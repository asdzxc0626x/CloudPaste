/**
 * 代码仓库备份 - 上游错误分类（修改点：第 2 期 限流错误分类 + 延迟重试）
 *
 * 为什么需要单独一层：
 * - Provider 抛出的错误原先只有「消息」没有「类别」，调用方（备份任务）无法区分
 *   「GitHub 限流了，过一会儿自己会好」和「这个分支根本不存在」，
 *   只能一律记 failed —— 于是限流一次就把仓库打进 6 小时的空档。
 * - 这里把错误收敛成三类，并各自带上「多久之后可以再试」的信息：
 *
 *   1. rate_limited 限流（429 / 403 且 x-ratelimit-remaining=0）
 *      -> 不算失败，按 Retry-After / x-ratelimit-reset 延迟到额度恢复后再跑
 *   2. transient 暂时性（超时、连接重置、5xx）
 *      -> 不算失败，短时间退避后重试
 *   3. permanent 永久性（仓库/分支/tag 不存在、参数非法、响应结构异常）
 *      -> 照旧记 failed，不要浪费额度反复重试
 *
 * 边界说明：
 * - 本文件只做「分类 + 延迟计算」，不负责调度；真正把延迟落到
 *   scheduled_jobs.next_run_after 的是 repobackup/schedule.js 与备份任务 handler。
 * - 延迟永远有下限（避免恢复时间算成 0 导致立刻重跑打转）与上限
 *   （避免上游给出离谱的 reset 时间把下一次备份推到很久以后）。
 */

import { AppError } from "../http/errors.js";
import { ApiStatus } from "../constants/index.js";

/** 错误类别 */
export const REPO_ERROR_KIND = {
  RATE_LIMITED: "rate_limited",
  TRANSIENT: "transient",
  PERMANENT: "permanent",
};

/** 延迟重试的时长边界（毫秒） */
export const RETRY_DELAY_MS = {
  /** 限流：下限 30 秒，避免把恢复时间算成 0 后立刻重跑 */
  RATE_LIMITED_MIN: 30 * 1000,
  /** 限流：上限 65 分钟。GitHub 匿名额度按小时重置，reset 不会超过 1 小时，留一点余量 */
  RATE_LIMITED_MAX: 65 * 60 * 1000,
  /** 限流：拿不到 Retry-After / reset 时的兜底等待 */
  RATE_LIMITED_DEFAULT: 60 * 1000,

  /** 暂时性：下限 1 分钟 */
  TRANSIENT_MIN: 60 * 1000,
  /** 暂时性：上限 10 分钟（再久就不像「短时间退避」了） */
  TRANSIENT_MAX: 10 * 60 * 1000,
  /** 暂时性：默认退避 2 分钟 */
  TRANSIENT_DEFAULT: 2 * 60 * 1000,
};

/** 限流错误码（Provider 与调用方共用的常量，避免字面量散落） */
export const RATE_LIMITED_CODE = "REPO_BACKUP.GITHUB_RATE_LIMITED";
/** 暂时性上游错误码 */
export const TRANSIENT_CODE = "REPO_BACKUP.UPSTREAM_TRANSIENT";

/**
 * 限流错误
 *
 * 语义：这不是「失败」，而是「现在不行，等 X 之后再来」。
 * 调用方应当据此安排延迟重试，而不是把它记进失败历史。
 */
export class RateLimitedError extends AppError {
  /**
   * @param {string} message
   * @param {{ retryAfterMs?: number|null, retryAtMs?: number|null, details?: any }} [options]
   */
  constructor(message, { retryAfterMs = null, retryAtMs = null, details = null } = {}) {
    super(message, {
      status: ApiStatus.INTERNAL_ERROR,
      code: RATE_LIMITED_CODE,
      expose: true,
      details,
    });
    this.name = "RateLimitedError";
    /** @type {string} 分类标记，供 classifyRepoBackupError 与跨层传递使用 */
    this.kind = REPO_ERROR_KIND.RATE_LIMITED;

    const normalizedRetryAfter = Number.isFinite(Number(retryAfterMs)) && Number(retryAfterMs) >= 0
      ? Number(retryAfterMs)
      : null;
    const normalizedRetryAt = Number.isFinite(Number(retryAtMs)) && Number(retryAtMs) > 0
      ? Number(retryAtMs)
      : null;

    this.retryAfterMs = normalizedRetryAfter;
    /**
     * 允许再次尝试的绝对时间（epoch ms）
     * - 优先用显式传入的 retryAtMs
     * - 否则由 retryAfterMs 推算
     */
    this.retryAtMs =
      normalizedRetryAt ??
      (normalizedRetryAfter !== null ? Date.now() + normalizedRetryAfter : null);
  }
}

