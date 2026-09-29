/**
 * 代码仓库备份服务（修改点：新增功能）
 *
 * 职责：
 * - 仓库的增删改查与启用/禁用
 * - 检查仓库是否有更新（只查版本，不触发上传）
 * - 备份记录查询与下载链接生成
 *
 * 边界：
 * - 真正的「下载源码 + 上传到挂载点」由 RepoBackupTaskHandler 在任务里执行，
 *   本服务只负责创建任务，避免在 HTTP 请求生命周期里做重活
 */

import { UserType } from "../constants/index.js";
import { ValidationError, NotFoundError, ConflictError } from "../http/errors.js";
import { ensureRepositoryFactory } from "../utils/repositories.js";
import { StorageFactory } from "../storage/factory/StorageFactory.js";
import { CAPABILITIES } from "../storage/interfaces/capabilities/index.js";
import { RepoProviderFactory } from "../repobackup/providers/index.js";
import {
  parseProviderConfig,
  serializeProviderConfig,
  buildProviderConfigView,
  mergeProviderConfig,
} from "../repobackup/config.js";
import { normalizePathPrefix, buildRepoFolderName } from "../repobackup/paths.js";

/**
 * 生成主键
 * @param {string} prefix
 * @returns {string}
 */
function generateId(prefix) {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${prefix}_${crypto.randomUUID()}`;
    }
  } catch {
    // ignore
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 规范化 owner/repo 标识（同时兼容完整 URL）
 * @param {string} raw
 * @returns {string}
 */
function normalizeRepoIdentifier(raw) {
  let text = String(raw || "").trim();
  if (!text) {
    throw new ValidationError("仓库标识不能为空，格式应为 owner/repo");
  }
  text = text.replace(/^https?:\/\/(www\.)?[^/]+\//i, "");
  text = text.replace(/\.git$/i, "");
  const segments = text.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new ValidationError(`仓库标识格式无效: ${raw}，应为 owner/repo`);
  }
  return `${segments[0]}/${segments[1]}`;
}

/**
 * 校验目标挂载点：存在、启用、且驱动具备写入能力
 * - 只读驱动（GITHUB_RELEASES / MIRROR）在这里被挡下，
 *   而不是等到备份任务跑一半才失败
 * @param {object} mountRepository
 * @param {string} mountId
 * @returns {Promise<object>} 挂载点记录
 */
async function assertWritableMount(mountRepository, mountId) {
  if (!mountId) {
    throw new ValidationError("必须选择备份目标挂载点");
  }

  const mount = await mountRepository.findById(mountId);
  if (!mount) {
    throw new NotFoundError(`挂载点不存在: ${mountId}`);
  }
  if (mount.is_active === 0) {
    throw new ValidationError(`挂载点已禁用: ${mount.name || mount.mount_path}`);
  }

  const capabilities = StorageFactory.getRegisteredCapabilities(mount.storage_type) || [];
  if (!capabilities.includes(CAPABILITIES.WRITER)) {
    const displayName = StorageFactory.getTypeDisplayName(mount.storage_type);
    throw new ValidationError(
      `挂载点「${mount.name || mount.mount_path}」使用的存储类型 ${displayName} 是只读的，不能作为备份目标，请选择支持写入的挂载点`,
    );
  }

  return mount;
}

/**
 * 把数据库行转换为 API 返回结构
 * @param {object} row
 * @param {object} [extra]
 */
function toRepositoryDto(row, extra = {}) {
  return {
    id: row.id,
    provider: row.provider,
    providerDisplayName: RepoProviderFactory.getDisplayName(row.provider),
    name: row.name || row.repo_identifier,
    repoIdentifier: row.repo_identifier,
    trackMode: row.track_mode,
    trackRef: row.track_ref ?? null,
    targetMountId: row.target_mount_id,
    targetPathPrefix: row.target_path_prefix || "/",
    enabled: row.enabled === 1 || row.enabled === true,
    lastCheckedAt: row.last_checked_at ?? null,
    lastBackupAt: row.last_backup_at ?? null,
    lastKnownCommitSha: row.last_known_commit_sha ?? null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extra,
  };
}

/**
 * 把备份记录行转换为 API 返回结构
 * @param {object} row
 */
function toBackupDto(row) {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    refType: row.ref_type ?? null,
    ref: row.ref ?? null,
    commitSha: row.commit_sha,
    shortCommitSha: String(row.commit_sha || "").slice(0, 7),
    version: row.version ?? null,
    status: row.status,
    storagePath: row.storage_path ?? null,
    manifestPath: row.manifest_path ?? null,
    sizeBytes: row.size_bytes ?? null,
    jobId: row.job_id ?? null,
    errorMessage: row.error_message ?? null,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    createdAt: row.created_at,
  };
}

// ==================== Provider 元数据 ====================

/**
 * 获取全部 provider 元数据（驱动前端动态表单）
 */
export function getProviderMetadata() {
  return RepoProviderFactory.getAllTypeMetadata();
}

// ==================== 仓库 CRUD ====================

/**
 * 获取仓库列表
 * @param {D1Database} db
 * @param {object} repositoryFactory
 * @param {string} encryptionSecret
 * @param {object} [env]
 */
export async function listRepositories(db, repositoryFactory, encryptionSecret, env = {}) {
  const factory = ensureRepositoryFactory(db, repositoryFactory, env);
  const codeRepo = factory.getCodeRepositoryRepository();
  const mountRepository = factory.getMountRepository();

  const rows = await codeRepo.findAllRepositories();
  if (rows.length === 0) return [];

  // 一次性取出挂载点，避免 N+1 查询
  const mounts = await mountRepository.findAll(true);
  const mountMap = new Map(mounts.map((m) => [String(m.id), m]));

  const result = [];
  for (const row of rows) {
    const mount = mountMap.get(String(row.target_mount_id)) || null;
    const latestBackup = await codeRepo.findLatestBackup(row.id);

    result.push(
      toRepositoryDto(row, {
        config: await buildProviderConfigView(row.provider, row.config_json, encryptionSecret),
        targetMount: mount
          ? {
              id: mount.id,
              name: mount.name ?? null,
              mountPath: mount.mount_path,
              storageType: mount.storage_type ?? null,
              isActive: mount.is_active === 1,
            }
          : null,
        // 备份文件所在目录，便于管理端跳转到挂载浏览器查看
        backupFolder: mount
          ? `${String(mount.mount_path).replace(/\/+$/, "")}${normalizePathPrefix(row.target_path_prefix)}/${buildRepoFolderName({
              provider: row.provider,
              repoIdentifier: row.repo_identifier,
            })}/`
          : null,
        latestBackup: latestBackup ? toBackupDto(latestBackup) : null,
      }),
    );
  }

  return result;
}

/**
 * 获取单个仓库
 */
export async function getRepository(db, repositoryFactory, encryptionSecret, id, env = {}) {
  const factory = ensureRepositoryFactory(db, repositoryFactory, env);
  const codeRepo = factory.getCodeRepositoryRepository();

  const row = await codeRepo.findRepositoryById(id);
  if (!row) {
    throw new NotFoundError(`代码仓库不存在: ${id}`);
  }

  return toRepositoryDto(row, {
    config: await buildProviderConfigView(row.provider, row.config_json, encryptionSecret),
    latestBackup: await codeRepo
      .findLatestBackup(row.id)
      .then((b) => (b ? toBackupDto(b) : null)),
  });
}

/**
 * 创建仓库
 * @param {D1Database} db
 * @param {object} repositoryFactory
 * @param {string} encryptionSecret
 * @param {object} body
 * @param {object} [env]
 */
export async function createRepository(db, repositoryFactory, encryptionSecret, body, env = {}) {
  const factory = ensureRepositoryFactory(db, repositoryFactory, env);
  const codeRepo = factory.getCodeRepositoryRepository();
  const mountRepository = factory.getMountRepository();

  const provider = String(body?.provider || "github").trim().toLowerCase();
  if (!RepoProviderFactory.isTypeSupported(provider)) {
    throw new ValidationError(`不支持的代码仓库类型: ${provider}`);
  }

  const repoIdentifier = normalizeRepoIdentifier(body?.repoIdentifier ?? body?.repo_identifier);
  const trackMode = String(body?.trackMode ?? body?.track_mode ?? "branch").trim();
  const trackRefRaw = body?.trackRef ?? body?.track_ref ?? null;
  const trackRef = trackRefRaw === null || trackRefRaw === undefined ? null : String(trackRefRaw).trim() || null;

  const incomingConfig = body?.config && typeof body.config === "object" ? body.config : {};

  const validation = RepoProviderFactory.validateConfig(provider, {
    repoIdentifier,
    trackMode,
    trackRef,
    config: incomingConfig,
  });
  if (!validation.valid) {
    throw new ValidationError(validation.errors.join("；"));
  }

  const targetMountId = String(body?.targetMountId ?? body?.target_mount_id ?? "").trim();
  await assertWritableMount(mountRepository, targetMountId);

  // 前缀规范化同时承担校验职责（禁止 . 与 ..）
  const targetPathPrefix = normalizePathPrefix(body?.targetPathPrefix ?? body?.target_path_prefix ?? "/") || "/";

  const duplicate = await codeRepo.findRepositoryByIdentity({ provider, repoIdentifier, trackMode, trackRef });
  if (duplicate) {
    throw new ConflictError(
      `该仓库已登记（${repoIdentifier}，${trackMode}${trackRef ? `:${trackRef}` : ""}），请勿重复添加`,
    );
  }

  const id = generateId("repo");
  await codeRepo.createRepository({
    id,
    provider,
    name: body?.name ? String(body.name).trim() : null,
    repo_identifier: repoIdentifier,
    track_mode: trackMode,
    track_ref: trackRef,
    target_mount_id: targetMountId,
    target_path_prefix: targetPathPrefix,
    enabled: body?.enabled === undefined ? 1 : body.enabled ? 1 : 0,
    config_json: await serializeProviderConfig(provider, incomingConfig, encryptionSecret),
  });

  return await getRepository(db, factory, encryptionSecret, id, env);
}

/**
 * 更新仓库
 */
export async function updateRepository(db, repositoryFactory, encryptionSecret, id, body, env = {}) {
  const factory = ensureRepositoryFactory(db, repositoryFactory, env);
  const codeRepo = factory.getCodeRepositoryRepository();
  const mountRepository = factory.getMountRepository();

  const existing = await codeRepo.findRepositoryById(id);
  if (!existing) {
    throw new NotFoundError(`代码仓库不存在: ${id}`);
  }

  const provider = existing.provider; // provider 不允许变更（变更等同于换一个仓库）
  const updates = {};

  const repoIdentifier =
    body?.repoIdentifier !== undefined || body?.repo_identifier !== undefined
      ? normalizeRepoIdentifier(body.repoIdentifier ?? body.repo_identifier)
      : existing.repo_identifier;

  const trackMode =
    body?.trackMode !== undefined || body?.track_mode !== undefined
      ? String(body.trackMode ?? body.track_mode).trim()
      : existing.track_mode;

  let trackRef = existing.track_ref ?? null;
  if (body?.trackRef !== undefined || body?.track_ref !== undefined) {
    const raw = body.trackRef ?? body.track_ref;
    trackRef = raw === null || raw === undefined ? null : String(raw).trim() || null;
  }

  // 合并配置：前端回传掩码值时保留原密钥
  const existingConfig = await parseProviderConfig(provider, existing.config_json, encryptionSecret);
  const mergedConfig =
    body?.config && typeof body.config === "object"
      ? mergeProviderConfig(provider, existingConfig, body.config)
      : existingConfig;

  const validation = RepoProviderFactory.validateConfig(provider, {
    repoIdentifier,
    trackMode,
    trackRef,
    config: mergedConfig,
  });
  if (!validation.valid) {
    throw new ValidationError(validation.errors.join("；"));
  }

  // 身份四元组变化时需要重新查重
  const identityChanged =
    repoIdentifier !== existing.repo_identifier ||
    trackMode !== existing.track_mode ||
    (trackRef || "") !== (existing.track_ref || "");

  if (identityChanged) {
    const duplicate = await codeRepo.findRepositoryByIdentity({ provider, repoIdentifier, trackMode, trackRef });
    if (duplicate && String(duplicate.id) !== String(id)) {
      throw new ConflictError(
        `该仓库已登记（${repoIdentifier}，${trackMode}${trackRef ? `:${trackRef}` : ""}），请勿重复添加`,
      );
    }
  }

  updates.repo_identifier = repoIdentifier;
  updates.track_mode = trackMode;
  updates.track_ref = trackRef;
  updates.config_json = await serializeProviderConfig(provider, mergedConfig, encryptionSecret);

  if (body?.name !== undefined) {
    updates.name = body.name ? String(body.name).trim() : null;
  }

  if (body?.targetMountId !== undefined || body?.target_mount_id !== undefined) {
    const targetMountId = String(body.targetMountId ?? body.target_mount_id ?? "").trim();
    await assertWritableMount(mountRepository, targetMountId);
    updates.target_mount_id = targetMountId;
  }

  if (body?.targetPathPrefix !== undefined || body?.target_path_prefix !== undefined) {
    updates.target_path_prefix = normalizePathPrefix(body.targetPathPrefix ?? body.target_path_prefix) || "/";
  }

  if (body?.enabled !== undefined) {
    updates.enabled = body.enabled ? 1 : 0;
  }

  await codeRepo.updateRepository(id, updates);
  return await getRepository(db, factory, encryptionSecret, id, env);
}

/**
 * 启用/禁用仓库
 */
export async function setRepositoryEnabled(db, repositoryFactory, id, enabled, env = {}) {
  const factory = ensureRepositoryFactory(db, repositoryFactory, env);
  const codeRepo = factory.getCodeRepositoryRepository();

  const existing = await codeRepo.findRepositoryById(id);
  if (!existing) {
    throw new NotFoundError(`代码仓库不存在: ${id}`);
  }

  await codeRepo.updateRepository(id, { enabled: enabled ? 1 : 0 });
  return { id, enabled: Boolean(enabled) };
}

/**
 * 删除仓库（同时清理备份记录，但不删除已上传的快照文件）
 */
export async function deleteRepository(db, repositoryFactory, id, env = {}) {
  const factory = ensureRepositoryFactory(db, repositoryFactory, env);
  const codeRepo = factory.getCodeRepositoryRepository();

  const existing = await codeRepo.findRepositoryById(id);
  if (!existing) {
    throw new NotFoundError(`代码仓库不存在: ${id}`);
  }

  await codeRepo.deleteRepository(id);
  return { id };
}

// ==================== 检查更新 ====================

/**
 * 检查仓库是否有更新（只解析版本，不触发备份）
 * @returns {Promise<{hasUpdate: boolean, latest: object, lastBackup: object|null, lastKnownCommitSha: string|null}>}
 */
export async function checkRepository(db, repositoryFactory, encryptionSecret, id, env = {}) {
  const factory = ensureRepositoryFactory(db, repositoryFactory, env);
  const codeRepo = factory.getCodeRepositoryRepository();

  const row = await codeRepo.findRepositoryById(id);
  if (!row) {
    throw new NotFoundError(`代码仓库不存在: ${id}`);
  }

  const providerConfig = await parseProviderConfig(row.provider, row.config_json, encryptionSecret);
  const provider = RepoProviderFactory.createProvider(row.provider, providerConfig);

  try {
    const latest = await provider.resolveLatestVersion({
      repoIdentifier: row.repo_identifier,
      trackMode: row.track_mode,
      trackRef: row.track_ref ?? null,
    });

    const existingBackup = await codeRepo.findBackupByCommit(row.id, latest.commitSha);
    const alreadyBackedUp = Boolean(existingBackup && existingBackup.status === "success");

    await codeRepo.updateRepository(row.id, {
      last_checked_at: new Date().toISOString(),
      last_error: null,
    });

    const lastSuccess = await codeRepo.findLatestSuccessBackup(row.id);

    return {
      repositoryId: row.id,
      hasUpdate: !alreadyBackedUp,
      alreadyBackedUp,
      latest,
      lastKnownCommitSha: row.last_known_commit_sha ?? null,
      lastBackup: lastSuccess ? toBackupDto(lastSuccess) : null,
    };
  } catch (error) {
    await codeRepo
      .updateRepository(row.id, {
        last_checked_at: new Date().toISOString(),
        last_error: error?.message || String(error),
      })
      .catch(() => {});
    throw error;
  }
}

// ==================== 备份记录 ====================

/**
 * 分页查询某仓库的备份记录
 */
export async function listBackups(db, repositoryFactory, repositoryId, options = {}, env = {}) {
  const factory = ensureRepositoryFactory(db, repositoryFactory, env);
  const codeRepo = factory.getCodeRepositoryRepository();

  const repo = await codeRepo.findRepositoryById(repositoryId);
  if (!repo) {
    throw new NotFoundError(`代码仓库不存在: ${repositoryId}`);
  }

  const { backups, total } = await codeRepo.findBackupsByRepository(repositoryId, options);
  return {
    items: backups.map(toBackupDto),
    total,
    limit: options.limit ?? 50,
    offset: options.offset ?? 0,
  };
}

/**
 * 生成备份快照的下载链接
 * - 复用 FileSystem.generateFileLink：预签名 / 代理的决策交给既有逻辑
 * @param {object} fileSystem FileSystem 实例
 */
export async function getBackupDownloadLink(db, repositoryFactory, fileSystem, backupId, options = {}, env = {}) {
  const factory = ensureRepositoryFactory(db, repositoryFactory, env);
  const codeRepo = factory.getCodeRepositoryRepository();

  const backup = await codeRepo.findBackupById(backupId);
  if (!backup) {
    throw new NotFoundError(`备份记录不存在: ${backupId}`);
  }
  if (backup.status !== "success") {
    throw new ValidationError(`该备份未成功完成（当前状态：${backup.status}），无法下载`);
  }

  const target = options?.manifest === true ? backup.manifest_path : backup.storage_path;
  if (!target) {
    throw new NotFoundError(options?.manifest === true ? "该备份没有 manifest 文件" : "该备份没有可下载的快照文件");
  }

  const link = await fileSystem.generateFileLink(target, options.userId, options.userType ?? UserType.ADMIN, {
    forceDownload: true,
  });

  return {
    backupId,
    path: target,
    ...link,
  };
}

/**
 * 查询引用了某挂载点的仓库数量
 * - 供挂载点删除前的关联提示使用（当前未强制阻止删除）
 */
export async function countRepositoriesByMount(db, repositoryFactory, mountId, env = {}) {
  const factory = ensureRepositoryFactory(db, repositoryFactory, env);
  return await factory.getCodeRepositoryRepository().countRepositoriesByMount(mountId);
}

export default {
  getProviderMetadata,
  listRepositories,
  getRepository,
  createRepository,
  updateRepository,
  setRepositoryEnabled,
  deleteRepository,
  checkRepository,
  listBackups,
  getBackupDownloadLink,
  countRepositoriesByMount,
};
