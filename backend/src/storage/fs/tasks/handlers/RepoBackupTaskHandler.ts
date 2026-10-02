// cSpell:words tarball repobackup
import type { TaskHandler, InternalJob, ExecutionContext } from "../TaskHandler.js";
import type { TaskStats, ItemResult } from "../types.js";
import { ValidationError, NotFoundError } from "../../../../http/errors.js";
import { ensureRepositoryFactory } from "../../../../utils/repositories.js";
import { UserType } from "../../../../constants/index.js";
import { RepoProviderFactory } from "../../../../repobackup/providers/index.js";
import {
  parseProviderConfig,
  resolveTrackRefs,
  resolveTargetMountIds,
  buildUnresolvedCommitSha,
} from "../../../../repobackup/config.js";
import { planBackupPaths } from "../../../../repobackup/paths.js";
import { pruneOldVersions, describePruneResult } from "../../../../repobackup/retention.js";
// 修改点（第 2 期 错误分类 + 延迟重试）：
// 限流/暂时性故障不记失败，而是算出「最早可重试时间」交给调度层
import { planRetryForError, describeRetryAt, describeErrorKind } from "../../../../repobackup/errors.js";
import { deferRepositoryBackupSchedule } from "../../../../repobackup/schedule.js";

/**
 * 代码仓库备份任务（修改点：新增功能）
 *
 * 流程：
 *   解析最新版本 → 按 commitSha 去重 → 创建/复用备份记录 → 流式下载源码归档
 *   → 流式上传到目标挂载点 → 写 manifest → 回写记录与仓库状态
 *
 * 关键设计：
 * - 归档全程流式（provider 给 ReadableStream，直接交给 fileSystem.uploadFile），
 *   不整包读进内存，因此 Workers 128MB 限制下也能处理大仓库
 * - 字节数用 TransformStream 边传边计（Workers/Node 均原生支持），
 *   避免为了拿大小而缓冲整包
 *
 * 优化点（多分支 / 多备份目标 / 版本保留）：
 * - 一个作业处理该仓库的全部跟踪引用（分支模式即多个分支），逐个解析、去重、备份
 * - 每个版本会写入全部选中的目标挂载点；单个目标失败不影响其他目标，
 *   下次运行只补写缺失的目标（不会因为"某个目标成功过"就整版跳过）
 * - 备份成功后按 retention_count 清理最旧版本
 *
 * 取舍说明（多目标的下载开销）：
 *   向 N 个目标写入时按目标逐个「重新拉取一次源码归档」，而不是把同一个流分叉给
 *   N 个消费者。原因：Web Streams 的 tee() 内部缓冲无上限，大仓库在 Workers 上会
 *   撑爆内存；自建带背压的分叉流虽然可行，但一旦某个消费者中途失败，处理其挂起态
 *   的复杂度很高，容易把"单目标失败"放大成"整次备份失败"。逐个拉取的代价是
 *   多目标时 GitHub 侧流量放大 N 倍，换来的是内存可控、目标间故障完全隔离，
 *   以及重跑时只补写缺失目标（已成功的目标不会重复拉取）。
 *
 * 修改点（第 2 期：限流错误分类 + 延迟重试）：
 * - 上游错误先分类（repobackup/errors.js）：限流 / 暂时性 / 永久性
 * - 限流与暂时性错误**不算失败**：不写失败历史、不累计失败数、不抛异常
 *   （抛异常会让 Workflows 步骤与 Node 任务被判失败，还会触发无意义的重试）
 * - 只记下「最早可重试时间」，收尾时把它写进该仓库既有 scheduled_jobs 行的
 *   next_run_after，由调度层到点自动重跑
 * - 永久性错误（仓库/分支不存在等）行为不变，照旧记 failed
 *
 * 修改点（第 3 期：所有 GitHub API 请求统一经过请求调度器）：
 * - provider 由 createProvider 带上 db/env 创建，于是备份过程中的每一次 API 请求
 *   都先过 GithubRequestScheduler：全局并发 <= 2、间隔 >= 800ms、
 *   请求前查共享额度账本（额度不足则不发请求）、同一 URL 的并发查询合并成一次
 * - 调度器抛出的 RateLimitedError 由上面的第 2 期逻辑接住：依旧不记失败、不累计失败数、
 *   只把「最早可重试时间」交给调度层
 * - 源码归档走 codeload.github.com，不消耗 API 额度，因此不经过调度器（第 1 期成果不变）
 */

type RepoBackupPayload = {
  repositoryId: string;
  /** owner/repo，仅用于任务列表显示，执行时仍以 repositoryId 为准 */
  repoIdentifier?: string;
  force?: boolean;
};

/** 单个跟踪引用（分支）的备份结果 */
type RefOutcome = {
  ref: string | null;
  status: "success" | "partial" | "failed" | "skipped";
  error?: string;
  sizeBytes?: number | null;
  primaryPath?: string | null;
};

/**
 * 执行阶段（修改点：任务卡住排查 / 详情完善）
 *
 * 之所以要上报阶段：原实现只写 processedItems/successCount 这类计数，
 * 一个引用从开始到结束中间可能有十几分钟（解析 → 下载上传 → 写 manifest → 清理），
 * 这期间前端看到的统计完全不动，无法区分「正在传大仓库」和「真的卡死了」。
 */
