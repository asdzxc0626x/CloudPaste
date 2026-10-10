/**
 * 代码仓库备份 - 版本保留清理（修改点：版本保留优化）
 *
 * 职责：备份成功后，把超出「保留版本数」的最旧成功备份连同其在各个目标上的
 * 快照文件一起删除，避免备份无限增长把存储撑满。
 *
 * 设计要点：
 * - 只清理 status='success' 的记录；失败/跳过的记录不占额度，由任务列表自行留痕
 * - 文件删除是「尽力而为」：某个目标删不掉（挂载点被删、驱动只读等）不会阻塞
 *   其余目标的清理，也不会让备份任务失败——数据库记录照样清理，避免残留脏记录
 * - 复用 fileSystem.batchRemoveItems，不自己拼驱动调用
 * - 修改点（备份目录按分支分层）：每次备份独占一个「时间_分支_sha」目录，
 *   文件删完后顺手把该目录也清掉，否则本地 / WebDAV 这类真实目录的存储上会堆一堆空目录
 */

import { resolveRetentionCount, NON_SUCCESS_HISTORY_KEEP } from "./config.js";
// 修改点（备份目录按分支分层）：从落盘路径反推「本次备份的专属目录」，用于顺带清理空目录
import { resolveBackupDirFromFilePath } from "./paths.js";

/**
 * 按挂载点把待删路径分组
 * - batchRemoveItems 不支持跨挂载批量删除，因此必须分组调用
 * - 修改点（备份目录按分支分层）：文件与目录分开返回。文件是「必须删掉」的，
 *   目录只是收尾（见 pruneOldVersions），混在一起会让目录删除失败被误报成「文件删除失败」
 * - 导出仅供回归测试使用（retentionGrouping.test.js），业务代码只在本文件内调用
 * @param {Object[]} targets code_repository_backup_targets 行
 * @param {Object} legacyBackup 无目标结果时的兜底记录（v35 及更早）
 * @returns {{ files: Map<string, string[]>, dirs: Map<string, string[]> }} key 为 mount_id（未知时用 ""）
 */
export function groupPathsByMount(targets, legacyBackup) {
  const files = new Map();
  const dirs = new Map();

  const push = (bucket, mountId, path) => {
    if (!path) return;
    const key = String(mountId || "");
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key).push(path);
  };

  /**
   * 记录一个目标：快照、manifest，以及它们所在的专属目录
   * 修改点（备份目录按分支分层）：只在新结构下才会推出目录
   * （老记录的父目录是仓库目录，resolveBackupDirFromFilePath 返回 null，行为与改造前一致）
   */
  const pushTarget = (mountId, storagePath, manifestPath) => {
    push(files, mountId, storagePath);
    push(files, mountId, manifestPath);
    // 快照与 manifest 同在一个专属目录里，反推出的目录会重复一次，用 Set 去重
    const targetDirs = new Set();
    for (const path of [storagePath, manifestPath]) {
      const dir = resolveBackupDirFromFilePath(path);
      if (dir) targetDirs.add(dir);
    }
    for (const dir of targetDirs) push(dirs, mountId, dir);
  };

  if (Array.isArray(targets) && targets.length > 0) {
    for (const target of targets) {
      pushTarget(target.mount_id, target.storage_path, target.manifest_path);
    }
    return { files, dirs };
  }

  // 兼容 v35 数据：路径直接存在备份记录上，且两者必然同挂载点
  if (legacyBackup) {
    pushTarget(legacyBackup.target_mount_id || "", legacyBackup.storage_path, legacyBackup.manifest_path);
  }
  return { files, dirs };
}

/**
 * 清理超出保留数量的最旧备份
 *
 * @param {Object} params
 * @param {Object} params.codeRepo CodeRepositoryRepository 实例
 * @param {Object} params.fileSystem FileSystem 实例（用于删除快照文件）
 * @param {Object} params.repositoryRow code_repositories 行
 * @param {string|number} params.userId 执行删除的身份（管理员或系统身份）
 * @param {string} params.userType
 * @returns {Promise<{removedCount: number, removedAttempts: number, removedPaths: number, failedPaths: number, errors: string[]}>}
 */
