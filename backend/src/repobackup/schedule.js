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
  return {
    taskId: job.taskId,
    enabled: job.enabled,
    intervalSec: Number(job.intervalSec) || DEFAULT_SCHEDULE_INTERVAL_SEC,
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
 * @param {object} body 请求体
 * @param {object|null} existing 现有的备份计划（loadRepositorySchedule 的返回值）
 * @returns {{ enabled: boolean, intervalSec: number }}
 */
export function resolveScheduleInput(body, existing = null) {
  const enabledRaw = body?.scheduleEnabled ?? body?.schedule_enabled;
  const intervalRaw = body?.scheduleIntervalSec ?? body?.schedule_interval_sec;

  // 未提供时：更新沿用原值，创建用默认值（默认开启 + 每 6 小时）
  const enabled =
    enabledRaw === undefined || enabledRaw === null || enabledRaw === ""
      ? (existing ? existing.enabled : true)
      : Boolean(enabledRaw);

  if (intervalRaw === undefined || intervalRaw === null || intervalRaw === "") {
    return {
      enabled,
      intervalSec: existing ? existing.intervalSec : DEFAULT_SCHEDULE_INTERVAL_SEC,
    };
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

  return { enabled, intervalSec };
}

/**
 * 创建或更新仓库的备份计划行（幂等）
 *
 * - 不存在则按 interval 模式创建，首次执行时间 = now + intervalSec
 * - 已存在则只提交「确实发生变化」的字段：
 *   updateScheduledJob 在 intervalSec / enabled 变化时会重置 next_run_after，
 *   若每次保存仓库都无条件提交 intervalSec，就会把下次备份时间一直往后推
 *
 * @param {D1Database} db
 * @param {object} params
 * @param {object} params.repoRow code_repositories 行（取 id / name / repo_identifier）
 * @param {boolean} params.enabled 是否启用定时备份
 * @param {number} params.intervalSec 备份间隔（秒）
 * @param {object|null} [params.existing] 现有备份计划，省略时内部再读一次
 * @returns {Promise<object|null>} 同步后的备份计划
 */
export async function syncRepositoryScheduleJob(db, { repoRow, enabled, intervalSec, existing = undefined }) {
  const repositoryId = repoRow?.id;
  if (!repositoryId) return null;

  const taskId = buildScheduleTaskId(repositoryId);
  const name = buildScheduleName(repoRow);
  const current = existing === undefined ? await loadRepositorySchedule(db, repositoryId) : existing;

  if (!current) {
    await createScheduledJob(db, {
      taskId,
      handlerId: REPO_BACKUP_SCHEDULE_HANDLER_ID,
      name,
      description: SCHEDULE_DESCRIPTION,
      scheduleType: "interval",
      intervalSec,
      enabled,
      config: { repositoryId },
    });
    return await loadRepositorySchedule(db, repositoryId);
  }

  const patch = { config: { repositoryId } };
  if (current.intervalSec !== intervalSec) patch.intervalSec = intervalSec;
  if (current.enabled !== enabled) patch.enabled = enabled;
  // 仓库改名后，「定时任务」页里的名字要跟着变
  patch.name = name;
  patch.description = SCHEDULE_DESCRIPTION;

  await updateScheduledJob(db, taskId, patch);
  return await loadRepositorySchedule(db, repositoryId);
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
  buildScheduleTaskId,
  buildScheduleName,
  loadAllRepositorySchedules,
  loadRepositorySchedule,
  resolveScheduleInput,
  syncRepositoryScheduleJob,
  removeRepositoryScheduleJob,
};
