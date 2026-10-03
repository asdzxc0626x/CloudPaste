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
 * @param {number} [params.activeJobCount] 该仓库未结束的作业数
 * @returns {{ outcome: string, tone: string, message: string|null, retryAt: string|null, at: string|null }}
 */
export function resolveRepositoryState({ enabled = true, latestBackup = null, detectStates = [], activeJobCount = 0 } = {}) {
  const detect = outcomeFromDetectStates(detectStates);
  const backupOutcome = latestBackup ? outcomeFromBackupStatus(latestBackup.status, latestBackup) : null;

  const build = (outcome, message = null, retryAt = null, at = null) => ({
    outcome,
    tone: outcomeTone(outcome),
    message,
    retryAt,
    at,
  });

  // 1. 正在写入
  if (backupOutcome === REPO_OUTCOME.RUNNING) {
    return build(REPO_OUTCOME.RUNNING, null, null, latestBackup?.startedAt ?? latestBackup?.createdAt ?? null);
  }

  // 2. 已被其他任务占住（有未结束的作业，但还没进入写入阶段）
  if (activeJobCount > 0) {
    return build(
      REPO_OUTCOME.BLOCKED,
      `该仓库已有 ${activeJobCount} 个任务正在进行中，本次不会再创建新任务`,
    );
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
  outcomeTone,
  isFailureOutcome,
  isSuccessOutcome,
  outcomeFromBackupStatus,
  outcomeFromDetectStates,
  resolveRepositoryState,
};