/**
 * 暂时性上游错误（超时、连接重置、5xx）
 *
 * 与限流的区别只是「退避多久」：限流等额度，暂时性错误短退避。
 * 与永久性错误的区别是根本性的：它会自己好，所以不能记成失败。
 */
export class TransientError extends AppError {
  /**
   * @param {string} message
   * @param {{ retryAfterMs?: number|null, details?: any }} [options]
   */
  constructor(message, { retryAfterMs = null, details = null } = {}) {
    super(message, {
      status: ApiStatus.INTERNAL_ERROR,
      code: TRANSIENT_CODE,
      expose: true,
      details,
    });
    this.name = "TransientError";
    this.kind = REPO_ERROR_KIND.TRANSIENT;
    this.retryAfterMs = Number.isFinite(Number(retryAfterMs)) && Number(retryAfterMs) >= 0
      ? Number(retryAfterMs)
      : null;
  }
}

/**
 * 判断某个错误是否属于「可延迟重试」类别
 * @param {string} kind
 * @returns {boolean}
 */
export function isDeferrableKind(kind) {
  return kind === REPO_ERROR_KIND.RATE_LIMITED || kind === REPO_ERROR_KIND.TRANSIENT;
}

/**
 * 取有限数值，拿不到就返回 null
 *
 * 修改点（审计修复 — 返回值契约）：不能只用 Number.isFinite(Number(v)) 判断 ——
 * Number(null) === 0 且 0 是有限数，于是「没有建议等待时长」会被规整成「等待 0 毫秒」。
 * 下游 resolveDeferDelayMs 用 `> 0` 兜住了这个值，行为上没出问题，
 * 但函数声明的 number|null 契约名不副实，排查时容易被误导。
 */
function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 把任意错误归类
 *
 * 优先按错误实例判断；同时兼容「跨层传递导致原型丢失、只剩 code/kind 字段」的情况
 * （例如错误信息被序列化后再还原），避免因为 instanceof 失效而误判成永久性错误。
 *
 * @param {any} error
 * @returns {{
 *   kind: string,
 *   retryAfterMs: number|null,
 *   retryAtMs: number|null,
 *   code: string|null,
 *   message: string,
 * }}
 */
export function classifyRepoBackupError(error) {
  const message = String(error?.message || error || "未知错误");
  const code = error?.code ? String(error.code) : null;

  // 1. 实例判断（正常路径）
  if (error instanceof RateLimitedError || error?.kind === REPO_ERROR_KIND.RATE_LIMITED) {
    return {
      kind: REPO_ERROR_KIND.RATE_LIMITED,
      retryAfterMs: finiteOrNull(error?.retryAfterMs),
      retryAtMs: finiteOrNull(error?.retryAtMs),
      code,
      message,
    };
  }
  if (error instanceof TransientError || error?.kind === REPO_ERROR_KIND.TRANSIENT) {
    return {
      kind: REPO_ERROR_KIND.TRANSIENT,
      retryAfterMs: finiteOrNull(error?.retryAfterMs),
      retryAtMs: null,
      code,
      message,
    };
  }

  // 2. code 兜底（原型丢失时仍能认出限流）
  //    只兜底限流这一条：它的 code 是专用的，而 GITHUB_REQUEST_FAILED 同时覆盖
  //    「网络错误」与「HTTP 4xx」，仅凭 code 无法安全区分，宁可归为永久性错误。
  if (code === RATE_LIMITED_CODE) {
    return {
      kind: REPO_ERROR_KIND.RATE_LIMITED,
      retryAfterMs: finiteOrNull(error?.retryAfterMs),
      retryAtMs: finiteOrNull(error?.retryAtMs),
      code,
      message,
    };
  }
  if (code === TRANSIENT_CODE) {
    return { kind: REPO_ERROR_KIND.TRANSIENT, retryAfterMs: null, retryAtMs: null, code, message };
  }

  // 3. 其余一律永久性（NotFoundError / ValidationError / 解析失败 / 未知异常）
  return { kind: REPO_ERROR_KIND.PERMANENT, retryAfterMs: null, retryAtMs: null, code, message };
}

