/**
 * 代码仓库备份 - 独立备份计划（修改点：独立备份计划优化）
 *
 * 设计要点（为什么不在 code_repositories 上加 schedule 字段）：
 * - 备份计划的全部语义（启用、间隔、下次运行时间、分布式锁、运行历史、失败计数）
 *   scheduled_jobs + ScheduledTaskRegistry 已经完整实现了一遍；再在仓库表上存一份
 *   间隔与开关，就会出现「两处状态需要同步」的漂移问题（例如管理员直接在
 *   「定时任务」页改了间隔，仓库页显示的还是旧值）。
 * - 因此这里把 scheduled_jobs 当作备份计划的唯一数据源：
 *   一个仓库 ⇄ 一行 scheduled_jobs，task_id 由仓库 ID 确定性派生，
 *   handler_id 固定为 repo_backup_schedule。
 * - 好处：仓库的备份计划天然出现在「定时任务」页，带运行历史与下次执行时间预览，
 *   不需要为它重写一套调度。
 *
 * 注意：scheduled_jobs.enabled 只表示「是否启用定时备份」这一项用户选择，
 * 与仓库本身的 enabled 无关。仓库被禁用时不去改动这一行，而是由
 * ScheduledRepoBackupTask 在运行时跳过——否则仓库重新启用后，
 * 用户原先「关闭定时备份」的选择就被冲掉了。
 */

import { ValidationError, NotFoundError } from "../http/errors.js";
import {
  listScheduledJobs,
  createScheduledJob,
  updateScheduledJob,
  deleteScheduledJob,
} from "../services/scheduledJobService.js";

/** ScheduledTaskRegistry 中的 handler ID（= scheduled_jobs.handler_id） */
export const REPO_BACKUP_SCHEDULE_HANDLER_ID = "repo_backup_schedule";

/** task_id 前缀：task_id = `${前缀}${仓库ID}`，迁移脚本里也按同一规则拼接 */
export const REPO_BACKUP_SCHEDULE_TASK_PREFIX = "repo_backup_";

/** 默认每 6 小时备份一次 */
export const DEFAULT_SCHEDULE_INTERVAL_SEC = 6 * 60 * 60;

/**
 * 间隔下限 15 分钟
 * - Workers 的 cron tick 默认 5 分钟一次，Node 默认每分钟一次，
 *   比 tick 还短的间隔没有意义；15 分钟同时也避免把 GitHub API 打到限流
 */
export const MIN_SCHEDULE_INTERVAL_SEC = 15 * 60;

/** 间隔上限 30 天 */
export const MAX_SCHEDULE_INTERVAL_SEC = 30 * 24 * 60 * 60;

/**
 * 「上一次备份仍在进行中」的判定窗口
 * - 超过这个时长的 running 记录视为残留（任务进程被杀、Workers 超时等），
 *   不再阻塞后续调度，否则一条脏记录会让该仓库永久不再自动备份
 */
export const STALE_RUNNING_BACKUP_SEC = 6 * 60 * 60;

/**
 * 「上一次备份仍在进行中」时，本次调度往后推迟多久再看（修改点：第 2 期）
 *
 * 原实现直接按正常间隔（默认 6 小时）计算下次执行时间，意味着
 * 「上一次还差 1 分钟跑完」也要白等 6 小时才能排下一次。
 * 这里由 handler 返回一个短延迟，交给 runDueScheduledJobs 覆盖本次的 next_run_after。
 */
export const RUNNING_GUARD_RETRY_DELAY_MS = 5 * 60 * 1000;

/**
 * 延迟重试的最小等待（修改点：第 2 期）
 * - 防止上游给出 0 或已经过去的重试时间，导致 next_run_after 落在过去、每个 tick 都重跑
 */
export const MIN_DEFER_RETRY_DELAY_MS = 30 * 1000;

/**
 * 由仓库 ID 派生调度作业 ID
 * @param {string} repositoryId
 * @returns {string}
 */
export function buildScheduleTaskId(repositoryId) {
  return `${REPO_BACKUP_SCHEDULE_TASK_PREFIX}${repositoryId}`;
}

/**
 * 调度作业的展示名（出现在「定时任务」页）
 * @param {{ name?: string|null, repo_identifier?: string }} repoRow
 * @returns {string}
 */
export function buildScheduleName(repoRow) {
  const label = repoRow?.name || repoRow?.repo_identifier || "未命名仓库";
  return `仓库备份 - ${label}`;
}

const SCHEDULE_DESCRIPTION = "按该仓库的备份计划自动创建代码仓库备份作业（在「仓库管理」中配置）";

/**
 * 把 scheduled_jobs DTO 收敛为仓库 API 需要的备份计划结构
 * @param {object|null} job listScheduledJobs 返回的 DTO
 * @returns {object|null}
 */
