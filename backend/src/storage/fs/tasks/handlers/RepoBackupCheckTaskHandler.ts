// cSpell:words repobackup
import type { TaskHandler, InternalJob, ExecutionContext } from "../TaskHandler.js";
import type { TaskStats, ItemResult, RepoBackupCheckTaskPayload, RepoBackupResolvedRef } from "../types.js";
import { ValidationError, NotFoundError } from "../../../../http/errors.js";
import { ensureRepositoryFactory } from "../../../../utils/repositories.js";
import { UserType } from "../../../../constants/index.js";
import { RepoProviderFactory } from "../../../../repobackup/providers/index.js";
import { parseProviderConfig, buildUnresolvedCommitSha } from "../../../../repobackup/config.js";
import { describeRetryAt, describeErrorKind } from "../../../../repobackup/errors.js";
import { deferRepositoryBackupSchedule } from "../../../../repobackup/schedule.js";
import {
  DETECT_MAX_REFS_PER_RUN,
  DETECT_STATUS,
  detectRefs,
  prepareDetectRound,
} from "../../../../repobackup/detect.js";
// 修改点（状态显示不一致修复）：统一结果词汇，任务条目与仓库管理页共用同一套
import { REPO_OUTCOME } from "../../../../repobackup/status.js";

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
  /**
   * 跟踪键（修改点：P0 水位键错位）
   *
   * 上面的 `ref` 是 provider 解析出来的具体版本（release 模式跟踪「最新」时是具体 Tag），
   * 只能用于展示；`trackingRef` 才是 repo_detect_states 的状态键。
   * 必须把它一路转进备份任务的 payload —— 以前这里没有这两个字段，
   * 组 payload 时跟踪键就被丢掉了，备份成功后水位落到错的状态行上。
   */
  trackingRef?: string | null;
  trackingRefType?: string;
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