/** 把数值限制在区间内 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 计算「这次应该等多久再试」（毫秒）
 *
 * - 限流：优先用上游给的恢复时间；没有就用兜底值
 * - 暂时性：固定短退避，忽略上游给的超长等待（5xx 的 Retry-After 偶尔会很大，
 *   那种情况等下去不如按自己的节奏重试）
 *
 * @param {string} kind classifyRepoBackupError 的结果
 * @param {number|null} [retryAfterMs] 上游建议的等待时长
 * @returns {number}
 */
export function resolveDeferDelayMs(kind, retryAfterMs = null) {
  const suggested = Number.isFinite(Number(retryAfterMs)) && Number(retryAfterMs) > 0
    ? Number(retryAfterMs)
    : null;

  if (kind === REPO_ERROR_KIND.RATE_LIMITED) {
    // 多等 5 秒，避免卡在 reset 边界上又被拒一次
    const base = suggested !== null ? suggested + 5000 : RETRY_DELAY_MS.RATE_LIMITED_DEFAULT;
    return clamp(base, RETRY_DELAY_MS.RATE_LIMITED_MIN, RETRY_DELAY_MS.RATE_LIMITED_MAX);
  }

  if (kind === REPO_ERROR_KIND.TRANSIENT) {
    const base = suggested !== null ? suggested : RETRY_DELAY_MS.TRANSIENT_DEFAULT;
    return clamp(base, RETRY_DELAY_MS.TRANSIENT_MIN, RETRY_DELAY_MS.TRANSIENT_MAX);
  }

  // 永久性错误不应该延迟重试；返回 0 让调用方据此判断「不需要延迟」
  return 0;
}

/**
 * 生成给人看的重试时间说明
 * - 用 ISO 字符串，Workers / Node 两侧表现一致（toLocaleString 在 Workers 上不可靠）
 * @param {number} retryAtMs epoch ms
 * @returns {string}
 */
export function describeRetryAt(retryAtMs) {
  const ms = Number(retryAtMs);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms).toISOString();
}

/**
 * 分类 + 计算延迟 + 生成说明，一步到位
 * @param {any} error
 * @returns {{ kind: string, deferrable: boolean, delayMs: number, retryAtMs: number|null, message: string }}
 */
export function planRetryForError(error) {
  const info = classifyRepoBackupError(error);
  const deferrable = isDeferrableKind(info.kind);
  const delayMs = deferrable ? resolveDeferDelayMs(info.kind, info.retryAfterMs) : 0;
  return {
    kind: info.kind,
    deferrable,
    delayMs,
    retryAtMs: deferrable ? Date.now() + delayMs : null,
    message: info.message,
  };
}

/** 类别对应的中文说明（用于日志与提示） */
export function describeErrorKind(kind) {
  switch (kind) {
    case REPO_ERROR_KIND.RATE_LIMITED:
      return "GitHub API 限流";
    case REPO_ERROR_KIND.TRANSIENT:
      return "上游暂时不可用";
    default:
      return "永久性错误";
  }
}

export default {
  REPO_ERROR_KIND,
  RETRY_DELAY_MS,
  RATE_LIMITED_CODE,
  TRANSIENT_CODE,
  RateLimitedError,
  TransientError,
  isDeferrableKind,
  classifyRepoBackupError,
  resolveDeferDelayMs,
  describeRetryAt,
  planRetryForError,
  describeErrorKind,
};
