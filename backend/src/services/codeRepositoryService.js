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
 *
 * 优化点（多分支 / 多备份目标 / 版本保留 / 独立备份计划）：
 * - 分支模式下一个仓库记录承载一组分支，落库为 track_refs_json
 * - 备份目标可多选，落库为 target_mount_ids_json，全部要求具备 WriterCapable
 * - retention_count 控制每个仓库保留多少个成功版本
 * - 备份计划不存在仓库表里：每个仓库对应一行 scheduled_jobs，
 *   由 repobackup/schedule.js 在创建/更新/删除仓库时同步维护（详见该文件头注释）
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
  resolveTrackRefs,
  resolveTargetMountIds,
  resolveRetentionCount,
  DEFAULT_RETENTION_COUNT,
  MIN_RETENTION_COUNT,
  MAX_RETENTION_COUNT,
  MAX_TRACK_REFS,
  MAX_TARGET_MOUNTS,
} from "../repobackup/config.js";
import { normalizePathPrefix, buildRepoFolderName } from "../repobackup/paths.js";
import {
  resolveScheduleInput,
  syncRepositoryScheduleJob,
  removeRepositoryScheduleJob,
  loadRepositorySchedule,
  loadAllRepositorySchedules,
} from "../repobackup/schedule.js";

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
 * 把传入的数组/单值规范成去重后的字符串数组
 * @param {unknown} raw
 * @param {{ allowEmpty?: boolean, max?: number, label?: string }} [options]
 * @returns {string[]}
 */
function normalizeStringList(raw, options = {}) {
  const { allowEmpty = false, max = 50, label = "列表" } = options;

  let list = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw === undefined || raw === null || raw === "") {
    list = [];
  } else {
    // 兼容旧前端传单值，以及逗号分隔的多值
    list = String(raw)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const seen = new Set();
  const result = [];
  for (const item of list) {
    const text = String(item ?? "").trim();
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }

  if (!allowEmpty && result.length === 0) {
    throw new ValidationError(`${label}不能为空`);
  }
  if (result.length > max) {
    throw new ValidationError(`${label}最多支持 ${max} 项，当前 ${result.length} 项`);
  }
  return result;
}

/**
 * 校验目标挂载点：存在、启用、且驱动具备写入能力
 * - 只读驱动（GITHUB_RELEASES / MIRROR）在这里被挡下，
 *   而不是等到备份任务跑一半才失败
 *
 * 修改点（多备份目标优化）：从「校验单个」扩展为「校验多个」，
 * 任意一个不合格即整体拒绝（用户要求：所有目标必须具备 WriterCapable）。
 *
 * @param {object} mountRepository
 * @param {string[]} mountIds
 * @returns {Promise<object[]>} 与 mountIds 顺序一致的挂载点记录
 */
async function assertWritableMounts(mountRepository, mountIds) {
  if (!Array.isArray(mountIds) || mountIds.length === 0) {
    throw new ValidationError("至少需要选择一个备份目标挂载点");
  }

  const mounts = [];
  for (const mountId of mountIds) {
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

    mounts.push(mount);
  }

  return mounts;
}

/**
 * 把仓库记录上的目标挂载点解析为可展示结构
 * @param {object[]} mounts
 */
function toMountBrief(mount) {
  if (!mount) return null;
  return {
    id: mount.id,
    name: mount.name ?? null,
    mountPath: mount.mount_path,
    storageType: mount.storage_type ?? null,
    isActive: mount.is_active === 1,
  };
}

/**
 * 把数据库行转换为 API 返回结构
 * @param {object} row
 * @param {object} [extra]
 */
