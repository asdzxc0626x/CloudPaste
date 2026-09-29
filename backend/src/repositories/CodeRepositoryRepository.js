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
   * 按“身份三元组”查找仓库（用于创建前的重复校验）
   *
   * 修改点（多分支优化）：原先身份包含单个 track_ref，多分支下一个仓库记录
   * 承载一组分支，因此身份退化为 provider + repo + track_mode，
   * 分支集合的交集校验交给 service 层（它能读到 track_refs_json）。
   *
   * @param {{ provider: string, repoIdentifier: string, trackMode: string }} identity
   * @returns {Promise<Object[]>} 同身份的全部仓库（通常 0 或 1 条）
   */
  async findRepositoriesByIdentity({ provider, repoIdentifier, trackMode }) {
    const sql = `
      SELECT * FROM ${DbTables.CODE_REPOSITORIES}
      WHERE provider = ? AND repo_identifier = ? AND track_mode = ?
    `;
    const result = await this.query(sql, [provider, repoIdentifier, trackMode]);
    return result.results || [];
  }

  /**
   * 统计引用了某挂载点的仓库数量（挂载点删除前的关联检查可用）
   *
   * 修改点（多备份目标优化）：目标可能只出现在 target_mount_ids_json 里，
   * 因此不能只比对 target_mount_id 列，需一并检查 JSON 数组。
   * 用 LIKE 匹配 JSON 中的 "id" 片段（id 由 crypto.randomUUID 生成，不含引号，
   * 不会出现一个 id 是另一个 id 子串的情况）。
   * @param {string} mountId
   * @returns {Promise<number>}
   */
  async countRepositoriesByMount(mountId) {
    if (!mountId) return 0;
    const sql = `
      SELECT COUNT(*) AS count FROM ${DbTables.CODE_REPOSITORIES}
      WHERE target_mount_id = ? OR target_mount_ids_json LIKE ?
    `;
    const row = await this.queryFirst(sql, [mountId, `%"${mountId}"%`]);
    return Number(row?.count) || 0;
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
      // 修改点（多分支优化）：分支数组，NOT NULL DEFAULT '[]'
      track_refs_json: data.track_refs_json || "[]",
      target_mount_id: data.target_mount_id,
      // 修改点（多备份目标优化）：目标挂载点数组
      target_mount_ids_json: data.target_mount_ids_json || "[]",
      target_path_prefix: data.target_path_prefix || "/",
      // 修改点（版本保留优化）：默认保留 10 个版本
      retention_count: data.retention_count === undefined ? 10 : data.retention_count,
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
    // 修改点（多分支 / 多备份目标 / 版本保留优化）
    if (data.track_refs_json !== undefined) updates.track_refs_json = data.track_refs_json;
    if (data.target_mount_id !== undefined) updates.target_mount_id = data.target_mount_id;
    if (data.target_mount_ids_json !== undefined) updates.target_mount_ids_json = data.target_mount_ids_json;
    if (data.retention_count !== undefined) updates.retention_count = data.retention_count;
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
    // 修改点（多备份目标优化）：先清理目标结果（它依赖 backup_id），再清理备份记录
    const backupIds = await this.findBackupIdsByRepository(id);
    for (const backupId of backupIds) {
      await this.deleteBackupTargetsByBackup(backupId);
    }
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

  /**
   * 取某仓库的全部备份记录 ID（删除仓库时用于级联清理目标结果）
   * @param {string} repositoryId
   * @returns {Promise<string[]>}
   */
  async findBackupIdsByRepository(repositoryId) {
    if (!repositoryId) return [];
    const sql = `SELECT id FROM ${DbTables.CODE_REPOSITORY_BACKUPS} WHERE repository_id = ?`;
    const result = await this.query(sql, [repositoryId]);
    return (result.results || []).map((row) => row.id).filter(Boolean);
  }

  /**
   * 找出超出保留数量、需要清理的最旧成功备份
   *
   * 修改点（版本保留优化）
   * - 只统计 status 为 success/partial 的记录：失败/跳过的记录不占用保留额度
   *   （partial 同样在部分目标上真实存在快照文件，必须计入额度）
   * - 按 created_at 倒序跳过最新 keepCount 条，其余即待删除
   *
   * @param {string} repositoryId
   * @param {number} keepCount 需要保留的版本数
   * @returns {Promise<Object[]>} 待删除的备份记录（由旧到新）
   */
  async findSuccessBackupsBeyondLimit(repositoryId, keepCount) {
    if (!repositoryId) return [];
    const keep = Number.isFinite(Number(keepCount)) ? Math.max(0, Math.trunc(Number(keepCount))) : 0;
    if (keep <= 0) {
      // 保留 0 个视为“不保留任何版本”，这里按不安全处理，交给上层做下限约束
      return [];
    }

    const sql = `
      SELECT * FROM ${DbTables.CODE_REPOSITORY_BACKUPS}
      WHERE repository_id = ? AND status IN ('success', 'partial')
      ORDER BY created_at DESC
      LIMIT -1 OFFSET ?
    `;
    const result = await this.query(sql, [repositoryId, keep]);
    const rows = result.results || [];
    // 由旧到新删除，便于日志阅读
    return rows.reverse();
  }

  // ==================== code_repository_backup_targets ====================

  /**
   * 写入/覆盖某备份在某挂载点上的结果（修改点：多备份目标优化）
   * - (backup_id, mount_id) 上有唯一索引，重跑同一备份时按此 upsert
   * @param {Object} data
   * @returns {Promise<void>}
   */
  async upsertBackupTarget(data) {
    const now = new Date().toISOString();
    const sql = `
      INSERT INTO ${DbTables.CODE_REPOSITORY_BACKUP_TARGETS}
        (id, backup_id, mount_id, mount_path, storage_path, manifest_path, size_bytes, status, error_message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(backup_id, mount_id) DO UPDATE SET
        mount_path = excluded.mount_path,
        storage_path = excluded.storage_path,
        manifest_path = excluded.manifest_path,
        size_bytes = excluded.size_bytes,
        status = excluded.status,
        error_message = excluded.error_message,
        created_at = excluded.created_at
    `;
    await this.execute(sql, [
      data.id,
      data.backup_id,
      data.mount_id,
      data.mount_path || null,
      data.storage_path || null,
      data.manifest_path || null,
      data.size_bytes === undefined ? null : data.size_bytes,
      data.status,
      data.error_message || null,
      now,
    ]);
  }

  /**
   * 清理某备份的全部目标结果（重跑前重置）
   * @param {string} backupId
   * @returns {Promise<void>}
   */
  async deleteBackupTargetsByBackup(backupId) {
    if (!backupId) return;
    await this.deleteWhere(DbTables.CODE_REPOSITORY_BACKUP_TARGETS, { backup_id: backupId });
  }

  /**
   * 取某备份的全部目标结果
   * @param {string} backupId
   * @returns {Promise<Object[]>}
   */
  async findTargetsByBackup(backupId) {
    if (!backupId) return [];
    const sql = `SELECT * FROM ${DbTables.CODE_REPOSITORY_BACKUP_TARGETS} WHERE backup_id = ?`;
    const result = await this.query(sql, [backupId]);
    return result.results || [];
  }

  /**
   * 批量取多个备份的目标结果（避免列表接口 N+1）
   * @param {string[]} backupIds
   * @returns {Promise<Map<string, Object[]>>}
   */
  async findTargetsByBackups(backupIds) {
    const map = new Map();
    const ids = (backupIds || []).filter(Boolean);
    if (ids.length === 0) return map;

    const placeholders = ids.map(() => "?").join(", ");
    const sql = `SELECT * FROM ${DbTables.CODE_REPOSITORY_BACKUP_TARGETS} WHERE backup_id IN (${placeholders})`;
    const result = await this.query(sql, ids);
    for (const row of result.results || []) {
      const key = String(row.backup_id);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
    return map;
  }
}
