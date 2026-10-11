/**
 * 代码仓库备份 - 同分支同 sha 的重复目录去重（修改点：同分支同 sha 只保留一个目录）
 *
 * 要解决的现场
 * ------------
 * 挂载浏览里能看到同一个分支、同一个 commit 出现多个只有时间不同的文件夹：
 *   /Github/owner__repo/main/20261011-093512__main__8a7950d/
 *   /Github/owner__repo/main/20261009-041203__main__8a7950d/
 *   /Github/owner__repo/main/20261006-221045__main__8a7950d/
 *
 * 根因：目录名是 planBackupPaths 用「本次写入时刻」拼的 {时间}__{分支}__{sha7}，
 * 而同一个 (分支, sha) 会被重复写入多次 ——
 *   · force 强制重跑：3.2 的去重被跳过，直接重新规划路径；
 *   · 部分目标失败后的补写：下一轮只补缺的目标，但 at 是新的时刻；
 *   · 预算用尽的 deferred 目标在下一轮继续；
 *   · 并发两个作业备同一个 commit。
 * 数据库那边有 (repository_id, commit_sha) 唯一索引 + upsertBackupTarget 的
 * ON CONFLICT(backup_id, mount_id)，所以**记录只有一份**，它只指向最后写成功的那个目录；
 * 先前那些目录就成了没人引用的孤儿，一直留在存储里。
 *
 * 本模块的职责
 * ------------
 * 备份写入成功后，扫一遍该分支目录，把「同分支同 sha」的目录按身份分组，
 * 每组只留一个（时间最新的那个），其余删除。
 *
 * 几条硬约束（都是为了绝不误删）
 * ------------
 * 1. 只认 parseBackupDirName 能解析的目录名（严格的 {8位}-{6位}__分支__{7位sha} 形态）。
 *    认不出来的目录（用户自建的、老结构的、其它工具放的）一律不碰；
 * 2. 只在「本次备份的那个分支目录」里扫，不递归、不跨分支、不碰仓库目录本身；
 * 3. 保护名单优先：仍被数据库记录引用的目录永远不删（见 findReferencedPaths）。
 *    反过来，「时间更新但没被引用」的目录是要删的 —— 那种排列只出现在
 *    「更新的那次写入没走完」（归档传上去了但目标行没 upsert，作业被杀）时，
 *    那个目录很可能是半截的，而被引用的才是备份历史里能下载的那个。
 *    删它是安全的：没有任何记录指向它，删了不会让下载链接失效；
 *    结果仍然收敛到「只剩一个目录」。正常流程下两者本来就是同一个 ——
 *    调用方在 upsertBackupTarget 之后才查名单，刚写完的目录必然既最新又被引用；
 * 4. 全程 best-effort：列目录失败、删除失败都只打日志，绝不让备份任务失败。
 *    备份本身已经成功了，收拾现场失败不该把结论改成红色。
 */

import { parseBackupDirName, buildBackupGroupKey } from "./paths.js";

/**
 * 从一组同身份的目录里挑出「要保留的那一个」
 *
 * 优先级：
 * 1. 被数据库引用的（referenced）—— 它就是备份历史里下载链接指向的目录，必须留；
 *    若有多个被引用（理论上不该出现，除非历史数据错乱），留时间最新的那个，
 *    其余被引用的目录同样不会被删（调用方对 referenced 另有豁免）；
 * 2. 都没被引用时留时间戳最新的 —— 与「时间使用最新的」这一要求一致。
 *
 * @param {Array<{ dirName: string, timestamp: string, referenced: boolean }>} group
 * @returns {{ dirName: string, timestamp: string, referenced: boolean }} 要保留的那一个
 */
export function pickKeeper(group) {
  const sorted = [...group].sort((a, b) => {
    // 被引用的排在前面
    if (a.referenced !== b.referenced) return a.referenced ? -1 : 1;
    // 时间戳形态固定（yyyyMMdd-HHmmss），字典序即时间序，降序取最新
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? 1 : -1;
    // 时间戳也相同：用目录名兜底定序，保证结果稳定（同一输入永远选同一个）
    return a.dirName < b.dirName ? 1 : -1;
  });
  return sorted[0];
}

/**
 * 算出某分支目录下「该删掉的重复目录」
 *
 * 纯函数，不碰 IO —— 这样「选谁留谁」这套判断可以被单测完整覆盖（见 dedupeDirs.test.js）。
 *
 * @param {Object} params
 * @param {string[]} params.dirNames 分支目录下的子目录名（不含斜杠）
 * @param {string} params.refDirPath 分支目录路径（以 / 结尾），用于拼出完整路径
 * @param {Set<string>} [params.referencedDirs] 仍被数据库引用的目录路径（以 / 结尾）
 * @returns {{ removeDirPaths: string[], groups: number, duplicates: number }}
 */
