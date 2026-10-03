// cSpell:words repobackup
import type { TaskHandler, InternalJob, ExecutionContext } from "../TaskHandler.js";
import type { TaskStats, ItemResult, RepoBackupCheckTaskPayload, RepoBackupResolvedRef } from "../types.js";
import { ValidationError, NotFoundError } from "../../../../http/errors.js";
import { ensureRepositoryFactory } from "../../../../utils/repositories.js";
import { UserType } from "../../../../constants/index.js";
import { RepoProviderFactory } from "../../../../repobackup/providers/index.js";
import { parseProviderConfig } from "../../../../repobackup/config.js";
import { describeRetryAt, describeErrorKind } from "../../../../repobackup/errors.js";
import { deferRepositoryBackupSchedule } from "../../../../repobackup/schedule.js";
import {
  DETECT_MAX_REFS_PER_RUN,
  DETECT_STATUS,
  detectRefs,
  prepareDetectRound,
} from "../../../../repobackup/detect.js";

/**
 * 代码仓库版本检测任务（修改点：第 4 期 检测状态持久化 + repo_backup_check）
 *
 * 它在整条链路里的位置：
 *   scheduled_jobs（每仓库一行）
 *     → ScheduledRepoBackupTask（只 createJob，不做 IO）
 *       → **repo_backup_check（本任务）**：解析版本、落库、判断是否有更新
 *         → 仅在有更新时 createJob("repo_backup", { refs: [...已解析版本] })
 *           → RepoBackupTaskHandler：直接用 refs 里的 commitSha 下载，不再问 GitHub
 *
 * 这么分的收益（对比第 1～3 期的「调度 → 直接备份」）：
 * - 无更新时不再创建备份任务：任务列表不再被一堆 skipped 刷屏，
 *   也不再为了「发现没更新」而走一遍 FileSystem / MountManager 的构造开销
 * - 版本解析结果落库：进程/Worker 重启后检测进度不丢（next_detect_after 持久化）
 * - 限流发生在检测阶段，此时还没创建备份任务，延迟语义更干净
 *
 * 必须守住的既有机制（全部复用，没有新增并行实现）：
 * - 第 2 期：限流/暂时性错误 = 延迟不是失败 → deferRepositoryBackupSchedule
 * - 第 3 期：GithubRequestScheduler + Token/代理轮询池 + 独立额度账本
 *   （本任务不直接 fetch，所有请求都经 provider，自动继承这三件事）
 *
 * 削峰（需求 10）：
 * - 本任务一轮最多检测 maxRefs 个引用（默认 DETECT_MAX_REFS_PER_RUN）
 * - 没检测完的引用不丢：它们的 next_detect_after 仍是过去时间，
 *   下一轮 findDueDetectStates 按升序优先取到它们，并返回短延迟让调度早点再来
 */

/** 单个仓库一轮检测的阶段 */
type CheckStage = "preparing" | "detecting" | "dispatching" | "finished";

/**
 * detectRefs 返回的单条检测结果
 *
 * repobackup/detect.js 是 JS 模块（没有 .d.ts），import 进来整体是 any，
 * 于是下面每一处 `.map((item) => ...)` 都会被判为隐式 any。
 * 这里显式声明契约形状，既消掉隐式 any，也把「检测核心给任务层什么」
 * 这件事写死在类型上，改契约时编译期就能发现。
 */
type DetectRefResult = {
  refType: string;
  ref: string | null;
  commitSha: string | null;
  shortCommitSha: string | null;
  version: string | null;
  publishedAt: string | null;
  hasUpdate: boolean;
  alreadyBackedUp: boolean;
  detectStatus: string;
  error: string | null;
  errorKind?: string | null;
  retryAt?: string | null;
};

/** 本轮没检测完时，让调度器多久之后再来（避免白等一个完整备份周期） */
const INCOMPLETE_ROUND_RETRY_MS = 5 * 60 * 1000;

function buildStats(totalItems: number, overrides: Partial<TaskStats> = {}): TaskStats {
  return {
    totalItems,
    processedItems: 0,
    successCount: 0,
    failedCount: 0,
    skippedCount: 0,
    itemResults: [],
    ...overrides,
  };
}

