/**
 * GitHub 请求调度器 + 匿名额度账本（修改点：第 3 期）
 *
 * 解决的问题：
 *   第 1 期把「N 个分支 N 次请求」压成了 1 次批量请求，第 2 期让限流不再被判失败，
 *   但只要同时有几个仓库在检测/备份，请求仍旧会以最大速度一起打向 api.github.com：
 *   - 匿名额度只有 60 次/小时（按 IP 计），瞬时并发会把额度一次性烧光，
 *     然后所有仓库一起进入「等一小时」的延迟；
 *   - 同一个仓库被「检查更新」和「备份任务」同时解析时，会重复发同样的请求；
 *   - 额度信息只存在于每个响应头里，任务之间、实例之间互不知情。
 *
 * 本模块提供三件事：
 *   1. 进程内节流：全局并发 <= 2、相邻请求发起间隔 >= 800ms
 *      （同一个 Worker isolate / Node 进程内共享；跨实例的上限靠下面的共享账本保证）
 *   2. 共享额度账本：把每次响应里的 limit / remaining / resetAt 落进 metrics_cache，
 *      并把「本窗口已用次数」也记在同一行 —— 因此它是跨任务、跨实例共享的
 *   3. 请求合并：同一 scope + 同一 URL 的并发 GET 只发一次，其余调用方复用结果
 *
 * 额度不足时的行为（本期关键）：
 *   **不发请求**，直接抛 RateLimitedError（带恢复时间）。它会被第 2 期就已经做好的
 *   延迟重试流程接住 —— 不写失败历史、不累计失败数、由调度层到点重跑。
 *
 * 为什么账本放在 metrics_cache 而不是新建表：
 *   该表的定位就是「快照/用量/配额等派生数据」，额度账本正好是派生数据
 *   （remaining/resetAt 都能从响应头重建），复用它零迁移、零 schema 变更。
 *   账本丢失也只是少一层保护：下游还有 GitHub 自己的 429 兜底。
 *
 * 有 Token 时不套用匿名预算：
 *   匿名 45 次/小时是「从 60 里留出 15 次给其他 GitHub 功能」的保守值；
 *   带 Token 时上限是 5000 次/小时，继续按 45 卡就纯粹是在自缚手脚，
 *   因此 budget=null（不做自设上限），只保留一个较小的预留量防止把额度榨干。
 *
 * 已知边界（本期刻意不解决）：
 *   - 并发/间隔是进程内的：Workers 多 isolate 时各自计数，真正的跨实例保护
 *     来自共享账本里的小时预算与 remaining 预检
 *   - 不识别 IP / 代理轮换（本期明确不做）
 */

import { DbTables } from "../constants/index.js";
import { RateLimitedError, TransientError } from "./errors.js";

/** 调度器默认参数 */
export const GITHUB_SCHEDULER_DEFAULTS = {
  /** 全局并发上限（同时「在飞」的 api.github.com 请求数） */
  MAX_CONCURRENCY: 2,
  /** 相邻两次请求发起的最小间隔 */
  MIN_INTERVAL_MS: 800,
  /** 匿名额度下「我方自设」的小时预算（真实上限是 60，留出余量给其他 GitHub 功能） */
  ANONYMOUS_HOURLY_BUDGET: 45,
  /** 匿名额度下从上游 remaining 里预留的余量 */
  ANONYMOUS_RESERVE: 5,
  /** 带 Token 时预留的余量（上限通常 5000，留 50 基本不影响使用） */
  TOKEN_RESERVE: 50,
  /** 额度窗口长度（GitHub 固定按小时滚动） */
  WINDOW_MS: 60 * 60 * 1000,
  /** 恢复时间上多等的缓冲，避免卡在 reset 边界上又被拒一次 */
  RESET_GRACE_MS: 5 * 1000,
  /** 排队等待上限：超过就让调用方走延迟重试，而不是把请求挂死在这里 */
  MAX_START_DELAY_MS: 120 * 1000,
  /** 同一 URL 的结果复用窗口（并发合并 + 极短时间内的重复请求） */
  COALESCE_TTL_MS: 3000,
  /** 合并缓存的容量上限，超过就清理过期项 */
  COALESCE_MAX_ENTRIES: 200,
};

