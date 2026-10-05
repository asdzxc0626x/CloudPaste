/**
 * 代码仓库备份 - 统一状态词汇与映射（修改点：状态显示不一致修复）
 *
 * 为什么需要这个模块：
 *   同一个仓库的「结果」原先被三处各自解释，于是两个页面会给出互相矛盾的结论 ——
 *   典型的例子是「立即备份」撞上限流：
 *     · 任务列表读 tasks.stats.itemResults[].status = 'skipped' → 显示「跳过」
 *     · 仓库管理读 code_repositories.last_error（handler 把「已安排自动重试」这句
 *       人话写进了这个字段）→ 前端只要看到非空就渲染成红字 → 看起来是「失败」
 *   两处都没做错，错在**没有共同的语义**：'skipped' 在备份记录里同时表示
 *   「无需备份」和「限流延迟」两件事，last_error 同时表示「真失败」和「延迟说明」。
 *
 * 本模块把这件事收敛成一套词汇，并把「由结构化数据推导结果」这条规则集中到一处：
 *   · 备份记录 status → REPO_OUTCOME
 *   · 检测状态 detectStatus → REPO_OUTCOME
 *   · 两者 + 仓库开关 + 在跑的任务 → 仓库级 REPO_OUTCOME
 * 前端只负责把 outcome 渲染成颜色和文案，不再自己判断「这算不算失败」。
 *
 * 硬性约定（本次修复的验收口径）：
 *   - 只有真正失败才是 error 色调；skipped / deferred / blocked 一律不是失败
 *   - 「已是最新 / 无需备份」属于**成功检测结果**，必须显示为正常态
 *   - 限流与暂时性故障显示为「延迟重试」，既不失败也不显示为空
 */

import { DETECT_STATUS } from "./detect.js";
// 修改点（第 5 期 前端状态展示）：判断备份记录里的 running 是不是残留，
// 复用备份链路的同一个超期窗口，避免两处各写一个阈值
import { STALE_RUNNING_BACKUP_SEC } from "./schedule.js";

/**
 * 统一结果
 *
 * 前七个是仓库/任务页面共用的完整取值；后端任何一处要表达「这次怎么样」，
 * 都必须先落到这里的一个值，不允许再各自造词。
 */
export const REPO_OUTCOME = {
  /** 还没有任何结果（新建仓库、从未检测过） */
  PENDING: "pending",
  /** 正在执行（有 running 的备份记录 / 有未结束的作业） */
  RUNNING: "running",
  /** 成功完成（全部目标都写入成功） */
  SUCCESS: "success",
  /** 部分成功：至少一个目标写成功，但有目标没写成 */
  PARTIAL: "partial",
  /** 已是最新，无需备份（检测成功且水位与已备份一致）—— 属于成功结果 */
  UP_TO_DATE: "up_to_date",
  /** 检测到新版本，等待备份 */
  UPDATE_AVAILABLE: "update_available",
  /** 限流 / 上游暂时不可用，已安排延迟重试 —— 不是失败 */
  DEFERRED: "deferred",
  /** 被其他任务或仓库开关挡住，本次没有执行 —— 不是失败 */
  BLOCKED: "blocked",
  /** 真正失败（仓库/分支不存在、目标写入失败等），需要人工介入 */
  FAILED: "failed",
  /**
   * 检测作业正在执行（修改点：第 5 期 前端状态展示）
   *
   * 与 RUNNING 的区别：RUNNING 指的是「正在写入备份」，
   * DETECTING 指的是「正在向 GitHub 解析版本」，此时还没有任何备份动作。
   * 原先两者被混为一谈 —— 有检测作业时仓库显示「已被阻止」，
   * 用户看到的是「什么都没发生」，而不是「正在检测」。
   */
  DETECTING: "detecting",
};

/**
 * 结果对应的色调，前端据此选颜色：
 * - ok      正常（绿）
 * - info    进行中 / 有动作待做（蓝）
 * - warn    需要注意但不是故障（琥珀）
 * - error   故障（红）
 * - muted   暂无结果（灰）
 */
