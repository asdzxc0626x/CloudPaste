/**
 * GithubRepoProvider - GitHub 代码仓库 Provider
 *
 * 修改点：新增功能
 *
 * 能力：
 * - resolveLatestVersion：按 branch 取最新 commit，或按 release 取最新 tag
 * - openSourceArchive：打开 tarball 的流（不整包读入内存，Workers 下也能处理大仓库）
 *
 * 实现说明：
 * - 限流退避策略参照 storage/drivers/github/GithubApiStorageDriver.js 的 _fetchJson：
 *   识别 429 / 403+retry-after / x-ratelimit-reset，仅对 GET 重试
 * - 公开仓库无需 token；token 仅用于提高速率上限（第一阶段不支持私有仓库）
 * - 请求头复用 MasqueradeClient，与现有 GitHub 驱动保持一致
 */

import { BaseRepoProvider } from "./BaseRepoProvider.js";
import { ApiStatus } from "../../constants/index.js";
import { AppError, NotFoundError, ValidationError } from "../../http/errors.js";
import { MasqueradeClient } from "../../utils/httpMasquerade.js";

const DEFAULT_API_BASE = "https://api.github.com";
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 8000;

/**
 * 超时与等待上限（修改点：备份任务卡住排查）
 *
 * 原实现的三个卡死点：
 * 1. fetch 不带 signal —— 连接一旦停滞就永远不返回。Node 侧 undici 只有「完全无数据」
 *    才会在 5 分钟后报错，而 gh_proxy 代理半死不活时常表现为长时间不返回响应头；
 *    Workers 侧 fetch 更是没有客户端超时。任务就停在 running 且没有任何错误。
 * 2. 限流退避直接按 x-ratelimit-reset 睡 —— 未配置 token 时 GitHub 只给 60 次/小时，
 *    触顶后 reset 可能在一小时后，于是 _sleep 静默睡将近一小时（还会重试两次），
 *    表现为「任务卡住、日志无输出」。这里给等待时间设上限，超过就立刻失败并说明原因。
 * 3. 429/5xx 重试时不释放上一次的响应体 —— undici 连接池被未消费的 body 占住，
 *    连续几次之后新请求排队等不到连接，同样表现为卡住。
 */
const API_TIMEOUT_MS = 30 * 1000;

/**
 * 归档请求的超时只覆盖「等待响应头」这一段。
 * body 的读取耗时取决于仓库大小，绝不能用固定定时器掐断；
 * 停滞检测由调用方（RepoBackupTaskHandler）通过 signal 负责。
 */
const ARCHIVE_HEADERS_TIMEOUT_MS = 60 * 1000;

/** 单次限流等待上限，超过则不再等待，直接失败并提示配置 token */
const RATE_LIMIT_MAX_WAIT_MS = 60 * 1000;

// 说明：constants/index.js 的 ApiStatus 未定义 502/BAD_GATEWAY，
// 为避免引用未定义常量（会静默退化成 undefined），上游失败统一使用 INTERNAL_ERROR，
// 并通过 expose:true + 明确 message 让管理端看到真实原因。

/**
 * 解析 'owner/repo' 标识，同时兼容完整 URL 形式
 * @param {string} raw
 * @returns {{ owner: string, repo: string }}
 */
function parseRepoIdentifier(raw) {
  let text = String(raw || "").trim();
  if (!text) {
    throw new ValidationError("仓库标识不能为空，格式应为 owner/repo");
  }

  // 兼容 https://github.com/owner/repo(.git)(/任意后缀)
  text = text.replace(/^https?:\/\/(www\.)?github\.com\//i, "");
  text = text.replace(/\.git$/i, "");

  const segments = text.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new ValidationError(`仓库标识格式无效: ${raw}，应为 owner/repo`);
  }

  return { owner: segments[0], repo: segments[1] };
}

export class GithubRepoProvider extends BaseRepoProvider {
  /**
   * @param {Object} config 已解密的 provider 配置 { token?, gh_proxy?, endpoint_url? }
   */
  constructor(config = {}) {
    super(config);
    this.type = "github";

    this.token = config?.token ? String(config.token).trim() : null;
    this.ghProxy = config?.gh_proxy ? String(config.gh_proxy).trim().replace(/\/+$/, "") : null;
    this.apiBase = (config?.endpoint_url ? String(config.endpoint_url).trim() : DEFAULT_API_BASE).replace(/\/+$/, "");

    this._masqueradeClient = new MasqueradeClient({ rotateIP: true, rotateUA: false });
  }