/**
 * 可用环境变量覆盖的参数（Workers 的 vars / Node 的 process.env 都支持）
 * 例：REPO_BACKUP_GITHUB_HOURLY_BUDGET=3 可把小时预算压到 3 次，用于验证超额后的行为
 */
export const GITHUB_SCHEDULER_ENV_KEYS = {
  MAX_CONCURRENCY: "REPO_BACKUP_GITHUB_MAX_CONCURRENCY",
  MIN_INTERVAL_MS: "REPO_BACKUP_GITHUB_MIN_INTERVAL_MS",
  HOURLY_BUDGET: "REPO_BACKUP_GITHUB_HOURLY_BUDGET",
};

/** 账本在 metrics_cache 里的坐标（scope_type / scope_id / metric_key） */
const QUOTA_SCOPE_TYPE = "repobackup_github";
const QUOTA_METRIC_KEY = "rate_limit";

/** 未配置 Token 时共用的账本分区（匿名额度按 IP 计，所有匿名请求共享同一份额度） */
export const ANONYMOUS_SCOPE_ID = "anonymous";

const METRICS_TABLE = DbTables.METRICS_CACHE;

// ==================== 小工具 ====================

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 取整并夹到区间内
 * - null / undefined / 空串表示「没配置」，直接回落默认值
 *   （注意不能只判 Number.isFinite：Number(null) === 0 是有限数，会把默认值吃成 0）
 */
function clampInt(value, min, max, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 从 run() 的返回值里取受影响行数（D1 与 Node SQLite 适配器的形状不同，都要兼容） */
function changesOf(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0) || 0;
}

/**
 * 读取环境变量里的数字
 * - Workers：env 是绑定对象；Node：优先 env，其次 process.env
 * - 空字符串 / 非数字一律当「没配置」，回落到默认值
 */