const OUTCOME_TONE = {
  [REPO_OUTCOME.PENDING]: "muted",
  [REPO_OUTCOME.RUNNING]: "info",
  [REPO_OUTCOME.SUCCESS]: "ok",
  [REPO_OUTCOME.PARTIAL]: "warn",
  [REPO_OUTCOME.UP_TO_DATE]: "ok",
  [REPO_OUTCOME.UPDATE_AVAILABLE]: "info",
  [REPO_OUTCOME.DEFERRED]: "warn",
  [REPO_OUTCOME.BLOCKED]: "warn",
  [REPO_OUTCOME.FAILED]: "error",
  // 修改点（第 5 期）：检测是「正在发生」，用 info（蓝）而不是 muted
  [REPO_OUTCOME.DETECTING]: "info",
};

/** 取结果色调；未知值按「暂无结果」处理，绝不臆断成失败 */
export function outcomeTone(outcome) {
  return OUTCOME_TONE[outcome] || "muted";
}

/**
 * 是否是失败
 *
 * 判定只看色调，不散落 switch：新增 outcome 时只要在 OUTCOME_TONE 里定好色调，
 * 「算不算失败」自动就对。'skipped' / 'deferred' 这类值不可能被判成失败。
 */
export function isFailureOutcome(outcome) {
  return outcomeTone(outcome) === "error";
}

/** 是否属于「成功检测结果」（含无需备份）—— 用于验收「无更新不能显示为失败或空结果」 */
export function isSuccessOutcome(outcome) {
  const tone = outcomeTone(outcome);
  return tone === "ok" || tone === "info";
}

/**
 * 旧数据里「其实是限流 / 上游暂时不可用」的措辞（修改点：旧失败记录压住新结论）
 *
 * 当前代码绝不会把限流写成 failed —— 限流抛 RateLimitedError，落库是 deferred。
 * 但修复前的版本会，例如用户库里这条：
 *   「GitHub API 速率受限，约 40 分钟后才恢复，已放弃等待（请在仓库配置里填写
 *     GitHub Token 提高速率上限，或稍后重试）」
 * 那句「已放弃等待」的措辞在 07494ba4 之后就从代码里删掉了，也就是说凡是带这些
 * 词的 failed 记录都是历史遗留。不认它们的话，这些仓库会永远红着 ——
 * 用户只能手改数据库才消得掉，这显然不对。
 */
const DEFERRABLE_MESSAGE_HINTS = ["速率受限", "已放弃等待", "暂时不可用", "限流", "自动重试"];

/** 这条记录的说明文字看起来是不是「可延迟重试」而非真失败 */
function looksDeferrable(record) {
  const text = record && typeof record.errorMessage === "string" ? record.errorMessage : "";
  if (!text) return false;
  return DEFERRABLE_MESSAGE_HINTS.some((hint) => text.includes(hint));
}

/**
 * 把数据库时间值解析成毫秒（修改点：旧失败记录压住新结论）
 *
 * 为什么不直接 Date.parse：
 *   新写入的时间都是 new Date().toISOString()（带 Z 的 UTC），但更早的数据
 *   与 SQLite 的 CURRENT_TIMESTAMP 默认值是 "YYYY-MM-DD HH:MM:SS"（无时区标记），
 *   后者会被 Date.parse 当成**本地时间**，和前者相比凭空差出一个时区偏移。
 *   统一补成 UTC 再解析，两种格式才可比。
 */
function toMs(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text) ? `${text.replace(" ", "T")}Z` : text;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

/** 逐引用检测里最近一次「成功检测」的时间（毫秒），没有则 null */
function latestSuccessDetectMs(states) {
  let best = null;
  for (const item of Array.isArray(states) ? states : []) {
    if (!item) continue;
    const ms = toMs(item.lastSuccessDetectAt);
    if (ms !== null && (best === null || ms > best)) best = ms;
  }
  return best;
}

