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
 * @typedef {'running' | 'success' | 'partial' | 'failed' | 'skipped'} BackupStatus
 * partial = 部分备份目标写入成功（多目标时可能出现）
 */

/**
 * @typedef {Object} RepoTargetResult
 * @property {string} id
 * @property {string} mountId
 * @property {string|null} mountPath
 * @property {string|null} storagePath
 * @property {string|null} manifestPath
 * @property {number|null} sizeBytes
 * @property {'success'|'failed'|'skipped'} status
 * @property {string|null} errorMessage
 */

/**
 * @typedef {Object} RepoProviderMeta
 * @property {string} provider - provider 标识，如 'github'
 * @property {string} displayName - 展示名
 * @property {TrackMode[]} trackModes - 支持的跟踪模式
 * @property {Object|null} configSchema - 动态表单 schema
 * @property {Object|null} ui - UI 元数据（图标 / i18nKey）
 * @property {string} [defaultPathPrefix] - 该仓库源的默认备份目录
 *   （修改点：备份默认目录按仓库源区分），如 GitHub 为 "/GitHub"；缺失时按根目录 "/" 处理
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
 * @typedef {Object} RepoSchedule
 * 仓库的独立备份计划（后端落在 scheduled_jobs 表，一个仓库一行）
 * @property {string} taskId - 调度作业 ID（`repo_backup_<仓库ID>`）
 * @property {boolean} enabled - 是否启用定时备份
 * @property {'interval'|'cron'} scheduleType - 调度方式（修改点：备份计划支持 cron）
 * @property {number} intervalSec - 备份间隔（秒），interval 模式有效，默认 21600（6 小时）
 * @property {string|null} cronExpression - cron 表达式（5 段），cron 模式有效
 * @property {number|null} estimatedIntervalSec - cron 模式下由表达式推导的相邻间隔，仅供展示
 * @property {string|null} nextRunAfter - 下次执行时间
 * @property {string|null} lastRunStatus - 'success' | 'failure' | 'skipped' | null
 * @property {string|null} lastRunFinishedAt
 * @property {number} runCount
 * @property {number} failureCount
 * @property {string} runtimeState - 'disabled'|'scheduled'|'pending'|'running'|'idle'
 */

/**
 * @typedef {Object} CodeRepository
 * @property {string} id
 * @property {string} provider
 * @property {string} providerDisplayName
 * @property {string} name
 * @property {string} repoIdentifier - 'owner/repo'
 * @property {string|null} repoWebUrl - 仓库网页地址（修改点：点击 owner/repo 跳转仓库）；
 *   为 null 表示推导不出，前端按纯文本展示
 * @property {TrackMode} trackMode
 * @property {string[]} trackRefs - 跟踪引用列表（branch 模式=多个分支；release 模式=单元素）
 * @property {string|null} trackRef - 主引用（兼容字段）
 * @property {string[]} targetMountIds - 备份目标挂载点 ID 列表
 * @property {string|null} targetMountId - 第一个目标（兼容字段）
 * @property {string} targetPathPrefix - 挂载点内的存放目录；新建时默认取该仓库源的
 *   defaultPathPrefix（修改点：备份默认目录按仓库源区分），可由用户改成任意目录
 * @property {number} retentionCount - 保留版本数
 * @property {boolean} enabled
 * @property {string|null} lastCheckedAt
 * @property {string|null} lastBackupAt
 * @property {string|null} lastKnownCommitSha
 * @property {string|null} lastError
 * @property {Object} [config] - provider 配置（敏感字段已掩码）
 * @property {RepoTargetMount|null} [targetMount]
 * @property {RepoTargetMount[]} [targetMounts]
 * @property {string[]} [missingMountIds] - 已被删除的挂载点 ID
 * @property {string|null} [backupFolder] - 备份文件所在目录（可跳转挂载浏览器）
 * @property {RepoSchedule|null} [schedule] - 独立备份计划，null 表示未配置
 * @property {RepoBackup|null} [latestBackup]
 * @property {RepositoryState} [state] - 仓库级合并结论（主徽章用）
 * @property {DetectState} [detectState] - 检测维度（修改点：第 5 期 状态展示）
 * @property {BackupState} [backupState] - 备份维度（修改点：第 5 期 状态展示）
 * @property {ScheduleState} [scheduleState] - 调度维度，来源是 scheduled_jobs（修改点：第 5 期 状态展示）
 * @property {Object[]} [detectStates] - 逐引用检测状态
 * @property {number} [activeJobCount] - 未结束的作业总数（检测 + 备份）
 * @property {number} [activeCheckCount] - 未结束的检测作业数
 * @property {number} [activeBackupCount] - 未结束的备份作业数
 */