function readEnvNumber(env, key) {
  const raw = env?.[key] ?? (typeof process !== "undefined" ? process.env?.[key] : undefined);
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * 解析调度参数（provider 构造时调用一次）
 * @param {object|null} env 运行时环境绑定
 * @returns {{ maxConcurrency: number, minIntervalMs: number, anonymousHourlyBudget: number, anonymousReserve: number, tokenReserve: number, windowMs: number }}
 */
export function resolveGithubSchedulerConfig(env = null) {
  const maxConcurrency = readEnvNumber(env, GITHUB_SCHEDULER_ENV_KEYS.MAX_CONCURRENCY);
  const minIntervalMs = readEnvNumber(env, GITHUB_SCHEDULER_ENV_KEYS.MIN_INTERVAL_MS);
  const budget = readEnvNumber(env, GITHUB_SCHEDULER_ENV_KEYS.HOURLY_BUDGET);

  return {
    maxConcurrency: clampInt(maxConcurrency, 1, 8, GITHUB_SCHEDULER_DEFAULTS.MAX_CONCURRENCY),
    minIntervalMs: clampInt(minIntervalMs, 0, 60 * 1000, GITHUB_SCHEDULER_DEFAULTS.MIN_INTERVAL_MS),
    anonymousHourlyBudget: clampInt(budget, 1, 10000, GITHUB_SCHEDULER_DEFAULTS.ANONYMOUS_HOURLY_BUDGET),
    anonymousReserve: GITHUB_SCHEDULER_DEFAULTS.ANONYMOUS_RESERVE,
    tokenReserve: GITHUB_SCHEDULER_DEFAULTS.TOKEN_RESERVE,
    windowMs: GITHUB_SCHEDULER_DEFAULTS.WINDOW_MS,
    /** 排队等待上限（超过就让调用方走延迟重试，不把请求挂死） */
    maxStartDelayMs: GITHUB_SCHEDULER_DEFAULTS.MAX_START_DELAY_MS,
    /** 同一 URL 结果复用窗口（并发合并用） */
    coalesceTtlMs: GITHUB_SCHEDULER_DEFAULTS.COALESCE_TTL_MS,
  };
}

/**
 * FNV-1a 32 位散列（同步、无平台依赖）
 * 用途只有一个：把 Token 映射成稳定的分区名，用于区分「不同 Token 的独立额度」。
 * 不做安全用途，因此不需要加密散列；即使碰撞也只是两个 Token 共用一份保守账本。
 */
function fnv1aHex(input) {
  let hash = 0x811c9dc5;
  const text = String(input);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // 乘以 16777619 并保持在 32 位内（用移位避免大整数精度问题）
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * 计算额度账本的分区 ID
 * - 无 Token：anonymous（匿名额度按 IP 共享，所有匿名仓库共用一份）
 * - 有 Token：token-<散列前 12 位>（不同 Token 的额度互相独立，不能互相阻塞）
 *
 * 注意：这里只输出散列，Token 明文不会进入账本、日志或错误信息。
 *
 * @param {string|null} token
 * @returns {string}
 */
export function buildQuotaScopeId(token) {
  const text = String(token || "").trim();
  if (!text) return ANONYMOUS_SCOPE_ID;
  return `token-${fnv1aHex(text).slice(0, 12)}`;
}

/** 解析账本里的 JSON 列（坏数据一律当空） */
function parseLedgerJson(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 从响应头里取数字（取不到返回 null，0 是合法值） */
function headerNumber(headers, name) {
  const raw = headers?.get?.(name) ?? null;
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

// ==================== 同名请求合并 ====================

/**
 * 在飞/近期结果的合并表
 * key = `${scopeId} ${method} ${url}`
 *
 * 注意：只在同一个进程内生效。合并的是「已经解析好的 JSON 结果」，
 * 因为 Response 的 body 只能被读一次，无法把同一个 Response 分给多个调用方。
 */
const coalescedRequests = new Map();

/** 清理已过期条目 */
function sweepCoalesced(nowMs) {
  for (const [key, entry] of coalescedRequests) {
    if (entry.expiresAt <= nowMs) coalescedRequests.delete(key);
  }
}

/**
 * 合并同名请求（修改点：第 3 期 避免重复请求）
 *
 * 语义：
 * - 同一个 key 的请求正在进行时，后续调用方直接复用同一个 Promise（真的只发一次）
 * - 请求成功后结果保留 ttlMs，覆盖「几乎同时但没完全同时」的第二次调用
 * - 请求失败立即清除，避免把一次失败固化成一个短窗口内的连续失败
 *
 * @template T
 * @param {string|null} key 合并键；为空表示不合并
 * @param {() => Promise<T>} factory 真正发请求的函数
 * @param {{ ttlMs?: number, maxEntries?: number }} [opts]
 * @returns {Promise<T>}
 */
export function runCoalesced(key, factory, opts = {}) {
  if (!key) return Promise.resolve().then(factory);

  const ttlMs = clampInt(opts.ttlMs, 0, 60 * 1000, GITHUB_SCHEDULER_DEFAULTS.COALESCE_TTL_MS);
  const maxEntries = clampInt(opts.maxEntries, 1, 5000, GITHUB_SCHEDULER_DEFAULTS.COALESCE_MAX_ENTRIES);
  const nowMs = Date.now();

  const hit = coalescedRequests.get(key);
  if (hit && hit.expiresAt > nowMs) return hit.promise;

  if (coalescedRequests.size >= maxEntries) sweepCoalesced(nowMs);

  const promise = Promise.resolve().then(factory);
  const entry = { promise, expiresAt: nowMs + ttlMs };
  coalescedRequests.set(key, entry);

  promise.then(
    () => {
      // 成功：把结果的有效期从「发起时刻 + ttl」顺延到「完成时刻 + ttl」
      if (coalescedRequests.get(key) === entry) entry.expiresAt = Date.now() + ttlMs;
    },
    () => {
      if (coalescedRequests.get(key) === entry) coalescedRequests.delete(key);
    },
  );

  return promise;
}

/** 清空合并缓存（测试与运行期排障用） */
export function clearCoalescedCache() {
  coalescedRequests.clear();
}

/** 合并缓存当前条目数（测试用） */
export function coalescedCacheSize() {
  return coalescedRequests.size;
}

// ==================== 调度器 ====================

/**
 * GitHub 请求调度器
 *
 * 实例是「进程级单例」：并发名额与最小间隔必须全进程共享才有效，
 * 所以不要在业务代码里 new，统一用文件末尾导出的 githubRequestScheduler。
 */
export class GithubRequestScheduler {
  constructor(defaults = {}) {
    this._defaults = { ...GITHUB_SCHEDULER_DEFAULTS, ...(defaults || {}) };
    /** 当前在飞请求数 */
    this._active = 0;
    /** 等待并发名额的队列（FIFO） */
    this._waiters = [];
    /** 下一次允许发起请求的最早时刻（发起时刻的预约游标） */
    this._nextStartMs = 0;
    /** 账本不可用的告警只打一次（避免每个请求刷一行日志） */
    this._ledgerWarned = false;
  }

  /** 覆盖默认参数（测试用；运行期改配置请用环境变量） */
  setDefaults(partial = {}) {
    this._defaults = { ...this._defaults, ...(partial || {}) };
  }

  /** 复位运行态（测试用） */
  reset() {
    this._active = 0;
    this._waiters = [];
    this._nextStartMs = 0;
  }

  /** 当前在飞请求数（测试用） */
  get activeCount() {
    return this._active;
  }

  /** 当前排队等待数（测试用） */
  get waitingCount() {
    return this._waiters.length;
  }

  // ---------- 并发名额 ----------

  /**
   * 取一个并发名额
   * - 名额在「移交给下一个等待者」时就已计入 _active，避免交接瞬间的超发
   * @private
   */
  _acquireSlot(maxConcurrency) {
    if (this._active >= maxConcurrency) {
      return new Promise((resolve) => {
        this._waiters.push(() => {
          // 名额直接移交，_active 不变（release 侧做了对应处理）
          resolve();
        });
      });
    }
    this._active += 1;
    return Promise.resolve();
  }

  /**
   * 归还并发名额
   * - 有等待者时把名额直接交给队首，_active 保持不变，避免「先减后加」的窗口里被插队
   * @private
   */
  _releaseSlot() {
    const next = this._waiters.shift();
    if (next) {
      next();
      return;
    }
    this._active = Math.max(0, this._active - 1);
  }

  /**
   * 预约一个「发起时刻」
   * - 必须在没有任何 await 的同步段里调用：并发调用者会依次把游标往后推，
   *   于是「相邻请求间隔 >= minIntervalMs」不会因为同时被唤醒而失效
   * @private
   */
  _reserveStartTime(minIntervalMs) {
    const nowMs = Date.now();
    const startAt = Math.max(nowMs, this._nextStartMs);
    this._nextStartMs = startAt + Math.max(0, minIntervalMs);
    return startAt;
  }

  // ---------- 额度账本 ----------

  /**
   * 读取账本行
   *
   * 读失败一律返回 null（当作「账本不可用」），绝不让异常冒到调用方：
   * 账本只是「礼貌限流」层，它出问题不该把仓库备份整个停掉。
   * @private
   */
  async _readLedger(db, scopeId) {
    try {
      const row = await db
        .prepare(
          `SELECT value_num, snapshot_at_ms, value_json_text, updated_at_ms
             FROM ${METRICS_TABLE}
            WHERE scope_type = ? AND scope_id = ? AND metric_key = ?`,
        )
        .bind(QUOTA_SCOPE_TYPE, scopeId, QUOTA_METRIC_KEY)
        .first();
      return row || null;
    } catch (error) {
      this._warnLedgerUnavailable(error);
      return null;
    }
  }

  /** 账本不可用的提示只打一次，避免刷屏 */
  _warnLedgerUnavailable(error) {
    if (this._ledgerWarned) return;
    this._ledgerWarned = true;
    console.warn(
      `[GithubRequestScheduler] 额度账本不可用，已退化为「只做进程内节流」（fail-open）: ${error?.message || error}`,
    );
  }

  /**
   * 原子占用一个小时预算名额（修改点：第 3 期 共享小时预算）
   *
   * 用「条件写入的受影响行数」当信号，而不是先读后写：
   * 先读后写在并发下会同时放行，而这条 upsert 在 SQLite/D1 里是单语句原子的，
   * 并发调用者会各自看到递增后的值，因此不会超发。
   *
   * 一条语句同时覆盖三种情况：
   * - 行不存在               -> INSERT，开新窗口并占第 1 个名额
   * - 行存在且窗口已过期     -> 重置为 1 并前移窗口起点
   * - 行存在且窗口仍有效     -> +1（但仍受 budget 约束）
   * WHERE 决定这次写入是否真的发生：0 行受影响就说明窗口没结束且预算已用尽。
   *
   * @returns {Promise<{ ok: boolean, resetAtMs?: number, degraded?: boolean }>}
   * @private
   */
  async _reserveBudget(db, scopeId, budget, nowMs, windowMs) {
    try {
      const result = await db
        .prepare(
          `INSERT INTO ${METRICS_TABLE}
             (scope_type, scope_id, metric_key, value_num, value_text, value_json_text, snapshot_at_ms, updated_at_ms, error_message)
           VALUES (?, ?, ?, 1, NULL, NULL, ?, ?, NULL)
           ON CONFLICT(scope_type, scope_id, metric_key) DO UPDATE SET
             value_num = CASE
               WHEN snapshot_at_ms IS NULL OR (? - snapshot_at_ms) >= ? THEN 1
               ELSE COALESCE(value_num, 0) + 1
             END,
             snapshot_at_ms = CASE
               WHEN snapshot_at_ms IS NULL OR (? - snapshot_at_ms) >= ? THEN ?
               ELSE snapshot_at_ms
             END,
             updated_at_ms = ?
           WHERE snapshot_at_ms IS NULL
              OR (? - snapshot_at_ms) >= ?
              OR COALESCE(value_num, 0) < ?`,
        )
        .bind(
          QUOTA_SCOPE_TYPE,
          scopeId,
          QUOTA_METRIC_KEY,
          nowMs, // INSERT 分支：窗口起点
          nowMs, // INSERT 分支：更新时间
          nowMs, // value_num CASE：当前时间
          windowMs, // value_num CASE：窗口长度
          nowMs, // snapshot CASE：当前时间
          windowMs, // snapshot CASE：窗口长度
          nowMs, // snapshot CASE：新窗口起点
          nowMs, // updated_at_ms
          nowMs, // WHERE：当前时间
          windowMs, // WHERE：窗口长度
          budget, // WHERE：预算上限
        )
        .run();

      if (changesOf(result) > 0) return { ok: true };

      // 0 行受影响有两种完全不同的原因，必须区分开：
      //   (a) 写入正常执行了，只是 WHERE 不成立 —— 窗口还在且预算确实用完了，应当拦
      //   (b) 这条 upsert 根本没落库 —— 表不存在、SQL 不被支持、驱动返回值异常，
      //       此时必须放行（fail-open），否则账本一坏所有仓库就再也备不了份
      // 仅凭 changes 分不出 (a) 和 (b)，所以回读一次账本做确认。
      const ledger = await this._readLedger(db, scopeId);
      if (!ledger) {
        this._warnLedgerUnavailable(new Error("额度账本写入未生效（表不存在或 SQL 不被支持）"));
        return { ok: true, degraded: true };
      }

      const windowStartMs = Number(ledger.snapshot_at_ms) || nowMs;
      const used = Number(ledger.value_num) || 0;

      // 窗口已经过期却没能写入新窗口 —— 说明写入路径有问题，同样放行
      if (nowMs - windowStartMs >= windowMs) {
        this._warnLedgerUnavailable(new Error("额度窗口过期后未能重置"));
        return { ok: true, degraded: true };
      }

      // 回读到的已用次数还没到上限，却没能写入 —— 不是「预算用完」，放行
      if (used < budget) {
        this._warnLedgerUnavailable(new Error(`额度计数未按预期递增（已用 ${used}/${budget}）`));
        return { ok: true, degraded: true };
      }

      // 到这里才能确认：窗口仍有效，且本窗口确实已经用满
      return { ok: false, resetAtMs: windowStartMs + windowMs, used };
    } catch (error) {
      // 账本写失败时放行（fail-open）：
      // 宁可少一层「礼貌限流」，也不能因为账本故障把所有仓库备份全部停掉。
      // 上游的 429 仍然会兜住真正的超额。
      console.warn(
        `[GithubRequestScheduler] 额度账本写入失败，本次跳过预算检查（fail-open）: ${error?.message || error}`,
      );
      return { ok: true, degraded: true };
    }
  }

  /**
   * 把响应头里的额度信息写回账本（跨任务、跨实例共享）
   *
   * 只更新 value_json_text / updated_at_ms，绝不碰 value_num / snapshot_at_ms ——
   * 那两列是「本窗口已用次数」的原子计数器，被覆盖会导致预算统计错乱。
   *
   * @private
   */
  async _recordResponse({ db, scopeId, resp, hasToken }) {
    if (!db || !resp?.headers?.get) return;

    const limit = headerNumber(resp.headers, "x-ratelimit-limit");
    const remainingRaw = headerNumber(resp.headers, "x-ratelimit-remaining");
    const reset = headerNumber(resp.headers, "x-ratelimit-reset");
    const retryAfter = headerNumber(resp.headers, "retry-after");

    // 与 provider 里的限流判定保持一致：429，或 403 且 remaining=0
    const rateLimited = resp.status === 429 || (resp.status === 403 && remainingRaw === 0);
    const hasRateHeaders = limit !== null || remainingRaw !== null || reset !== null;
    // 既没有额度响应头、又不是限流：没有任何可记的信息，省掉这次写库
    if (!hasRateHeaders && !rateLimited) return;

    const nowMs = Date.now();
    // retry-after 是「还有多少秒」（GitHub 的语义），优先于 reset 的绝对时刻
    const resetAtMs =
      rateLimited && retryAfter !== null && retryAfter >= 0
        ? nowMs + retryAfter * 1000
        : reset !== null && reset > 0
          ? reset * 1000
          : null;

    const payload = {
      limit,
      remaining: rateLimited ? 0 : remainingRaw,
      resetAtMs,
      hasToken: Boolean(hasToken),
      status: resp.status,
      updatedAtMs: nowMs,
    };

    await db
      .prepare(
        `INSERT INTO ${METRICS_TABLE}
           (scope_type, scope_id, metric_key, value_num, value_text, value_json_text, snapshot_at_ms, updated_at_ms, error_message)
         VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, NULL)
         ON CONFLICT(scope_type, scope_id, metric_key) DO UPDATE SET
           value_json_text = excluded.value_json_text,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .bind(
        QUOTA_SCOPE_TYPE,
        scopeId,
        QUOTA_METRIC_KEY,
        JSON.stringify(payload),
        nowMs,
        nowMs,
      )
      .run();
  }

  /**
   * 请求前额度预检（修改点：第 3 期 额度不足不发请求）
   *
   * 两层判断，任一不通过就抛 RateLimitedError（带恢复时间）：
   * 1. 上游权威额度：账本里 remaining 已低于预留量 -> 这次请求必然被拒，不发
   * 2. 我方小时预算：匿名 45 次/小时（有 Token 时不做自设上限）
   *
   * @private
   */
  async _checkQuota({ db, scopeId, hasToken, budget, reserve, windowMs, url }) {
    if (!db) return { checked: false };

    const reserveAmount = Number.isFinite(reserve)
      ? Number(reserve)
      : hasToken
        ? this._defaults.TOKEN_RESERVE
        : this._defaults.ANONYMOUS_RESERVE;

    const nowMs = Date.now();
    const ledger = await this._readLedger(db, scopeId);
    const info = parseLedgerJson(ledger?.value_json_text);
    const remaining = Number.isFinite(Number(info.remaining)) ? Number(info.remaining) : null;
    const resetAtMs = Number.isFinite(Number(info.resetAtMs)) ? Number(info.resetAtMs) : null;

    // 只有「恢复时间明确且还没到」时才拦：否则可能是一次过期的 remaining=0，
    // 拦下来会让仓库再也恢复不了
    if (remaining !== null && remaining <= reserveAmount && resetAtMs && nowMs < resetAtMs) {
      const retryAtMs = resetAtMs + this._defaults.RESET_GRACE_MS;
      throw new RateLimitedError(
        `GitHub 额度不足（剩余 ${remaining} 次，低于预留的 ${reserveAmount} 次），本次未发送请求，等待额度恢复` +
          (hasToken ? "" : "；配置 GitHub Token 可把匿名上限 60 次/小时提高到 5000 次/小时"),
        {
          // retryAtMs 是权威的绝对时间；retryAfterMs 同时给出，
          // 是为了让第 2 期的 planRetryForError（它按相对时长重算）也能得到同一个时刻
          retryAtMs,
          retryAfterMs: Math.max(0, retryAtMs - nowMs),
          details: { url, scopeId, remaining, reserve: reserveAmount, resetAtMs, source: "github-quota-ledger" },
        },
      );
    }

    // 有 Token 时 budget 为 null：不套用匿名 45 次预算，只依赖上游 remaining
    if (Number.isFinite(budget) && Number(budget) > 0) {
      const reserved = await this._reserveBudget(db, scopeId, Number(budget), nowMs, windowMs);
      if (!reserved.ok) {
        const windowResetAtMs = reserved.resetAtMs || nowMs + windowMs;
        const retryAtMs = windowResetAtMs + this._defaults.RESET_GRACE_MS;
        throw new RateLimitedError(
          `GitHub 每小时请求预算已用尽（上限 ${budget} 次/小时），本次未发送请求，等待下个额度窗口` +
            (hasToken ? "" : "；配置 GitHub Token 可把匿名上限 60 次/小时提高到 5000 次/小时"),
          {
            retryAtMs,
            retryAfterMs: Math.max(0, retryAtMs - nowMs),
            details: { url, scopeId, budget, resetAtMs: reserved.resetAtMs ?? null, source: "github-quota-budget" },
          },
        );
      }
    }

    return { checked: true };
  }

  // ---------- 对外入口 ----------

  /**
   * 请求前排队 + 预检
   *
   * 调用方拿到 ticket 后必须调用一次 ticket.settle(resp)（resp 为 null 表示请求抛错），
   * 用来归还并发名额并把响应头写回账本。
   *
   * @param {object} options
   * @param {any} [options.db] 数据库句柄；为空时跳过额度账本（仍做进程内节流）
   * @param {string} [options.scopeId] 账本分区（见 buildQuotaScopeId）
   * @param {boolean} [options.hasToken] 本次请求是否带 Token
   * @param {number|null} [options.budget] 自设小时预算；null 表示不设上限（有 Token 时）
   * @param {number} [options.reserve] 从上游 remaining 里预留的余量
   * @param {string} [options.url] 仅用于日志与错误详情
   * @returns {Promise<{ settle: (resp: Response|null) => Promise<void> }>}
   */
  async acquire(options = {}) {
    const {
      db = null,
      scopeId = ANONYMOUS_SCOPE_ID,
      hasToken = false,
      budget = null,
      reserve = undefined,
      url = "",
      maxConcurrency = this._defaults.MAX_CONCURRENCY,
      minIntervalMs = this._defaults.MIN_INTERVAL_MS,
      maxStartDelayMs = this._defaults.MAX_START_DELAY_MS,
      windowMs = this._defaults.WINDOW_MS,
    } = options;

    // 1. 额度预检：不通过就直接抛 RateLimitedError，一次请求都不发
    await this._checkQuota({ db, scopeId, hasToken, budget, reserve, windowMs, url });

    // 2. 排队过久时提前放弃：把请求挂在这里不如让调用方走延迟重试
    const projectedStartMs = Math.max(Date.now(), this._nextStartMs);
    if (projectedStartMs - Date.now() > maxStartDelayMs) {
      const waitSec = Math.ceil((projectedStartMs - Date.now()) / 1000);
      throw new TransientError(`GitHub 请求排队过长（预计还需 ${waitSec} 秒），本次跳过等待下轮重试`, {
        retryAfterMs: 60 * 1000,
        details: { url, waitSec },
      });
    }

    // 3. 并发名额
    await this._acquireSlot(maxConcurrency);

    // 4. 最小间隔：预约发起时刻（同步段，避免并发调用同时突破间隔）
    const startAtMs = this._reserveStartTime(minIntervalMs);
    const waitMs = startAtMs - Date.now();
    if (waitMs > 0) await sleep(waitMs);

    let settled = false;
    return {
      /**
       * 收尾：写回额度并归还名额（必须且只能调用一次）
       * @param {Response|null} resp 请求失败时传 null
       */
      settle: async (resp = null) => {
        if (settled) return;
        settled = true;
        try {
          if (resp) {
            await this._recordResponse({ db, scopeId, resp, hasToken });
          }
        } catch (error) {
          // 账本写失败不影响请求本身
          this._warnLedgerUnavailable(error);
        } finally {
          this._releaseSlot();
        }
      },
    };
  }
}

/** 进程级单例：并发名额与发起间隔必须全进程共享才有效 */
export const githubRequestScheduler = new GithubRequestScheduler();

/** 复位单例运行态（测试用） */
export function resetGithubRequestScheduler() {
  githubRequestScheduler.reset();
}

export default {
  GITHUB_SCHEDULER_DEFAULTS,
  GITHUB_SCHEDULER_ENV_KEYS,
  ANONYMOUS_SCOPE_ID,
  GithubRequestScheduler,
  githubRequestScheduler,
  resolveGithubSchedulerConfig,
  buildQuotaScopeId,
  runCoalesced,
  clearCoalescedCache,
  coalescedCacheSize,
  resetGithubRequestScheduler,
};
