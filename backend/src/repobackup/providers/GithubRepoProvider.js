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
 *
 * 修改点（第 1 期：GitHub 请求数量优化）：
 * 1. 多分支检测：跟踪 N 个分支时，原先是 N 次 /commits/{ref}，现改为 1 次 /branches
 *    列表接口批量取回「分支名 -> commit sha」映射后再匹配目标分支
 * 2. 源码下载：改用 codeload.github.com 直连，绕开 api.github.com 的 tarball 302
 *    （原路径每次下载都要先消耗一次 API 速率额度）
 * 这两项都不改变对外语义：逐分支的结果结构、错误隔离、去重键仍是 commitSha
 *
 * 修改点（第 2 期：错误分类 + 延迟重试）：
 * 抛出的错误带上「类别」与「可重试时间」，供调用方区分处理：
 * - RateLimitedError  429 / 403 且 x-ratelimit-remaining=0 -> 延迟到额度恢复再跑，不记失败
 * - TransientError    超时 / 连接重置 / 5xx / 传输停滞      -> 短退避后重试，不记失败
 * - 其余（NotFoundError / AppError）为永久性错误            -> 照旧记失败
 * 具体分类规则见 repobackup/errors.js。
 *
 * 修改点（第 3 期：统一走请求调度器）：
 * 所有打在 api.github.com 上的请求都先经过 repobackup/GithubRequestScheduler.js：
 * - 全局并发 <= 2、相邻请求发起间隔 >= 800ms（进程内）
 * - 请求前查共享额度账本，额度不足时**不发请求**，直接抛 RateLimitedError
 *   交给第 2 期的延迟重试流程（它已经能把限流转成「延迟」而不是「失败」）
 * - 响应头里的 limit/remaining/reset 回写账本，跨任务、跨实例共享
 * - 同一 scope + 同一 URL 的并发 GET 合并成一次请求
 * 注意：codeload.github.com 的源码下载**不经过调度器**（第 1 期已确认它不消耗 API 额度），
 * 只有 endpoint_url 指向自建实例时才落到 API 主机上、才需要计数。
 */

import { BaseRepoProvider } from "./BaseRepoProvider.js";
import { ApiStatus } from "../../constants/index.js";
import { AppError, NotFoundError, ValidationError } from "../../http/errors.js";
import { MasqueradeClient } from "../../utils/httpMasquerade.js";
// 修改点（第 2 期 错误分类）：上游错误不再一律抛 AppError，而是按
// 「限流 / 暂时性」分类抛出并带上可重试时间，供调用方安排延迟重试而不是记失败
import { RateLimitedError, TransientError } from "../errors.js";
// 修改点（第 3 期 请求调度）：统一节流 + 共享额度账本 + 同名请求合并
import {
  githubRequestScheduler,
  resolveGithubSchedulerConfig,
  buildQuotaScopeId,
  buildProxyScopeId,
  readScopeStates,
  resolveScopeState,
  isScopeBlocked,
  markScopeCooldown,
  runCoalesced,
  ANONYMOUS_SCOPE_ID,
  TOKEN_INVALID_COOLDOWN_MS,
  PROXY_FAILURE_COOLDOWN_MS,
} from "../GithubRequestScheduler.js";
// 修改点（第 3 期 3-B 凭据池）：多 Token / 多代理，仓库级优先、全局级兜底
import {
  loadGlobalPool,
  extractRepoPool,
  listCredentialCandidates,
  hasConfiguredEntries,
  isMaskedPlaceholder,
  POOL_TOKEN_KEY,
  POOL_PROXY_KEY,
} from "../credentials.js";

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

/**
 * 单次限流等待上限
 *
 * 修改点（第 2 期 错误分类）：超过这个上限时不再「放弃等待并直接判失败」，
 * 而是抛出 RateLimitedError（带恢复时间），由调度层安排延迟重试。
 * 这个上限只是「本次请求内愿意干等多久」，不是「重试与否」的分界线——
 * 在 Worker 里睡一小时既会触发超时，也看不出任务到底卡在哪。
 */
const RATE_LIMIT_MAX_WAIT_MS = 60 * 1000;

/**
 * 分支索引（批量取分支 SHA）相关常量（修改点：第 1 期请求数量优化）
 */
/** GitHub /branches 单页上限，也是官方允许的最大值 */
const BRANCH_INDEX_PER_PAGE = 100;
/**
 * 最多翻多少页
 * - 前 3 页覆盖 300 个分支，足以覆盖绝大多数仓库
 * - 超过上限时不再继续翻页，回退到「单分支查询」，行为与改造前一致
 */
const BRANCH_INDEX_MAX_PAGES = 3;

/**
 * codeload 直连（修改点：第 1 期源码下载优化）
 * - 默认 api.github.com 时，归档地址直接指向 codeload.github.com
 * - 自定义 endpoint_url（GitHub Enterprise / 自建）无法可靠推导 codeload 地址，
 *   继续沿用原 `${apiBase}/repos/.../tarball/...` 形式，endpoint_url 语义不变
 */
const DEFAULT_CODELOAD_BASE = "https://codeload.github.com";
/** 默认 API 主机名，用于判断是否可以安全切到 codeload */
const DEFAULT_API_BASE_HOST = "api.github.com";

/**
 * 凭据轮转游标（修改点：第 3 期 3-B）
 *
 * 放在模块级而不是实例上：每次备份任务都会新建一个 provider 实例，
 * 如果游标跟着实例走，每个任务都从第 0 个凭据开始，「不固定绑定」就名存实亡
 * —— 所有流量会一直压在第一个 Token / 代理上，直到它被限流为止。
 * 模块级游标让轮转跨任务、跨调用方持续推进。
 */
const credentialRotation = { token: 0, proxy: 0 };

/**
 * 复位凭据轮询游标（修改点：审计修复 — 测试与排障用）
 *
 * 游标是模块级状态，会跨调用方持续累积。运行期不该重置（那会让轮询退化成
 * 「每次都从第一个开始」），但测试需要一个确定性的起点，否则只能靠猜游标位置
 * 来断言轮询顺序。排障时也可以用它把轮询拉回可预测的起点。
 */
export function resetCredentialRotation() {
  credentialRotation.token = 0;
  credentialRotation.proxy = 0;
}

/**
 * 游标的回绕模数（修改点：审计修复 — 轮询均匀性）
 *
 * 为什么需要它：游标是模块级共享的，而每次挑选时「可用池」的长度各不相同
 * （不同仓库的池大小不同，被限流/冷却的条目也会被排除）。
 * 原实现写回 `(cursor + 1) % group.length`，等于用「当前这个池的长度」去约束
 * 一个共享游标 —— 只要系统里存在一个短池，游标就会被永久压在它的范围内，
 * 长池里靠后的 Token / 代理一次都轮不到，「均匀分摊」直接失效。
 *
 * 正确做法是「写回时只自增、读取时才按组长取模」。这里再模一个足够大的数，
 * 纯粹是为了防止长期运行后数值无边界增长；10 亿次请求才回绕一次，
 * 回绕处最多产生一次不均，可以忽略。
 */
