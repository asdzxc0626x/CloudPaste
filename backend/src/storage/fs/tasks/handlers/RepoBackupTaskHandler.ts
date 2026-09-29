// cSpell:words tarball repobackup
import type { TaskHandler, InternalJob, ExecutionContext } from "../TaskHandler.js";
import type { TaskStats, ItemResult } from "../types.js";
import { ValidationError, NotFoundError } from "../../../../http/errors.js";
import { ensureRepositoryFactory } from "../../../../utils/repositories.js";
import { UserType } from "../../../../constants/index.js";
import { RepoProviderFactory } from "../../../../repobackup/providers/index.js";
import { parseProviderConfig } from "../../../../repobackup/config.js";
import { planBackupPaths } from "../../../../repobackup/paths.js";

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
 */

type RepoBackupPayload = {
  repositoryId: string;
  force?: boolean;
};

/** 单个任务只处理一个仓库，统计模板固定为 1 项 */
function buildStats(overrides: Partial<TaskStats> = {}): TaskStats {
  return {
    totalItems: 1,
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
    return buildStats();
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

    const startedAt = nowIso();
    const startedMs = Date.now();

    const itemResult: ItemResult = {
      kind: "repo",
      label: payload.repositoryId,
      status: "processing",
    };

    const report = async (extra: Partial<TaskStats> = {}) => {
      await context.updateProgress(job.jobId, buildStats({ itemResults: [itemResult], ...extra }));
    };

    await report();

    // ---------- 1. 读取仓库配置 ----------
    const repoRow = await codeRepo.findRepositoryById(payload.repositoryId);
    if (!repoRow) {
      throw new NotFoundError(`代码仓库不存在: ${payload.repositoryId}`);
    }

    const provider = String(repoRow.provider || "");
    const repoIdentifier = String(repoRow.repo_identifier || "");
    itemResult.label = `${provider}:${repoIdentifier}`;

    let backupId: string | null = null;

    try {
      if (await context.isCancelled(job.jobId)) {
        throw new Error("cancelled");
      }

      // ---------- 2. 解析最新版本 ----------
      const providerConfig = await parseProviderConfig(provider, repoRow.config_json, encryptionSecret);
      const providerInstance = RepoProviderFactory.createProvider(provider, providerConfig);

      const version = await providerInstance.resolveLatestVersion({
        repoIdentifier,
        trackMode: String(repoRow.track_mode || "branch") as "branch" | "release",
        trackRef: repoRow.track_ref ?? null,
      });

      await codeRepo.updateRepository(repoRow.id, { last_checked_at: nowIso() });

      itemResult.meta = {
        refType: version.refType,
        ref: version.ref,
        commitSha: version.commitSha,
        version: version.version,
      };
      await report({ processedItems: 0 });

      // ---------- 3. 去重判断 ----------
      const existing = await codeRepo.findBackupByCommit(repoRow.id, version.commitSha);

      if (existing && existing.status === "success" && !force) {
        itemResult.status = "skipped";
        itemResult.message = `已存在该版本的备份（${version.version}），跳过`;
        itemResult.durationMs = Date.now() - startedMs;

        await codeRepo.updateRepository(repoRow.id, { last_error: null });
        await context.updateProgress(
          job.jobId,
          buildStats({ processedItems: 1, skippedCount: 1, itemResults: [itemResult] }),
        );
        console.log(`[RepoBackupTaskHandler] 跳过重复备份: ${repoIdentifier} @ ${version.commitSha}`);
        return;
      }

      // ---------- 4. 解析目标挂载点 ----------
      const mount = await mountRepository.findById(repoRow.target_mount_id);
      if (!mount) {
        throw new NotFoundError(`备份目标挂载点不存在: ${repoRow.target_mount_id}`);
      }
      if (mount.is_active === 0) {
        throw new ValidationError(`备份目标挂载点已禁用: ${mount.name || mount.mount_path}`);
      }

      const paths = planBackupPaths({
        mountPath: mount.mount_path,
        pathPrefix: repoRow.target_path_prefix,
        provider,
        repoIdentifier,
        commitSha: version.commitSha,
      });

      // ---------- 5. 创建/复用备份记录 ----------
      // 注意：(repository_id, commit_sha) 上有唯一索引，force 重跑时必须复用原记录而非新插入
      if (existing) {
        backupId = existing.id;
        await codeRepo.updateBackup(backupId, {
          status: "running",
          ref_type: version.refType,
          ref: version.ref,
          version: version.version,
          storage_path: null,
          manifest_path: null,
          size_bytes: null,
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

      if (await context.isCancelled(job.jobId)) {
        throw new Error("cancelled");
      }

      // ---------- 6. 确保目标目录存在 ----------
      // createDirectory 对已存在目录是幂等的（返回 alreadyExists）
      try {
        await fileSystem.createDirectory(paths.repoDirPath, job.userId, job.userType);
      } catch (error: any) {
        // 部分对象存储没有真实目录概念，创建失败不影响后续写入
        console.warn(
          `[RepoBackupTaskHandler] 创建目录失败（继续尝试上传）: ${paths.repoDirPath}`,
          error?.message || error,
        );
      }

      // ---------- 7. 流式下载 + 上传 ----------
      console.log(
        `[RepoBackupTaskHandler] 开始备份 ${repoIdentifier} @ ${version.version} -> ${paths.archivePath}`,
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

      itemResult.fileSize = sizeBytes ?? undefined;
      itemResult.bytesTransferred = counter.value;
      await report({ totalBytes: sizeBytes ?? 0, bytesTransferred: counter.value });

      console.log(
        `[RepoBackupTaskHandler] 归档已上传: ${paths.archivePath}, 大小=${sizeBytes ?? "未知"} 字节`,
      );

      // ---------- 8. 写 manifest ----------
      const manifest = {
        schemaVersion: 1,
        provider,
        repoIdentifier,
        repositoryId: repoRow.id,
        repositoryName: repoRow.name || repoIdentifier,
        trackMode: repoRow.track_mode,
        trackRef: repoRow.track_ref ?? null,
        refType: version.refType,
        ref: version.ref,
        commitSha: version.commitSha,
        version: version.version,
        publishedAt: version.publishedAt ?? null,
        backupId,
        backupAt: nowIso(),
        jobId: job.jobId,
        archive: {
          path: uploadResult?.storagePath || paths.archivePath,
          fileName: paths.archiveFileName,
          contentType: archive.contentType || "application/gzip",
          sizeBytes,
          format: "tar.gz",
        },
        mount: {
          id: mount.id,
          name: mount.name ?? null,
          mountPath: mount.mount_path,
          storageType: mount.storage_type ?? null,
        },
      };

      let manifestPath: string | null = null;
      let manifestWarning: string | null = null;
      try {
        const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
        await fileSystem.uploadFile(paths.manifestPath, manifestBytes, job.userId, job.userType, {
          filename: paths.manifestFileName,
          contentType: "application/json",
          contentLength: manifestBytes.byteLength,
        });
        manifestPath = paths.manifestPath;
      } catch (error: any) {
        // manifest 是归档旁的便利副本，元信息在数据库记录中已完整保存。
        // 这里不因它失败而判定整个备份失败，但必须把问题暴露给管理员。
        manifestWarning = `manifest 写入失败: ${error?.message || String(error)}`;
        console.warn(`[RepoBackupTaskHandler] ${manifestWarning}`);
      }

      // ---------- 9. 回写记录 ----------
      const finishedAt = nowIso();
      await codeRepo.updateBackup(backupId, {
        status: "success",
        storage_path: uploadResult?.storagePath || paths.archivePath,
        manifest_path: manifestPath,
        size_bytes: sizeBytes,
        error_message: manifestWarning,
        finished_at: finishedAt,
      });

      await codeRepo.updateRepository(repoRow.id, {
        last_backup_at: finishedAt,
        last_known_commit_sha: version.commitSha,
        last_error: manifestWarning,
      });

      itemResult.status = "success";
      itemResult.targetPath = uploadResult?.storagePath || paths.archivePath;
      itemResult.durationMs = Date.now() - startedMs;
      if (manifestWarning) itemResult.message = manifestWarning;

      await context.updateProgress(
        job.jobId,
        buildStats({
          processedItems: 1,
          successCount: 1,
          totalBytes: sizeBytes ?? 0,
          bytesTransferred: counter.value,
          itemResults: [itemResult],
        }),
      );

      console.log(`[RepoBackupTaskHandler] 备份完成: ${repoIdentifier} @ ${version.version}`);
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
        .updateRepository(payload.repositoryId, { last_error: message })
        .catch((e: any) => console.warn("[RepoBackupTaskHandler] 更新仓库状态失败:", e?.message || e));

      itemResult.status = cancelled ? "skipped" : "failed";
      itemResult.error = message;
      itemResult.durationMs = Date.now() - startedMs;

      await context.updateProgress(
        job.jobId,
        buildStats({
          processedItems: 1,
          successCount: 0,
          failedCount: cancelled ? 0 : 1,
          skippedCount: cancelled ? 1 : 0,
          itemResults: [itemResult],
        }),
      );

      console.error(`[RepoBackupTaskHandler] 备份失败: ${payload.repositoryId}`, message);

      // 取消是预期内的终止，不再向上抛出（避免任务被标记为 failed）
      if (cancelled) return;
      throw error;
    }
  }
}
