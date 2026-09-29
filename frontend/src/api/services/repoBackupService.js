/**
 * 代码仓库备份 API 服务（修改点：新增功能）
 *
 * 说明：
 * - 纯 HTTP 层，不含业务语义，与 api/services 下其它文件保持一致
 * - 所有接口均为管理员接口（后端 usePolicy("admin.all")）
 */

import { get, post, put, del } from "../client";

/******************************************************************************
 * 类型定义 (JSDoc)
 ******************************************************************************/

/**
 * @typedef {'branch' | 'release'} TrackMode
 * 版本跟踪模式：branch=跟踪分支最新 commit；release=跟踪最新 Release/Tag
 */

/**
 * @typedef {'running' | 'success' | 'failed' | 'skipped'} BackupStatus
 */

/**
 * @typedef {Object} RepoProviderMeta
 * @property {string} provider - provider 标识，如 'github'
 * @property {string} displayName - 展示名
 * @property {TrackMode[]} trackModes - 支持的跟踪模式
 * @property {Object|null} configSchema - 动态表单 schema
 * @property {Object|null} ui - UI 元数据（图标 / i18nKey）
 */

/**
 * @typedef {Object} RepoTargetMount
 * @property {string} id
 * @property {string|null} name
 * @property {string} mountPath
 * @property {string|null} storageType
 * @property {boolean} isActive
 */

/**
 * @typedef {Object} CodeRepository
 * @property {string} id
 * @property {string} provider
 * @property {string} providerDisplayName
 * @property {string} name
 * @property {string} repoIdentifier - 'owner/repo'
 * @property {TrackMode} trackMode
 * @property {string|null} trackRef
 * @property {string} targetMountId
 * @property {string} targetPathPrefix
 * @property {boolean} enabled
 * @property {string|null} lastCheckedAt
 * @property {string|null} lastBackupAt
 * @property {string|null} lastKnownCommitSha
 * @property {string|null} lastError
 * @property {Object} [config] - provider 配置（敏感字段已掩码）
 * @property {RepoTargetMount|null} [targetMount]
 * @property {string|null} [backupFolder] - 备份文件所在目录（可跳转挂载浏览器）
 * @property {RepoBackup|null} [latestBackup]
 */

/**
 * @typedef {Object} RepoBackup
 * @property {string} id
 * @property {string} repositoryId
 * @property {'branch'|'tag'|null} refType
 * @property {string|null} ref
 * @property {string} commitSha
 * @property {string} shortCommitSha
 * @property {string|null} version
 * @property {BackupStatus} status
 * @property {string|null} storagePath
 * @property {string|null} manifestPath
 * @property {number|null} sizeBytes
 * @property {string|null} jobId
 * @property {string|null} errorMessage
 * @property {string|null} startedAt
 * @property {string|null} finishedAt
 * @property {string} createdAt
 */

/**
 * @typedef {Object} RepoVersionInfo
 * @property {'branch'|'tag'} refType
 * @property {string} ref
 * @property {string} commitSha
 * @property {string} version
 * @property {string|null} publishedAt
 */

/**
 * @typedef {Object} CheckResult
 * @property {string} repositoryId
 * @property {boolean} hasUpdate - 是否存在尚未备份的新版本
 * @property {boolean} alreadyBackedUp - 最新版本是否已备份
 * @property {RepoVersionInfo} latest
 * @property {string|null} lastKnownCommitSha
 * @property {RepoBackup|null} lastBackup
 */

// 注意：endpoint 不带 /api 前缀——client 的 getFullApiUrl 会统一拼上 API_PREFIX，
// 与 fsIndexService（"/admin/fs/index/status"）等既有 service 保持一致
const BASE = "/admin/repo-backup";

/******************************************************************************
 * Provider 元数据
 ******************************************************************************/

/**
 * 获取支持的代码仓库类型及其配置 schema
 * @returns {Promise<{success: boolean, data: RepoProviderMeta[], message: string}>}
 */
export function getProviders() {
  return get(`${BASE}/providers`);
}

/******************************************************************************
 * 仓库 CRUD
 ******************************************************************************/

/**
 * 获取仓库列表
 * @returns {Promise<{success: boolean, data: CodeRepository[], message: string}>}
 */
