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
} from "../../../../repobackup/config.js";
import { planBackupPaths } from "../../../../repobackup/paths.js";
import { pruneOldVersions, describePruneResult } from "../../../../repobackup/retention.js";

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
 */

type RepoBackupPayload = {
  repositoryId: string;
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
 * 给流套一个字节计数器
 * - 返回的 counter.value 只有在流被完全消费后才是最终值
 */
function withByteCounter(stream: ReadableStream): { stream: ReadableStream; counter: { value: number } } {
  const counter = { value: 0 };

  // TransformStream 在 Cloudflare Workers 与 Node 18+ 均为全局可用
  const transform = new TransformStream({
    transform(chunk: any, controller: any) {
      try {
        const size = chunk?.byteLength ?? chunk?.length ?? 0;
        if (Number.isFinite(size)) counter.value += size;
      } catch {
        // 计数失败不应中断传输
      }
      controller.enqueue(chunk);
    },
  });

  return { stream: stream.pipeThrough(transform), counter };
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
          ...extra,
        }),
      );
    };

    await report(0);

    // ---------- 2. 解析 Provider（失败即整体失败） ----------
    const providerConfig = await parseProviderConfig(provider, repoRow.config_json, encryptionSecret);
    const providerInstance = RepoProviderFactory.createProvider(provider, providerConfig);

    let processed = 0;
    let firstError: Error | null = null;

    // ---------- 3. 逐个引用（分支）备份 ----------
    for (const trackRef of trackRefs) {
      const itemResult: ItemResult = {
        kind: "repo",
        label: trackRef ? `${repoIdentifier}@${trackRef}` : repoIdentifier,
        status: "processing",
        meta: { refType: trackMode === "branch" ? "branch" : "tag", ref: trackRef },
      };
      itemResults.push(itemResult);

      const refStartedMs = Date.now();
      let backupId: string | null = null;

      try {
        if (await context.isCancelled(job.jobId)) {
          throw new Error("cancelled");
        }

        // 3.1 解析该引用的最新版本
        const version = await providerInstance.resolveLatestVersion({
          repoIdentifier,
          trackMode,
          trackRef: trackRef ?? null,
        });

        itemResult.meta = {
          refType: version.refType,
          ref: version.ref,
          commitSha: version.commitSha,
          version: version.version,
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

            const archive = await providerInstance.openSourceArchive({
              repoIdentifier,
              refType: version.refType,
              ref: version.ref,
              commitSha: version.commitSha,
            });

            const { stream: countedStream, counter } = withByteCounter(archive.stream);

            const uploadResult = await fileSystem.uploadFile(
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

            const sizeBytes = counter.value > 0 ? counter.value : null;
            totalBytes += sizeBytes ?? 0;
            bytesTransferred += counter.value;

            // manifest 是归档旁的便利副本，元信息在数据库记录中已完整保存。
            // 这里不因它失败而判定该目标失败，但必须把问题暴露给管理员。
            let manifestPath: string | null = null;
            let manifestWarning: string | null = null;
            try {
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
            if (!primaryStoragePath) {
              primaryStoragePath = storagePath;
              primaryManifestPath = manifestPath;
              primarySizeBytes = sizeBytes;
            }
            if (manifestWarning) targetErrors.push(`${mount.name || mount.mount_path}: ${manifestWarning}`);

            console.log(`[RepoBackupTaskHandler] 目标写入完成: ${storagePath}`);
          } catch (targetError: any) {
            // 单个目标失败不影响其他目标；下次运行会自动补写
            const message = String(targetError?.message || targetError || "未知错误");
            targetErrors.push(`${mount.name || mount.mount_path}: ${message}`);

            await codeRepo
              .upsertBackupTarget({
                id: generateId("bkt"),
                backup_id: backupId,
                mount_id: mount.id,
                mount_path: mount.mount_path,
                status: "failed",
                error_message: message,
              })
              .catch((e: any) =>
                console.warn("[RepoBackupTaskHandler] 记录目标失败状态出错:", e?.message || e),
              );

            console.error(
              `[RepoBackupTaskHandler] 目标写入失败 (${mount.name || mount.mount_path}):`,
              message,
            );
          }
        }

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
          // 所有目标都没有副本：该引用判定为失败
          const message = backupWarning || "所有备份目标均写入失败";
          await codeRepo.updateBackup(backupId, {
            status: "failed",
            error_message: message,
            finished_at: finishedAt,
          });

          itemResult.status = "failed";
          itemResult.error = message;
          itemResult.durationMs = Date.now() - refStartedMs;
          outcomes.push({ ref: version.ref ?? trackRef ?? null, status: "failed", error: message });
          if (!firstError) firstError = new Error(message);
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
        const cancelled = String(error?.message || "").toLowerCase() === "cancelled";
        const message = cancelled ? "备份已取消" : String(error?.message || error || "未知错误");

        if (backupId) {
          await codeRepo
            .updateBackup(backupId, {
              status: cancelled ? "skipped" : "failed",
              error_message: message,
              finished_at: nowIso(),
            })
            .catch((e: any) => console.warn("[RepoBackupTaskHandler] 更新备份记录失败:", e?.message || e));
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

      processed += 1;
      await report(processed);

      if (await context.isCancelled(job.jobId)) {
        console.log("[RepoBackupTaskHandler] 任务已取消，停止后续引用");
        break;
      }
    }

    await report(processed);

    // 全部引用都失败时向上抛出，让任务被标记为失败（部分失败按成功结束，便于重试单条）
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