export class RepoBackupCheckTaskHandler implements TaskHandler {
  readonly taskType = "repo_backup_check";

  async validate(payload: any): Promise<void> {
    const p = (payload || {}) as RepoBackupCheckTaskPayload;
    if (!p.repositoryId || typeof p.repositoryId !== "string") {
      throw new ValidationError("repo_backup_check: 缺少 repositoryId");
    }
    if (p.maxRefs !== undefined && p.maxRefs !== null) {
      const n = Number(p.maxRefs);
      if (!Number.isFinite(n) || n < 1) {
        throw new ValidationError("repo_backup_check: maxRefs 必须是正整数");
      }
    }
  }

  createStatsTemplate(_payload: any): TaskStats {
    // 到期引用数要查库才知道，创建时先按 1 占位，execute 里 report 会立刻纠正
    return buildStats(1, { stage: "preparing" as CheckStage });
  }

  async execute(job: InternalJob, context: ExecutionContext): Promise<void> {
    const payload = (job.payload || {}) as RepoBackupCheckTaskPayload;
    const createBackup = payload.createBackup !== false;
    const ignoreDue = payload.ignoreDue === true;
    const force = payload.force === true;
    const maxRefs = Number(payload.maxRefs) > 0 ? Math.trunc(Number(payload.maxRefs)) : DETECT_MAX_REFS_PER_RUN;

    const fileSystem = context.getFileSystem();
    const env = typeof context.getEnv === "function" ? context.getEnv() : null;
    const db = env?.DB ?? fileSystem?.mountManager?.db;
    if (!db) {
      throw new ValidationError("repo_backup_check: 缺少 DB 绑定");
    }

    const encryptionSecret = env?.ENCRYPTION_SECRET ?? fileSystem?.mountManager?.encryptionSecret;
    if (!encryptionSecret) {
      throw new ValidationError("repo_backup_check: 缺少 ENCRYPTION_SECRET");
    }

    const factory = ensureRepositoryFactory(db, fileSystem?.repositoryFactory, env || {});
    const codeRepo = factory.getCodeRepositoryRepository();

    // ---------- 1. 读仓库 ----------
    const repoRow = await codeRepo.findRepositoryById(payload.repositoryId);
    if (!repoRow) {
      throw new NotFoundError(`代码仓库不存在: ${payload.repositoryId}`);
    }
    const repoIdentifier = String(repoRow.repo_identifier || "");
    const repoLabel = repoRow.name || repoIdentifier;

    let stage: CheckStage = "preparing";
    const itemResults: ItemResult[] = [];
    let totalItems = 1;
    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    let createdJobId: string | null = null;
    let deferRetryAt: string | null = null;

    const report = async (processedItems: number, extra: Partial<TaskStats> = {}) => {
      await context.updateProgress(
        job.jobId,
        buildStats(totalItems, {
          processedItems,
          successCount,
          failedCount,
          skippedCount,
          itemResults,
          stage,
          repositoryId: repoRow.id,
          repoIdentifier,
          createdBackupJobId: createdJobId,
          deferRetryAt,
          ...extra,
        }),
      );
    };

    // ---------- 2. 准备本轮：补建状态行 / 清理过期引用 / 挑出到期引用 ----------
    const round = await prepareDetectRound({ codeRepo, repoRow, maxRefs, ignoreDue });

    totalItems = Math.max(1, round.refs.length);
    await report(0);

    if (round.refs.length === 0) {
      // 没有到期的引用：本轮什么都不做。这是常态而非异常
      //（上一轮刚检测过、或者全部引用都在退避中）
      stage = "finished";
      skippedCount = 1;
      itemResults.push({
        kind: "repo",
        label: repoLabel,
        status: "skipped",
        message:
          round.trackedCount === 0
            ? "该仓库未配置任何跟踪引用"
            : `本轮没有到期的引用（共跟踪 ${round.trackedCount} 个，均未到下次检测时间）`,
      });
      await report(1);
      return;
    }

    // ---------- 3. 构造 provider ----------
    // 修改点（第 3 期复用）：带上 db / env / encryptionSecret，于是本任务里的每一次
    // GitHub 请求都自动经过 GithubRequestScheduler（并发/间隔/共享额度账本）
    // 与 Token / 代理轮询池，本文件不需要也不应该自己做节流或凭据选择
    const providerConfig = await parseProviderConfig(repoRow.provider, repoRow.config_json, encryptionSecret);
    const provider = RepoProviderFactory.createProvider(repoRow.provider, providerConfig, {
      db,
      env,
      encryptionSecret,
    });

    if (await context.isCancelled(job.jobId)) {
      return;
    }

    // ---------- 4. 检测 ----------
    stage = "detecting";
    await report(0);

    const outcome = await detectRefs({ codeRepo, provider, repoRow, refs: round.refs });

    // 显式收敛成契约类型（见 DetectRefResult 的说明），下游回调参数才不会退化成 any
    const detectResults = outcome.results as DetectRefResult[];
    const updatedRefs = outcome.updatedRefs as DetectRefResult[];

    successCount = outcome.successCount;
    failedCount = outcome.errorCount;
    skippedCount = outcome.deferredCount;

    for (const item of detectResults) {
      const label = item.ref ? `${repoIdentifier}@${item.ref}` : repoIdentifier;
      if (item.detectStatus === DETECT_STATUS.OK) {
        itemResults.push({
          kind: "repo",
          label,
          status: "success",
          message: item.hasUpdate
            ? `发现新版本 ${item.version || item.shortCommitSha}`
            : `无更新（当前 ${item.version || item.shortCommitSha}）`,
          meta: {
            refType: item.refType,
            ref: item.ref,
            commitSha: item.commitSha,
            version: item.version,
            hasUpdate: item.hasUpdate,
          },
        });
      } else if (item.detectStatus === DETECT_STATUS.DEFERRED) {
        // 限流/暂时性：标成 skipped 而不是 failed —— 这不是失败，是「稍后再来」
        itemResults.push({
          kind: "repo",
          label,
          status: "skipped",
          message: `${describeErrorKind(item.errorKind || "")}，已安排 ${item.retryAt} 重检`,
          meta: { refType: item.refType, ref: item.ref, errorKind: item.errorKind, retryAt: item.retryAt },
        });
      } else {
        itemResults.push({
          kind: "repo",
          label,
          status: "failed",
          error: item.error || "检测失败",
          meta: { refType: item.refType, ref: item.ref, errorKind: item.errorKind },
        });
      }
    }

    await report(round.refs.length);

    // ---------- 5. 有更新 → 创建一次备份任务 ----------
    // 注意：一轮只创建**一个** repo_backup 任务，把本轮全部有更新的引用一起交给它。
    // 不按引用各建一个任务：备份任务内部本来就按引用循环，拆开只会让任务列表变噪音，
    // 也会让「同一仓库并发备份」重新出现（第 1 期特意用 running 守卫挡掉的东西）。
    //
    // force=true（手动强制备份）时把**全部检测成功**的引用都交出去，
    // 不只是有更新的那些 —— 用户按「强制备份」就是要重新下载一遍。
    const backupCandidates = force
      ? detectResults.filter((item) => item.detectStatus === DETECT_STATUS.OK && item.commitSha)
      : updatedRefs;

    if (createBackup && backupCandidates.length > 0) {
      stage = "dispatching";
      await report(round.refs.length);

      const refs: RepoBackupResolvedRef[] = backupCandidates.map((item) => ({
        refType: (item.refType === "tag" ? "tag" : "branch") as "branch" | "tag",
        ref: item.ref ?? null,
        commitSha: String(item.commitSha),
        version: item.version ?? null,
        publishedAt: item.publishedAt ?? null,
      }));

      const created = await fileSystem.createJob(
        "repo_backup",
        {
          repositoryId: repoRow.id,
          repoIdentifier,
          force,
          // 需求 4：把已解析出的版本交给备份任务，它不再请求 GitHub 版本 API
          refs,
        },
        job.userId || "system-repo-backup-check",
        job.userType || UserType.ADMIN,
        {
          // 手动强制备份的链路保留 manual 语义，便于在任务列表里区分来源
          triggerType: force ? "manual" : "scheduled",
          triggerRef: `repo_backup_check:${job.jobId}`,
        },
      );
      createdJobId = created?.jobId ?? null;
    }

    // ---------- 6. 收尾：把「需要早点再来」的时间交给调度层 ----------
    // 两种情况需要提前下一轮：
    //   a) 撞了限流/暂时性故障（第 2 期语义，用上游给的恢复时间）
    //   b) 本轮被 maxRefs 截断，还有引用没检测（用一个固定的短延迟）
    // 两者都走 deferRepositoryBackupSchedule —— 它只前移不后移，
    // 所以永远不会把用户配置的正常周期往后推。
    const remainingDue = Math.max(0, round.dueCount - round.refs.length);
    let deferAtMs: number | null = outcome.deferredUntilMs;
    if (remainingDue > 0) {
      const incompleteAt = Date.now() + INCOMPLETE_ROUND_RETRY_MS;
      deferAtMs = deferAtMs === null ? incompleteAt : Math.min(deferAtMs, incompleteAt);
    }

    if (deferAtMs !== null) {
      deferRetryAt = describeRetryAt(deferAtMs);
      await deferRepositoryBackupSchedule(db, repoRow.id, deferRetryAt);
    }

    // 仓库级字段降级为「聚合展示」：逐引用的真实状态在 repo_detect_states 里，
    // 这里只写一个最近检测时间给列表页用。last_error 仅在**全部**引用都永久失败时才写，
    // 避免「一个分支打错字」把整个仓库标红
    const allPermanentFailed = outcome.errorCount > 0 && outcome.errorCount === round.refs.length;
    await codeRepo.updateRepository(repoRow.id, {
      last_checked_at: new Date().toISOString(),
      last_error: allPermanentFailed ? detectResults.find((r) => r.error)?.error ?? null : null,
    });

    stage = "finished";
    await report(round.refs.length, {
      summary: buildSummary({
        repoLabel,
        detected: round.refs.length,
        updated: backupCandidates.length,
        deferred: outcome.deferredCount,
        errors: outcome.errorCount,
        remainingDue,
        createdJobId,
        createBackup,
        force,
      }),
    });

    console.log(
      `[RepoBackupCheckTaskHandler] ${repoIdentifier} 检测完成: ` +
        `到期 ${round.dueCount} / 本轮 ${round.refs.length}，` +
        `有更新 ${updatedRefs.length}，延迟 ${outcome.deferredCount}，永久失败 ${outcome.errorCount}` +
        (createdJobId ? `，已创建备份作业 ${createdJobId}` : "") +
        (deferRetryAt ? `，下一轮安排在 ${deferRetryAt}` : ""),
    );
  }
}

/** 拼一句给人看的结论（出现在任务列表的摘要列） */
function buildSummary(params: {
  repoLabel: string;
  detected: number;
  updated: number;
  deferred: number;
  errors: number;
  remainingDue: number;
  createdJobId: string | null;
  createBackup: boolean;
  force: boolean;
}): string {
  const parts: string[] = [`仓库「${params.repoLabel}」检测了 ${params.detected} 个引用`];

  if (params.updated > 0) {
    const what = params.force ? `${params.updated} 个引用（强制备份）` : `${params.updated} 个新版本`;
    parts.push(
      params.createdJobId
        ? `${what}，已创建备份作业`
        : `${what}${params.createBackup ? "（创建备份作业失败）" : "（本次不自动备份）"}`,
    );
  } else {
    parts.push("没有新版本，未创建备份作业");
  }

  if (params.deferred > 0) parts.push(`${params.deferred} 个引用因上游限流/抽风已安排重检`);
  if (params.errors > 0) parts.push(`${params.errors} 个引用检测失败`);
  if (params.remainingDue > 0) parts.push(`还有 ${params.remainingDue} 个引用排在下一轮`);

  return parts.join("；");
}
