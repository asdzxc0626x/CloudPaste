/**
 * 代码仓库备份 - 路径规划
 *
 * 修改点：新增功能
 *
 * 职责：把「挂载点 + 前缀 + 仓库 + 版本」映射为确定的 FS 路径。
 * 单独抽出来的原因：任务层要写入、服务层要生成下载链接，两边必须用同一套规则。
 *
 * 产出形态（与用户确认的方案一致）：
 *   /{mountPath}/{prefix}/{owner}__{repo}/{ref}/{yyyyMMdd-HHmmss}__{ref}__{sha7}/{owner}__{repo}__{ref}__{sha7}.tar.gz
 *   /{mountPath}/{prefix}/{owner}__{repo}/{ref}/{yyyyMMdd-HHmmss}__{ref}__{sha7}/{owner}__{repo}__{ref}__{sha7}.manifest.json
 *
 * 修改点（备份目录按分支分层）：在仓库目录与快照之间插入「分支目录 + 本次备份专属目录」两层，
 * 例如 owner__repo/main/20261005-155036__main__8a7950d/angusdevgo__IDM_Pro_Tool__main__8a7950d.tar.gz。
 * 这么分层的原因：
 * - 同一个仓库往往同时跟踪多个分支，原先所有分支、所有版本平铺在一个目录里，
 *   版本一多就分不清哪个文件属于哪个分支、哪一次备份；
 * - 每次备份独占一个「时间_分支_sha」目录，快照与它的 manifest 天然成组，
 *   删除某个版本时整目录拿走即可，不会误伤邻居
 *
 * 修改点（仓库目录去掉平台前缀）：仓库目录名由 `{provider}__{owner}__{repo}` 改为 `{owner}__{repo}`。
 * 上级目录本来就按仓库源分（GitHub 默认落到 /Github），仓库源在路径里重复出现了一次，
 * 于是 github__owner__repo 变成 owner__repo，路径更短也更好认。
 *
 * 修改点（快照按仓库名命名）：专属目录里的文件用 owner__repo__ref__sha 命名（不带平台前缀），
 * 文件名自身就能说明「哪个仓库的哪个分支哪个版本」，单独拿出去也认得出来
 */

import { ValidationError } from "../http/errors.js";

/**
 * 引用名兜底（修改点：备份目录按分支分层）
 * - branch 模式的分支名、release 模式的 tag 名都会作为目录名；
 *   引用缺失（历史数据 / 未解析到 ref）时不能留空目录段，统一落到 "default"
 */
const DEFAULT_REF_SEGMENT = "default";

/**
 * 「本次备份专属目录」的名字形态：yyyyMMdd-HHmmss__分支__sha7（修改点：快照按仓库名命名）
 *
 * 版本保留清理要判断一个路径的父目录是不是「本次备份专属目录」，好把空目录一并收掉。
 * 判定必须严格 —— 认错就会把整个仓库目录删掉，所以这里只认我们自己生成的时间戳形态：
 * - 时间戳是 UTC 的 yyyyMMdd-HHmmss，固定 8 位数字 + "-" + 6 位数字，老结构（父目录是
 *   owner__repo 这类仓库目录）不可能以它开头；
 * - 末段是 7 个字符的短 sha（commitSha 缺失时代码会写成 "unknown"，也正好 7 位）
 */
const BACKUP_DIR_NAME_PATTERN = /^\d{8}-\d{6}__.+__[0-9a-zA-Z]{7}$/;

/**
 * 把任意片段规范成安全的单层目录/文件名
 * - 复用 FS 层的命名约束：禁止 / \ ? < > * : | "
 * @param {string} raw
 * @returns {string}
 */
