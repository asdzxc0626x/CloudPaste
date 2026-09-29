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
   * @param {{ repoIdentifier: string, refType: 'branch'|'tag', ref: string, commitSha: string }} params
   * @returns {Promise<import("./BaseRepoProvider.js").RepoArchive>}
   */
  async openSourceArchive({ repoIdentifier, refType, ref, commitSha }) {
    const { owner, repo } = parseRepoIdentifier(repoIdentifier);

    // 直接用 commitSha 取归档，保证「解析到的版本」与「下载到的内容」严格一致
    // （若期间分支有新提交，用分支名会下载到不一致的内容）
    const archiveRef = commitSha || ref;
    const url = this._applyGhProxy(`${this.apiBase}/repos/${owner}/${repo}/tarball/${encodeURIComponent(archiveRef)}`);

    const resp = await this._fetchWithRetry(url, {
      method: "GET",
      // GitHub 会 302 到 codeload.github.com，交给 fetch 自动跟随
      redirect: "follow",
    });

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
   * 带限流重试的 fetch（仅 GET 安全重试）
   * @private
   * @returns {Promise<Response>}
   */
  async _fetchWithRetry(url, init = {}) {
    const method = String(init?.method || "GET").toUpperCase();
    const canRetryNetwork = method === "GET";

    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
      let resp = null;
      try {
        resp = await fetch(url, { ...init, headers: this._buildHeaders(init.headers || {}, url) });
      } catch (e) {
        if (attempt < RETRY_MAX_ATTEMPTS && canRetryNetwork) {
          await this._sleep(this._computeDelayMs({ attempt }));
          continue;
        }
        throw new AppError("GitHub 请求失败: 网络错误", {
          status: ApiStatus.INTERNAL_ERROR,
          code: "REPO_BACKUP.GITHUB_REQUEST_FAILED",
          expose: false,
          details: { url, cause: e?.message || String(e) },
        });
      }

      if (resp.status === 404) {
        throw new NotFoundError("GitHub 资源不存在（仓库、分支或版本不存在，或仓库为私有）", { url });
      }

      if (resp.ok) {
        return resp;
      }

      const { retryAfter, reset, remaining } = this._readRetryHeaders(resp);
      const rateLimited = resp.status === 429 || (resp.status === 403 && (retryAfter != null || remaining === 0));
      const retryable5xx = resp.status === 502 || resp.status === 503 || resp.status === 504;

      if (attempt < RETRY_MAX_ATTEMPTS && (rateLimited || (retryable5xx && canRetryNetwork))) {
        await this._sleep(this._computeDelayMs({ attempt, retryAfterSeconds: retryAfter, resetEpochSeconds: reset }));
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
      status: ApiStatus.BAD_GATEWAY,
      code: "REPO_BACKUP.GITHUB_REQUEST_FAILED",
      expose: false,
      details: { url },
    });
  }

  /**
   * 带限流重试的 JSON 请求
   * @private
   */
  async _fetchJson(url, init = {}) {
    const resp = await this._fetchWithRetry(url, init);
    try {
      return await resp.json();
    } catch {
      return null;
    }
  }
}