/**
 * 备份记录状态 → 统一结果
 *
 * @param {string} status code_repository_backups.status
 * @param {{ errorMessage?: string|null }} [record] 记录本身（用于识别历史数据）
 * @returns {string} REPO_OUTCOME
 */
export function outcomeFromBackupStatus(status, record = null) {
  switch (String(status || "")) {
    case "running":
      return REPO_OUTCOME.RUNNING;
    case "success":
      return REPO_OUTCOME.SUCCESS;
    case "partial":
      // 至少有一个目标写成功了，快照是可用的；但它不是「成功完成」
      return REPO_OUTCOME.PARTIAL;
    case "deferred":
      return REPO_OUTCOME.DEFERRED;
    case "failed":
      /**
       * 修改点（旧失败记录压住新结论）：旧版本把限流也写成 failed，
       * 按语义还原成「延迟重试」。见 DEFERRABLE_MESSAGE_HINTS 的说明 ——
       * 当前代码不可能产生这种记录，所以这里只会命中历史数据。
       */
      return looksDeferrable(record) ? REPO_OUTCOME.DEFERRED : REPO_OUTCOME.FAILED;
    case "skipped":
      /**
       * skipped 有两种来源，必须分开：
       *  · 本次修复之后：「无需备份 / 任务被取消」，属于已是最新
       *  · 历史数据：修复前限流也写 skipped，靠 error_message 里的措辞识别
       * 不做这层识别的话，升级前被限流过的仓库会永远显示成「已跳过」，
       * 用户看不到「已安排重试」这一事实。
       */
      return looksDeferrable(record) ? REPO_OUTCOME.DEFERRED : REPO_OUTCOME.UP_TO_DATE;
    default:
      return REPO_OUTCOME.PENDING;
  }
}

/**
 * 逐引用检测状态 → 仓库级统一结果
 *
 * 聚合口径（与 detectRefs 的语义一致）：
 * - 只要有一个引用检出永久性错误，就按失败展示（错误信息里会带上具体分支）
 * - 只要有一个引用被延迟，就按延迟展示：这说明本轮确实没查完，
 *   不能因为别的分支成功就说「已是最新」
 * - 全部成功且水位与已备份一致 → 已是最新（成功结果）
 * - 还有引用从没检测过 → 暂无结果
 *
 * @param {Array<object>} states toDetectStateDto 的结果数组
 * @returns {{ outcome: string, message: string|null, ref: string|null, retryAt: string|null }}
 */
export function outcomeFromDetectStates(states) {
  const list = Array.isArray(states) ? states.filter(Boolean) : [];
  if (list.length === 0) {
    return { outcome: REPO_OUTCOME.PENDING, message: null, ref: null, retryAt: null };
  }

  const errored = list.find((item) => item.detectStatus === DETECT_STATUS.ERROR);
  if (errored) {
    return {
      outcome: REPO_OUTCOME.FAILED,
      message: errored.lastError || null,
      ref: errored.ref ?? null,
      retryAt: null,
    };
  }

  const deferred = list.find((item) => item.detectStatus === DETECT_STATUS.DEFERRED);
  if (deferred) {
    return {
      outcome: REPO_OUTCOME.DEFERRED,
      message: deferred.lastError || null,
      ref: deferred.ref ?? null,
      // 检测状态里落库了下次检测时间，前端可以直接渲染成本地时间
      retryAt: deferred.nextDetectAfter ?? null,
    };
  }

  const okList = list.filter((item) => item.detectStatus === DETECT_STATUS.OK);
  if (okList.length === 0) {
    // 全是 pending：还没有任何一次成功的检测
    return { outcome: REPO_OUTCOME.PENDING, message: null, ref: null, retryAt: null };
  }

  const withUpdate = okList.find((item) => item.hasUpdate);
  if (withUpdate) {
    return {
      outcome: REPO_OUTCOME.UPDATE_AVAILABLE,
      message: null,
      ref: withUpdate.ref ?? null,
      retryAt: null,
    };
  }

  return { outcome: REPO_OUTCOME.UP_TO_DATE, message: null, ref: null, retryAt: null };
}