  /**
   * 创建仓库前的输入校验（由 RepoProviderFactory.validate 调用）
   * @param {{ repoIdentifier?: string, config?: object }} input
   * @returns {{ valid: boolean, errors: string[] }}
   */
  static validateInput(input = {}) {
    const errors = [];

    try {
      parseRepoIdentifier(input.repoIdentifier);
    } catch (e) {
      errors.push(e?.message || "仓库标识无效");
    }

    const cfg = input.config || {};

    for (const key of ["gh_proxy", "endpoint_url"]) {
      const value = cfg[key];
      if (!value) continue;
      try {
        const parsed = new URL(String(value));
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          errors.push(`${key} 必须以 http:// 或 https:// 开头`);
        }
      } catch {
        errors.push(`${key} 格式无效`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  // ==================== 公开能力 ====================

  /**
   * 解析最新版本
   * @param {{ repoIdentifier: string, trackMode: 'branch'|'release', trackRef: (string|null) }} params
   * @returns {Promise<import("./BaseRepoProvider.js").RepoVersionInfo>}
   */
  async resolveLatestVersion({ repoIdentifier, trackMode = "branch", trackRef = null }) {
    const { owner, repo } = parseRepoIdentifier(repoIdentifier);

    if (trackMode === "release") {
      return await this._resolveLatestRelease(owner, repo, trackRef);
    }
    return await this._resolveLatestBranchCommit(owner, repo, trackRef);
  }

  /**
   * 打开源码归档流（tar.gz）
   * @param {{ repoIdentifier: string, refType: 'branch'|'tag', ref: string, commitSha: string, signal?: AbortSignal|null }} params
   *        signal（修改点：备份任务卡住排查）由调用方持有，用于在传输停滞或任务取消时
   *        中止整个响应（含 body）；不传则只有「等响应头」的超时保护
   * @returns {Promise<import("./BaseRepoProvider.js").RepoArchive>}
   */
  async openSourceArchive({ repoIdentifier, refType, ref, commitSha, signal = null }) {
    const { owner, repo } = parseRepoIdentifier(repoIdentifier);

    // 直接用 commitSha 取归档，保证「解析到的版本」与「下载到的内容」严格一致
    // （若期间分支有新提交，用分支名会下载到不一致的内容）
    const archiveRef = commitSha || ref;
    const url = this._applyGhProxy(`${this.apiBase}/repos/${owner}/${repo}/tarball/${encodeURIComponent(archiveRef)}`);

    const resp = await this._fetchWithRetry(
      url,
      {
        method: "GET",
        // GitHub 会 302 到 codeload.github.com，交给 fetch 自动跟随
        redirect: "follow",
      },
      { timeoutMs: ARCHIVE_HEADERS_TIMEOUT_MS, signal },
    );

    if (!resp.body) {
      throw new AppError("GitHub 归档响应没有可读流", {
        status: ApiStatus.INTERNAL_ERROR,
        code: "REPO_BACKUP.ARCHIVE_NO_BODY",
        expose: false,
        details: { url },
      });
    }

    // codeload 通常使用 chunked 编码，没有 content-length；此时保持 null，
    // 由上层按「未知大小」处理（S3 走 lib-storage 分片，配额守卫会跳过 best-effort 判断）
    const contentLengthRaw = resp.headers?.get?.("content-length");
    const contentLength = contentLengthRaw != null && String(contentLengthRaw).trim() !== "" ? Number(contentLengthRaw) : null;

    const shortSha = String(commitSha || "").slice(0, 7);
    const safeRef = String(ref || archiveRef).replace(/[^a-zA-Z0-9._-]+/g, "-");

    return {
      stream: resp.body,
      filename: `${repo}__${safeRef}__${shortSha || "unknown"}.tar.gz`,
      contentType: "application/gzip",
      contentLength: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null,
      refType,
    };
  }

  // ==================== 内部实现 ====================

  /**
   * branch 模式：取分支最新 commit
   * @private
   */
  async _resolveLatestBranchCommit(owner, repo, branch) {
    const ref = String(branch || "").trim();
    if (!ref) {
      throw new ValidationError("branch 模式必须指定分支名");
    }

    const url = `${this.apiBase}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`;
    const data = await this._fetchJson(url);

    const commitSha = data?.sha ? String(data.sha) : null;
    if (!commitSha) {
      throw new AppError("无法从 GitHub 响应中解析 commit sha", {
        status: ApiStatus.INTERNAL_ERROR,
        code: "REPO_BACKUP.COMMIT_SHA_MISSING",
        expose: false,
        details: { url },
      });
    }

    const committedAt = data?.commit?.committer?.date || data?.commit?.author?.date || null;

    return {
      refType: "branch",
      ref,
      commitSha,
      version: `${ref}@${commitSha.slice(0, 7)}`,
      publishedAt: committedAt ? new Date(committedAt).toISOString() : null,
    };
  }

  /**
   * release 模式：取最新 release（或指定 tag），并解析为 commit sha
   * @private
   */
  async _resolveLatestRelease(owner, repo, tagRef) {
    const wantTag = String(tagRef || "").trim();

    const releaseUrl = wantTag
      ? `${this.apiBase}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(wantTag)}`
      : `${this.apiBase}/repos/${owner}/${repo}/releases/latest`;

    let release = null;
    try {
      release = await this._fetchJson(releaseUrl);
    } catch (error) {
      // 仓库只打 tag、不发 Release 的情况很常见：回退到 tags 列表
      if (error instanceof NotFoundError && !wantTag) {
        return await this._resolveLatestTag(owner, repo);
      }
      throw error;
    }

    const tagName = release?.tag_name ? String(release.tag_name) : null;
    if (!tagName) {
      throw new AppError("无法从 GitHub Release 响应中解析 tag_name", {
        status: ApiStatus.INTERNAL_ERROR,
        code: "REPO_BACKUP.RELEASE_TAG_MISSING",
        expose: false,
        details: { url: releaseUrl },
      });
    }

    const commitSha = await this._resolveTagCommitSha(owner, repo, tagName);
    const publishedAt = release?.published_at || release?.created_at || null;

    return {
      refType: "tag",
      ref: tagName,
      commitSha,
      version: tagName,
      publishedAt: publishedAt ? new Date(publishedAt).toISOString() : null,
    };
  }

  /**
   * 回退路径：仓库没有 Release，但有 tag
   * @private
   */
  async _resolveLatestTag(owner, repo) {
    const url = `${this.apiBase}/repos/${owner}/${repo}/tags?per_page=1`;
    const tags = await this._fetchJson(url);

    if (!Array.isArray(tags) || tags.length === 0) {
      throw new NotFoundError("该仓库没有任何 Release 或 Tag，无法按 release 模式备份", {
        owner,
        repo,
      });
    }

    const tag = tags[0];
    const tagName = tag?.name ? String(tag.name) : null;
    const commitSha = tag?.commit?.sha ? String(tag.commit.sha) : null;

    if (!tagName || !commitSha) {
      throw new AppError("无法从 GitHub Tags 响应中解析 tag 信息", {
        status: ApiStatus.INTERNAL_ERROR,
        code: "REPO_BACKUP.TAG_PARSE_FAILED",
        expose: false,
        details: { url },
      });
    }

    return {
      refType: "tag",
      ref: tagName,
      commitSha,
      version: tagName,
      publishedAt: null,
    };
  }

  /**
   * 把 tag 名解析为 commit sha
   * - tag 可能是 lightweight tag（直接指向 commit）或 annotated tag（指向 tag 对象）
   * @private
   */
  async _resolveTagCommitSha(owner, repo, tagName) {
    const url = `${this.apiBase}/repos/${owner}/${repo}/commits/${encodeURIComponent(tagName)}`;
    const data = await this._fetchJson(url);

    const commitSha = data?.sha ? String(data.sha) : null;
    if (!commitSha) {
      throw new AppError(`无法解析 tag ${tagName} 对应的 commit sha`, {
        status: ApiStatus.INTERNAL_ERROR,
        code: "REPO_BACKUP.TAG_COMMIT_SHA_MISSING",
        expose: false,
        details: { url },
      });
    }
    return commitSha;
  }

  /**
   * gh_proxy 前缀加速（与 GitHub 驱动的处理方式一致）
   * @private
   */
  _applyGhProxy(url) {
    if (!this.ghProxy) return url;
    return `${this.ghProxy}/${url}`;
  }

  /**
   * 构建请求头
   * @private
   */
  _buildHeaders(extra = {}, targetUrl = null) {
    const browserHeaders = this._masqueradeClient.buildHeaders({}, targetUrl);
    const headers = {
      ...browserHeaders,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...extra,
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    return headers;
  }

  /** @private */
  _sleep(ms) {
    if (!ms || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 读取限流相关响应头
   * @private
   */
  _readRetryHeaders(resp) {
    const pick = (name) => resp.headers?.get?.(name) ?? resp.headers?.get?.(name.toLowerCase()) ?? null;
    const toNumber = (raw) => (raw != null && String(raw).trim() !== "" ? Number(raw) : null);
    return {
      retryAfter: toNumber(pick("retry-after")),
      reset: toNumber(pick("x-ratelimit-reset")),
      remaining: toNumber(pick("x-ratelimit-remaining")),
    };
  }

  /**
   * 计算退避时长
   * @private
   */
  _computeDelayMs({ attempt, retryAfterSeconds = null, resetEpochSeconds = null }) {
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
      return Math.max(0, retryAfterSeconds * 1000);
    }
    if (Number.isFinite(resetEpochSeconds) && resetEpochSeconds > 0) {
      const until = resetEpochSeconds * 1000 - Date.now();
      return Math.max(0, until + 250);
    }
    const exp = RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
    return Math.max(0, Math.min(exp, RETRY_MAX_DELAY_MS));
  }

  /**
   * 为单次请求构造 AbortSignal（修改点：备份任务卡住排查）
   *
   * 两种中止来源的生命周期不同，必须分开处理：
   * - timeoutMs：只用于「等待响应头」。拿到 Response 后调用方必须立刻 clearTimer，
   *   否则大仓库的 body 还没读完就会被这个定时器掐断
   * - externalSignal：由调用方（备份任务的停滞看门狗 / 取消）持有，生命周期要覆盖
   *   整个 body 读取过程，所以 clearTimer 只停定时器、不解绑它的转发
   *
   * @private
   * @param {AbortSignal|null} externalSignal
   * @param {number} timeoutMs
   */
  _linkAbort(externalSignal, timeoutMs) {
    const controller = new AbortController();
    const state = { timedOut: false };

    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }

    const timer =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            state.timedOut = true;
            controller.abort();
          }, timeoutMs)
        : null;

    return {
      signal: controller.signal,
      state,
      clearTimer: () => {
        if (timer) clearTimeout(timer);
      },
    };
  }

  /**
   * 丢弃不再使用的响应体（修改点：备份任务卡住排查）
   * - 重试前必须释放，否则 undici 连接池会被未消费的 body 占住
   * @private
   */
  async _discardBody(resp) {
    try {
      if (resp?.body && typeof resp.body.cancel === "function") {
        await resp.body.cancel();
      }
    } catch {
      // 释放失败不影响重试
    }
  }

  /**
   * 带限流重试的 fetch（仅 GET 安全重试）
   * @private
   * @param {string} url
   * @param {Object} init
   * @param {{ timeoutMs?: number, signal?: AbortSignal|null }} opts
   *        timeoutMs 只约束「等到响应头」的时间；signal 覆盖整个响应（含 body）
   * @returns {Promise<Response>}
   */
  async _fetchWithRetry(url, init = {}, opts = {}) {
    const method = String(init?.method || "GET").toUpperCase();
    const canRetryNetwork = method === "GET";
    const timeoutMs = opts?.timeoutMs ?? API_TIMEOUT_MS;
    const externalSignal = opts?.signal ?? null;

    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
      const abort = this._linkAbort(externalSignal, timeoutMs);
      let resp = null;
      try {
        resp = await fetch(url, {
          ...init,
          headers: this._buildHeaders(init.headers || {}, url),
          signal: abort.signal,
        });
      } catch (e) {
        abort.clearTimer();

        // 调用方主动中止（任务取消 / 下载停滞看门狗）：重试没有意义，如实上报
        if (externalSignal?.aborted) {
          throw new AppError("GitHub 请求已中止（任务取消或传输停滞超时）", {
            status: ApiStatus.INTERNAL_ERROR,
            code: "REPO_BACKUP.GITHUB_REQUEST_ABORTED",
            expose: true,
            details: { url },
          });
        }

        const timedOut = abort.state.timedOut;
        if (attempt < RETRY_MAX_ATTEMPTS && canRetryNetwork) {
          console.warn(
            `[GithubRepoProvider] 请求${timedOut ? "超时" : "失败"}，第 ${attempt} 次重试: ${url}`,
          );
          await this._sleep(this._computeDelayMs({ attempt }));
          continue;
        }

        throw new AppError(
          timedOut
            ? `GitHub 请求超时：${timeoutMs}ms 内未返回响应头（已重试 ${RETRY_MAX_ATTEMPTS} 次）`
            : "GitHub 请求失败: 网络错误",
          {
            status: ApiStatus.INTERNAL_ERROR,
            code: timedOut ? "REPO_BACKUP.GITHUB_REQUEST_TIMEOUT" : "REPO_BACKUP.GITHUB_REQUEST_FAILED",
            expose: true,
            details: { url, cause: e?.message || String(e) },
          },
        );
      }

      // 已拿到响应头：立刻停掉超时定时器，否则会在读 body 的过程中把连接掐断
      abort.clearTimer();

      if (resp.status === 404) {
        await this._discardBody(resp);
        throw new NotFoundError("GitHub 资源不存在（仓库、分支或版本不存在，或仓库为私有）", { url });
      }

      if (resp.ok) {
        return resp;
      }

      const { retryAfter, reset, remaining } = this._readRetryHeaders(resp);
      const rateLimited = resp.status === 429 || (resp.status === 403 && (retryAfter != null || remaining === 0));
      const retryable5xx = resp.status === 502 || resp.status === 503 || resp.status === 504;

      if (attempt < RETRY_MAX_ATTEMPTS && (rateLimited || (retryable5xx && canRetryNetwork))) {
        const delayMs = this._computeDelayMs({
          attempt,
          retryAfterSeconds: retryAfter,
          resetEpochSeconds: reset,
        });

        // 限流恢复时间太远时不再静默等待：睡一小时看起来就是「任务卡住」
        if (delayMs > RATE_LIMIT_MAX_WAIT_MS) {
          await this._discardBody(resp);
          const waitMinutes = Math.ceil(delayMs / 60000);
          throw new AppError(
            `GitHub API 速率受限，约 ${waitMinutes} 分钟后才恢复，已放弃等待` +
              `（请在仓库配置里填写 GitHub Token 提高速率上限，或稍后重试）`,
            {
              status: ApiStatus.INTERNAL_ERROR,
              code: "REPO_BACKUP.GITHUB_RATE_LIMITED",
              expose: true,
              details: { url, status: resp.status, waitMs: delayMs },
            },
          );
        }

        await this._discardBody(resp);
        console.warn(
          `[GithubRepoProvider] HTTP ${resp.status}${rateLimited ? "（限流）" : ""}，` +
            `${delayMs}ms 后第 ${attempt} 次重试: ${url}`,
        );
        await this._sleep(delayMs);
        continue;
      }

      let text = null;
      try {
        text = await resp.text();
      } catch {
        text = null;
      }

      const hint = rateLimited ? "（GitHub API 速率受限，建议配置 token 提高上限）" : "";
      throw new AppError(`GitHub 请求失败: HTTP ${resp.status}${hint}`, {
        status: ApiStatus.INTERNAL_ERROR,
        code: "REPO_BACKUP.GITHUB_REQUEST_FAILED",
        expose: true,
        details: { url, status: resp.status, body: text ? String(text).slice(0, 500) : null },
      });
    }

    // 理论上不会到达（循环内必定 return 或 throw）
    throw new AppError("GitHub 请求失败: 超过最大重试次数", {
      status: ApiStatus.INTERNAL_ERROR,
      code: "REPO_BACKUP.GITHUB_REQUEST_FAILED",
      expose: false,
      details: { url },
    });
  }

  /**
   * 带限流重试的 JSON 请求
   *
   * 修改点（备份任务卡住排查）：_fetchWithRetry 的超时只覆盖到「拿到响应头」，
   * 之后读 body 是没有保护的。JSON 响应虽小，但连接在响应头之后停滞同样会永久挂起，
   * 所以这里给 resp.json() 再加一道截止时间。
   * @private
   */
  async _fetchJson(url, init = {}, opts = {}) {
    const resp = await this._fetchWithRetry(url, init, opts);
    const timeoutMs = opts?.timeoutMs ?? API_TIMEOUT_MS;

    let timer = null;
    try {
      return await Promise.race([
        // 解析失败按「拿不到结构化数据」处理，由调用方给出具体报错
        resp.json().catch(() => null),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new AppError(`GitHub 响应体读取超时（${timeoutMs}ms）`, {
                status: ApiStatus.INTERNAL_ERROR,
                code: "REPO_BACKUP.GITHUB_REQUEST_TIMEOUT",
                expose: true,
                details: { url },
              }),
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