function toScheduleDto(job) {
  if (!job) return null;
  // 修改点（备份计划支持 cron）：scheduleType 决定 intervalSec / cronExpression 哪个有效
  // 注意 scheduledJobService 在 cron 模式下会从表达式推导一个「代表性间隔」填进 intervalSec，
  // 那只是给 UI 看的估算值，不能当成真实配置，所以这里按 scheduleType 分开暴露
  const scheduleType = job.scheduleType === "cron" ? "cron" : "interval";
  return {
    taskId: job.taskId,
    enabled: job.enabled,
    scheduleType,
    intervalSec:
      scheduleType === "interval"
        ? Number(job.intervalSec) || DEFAULT_SCHEDULE_INTERVAL_SEC
        : DEFAULT_SCHEDULE_INTERVAL_SEC,
    cronExpression: scheduleType === "cron" ? job.cronExpression ?? null : null,
    /** cron 模式下由表达式推导出的相邻两次间隔（秒），仅用于展示 */
    estimatedIntervalSec: scheduleType === "cron" ? Number(job.intervalSec) || 0 : null,
    nextRunAfter: job.nextRunAfter ?? null,
    lastRunStatus: job.lastRunStatus ?? null,
    lastRunFinishedAt: job.lastRunFinishedAt ?? null,
    runCount: Number(job.runCount) || 0,
    failureCount: Number(job.failureCount) || 0,
    runtimeState: job.runtimeState ?? "idle",
  };
}

/**
 * 从调度作业 DTO 反推它属于哪个仓库
 * - 优先读 config.repositoryId；缺失时按 task_id 前缀回退，
 *   兼容纯 SQL 回填出的行
 * @param {object} job
 * @returns {string|null}
 */
function resolveRepositoryIdFromJob(job) {
  const fromConfig = job?.config?.repositoryId;
  if (fromConfig) return String(fromConfig);

  const taskId = String(job?.taskId || "");
  if (taskId.startsWith(REPO_BACKUP_SCHEDULE_TASK_PREFIX)) {
    return taskId.slice(REPO_BACKUP_SCHEDULE_TASK_PREFIX.length) || null;
  }
  return null;
}

/**
 * 批量读取备份计划（列表接口用，避免 N+1）
 * @param {D1Database} db
 * @returns {Promise<Map<string, object>>} key = repositoryId
 */
export async function loadAllRepositorySchedules(db) {
  const map = new Map();
  let jobs = [];
  try {
    jobs = await listScheduledJobs(db);
  } catch (error) {
    // 备份计划只是仓库列表上的附加信息，读失败不应让整页 500
    console.warn("[repoBackup] 读取备份计划失败，列表将不展示计划信息:", error?.message || error);
    return map;
  }

  for (const job of jobs) {
    if (job?.handlerId !== REPO_BACKUP_SCHEDULE_HANDLER_ID) continue;
    const repositoryId = resolveRepositoryIdFromJob(job);
    if (!repositoryId) continue;
    map.set(String(repositoryId), toScheduleDto(job));
  }
  return map;
}

/**
 * 读取单个仓库的备份计划
 * @param {D1Database} db
 * @param {string} repositoryId
 * @returns {Promise<object|null>} 未配置时返回 null
 */
export async function loadRepositorySchedule(db, repositoryId) {
  if (!repositoryId) return null;
  try {
    const jobs = await listScheduledJobs(db, { taskId: buildScheduleTaskId(repositoryId) });
    return toScheduleDto(jobs[0] || null);
  } catch (error) {
    console.warn("[repoBackup] 读取备份计划失败:", error?.message || error);
    return null;
  }
}

/**
 * 解析请求体里的备份计划输入
 *
 * 修改点（备份计划支持 cron）：
 * - scheduleType = 'interval' 时用 scheduleIntervalSec（固定间隔）
 * - scheduleType = 'cron' 时用 scheduleCron（标准 5 段表达式，精确到分钟）
 * - 表达式的合法性校验交给 scheduledJobService（它用 cron-parser 做真实解析），
 *   这里只做「必填 + 段数」的前置检查，好给出比解析器更易懂的报错
 *
 * @param {object} body 请求体
 * @param {object|null} existing 现有的备份计划（loadRepositorySchedule 的返回值）
 * @returns {{ enabled: boolean, scheduleType: 'interval'|'cron', intervalSec: number, cronExpression: string|null }}
 */