// ==================== 三个维度（修改点：第 5 期 前端状态展示）====================

/**
 * 为什么要把状态拆成三个维度
 *
 * 原先仓库管理页只有一个合并结论（resolveRepositoryState），它把
 * 「检测」「备份」「调度」三件事压成一个 outcome。结果是用户无法回答
 * 「上次检测到什么时候」「备份到哪一步了」「下次什么时候跑」——
 * 而且很容易被一条旧记录带偏（例如一条陈旧的 running 备份记录
 * 会让仓库永远显示「进行中」）。
 *
 * 现在三个维度各自独立、各自由结构化数据推导，前端并列展示：
 *   检测维度 ← repo_detect_states + 正在运行的检测作业
 *   备份维度 ← code_repository_backups 最近一条 + 正在运行的备份作业
 *   调度维度 ← scheduled_jobs（下次执行时间 / 上次调度结果）—— 不再用备份记录冒充
 *
 * 合并结论（REPO_OUTCOME）仍然保留，作为列表页的「主徽章」，
 * 保证既有页面与既有测试的行为不变。
 */

/** 检测维度取值（仓库管理页文案：等待检测 / 检测中 / 无更新 / 检测到更新 / 延迟重试 / 失败） */
export const DETECT_OUTCOME = {
  PENDING: "pending",
  DETECTING: "detecting",
  UP_TO_DATE: "up_to_date",
  UPDATE_AVAILABLE: "update_available",
  DEFERRED: "deferred",
  FAILED: "failed",
};

/** 备份维度取值（备份中 / 已备份 / 部分成功 / 已跳过 / 延迟重试 / 失败 / 尚无备份） */
export const BACKUP_STATE = {
  /** 还没有任何备份记录 —— 注意与「已跳过」不同，后者是确实跑过一次但无需备份 */
  PENDING: "pending",
  RUNNING: "running",
  SUCCESS: "success",
  PARTIAL: "partial",
  SKIPPED: "skipped",
  DEFERRED: "deferred",
  FAILED: "failed",
};

/** 调度维度取值（未配置定时 / 定时已关闭 / 等待下次执行 / 上次调度失败） */
export const SCHEDULE_STATE = {
  NONE: "none",
  DISABLED: "disabled",
  WAITING: "waiting",
  FAILED: "failed",
};

/** 各维度的色调（与 OUTCOME_TONE 同一套取值：ok/info/warn/error/muted） */
const DETECT_TONE = {
  [DETECT_OUTCOME.PENDING]: "muted",
  [DETECT_OUTCOME.DETECTING]: "info",
  [DETECT_OUTCOME.UP_TO_DATE]: "ok",
  [DETECT_OUTCOME.UPDATE_AVAILABLE]: "info",
  [DETECT_OUTCOME.DEFERRED]: "warn",
  [DETECT_OUTCOME.FAILED]: "error",
};

const BACKUP_TONE = {
  [BACKUP_STATE.PENDING]: "muted",
  [BACKUP_STATE.RUNNING]: "info",
  [BACKUP_STATE.SUCCESS]: "ok",
  [BACKUP_STATE.PARTIAL]: "warn",
  // 「已跳过」= 跑过了但无需备份，既不是成功快照也不是故障，用中性灰
  [BACKUP_STATE.SKIPPED]: "muted",
  [BACKUP_STATE.DEFERRED]: "warn",
  [BACKUP_STATE.FAILED]: "error",
};

const SCHEDULE_TONE = {
  [SCHEDULE_STATE.NONE]: "muted",
  [SCHEDULE_STATE.DISABLED]: "muted",
  [SCHEDULE_STATE.WAITING]: "info",
  [SCHEDULE_STATE.FAILED]: "error",
};