type BackupStage = "preparing" | "resolving" | "transferring" | "manifest" | "pruning" | "finished";

/**
 * 传输停滞超时（修改点：任务卡住排查）
 *
 * GitHub/加速代理的连接可能在中途停止吐数据而不断开，此时下载与上传都会无限期等待，
 * 任务永远停在 running。这里在字节流上挂一个看门狗：超过该时长没有新分片就 abort 掉
 * 整个响应，让这个目标以明确的错误失败（下次运行会自动补写）。
 */
const STALL_TIMEOUT_MS = 120 * 1000;

/** 实时字节进度的上报节流：至少间隔 1.5s，或累计新增 8MB */
const PROGRESS_FLUSH_INTERVAL_MS = 1500;
const PROGRESS_FLUSH_BYTES = 8 * 1024 * 1024;

/** 单次任务只处理一个仓库，统计模板按引用数量展开 */
function buildStats(totalItems: number, overrides: Partial<TaskStats> = {}): TaskStats {
  return {
    totalItems,
    processedItems: 0,
    successCount: 0,
    failedCount: 0,
    skippedCount: 0,
    itemResults: [],
    ...overrides,
  } as TaskStats;
}

function nowIso(): string {
  return new Date().toISOString();
}

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

/**
 * 归档传输的护栏（修改点：任务卡住排查）
 *
 * 一次性解决三件事：
 * - 字节计数：counter.value 在流被消费的过程中持续累加
 * - 停滞检测：每收到一个分片就重置计时器，超时则 abort 整个响应
 * - 实时进度：按节流回调 onProgress，让前端能看到字节在涨（不涨就是真卡住了）
 *
 * controller.signal 必须在发起请求前就交给 provider，所以本函数先于 openSourceArchive 调用，
 * 拿到响应后再用 wrap() 套住 body。
 */
function createTransferGuard({
  stallTimeoutMs = STALL_TIMEOUT_MS,
  onProgress,
}: {
  stallTimeoutMs?: number;
  onProgress?: (bytes: number) => void;
} = {}) {
  const controller = new AbortController();
  const counter = { value: 0 };

  let timer: any = null;
  let stalled = false;
  let disposed = false;
  let lastFlushMs = Date.now();
  let lastFlushBytes = 0;

  /** 重新武装停滞计时器 */
  const arm = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      console.error(`[RepoBackupTaskHandler] 传输停滞超过 ${Math.round(stallTimeoutMs / 1000)}s，中止本次下载`);
      try {
        controller.abort();
      } catch {
        // ignore
      }
    }, stallTimeoutMs);
  };

  const dispose = () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const flushProgress = (force = false) => {
    if (!onProgress) return;
    const nowMs = Date.now();
    const grown = counter.value - lastFlushBytes;
    if (!force && nowMs - lastFlushMs < PROGRESS_FLUSH_INTERVAL_MS && grown < PROGRESS_FLUSH_BYTES) {
      return;
    }
    lastFlushMs = nowMs;
    lastFlushBytes = counter.value;
    try {
      onProgress(counter.value);
    } catch {
      // 进度上报失败绝不能影响传输
    }
  };

  /** 套在归档 body 外层：边转发边计数、重置看门狗、上报进度 */
  const wrap = (stream: ReadableStream): ReadableStream => {
    // TransformStream 在 Cloudflare Workers 与 Node 18+ 均为全局可用
    const transform = new TransformStream({
      transform(chunk: any, ctrl: any) {
        arm();
        try {
          const size = chunk?.byteLength ?? chunk?.length ?? 0;
          if (Number.isFinite(size)) counter.value += size;
        } catch {
          // 计数失败不应中断传输
        }
        flushProgress();
        ctrl.enqueue(chunk);
      },
      flush() {
        dispose();
      },
    });
    return stream.pipeThrough(transform);
  };

  return {
    signal: controller.signal,
    counter,
    arm,
    dispose,
    wrap,
    isStalled: () => stalled,
  };
}

export class RepoBackupTaskHandler implements TaskHandler {
  readonly taskType = "repo_backup";

  async validate(payload: any): Promise<void> {
    if (payload === null || typeof payload !== "object") {
      throw new ValidationError("payload 必须是对象");
    }
    if (!payload.repositoryId || typeof payload.repositoryId !== "string") {
      throw new ValidationError("repositoryId 必须是非空字符串");
    }
    if (payload.force !== undefined && typeof payload.force !== "boolean") {
      throw new ValidationError("force 必须是布尔值");
    }
  }

  createStatsTemplate(_payload: any): TaskStats {
    return buildStats(1);
  }

