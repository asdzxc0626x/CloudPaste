/**
 * CodeRepositoryRepository
 * 负责代码仓库备份相关表的持久化访问：
 * - code_repositories：登记的代码仓库
 * - code_repository_backups：备份记录
 *
 * 说明（修改点：新增功能）：
 * - 纯数据访问，不含业务逻辑（加密/权限/Provider 调用都在 service 层）
 * - 所有时间字段统一写 ISO 字符串，与 fs_meta / scheduled_jobs 等表保持一致
 */

import { BaseRepository } from "./BaseRepository.js";
import { DbTables } from "../constants/index.js";

export class CodeRepositoryRepository extends BaseRepository {
  // ==================== code_repositories ====================

  /**
   * 获取仓库列表
   * @param {{ enabledOnly?: boolean }} [options]
   * @returns {Promise<Object[]>}
   */
  async findAllRepositories(options = {}) {
    const { enabledOnly = false } = options || {};
    const sql = enabledOnly
      ? `SELECT * FROM ${DbTables.CODE_REPOSITORIES} WHERE enabled = 1 ORDER BY created_at DESC`
      : `SELECT * FROM ${DbTables.CODE_REPOSITORIES} ORDER BY created_at DESC`;
    const result = await this.query(sql);
    return result.results || [];
  }

  /**
   * 根据 ID 获取仓库
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async findRepositoryById(id) {
    if (!id) return null;
    return await this.findOne(DbTables.CODE_REPOSITORIES, { id });
  }

  /**
   * 按“身份四元组”查找仓库（用于创建前的重复校验）
   * @param {{ provider: string, repoIdentifier: string, trackMode: string, trackRef: (string|null) }} identity
   * @returns {Promise<Object|null>}
   */
  async findRepositoryByIdentity({ provider, repoIdentifier, trackMode, trackRef }) {
    const sql = `
      SELECT * FROM ${DbTables.CODE_REPOSITORIES}
      WHERE provider = ? AND repo_identifier = ? AND track_mode = ? AND COALESCE(track_ref, '') = ?
    `;
    return await this.queryFirst(sql, [provider, repoIdentifier, trackMode, trackRef || ""]);
  }

  /**
   * 统计引用了某挂载点的仓库数量（挂载点删除前的关联检查可用）
   * @param {string} mountId
   * @returns {Promise<number>}
   */
  async countRepositoriesByMount(mountId) {
    if (!mountId) return 0;
    return await this.count(DbTables.CODE_REPOSITORIES, { target_mount_id: mountId });
  }

  /**
   * 创建仓库记录
   * @param {Object} data
   * @returns {Promise<Object>}
   */
  async createRepository(data) {
    const now = new Date().toISOString();
    const record = {
      id: data.id,
      provider: data.provider,
      name: data.name || null,
      repo_identifier: data.repo_identifier,
      track_mode: data.track_mode || "branch",
      track_ref: data.track_ref || null,
      target_mount_id: data.target_mount_id,
      target_path_prefix: data.target_path_prefix || "/",
      enabled: data.enabled === undefined ? 1 : data.enabled ? 1 : 0,
      config_json: data.config_json || "{}",
      created_at: now,
      updated_at: now,
    };
    return await super.create(DbTables.CODE_REPOSITORIES, record);
  }

  /**
   * 更新仓库记录（仅更新显式传入的字段）
   * @param {string} id
   * @param {Object} data
   * @returns {Promise<void>}
   */
  async updateRepository(id, data) {
    const updates = { updated_at: new Date().toISOString() };

    if (data.name !== undefined) updates.name = data.name;
    if (data.repo_identifier !== undefined) updates.repo_identifier = data.repo_identifier;
    if (data.track_mode !== undefined) updates.track_mode = data.track_mode;
    if (data.track_ref !== undefined) updates.track_ref = data.track_ref;
    if (data.target_mount_id !== undefined) updates.target_mount_id = data.target_mount_id;
    if (data.target_path_prefix !== undefined) updates.target_path_prefix = data.target_path_prefix;
    if (data.enabled !== undefined) updates.enabled = data.enabled ? 1 : 0;
    if (data.config_json !== undefined) updates.config_json = data.config_json;
    if (data.last_checked_at !== undefined) updates.last_checked_at = data.last_checked_at;
    if (data.last_backup_at !== undefined) updates.last_backup_at = data.last_backup_at;
    if (data.last_known_commit_sha !== undefined) updates.last_known_commit_sha = data.last_known_commit_sha;
    if (data.last_error !== undefined) updates.last_error = data.last_error;

    await super.update(DbTables.CODE_REPOSITORIES, id, updates);
  }

  /**
   * 删除仓库记录及其全部备份记录
   * - 备份记录是仓库的从属数据，随仓库一起清理
   * - 注意：不会删除已上传到存储的快照文件（用户数据，需显式操作）
   * @param {string} id
   * @returns {Promise<void>}
   */
  async deleteRepository(id) {
    await this.deleteWhere(DbTables.CODE_REPOSITORY_BACKUPS, { repository_id: id });
    await super.delete(DbTables.CODE_REPOSITORIES, id);
  }

