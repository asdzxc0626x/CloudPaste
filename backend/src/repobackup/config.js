/**
 * 代码仓库备份 - provider 配置的序列化/反序列化
 *
 * 修改点：新增功能
 *
 * 职责：
 * - 把 code_repositories.config_json 在「数据库存储形态（敏感字段加密）」与
 *   「运行时形态（明文）」之间转换
 * - 与 utils/crypto.js 的 buildSecretView 思路一致：敏感字段集中声明，避免散落
 */

import { encryptValue, decryptIfNeeded, maskSecret } from "../utils/crypto.js";
// 修改点（第 3 期 3-B 凭据池）：tokens / proxies 是「数组形态的敏感字段」，
// 加解密、掩码、按 id 合并的规则与全局池必须完全一致，因此统一走 credentials.js
import { decryptEntryList, encryptEntryList, mergeEntryList } from "./credentials.js";

/**
 * 多分支 / 多备份目标 / 版本保留的取值边界（修改点：仓库备份优化）
 * - 上限存在的意义是防止一次作业跑太久、单表单提交过大
 */
export const MAX_TRACK_REFS = 20;
export const MAX_TARGET_MOUNTS = 10;
export const DEFAULT_RETENTION_COUNT = 10;
export const MIN_RETENTION_COUNT = 1;
export const MAX_RETENTION_COUNT = 100;

/**
 * 「版本未解析」的占位 commit_sha 前缀（修改点：历史记录需显示失败记录）
 *
 * 背景：备份记录原先只在 resolveLatestVersion 成功之后才创建，
 * 所以「解析版本阶段就失败」（限流、网络不通、分支不存在）根本不会留下历史记录，
 * 备份历史里看起来永远只有成功的版本。
 *
 * 但 code_repository_backups.commit_sha 是 NOT NULL，且 (repository_id, commit_sha)
 * 上有唯一索引，没有真实 sha 时无法插入。这里用一个带前缀且天然唯一的占位值，
 * 避免为此做一次表结构迁移：
 * - 前缀可识别，DTO 读取时会把 commitSha 还原为 null，不会把假 sha 暴露给前端
 * - 占位值不会与真实 sha 冲突（真实 sha 是 40 位十六进制）
 * - 按 commit 去重只会用真实 sha 查询，不受这些行影响
 */
export const UNRESOLVED_COMMIT_PREFIX = "unresolved-";