export function resolveScheduleInput(body, existing = null) {
  const enabledRaw = body?.scheduleEnabled ?? body?.schedule_enabled;
  const intervalRaw = body?.scheduleIntervalSec ?? body?.schedule_interval_sec;
  const typeRaw = body?.scheduleType ?? body?.schedule_type;
  const cronRaw = body?.scheduleCron ?? body?.schedule_cron ?? body?.scheduleCronExpression;

  // 未提供时：更新沿用原值，创建用默认值（默认开启 + 每 6 小时）
  const enabled =
    enabledRaw === undefined || enabledRaw === null || enabledRaw === ""
      ? (existing ? existing.enabled : true)
      : Boolean(enabledRaw);

  const normalizedType = String(typeRaw || "").trim().toLowerCase();
  const scheduleType =
    normalizedType === "cron" || normalizedType === "interval"
      ? normalizedType
      : (existing?.scheduleType === "cron" ? "cron" : "interval");

  // 沿用原值的兜底（创建时回落到默认间隔）
  const fallbackInterval = existing?.intervalSec ?? DEFAULT_SCHEDULE_INTERVAL_SEC;
  const fallbackCron = existing?.cronExpression ?? null;

  if (scheduleType === "cron") {
    const expression = cronRaw === undefined || cronRaw === null ? fallbackCron : String(cronRaw).trim();
    if (!expression) {
      throw new ValidationError("选择 cron 模式时必须填写 cron 表达式");
    }
    // 标准 5 段：分 时 日 月 周（与「定时任务」页一致，最小粒度为分钟）
    const fields = expression.split(/\s+/).filter(Boolean);
    if (fields.length !== 5) {
      throw new ValidationError("cron 表达式必须是 5 段：分 时 日 月 周（例如 30 3 * * *）");
    }
    return { enabled, scheduleType, intervalSec: fallbackInterval, cronExpression: expression };
  }

  if (intervalRaw === undefined || intervalRaw === null || intervalRaw === "") {
    return { enabled, scheduleType, intervalSec: fallbackInterval, cronExpression: null };
  }

  const num = Number(intervalRaw);
  if (!Number.isFinite(num)) {
    throw new ValidationError("备份间隔必须是数字（秒）");
  }
  const intervalSec = Math.trunc(num);
  if (intervalSec < MIN_SCHEDULE_INTERVAL_SEC || intervalSec > MAX_SCHEDULE_INTERVAL_SEC) {
    throw new ValidationError(
      `备份间隔必须在 ${MIN_SCHEDULE_INTERVAL_SEC / 60} 分钟 ~ ${MAX_SCHEDULE_INTERVAL_SEC / 86400} 天之间`,
    );
  }

  return { enabled, scheduleType, intervalSec, cronExpression: null };
}

/**
 * 创建或更新仓库的备份计划行（幂等）
 *
 * - 不存在则创建，首次执行时间由 scheduledJobService 按调度类型计算
 * - 已存在则只提交「确实发生变化」的字段：
 *   updateScheduledJob 在 scheduleType / intervalSec / cronExpression / enabled
 *   变化时会重置 next_run_after，若每次保存仓库都无条件提交这些字段，
 *   就会把下次备份时间一直往后推
 *
 * @param {D1Database} db
 * @param {object} params
 * @param {object} params.repoRow code_repositories 行（取 id / name / repo_identifier）
 * @param {boolean} params.enabled 是否启用定时备份
 * @param {'interval'|'cron'} [params.scheduleType] 调度类型，默认 interval
 * @param {number} params.intervalSec 备份间隔（秒，interval 模式用）
 * @param {string|null} [params.cronExpression] cron 表达式（cron 模式用）
 * @param {object|null} [params.existing] 现有备份计划，省略时内部再读一次
 * @returns {Promise<object|null>} 同步后的备份计划
 */
export async function syncRepositoryScheduleJob(
  db,
  { repoRow, enabled, intervalSec, scheduleType = "interval", cronExpression = null, existing = undefined },
) {
  const repositoryId = repoRow?.id;
  if (!repositoryId) return null;

  const taskId = buildScheduleTaskId(repositoryId);
  const name = buildScheduleName(repoRow);
  const useCron = scheduleType === "cron";
  const current = existing === undefined ? await loadRepositorySchedule(db, repositoryId) : existing;

  if (!current) {
    await createScheduledJob(db, {
      taskId,
      handlerId: REPO_BACKUP_SCHEDULE_HANDLER_ID,
      name,
      description: SCHEDULE_DESCRIPTION,
      scheduleType: useCron ? "cron" : "interval",
      // createScheduledJob 会按 scheduleType 只取用对应的那一个
      intervalSec,
      cronExpression: useCron ? cronExpression : null,
      enabled,
      config: { repositoryId },
    });
    return await loadRepositorySchedule(db, repositoryId);
  }

  const patch = { config: { repositoryId } };
  // 调度类型变了必须提交，否则 interval/cron 互切不生效
  if (current.scheduleType !== (useCron ? "cron" : "interval")) {
    patch.scheduleType = useCron ? "cron" : "interval";
  }
  if (useCron) {
    if (current.cronExpression !== cronExpression) patch.cronExpression = cronExpression;
    // 切到 cron 时即使表达式没变，也要保证 cronExpression 一起提交，
    // 否则 updateScheduledJob 在 cron 模式下会因为 cron_expression 为空而报错
    if (patch.scheduleType === "cron" && patch.cronExpression === undefined) {
      patch.cronExpression = cronExpression;
    }
  } else if (current.intervalSec !== intervalSec || patch.scheduleType === "interval") {
    patch.intervalSec = intervalSec;
  }
  if (current.enabled !== enabled) patch.enabled = enabled;
  // 仓库改名后，「定时任务」页里的名字要跟着变
  patch.name = name;
  patch.description = SCHEDULE_DESCRIPTION;

  await updateScheduledJob(db, taskId, patch);
  return await loadRepositorySchedule(db, repositoryId);
}

