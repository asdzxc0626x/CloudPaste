import { MountManager } from "../../storage/managers/MountManager.js";
import { FileSystem } from "../../storage/fs/FileSystem.js";
import { ensureRepositoryFactory } from "../../utils/repositories.js";
import { ValidationError, NotFoundError } from "../../http/errors.js";
import { UserType } from "../../constants/index.js";
import {
  REPO_BACKUP_SCHEDULE_HANDLER_ID,
  STALE_RUNNING_BACKUP_SEC,
} from "../../repobackup/schedule.js";

/**
 * 仓库定时备份任务（修改点：独立备份计划优化）
 *
 * - 每个代码仓库对应一行 scheduled_jobs（task_id = `repo_backup_<仓库ID>`，
 *   config_json = { repositoryId }），由「仓库管理」页在保存仓库时同步维护
 * - handler 只负责创建 taskType = "repo_backup" 的编排作业，
 *   真正的下载/上传/清理在任务系统里跑（与 ScheduledSyncCopyTask 的分工一致）：
 *   调度 tick 有锁超时，绝不能在这里做长耗时的 IO
 * - 一次作业内部会遍历该仓库的全部跟踪分支，所以这里一个仓库只建一个作业
 */
export class ScheduledRepoBackupTask {
  constructor() {
    /** @type {string} 任务唯一标识（用于 ScheduledTaskRegistry && scheduled_jobs.handler_id） */
    this.id = REPO_BACKUP_SCHEDULE_HANDLER_ID;

    /** @type {string} 任务显示名称 */
    this.name = "仓库定时备份";

    /** @type {string} 任务描述 */
    this.description =
      "按每个代码仓库各自的备份计划创建源码备份作业；备份计划在「文件管理 → 仓库管理」中配置";

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
      };
    }

    // 构造 FileSystem（与 ScheduledSyncCopyTask / JobWorkflow 保持一致）
    const mountManager = new MountManager(db, env?.ENCRYPTION_SECRET, repositoryFactory, { env });
    const fileSystem = new FileSystem(mountManager, env);

    // 内部系统身份：定时备份是后台系统级操作，用管理员身份绕过挂载 ACL
    const systemUserId = "system-scheduled-repo-backup";

    const job = await fileSystem.createJob(
      "repo_backup",
      // force=false：仍然按 commitSha 去重，没有新版本时任务内部会记 skipped
      // 修改点（任务列表显示仓库名）：payload 带上 owner/repo，供任务列表直接显示
      { repositoryId, repoIdentifier: repoRow.repo_identifier, force: false },
      systemUserId,
      UserType.ADMIN,
      { triggerType: "scheduled", triggerRef: ctx?.scheduledJobId || this.id },
    );

    return {
      summary: `已为仓库「${repoLabel}」创建定时备份作业（repo_backup 作业 ID=${job.jobId}）`,
      repositoryId,
      repoIdentifier: repoRow.repo_identifier,
      jobId: job.jobId,
      jobIds: [job.jobId],
      createdAt: new Date(ctx?.now || Date.now()).toISOString(),
    };
  }
}
