import { MountManager } from "../../storage/managers/MountManager.js";
import { FileSystem } from "../../storage/fs/FileSystem.js";
import { ensureRepositoryFactory } from "../../utils/repositories.js";
import { ValidationError, NotFoundError } from "../../http/errors.js";
import { UserType } from "../../constants/index.js";
import {
  REPO_BACKUP_SCHEDULE_HANDLER_ID,
  STALE_RUNNING_BACKUP_SEC,
  RUNNING_GUARD_RETRY_DELAY_MS,
} from "../../repobackup/schedule.js";

/**
 * 仓库定时备份任务（修改点：独立备份计划优化）
 *
 * - 每个代码仓库对应一行 scheduled_jobs（task_id = `repo_backup_<仓库ID>`，
 *   config_json = { repositoryId }），由「仓库管理」页在保存仓库时同步维护
 * - handler 只负责创建编排作业，真正的网络 IO 在任务系统里跑
 *   （与 ScheduledSyncCopyTask 的分工一致）：调度 tick 有锁超时，
 *   绝不能在这里做长耗时的 IO
 *
 * 修改点（第 4 期 检测状态持久化）：创建的作业类型从 repo_backup 换成 repo_backup_check
 *
 * 换之前：tick → 直接创建 repo_backup → 备份任务内部解析版本 → 大多数时候发现
 *         「没更新」然后记一条 skipped。于是每个周期每个仓库都要：
 *           · 打一次 GitHub 版本 API（哪怕什么都没变）
 *           · 建一条 tasks 行 + 构造 MountManager/FileSystem
 *           · 在任务列表里留一条 skipped 噪音
 *
 * 换之后：tick → 创建 repo_backup_check → 检测任务解析版本并落库 →
 *         **只有发现新版本时**才由它创建 repo_backup（并把已解析的
 *         commitSha/version 一起传过去，备份任务不再问 GitHub）。
 *
 * 不变的部分（刻意不动）：
 * - scheduled_jobs 仍是备份计划的唯一数据源，不新增表、不新增调度框架
 * - 「上一次还在跑就跳过」的守卫仍在这里，且判据仍是 code_repository_backups
 *   里的 running 记录 —— 它要挡的是「备份任务堆积」，和检测无关
 * - 返回 deferMs 让 runDueScheduledJobs 覆盖本次 next_run_after 的机制不变
 */
export class ScheduledRepoBackupTask {
  constructor() {
    /** @type {string} 任务唯一标识（用于 ScheduledTaskRegistry && scheduled_jobs.handler_id） */
    this.id = REPO_BACKUP_SCHEDULE_HANDLER_ID;

    /** @type {string} 任务显示名称 */
    this.name = "仓库定时备份";

    /** @type {string} 任务描述 */
    this.description =
      "按每个代码仓库各自的备份计划创建版本检测作业；只有检测到新版本才会创建备份作业。备份计划在「文件管理 → 仓库管理」中配置";

    /** @type {"maintenance" | "business"} 任务类别 */
    this.category = "business";

    /**
     * 配置参数 Schema
     * - 留空：备份计划由仓库管理页维护（间隔/开关都在仓库表单里），
     *   不在「定时任务」页单独编辑，避免两个入口写同一份配置
     * @type {Array<object>}
     */
    this.configSchema = [];
  }