const ROTATION_CURSOR_MODULUS = 1_000_000_000;

/**
 * 单次请求内「换凭据重试」的次数上限（修改点：审计修复 2）
 *
 * 与网络重试（RETRY_MAX_ATTEMPTS）是两套独立预算：
 * 一个坏 Token 不应该把网络抖动的重试额度吃掉，反之亦然。
 *
 * 为什么不等于池上限（20）：401 导致的换人每次都是一次真实请求、要烧一次额度。
 * 5 次足以覆盖常见池规模（2~5 条），又不会在「整池都失效」时连烧 20 次额度 ——
 * 那种情况下换人是徒劳的，交给冷却 + 下一个调度周期更合适。
 */
const MAX_CREDENTIAL_SWITCHES = 5;

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
   * @param {Object} config 已解密的 provider 配置
   *        { token?, gh_proxy?, endpoint_url?, tokens?: Array, proxies?: Array }
   *        （tokens / proxies 是第 3 期 3-B 的凭据池，见 repobackup/credentials.js）
   * @param {{ db?: any, env?: object|null, encryptionSecret?: string|null }} [runtime] 运行时依赖
   *        db               —— 额度账本 / 凭据状态的数据库句柄（D1 binding 或 Node SQLite 适配器）。
   *                            拿不到时只做进程内节流，跳过共享账本（fail-open，不影响原有功能）。
   *        env              —— 第 3 期的调度参数覆盖（并发 / 间隔 / 小时预算）。
   *        encryptionSecret —— 解密全局凭据池所需；缺失时全局池按空处理。
   */
  constructor(config = {}, runtime = {}) {
    super(config);
    this.type = "github";

    this.token = config?.token ? String(config.token).trim() : null;
    this.ghProxy = config?.gh_proxy ? String(config.gh_proxy).trim().replace(/\/+$/, "") : null;
    this.apiBase = (config?.endpoint_url ? String(config.endpoint_url).trim() : DEFAULT_API_BASE).replace(/\/+$/, "");

    this._masqueradeClient = new MasqueradeClient({ rotateIP: true, rotateUA: false });

    /**
     * 请求调度参数与凭据池（修改点：第 3 期 / 3-B）
     *
     * - db 由调用方在构造时通过 createProvider(type, config, { db, env }) 传入；
     *   拿不到时只做进程内节流、跳过共享状态（fail-open，不影响原有功能）
     * - 凭据分区一律由「值」派生散列（匿名共用 anonymous，不同 Token/代理各自独立），
     *   明文不会进入账本、日志或错误信息
     */
    this._db = runtime?.db ?? null;
    this._encryptionSecret = runtime?.encryptionSecret ?? null;
    this._schedulerConfig = resolveGithubSchedulerConfig(runtime?.env ?? null);
    // 说明：预留量（reserve）不在这里缓存。它必须跟着**每次请求实际选中的凭据**走
    // （有 Token 用 tokenReserve，匿名用 anonymousReserve），
    // 而实例上的 this.token 只是兼容旧配置的单一 Token，不能代表轮询结果。
    // 取值见 _pickCredential 与 _acquireRequestTicket。

    /**
     * 仓库级凭据池（修改点：第 3 期 3-B）
     *
     * 兼容：第 3 期之前配置的单个 token 视为「仓库级池里的第一条」，
     * 这样老配置既不会失效，也会正常参与额度记账与轮换。
     * 旧的 gh_proxy 不并入池 —— 它历史上只作用于源码下载，并入会顺手改变
     * 所有 API 请求的走向，属于本期不该发生的行为变更。
     */
    this._repoPool = extractRepoPool(config);
    if (this.token && !hasConfiguredEntries(this._repoPool, POOL_TOKEN_KEY)) {
      this._repoPool[POOL_TOKEN_KEY].unshift({ id: "tk_legacy", label: "", value: this.token, enabled: true });
    }
    /** 全局池懒加载（只在第一次真的要发请求时读一次库） */
    this._globalPool = null;
    this._globalPoolPromise = null;

    /**
     * 分支索引缓存（修改点：第 1 期请求数量优化）
     * key = `${owner}/${repo}`，value = 索引状态对象（见 _getBranchIndexState）
     *
     * 为什么要放在实例上：provider 实例的生命周期恰好是「一次 checkRepository」
     * 或「一次备份任务」，也就是同一个仓库的一轮处理。索引因此只在该轮内复用，
     * 不会跨仓库串味，也不需要任何外部失效机制。
     */
    this._branchIndexCache = new Map();

    /**
     * tag -> commit sha 的实例内缓存（修改点：第 1 期 Release 检测优化）
     * 同一轮处理里重复解析同一个 tag 时不再发请求
     */
    this._tagShaCache = new Map();
  }

  /**
   * 判断某个 URL 是否打在 GitHub API 主机上（修改点：第 3 期）
   *
   * 只有 API 请求才消耗速率额度，也才需要计数与节流：
   * - 默认配置下源码归档走 codeload.github.com -> 不计数（第 1 期的成果，必须保住）
   * - endpoint_url 指向自建实例时归档仍走 `${apiBase}/repos/.../tarball/...` -> 计数
   *
   * @private
   */
  _isApiRequest(url) {
    return typeof url === "string" && url.startsWith(this.apiBase);
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

    // 修改点（审计修复 3）：代理池逐条校验 URL / 协议，保存时就拒绝非法地址。
    //
    // 为什么必须在这里拦：非 URL 的代理地址会让 fetch 直接抛错，被归类为
    // 「网络错误」-> 冷却该节点 3 分钟 -> 冷却到期后又轮到它 -> 无限循环，
    // 而用户在界面上看不到任何「这条配错了」的提示。
    //
    // 掩码值（前端回传的未改动条目，形如 ****abcd）必须跳过：它不是用户新填的值，
    // 原值已经在创建时校验过了，这里再校验只会把「只改备注」的保存操作误判成非法。
    for (const entry of Array.isArray(cfg[POOL_PROXY_KEY]) ? cfg[POOL_PROXY_KEY] : []) {
      const raw = entry?.value === null || entry?.value === undefined ? "" : String(entry.value).trim();
      if (!raw) continue;
      if (isMaskedPlaceholder(raw)) continue;

      const label = entry?.label ? `「${String(entry.label).slice(0, 40)}」` : "";
      try {
        const parsed = new URL(raw);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          errors.push(`加速代理${label}必须以 http:// 或 https:// 开头`);
        }
      } catch {
        // 注意：错误信息里绝不能回显 raw —— 代理地址可能内嵌 basic auth
        errors.push(`加速代理${label}格式无效，应为完整的 http(s) 地址`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  // ==================== 公开能力 ====================

  /**
   * 解析最新版本
   * @param {{ repoIdentifier: string, trackMode: 'branch'|'release', trackRef: (string|null), refCount?: number }} params
   *        refCount（修改点：第 1 期请求数量优化）本仓库一共要解析多少个引用。
   *        调用方（checkRepository / RepoBackupTaskHandler）本来就持有完整的
   *        trackRefs 列表，把它传进来，provider 才能判断「走批量还是走单分支」：
   *          - refCount >= 2：批量接口 1 次请求覆盖全部分支
   *          - refCount <= 1：维持原单分支查询（响应更小，且能拿到提交时间）
   *        不传时按 1 处理，行为与改造前完全一致。
   * @returns {Promise<import("./BaseRepoProvider.js").RepoVersionInfo>}
   */
  async resolveLatestVersion({ repoIdentifier, trackMode = "branch", trackRef = null, refCount = 1 }) {
    const { owner, repo } = parseRepoIdentifier(repoIdentifier);

    if (trackMode === "release") {
      return await this._resolveLatestRelease(owner, repo, trackRef);
    }
    return await this._resolveLatestBranchCommit(owner, repo, trackRef, refCount);
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
    // 修改点（第 1 期源码下载优化）：归档地址改由 _buildArchiveUrl 构造，
    // 默认走 codeload.github.com 直连，不再经过 api.github.com 的 tarball 302
    // 修改点（第 3 期 3-B）：代理不再在这里套用，改由 _fetchWithRetry 统一处理
    //（优先用凭据池里选中的代理，池里没有才回落到历史上的 gh_proxy）
    const archiveRef = commitSha || ref;
    const url = this._buildArchiveUrl(owner, repo, archiveRef);

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
   *
   * 修改点（第 1 期请求数量优化）：
   * 跟踪多个分支时先用 /branches 列表接口批量建立索引，再从中匹配目标分支，
   * 把「N 个分支 N 次请求」压成「1 次请求（必要时翻页）」。
   * 索引里找不到该分支时（可能超出分页上限，也可能确实不存在）回退到
   * _fetchBranchCommit，保证 404 等错误语义与改造前完全一致。
   *
   * @param {number} refCount 本仓库要解析的引用总数
   * @private
   */
  async _resolveLatestBranchCommit(owner, repo, branch, refCount = 1) {
    const ref = String(branch || "").trim();
    if (!ref) {
      throw new ValidationError("branch 模式必须指定分支名");
    }

    // 只在「确实要解析多个分支」时才走批量。
    // 单分支仍走原来的 /commits/{ref}：请求数一样是 1 次，但响应体更小，
    // 且能拿到提交时间（/branches 列表不返回该字段），单分支仓库零行为变化。
    if (Number(refCount) >= 2) {
      const hit = await this._lookupBranchInIndex(owner, repo, ref);
      if (hit) {
        return {
          refType: "branch",
          ref,
          commitSha: hit.commitSha,
          version: `${ref}@${hit.commitSha.slice(0, 7)}`,
          // /branches 列表接口不返回提交时间，批量路径下该字段为 null
          //（该字段仅用于 manifest 与检查结果展示，前端不渲染）
          publishedAt: null,
        };
      }
    }

    return await this._fetchBranchCommit(owner, repo, ref);
  }

  /**
   * 单分支查询：取指定分支的最新 commit（改造前的原始实现，原样保留）
   * @private
   */
  async _fetchBranchCommit(owner, repo, ref) {
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
   * 取（或初始化）某仓库的分支索引状态（修改点：第 1 期请求数量优化）
   * @private
   */
  _getBranchIndexState(owner, repo) {
    const key = `${owner}/${repo}`;
    let state = this._branchIndexCache.get(key);
    if (!state) {
      state = {
        /** @type {Map<string, {commitSha: string}>} 分支名 -> commit 信息 */
        entries: new Map(),
        /** 已加载的页数 */
        loadedPages: 0,
        /** 已确认没有下一页 */
        exhausted: false,
        /** 索引构建失败，本实例内不再重试，直接走单分支查询 */
        unavailable: false,
        /**
         * 索引失败的原因（修改点：第 2 期 错误分类）
         * - 限流/暂时性故障时记在这里，后续引用直接复用同一个错误向上抛，
         *   不再逐个回退到单分支查询（N 个分支 = N 份白烧的额度）
         */
        error: null,
      };
      this._branchIndexCache.set(key, state);
    }
    return state;
  }

  /**
   * 在分支索引里查找目标分支，必要时按需翻页
   *
   * 分页策略（修改点：第 1 期请求数量优化）：
   * - 懒加载：只有当前页没命中且还有下一页时才继续请求下一页，
   *   因此绝大多数仓库（<=100 个分支）固定只花 1 次请求
   * - 翻页上限 BRANCH_INDEX_MAX_PAGES，超过则放弃并回退单分支查询，
   *   避免在分支极多的仓库上为了 1 个分支翻十几页，反而比改造前更费请求
   *
   * @returns {Promise<{commitSha: string}|null>} null 表示索引无法回答，调用方应回退
   * @private
   */
  async _lookupBranchInIndex(owner, repo, ref) {
    const state = this._getBranchIndexState(owner, repo);
    if (state.unavailable) {
      // 修改点（第 2 期）：索引因为限流/暂时性故障建不起来时，后续引用直接复用
      // 那个错误。否则每个分支都会回退去打一次同样被拒的请求，白白放大额度消耗。
      if (state.error) throw state.error;
      return null;
    }

    const cached = state.entries.get(ref);
    if (cached) return cached;

    while (!state.exhausted && state.loadedPages < BRANCH_INDEX_MAX_PAGES) {
      const ok = await this._loadNextBranchPage(owner, repo, state);
      // 加载失败：标记索引不可用并回退单分支查询。
      // 这里刻意不把错误直接抛给调用方，是为了保住原有的错误隔离语义——
      // 每个分支应当各自拿到属于自己的错误，而不是共享一个索引级错误。
      if (!ok) return null;

      const hit = state.entries.get(ref);
      if (hit) return hit;
    }

    return null;
  }

  /**
   * 加载分支索引的下一页（修改点：第 1 期请求数量优化）
   * @returns {Promise<boolean>} 是否成功加载（失败时把索引标记为不可用）
   * @private
   */
  async _loadNextBranchPage(owner, repo, state) {
    const page = state.loadedPages + 1;
    const url =
      `${this.apiBase}/repos/${owner}/${repo}/branches` +
      `?per_page=${BRANCH_INDEX_PER_PAGE}&page=${page}`;

    let list = null;
    try {
      list = await this._fetchJson(url);
    } catch (error) {
      // 修改点（第 2 期 错误分类）：限流/暂时性错误不能按「索引不可用」吞掉。
      // 索引失败后回退到单分支查询，只会让 N 个分支各自再打一次同样被拒的请求
      // （N 份白烧的额度、N 份重复日志），结果还是全部失败。
      // 直接向上抛，整轮统一按「延迟重试」处理，语义反而更清晰。
      // 注意：_fetchWithRetry 内部已经重试过 3 次，能走到这里的已经不算瞬时抖动。
      if (error instanceof RateLimitedError || error instanceof TransientError) {
        state.unavailable = true;
        // 记住原因：同一实例内后续引用的查找会直接复用这个错误（见 _lookupBranchInIndex）
        state.error = error;
        throw error;
      }
      state.unavailable = true;
      state.error = null;
      console.warn(
        `[GithubRepoProvider] 分支列表拉取失败，本次回退单分支查询: ${url} - ${error?.message || error}`,
      );
      return false;
    }

    if (!Array.isArray(list)) {
      // 响应不是数组（异常响应体）时同样按不可用处理
      state.unavailable = true;
      return false;
    }

    state.loadedPages = page;
    // 返回条数不足一页 => 已经是最后一页
    if (list.length < BRANCH_INDEX_PER_PAGE) {
      state.exhausted = true;
    }

    for (const item of list) {
      const name = item?.name ? String(item.name) : null;
      const sha = item?.commit?.sha ? String(item.commit.sha) : null;
      if (!name || !sha) continue;
      // 同名分支以先出现者为准
      if (!state.entries.has(name)) {
        state.entries.set(name, { commitSha: sha });
      }
    }

    return true;
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
   *
   * 修改点（第 1 期 Release 检测优化）：同一轮处理内缓存解析结果。
   * releases/latest 本身不返回 commit sha（只有 tag_name），必须再发一次请求解析；
   * 当同一个 tag 在一轮里被解析多次时（重试、多目标补写等），直接复用缓存结果。
   * @private
   */
  async _resolveTagCommitSha(owner, repo, tagName) {
    const cacheKey = `${owner}/${repo}#${tagName}`;
    const cached = this._tagShaCache.get(cacheKey);
    if (cached) return cached;

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

    this._tagShaCache.set(cacheKey, commitSha);
    return commitSha;
  }

  /**
   * 构造源码归档地址（修改点：第 1 期源码下载优化）
   *
   * 原实现请求 `${apiBase}/repos/{owner}/{repo}/tarball/{ref}`：
   * api.github.com 会先计一次速率额度再 302 跳到 codeload。
   * 多备份目标时每个目标各下载一次，等于每次备份白烧 N 次 API 额度。
   * 直连 codeload 可以完全绕开 API 额度，同时省掉一次 302 往返。
   *
   * endpoint_url 语义保持不变：
   * - 默认（api.github.com）        -> https://codeload.github.com/{owner}/{repo}/tar.gz/{ref}
   * - 自定义（GHE / 自建 / 反代）   -> 仍走原 `${apiBase}/repos/.../tarball/...`，
   *   因为无法从 API 地址可靠推导出该实例的 codeload 地址，不能擅自猜测
   *
   * @private
   */
  _buildArchiveUrl(owner, repo, archiveRef) {
    const encodedRef = encodeURIComponent(archiveRef);
    if (this._isDefaultApiBase()) {
      return `${DEFAULT_CODELOAD_BASE}/${owner}/${repo}/tar.gz/${encodedRef}`;
    }
    return `${this.apiBase}/repos/${owner}/${repo}/tarball/${encodedRef}`;
  }

  /**
   * 判断当前 API 地址是否就是官方 api.github.com
   * @private
   */
  _isDefaultApiBase() {
    if (this.apiBase === DEFAULT_API_BASE) return true;
    try {
      return new URL(this.apiBase).host.toLowerCase() === DEFAULT_API_BASE_HOST;
    } catch {
      // 地址无法解析时按「非默认」处理，走原来的 tarball 路径更安全
      return false;
    }
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
   * @param {object} [extra] 额外请求头
   * @param {string|null} [targetUrl] 用于生成伪装请求头的目标地址
   * @param {string|null|undefined} [token] 本次请求使用的 Token（修改点：第 3 期 3-B）
   *        - undefined：沿用实例上的历史单 Token（第 3 期之前的调用方式）
   *        - null：明确不带认证（选中的是匿名额度）
   *        - 字符串：使用凭据池里选中的那个 Token
   * @private
   */
  _buildHeaders(extra = {}, targetUrl = null, token = undefined) {
    const browserHeaders = this._masqueradeClient.buildHeaders({}, targetUrl);
    const headers = {
      ...browserHeaders,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...extra,
    };
    const effectiveToken = token === undefined ? this.token : token;
    if (effectiveToken) {
      headers.Authorization = `Bearer ${effectiveToken}`;
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

    // 修改点（第 3 期 请求调度）：只有打在 API 主机上的请求才需要计数与节流。
    // 默认配置下源码归档走 codeload.github.com，不消耗 API 额度，因此不经过调度器
    // —— 第 1 期的「codeload 直连」优化不能被这一期影响。
    const gated = this._isApiRequest(url);

    /**
     * 本轮已判定不可用的凭据分区（修改点：审计修复 2）
     *
     * 只在这一次请求内生效、不写库：它让「换下一个凭据接着试」成为本轮就能完成的动作，
     * 而不是等下一个调度周期。需要跨请求保留的状态（401 冷却、代理冷却）
     * 仍然由 _noteCredentialFailure 落到共享账本里。
     */
    const excludeTokenScopes = new Set();
    const excludeProxyScopes = new Set();

    /**
     * 两套独立的重试预算（修改点：审计修复 2）
     * - attempt  网络错误 / 5xx / 限流退避的轮次，上限 RETRY_MAX_ATTEMPTS（语义与改造前一致）
     * - switches 因凭据本身不可用（401 / 权限不足 / 额度耗尽 / 代理挂了）而换人重试的次数
     *
     * 分开的理由：一个坏 Token 不该把网络抖动的重试额度吃光。否则池里配了 5 个 Token
     * 也只能试到第 3 个就被判失败 —— 那就退化成了「主 Token + 备用」，而不是轮询池。
     */
    let attempt = 1;
    let switches = 0;
    /** 兜底的总轮次上限，防止任何意外路径把循环变成死循环 */
    let rounds = 0;
    const maxRounds = RETRY_MAX_ATTEMPTS + MAX_CREDENTIAL_SWITCHES + 1;

    for (;;) {
      rounds += 1;
      if (rounds > maxRounds) {
        throw new TransientError("GitHub 请求失败: 超过最大重试次数", { details: { url } });
      }

      // 修改点（第 3 期 3-B）：每一次尝试都重新挑一次 Token / 代理 —— 这是个轮询池，
      // 每次调用都会往后推进游标，请求因此持续分摊到池里的每一条，
      // 而不是只有当前凭据失败了才切换。
      // 修改点（审计修复 1）：API 请求不走代理，所以也不挑代理（不推进代理游标）。
      const credential = await this._pickCredential({
        needProxy: !gated,
        excludeTokenScopes,
        excludeProxyScopes,
      });
      const targetUrl = this._applyCredentialProxy(url, { proxy: credential.proxy, apiRequest: gated });
      /**
       * 本次是否真的经过了代理。
       * 修改点（审计修复 1 配套）：归因要看「实际是否走了代理」而不是「有没有挑到代理」，
       * 否则 API 请求的网络抖动会冷却掉一个根本没参与本次请求的代理节点。
       */
      const proxyApplied = targetUrl !== url;

      // 修改点（第 3 期）：发起前先过调度器——
      // 1) 查共享额度账本，额度不足时直接抛 RateLimitedError（一个请求都不发），
      //    由第 2 期已经做好的延迟重试流程接住；
      // 2) 排队等全局并发名额与最小发起间隔。
      // 每一次「重试」都是一次真实请求，所以通行证按轮次逐个申请。
      let ticket = null;
      if (gated) {
        try {
          ticket = await this._acquireRequestTicket(url, credential);
        } catch (quotaError) {
          // 修改点（审计修复 — 各 Token 独立限流）：被限流的是「这一个 Token」，
          // 它的额度是独立分区。池里还有别的可用 Token 时应当立刻换一个继续，
          // 而不是让整次请求因为某一个 Token 没额度就失败。
          if (
            quotaError instanceof RateLimitedError &&
            credential.token &&
            credential.usableTokenCount > 1 &&
            switches < MAX_CREDENTIAL_SWITCHES
          ) {
            excludeTokenScopes.add(credential.tokenScopeId);
            switches += 1;
            console.warn(`[GithubRepoProvider] 当前 Token 额度不足，换池内下一个继续: ${url}`);
            continue;
          }
          throw quotaError;
        }
      }

      const abort = this._linkAbort(externalSignal, timeoutMs);
      let resp = null;
      let fetchError = null;
      try {
        // 注意：headers 用**原始 URL** 生成（伪装头要按真实目标算），
        // 而 errors / details 里也一律记原始 URL —— 代理地址可能含认证信息，绝不能外泄
        resp = await fetch(targetUrl, {
          ...init,
          headers: this._buildHeaders(init.headers || {}, url, credential.token),
          signal: abort.signal,
        });
      } catch (e) {
        fetchError = e;
      } finally {
        // 已拿到响应头（或已失败）：立刻停掉超时定时器
        abort.clearTimer();
        // 归还并发名额，并把响应头里的额度信息写回共享账本（resp 为 null 表示请求抛错）
        if (ticket) await ticket.settle(resp);
        // 修改点（第 3 期 3-B）：把失败归因到具体凭据，让后续请求自动避开它
        await this._noteCredentialFailure(credential, {
          networkError: Boolean(fetchError),
          status: resp?.status ?? null,
          proxyApplied,
        });
      }

      if (fetchError) {
        const e = fetchError;

        // 调用方主动中止（任务取消 / 下载停滞看门狗）
        // 修改点（第 2 期 错误分类）：归类为「暂时性」而不是永久失败——
        // 传输停滞通常是上游或代理抽风，过几分钟自己会好，记 failed 反而要等一个完整周期。
        // 真正的「任务被取消」由 handler 在捕获时用 context.isCancelled 单独识别，
        // 不会走到这里被误判成可重试。
        if (externalSignal?.aborted) {
          throw new TransientError("GitHub 请求已中止（任务取消或传输停滞超时）", {
            retryAfterMs: RETRY_BASE_DELAY_MS,
            details: { url },
          });
        }

        const timedOut = abort.state.timedOut;

        // 修改点（审计修复 2）：网络失败且本次确实走了代理 —— 先换一个代理节点试。
        // 这不消耗网络重试预算：问题在节点上，不在网络上。
        // 冷却已由 _noteCredentialFailure 写进账本，这里再加一次本轮排除，
        // 确保紧接着的 _pickCredential 一定轮到别的节点（而不是靠游标碰运气）。
        if (proxyApplied && credential.proxyScopeId) {
          excludeProxyScopes.add(credential.proxyScopeId);
          if (credential.usableProxyCount > 1 && switches < MAX_CREDENTIAL_SWITCHES) {
            switches += 1;
            console.warn(
              `[GithubRepoProvider] 代理节点${timedOut ? "超时" : "失败"}，换池内下一个继续: ${url}`,
            );
            continue;
          }
        }

        if (attempt < RETRY_MAX_ATTEMPTS && canRetryNetwork) {
          console.warn(
            `[GithubRepoProvider] 请求${timedOut ? "超时" : "失败"}，第 ${attempt} 次重试: ${url}`,
          );
          await this._sleep(this._computeDelayMs({ attempt }));
          attempt += 1;
          continue;
        }

        // 修改点（第 2 期 错误分类）：超时/连接重置属于「暂时性」，不再是永久失败
        throw new TransientError(
          timedOut
            ? `GitHub 请求超时：${timeoutMs}ms 内未返回响应头（已重试 ${RETRY_MAX_ATTEMPTS} 次）`
            : "GitHub 请求失败: 网络错误",
          {
            retryAfterMs: RETRY_BASE_DELAY_MS,
            details: { url, cause: e?.message || String(e) },
          },
        );
      }

      // 已拿到响应头（超时定时器与并发名额都在上面的 finally 里处理完了）

      if (resp.status === 404) {
        await this._discardBody(resp);

        // 修改点（第 3 期 3-B 回退规则）：
        // 本次是「配置了凭据但它们此刻全都不可用」而被迫降级成匿名发出去的。
        // 这种情况下 404 极可能只是匿名看不见私有仓库，而不是仓库真的不存在 ——
        // 按暂时性错误重试（等凭据恢复），避免第 2 期刚消除的
        // 「私有仓库被记成永久失败」重新出现。
        if (!credential.token && (hasConfiguredEntries(this._repoPool, POOL_TOKEN_KEY) || hasConfiguredEntries(this._globalPool, POOL_TOKEN_KEY))) {
          throw new TransientError(
            "GitHub 资源不可见（本次以匿名身份请求，配置的 Token 暂时都不可用，稍后重试）",
            { retryAfterMs: RETRY_BASE_DELAY_MS, details: { url, reason: "anonymous-fallback" } },
          );
        }

        throw new NotFoundError("GitHub 资源不存在（仓库、分支或版本不存在，或仓库为私有）", { url });
      }

      if (resp.ok) {
        return resp;
      }

      const { retryAfter, reset, remaining } = this._readRetryHeaders(resp);
      const rateLimited = resp.status === 429 || (resp.status === 403 && (retryAfter != null || remaining === 0));
      // 修改点（第 2 期 错误分类）：5xx 一律按「暂时性」处理。
      // 原实现只认 502/503/504，500 等会被当成永久性错误直接记 failed。
      const retryableServer = resp.status >= 500;

      // ------------- 凭据被拒：换池内下一个继续（修改点：审计修复 2）-------------
      //
      // 401            = 这个 Token 明确失效（已由 _noteCredentialFailure 冷却 15 分钟）
      // 403 且非限流   = 这个 Token 对该仓库权限不足 / SSO 未授权
      //
      // 池里还有别的可用 Token 时必须立刻换一个重试，否则一个坏 Token 就能把整轮
      // 判成永久失败、写进备份历史 —— 多 Token 池的意义正是「坏了就换下一个」。
      // 这类重试不消耗网络重试预算（问题在凭据上，不在网络上）。
      //
      // 403 刻意只在本轮排除、不落库冷却：它多半是「这个 Token + 这个仓库」的组合问题，
      // 写长冷却会误伤该 Token 在其他仓库的正常使用。
      const credentialRejected = resp.status === 401 || (resp.status === 403 && !rateLimited);
      if (
        credentialRejected &&
        credential.token &&
        credential.usableTokenCount > 1 &&
        switches < MAX_CREDENTIAL_SWITCHES
      ) {
        await this._discardBody(resp);
        excludeTokenScopes.add(credential.tokenScopeId);
        switches += 1;
        console.warn(
          `[GithubRepoProvider] HTTP ${resp.status}（当前 Token 不可用），换池内下一个继续: ${url}`,
        );
        continue;
      }

      // ------------- 限流（修改点：第 2 期 限流 = 延迟，不是失败）-------------
      if (rateLimited) {
        // 修改点（审计修复 — 各 Token 独立限流）：撞到 429 的只是「这一个 Token」。
        // 池里还有别的可用 Token 时先换人，不要让整个请求陪着它等额度恢复。
        if (credential.token && credential.usableTokenCount > 1 && switches < MAX_CREDENTIAL_SWITCHES) {
          await this._discardBody(resp);
          excludeTokenScopes.add(credential.tokenScopeId);
          switches += 1;
          console.warn(`[GithubRepoProvider] HTTP ${resp.status}（当前 Token 限流），换池内下一个继续: ${url}`);
          continue;
        }

        const delayMs = this._computeDelayMs({
          attempt,
          retryAfterSeconds: retryAfter,
          resetEpochSeconds: reset,
        });

        // 恢复时间在可等待范围内：本次请求内先睡一下再试（与改造前一致的短退避）
        if (attempt < RETRY_MAX_ATTEMPTS && delayMs <= RATE_LIMIT_MAX_WAIT_MS) {
          await this._discardBody(resp);
          console.warn(
            `[GithubRepoProvider] HTTP ${resp.status}（限流），${delayMs}ms 后第 ${attempt} 次重试: ${url}`,
          );
          await this._sleep(delayMs);
          attempt += 1;
          continue;
        }

        // 恢复时间太远（未配置 token 时最常见，reset 可能在一小时之后）：
        // 既不能在这里静默睡一小时（看起来就是任务卡死），也不再直接判失败 ——
        // 抛出带恢复时间的「限流错误」，由备份任务转成「延迟重试」交给调度层。
        await this._discardBody(resp);
        const waitMinutes = Math.max(1, Math.ceil(delayMs / 60000));
        // 注意：这里只说事实（多久恢复），不承诺「已安排重试」——
        // 是否安排重试由调用方决定（备份任务会，手动「检查更新」不会）
        throw new RateLimitedError(
          `GitHub API 速率受限，约 ${waitMinutes} 分钟后恢复` +
            `；配置 GitHub Token 可把匿名上限 60 次/小时提高到 5000 次/小时`,
          {
            retryAfterMs: delayMs,
            details: { url, status: resp.status, remaining, reset, waitMs: delayMs },
          },
        );
      }

      // ------------- 5xx：先按指数退避重试，耗尽后抛「暂时性」-------------
      if (retryableServer && canRetryNetwork && attempt < RETRY_MAX_ATTEMPTS) {
        const delayMs = this._computeDelayMs({ attempt });
        await this._discardBody(resp);
        console.warn(
          `[GithubRepoProvider] HTTP ${resp.status}，${delayMs}ms 后第 ${attempt} 次重试: ${url}`,
        );
        await this._sleep(delayMs);
        attempt += 1;
        continue;
      }

      let text = null;
      try {
        text = await resp.text();
      } catch {
        text = null;
      }

      // 5xx 重试耗尽：暂时性错误（不是「仓库有问题」），让上层短时间退避后重试
      if (retryableServer) {
        throw new TransientError(`GitHub 服务暂时不可用: HTTP ${resp.status}`, {
          retryAfterMs: RETRY_BASE_DELAY_MS,
          details: { url, status: resp.status, body: text ? String(text).slice(0, 500) : null },
        });
      }

      // 其余状态码（400/422 等，以及池内已无其他可用 Token 时的 401/403）：
      // 永久性错误，照旧记失败。
      // 修改点（审计修复 2）：401/403 只有在「换无可换」时才落到这里 ——
      // 池里还有可用 Token 的情况已经在上面换人重试了。
      // 单 Token 且它失效时走到这里是对的：那是配置问题，应当让用户看到。
      throw new AppError(`GitHub 请求失败: HTTP ${resp.status}`, {
        status: ApiStatus.INTERNAL_ERROR,
        code: "REPO_BACKUP.GITHUB_REQUEST_FAILED",
        expose: true,
        details: { url, status: resp.status, body: text ? String(text).slice(0, 500) : null },
      });
    }
    // 注意：上面是 for(;;)，所有路径都 return 或 throw，
    // 轮次上限由循环开头的 rounds 兜底（抛 TransientError），此处无需再兜一次。
  }

  // ==================== 凭据池：挑选与故障隔离（第 3 期 3-B）====================

  /**
   * 懒加载全局凭据池（只读一次库）
   *
   * 用「记住 Promise」而不是「记住结果」：并发请求同时进来时只会真正读一次，
   * 后面的调用等着同一个 Promise，不会各自发一次查询。
   * @private
   */
  async _ensureCredentialPools() {
    if (!this._globalPoolPromise) {
      this._globalPoolPromise = loadGlobalPool(this._db, this._encryptionSecret);
    }
    this._globalPool = await this._globalPoolPromise;
    return this._globalPool;
  }

  /**
   * 在候选里轮转挑一个
   *
   * 规则（从主到次）：
   * 1. 仓库级优先于全局级 —— 仓库显式配置的凭据应当先用；
   *    传进来的 candidates 已经过滤掉「此刻不可用」的条目，所以只要仓库级还剩一条
   *    可用，就一定选它，不会掺入全局的（需求：仓库级 -> 全局 -> 匿名）
   * 2. 组内轮转 —— 每次调用都往后推进一位，让请求持续分摊到池里的每一条
   *
   * 这里刻意**不按「剩余额度」排序**：额度见底、处于冷却的候选在上一步就已经被
   * 过滤掉了，留在组里的都是当下可用的；再按额度排序会让流量长期压在某一个凭据上，
   * 反而把「不固定绑定」变成「绑定到额度最多的那个」。
   * 「根据额度动态组合」体现在**排除**上，而不是排序上。
   *
   * 修改点（审计修复 — 轮询均匀性）：游标写回时只自增、不按 group.length 取模。
   * 详见 ROTATION_CURSOR_MODULUS 的说明：用当前组长去约束共享游标会让长池的
   * 尾部凭据永远轮不到。
   *
   * @private
   */
  _rotatePick(candidates, cursorKind) {
    const repoLevel = candidates.filter((c) => c.source === "repository");
    const group = repoLevel.length > 0 ? repoLevel : candidates;

    // 游标跨实例共享（见 credentialRotation 的注释），因此直接读写模块级状态
    const cursor = Number(credentialRotation[cursorKind]) || 0;
    const picked = group[cursor % group.length];
    credentialRotation[cursorKind] = (cursor + 1) % ROTATION_CURSOR_MODULUS;
    return picked;
  }

  /**
   * 为本次请求挑一组 Token + 代理（修改点：第 3 期 3-B）
   *
   * 这是一个**轮询池**，不是「主 Token + 失败备用」：
   * 每次调用都会往后推进游标，因此每一次新的 API / 归档请求都会轮到下一个可用凭据，
   * 而不是等当前凭据失败了才切换。Token 与代理各自独立轮询、不固定绑定。
   *
   * 优先级（与需求一致）：
   *   仓库级 Token/代理  ->  全局池  ->  匿名
   *
   * 回退语义（修改点：第 3 期 3-B 回退规则确认）：
   * - 仓库自己配了就**只用仓库级的**：只要仓库级还有一条可用，就一定选它，绝不掺入全局的
   *   （由 _rotatePick 的 repository 优先保证）
   * - 仓库级此刻全部不可用（限流 / 冷却 / 失效）才回退到全局池
   * - 全局池也不可用就降级为匿名，**不再延迟等待**：匿名额度由调度器的账本单独把关，
   *   真的没额度时 acquire 仍会抛 RateLimitedError，所以这里没必要再造一个「池全灭就停摆」的状态
   *
   * 降级成匿名时如果打到私有仓库会拿到 404，那个误判由 _fetchWithRetry 里的
   * 「被迫匿名」判断单独兜住，不在这里处理。
   *
   * @param {object} [options]
   * @param {boolean} [options.needProxy] 是否需要挑代理（修改点：审计修复 1）。
   *        API 请求一律不走代理，因此也不该挑 —— 否则会白白推进代理游标，
   *        把归档下载的代理分摊搅乱（API 请求通常远多于归档请求）。
   * @param {Set<string>|null} [options.excludeTokenScopes] 本轮已判定不可用的 Token 分区
   * @param {Set<string>|null} [options.excludeProxyScopes] 本轮已判定不可用的代理分区
   * @returns {Promise<{
   *   token: string|null, tokenScopeId: string, tokenSource: string,
   *   proxy: string|null, proxyScopeId: string|null,
   *   usableTokenCount: number, usableProxyCount: number,
   * }>} usableXxxCount 是「排除集生效后仍可用的候选数」，
   *     调用方据此判断「换一个还有没有意义」，避免在只剩一条时空转
   * @private
   */
  async _pickCredential({ needProxy = true, excludeTokenScopes = null, excludeProxyScopes = null } = {}) {
    await this._ensureCredentialPools();

    const nowMs = Date.now();
    // 没有 db 时读不到共享状态，退化为「只看池里的启用情况」
    const states = this._db ? await readScopeStates(this._db) : new Map();

    // ---------- Token ----------
    let token = null;
    let tokenScopeId = ANONYMOUS_SCOPE_ID;
    let tokenSource = "anonymous";
    let usableTokenCount = 0;

    const tokenCandidates = listCredentialCandidates({
      repoPool: this._repoPool,
      globalPool: this._globalPool,
      kind: POOL_TOKEN_KEY,
    });

    if (tokenCandidates.length > 0) {
      const usable = [];
      for (const candidate of tokenCandidates) {
        const scopeId = buildQuotaScopeId(candidate.entry.value);
        // 修改点（审计修复 2）：本轮已经撞过 401 / 额度不足的，直接跳过，
        // 保证「继续轮询其他可用项」而不是反复踩同一个
        if (excludeTokenScopes?.has(scopeId)) continue;
        const state = resolveScopeState(states, scopeId);
        // 每个 Token 的额度状态是独立分区（见 buildQuotaScopeId）：
        // 一个被限流只会把它自己排除，不影响其他 Token
        if (isScopeBlocked(state, { nowMs, reserve: this._schedulerConfig.tokenReserve })) continue;
        usable.push({ ...candidate, scopeId, remaining: state.remaining });
      }

      usableTokenCount = usable.length;
      if (usable.length > 0) {
        const picked = this._rotatePick(usable, "token");
        token = picked.entry.value;
        tokenScopeId = picked.scopeId;
        tokenSource = picked.source;
      }
      // 修改点（第 3 期 3-B 回退规则）：仓库级与全局级此刻都不可用时，
      // 保持 token = null（匿名）继续发请求，而不是延迟重试。
      // 匿名额度的把关交给调度器账本：真的用完了 acquire 会抛 RateLimitedError。
    }

    // ---------- 代理 ----------
    let proxy = null;
    let proxyScopeId = null;
    let usableProxyCount = 0;

    // 修改点（审计修复 1）：只有真的会用到代理的请求（归档下载）才挑代理
    if (needProxy) {
      const proxyCandidates = listCredentialCandidates({
        repoPool: this._repoPool,
        globalPool: this._globalPool,
        kind: POOL_PROXY_KEY,
      });

      if (proxyCandidates.length > 0) {
        const usable = [];
        for (const candidate of proxyCandidates) {
          const scopeId = buildProxyScopeId(candidate.entry.value);
          if (excludeProxyScopes?.has(scopeId)) continue;
          if (isScopeBlocked(resolveScopeState(states, scopeId), { nowMs })) continue;
          usable.push({ ...candidate, scopeId });
        }
        usableProxyCount = usable.length;
        if (usable.length > 0) {
          const picked = this._rotatePick(usable, "proxy");
          proxy = picked.entry.value;
          proxyScopeId = picked.scopeId;
        }
        // 代理全部不可用时直连：直连失败会被归类为「暂时性错误」并安排重试，
        // 比把请求挂在一个已知有问题的节点上要好
      }
    }

    return { token, tokenScopeId, tokenSource, proxy, proxyScopeId, usableTokenCount, usableProxyCount };
  }

  /**
   * 给 URL 套上本次选中的代理
   *
   * 修改点（审计修复 1）：**API 请求一律不走代理**，恢复 gh_proxy 的历史语义。
   *
   * 第 3-B 原实现把凭据池里的代理也套到了 api.github.com 上，这是个误判级的问题：
   * ghproxy 这类「前缀式」加速服务通常只转发 github.com / codeload / raw，
   * 并不转发 api.github.com。请求打过去会拿到代理自己的 404，
   * 而 404 在 _fetchWithRetry 里会被翻译成 NotFoundError（「仓库不存在」）
   * 并被备份任务记成**永久失败** —— 用户只是配了个加速代理，仓库就再也备不了份。
   * 而且这类 HTTP 层失败不会触发代理冷却（只有网络层错误才会），于是每轮都重复踩。
   *
   * 现在的分工回到清晰状态：
   * - API 请求（含自建 endpoint_url 的 API）：直连，不套任何代理
   * - 源码归档下载：优先用凭据池里轮到的代理，池里没有才回落到历史上的 gh_proxy
   *
   * 注意：返回的是「实际要请求的地址」，其中可能含代理的认证信息；
   * 它绝不能被写进日志、错误信息或任务详情 —— 对外一律使用原始 URL。
   *
   * @private
   */
  _applyCredentialProxy(url, { proxy, apiRequest }) {
    // API 请求从不走代理（凭据池里的代理与历史上的 gh_proxy 都不作用于 API）
    if (apiRequest) return url;

    if (proxy) {
      const base = String(proxy).trim().replace(/\/+$/, "");
      return `${base}/${url}`;
    }
    return this._applyGhProxy(url);
  }

  /**
   * 把一次失败归因到具体的凭据上，让后续请求自动避开（修改点：第 3 期 3-B）
   *
   * 归因规则刻意保守：
   * - 网络层失败 + **本次真的走了代理**  -> 认为这个代理节点有问题，短时间避开
   * - 401                              -> 这个 Token 明确失效，较长时间避开
   * - 限流                             -> **不在这里处理**：它由账本里的 remaining/resetAt 表达，
   *                                       再记一份冷却就等于两套状态互相打架
   * - 403 非限流                        -> 多半是「这个 Token 对这个仓库权限不足」，
   *                                       是仓库与 Token 的组合问题而不是 Token 本身失效。
   *                                       写长冷却会误伤它在其他仓库的正常使用，
   *                                       因此只在本轮排除（见 _fetchWithRetry），不落库
   * - 404 / 其它 4xx                    -> 是仓库或权限的问题，不是凭据的问题，不避开
   *
   * 修改点（审计修复 1 配套）：代理冷却必须以 proxyApplied 为准，不能只看
   * credential.proxy 是否存在 —— API 请求已经不走代理了，若仍按「挑到了代理」归因，
   * 一次 API 网络抖动会把一个根本没参与请求的代理节点冷却掉。
   *
   * @private
   */
  async _noteCredentialFailure(credential, { networkError = false, status = null, proxyApplied = false } = {}) {
    if (!this._db || !credential) return;
    const nowMs = Date.now();

    if (networkError && proxyApplied && credential.proxyScopeId) {
      await markScopeCooldown(
        this._db,
        credential.proxyScopeId,
        nowMs + PROXY_FAILURE_COOLDOWN_MS,
        "proxy-network-error",
      );
    }

    if (status === 401 && credential.token && credential.tokenScopeId) {
      await markScopeCooldown(
        this._db,
        credential.tokenScopeId,
        nowMs + TOKEN_INVALID_COOLDOWN_MS,
        "token-invalid",
      );
    }
  }

  /**
   * 申请一张请求通行证（修改点：第 3 期 请求调度）
   *
   * 通行证负责两件事：
   * - 申请时：查共享额度账本 + 排队等并发名额与最小发起间隔；
   *   额度不足会抛 RateLimitedError（一个请求都不发）
   * - 归还时（ticket.settle）：把响应头里的 limit/remaining/reset 写回账本，
   *   让其他任务、其他实例立刻知道额度已经见底，不必各自再撞一次 429
   *
   * 额度分区跟着**本次选中的凭据**走（修改点：第 3 期 3-B）：
   * 用 Token A 打的请求记在 A 的账上，A 被限流不会牵连 Token B。
   *
   * @private
   */
  async _acquireRequestTicket(url, credential = null) {
    const hasToken = Boolean(credential?.token);
    return await githubRequestScheduler.acquire({
      db: this._db,
      scopeId: credential?.tokenScopeId || ANONYMOUS_SCOPE_ID,
      hasToken,
      // 有 Token 时不套用匿名 45 次/小时的预算（见 GithubRequestScheduler 注释）
      budget: hasToken ? null : this._schedulerConfig.anonymousHourlyBudget,
      reserve: hasToken ? this._schedulerConfig.tokenReserve : this._schedulerConfig.anonymousReserve,
      url,
      maxConcurrency: this._schedulerConfig.maxConcurrency,
      minIntervalMs: this._schedulerConfig.minIntervalMs,
      maxStartDelayMs: this._schedulerConfig.maxStartDelayMs,
      windowMs: this._schedulerConfig.windowMs,
    });
  }

  /**
   * 带限流重试的 JSON 请求
   *
   * 修改点（备份任务卡住排查）：_fetchWithRetry 的超时只覆盖到「拿到响应头」，
   * 之后读 body 是没有保护的。JSON 响应虽小，但连接在响应头之后停滞同样会永久挂起，
   * 所以这里给 resp.json() 再加一道截止时间。
   *
   * 修改点（第 3 期 请求去重）：同一额度分区下对同一 URL 的并发 GET 只真正发一次。
   * 合并的是「已经解析好的 JSON 结果」（Response 的 body 只能被读一次，无法分给多个调用方）。
   * 调用方只读不写这些结果，因此共用是安全的。
   *
   * @private
   */
  async _fetchJson(url, init = {}, opts = {}) {
    const method = String(init?.method || "GET").toUpperCase();

    // 只在「GET + API 主机」时合并；非 GET 合并会改变语义
    if (method !== "GET" || !this._isApiRequest(url)) {
      return await this._fetchJsonDirect(url, init, opts);
    }

    // 修改点（第 3 期 3-B）：合并键里带上「当前生效的凭据组合」。
    // 理由：不同 Token / 匿名的可见范围不同（私有仓库匿名会 404），
    // 若只按 URL 合并，配了匿名的一方可能拿到另一方的授权结果。
    // 指纹只包含凭据值的散列，明文不会进入合并键。
    const scopeKey = await this._credentialFingerprint();
    const coalesceKey = `${scopeKey} ${method} ${url}`;

    return await runCoalesced(coalesceKey, () => this._fetchJsonDirect(url, init, opts), {
      ttlMs: this._schedulerConfig.coalesceTtlMs,
    });
  }

  /**
   * 当前生效凭据组合的稳定指纹（修改点：第 3 期 3-B）
   *
   * 只用于请求合并的分区，不参与任何鉴权决策；输出是散列，凭据明文不外泄。
   * 完全没有配置凭据时返回 anonymous，与匿名分区一致。
   * @private
   */
  async _credentialFingerprint() {
    if (this._poolFingerprint) return this._poolFingerprint;

    const globalPool = await this._ensureCredentialPools();
    const parts = [];
    for (const kind of [POOL_TOKEN_KEY, POOL_PROXY_KEY]) {
      for (const candidate of listCredentialCandidates({ repoPool: this._repoPool, globalPool, kind })) {
        parts.push(`${candidate.source}|${kind}|${candidate.entry.value}`);
      }
    }
    parts.sort();

    // buildQuotaScopeId 在这里只当作「把任意字符串映射成不含明文的稳定 id」使用
    this._poolFingerprint = buildQuotaScopeId(parts.join("\n"));
    return this._poolFingerprint;
  }

  /**
   * 真正发请求并解析 JSON（未合并版本）
   * @private
   */
  async _fetchJsonDirect(url, init = {}, opts = {}) {
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
