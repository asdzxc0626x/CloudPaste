/**
 * 代码仓库备份 - 路径规划
 *
 * 修改点：新增功能
 *
 * 职责：把「挂载点 + 前缀 + 仓库 + 版本」映射为确定的 FS 路径。
 * 单独抽出来的原因：任务层要写入、服务层要生成下载链接，两边必须用同一套规则。
 *
 * 产出形态（与用户确认的方案一致）：
 *   /{mountPath}/{prefix}/{provider}__{owner}__{repo}/{yyyyMMdd-HHmmss}__{sha7}.tar.gz
 *   /{mountPath}/{prefix}/{provider}__{owner}__{repo}/{yyyyMMdd-HHmmss}__{sha7}.manifest.json
 */

import { ValidationError } from "../http/errors.js";

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
 * 仓库在挂载点内的专属目录名
 * @param {{ provider: string, repoIdentifier: string }} params
 * @returns {string} 例如 github__ling-drag0n__CloudPaste
 */
export function buildRepoFolderName({ provider, repoIdentifier }) {
  const segments = String(repoIdentifier || "")
    .split("/")
    .filter(Boolean);
  const owner = sanitizeSegment(segments[0] || "unknown");
  const repo = sanitizeSegment(segments[1] || "unknown");
  return `${sanitizeSegment(provider) || "unknown"}__${owner}__${repo}`;
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
 *   archivePath: string,
 *   manifestPath: string,
 *   archiveFileName: string,
 *   manifestFileName: string,
 *   baseName: string,
 * }}
 */
export function planBackupPaths({ mountPath, pathPrefix, provider, repoIdentifier, commitSha, ref = null, at = new Date() }) {
  const normalizedMount = normalizeMountPath(mountPath);
  if (!normalizedMount) {
    throw new ValidationError("挂载点路径无效，无法规划备份路径");
  }

  const normalizedPrefix = normalizePathPrefix(pathPrefix);
  const folderName = buildRepoFolderName({ provider, repoIdentifier });

  const shortSha = String(commitSha || "").slice(0, 7) || "unknown";
  // 修改点（多分支优化）：文件名里带上引用名，多分支共存时目录一眼可读
  const refSegment = ref ? `${sanitizeSegment(ref)}__` : "";
  const baseName = `${buildTimestamp(at)}__${refSegment}${shortSha}`;

  const archiveFileName = `${baseName}.tar.gz`;
  const manifestFileName = `${baseName}.manifest.json`;

  // 目录路径按 FS 约定以 / 结尾
  const repoDirPath = `${normalizedMount}${normalizedPrefix}/${folderName}/`;

  return {
    repoDirPath,
    archivePath: `${repoDirPath}${archiveFileName}`,
    manifestPath: `${repoDirPath}${manifestFileName}`,
    archiveFileName,
    manifestFileName,
    baseName,
  };
}