  async execute(job: InternalJob, context: ExecutionContext): Promise<void> {
    const payload = (job.payload || {}) as RepoBackupPayload;
    const force = payload.force === true;

    const fileSystem = context.getFileSystem();
    const env = typeof context.getEnv === "function" ? context.getEnv() : null;
    const db = env?.DB ?? fileSystem?.mountManager?.db;
    if (!db) {
      throw new ValidationError("repo_backup: 缺少 DB 绑定");
    }

    const encryptionSecret = env?.ENCRYPTION_SECRET ?? fileSystem?.mountManager?.encryptionSecret;
    if (!encryptionSecret) {
      throw new ValidationError("repo_backup: 缺少 ENCRYPTION_SECRET");
    }

    const factory = ensureRepositoryFactory(db, fileSystem?.repositoryFactory, env || {});
    const codeRepo = factory.getCodeRepositoryRepository();
    const mountRepository = factory.getMountRepository();

    const startedMs = Date.now();

    // ---------- 1. 读取仓库配置 ----------
    const repoRow = await codeRepo.findRepositoryById(payload.repositoryId);
    if (!repoRow) {
      throw new NotFoundError(`代码仓库不存在: ${payload.repositoryId}`);
    }

    const provider = String(repoRow.provider || "");
    const repoIdentifier = String(repoRow.repo_identifier || "");
    const trackMode = String(repoRow.track_mode || "branch") as "branch" | "release";

    // 修改点（多分支优化）：一个作业处理该仓库的全部跟踪引用
    const trackRefs = resolveTrackRefs(repoRow);
    if (trackRefs.length === 0) {
      throw new ValidationError(`仓库未配置任何跟踪引用: ${repoIdentifier}`);
    }

    // 修改点（多备份目标优化）：一次备份写入全部选中的目标
    const targetMountIds = resolveTargetMountIds(repoRow);
    if (targetMountIds.length === 0) {
      throw new ValidationError(`仓库未配置备份目标: ${repoIdentifier}`);
    }

    const mounts: any[] = [];
    for (const mountId of targetMountIds) {
      const mount = await mountRepository.findById(mountId);
      if (!mount) {
        throw new NotFoundError(`备份目标挂载点不存在: ${mountId}`);
      }
      if (mount.is_active === 0) {
        throw new ValidationError(`备份目标挂载点已禁用: ${mount.name || mount.mount_path}`);
      }
      mounts.push(mount);
    }

    const totalItems = trackRefs.length;
    const itemResults: ItemResult[] = [];
    const outcomes: RefOutcome[] = [];

    let totalBytes = 0;
    let bytesTransferred = 0;

    /**
     * 本轮出现过的「可延迟重试」错误（修改点：第 2 期 限流 = 延迟，不是失败）
     *
     * 只保留最早的那个重试时间：一处限流就说明额度已经打满，整轮都该按
     * 最早的时间重来，而不是每个分支各排一个时间。
     *
     * 注意：必须声明在 report() 之前 —— report 会在循环开始前就被调用一次，
     * 而它引用了这几个变量。
     */
    let deferredRetryAtMs: number | null = null;
    let deferredKind: string | null = null;
    let deferredMessage: string | null = null;

    /**
     * 记录一次错误；若属于可延迟重试类别则返回延迟计划，否则返回 null
     * （永久性错误仍然走原来的「记失败」路径）
     */
    const noteDeferral = (error: unknown) => {
      const plan = planRetryForError(error);
      if (!plan.deferrable || plan.retryAtMs === null) return null;
      if (deferredRetryAtMs === null || plan.retryAtMs < deferredRetryAtMs) {
        deferredRetryAtMs = plan.retryAtMs;
        deferredKind = plan.kind;
        deferredMessage = plan.message;
      }
      return plan;
    };

    // 修改点（任务卡住排查 / 详情完善）：当前执行阶段与目标，让「任务管理」能看出卡在哪一步
    let currentStage: BackupStage = "preparing";
    let currentRef: string | null = null;
    let currentTarget: { name: string | null; mountPath: string | null } = { name: null, mountPath: null };

    const report = async (processedItems: number, extra: Partial<TaskStats> = {}) => {
      await context.updateProgress(
        job.jobId,
        buildStats(totalItems, {
          processedItems,
          successCount: outcomes.filter((o) => o.status === "success").length,
          failedCount: outcomes.filter((o) => o.status === "failed").length,
          skippedCount: outcomes.filter((o) => o.status === "skipped").length,
          itemResults,
          totalBytes,
          bytesTransferred,
          // 阶段类字段（前端任务详情直接展示）
          stage: currentStage,
          currentRef,
          currentTargetName: currentTarget.name,
          currentTargetPath: currentTarget.mountPath,
          repositoryId: repoRow.id,
          repoIdentifier,
          // 修改点（第 2 期 延迟重试）：本轮被推迟时的重试时间。
          // 前端不渲染该字段，放在 stats 里是为了任务详情能直接看出「为什么没备份」。
          deferRetryAt: deferredRetryAtMs ? describeRetryAt(deferredRetryAtMs) : null,
          targetCount: mounts.length,
          targetMounts: mounts.map((m) => ({
            id: m.id,
            name: m.name ?? null,
            mountPath: m.mount_path ?? null,
          })),
          ...extra,
        }),
      );
    };

    await report(0);

    // ---------- 2. 解析 Provider（失败即整体失败） ----------
    const providerConfig = await parseProviderConfig(provider, repoRow.config_json, encryptionSecret);
    // 修改点（第 3 期 请求调度）：把 db/env 交给 provider，让备份过程的全部
    // GitHub API 请求统一经过请求调度器（全局并发 <=2、间隔 >=800ms、
    // 请求前查共享额度账本、同名请求合并）。额度不足时会抛出 RateLimitedError，
    // 由下面的第 2 期延迟重试逻辑接住 —— 不记失败，改为安排到点重跑。
    const providerInstance = RepoProviderFactory.createProvider(provider, providerConfig, { db, env });

    currentStage = "resolving";
    await report(0);

    let processed = 0;
    let firstError: Error | null = null;

    // ---------- 3. 逐个引用（分支）备份 ----------
    for (const trackRef of trackRefs) {
      currentRef = trackRef ?? null;
      const itemResult: ItemResult = {
        kind: "repo",
        label: trackRef ? `${repoIdentifier}@${trackRef}` : repoIdentifier,
        status: "processing",
        meta: { refType: trackMode === "branch" ? "branch" : "tag", ref: trackRef },
      };
      itemResults.push(itemResult);

      const refStartedMs = Date.now();
      let backupId: string | null = null;
      /** 本引用内出现的可延迟重试错误（修改点：第 2 期），决定这个引用记「失败」还是「已安排重试」 */
      let refDeferral: ReturnType<typeof noteDeferral> = null;

      try {
        if (await context.isCancelled(job.jobId)) {
          throw new Error("cancelled");
        }

        // 3.1 解析该引用的最新版本
        currentStage = "resolving";
        await report(processed);

        const version = await providerInstance.resolveLatestVersion({
          repoIdentifier,
          trackMode,
          trackRef: trackRef ?? null,
          // 修改点（第 1 期请求数量优化）：把本轮要解析的引用总数告诉 provider，
          // 多分支时它会改用 1 次 /branches 批量请求代替 N 次单分支请求
          refCount: trackRefs.length,
        });

        // 修改点（详情完善）：targets 记录每个目标的写入结果，供任务详情逐条展示
        const targetSummaries: Array<{
          mountId: string;
          name: string | null;
          mountPath: string | null;
          status: "pending" | "processing" | "success" | "failed" | "skipped";
          sizeBytes?: number | null;
          error?: string | null;
        }> = mounts.map((m) => ({
          mountId: String(m.id),
          name: m.name ?? null,
          mountPath: m.mount_path ?? null,
          status: "pending",
        }));
        const summaryOf = (mountId: any) => targetSummaries.find((t) => t.mountId === String(mountId));

        itemResult.meta = {
          refType: version.refType,
          ref: version.ref,
          commitSha: version.commitSha,
          version: version.version,
          targets: targetSummaries,
        };

        // 3.2 去重：仅当「所有目标都已有该 commit 的成功副本」且非强制时才跳过
        //     修改点（多备份目标优化）：任一目标缺副本都要重跑，保证自愈
        const existing = await codeRepo.findBackupByCommit(repoRow.id, version.commitSha);
        let missingMounts = mounts;

        if (existing) {
          if (force) {
            missingMounts = mounts;
          } else {
            const existingTargets = await codeRepo.findTargetsByBackup(existing.id);
            const doneMountIds = new Set(
              existingTargets.filter((t: any) => t.status === "success").map((t: any) => String(t.mount_id)),
            );
            missingMounts = mounts.filter((m) => !doneMountIds.has(String(m.id)));

            // 已有副本的目标在详情里标为「跳过」，与本次要补写的目标区分开
            for (const mountId of doneMountIds) {
              const summary = summaryOf(mountId);
              if (summary) summary.status = "skipped";
            }

            if (missingMounts.length === 0) {
              itemResult.status = "skipped";
              itemResult.message = `已存在该版本的备份（${version.version}），跳过`;
              itemResult.durationMs = Date.now() - refStartedMs;
              outcomes.push({ ref: version.ref ?? trackRef ?? null, status: "skipped" });
              processed += 1;
              await report(processed);
              console.log(`[RepoBackupTaskHandler] 跳过重复备份: ${repoIdentifier} @ ${version.commitSha}`);
              continue;
            }
          }
        }

        if (missingMounts.length < mounts.length) {
          console.log(
            `[RepoBackupTaskHandler] 上次备份有 ${mounts.length - missingMounts.length} 个目标已完成，本次只补写剩余目标`,
          );
        }

        // 3.3 创建/复用备份记录
        // 注意：(repository_id, commit_sha) 上有唯一索引，force 重跑时必须复用原记录而非新插入
        const startedAt = nowIso();
        if (existing) {
          backupId = existing.id;
          await codeRepo.updateBackup(backupId, {
            status: "running",
            ref_type: version.refType,
            ref: version.ref,
            version: version.version,
            job_id: job.jobId,
            error_message: null,
            started_at: startedAt,
            finished_at: null,
          });
        } else {
          backupId = generateId("bk");
          await codeRepo.createBackup({
            id: backupId,
            repository_id: repoRow.id,
            ref_type: version.refType,
            ref: version.ref,
            commit_sha: version.commitSha,
            version: version.version,
            status: "running",
            job_id: job.jobId,
            started_at: startedAt,
          });
        }

        // 3.4 逐个目标写入
        const targetErrors: string[] = [];
        let primaryStoragePath: string | null = null;
        let primaryManifestPath: string | null = null;
        let primarySizeBytes: number | null = null;
        let successTargets = 0;

        for (const mount of missingMounts) {
          if (await context.isCancelled(job.jobId)) {
            throw new Error("cancelled");
          }

          const paths = planBackupPaths({
            mountPath: mount.mount_path,
            pathPrefix: repoRow.target_path_prefix,
            provider,
            repoIdentifier,
            commitSha: version.commitSha,
            ref: version.ref,
          });

          currentTarget = { name: mount.name ?? null, mountPath: mount.mount_path ?? null };
          const targetSummary = summaryOf(mount.id);
          if (targetSummary) targetSummary.status = "processing";

          // 修改点（任务卡住排查）：传输护栏必须在发起请求前创建，
          // 它的 signal 要交给 provider，才能在停滞时把整个响应中止掉
          const guard = createTransferGuard({
            onProgress: (bytes) => {
              // 只补 bytesTransferred 这一个字段，避免与 report() 的完整快照互相覆盖；
              // 失败不影响传输（updateProgress 在 Workers 下是异步 D1 写）
              Promise.resolve(
                context.updateProgress(job.jobId, { bytesTransferred: bytesTransferred + bytes }),
              ).catch(() => {});
            },
          });

          try {
            // createDirectory 对已存在目录是幂等的（返回 alreadyExists）
            try {
              await fileSystem.createDirectory(paths.repoDirPath, job.userId, job.userType);
            } catch (dirError: any) {
              // 部分对象存储没有真实目录概念，创建失败不影响后续写入
              console.warn(
                `[RepoBackupTaskHandler] 创建目录失败（继续尝试上传）: ${paths.repoDirPath}`,
                dirError?.message || dirError,
              );
            }

            console.log(
              `[RepoBackupTaskHandler] 开始备份 ${repoIdentifier}@${version.ref || ""} ${version.version} -> ${paths.archivePath}`,
            );

            currentStage = "transferring";
            await report(processed);

            const archive = await providerInstance.openSourceArchive({
              repoIdentifier,
              refType: version.refType,
              ref: version.ref,
              commitSha: version.commitSha,
              signal: guard.signal,
            });

            // 拿到响应之后才启动停滞看门狗：
            // 「等响应头」那一段由 provider 自己的超时 + 重试负责，两者职责不重叠，
            // 报错信息也才对得上（超时 vs 传输停滞）
            guard.arm();
            const countedStream = guard.wrap(archive.stream);
            const counter = guard.counter;

            let uploadResult: any;
            try {
              uploadResult = await fileSystem.uploadFile(
                paths.archivePath,
                countedStream,
                job.userId,
                job.userType,
                {
                  filename: paths.archiveFileName,
                  contentType: archive.contentType || "application/gzip",
                  // GitHub tarball 通常是 chunked 无 content-length，此时传 0 表示未知，
                  // 上游的配额守卫会跳过 best-effort 判断，S3 走 lib-storage 自动分片
                  contentLength: archive.contentLength || 0,
                },
              );
            } catch (uploadError: any) {
              // 看门狗触发时底层报的是 abort/stream 错误，换成人看得懂的原因
              if (guard.isStalled()) {
                throw new Error(
                  `传输停滞超过 ${Math.round(STALL_TIMEOUT_MS / 1000)} 秒（已传 ${counter.value} 字节）已中止，` +
                    `可能是 GitHub 或加速代理无响应`,
                );
              }
              throw uploadError;
            } finally {
              guard.dispose();
            }

            const sizeBytes = counter.value > 0 ? counter.value : null;
            totalBytes += sizeBytes ?? 0;
            bytesTransferred += counter.value;

            // manifest 是归档旁的便利副本，元信息在数据库记录中已完整保存。
            // 这里不因它失败而判定该目标失败，但必须把问题暴露给管理员。
            let manifestPath: string | null = null;
            let manifestWarning: string | null = null;
            try {
              currentStage = "manifest";
              const manifest = this.buildManifest({
                provider,
                repoIdentifier,
                repoRow,
                version,
                backupId,
                jobId: job.jobId,
                archive: {
                  path: uploadResult?.storagePath || paths.archivePath,
                  fileName: paths.archiveFileName,
                  contentType: archive.contentType || "application/gzip",
                  sizeBytes,
                },
                mount,
              });
              const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
              await fileSystem.uploadFile(paths.manifestPath, manifestBytes, job.userId, job.userType, {
                filename: paths.manifestFileName,
                contentType: "application/json",
                contentLength: manifestBytes.byteLength,
              });
              manifestPath = paths.manifestPath;
            } catch (manifestError: any) {
              manifestWarning = `manifest 写入失败: ${manifestError?.message || String(manifestError)}`;
              console.warn(`[RepoBackupTaskHandler] ${manifestWarning}`);
            }

            const storagePath = uploadResult?.storagePath || paths.archivePath;

            // 修改点（多备份目标优化）：每个目标单独记录结果
            await codeRepo.upsertBackupTarget({
              id: generateId("bkt"),
              backup_id: backupId,
              mount_id: mount.id,
              mount_path: mount.mount_path,
              storage_path: storagePath,
              manifest_path: manifestPath,
              size_bytes: sizeBytes,
              status: "success",
              error_message: manifestWarning,
            });

            successTargets += 1;
            if (targetSummary) {
              targetSummary.status = "success";
              targetSummary.sizeBytes = sizeBytes;
              targetSummary.error = manifestWarning;
            }
            if (!primaryStoragePath) {
              primaryStoragePath = storagePath;
              primaryManifestPath = manifestPath;
              primarySizeBytes = sizeBytes;
            }
            if (manifestWarning) targetErrors.push(`${mount.name || mount.mount_path}: ${manifestWarning}`);

            console.log(`[RepoBackupTaskHandler] 目标写入完成: ${storagePath}`);
            await report(processed);
          } catch (targetError: any) {
            guard.dispose();
            // 单个目标失败不影响其他目标；下次运行会自动补写
            const message = String(targetError?.message || targetError || "未知错误");

            // 修改点（第 2 期 错误分类）：先判断这个目标的失败是不是「限流 / 暂时性」。
            // 是的话本轮不能以失败收尾——目标行记 skipped（而不是 failed），
            // 并记下重试时间，由本轮收尾统一把延迟交给调度层。
            const targetDeferral = noteDeferral(targetError);
            if (targetDeferral && !refDeferral) refDeferral = targetDeferral;

            targetErrors.push(
              targetDeferral
                ? `${mount.name || mount.mount_path}: 已延迟重试（${describeErrorKind(targetDeferral.kind)}）${message}`
                : `${mount.name || mount.mount_path}: ${message}`,
            );

            if (targetSummary) {
              targetSummary.status = targetDeferral ? "skipped" : "failed";
              targetSummary.error = targetDeferral ? `已安排自动重试：${message}` : message;
            }

            await codeRepo
              .upsertBackupTarget({
                id: generateId("bkt"),
                backup_id: backupId,
                mount_id: mount.id,
                mount_path: mount.mount_path,
                status: targetDeferral ? "skipped" : "failed",
                error_message: message,
              })
              .catch((e: any) =>
                console.warn("[RepoBackupTaskHandler] 记录目标失败状态出错:", e?.message || e),
              );

            console.error(
              `[RepoBackupTaskHandler] 目标写入${targetDeferral ? "被推迟" : "失败"} (${mount.name || mount.mount_path}):`,
              message,
            );
            await report(processed);
          }
        }

        currentTarget = { name: null, mountPath: null };
        const finishedAt = nowIso();

        // 修改点（多备份目标优化）：按「该备份的全部目标行」重算状态，
        // 而不是只看本次写入结果 —— 这样"上次部分失败、本次补写成功"能正确收敛为 success
        const allTargets = await codeRepo.findTargetsByBackup(backupId);
        const okMountIds = new Set(
          allTargets.filter((t: any) => t.status === "success").map((t: any) => String(t.mount_id)),
        );
        const doneCount = mounts.filter((m) => okMountIds.has(String(m.id))).length;
        const anyDone = doneCount > 0;
        const allDone = doneCount === mounts.length;

        const backupWarning = targetErrors.length > 0 ? targetErrors.join("；") : null;

        if (!anyDone) {
          // 所有目标都没有副本
          const message = backupWarning || "所有备份目标均写入失败";

          // 修改点（第 2 期 延迟重试）：写入阶段撞上限流/暂时性故障时不算失败。
          // 记录必须离开 running（否则会挡住下一次定时备份），但绝不能写 failed，
          // 于是记 skipped，并在 error_message 里带上自动重试时间。
          await codeRepo.updateBackup(backupId, {
            status: refDeferral ? "skipped" : "failed",
            error_message: refDeferral
              ? `本次未能完成，已安排在 ${describeRetryAt(refDeferral.retryAtMs as number)} 自动重试：${message}`
              : message,
            finished_at: finishedAt,
          });

          itemResult.status = refDeferral ? "skipped" : "failed";
          if (refDeferral) {
            itemResult.message = `已延迟重试（${describeErrorKind(refDeferral.kind)}，重试时间 ${describeRetryAt(refDeferral.retryAtMs as number)}）：${message}`;
          } else {
            itemResult.error = message;
          }
          itemResult.durationMs = Date.now() - refStartedMs;
          outcomes.push({
            ref: version.ref ?? trackRef ?? null,
            status: refDeferral ? "skipped" : "failed",
            error: refDeferral ? undefined : message,
          });
          if (!refDeferral && !firstError) firstError = new Error(message);
          processed += 1;
          await report(processed);
          continue;
        }

        // 主路径：优先用本次写入的；补写场景下回退到此前已成功的目标
        if (!primaryStoragePath) {
          const primaryRow = allTargets.find((t: any) => t.status === "success" && t.storage_path);
          if (primaryRow) {
            primaryStoragePath = primaryRow.storage_path;
            primaryManifestPath = primaryRow.manifest_path ?? null;
            primarySizeBytes = primaryRow.size_bytes ?? null;
          }
        }

        // 修改点（多备份目标优化）：全部目标有副本 -> success；部分 -> partial
        const status: "success" | "partial" = allDone ? "success" : "partial";

        // 修改点（版本保留优化）：备份成功后清理超出保留数量的最旧版本
        let pruneMessage = "";
        try {
          currentStage = "pruning";
          await report(processed);
          const pruneSummary = await pruneOldVersions({
            codeRepo,
            fileSystem,
            repositoryRow: repoRow,
            userId: job.userId,
            userType: job.userType,
          });
          pruneMessage = describePruneResult(pruneSummary);
          if (pruneSummary.removedCount > 0) {
            console.log(`[RepoBackupTaskHandler] ${pruneMessage}`);
          }
          for (const err of pruneSummary.errors) {
            console.warn(`[RepoBackupTaskHandler] 版本清理提示: ${err}`);
          }
        } catch (pruneError: any) {
          // 清理失败不影响本次备份结论
          console.warn("[RepoBackupTaskHandler] 版本清理失败:", pruneError?.message || pruneError);
        }

        const backupNote = [backupWarning, pruneMessage].filter(Boolean).join("；") || null;

        await codeRepo.updateBackup(backupId, {
          status,
          storage_path: primaryStoragePath,
          manifest_path: primaryManifestPath,
          size_bytes: primarySizeBytes,
          error_message: backupNote,
          finished_at: finishedAt,
        });

        await codeRepo.updateRepository(repoRow.id, {
          last_backup_at: finishedAt,
          last_known_commit_sha: version.commitSha,
          last_error: backupWarning,
        });

        // 部分目标成功时：备份记录记为 partial（历史里能看出哪些目标缺副本），
        // 但任务条目仍记为 failed —— 用户要求"写入全部目标"，没写全就不算成功
        itemResult.status = allDone ? "success" : "failed";
        itemResult.targetPath = primaryStoragePath || undefined;
        itemResult.fileSize = primarySizeBytes ?? undefined;
        itemResult.durationMs = Date.now() - refStartedMs;
        if (backupNote) itemResult.message = backupNote;
        if (!allDone) itemResult.error = backupWarning || "部分目标写入失败";

        outcomes.push({
          ref: version.ref ?? trackRef ?? null,
          status,
          error: backupWarning || undefined,
          sizeBytes: primarySizeBytes,
          primaryPath: primaryStoragePath,
        });

        console.log(
          `[RepoBackupTaskHandler] 备份完成: ${repoIdentifier}@${version.ref || ""} ${version.version}` +
            `（本次写入 ${successTargets}/${missingMounts.length}，目标副本 ${doneCount}/${mounts.length}）`,
        );
      } catch (error: any) {
        // 修改点（第 2 期 错误分类）：先排除「任务被取消」。
        // 传输停滞看门狗触发的 abort 现在被归类为「暂时性错误」，如果任务其实已经
        // 被取消，就不能按可重试处理，否则会安排一次没人想要的延迟重试。
        const cancelled =
          String(error?.message || "").toLowerCase() === "cancelled" ||
          (await Promise.resolve(context.isCancelled(job.jobId)).catch(() => false));
        const message = cancelled ? "备份已取消" : String(error?.message || error || "未知错误");

        // 修改点（第 2 期 限流 = 延迟，不是失败）：
        // 限流 / 超时 / 5xx 这类错误会自己好，既不该写进失败历史，也不该累计失败数，
        // 只记下「最早可以重试的时间」，本轮结束后交给调度层安排延迟重试。
        const deferral = cancelled ? null : noteDeferral(error);

        if (deferral) {
          const retryAtText = describeRetryAt(deferral.retryAtMs as number);

          if (backupId) {
            // 已经建好的记录不能留在 running（会永久挡住下一次定时备份），
            // 但绝不能写 failed —— 记 skipped，表示「本次没备份，已安排重试」
            await codeRepo
              .updateBackup(backupId, {
                status: "skipped",
                error_message: `本次未能完成，已安排在 ${retryAtText} 自动重试：${message}`,
                finished_at: nowIso(),
              })
              .catch((e: any) =>
                console.warn("[RepoBackupTaskHandler] 更新延迟记录失败:", e?.message || e),
              );
          }
          // 解析版本阶段就延迟时，原本会补一条失败留痕（见下方 else 分支）。
          // 这里刻意不写任何记录：限流不是失败，写进备份历史只会污染它。

          itemResult.status = "skipped";
          itemResult.message = `已延迟重试（${describeErrorKind(deferral.kind)}，重试时间 ${retryAtText}）：${message}`;
          itemResult.durationMs = Date.now() - refStartedMs;

          outcomes.push({ ref: trackRef ?? null, status: "skipped", error: undefined });

          // 不写 last_error：限流不是这个仓库的问题，留给收尾统一写「已安排重试」的说明
          console.warn(
            `[RepoBackupTaskHandler] 备份被推迟: ${repoIdentifier}@${trackRef || ""} ${itemResult.message}`,
          );
        } else {
          if (backupId) {
            await codeRepo
              .updateBackup(backupId, {
                status: cancelled ? "skipped" : "failed",
                error_message: message,
                finished_at: nowIso(),
              })
              .catch((e: any) => console.warn("[RepoBackupTaskHandler] 更新备份记录失败:", e?.message || e));
          } else {
            // 修改点（历史记录需显示失败记录）：
            // 解析版本阶段就失败时（限流、网络不通、分支不存在）原本一条记录都不会写，
            // 备份历史里因此永远只看到成功的版本。这里补一条失败留痕，
            // commit_sha 用占位值绕过 NOT NULL + 唯一索引，DTO 读取时会还原为 null。
            await codeRepo
              .createBackup({
                id: generateId("bk"),
                repository_id: repoRow.id,
                ref_type: trackMode === "branch" ? "branch" : "tag",
                ref: trackRef ?? null,
                commit_sha: buildUnresolvedCommitSha(),
                version: null,
                status: cancelled ? "skipped" : "failed",
                job_id: job.jobId,
                error_message: message,
                started_at: new Date(refStartedMs).toISOString(),
                finished_at: nowIso(),
              })
              .catch((e: any) => console.warn("[RepoBackupTaskHandler] 写入失败留痕记录出错:", e?.message || e));
          }

          await codeRepo
            .updateRepository(repoRow.id, { last_error: message })
            .catch((e: any) => console.warn("[RepoBackupTaskHandler] 更新仓库状态失败:", e?.message || e));

          itemResult.status = cancelled ? "skipped" : "failed";
          itemResult.error = message;
          itemResult.durationMs = Date.now() - refStartedMs;

          outcomes.push({
            ref: trackRef ?? null,
            status: cancelled ? "skipped" : "failed",
            error: message,
          });

          if (!cancelled && !firstError) firstError = error;

          console.error(`[RepoBackupTaskHandler] 备份失败: ${repoIdentifier}@${trackRef || ""}`, message);
        }
      }

      processed += 1;
      await report(processed);

      if (await context.isCancelled(job.jobId)) {
        console.log("[RepoBackupTaskHandler] 任务已取消，停止后续引用");
        break;
      }
    }

    // ---------- 4. 延迟重试收尾（修改点：第 2 期 限流 = 延迟，不是失败）----------
    //
    // 走到这里说明本轮至少有一处撞上了限流/暂时性故障。此时：
    // - 不写任何失败记录（上面已经处理过）
    // - 把该仓库的备份计划提前到「最早可重试时间」，让调度层到点自动重跑，
    //   而不是白等一个完整周期（默认 6 小时）
    // - 函数正常返回、不抛异常：这样 Workflows 的 execute-task 步骤不会被判定失败，
    //   Node 侧的任务也不会被标 failed —— 下一次执行完全由调度器按 next_run_after 决定
    if (deferredRetryAtMs !== null) {
      const retryAtText = describeRetryAt(deferredRetryAtMs);
      const kindText = describeErrorKind(deferredKind || "");
      const note = `${kindText}，本次未备份，已安排在 ${retryAtText} 自动重试：${deferredMessage || ""}`;

      // 只前移、不后移，也不会碰 schedule_type / interval_sec / enabled 等其他字段；
      // 仓库未启用定时备份时返回 false，这种情况下只能由管理员手动重试
      const moved = await deferRepositoryBackupSchedule(db, repoRow.id, retryAtText);

      await codeRepo
        .updateRepository(repoRow.id, { last_error: note })
        .catch((e: any) =>
          console.warn("[RepoBackupTaskHandler] 更新仓库延迟状态失败:", e?.message || e),
        );

      console.warn(
        `[RepoBackupTaskHandler] ${repoIdentifier} 本轮被推迟：${note}` +
          `（${moved ? "已提前备份计划" : "该仓库未启用定时备份，需手动重试"}）`,
      );
    }

    currentStage = "finished";
    currentRef = null;
    currentTarget = { name: null, mountPath: null };
    await report(processed, { durationMs: Date.now() - startedMs });

    // 全部引用都失败时向上抛出，让任务被标记为失败（部分失败按成功结束，便于重试单条）
    // 修改点（第 2 期）：被推迟的引用记为 skipped 而不是 failed，因此
    // 「整轮都是限流」不会被判成失败 —— 它已经交给调度层安排了延迟重试。
    const failedCount = outcomes.filter((o) => o.status === "failed").length;
    if (failedCount > 0 && failedCount === outcomes.length) {
      throw firstError || new Error("全部备份引用均失败");
    }
  }

  /**
   * 构造写入目标旁的 manifest（修改点：多备份目标优化，按目标记录挂载点信息）
   */
  private buildManifest({
    provider,
    repoIdentifier,
    repoRow,
    version,
    backupId,
    jobId,
    archive,
    mount,
  }: any) {
    return {
      schemaVersion: 1,
      provider,
      repoIdentifier,
      repositoryId: repoRow.id,
      repositoryName: repoRow.name || repoIdentifier,
      trackMode: repoRow.track_mode,
      refType: version.refType,
      ref: version.ref,
      commitSha: version.commitSha,
      version: version.version,
      publishedAt: version.publishedAt ?? null,
      backupId,
      backupAt: nowIso(),
      jobId,
      archive,
      mount: {
        id: mount.id,
        name: mount.name ?? null,
        mountPath: mount.mount_path,
        storageType: mount.storage_type ?? null,
      },
    };
  }
}