export function planDirDedupe({ dirNames, refDirPath, referencedDirs = new Set() }) {
  /** @type {Map<string, Array<{ dirName: string, timestamp: string, referenced: boolean }>>} */
  const groups = new Map();

  for (const dirName of dirNames || []) {
    const parsed = parseBackupDirName(dirName);
    // 认不出来的目录一律不碰（约束 1）
    if (!parsed) continue;

    const key = buildBackupGroupKey(parsed);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      dirName,
      timestamp: parsed.timestamp,
      referenced: referencedDirs.has(`${refDirPath}${dirName}/`),
    });
  }

  const removeDirPaths = [];
  let duplicates = 0;

  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    duplicates += group.length - 1;

    const keeper = pickKeeper(group);
    for (const entry of group) {
      if (entry.dirName === keeper.dirName) continue;
      // 保护名单优先（约束 3）：被引用的目录即使不是最新也不删
      if (entry.referenced) continue;
      removeDirPaths.push(`${refDirPath}${entry.dirName}/`);
    }
  }

  return { removeDirPaths, groups: groups.size, duplicates };
}

/**
 * 扫一个分支目录，删掉同分支同 sha 的多余目录
 *
 * 调用时机：某个目标写入成功之后（见 RepoBackupTaskHandler）。
 * 为什么是「每个目标各扫一次」而不是统一收尾扫一遍：目标各自落在不同挂载点上，
 * 分支目录路径里带挂载点前缀，本来就得逐挂载点扫；而且写完就扫，
 * 哪怕后面的目标撞上预算用尽、整个作业被 CPU 限制杀掉，已经写完的那个挂载点也已经干净了。
 *
 * @param {Object} params
 * @param {Object} params.fileSystem FileSystem 实例
 * @param {string} params.refDirPath 分支目录路径（以 / 结尾）
 * @param {Set<string>} [params.referencedDirs] 仍被数据库引用的目录路径（以 / 结尾）
 * @param {string|number} params.userId
 * @param {string} params.userType
 * @returns {Promise<{ removed: number, failed: number, duplicates: number }>}
 */
export async function dedupeBackupDirs({ fileSystem, refDirPath, referencedDirs, userId, userType }) {
  const summary = { removed: 0, failed: 0, duplicates: 0 };
  if (!fileSystem || !refDirPath) return summary;

  let dirNames = [];
  try {
    // refresh: true —— 本次备份刚往这个目录里写过东西，目录缓存可能还是旧的；
    // 拿旧列表去重会漏掉刚写进去的目录（也就漏掉了本次产生的重复）
    const listing = await fileSystem.listDirectory(refDirPath, userId, userType, { refresh: true });
    dirNames = (listing?.items || []).filter((item) => item?.isDirectory).map((item) => String(item.name || ""));
  } catch (error) {
    // 分支目录不存在、驱动不支持列目录等：没什么可去重的，直接收手（约束 4）
    console.warn(
      `[repoBackup] 重复目录去重跳过（列目录失败）: ${refDirPath}`,
      error?.message || error,
    );
    return summary;
  }

  const { removeDirPaths, duplicates } = planDirDedupe({ dirNames, refDirPath, referencedDirs });
  summary.duplicates = duplicates;
  if (removeDirPaths.length === 0) return summary;

  try {
    const result = await fileSystem.batchRemoveItems(removeDirPaths, userId, userType);
    summary.removed = Number(result?.success) || 0;
    const failed = Array.isArray(result?.failed) ? result.failed : [];
    summary.failed = failed.length;
    for (const item of failed) {
      console.warn(`[repoBackup] 重复目录删除失败 ${item?.path || ""}: ${item?.error || "未知原因"}`);
    }
    if (summary.removed > 0) {
      console.log(
        `[repoBackup] 已清理 ${summary.removed} 个同分支同 sha 的重复目录: ${refDirPath}`,
      );
    }
  } catch (error) {
    summary.failed = removeDirPaths.length;
    console.warn(
      `[repoBackup] 重复目录删除失败（不影响备份结论）: ${removeDirPaths.join(", ")}`,
      error?.message || error,
    );
  }

  return summary;
}

/**
 * 把「仍被引用的文件路径」收敛成「仍被引用的专属目录」集合
 *
 * @param {string[]} paths findReferencedPaths 的返回值（完整 FS 路径）
 * @returns {Set<string>} 目录路径（以 / 结尾）
 */
export function toReferencedDirs(paths) {
  const dirs = new Set();
  for (const path of paths || []) {
    const raw = String(path || "");
    const lastSlash = raw.lastIndexOf("/");
    if (lastSlash <= 0) continue;
    dirs.add(raw.slice(0, lastSlash + 1));
  }
  return dirs;
}