export async function pruneOldVersions({ codeRepo, fileSystem, repositoryRow, userId, userType }) {
  const summary = { removedCount: 0, removedAttempts: 0, removedPaths: 0, failedPaths: 0, errors: [] };
  if (!codeRepo || !repositoryRow?.id) return summary;

  const keepCount = resolveRetentionCount(repositoryRow);

  let staleBackups = [];
  try {
    staleBackups = await codeRepo.findSuccessBackupsBeyondLimit(repositoryRow.id, keepCount);
  } catch (error) {
    summary.errors.push(`查询待清理备份失败: ${error?.message || error}`);
    // 成功版本查不出来不代表失败留痕也不用清，继续往下走
    staleBackups = [];
  }

  for (const backup of staleBackups) {
    // 1. 删文件（best-effort）
    if (fileSystem) {
      try {
        const targets = await codeRepo.findTargetsByBackup(backup.id);
        const { files, dirs } = groupPathsByMount(targets, backup);

        for (const paths of files.values()) {
          if (paths.length === 0) continue;
          try {
            const result = await fileSystem.batchRemoveItems(paths, userId, userType);
            summary.removedPaths += Number(result?.success) || 0;
            const failed = Array.isArray(result?.failed) ? result.failed : [];
            summary.failedPaths += failed.length;
            for (const item of failed) {
              summary.errors.push(`删除失败 ${item?.path || ""}: ${item?.error || "未知原因"}`);
            }
          } catch (error) {
            // 挂载点已被删除等场景：记录后继续，不阻塞记录清理
            summary.failedPaths += paths.length;
            summary.errors.push(`删除快照失败（${paths.join(", ")}）: ${error?.message || error}`);
          }
        }

        // 修改点（备份目录按分支分层）：快照与 manifest 删完后，那种「时间_分支_sha」
        // 专属目录就空了，顺手收掉，免得本地 / WebDAV 这类真实目录的存储上堆一堆空目录。
        // 这一步纯粹是收拾现场：失败（驱动不支持删目录、目录里还有删不掉的文件等）
        // 既不计入 failedPaths 也不写 errors，避免让管理员以为快照没删干净。
        for (const paths of dirs.values()) {
          if (paths.length === 0) continue;
          try {
            await fileSystem.batchRemoveItems(paths, userId, userType);
          } catch (error) {
            console.warn(
              `[repoBackup] 清理备份目录失败（不影响记录清理）: ${paths.join(", ")}`,
              error?.message || error,
            );
          }
        }
      } catch (error) {
        summary.errors.push(`读取备份目标失败（${backup.id}）: ${error?.message || error}`);
      }
    }

    // 2. 删记录（含各目标结果）
    try {
      await codeRepo.deleteBackupTargetsByBackup(backup.id);
      await codeRepo.deleteBackup(backup.id);
      summary.removedCount += 1;
    } catch (error) {
      summary.errors.push(`删除备份记录失败（${backup.id}）: ${error?.message || error}`);
    }
  }

  // 3. 顺带清理过多的失败/跳过留痕（修改点：历史记录需显示失败记录）
  //    这些记录没有可用快照（failed = 没有任何目标写成功，skipped = 什么都没写），
  //    所以不删文件、只删记录；它们也不占用「保留版本数」的额度
  try {
    const staleAttempts = await codeRepo.findNonSuccessBackupsBeyondLimit(
      repositoryRow.id,
      NON_SUCCESS_HISTORY_KEEP,
    );
    for (const attempt of staleAttempts) {
      try {
        await codeRepo.deleteBackupTargetsByBackup(attempt.id);
        await codeRepo.deleteBackup(attempt.id);
        summary.removedAttempts += 1;
      } catch (error) {
        summary.errors.push(`删除失败留痕记录出错（${attempt.id}）: ${error?.message || error}`);
      }
    }
  } catch (error) {
    summary.errors.push(`查询待清理的失败留痕出错: ${error?.message || error}`);
  }

  return summary;
}

/**
 * 生成一句面向管理员的清理摘要（写入任务 itemResult.message）
 * @param {{removedCount: number, removedAttempts?: number, removedPaths: number, failedPaths: number, errors: string[]}|null} summary
 * @returns {string}
 */
export function describePruneResult(summary) {
  if (!summary) return "";
  const parts = [];
  if (summary.removedCount > 0) {
    parts.push(`已清理 ${summary.removedCount} 个最旧版本`);
    if (summary.failedPaths > 0) {
      parts.push(`其中 ${summary.failedPaths} 个文件删除失败（记录已清理，文件可能残留）`);
    }
  }
  // 修改点（历史记录需显示失败记录）：失败留痕的清理也要说明，否则记录凭空变少
  if (summary.removedAttempts > 0) {
    parts.push(`已清理 ${summary.removedAttempts} 条过旧的失败记录`);
  }
  return parts.join("，");
}