  /**
   * @param {{ db: D1Database, env: any, now: string, config: any, scheduledJobId?: string }} ctx
   */
  async run(ctx) {
    const { db, env, config } = ctx;

    const repositoryId = String(config?.repositoryId || "").trim();
    if (!repositoryId) {
      throw new ValidationError(
        "备份计划缺少 repositoryId 配置，无法确定要备份哪个仓库；请在「仓库管理」中重新保存该仓库，或删除该调度作业",
      );
    }

    const repositoryFactory = ensureRepositoryFactory(db);
    const codeRepo = repositoryFactory.getCodeRepositoryRepository();

    const repoRow = await codeRepo.findRepositoryById(repositoryId);
    if (!repoRow) {
      // 仓库通过接口删除时计划行会一起删掉；走到这里说明是直接改库等异常情况，
      // 报错让它出现在「定时任务」的失败状态里，由管理员清理，不做静默自愈
      throw new NotFoundError(
        `代码仓库不存在（${repositoryId}），该备份计划已失效，请在「定时任务」中删除它`,
      );
    }

    const repoLabel = repoRow.name || repoRow.repo_identifier;

    // 仓库被禁用：跳过而不是失败。计划行的 enabled 只表达「是否启用定时备份」，
    // 不随仓库启用状态联动，这样仓库重新启用后用户原先的计划选择还在
    if (!(repoRow.enabled === 1 || repoRow.enabled === true)) {
      return {
        summary: `仓库「${repoLabel}」当前已禁用，本次定时备份跳过`,
        repositoryId,
        skipped: true,
      };
    }

    // 上一次备份还没跑完就跳过，避免间隔小于单次备份耗时时作业堆积。
    // 超过 STALE_RUNNING_BACKUP_SEC 的 running 记录视为残留，不再阻塞
    const staleBefore = new Date(Date.now() - STALE_RUNNING_BACKUP_SEC * 1000).toISOString();
    const runningCount = await codeRepo.countRunningBackupsSince(repositoryId, staleBefore);
    if (runningCount > 0) {
      return {
        summary: `仓库「${repoLabel}」上一次备份仍在进行中（${runningCount} 个版本），本次定时备份跳过`,
        repositoryId,
        runningCount,
        skipped: true,
        // 修改点（第 2 期 延迟重试）：本次没有真正执行，不应该白等一个完整周期
        // （默认 6 小时）。返回一个短延迟，由 runDueScheduledJobs 覆盖本次的
        // next_run_after，这样上一次备份一结束，下一次备份就能很快排上。
        deferMs: RUNNING_GUARD_RETRY_DELAY_MS,
      };
    }

    /**
     * 修改点（第 4 期）：检测任务的并发守卫
     *
     * 上面那个守卫看的是 code_repository_backups 里的 running 记录，检测任务不写那张表，
     * 所以挡不住「检测任务还在跑，又创建了一个检测任务」。这种情况是真实存在的：
     * 检测撞限流后会一直在任务里退避重试，耗时可能超过一个备份周期。
     * 重复创建会让同一仓库的请求叠在一起，正好是需求 10 要避免的洪峰。
     *
     * 残留判定复用 STALE_RUNNING_BACKUP_SEC（6 小时）：任务进程被杀 / Workers 超时
     * 留下的 pending 行不能永久阻塞该仓库的检测。
     */
    const activeCheckCount = await codeRepo.countActiveRepoJobs(
      repositoryId,
      ["repo_backup_check"],
      Date.now() - STALE_RUNNING_BACKUP_SEC * 1000,
    );
    if (activeCheckCount > 0) {
      return {
        summary: `仓库「${repoLabel}」上一次版本检测仍在进行中（${activeCheckCount} 个作业），本次跳过`,
        repositoryId,
        activeCheckCount,
        skipped: true,
        deferMs: RUNNING_GUARD_RETRY_DELAY_MS,
      };
    }

    // 构造 FileSystem（与 ScheduledSyncCopyTask / JobWorkflow 保持一致）
    const mountManager = new MountManager(db, env?.ENCRYPTION_SECRET, repositoryFactory, { env });
    const fileSystem = new FileSystem(mountManager, env);

    // 内部系统身份：定时备份是后台系统级操作，用管理员身份绕过挂载 ACL
    const systemUserId = "system-scheduled-repo-backup";

    /**
     * 修改点（第 4 期）：创建版本检测作业，而不是直接创建备份作业
     *
     * createBackup: true —— 检测到新版本时由检测任务自己创建 repo_backup，
     *   并把解析出的 commitSha/version 一起传过去（需求 3 + 需求 4）
     * ignoreDue 不传（即 false）—— 定时路径必须尊重 next_detect_after：
     *   它既是「检测进度」的持久化载体（需求：重启不丢），
     *   也是削峰闸门（需求 10）。手动「检查更新」才会用 ignoreDue。
     */
    const job = await fileSystem.createJob(
      "repo_backup_check",
      { repositoryId, repoIdentifier: repoRow.repo_identifier, createBackup: true },
      systemUserId,
      UserType.ADMIN,
      { triggerType: "scheduled", triggerRef: ctx?.scheduledJobId || this.id },
    );

    return {
      summary: `已为仓库「${repoLabel}」创建版本检测作业（repo_backup_check 作业 ID=${job.jobId}）；只有检测到新版本才会继续创建备份作业`,
      repositoryId,
      repoIdentifier: repoRow.repo_identifier,
      jobId: job.jobId,
      jobIds: [job.jobId],
      createdAt: new Date(ctx?.now || Date.now()).toISOString(),
    };
  }
}