function toRepositoryDto(row, extra = {}) {
  const trackRefs = resolveTrackRefs(row);
  const targetMountIds = resolveTargetMountIds(row);

  return {
    id: row.id,
    provider: row.provider,
    providerDisplayName: RepoProviderFactory.getDisplayName(row.provider),
    name: row.name || row.repo_identifier,
    repoIdentifier: row.repo_identifier,
    trackMode: row.track_mode,
    // 修改点（多分支优化）：对外暴露数组；trackRef 保留为兼容用的“主引用”
    trackRefs,
    trackRef: row.track_ref ?? trackRefs[0] ?? null,
    // 修改点（多备份目标优化）：对外暴露数组；targetMountId 保留为第一个目标
    targetMountIds,
    targetMountId: row.target_mount_id ?? targetMountIds[0] ?? null,
    targetPathPrefix: row.target_path_prefix || "/",
    // 修改点（版本保留优化）
    retentionCount: resolveRetentionCount(row),
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
 * 备份目标结果行 → API 结构
 * @param {object} row code_repository_backup_targets 行
 */
function toTargetDto(row) {
  return {
    id: row.id,
    mountId: row.mount_id,
    mountPath: row.mount_path ?? null,
    storagePath: row.storage_path ?? null,
    manifestPath: row.manifest_path ?? null,
    sizeBytes: row.size_bytes ?? null,
    status: row.status,
    errorMessage: row.error_message ?? null,
  };
}

/**
 * 把备份记录行转换为 API 返回结构
 * @param {object} row
 * @param {{ targets?: object[] }} [extra]
 */
function toBackupDto(row, extra = {}) {
  const targets = Array.isArray(extra.targets) ? extra.targets.map(toTargetDto) : [];
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
    // 修改点（多备份目标优化）：每个目标各自的落盘结果
    targets,
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

  // 修改点（独立备份计划优化）：一次性取出全部备份计划，避免逐仓库查 scheduled_jobs
  const scheduleMap = await loadAllRepositorySchedules(db);

  const result = [];
  for (const row of rows) {
    const targetMountIds = resolveTargetMountIds(row);
    const targetMounts = targetMountIds.map((id) => toMountBrief(mountMap.get(String(id)) || null));

    const latestBackup = await codeRepo.findLatestBackup(row.id);
    const latestBackupTargets = latestBackup ? await codeRepo.findTargetsByBackup(latestBackup.id) : [];

    // 备份目录：只给出第一个目标上的目录，避免列表里堆一长串路径
    const firstMount = targetMounts[0] ? mountMap.get(String(targetMountIds[0])) : null;
    const backupFolder = firstMount
      ? `${String(firstMount.mount_path).replace(/\/+$/, "")}${normalizePathPrefix(row.target_path_prefix)}/${buildRepoFolderName({
          provider: row.provider,
          repoIdentifier: row.repo_identifier,
        })}/`
      : null;

    result.push(
      toRepositoryDto(row, {
        config: await buildProviderConfigView(row.provider, row.config_json, encryptionSecret),
        targetMount: targetMounts[0] || null,
        targetMounts,
        missingMountIds: targetMountIds.filter((id) => !mountMap.has(String(id))),
        backupFolder,
        // 修改点（独立备份计划优化）：未配置计划时为 null，前端显示「未启用」
        schedule: scheduleMap.get(String(row.id)) || null,
        latestBackup: latestBackup ? toBackupDto(latestBackup, { targets: latestBackupTargets }) : null,
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
  const mountRepository = factory.getMountRepository();

  const row = await codeRepo.findRepositoryById(id);
  if (!row) {
    throw new NotFoundError(`代码仓库不存在: ${id}`);
  }

  const targetMountIds = resolveTargetMountIds(row);
  const targetMounts = [];
  for (const mountId of targetMountIds) {
    targetMounts.push(toMountBrief(await mountRepository.findById(mountId)));
  }

  const latestBackup = await codeRepo.findLatestBackup(row.id);
  const latestBackupTargets = latestBackup ? await codeRepo.findTargetsByBackup(latestBackup.id) : [];

  return toRepositoryDto(row, {
    config: await buildProviderConfigView(row.provider, row.config_json, encryptionSecret),
    targetMount: targetMounts[0] || null,
    targetMounts,
    missingMountIds: targetMountIds.filter((_, index) => !targetMounts[index]),
    // 修改点（独立备份计划优化）
    schedule: await loadRepositorySchedule(db, row.id),
    latestBackup: latestBackup ? toBackupDto(latestBackup, { targets: latestBackupTargets }) : null,
  });
}

/**
 * 从请求体解析「跟踪引用」与「跟踪模式」的组合
 *
 * 修改点（多分支优化）：
 * - branch 模式：接收 trackRefs 数组（兼容旧的单个 trackRef 字符串）
 * - release 模式：只接收单个 trackRef（空串/null 表示最新 Release）
 *
 * @param {object} body
 * @param {string} [fallbackTrackMode] 更新时沿用原值
 * @param {object} [existing] 更新时的现有记录（用于缺省沿用）
 * @returns {{ trackMode: string, trackRefs: string[], trackRef: string|null }}
 */
function resolveTrackInput(body, fallbackTrackMode = "branch", existing = null) {
  const hasTrackMode = body?.trackMode !== undefined || body?.track_mode !== undefined;
  const trackMode = String(
    hasTrackMode ? (body.trackMode ?? body.track_mode) : (existing?.track_mode ?? fallbackTrackMode),
  ).trim();

  if (trackMode !== "branch" && trackMode !== "release") {
    throw new ValidationError(`不支持的跟踪模式: ${trackMode}`);
  }

  const trackRefsProvided = body?.trackRefs !== undefined || body?.track_refs !== undefined;
  const trackRefProvided = body?.trackRef !== undefined || body?.track_ref !== undefined;

  if (trackMode === "release") {
    // release 模式始终是单个引用，空值表示“最新 Release”
    let trackRef = existing?.track_ref ?? null;
    if (trackRefProvided) {
      const raw = body.trackRef ?? body.track_ref;
      trackRef = raw === null || raw === undefined ? null : String(raw).trim() || null;
    } else if (trackRefsProvided) {
      const list = Array.isArray(body.trackRefs ?? body.track_refs) ? body.trackRefs ?? body.track_refs : [];
      const first = list.map((v) => String(v ?? "").trim()).filter(Boolean)[0];
      trackRef = first || null;
    }
    return { trackMode, trackRefs: [], trackRef };
  }

  // branch 模式
  let rawInput;
  if (trackRefsProvided) {
    rawInput = body.trackRefs ?? body.track_refs;
  } else if (trackRefProvided) {
    rawInput = [body.trackRef ?? body.track_ref];
  } else if (existing) {
    // 未提供时沿用现有分支集合
    return { trackMode, trackRefs: resolveTrackRefs(existing), trackRef: existing.track_ref ?? null };
  }

  const trackRefs = normalizeStringList(rawInput, {
    allowEmpty: false,
    max: MAX_TRACK_REFS,
    label: "分支列表",
  });

  return { trackMode, trackRefs, trackRef: trackRefs[0] ?? null };
}

/**
 * 解析目标挂载点输入（修改点：多备份目标优化）
 * @param {object} body
 * @param {object} [existing]
 * @returns {string[]|null} null 表示本次未提供，沿用原值
 */
function resolveTargetMountInput(body, existing = null) {
  const provided =
    body?.targetMountIds !== undefined ||
    body?.target_mount_ids !== undefined ||
    body?.targetMountId !== undefined ||
    body?.target_mount_id !== undefined;

  if (!provided) {
    return existing ? resolveTargetMountIds(existing) : null;
  }

  const raw = body.targetMountIds ?? body.target_mount_ids ?? body.targetMountId ?? body.target_mount_id;
  return normalizeStringList(raw, {
    allowEmpty: false,
    max: MAX_TARGET_MOUNTS,
    label: "备份目标",
  });
}

/**
 * 解析版本保留数输入（修改点：版本保留优化）
 * @param {object} body
 * @param {object} [existing]
 * @returns {number}
 */
function resolveRetentionInput(body, existing = null) {
  const raw = body?.retentionCount ?? body?.retention_count;
  if (raw === undefined || raw === null || raw === "") {
    return existing ? resolveRetentionCount(existing) : DEFAULT_RETENTION_COUNT;
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    throw new ValidationError("保留版本数必须是数字");
  }
  const int = Math.trunc(num);
  if (int < MIN_RETENTION_COUNT || int > MAX_RETENTION_COUNT) {
    throw new ValidationError(`保留版本数必须在 ${MIN_RETENTION_COUNT} ~ ${MAX_RETENTION_COUNT} 之间`);
  }
  return int;
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
  const { trackMode, trackRefs, trackRef } = resolveTrackInput(body, "branch", null);

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

  const targetMountIds = resolveTargetMountInput(body, null);
  await assertWritableMounts(mountRepository, targetMountIds);

  const retentionCount = resolveRetentionInput(body, null);

  // 修改点（独立备份计划优化）：先校验计划参数再建仓库，
  // 避免仓库建好了却因为间隔非法而报错（留下一个没有计划的仓库）
  const schedule = resolveScheduleInput(body, null);

  // 前缀规范化同时承担校验职责（禁止 . 与 ..）
  const targetPathPrefix = normalizePathPrefix(body?.targetPathPrefix ?? body?.target_path_prefix ?? "/") || "/";

  const duplicates = await codeRepo.findRepositoriesByIdentity({ provider, repoIdentifier, trackMode });
  if (duplicates.length > 0) {
    throw new ConflictError(
      `该仓库已登记（${repoIdentifier}，${trackMode === "branch" ? "分支模式" : "Release 模式"}），请勿重复添加`,
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
    track_refs_json: JSON.stringify(trackMode === "branch" ? trackRefs : []),
    target_mount_id: targetMountIds[0],
    target_mount_ids_json: JSON.stringify(targetMountIds),
    target_path_prefix: targetPathPrefix,
    retention_count: retentionCount,
    enabled: body?.enabled === undefined ? 1 : body.enabled ? 1 : 0,
    config_json: await serializeProviderConfig(provider, incomingConfig, encryptionSecret),
  });

  // 修改点（独立备份计划优化）：建立该仓库自己的 scheduled_jobs 行
  await syncRepositoryScheduleJob(db, {
    repoRow: { id, name: body?.name ? String(body.name).trim() : null, repo_identifier: repoIdentifier },
    enabled: schedule.enabled,
    intervalSec: schedule.intervalSec,
    existing: null,
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

  const { trackMode, trackRefs, trackRef } = resolveTrackInput(body, existing.track_mode, existing);

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

  // 身份变化时需要重新查重（排除自己）
  const identityChanged = repoIdentifier !== existing.repo_identifier || trackMode !== existing.track_mode;
  if (identityChanged) {
    const duplicates = await codeRepo.findRepositoriesByIdentity({ provider, repoIdentifier, trackMode });
    const others = duplicates.filter((row) => String(row.id) !== String(id));
    if (others.length > 0) {
      throw new ConflictError(
        `该仓库已登记（${repoIdentifier}，${trackMode === "branch" ? "分支模式" : "Release 模式"}），请勿重复添加`,
      );
    }
  }

  const targetMountIds = resolveTargetMountInput(body, existing);
  if (targetMountIds !== null) {
    await assertWritableMounts(mountRepository, targetMountIds);
    updates.target_mount_id = targetMountIds[0];
    updates.target_mount_ids_json = JSON.stringify(targetMountIds);
  }

  updates.repo_identifier = repoIdentifier;
  updates.track_mode = trackMode;
  updates.track_ref = trackRef;
  updates.track_refs_json = JSON.stringify(trackMode === "branch" ? trackRefs : []);
  updates.retention_count = resolveRetentionInput(body, existing);
  updates.config_json = await serializeProviderConfig(provider, mergedConfig, encryptionSecret);

  if (body?.name !== undefined) {
    updates.name = body.name ? String(body.name).trim() : null;
  }

  if (body?.targetPathPrefix !== undefined || body?.target_path_prefix !== undefined) {
    updates.target_path_prefix = normalizePathPrefix(body.targetPathPrefix ?? body.target_path_prefix) || "/";
  }

  if (body?.enabled !== undefined) {
    updates.enabled = body.enabled ? 1 : 0;
  }

  // 修改点（独立备份计划优化）：先校验计划参数，再写仓库，再同步计划行
  const existingSchedule = await loadRepositorySchedule(db, id);
  const schedule = resolveScheduleInput(body, existingSchedule);

  await codeRepo.updateRepository(id, updates);

  await syncRepositoryScheduleJob(db, {
    repoRow: {
      id,
      // 名字用于「定时任务」页的展示，取本次更新后的值
      name: updates.name !== undefined ? updates.name : existing.name,
      repo_identifier: repoIdentifier,
    },
    enabled: schedule.enabled,
    intervalSec: schedule.intervalSec,
    existing: existingSchedule,
  });

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
 * 删除仓库（同时清理备份记录、各目标结果与备份计划，但不删除已上传的快照文件）
 */
export async function deleteRepository(db, repositoryFactory, id, env = {}) {
  const factory = ensureRepositoryFactory(db, repositoryFactory, env);
  const codeRepo = factory.getCodeRepositoryRepository();

  const existing = await codeRepo.findRepositoryById(id);
  if (!existing) {
    throw new NotFoundError(`代码仓库不存在: ${id}`);
  }

  await codeRepo.deleteRepository(id);
  // 修改点（独立备份计划优化）：连带清理该仓库的 scheduled_jobs 行与其运行历史，
  // 否则会留下一个永远找不到仓库的调度作业
  await removeRepositoryScheduleJob(db, id);
  return { id };
}

// ==================== 检查更新 ====================

/**
 * 检查仓库是否有更新（只解析版本，不触发备份）
 *
 * 修改点（多分支优化）：branch 模式下逐个分支解析最新 commit，
 * 每个分支独立判断「是否已备份」，其中一个分支解析失败不影响其他分支。
 *
 * @returns {Promise<{
 *   repositoryId: string,
 *   hasUpdate: boolean,
 *   refs: object[],
 *   latest: object|null,
 *   lastKnownCommitSha: string|null,
 *   lastBackup: object|null,
 * }>}
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

  const trackMode = String(row.track_mode || "branch");
  const trackRefs = resolveTrackRefs(row);

  const results = [];
  let firstError = null;

  for (const ref of trackRefs) {
    try {
      const latest = await provider.resolveLatestVersion({
        repoIdentifier: row.repo_identifier,
        trackMode,
        trackRef: ref ?? null,
      });

      const existingBackup = await codeRepo.findBackupByCommit(row.id, latest.commitSha);
      const alreadyBackedUp = Boolean(existingBackup && existingBackup.status === "success");

      results.push({
        ref: latest.ref ?? ref ?? null,
        refType: latest.refType,
        commitSha: latest.commitSha,
        shortCommitSha: String(latest.commitSha || "").slice(0, 7),
        version: latest.version ?? null,
        publishedAt: latest.publishedAt ?? null,
        // 修改点（多分支优化）：每个分支独立判断
        hasUpdate: !alreadyBackedUp,
        alreadyBackedUp,
        error: null,
      });
    } catch (error) {
      const message = error?.message || String(error);
      if (!firstError) firstError = message;
      results.push({
        ref: ref ?? null,
        refType: trackMode === "branch" ? "branch" : "tag",
        commitSha: null,
        shortCommitSha: null,
        version: null,
        publishedAt: null,
        hasUpdate: false,
        alreadyBackedUp: false,
        error: message,
      });
    }
  }

  // 全部引用都失败才认为是整体失败（部分失败仍返回逐分支结果，便于前端展示）
  const allFailed = results.length > 0 && results.every((item) => item.error);
  const successCount = results.filter((item) => !item.error).length;

  await codeRepo.updateRepository(row.id, {
    last_checked_at: new Date().toISOString(),
    // 只有整体失败才把错误落到仓库上；部分失败不下发为仓库级错误，避免误导
    last_error: allFailed ? firstError : null,
  });

  const lastSuccess = await codeRepo.findLatestSuccessBackup(row.id);
  const lastSuccessTargets = lastSuccess ? await codeRepo.findTargetsByBackup(lastSuccess.id) : [];

  return {
    repositoryId: row.id,
    // 修改点（多分支优化）：任一分支有更新即视为有更新
    hasUpdate: results.some((item) => item.hasUpdate),
    allFailed,
    checkedCount: results.length,
    successCount,
    failedCount: results.length - successCount,
    refs: results,
    latest: results.find((item) => !item.error) || null,
    lastKnownCommitSha: row.last_known_commit_sha ?? null,
    lastBackup: lastSuccess ? toBackupDto(lastSuccess, { targets: lastSuccessTargets }) : null,
  };
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
  // 修改点（多备份目标优化）：一次性取出所有目标结果，避免逐条查询
  const targetMap = await codeRepo.findTargetsByBackups(backups.map((row) => row.id));

  return {
    items: backups.map((row) => toBackupDto(row, { targets: targetMap.get(String(row.id)) || [] })),
    total,
    limit: options.limit ?? 50,
    offset: options.offset ?? 0,
  };
}

/**
 * 生成备份快照的下载链接
 * - 复用 FileSystem.generateFileLink：预签名 / 代理的决策交给既有逻辑
 *
 * 修改点（多备份目标优化）：
 * - 可选 targetId 指定从哪个目标的副本下载
 * - 未指定时优先取第一个成功的目标，再回退到备份记录上的路径（v35 数据）
 *
 * @param {object} fileSystem FileSystem 实例
 */
export async function getBackupDownloadLink(db, repositoryFactory, fileSystem, backupId, options = {}, env = {}) {
  const factory = ensureRepositoryFactory(db, repositoryFactory, env);
  const codeRepo = factory.getCodeRepositoryRepository();

  const backup = await codeRepo.findBackupById(backupId);
  if (!backup) {
    throw new NotFoundError(`备份记录不存在: ${backupId}`);
  }
  // partial = 至少有一个目标写成功，快照是可下载的
  if (backup.status !== "success" && backup.status !== "partial") {
    throw new ValidationError(`该备份未成功完成（当前状态：${backup.status}），无法下载`);
  }

  const wantManifest = options?.manifest === true;
  const targets = await codeRepo.findTargetsByBackup(backupId);

  let targetRow = null;
  if (options?.targetId) {
    targetRow = targets.find((row) => String(row.id) === String(options.targetId)) || null;
    if (!targetRow) {
      throw new NotFoundError(`该备份在指定目标上没有副本: ${options.targetId}`);
    }
  } else {
    targetRow = targets.find((row) => row.status === "success") || null;
  }

  const target = wantManifest
    ? targetRow?.manifest_path ?? backup.manifest_path
    : targetRow?.storage_path ?? backup.storage_path;

  if (!target) {
    throw new NotFoundError(wantManifest ? "该备份没有 manifest 文件" : "该备份没有可下载的快照文件");
  }

  const link = await fileSystem.generateFileLink(target, options.userId, options.userType ?? UserType.ADMIN, {
    forceDownload: true,
  });

  return {
    backupId,
    path: target,
    targetId: targetRow?.id ?? null,
    mountId: targetRow?.mount_id ?? null,
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