/** 备份记录 → 备份维度取值（复用 outcomeFromBackupStatus，保证与历史抽屉同一结论） */
function backupStateFromOutcome(outcome) {
  switch (outcome) {
    case REPO_OUTCOME.RUNNING:
      return BACKUP_STATE.RUNNING;
    case REPO_OUTCOME.SUCCESS:
      return BACKUP_STATE.SUCCESS;
    case REPO_OUTCOME.PARTIAL:
      return BACKUP_STATE.PARTIAL;
    case REPO_OUTCOME.DEFERRED:
      return BACKUP_STATE.DEFERRED;
    case REPO_OUTCOME.FAILED:
      return BACKUP_STATE.FAILED;
    case REPO_OUTCOME.UP_TO_DATE:
      // 备份记录里没有「已是最新」这种状态，落到这里只可能是 skipped
      return BACKUP_STATE.SKIPPED;
    default:
      return BACKUP_STATE.PENDING;
  }
}

/**
 * 这条 running 备份记录是不是「残留」
 *
 * 任务进程被杀 / Workers 超时都会留下永远停在 running 的记录。
 * 不做这层判定的话，陈旧的 running 会让仓库永远显示「备份中」，
 * 用户既看不到真实进度，也等不到它结束。
 */
function isStaleRunningBackup(record) {
  if (String(record?.status || "") !== "running") return false;
  const ms = toMs(record?.startedAt ?? record?.createdAt ?? null);
  /**
   * 只有「确实能读出时间、且已经超出超期窗口」才判定为残留。
   * 时间缺失/不可解析时保持原行为（仍视为正在运行）：
   * code_repository_backups.created_at 是 NOT NULL，真实数据一定带时间，
   * 而保守处理可以避免把一条信息不全的记录误判成「没在备份」。
   */
  if (ms === null) return false;
  return Date.now() - ms > STALE_RUNNING_BACKUP_SEC * 1000;
}

/**
 * 检测维度状态
 *
 * @param {object} params
 * @param {Array<object>} [params.detectStates] toDetectStateDto 的结果数组
 * @param {number} [params.activeCheckCount] 该仓库未结束的 repo_backup_check 作业数
 * @returns {{ status: string, tone: string, message: string|null, ref: string|null, retryAt: string|null, nextDetectAfter: string|null, updatedRefCount: number, trackedRefCount: number }}
 */
export function buildDetectState({ detectStates = [], activeCheckCount = 0 } = {}) {
  const list = Array.isArray(detectStates) ? detectStates.filter(Boolean) : [];

  /**
   * 「检测中」优先于上一轮的结论：作业正在跑，此刻的事实就是「正在检测」。
   * 注意这与合并结论里的 RUNNING 不同 —— 那个说的是「正在写备份」。
   */
  if (Number(activeCheckCount) > 0) {
    return {
      status: DETECT_OUTCOME.DETECTING,
      tone: DETECT_TONE[DETECT_OUTCOME.DETECTING],
      message: null,
      ref: null,
      retryAt: null,
      nextDetectAfter: null,
      updatedRefCount: list.filter((item) => item.hasUpdate).length,
      trackedRefCount: list.length,
    };
  }

  const base = outcomeFromDetectStates(list);
  const status = base.outcome === REPO_OUTCOME.DETECTING ? DETECT_OUTCOME.DETECTING : base.outcome;

  // 最近的「下次检测时间」：给前端展示检测节奏，取最早的一个才有指导意义
  let nextDetectAfter = null;
  for (const item of list) {
    const value = item.nextDetectAfter;
    if (!value) continue;
    if (nextDetectAfter === null || String(value) < String(nextDetectAfter)) nextDetectAfter = value;
  }

  return {
    status,
    tone: DETECT_TONE[status] || "muted",
    message: base.message || null,
    ref: base.ref ?? null,
    retryAt: base.retryAt ?? null,
    nextDetectAfter,
    updatedRefCount: list.filter((item) => item.hasUpdate).length,
    trackedRefCount: list.length,
  };
}