/** 生成一个唯一的占位 commit_sha */
export function buildUnresolvedCommitSha() {
  return `${UNRESOLVED_COMMIT_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 判断某个 commit_sha 是否为占位值 */
export function isUnresolvedCommitSha(value) {
  return typeof value === "string" && value.startsWith(UNRESOLVED_COMMIT_PREFIX);
}

/**
 * 非成功备份记录的保留条数（修改点：历史记录需显示失败记录）
 * - 失败/跳过记录不占用「保留版本数」额度（那是给成功快照用的），
 *   但也不能无限增长，所以单独设一个上限，超出后删除最旧的
 */
export const NON_SUCCESS_HISTORY_KEEP = 20;

/** 备份记录的合法状态，供列表筛选参数校验使用 */
export const BACKUP_STATUSES = ["running", "success", "partial", "failed", "skipped"];

/**
 * 把 JSON 数组列解析为字符串数组
 * - 解析失败/非数组一律按空数组处理，避免单条脏数据让整页接口 500
 * @param {string|null|undefined} raw
 * @param {{ allowNull?: boolean }} [options]
 * @returns {Array<string|null>}
 */
export function parseStringArray(raw, options = {}) {
  const { allowNull = false } = options;
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];

  const result = [];
  for (const item of value) {
    if (item === null || item === undefined) {
      if (allowNull) result.push(null);
      continue;
    }
    const text = String(item).trim();
    if (!text) continue;
    result.push(text);
  }
  return result;
}

/**
 * 解析仓库记录中被跟踪的引用列表
 *
 * 修改点（多分支优化）：
 * - branch 模式：返回分支名数组（来自 track_refs_json）
 * - release 模式：返回单元素数组，元素可能为 null（表示“最新 Release”）
 *
 * @param {Object} row code_repositories 行
 * @returns {Array<string|null>}
 */
export function resolveTrackRefs(row) {
  const trackMode = String(row?.track_mode || "branch");
  if (trackMode !== "branch") {
    return [row?.track_ref ?? null];
  }

  const fromJson = parseStringArray(row?.track_refs_json);
  if (fromJson.length > 0) return fromJson;

  // 兼容 v35 及更早的数据：只有单个 track_ref
  const legacy = row?.track_ref ? String(row.track_ref).trim() : "";
  return legacy ? [legacy] : [];
}

/**
 * 解析仓库记录的备份目标挂载点 ID 列表
 *
 * 修改点（多备份目标优化）：优先读数组列，缺失时回退到旧的单个 target_mount_id
 * @param {Object} row code_repositories 行
 * @returns {string[]}
 */
export function resolveTargetMountIds(row) {
  const fromJson = parseStringArray(row?.target_mount_ids_json);
  if (fromJson.length > 0) return fromJson;
  const legacy = row?.target_mount_id ? String(row.target_mount_id).trim() : "";
  return legacy ? [legacy] : [];
}

/**
 * 解析仓库的版本保留数（带上下限约束）
 * @param {Object} row
 * @returns {number}
 */
export function resolveRetentionCount(row) {
  const raw = Number(row?.retention_count);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_RETENTION_COUNT;
  return Math.min(MAX_RETENTION_COUNT, Math.max(MIN_RETENTION_COUNT, Math.trunc(raw)));
}

/**
 * 各 provider 的敏感字段
 * - 新增 provider 时在此登记，未登记的 provider 默认无敏感字段
 */
const SECRET_FIELDS_BY_PROVIDER = {
  github: ["token"],
};

/**
 * 获取某 provider 的敏感字段列表
 * @param {string} provider
 * @returns {string[]}
 */
export function getSecretFields(provider) {
  return SECRET_FIELDS_BY_PROVIDER[provider] || [];
}

/**
 * 各 provider 的「结构化敏感字段」（修改点：第 3 期 3-B）
 *
 * 与 SECRET_FIELDS 的区别：这些字段是**数组**，数组元素里带 value 子字段，
 * 例如 [{ id, label, value, enabled }]。加密/掩码要逐条处理，不能整体当作一个字符串。
 */
const SECRET_POOL_FIELDS_BY_PROVIDER = {
  github: ["tokens", "proxies"],
};

/**
 * 获取某 provider 的结构化敏感字段列表
 * @param {string} provider
 * @returns {string[]}
 */
export function getSecretPoolFields(provider) {
  return SECRET_POOL_FIELDS_BY_PROVIDER[provider] || [];
}

/**
 * 解析 config_json 为运行时配置（敏感字段解密）
 * @param {string} provider
 * @param {string|null|undefined} configJson
 * @param {string} encryptionSecret
 * @returns {Promise<Object>}
 */
export async function parseProviderConfig(provider, configJson, encryptionSecret) {
  let raw = {};
  if (configJson) {
    try {
      raw = JSON.parse(configJson) || {};
    } catch {
      // 配置损坏时按空配置处理：GitHub 公开仓库无需任何配置也能工作，
      // 直接抛错会让仓库完全不可用，得不偿失
      console.warn(`[repoBackup] config_json 解析失败，按空配置处理 (provider=${provider})`);
      raw = {};
    }
  }

  const result = { ...raw };
  for (const field of getSecretFields(provider)) {
    if (result[field] === undefined || result[field] === null) continue;
    result[field] = await decryptIfNeeded(result[field], encryptionSecret);
  }
  // 修改点（第 3 期 3-B）：凭据池逐条解密
  for (const field of getSecretPoolFields(provider)) {
    if (result[field] === undefined || result[field] === null) continue;
    result[field] = await decryptEntryList(result[field], encryptionSecret, field);
  }
  return result;
}

/**
 * 把运行时配置序列化为 config_json（敏感字段加密）
 * @param {string} provider
 * @param {Object} config
 * @param {string} encryptionSecret
 * @returns {Promise<string>}
 */
export async function serializeProviderConfig(provider, config, encryptionSecret) {
  const source = config && typeof config === "object" ? config : {};
  const result = {};

  for (const [key, value] of Object.entries(source)) {
    // 空串视为「清空该字段」，直接跳过不写入
    if (value === undefined || value === null || value === "") continue;
    result[key] = value;
  }

  for (const field of getSecretFields(provider)) {
    if (result[field] === undefined) continue;
    const plain = String(result[field]);
    // 已是加密格式则原样保留（更新时未改动密钥的场景）
    result[field] = plain.startsWith("encrypted:") ? plain : await encryptValue(plain, encryptionSecret);
  }

  // 修改点（第 3 期 3-B）：凭据池逐条加密
  for (const field of getSecretPoolFields(provider)) {
    if (result[field] === undefined) continue;
    result[field] = await encryptEntryList(result[field], encryptionSecret, field);
  }

  return JSON.stringify(result);
}

/**
 * 构建返回给前端的配置视图
 *
 * 默认对敏感字段掩码、不下发明文；
 * 传入 { reveal: "plain" } 时给出明文 —— 仅限管理员显式请求（与存储配置的
 * `?reveal=plain` 同一套语义），调用方必须自行做鉴权与审计。
 *
 * @param {string} provider
 * @param {string|null|undefined} configJson
 * @param {string} encryptionSecret
 * @param {{ reveal?: 'plain'|null }} [options]
 * @returns {Promise<Object>}
 */
export async function buildProviderConfigView(provider, configJson, encryptionSecret, options = {}) {
  const revealPlain = options?.reveal === "plain";
  const config = await parseProviderConfig(provider, configJson, encryptionSecret);
  const view = { ...config };

  for (const field of getSecretFields(provider)) {
    if (view[field] === undefined || view[field] === null || view[field] === "") {
      // 明确告诉前端「未配置」，便于区分「未填」与「已填但不下发」
      view[field] = "";
      view[`has_${field}`] = false;
      continue;
    }
    view[field] = revealPlain ? String(view[field]) : maskSecret(String(view[field]));
    view[`has_${field}`] = true;
  }

  // 修改点（第 3 期 3-B）：凭据池逐条处理。
  // 默认同样只下发掩码，前端要「点击查看」需显式走 reveal。
  for (const field of getSecretPoolFields(provider)) {
    const entries = Array.isArray(view[field]) ? view[field] : [];
    view[field] = entries.map((entry) => ({
      id: entry.id,
      label: entry.label,
      enabled: entry.enabled,
      value: entry.value
        ? revealPlain
          ? String(entry.value)
          : maskSecret(String(entry.value))
        : "",
      hasValue: Boolean(entry.value),
    }));
  }

  return view;
}

/**
 * 合并配置更新：前端回传掩码值时保留原值
 * - 前端拿到的是掩码串（如 ****abcd），原样提交回来不应覆盖真实密钥
 * @param {string} provider
 * @param {Object} existingConfig 已解密的现有配置
 * @param {Object} incomingConfig 前端提交的配置
 * @returns {Object} 合并后的明文配置
 */
export function mergeProviderConfig(provider, existingConfig = {}, incomingConfig = {}) {
  const merged = { ...(existingConfig || {}) };
  const secretFields = new Set(getSecretFields(provider));
  // 修改点（第 3 期 3-B）：凭据池字段单独处理（按 id 增删改，而不是整体覆盖）
  const poolFields = new Set(getSecretPoolFields(provider));

  for (const [key, value] of Object.entries(incomingConfig || {})) {
    if (value === undefined) continue;

    if (poolFields.has(key)) {
      // 只有明确传来数组才改动池：null / 非数组一律视为「本次不涉及池」，
      // 避免一次字段缺失就把整个池清空
      if (Array.isArray(value)) merged[key] = mergeEntryList(merged[key], value, key);
      continue;
    }

    if (secretFields.has(key)) {
      // 空串 = 显式清空；全为 * 的掩码串 = 未改动，保留原值
      const text = value === null ? "" : String(value);
      if (text === "") {
        delete merged[key];
        continue;
      }
      if (/^\*+.{0,8}$/.test(text) && text.startsWith("*")) {
        continue;
      }
      merged[key] = text;
      continue;
    }

    if (value === null || value === "") {
      delete merged[key];
      continue;
    }
    merged[key] = value;
  }

  return merged;
}