/** 生成主键（修改点：备份历史缺记录 —— 补留痕需要写 code_repository_backups） */
function generateId(prefix: string): string {
  try {
    // eslint-disable-next-line no-undef
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      // eslint-disable-next-line no-undef
      return `${prefix}_${crypto.randomUUID()}`;
    }
  } catch {
    // ignore
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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
    // 修改点（状态显示不一致修复）：延迟重试单独计数。
    // 它仍然计入 skippedCount（两者都不是失败，进度条口径不变），
    // 但只有单独记一份，任务详情才能把「无需备份」和「已安排重试」区分开。
    let deferredCount = 0;
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
          deferredCount,
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
        // 修改点（状态显示不一致修复）：这是「被挡住/无需执行」，不是失败。
        // 区别在于「没到检测时间」属于正常节流，所以标成 blocked 而非 deferred。
        meta: { outcome: REPO_OUTCOME.BLOCKED },
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
    // 延迟重试也计进 skippedCount：两者都不是失败，进度条的分段口径与修复前一致
    skippedCount = outcome.deferredCount;
    deferredCount = outcome.deferredCount;

    for (const item of detectResults) {
      const label = item.ref ? `${repoIdentifier}@${item.ref}` : repoIdentifier;
      if (item.detectStatus === DETECT_STATUS.OK) {
        /**
         * 修改点（状态显示不一致修复 + 无更新反馈）：
         *
         * 检测成功有两种结论，都必须被明确表达出来：
         *   · 有更新 → UPDATE_AVAILABLE，随后会创建备份作业
         *   · 无更新 → UP_TO_DATE，**这是成功检测结果**，不是失败也不是空结果
         * 过去「无更新」只写了一句 message，接口层也没给出足够明确的措辞，
         * 用户点完「检查更新」后分不清「已是最新」和「检查没跑起来」。
         */
        // 命名成 itemOutcome 而不是 outcome：外层的 outcome 是 detectRefs 的整轮结果，
        // 循环里再叫 outcome 会遮住它，读代码的人容易以为下面用的还是这个
        const itemOutcome = item.hasUpdate ? REPO_OUTCOME.UPDATE_AVAILABLE : REPO_OUTCOME.UP_TO_DATE;
        itemResults.push({
          kind: "repo",
          label,
          status: "success",
          message: item.hasUpdate
            ? `发现新版本 ${item.version || item.shortCommitSha}`
            : `检查完成，当前已是最新版本（${item.version || item.shortCommitSha}）`,
          meta: {
            refType: item.refType,
            ref: item.ref,
            commitSha: item.commitSha,
            version: item.version,
            hasUpdate: item.hasUpdate,
            outcome: itemOutcome,
          },
        });
      } else if (item.detectStatus === DETECT_STATUS.DEFERRED) {
        // 限流/暂时性：标成 skipped 而不是 failed —— 这不是失败，是「稍后再来」。
        // 修改点（状态显示不一致修复）：用 meta.outcome 说明「延迟重试」，
        // 任务详情据此显示「已延迟重试」而不是笼统的「跳过」，
        // 与仓库管理页显示的延迟状态一致
        itemResults.push({
          kind: "repo",
          label,
          status: "skipped",
          message: `${describeErrorKind(item.errorKind || "")}，已安排 ${item.retryAt} 重检`,
          meta: {
            refType: item.refType,
            ref: item.ref,
            errorKind: item.errorKind,
            retryAt: item.retryAt,
            outcome: REPO_OUTCOME.DEFERRED,
          },
        });
      } else {
        itemResults.push({
          kind: "repo",
          label,
          status: "failed",
          error: item.error || "检测失败",
          meta: {
            refType: item.refType,
            ref: item.ref,
            errorKind: item.errorKind,
            outcome: REPO_OUTCOME.FAILED,
          },
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
        /**
         * 修改点（P0 水位键错位）：把跟踪键一起转下去。
         * 备份任务推进水位时只认这个字段；以前这里丢掉它，备份任务只能拿
         * 上面那个「具体 Tag」当状态键用，于是 release 模式跟踪「最新」的仓库
         * 水位永远落在一行新建的 ref='v9.9.9' 上，跟踪行 ref='' 永远是空的。
         */
        trackingRef: item.trackingRef !== undefined ? item.trackingRef : (item.ref ?? null),
        // 缺省时回落到 refType（而不是硬当 branch）：release 仓库的状态键类型是 tag
        trackingRefType: ((item.trackingRefType ?? item.refType) === "tag" ? "tag" : "branch") as "branch" | "tag",
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

    /**
     * 修改点（备份历史缺记录）：这一轮是「备份尝试」但没产生任何备份时，补一条留痕。
     *
     * 触发条件：createBackup === true（这一轮是备份链路：定时检测 / 手动「立即备份」，
     * 而不是只读的「检查更新」），且没有任何引用进入备份候选。此时分三种情形：
     *
     *   · 延迟 / 失败 —— 一律留痕。这是「本该备份却没备份成」，
     *     不记的话用户在任务列表看到一条「跳过」，点开历史却空空如也。
     *   · 已是最新且是**手动**触发 —— 也留痕。用户主动点了「立即备份」，
     *     必须能在历史里核对这次点击的结果（这正是用户反馈的
     *     「手动执行了很多次，历史里一直没有记录」）。
     *   · 已是最新且是定时触发 —— 不留痕。每几小时一条「没变化」会把历史淹掉。
     */
    const nothingBackedUp = createBackup && backupCandidates.length === 0;
    const hadTrouble = outcome.deferredCount > 0 || outcome.errorCount > 0;
    const manualUpToDate = payload.manual === true && !hadTrouble && outcome.successCount > 0;

    if (nothingBackedUp && (hadTrouble || manualUpToDate)) {
      const deferred = outcome.deferredCount > 0;
      /**
       * 「已是最新」留痕要带上版本号。
       *
       * commit_sha 仍然必须用占位值：(repository_id, commit_sha) 上有唯一索引，
       * 而这个 commit 早就有一条成功记录占着位子了（它正是「已是最新」的含义），
       * 写真实 sha 会直接撞唯一约束。版本信息改放 version / ref 两个字段，
       * 于是历史里显示的是「main · <版本>」而不是「未解析到版本」。
       */
      const sample = manualUpToDate ? detectResults.find((r) => r.detectStatus === DETECT_STATUS.OK) : null;

      let summary: string;
      if (manualUpToDate) {
        summary = `手动触发：检查完成，当前已是最新版本（${
          sample?.version || sample?.shortCommitSha || "已备份版本"
        }），无需备份`;
      } else {
        const reason =
          detectResults.find((r) => r.error)?.error ||
          `${describeErrorKind(outcome.deferredKind || "")}，上游暂时不可用`;
        summary = deferred
          ? `本次未能完成，${outcome.deferredCount} 个引用因${describeErrorKind(outcome.deferredKind || "")}已安排 ${
              deferRetryAt || "稍后"
            } 自动重试：${reason}`
          : `${outcome.errorCount} 个引用检测失败，未能备份：${reason}`;
      }

      try {
        await codeRepo.createBackup({
          id: generateId("bk"),
          repository_id: repoRow.id,
          ref_type: String(repoRow.track_mode || "branch") === "branch" ? "branch" : "tag",
          ref: sample?.ref ?? null,
          // 占位 commit_sha：见上面的唯一索引说明；DTO 读取时会还原为 null
          commit_sha: buildUnresolvedCommitSha(),
          version: sample?.version ?? null,
          // 已是最新 → skipped（映射为「已是最新」，非失败）
          // 延迟 → deferred（非失败）；其余才是 failed
          status: manualUpToDate ? "skipped" : deferred ? "deferred" : "failed",
          job_id: job.jobId,
          error_message: summary,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
        });
      } catch (error: any) {
        // 留痕写不进去不该让检测任务失败：检测本身已经完成、状态也已落库
        console.warn("[RepoBackupCheckTaskHandler] 写入未完成留痕出错:", error?.message || error);
      }
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
  } else if (params.detected > 0 && params.errors === params.detected) {
    // 全部引用都检测失败：不能再说「没有新版本」，那会把失败伪装成成功
    parts.push("检测未成功，无法判断是否有新版本");
  } else if (params.deferred > 0 && params.deferred + params.errors >= params.detected) {
    // 本轮一个引用都没查成功（全是限流或失败）：同样不能说「已是最新」——
    // 我们根本不知道是不是最新。这类情况属于「已安排重检」，不是成功结论。
    parts.push("本轮没有拿到有效检测结果，已安排重检");
  } else {
    /**
     * 修改点（状态显示不一致修复 + 无更新反馈）：
     * 明确表达「检查完成且已是最新」，这是一个成功结果。
     * 原来的「没有新版本，未创建备份作业」既没说「完成」，也没说「已是最新」，
     * 用户点完按钮后分不清是「确实没问题」还是「检查根本没跑」。
     */
    parts.push("检查完成，当前已是最新版本，无需备份");
  }

  if (params.deferred > 0) parts.push(`${params.deferred} 个引用因上游限流/抽风已安排重检`);
  if (params.errors > 0) parts.push(`${params.errors} 个引用检测失败`);
  if (params.remainingDue > 0) parts.push(`还有 ${params.remainingDue} 个引用排在下一轮`);

  return parts.join("；");
}