  // ==================== code_repository_backups ====================

  /**
   * 分页获取某仓库的备份记录（按创建时间倒序）
   * @param {string} repositoryId
   * @param {{ limit?: number, offset?: number }} [options]
   * @returns {Promise<{ backups: Object[], total: number }>}
   */
  async findBackupsByRepository(repositoryId, options = {}) {
    if (!repositoryId) return { backups: [], total: 0 };

    const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.min(200, Math.trunc(Number(options.limit)))) : 50;
    const offset = Number.isFinite(Number(options.offset)) ? Math.max(0, Math.trunc(Number(options.offset))) : 0;

    const total = await this.count(DbTables.CODE_REPOSITORY_BACKUPS, { repository_id: repositoryId });

    const sql = `
      SELECT * FROM ${DbTables.CODE_REPOSITORY_BACKUPS}
      WHERE repository_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;
    const result = await this.query(sql, [repositoryId, limit, offset]);
    return { backups: result.results || [], total };
  }

  /**
   * 根据 ID 获取备份记录
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async findBackupById(id) {
    if (!id) return null;
    return await this.findOne(DbTables.CODE_REPOSITORY_BACKUPS, { id });
  }

  /**
   * 按 commit 查找备份记录（去重判断的数据来源）
   * @param {string} repositoryId
   * @param {string} commitSha
   * @returns {Promise<Object|null>}
   */
  async findBackupByCommit(repositoryId, commitSha) {
    if (!repositoryId || !commitSha) return null;
    return await this.findOne(DbTables.CODE_REPOSITORY_BACKUPS, {
      repository_id: repositoryId,
      commit_sha: commitSha,
    });
  }

  /**
   * 获取某仓库最近一次的备份记录
   * @param {string} repositoryId
   * @returns {Promise<Object|null>}
   */
  async findLatestBackup(repositoryId) {
    if (!repositoryId) return null;
    const sql = `
      SELECT * FROM ${DbTables.CODE_REPOSITORY_BACKUPS}
      WHERE repository_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return await this.queryFirst(sql, [repositoryId]);
  }

  /**
   * 获取某仓库最近一次成功的备份记录
   * @param {string} repositoryId
   * @returns {Promise<Object|null>}
   */
  async findLatestSuccessBackup(repositoryId) {
    if (!repositoryId) return null;
    const sql = `
      SELECT * FROM ${DbTables.CODE_REPOSITORY_BACKUPS}
      WHERE repository_id = ? AND status = 'success'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return await this.queryFirst(sql, [repositoryId]);
  }

  /**
   * 创建备份记录
   * @param {Object} data
   * @returns {Promise<Object>}
   */
  async createBackup(data) {
    const now = new Date().toISOString();
    const record = {
      id: data.id,
      repository_id: data.repository_id,
      ref_type: data.ref_type || null,
      ref: data.ref || null,
      commit_sha: data.commit_sha,
      version: data.version || null,
      status: data.status || "running",
      storage_path: data.storage_path || null,
      manifest_path: data.manifest_path || null,
      size_bytes: data.size_bytes === undefined ? null : data.size_bytes,
      job_id: data.job_id || null,
      error_message: data.error_message || null,
      started_at: data.started_at || now,
      finished_at: data.finished_at || null,
      created_at: now,
    };
    return await super.create(DbTables.CODE_REPOSITORY_BACKUPS, record);
  }

  /**
   * 更新备份记录（仅更新显式传入的字段）
   * @param {string} id
   * @param {Object} data
   * @returns {Promise<void>}
   */
  async updateBackup(id, data) {
    const updates = {};

    if (data.status !== undefined) updates.status = data.status;
    if (data.storage_path !== undefined) updates.storage_path = data.storage_path;
    if (data.manifest_path !== undefined) updates.manifest_path = data.manifest_path;
    if (data.size_bytes !== undefined) updates.size_bytes = data.size_bytes;
    if (data.job_id !== undefined) updates.job_id = data.job_id;
    if (data.error_message !== undefined) updates.error_message = data.error_message;
    if (data.started_at !== undefined) updates.started_at = data.started_at;
    if (data.finished_at !== undefined) updates.finished_at = data.finished_at;
    if (data.ref_type !== undefined) updates.ref_type = data.ref_type;
    if (data.ref !== undefined) updates.ref = data.ref;
    if (data.version !== undefined) updates.version = data.version;

    if (Object.keys(updates).length === 0) return;

    await super.update(DbTables.CODE_REPOSITORY_BACKUPS, id, updates);
  }

  /**
   * 删除备份记录
   * @param {string} id
   * @returns {Promise<void>}
   */
  async deleteBackup(id) {
    await super.delete(DbTables.CODE_REPOSITORY_BACKUPS, id);
  }
}