/**
 * 备份维度状态
 *
 * @param {object} params
 * @param {object|null} [params.latestBackup] toBackupDto 形态的最近一条备份记录
 * @param {number} [params.activeBackupCount] 该仓库未结束的 repo_backup 作业数
 * @returns {{ status: string, tone: string, message: string|null, at: string|null, ref: string|null, version: string|null, commitSha: string|null }}
 */
export function buildBackupState({ latestBackup = null, activeBackupCount = 0 } = {}) {
  const staleRunning = isStaleRunningBackup(latestBackup);
  // 残留的 running 记录不参与判断（见 isStaleRunningBackup 的说明）
  const record = staleRunning ? null : latestBackup;
  const outcome = record ? outcomeFromBackupStatus(record.status, record) : null;

  let status;
  if (outcome === REPO_OUTCOME.RUNNING || Number(activeBackupCount) > 0) {
    status = BACKUP_STATE.RUNNING;
  } else if (outcome) {
    status = backupStateFromOutcome(outcome);
  } else {
    status = BACKUP_STATE.PENDING;
  }

  return {
    status,
    tone: BACKUP_TONE[status] || "muted",
    message: record?.errorMessage || null,
    at: record?.finishedAt ?? record?.startedAt ?? record?.createdAt ?? null,
    ref: record?.ref ?? null,
    version: record?.version ?? null,
    commitSha: record?.commitSha ?? null,
  };
}

/**
 * 调度维度状态（唯一来源是 scheduled_jobs，不用任何备份历史记录冒充）
 *
 * @param {{ schedule?: object|null }} params schedule 来自 loadRepositorySchedule / loadAllRepositorySchedules
 * @returns {{ status: string, tone: string, nextRunAfter: string|null, lastRunStatus: string|null, lastRunFinishedAt: string|null, runtimeState: string|null, enabled: boolean }}
 */
export function buildScheduleState({ schedule = null } = {}) {
  if (!schedule) {
    return {
      status: SCHEDULE_STATE.NONE,
      tone: SCHEDULE_TONE[SCHEDULE_STATE.NONE],
      nextRunAfter: null,
      lastRunStatus: null,
      lastRunFinishedAt: null,
      runtimeState: null,
      enabled: false,
    };
  }

  const enabled = Boolean(schedule.enabled);
  let status = SCHEDULE_STATE.WAITING;
  if (!enabled) {
    status = SCHEDULE_STATE.DISABLED;
  } else if (String(schedule.lastRunStatus || "") === "failure") {
    status = SCHEDULE_STATE.FAILED;
  }

  return {
    status,
    tone: SCHEDULE_TONE[status] || "muted",
    nextRunAfter: schedule.nextRunAfter ?? null,
    lastRunStatus: schedule.lastRunStatus ?? null,
    lastRunFinishedAt: schedule.lastRunFinishedAt ?? null,
    runtimeState: schedule.runtimeState ?? null,
    enabled,
  };
}

/**
 * 推导仓库级状态（仓库管理列表的唯一状态来源）
 *
 * 优先级说明（为什么是这个顺序）：
 *   1. 正在写入的备份记录 —— 这是此刻正在发生的事实，最该被看到
 *   2. 有未结束的作业但没有 running 记录 —— 说明该仓库已被别的任务占住，
 *      本次不会再创建新任务（就是「被其他任务阻止」）
 *   3. 仓库被禁用 —— 它不可能被备份，任何「已是最新」都是误导
 *   4. 上次备份真失败 —— 失败必须可见，且要带上原因
 *   5. 限流/延迟 —— 非失败，但也要让用户知道「稍后会自动重试」
 *   6. 检测结论：有更新 / 已是最新
 *   7. 上次备份成功但还没检测过新版本
 *
 * @param {object} params
 * @param {boolean} [params.enabled] 仓库是否启用
 * @param {object|null} [params.latestBackup] 最近一条备份记录（toBackupDto 形态）
 * @param {Array<object>} [params.detectStates] 逐引用检测状态（toDetectStateDto 形态）
 * @param {number} [params.activeJobCount] 该仓库未结束的作业数（兼容旧调用方，不区分类型）
 * @param {number} [params.activeCheckCount] 未结束的检测作业数（修改点：第 5 期）
 * @param {number} [params.activeBackupCount] 未结束的备份作业数（修改点：第 5 期）
 * @returns {{ outcome: string, tone: string, message: string|null, retryAt: string|null, at: string|null }}
 */