/**
 * 仓库级合并结论（主徽章用，修改点：第 5 期 前端状态展示）
 * 检测 / 备份 / 调度的细节分别在 detectState / backupState / scheduleState 里
 * @typedef {Object} RepositoryState
 * @property {'pending'|'running'|'success'|'partial'|'up_to_date'|'update_available'|'deferred'|'blocked'|'failed'|'detecting'} outcome
 * @property {'ok'|'info'|'warn'|'error'|'muted'} tone
 * @property {string|null} message
 * @property {string|null} retryAt
 * @property {string|null} at
 */

/**
 * 检测维度（修改点：第 5 期 前端状态展示）
 * @typedef {Object} DetectState
 * @property {'pending'|'detecting'|'up_to_date'|'update_available'|'deferred'|'failed'} status
 * @property {'ok'|'info'|'warn'|'error'|'muted'} tone
 * @property {string|null} message
 * @property {string|null} ref
 * @property {string|null} retryAt
 * @property {string|null} nextDetectAfter
 * @property {number} updatedRefCount
 * @property {number} trackedRefCount
 */

/**
 * 备份维度（修改点：第 5 期 前端状态展示）
 * @typedef {Object} BackupState
 * @property {'pending'|'running'|'success'|'partial'|'skipped'|'deferred'|'failed'} status
 * @property {'ok'|'info'|'warn'|'error'|'muted'} tone
 * @property {string|null} message
 * @property {string|null} at
 * @property {string|null} ref
 * @property {string|null} version
 * @property {string|null} commitSha
 */

/**
 * 调度维度（修改点：第 5 期 前端状态展示）
 * 唯一来源是 scheduled_jobs，不用备份历史记录冒充
 * @typedef {Object} ScheduleState
 * @property {'none'|'disabled'|'waiting'|'failed'} status
 * @property {'ok'|'info'|'warn'|'error'|'muted'} tone
 * @property {string|null} nextRunAfter
 * @property {string|null} lastRunStatus
 * @property {string|null} lastRunFinishedAt
 * @property {string|null} runtimeState
 * @property {boolean} enabled
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
 * @property {RepoTargetResult[]} [targets] - 每个备份目标的落盘结果
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
 * @typedef {Object} CheckRefResult
 * @property {string|null} ref - 分支名或 tag
 * @property {'branch'|'tag'} refType
 * @property {string|null} commitSha
 * @property {string|null} shortCommitSha
 * @property {string|null} version
 * @property {string|null} publishedAt
 * @property {boolean} hasUpdate - 该分支是否有尚未备份的新版本
 * @property {boolean} alreadyBackedUp
 * @property {string|null} error - 该分支检查失败的原因
 */

/**
 * @typedef {Object} CheckResult
 * @property {string} repositoryId
 * @property {boolean} hasUpdate - 任一分支有更新即为 true
 * @property {boolean} allFailed
 * @property {number} checkedCount
 * @property {number} successCount
 * @property {number} failedCount
 * @property {CheckRefResult[]} refs - 逐分支的检查结果
 * @property {CheckRefResult|null} latest
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
 * @param {{ reveal?: 'plain' }} [options] 修改点（第 3 期 3-B）：
 *        reveal='plain' 时后端会连凭据池的明文一起返回（仅管理员，后端有审计日志）。
 *        默认不带该参数，凭据一律是掩码。
 * @returns {Promise<{success: boolean, data: CodeRepository, message: string}>}
 */
export function getRepository(id, options = {}) {
  const query = options?.reveal === "plain" ? "?reveal=plain" : "";
  return get(`${BASE}/repositories/${encodeURIComponent(id)}${query}`);
}