export function listRepositories() {
  return get(`${BASE}/repositories`);
}

/**
 * 获取单个仓库
 * @param {string} id
 * @returns {Promise<{success: boolean, data: CodeRepository, message: string}>}
 */
export function getRepository(id) {
  return get(`${BASE}/repositories/${encodeURIComponent(id)}`);
}

/**
 * 添加仓库
 * @param {Object} payload
 * @param {string} payload.provider
 * @param {string} payload.repoIdentifier
 * @param {TrackMode} payload.trackMode
 * @param {string|null} [payload.trackRef]
 * @param {string} payload.targetMountId
 * @param {string} [payload.targetPathPrefix]
 * @param {string} [payload.name]
 * @param {boolean} [payload.enabled]
 * @param {Object} [payload.config]
 * @returns {Promise<{success: boolean, data: CodeRepository, message: string}>}
 */
export function createRepository(payload) {
  return post(`${BASE}/repositories`, payload);
}

/**
 * 更新仓库
 * @param {string} id
 * @param {Object} payload
 * @returns {Promise<{success: boolean, data: CodeRepository, message: string}>}
 */
export function updateRepository(id, payload) {
  return put(`${BASE}/repositories/${encodeURIComponent(id)}`, payload);
}

/**
 * 删除仓库（已上传的备份文件保留）
 * @param {string} id
 * @returns {Promise<{success: boolean, data: {id: string}, message: string}>}
 */
export function deleteRepository(id) {
  return del(`${BASE}/repositories/${encodeURIComponent(id)}`);
}

/**
 * 启用 / 禁用仓库
 * @param {string} id
 * @param {boolean} enabled
 * @returns {Promise<{success: boolean, data: {id: string, enabled: boolean}, message: string}>}
 */
export function setRepositoryEnabled(id, enabled) {
  return post(`${BASE}/repositories/${encodeURIComponent(id)}/enable`, { enabled });
}

/******************************************************************************
 * 检查更新 / 手动备份
 ******************************************************************************/

/**
 * 检查仓库是否有更新（同步，只查版本不下载）
 * @param {string} id
 * @returns {Promise<{success: boolean, data: CheckResult, message: string}>}
 */
export function checkRepository(id) {
  return post(`${BASE}/repositories/${encodeURIComponent(id)}/check`, {});
}

/**
 * 触发一次备份（创建异步作业）
 * @param {string} id
 * @param {{force?: boolean}} [options] force=true 时忽略去重强制重新备份
 * @returns {Promise<{success: boolean, data: {jobId: string, taskType: string, repositoryId: string, force: boolean}, message: string}>}
 */
export function triggerBackup(id, options = {}) {
  return post(`${BASE}/repositories/${encodeURIComponent(id)}/backup`, {
    force: options.force === true,
  });
}

/******************************************************************************
 * 备份记录
 ******************************************************************************/

/**
 * 获取某仓库的备份记录（分页）
 * @param {string} id
 * @param {{limit?: number, offset?: number}} [paging]
 * @returns {Promise<{success: boolean, data: {items: RepoBackup[], total: number, limit: number, offset: number}, message: string}>}
 */
export function listBackups(id, paging = {}) {
  const params = new URLSearchParams();
  if (paging.limit != null) params.set("limit", String(paging.limit));
  if (paging.offset != null) params.set("offset", String(paging.offset));
  const query = params.toString();
  return get(`${BASE}/repositories/${encodeURIComponent(id)}/backups${query ? `?${query}` : ""}`);
}

/**
 * 获取备份快照的下载链接
 * @param {string} backupId
 * @param {{manifest?: boolean}} [options] manifest=true 时返回 manifest.json 的链接
 * @returns {Promise<{success: boolean, data: {backupId: string, path: string, url: string, type: string}, message: string}>}
 */
export function getBackupDownloadLink(backupId, options = {}) {
  const query = options.manifest === true ? "?manifest=true" : "";
  return get(`${BASE}/backups/${encodeURIComponent(backupId)}/link${query}`);
}

export default {
  getProviders,
  listRepositories,
  getRepository,
  createRepository,
  updateRepository,
  deleteRepository,
  setRepositoryEnabled,
  checkRepository,
  triggerBackup,
  listBackups,
  getBackupDownloadLink,
};