export function resolveRepositoryState({
  enabled = true,
  latestBackup = null,
  detectStates = [],
  activeJobCount = 0,
  activeCheckCount = null,
  activeBackupCount = null,
} = {}) {
  const legacyActive = Number(activeJobCount) || 0;

  /**
   * 修改点（第 5 期 前端状态展示）：作业数按类型拆开。
   *
   * 只传 activeJobCount 的旧调用方行为完全不变（全部按备份作业处理 → BLOCKED）；
   * 传了拆分值的调用方，检测作业会被识别成「检测中」而不是「已被阻止」。
   */
  const backupActive =
    activeBackupCount === null || activeBackupCount === undefined
      ? legacyActive
      : Number(activeBackupCount) || 0;
  const checkActive =
    activeCheckCount === null || activeCheckCount === undefined
      ? 0
      : Number(activeCheckCount) || 0;

  const detect = outcomeFromDetectStates(detectStates);
  /**
   * 修改点（第 5 期）：残留的 running 备份记录不再冒充「正在进行」。
   * 与 buildBackupState 使用同一个判定，两个入口不会给出矛盾结论。
   */
  const effectiveBackup = isStaleRunningBackup(latestBackup) ? null : latestBackup;
  const backupOutcome = effectiveBackup ? outcomeFromBackupStatus(effectiveBackup.status, effectiveBackup) : null;

  const build = (outcome, message = null, retryAt = null, at = null) => ({
    outcome,
    tone: outcomeTone(outcome),
    message,
    retryAt,
    at,
  });

  // 1. 正在写入
  if (backupOutcome === REPO_OUTCOME.RUNNING) {
    return build(REPO_OUTCOME.RUNNING, null, null, effectiveBackup?.startedAt ?? effectiveBackup?.createdAt ?? null);
  }

  // 2. 已被备份任务占住（有未结束的备份作业，但还没进入写入阶段）
  if (backupActive > 0) {
    return build(
      REPO_OUTCOME.BLOCKED,
      `该仓库已有 ${backupActive} 个任务正在进行中，本次不会再创建新任务`,
    );
  }

  // 2.5 检测作业正在跑（修改点：第 5 期）：这是「检测中」，不是「被阻止」
  if (checkActive > 0) {
    return build(REPO_OUTCOME.DETECTING);
  }

  // 3. 仓库被禁用：此时说「已是最新」或「成功」都是误导
  if (!enabled) {
    return build(REPO_OUTCOME.BLOCKED, "仓库已禁用，不会执行备份");
  }

  /**
   * 这条非成功的备份记录是否已经被更新的成功检测「结清」
   * （修改点：旧失败记录压住新结论）
   *
   * 用户实际遇到的问题：10/02 因限流没备份成（旧版本把限流写成 failed），
   * 10/03 的检测已经成功、且确认「当前版本就是已经备份过的版本」，
   * 仓库管理却仍然红着显示 10/02 那句限流说明。原因是下面第 4/5 步
   * 只看「最近一条备份记录」，既不比时间，也不看检测结论 ——
   * 于是一条旧失败可以永久压住之后所有的成功事实。
   *
   * 判定要两个条件同时成立，缺一不可：
   *   · 有一次**成功检测**发生在这条备份记录之后 —— 它是更新的事实；
   *   · 该次检测的结论是「已是最新」（解析到的版本 = 已备份水位）—— 说明
   *     那次没做完的活现在已经没有了。
   * 若检测结论是「有新版本」，说明那次失败留下的工作还没完成，
   * 必须继续报失败 —— 这条守卫确保修复不会把真正的失败藏起来。
   */
  const supersededByDetect = (() => {
    if (detect.outcome !== REPO_OUTCOME.UP_TO_DATE) return false;
    const detectMs = latestSuccessDetectMs(detectStates);
    if (detectMs === null) return false;
    const backupMs = toMs(latestBackup?.finishedAt ?? latestBackup?.createdAt ?? null);
    // 备份记录没有可比时间时不敢下结论：宁可继续显示它，也不要把真失败藏起来
    if (backupMs === null) return false;
    return detectMs > backupMs;
  })();

  // 4. 真失败：原因必须带出来，不能只给一个红点
  if (backupOutcome === REPO_OUTCOME.FAILED && !supersededByDetect) {
    return build(
      REPO_OUTCOME.FAILED,
      latestBackup?.errorMessage || null,
      null,
      latestBackup?.finishedAt ?? latestBackup?.createdAt ?? null,
    );
  }

  // 5. 延迟重试（备份阶段撞限流，或检测阶段撞限流）
  if (!supersededByDetect && (backupOutcome === REPO_OUTCOME.DEFERRED || detect.outcome === REPO_OUTCOME.DEFERRED)) {
    const fromBackup = backupOutcome === REPO_OUTCOME.DEFERRED;
    return build(
      REPO_OUTCOME.DEFERRED,
      // 备份记录的说明更贴近「这次备份尝试」，优先它；没有则用检测状态里的
      (fromBackup ? latestBackup?.errorMessage : detect.message) || detect.message || null,
      // 重试时间只有一个机器可读的来源：检测状态里的 next_detect_after。
      // 两条链路都延迟时（检测被限流 → 没建备份作业 → 补了一条 deferred 留痕），
      // 备份记录的 error_message 只带人话时间，拿不到结构化时间，
      // 因此这里始终优先用检测状态给的值，让前端能本地化展示。
      detect.retryAt || null,
      fromBackup ? latestBackup?.finishedAt ?? latestBackup?.createdAt ?? null : null,
    );
  }

  // 6. 检测结论优先于「上次备份成功」：它更新
  if (detect.outcome === REPO_OUTCOME.FAILED) {
    return build(REPO_OUTCOME.FAILED, detect.message);
  }
  if (detect.outcome === REPO_OUTCOME.UPDATE_AVAILABLE) {
    return build(REPO_OUTCOME.UPDATE_AVAILABLE, null, null, null);
  }
  if (detect.outcome === REPO_OUTCOME.UP_TO_DATE) {
    return build(REPO_OUTCOME.UP_TO_DATE);
  }

  // 7. 只剩「上次备份成功」这一条信息
  if (backupOutcome === REPO_OUTCOME.SUCCESS || backupOutcome === REPO_OUTCOME.PARTIAL) {
    return build(
      backupOutcome,
      backupOutcome === REPO_OUTCOME.PARTIAL ? latestBackup?.errorMessage || null : null,
      null,
      latestBackup?.finishedAt ?? latestBackup?.createdAt ?? null,
    );
  }

  return build(REPO_OUTCOME.PENDING);
}

export default {
  REPO_OUTCOME,
  // 修改点（第 5 期 前端状态展示）：三个维度的取值与推导
  DETECT_OUTCOME,
  BACKUP_STATE,
  SCHEDULE_STATE,
  outcomeTone,
  isFailureOutcome,
  isSuccessOutcome,
  outcomeFromBackupStatus,
  outcomeFromDetectStates,
  buildDetectState,
  buildBackupState,
  buildScheduleState,
  resolveRepositoryState,
};