/**
 * 把某个仓库的下一次备份提前到指定时间（修改点：第 2 期 延迟重试）
 *
 * 使用场景：
 *   备份任务在跑到一半时遇到 GitHub 限流/暂时性故障。这类错误不是「失败」，
 *   但也不能等到下个正常周期（默认 6 小时）才重来。任务 handler 会把
 *   「允许重试的时间」交给本函数，本函数只做一件事：把它写进既有
 *   scheduled_jobs 行的 next_run_after。
 *
 * 几条必须守住的规则：
 * - 只前移，不后移：WHERE 上带 `next_run_after > ?`，永不推迟既有的正常计划，
 *   所以正常 6 小时周期与限流重试之间是「取更早的那个」，不会互相打架。
 * - 只动 next_run_after 一列：不碰 schedule_type / interval_sec / enabled，
 *   避免与「定时任务」页的配置编辑产生语义冲突。
 * - 计划行不存在（仓库只手动备份，从未开启定时备份）或已禁用时静默跳过：
 *   没有计划可提前，交给管理员手动重试即可。
 *
 * @param {D1Database} db
 * @param {string} repositoryId
 * @param {string} retryAtIso 允许重试的时间（ISO 字符串）
 * @returns {Promise<boolean>} 是否真的把计划提前了
 */
export async function deferRepositoryBackupSchedule(db, repositoryId, retryAtIso) {
  if (!db || !repositoryId || !retryAtIso) return false;

  const retryAt = new Date(retryAtIso);
  if (Number.isNaN(retryAt.getTime())) return false;

  const taskId = buildScheduleTaskId(repositoryId);
  try {
    const result = await db
      .prepare(
        `
        UPDATE scheduled_jobs
        SET next_run_after = ?
        WHERE task_id = ?
          AND enabled = 1
          AND (next_run_after IS NULL OR next_run_after > ?)
      `,
      )
      .bind(retryAtIso, taskId, retryAtIso)
      .run();

    const changes = result?.meta?.changes ?? result?.changes ?? 0;
    return changes > 0;
  } catch (error) {
    // 提前计划失败不应该影响备份任务本身的收尾（它已经决定「本次不算失败」了）
    console.warn(
      `[repoBackup] 提前备份计划失败（repositoryId=${repositoryId}）:`,
      error?.message || error,
    );
    return false;
  }
}

/**
 * 删除仓库的备份计划行（仓库被删除时调用）
 * - 行本来就不存在时静默通过，保证可重入
 * @param {D1Database} db
 * @param {string} repositoryId
 * @returns {Promise<void>}
 */
export async function removeRepositoryScheduleJob(db, repositoryId) {
  if (!repositoryId) return;
  try {
    await deleteScheduledJob(db, buildScheduleTaskId(repositoryId));
  } catch (error) {
    if (error instanceof NotFoundError) return;
    // 仓库已经删掉了，计划行删不掉不该让接口失败；残留行由 handler 报错提示管理员清理
    console.warn("[repoBackup] 删除备份计划失败:", error?.message || error);
  }
}

export default {
  REPO_BACKUP_SCHEDULE_HANDLER_ID,
  REPO_BACKUP_SCHEDULE_TASK_PREFIX,
  DEFAULT_SCHEDULE_INTERVAL_SEC,
  MIN_SCHEDULE_INTERVAL_SEC,
  MAX_SCHEDULE_INTERVAL_SEC,
  STALE_RUNNING_BACKUP_SEC,
  // 修改点（第 2 期）：延迟重试相关
  RUNNING_GUARD_RETRY_DELAY_MS,
  MIN_DEFER_RETRY_DELAY_MS,
  buildScheduleTaskId,
  buildScheduleName,
  loadAllRepositorySchedules,
  loadRepositorySchedule,
  resolveScheduleInput,
  syncRepositoryScheduleJob,
  deferRepositoryBackupSchedule,
  removeRepositoryScheduleJob,
};