function sanitizeSegment(raw) {
  return String(raw || "")
    .trim()
    .replace(/[/\\?<>*:|"]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^\.+/, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * 规范化挂载点内的路径前缀
 * @param {string} prefix
 * @returns {string} 以 / 开头、不以 / 结尾的前缀；根目录返回 ""
 */
export function normalizePathPrefix(prefix) {
  const raw = String(prefix || "/").trim();
  if (!raw || raw === "/") return "";

  const segments = raw.split("/").filter(Boolean);
  if (segments.some((s) => s === "." || s === "..")) {
    throw new ValidationError("备份路径前缀不允许包含 . 或 .. 段");
  }

  const safe = segments.map(sanitizeSegment).filter(Boolean);
  return safe.length > 0 ? `/${safe.join("/")}` : "";
}

/**
 * 规范化挂载点路径
 * @param {string} mountPath
 * @returns {string} 以 / 开头、不以 / 结尾
 */
function normalizeMountPath(mountPath) {
  const raw = String(mountPath || "/").trim();
  const collapsed = raw.replace(/\/{2,}/g, "/");
  const trimmed = collapsed.replace(/\/+$/g, "");
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * 拆出仓库标识里的 owner / repo 两段（修改点：快照按仓库名命名）
 * - 与仓库目录名用同一套清洗规则，保证「目录名里的 owner/repo」和「文件名里的 owner/repo」永远一致
 * @param {string} repoIdentifier 'owner/repo'
 * @returns {{ owner: string, repo: string }}
 */
function splitRepoIdentifier(repoIdentifier) {
  const segments = String(repoIdentifier || "")
    .split("/")
    .filter(Boolean);
  return {
    owner: sanitizeSegment(segments[0] || "unknown"),
    repo: sanitizeSegment(segments[1] || "unknown"),
  };
}

/**
 * 仓库在挂载点内的专属目录名
 *
 * 修改点（仓库目录去掉平台前缀）：原来是 `${provider}__${owner}__${repo}`（例如
 * github__ling-drag0n__CloudPaste），现在只留 owner__repo。上级目录已经按仓库源分
 * （GitHub 默认落到 /Github），仓库源没必要在路径里重复一遍。
 * provider 参数保留只是为了不动调用方签名，已不参与拼名。
 *
 * 取舍：默认前缀按仓库源分目录，所以不同仓库源的同名 owner/repo 不会撞在一起；
 * 若有人手工把两个仓库源的前缀设成同一个目录，它们会共用同一个仓库目录 —— 刻意接受。
 *
 * @param {{ provider?: string, repoIdentifier: string }} params
 * @returns {string} 例如 ling-drag0n__CloudPaste
 */
export function buildRepoFolderName({ repoIdentifier }) {
  const { owner, repo } = splitRepoIdentifier(repoIdentifier);
  return `${owner}__${repo}`;
}

/**
 * 时间戳（yyyyMMdd-HHmmss，UTC）
 * @param {Date} [date]
 * @returns {string}
 */
export function buildTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/**
 * 规划一次备份的落盘路径
 *
 * 修改点（备份目录按分支分层）：返回结构里新增 refDirPath（分支目录）与
 * backupDirPath（本次备份专属目录），archive/manifest 都落在 backupDirPath 下。
 *
 * @param {{
 *   mountPath: string,
 *   pathPrefix: string,
 *   provider: string,
 *   repoIdentifier: string,
 *   commitSha: string,
 *   ref?: string|null,
 *   at?: Date,
 * }} params
 * @returns {{
 *   repoDirPath: string,
 *   refDirPath: string,
 *   backupDirPath: string,
 *   archivePath: string,
 *   manifestPath: string,
 *   archiveFileName: string,
 *   manifestFileName: string,
 *   backupDirName: string,
 *   fileBaseName: string,
 *   refSegment: string,
 * }}
 */
export function planBackupPaths({ mountPath, pathPrefix, provider, repoIdentifier, commitSha, ref = null, at = new Date() }) {
  const normalizedMount = normalizeMountPath(mountPath);
  if (!normalizedMount) {
    throw new ValidationError("挂载点路径无效，无法规划备份路径");
  }

  const normalizedPrefix = normalizePathPrefix(pathPrefix);
  const folderName = buildRepoFolderName({ provider, repoIdentifier });
  const { owner, repo } = splitRepoIdentifier(repoIdentifier);

  const shortSha = String(commitSha || "").slice(0, 7) || "unknown";
  // 修改点（备份目录按分支分层）：分支（引用）名既是目录名，也进文件名，
  // 多分支共存时「目录 / 文件名 / manifest 内容」三处都自解释；
  // 引用为空时统一用 default，保证路径里始终有明确的分支段
  const refSegment = sanitizeSegment(ref) || DEFAULT_REF_SEGMENT;

  // 修改点（快照按仓库名命名）：目录名与文件名各司其职 ——
  // 目录名 时间_分支_sha 回答「这是哪一次备份」，文件名 owner__repo__分支__sha
  // 回答「这是哪个仓库的哪个分支」，文件单独拿出去也知道自己是谁的
  const backupDirName = `${buildTimestamp(at)}__${refSegment}__${shortSha}`;
  const fileBaseName = `${owner}__${repo}__${refSegment}__${shortSha}`;

  const archiveFileName = `${fileBaseName}.tar.gz`;
  const manifestFileName = `${fileBaseName}.manifest.json`;

  // 目录路径按 FS 约定以 / 结尾
  const repoDirPath = `${normalizedMount}${normalizedPrefix}/${folderName}/`;
  const refDirPath = `${repoDirPath}${refSegment}/`;
  // 每次备份独占一个目录
  const backupDirPath = `${refDirPath}${backupDirName}/`;

  return {
    repoDirPath,
    refDirPath,
    backupDirPath,
    archivePath: `${backupDirPath}${archiveFileName}`,
    manifestPath: `${backupDirPath}${manifestFileName}`,
    archiveFileName,
    manifestFileName,
    backupDirName,
    fileBaseName,
    refSegment,
  };
}

/**
 * 从落盘文件路径反推「本次备份的专属目录」（修改点：备份目录按分支分层）
 *
 * 用途：版本保留清理删掉快照与 manifest 之后，如果目录还空着就成了垃圾空目录，
 * 尤其是在本地 / WebDAV 这类有真实目录概念的存储上会一直堆着。
 *
 * 判定必须严格：只认目录名本身就是「时间_分支_sha」的父目录
 * （例如 .../main/20261005-155036__main__8a7950d/）。
 * 分层改造之前的老记录，父目录是仓库目录 github__owner__repo，不匹配时间戳形态，
 * 因此这里一律返回 null——老备份的清理行为保持与改造前完全一致，不会误删整个仓库目录。
 *
 * 注意判定只看目录名，不看文件名（修改点：快照按仓库名命名后，两者已经不同名）
 *
 * @param {string|null|undefined} filePath 挂载点内的 FS 路径
 * @returns {string|null} 目录路径（以 / 结尾）；不是本结构时返回 null
 */
export function resolveBackupDirFromFilePath(filePath) {
  const raw = String(filePath || "").trim();
  const lastSlash = raw.lastIndexOf("/");
  // 没有父目录（裸文件名或根本就是根路径）时无处可删
  if (lastSlash <= 0) return null;

  const fileName = raw.slice(lastSlash + 1);
  if (!fileName) return null;

  const dirPath = raw.slice(0, lastSlash + 1);
  const trimmedDir = dirPath.slice(0, -1);
  const dirName = trimmedDir.slice(trimmedDir.lastIndexOf("/") + 1);
  if (!dirName) return null;

  return BACKUP_DIR_NAME_PATTERN.test(dirName) ? dirPath : null;
}