/**
 * 添加仓库
 * @param {Object} payload
 * @param {string} payload.provider
 * @param {string} payload.repoIdentifier
 * @param {TrackMode} payload.trackMode
 * @param {string[]} [payload.trackRefs] - branch 模式：要跟踪的分支列表
 * @param {string|null} [payload.trackRef] - release 模式：指定 tag（空=最新）
 * @param {string[]} payload.targetMountIds - 备份目标挂载点 ID 列表（至少一个）
 * @param {string} [payload.targetPathPrefix]
 * @param {number} [payload.retentionCount] - 保留版本数，默认 10
 * @param {boolean} [payload.scheduleEnabled] - 是否启用定时备份，默认 true
 * @param {'interval'|'cron'} [payload.scheduleType] - 调度方式，默认 interval
 * @param {number} [payload.scheduleIntervalSec] - 备份间隔（秒），interval 模式用，默认 21600
 * @param {string} [payload.scheduleCron] - cron 表达式（5 段），cron 模式用
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
 *
 * 修改点（历史记录需显示失败记录）：
 * - statuses 为空时返回全部状态（含 failed / running / skipped），不再只有成功记录
 * - 返回值新增 statusCounts，用于在筛选器上显示每种状态的条数
 *
 * @param {string} id
 * @param {{limit?: number, offset?: number, statuses?: string[]}} [paging]
 * @returns {Promise<{success: boolean, data: {items: RepoBackup[], total: number, statuses: string[], statusCounts: Record<string, number>, limit: number, offset: number}, message: string}>}
 */
export function listBackups(id, paging = {}) {
  const params = new URLSearchParams();
  if (paging.limit != null) params.set("limit", String(paging.limit));
  if (paging.offset != null) params.set("offset", String(paging.offset));
  if (Array.isArray(paging.statuses) && paging.statuses.length > 0) {
    params.set("status", paging.statuses.join(","));
  }
  const query = params.toString();
  return get(`${BASE}/repositories/${encodeURIComponent(id)}/backups${query ? `?${query}` : ""}`);
}

/**
 * 获取备份快照的下载链接
 * @param {string} backupId
 * @param {{manifest?: boolean, targetId?: string}} [options]
 *   - manifest=true 时返回 manifest.json 的链接
 *   - targetId 指定从哪个目标的副本下载（修改点：多备份目标优化）
 * @returns {Promise<{success: boolean, data: {backupId: string, path: string, url: string, type: string, targetId: string|null, mountId: string|null}, message: string}>}
 */
export function getBackupDownloadLink(backupId, options = {}) {
  const params = new URLSearchParams();
  if (options.manifest === true) params.set("manifest", "true");
  if (options.targetId) params.set("targetId", String(options.targetId));
  const query = params.toString();
  return get(`${BASE}/backups/${encodeURIComponent(backupId)}/link${query ? `?${query}` : ""}`);
}

/******************************************************************************
 * 全局 GitHub 凭据池（修改点：第 3 期 3-B）
 ******************************************************************************/

/**
 * 获取全局 Token / 代理池
 * @param {{ reveal?: 'plain' }} [options] reveal='plain' 时返回明文（仅管理员，后端有审计日志）
 * @returns {Promise<{success: boolean, data: {tokens: CredentialEntry[], proxies: CredentialEntry[]}, message: string}>}
 */
export function getGlobalCredentials(options = {}) {
  const query = options?.reveal === "plain" ? "?reveal=plain" : "";
  return get(`${BASE}/credentials${query}`);
}

/**
 * 保存全局 Token / 代理池（整体保存）
 * - 未改动的条目可以把掩码原样回传，后端会还原成原值
 * @param {{tokens: CredentialEntry[], proxies: CredentialEntry[]}} pool
 * @returns {Promise<{success: boolean, data: {tokens: CredentialEntry[], proxies: CredentialEntry[]}, message: string}>}
 */
export function saveGlobalCredentials(pool) {
  return put(`${BASE}/credentials`, pool);
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
  getGlobalCredentials,
  saveGlobalCredentials,
};
