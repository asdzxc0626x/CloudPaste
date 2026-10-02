/**
 * 代码仓库备份 - GitHub 凭据池（修改点：第 3 期 3-B）
 *
 * 目标：让「多 Token / 多代理」成为可配置、可隔离、可回退的资源池，
 * 而不是把某一个 Token 焊死在某一个仓库上。
 *
 * 两级配置：
 * - 仓库级：存在 code_repositories.config_json 里的 tokens / proxies 数组
 * - 全局级：存在 system_settings 的一行 JSON（key = repo_backup_github_pool）
 * 两级都复用**已有**的存储位置，因此本阶段零迁移、零 schema 变更。
 *
 * 条目结构（两级完全一致）：
 *   { id, label, value, enabled }
 *   - value 在库里始终是密文（encrypted: 前缀），只有运行时才解密
 *   - 代理地址可能内嵌 basic auth（https://user:pass@host），因此与 Token 同等对待，
 *     同样加密、同样掩码、同样不出现在日志里
 *
 * 关键设计：**运行期可用性不落在这里**
 * 某个 Token 被限流、某个代理刚失败，这些状态由第 3-A 的共享额度账本
 * （metrics_cache，在第 3-A 里已建好）按「值 + 角色」的散列分区记录。
 * 这样做的好处：
 * - 同一个 Token 被两个仓库共用时，限流状态天然共享，不会被各自的池重复撞一次
 * - 改备注名、调整顺序都不会丢失限流状态（分区只跟 value 有关）
 * - 不需要在池里存易变的运行时字段，配置读写保持纯粹
 */

import { encryptValue, decryptIfNeeded, maskSecret } from "../utils/crypto.js";
import { DbTables } from "../constants/index.js";
import { SETTING_FLAGS, SETTING_GROUPS, SETTING_TYPES } from "../constants/settings.js";

/** 全局池在 system_settings 里的固定 key（永远只有 1 行） */
export const GLOBAL_POOL_SETTING_KEY = "repo_backup_github_pool";

/** 单个池的条目上限（Token 与代理各自计算），防止一次提交过大 */
export const MAX_POOL_ENTRIES = 20;

/** 池的两个种类（与 config_json / system_settings 里的字段名一致） */
export const POOL_TOKEN_KEY = "tokens";
export const POOL_PROXY_KEY = "proxies";
export const POOL_KEYS = [POOL_TOKEN_KEY, POOL_PROXY_KEY];

/** 条目 id 前缀，便于在日志与接口里看出类型（id 本身不含任何密钥信息） */
const ENTRY_ID_PREFIX = {
  [POOL_TOKEN_KEY]: "tk_",
  [POOL_PROXY_KEY]: "px_",
};

const GLOBAL_POOL_DESCRIPTION =
  "代码仓库备份的全局 GitHub Token / 加速代理池（由「仓库备份」页面维护，系统内部使用）。";

/**
 * 生成条目 id
 * - 只用于前端增删改时定位条目，不含任何密钥信息
 * @param {'tokens'|'proxies'} kind
 * @returns {string}
 */
export function generateEntryId(kind) {
  const prefix = ENTRY_ID_PREFIX[kind] || "en_";
  try {
    // eslint-disable-next-line no-undef
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      // eslint-disable-next-line no-undef
      return `${prefix}${crypto.randomUUID()}`;
    }
  } catch {
    // 忽略，退回到时间戳方案
  }
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 空池 */
export function emptyPool() {
  return { [POOL_TOKEN_KEY]: [], [POOL_PROXY_KEY]: [] };
}

/**
 * 判断一个值是不是「前端回传的掩码」
 * - 与 config.js 里 mergeProviderConfig 的判定保持一致
 * @param {string} text
 */
export function isMaskedPlaceholder(text) {
  return /^\*+.{0,8}$/.test(String(text || ""));
}

/**
 * 归一化一个条目数组
 * - 丢弃非对象项、补 id、去重 id、统一字段类型、截断到上限
 * @param {any} raw
 * @param {'tokens'|'proxies'} kind
 */
function normalizeEntries(raw, kind) {
  if (!Array.isArray(raw)) return [];

  const result = [];
  const seenIds = new Set();

  for (const item of raw) {
    if (result.length >= MAX_POOL_ENTRIES) break;
    if (!item || typeof item !== "object") continue;

    const value = item.value === null || item.value === undefined ? "" : String(item.value).trim();
    const label = item.label === null || item.label === undefined ? "" : String(item.label).trim();

    let id = item.id === null || item.id === undefined ? "" : String(item.id).trim();
    // id 缺失或重复都重新生成：id 只用于前端定位，重生成不影响任何已有状态
    if (!id || seenIds.has(id)) id = generateEntryId(kind);
    seenIds.add(id);

    result.push({
      id,
      label,
      value,
      // 只有显式 false / 0 才算禁用，缺省一律视为启用（兼容最早的手写配置）
      enabled: !(item.enabled === false || item.enabled === 0),
    });
  }

  return result;
}

/**
 * 归一化整个池（只处理形状，不动密文）
 * @param {any} raw
 * @returns {{ tokens: object[], proxies: object[] }}
 */
export function normalizePool(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    [POOL_TOKEN_KEY]: normalizeEntries(source[POOL_TOKEN_KEY], POOL_TOKEN_KEY),
    [POOL_PROXY_KEY]: normalizeEntries(source[POOL_PROXY_KEY], POOL_PROXY_KEY),
  };
}

/** 逐条解密 */
async function decryptEntries(entries, encryptionSecret) {
  const result = [];
  for (const entry of entries) {
    let value = "";
    try {
      value = await decryptIfNeeded(entry.value, encryptionSecret);
    } catch (error) {
      // 单条解密失败（换过 ENCRYPTION_SECRET）不应该让整池不可用，
      // 按「这条没有值」处理，其余条目继续工作
      console.warn(`[repoBackup] 凭据条目解密失败，已按空值处理（id=${entry.id}）: ${error?.message || error}`);
      value = "";
    }
    result.push({ ...entry, value: value === null || value === undefined ? "" : String(value) });
  }
  return result;
}

/** 逐条加密 */
async function encryptEntries(entries, encryptionSecret) {
  const result = [];
  for (const entry of entries) {
    const plain = String(entry.value || "");
    result.push({
      ...entry,
      // 已经是密文则原样保留（更新时未改动该条目的场景）
      value: plain === "" ? "" : plain.startsWith("encrypted:") ? plain : await encryptValue(plain, encryptionSecret),
    });
  }
  return result;
}

/**
 * 解密整个池 -> 运行时明文
 * @param {any} pool
 * @param {string} encryptionSecret
 */
export async function decryptPool(pool, encryptionSecret) {
  const normalized = normalizePool(pool);
  return {
    [POOL_TOKEN_KEY]: await decryptEntries(normalized[POOL_TOKEN_KEY], encryptionSecret),
    [POOL_PROXY_KEY]: await decryptEntries(normalized[POOL_PROXY_KEY], encryptionSecret),
  };
}

/**
 * 加密整个池 -> 落库形态
 * @param {any} pool
 * @param {string} encryptionSecret
 */
export async function encryptPool(pool, encryptionSecret) {
  const normalized = normalizePool(pool);
  return {
    [POOL_TOKEN_KEY]: await encryptEntries(normalized[POOL_TOKEN_KEY], encryptionSecret),
    [POOL_PROXY_KEY]: await encryptEntries(normalized[POOL_PROXY_KEY], encryptionSecret),
  };
}

/** 逐条掩码 -> 前端视图；revealPlain=true 时给出明文（仅限管理员显式 reveal） */
function maskEntries(entries, revealPlain = false) {
  return entries.map((entry) => ({
    id: entry.id,
    label: entry.label,
    enabled: entry.enabled,
    // 默认只下发掩码 —— 前端要「点击查看」必须走 reveal，明文不会随列表接口到处流动
    value: entry.value
      ? revealPlain
        ? String(entry.value)
        : maskSecret(String(entry.value))
      : "",
    hasValue: Boolean(entry.value),
  }));
}

/**
 * 构建前端视图
 * @param {any} pool 明文池
 * @param {{ revealPlain?: boolean }} [options] revealPlain 仅用于管理员显式请求明文
 */
export function buildPoolView(pool, options = {}) {
  const revealPlain = options?.revealPlain === true;
  const normalized = normalizePool(pool);
  return {
    [POOL_TOKEN_KEY]: maskEntries(normalized[POOL_TOKEN_KEY], revealPlain),
    [POOL_PROXY_KEY]: maskEntries(normalized[POOL_PROXY_KEY], revealPlain),
  };
}

/**
 * 合并前端提交的池（按 id 增删改）
 *
 * 规则与 config.js 的 mergeProviderConfig 一致：
 * - 入参里没有的 id = 删除该条目
 * - 没有 id = 新增
 * - value 为空串 = 显式清空该条目的值（条目保留但等于未配置）
 * - value 是掩码串 = 前端没有改动，沿用原值
 *
 * @param {any} existingPool 现有明文池
 * @param {any} incomingPool 前端提交的池
 */
export function mergePool(existingPool, incomingPool) {
  const existing = normalizePool(existingPool);
  const merged = {};

  for (const kind of POOL_KEYS) {
    const prevById = new Map(existing[kind].map((entry) => [entry.id, entry]));
    const source = Array.isArray(incomingPool?.[kind]) ? incomingPool[kind] : [];
    const entries = [];

    for (const item of source) {
      if (entries.length >= MAX_POOL_ENTRIES) break;
      if (!item || typeof item !== "object") continue;

      const id = item.id === null || item.id === undefined ? "" : String(item.id).trim();
      const prev = id ? prevById.get(id) : null;

      const rawValue = item.value === null || item.value === undefined ? "" : String(item.value);
      let value;
      if (rawValue === "") {
        value = "";
      } else if (isMaskedPlaceholder(rawValue) && prev) {
        value = String(prev.value || "");
      } else {
        value = rawValue.trim();
      }

      entries.push({
        id: id || generateEntryId(kind),
        label: item.label === null || item.label === undefined ? "" : String(item.label).trim(),
        value,
        enabled: !(item.enabled === false || item.enabled === 0),
      });
    }

    merged[kind] = normalizeEntries(entries, kind);
  }

  return merged;
}

/**
 * 读取全局池（明文）
 * - 读失败一律返回空池：全局池不可用时应当退化成「没有全局配置」，
 *   而不是让整个仓库备份功能报错
 * @param {any} db
 * @param {string} encryptionSecret
 */
export async function loadGlobalPool(db, encryptionSecret) {
  if (!db) return emptyPool();
  try {
    const row = await db
      .prepare(`SELECT value FROM ${DbTables.SYSTEM_SETTINGS} WHERE key = ?`)
      .bind(GLOBAL_POOL_SETTING_KEY)
      .first();
    const raw = row?.value;
    if (raw === null || raw === undefined || String(raw).trim() === "") return emptyPool();
    return await decryptPool(JSON.parse(String(raw)), encryptionSecret);
  } catch (error) {
    console.warn(`[repoBackup] 读取全局 GitHub 凭据池失败，按空池处理: ${error?.message || error}`);
    return emptyPool();
  }
}

/**
 * 写入全局池
 * - 与 schedulerTickerStateService 一样放进 system_settings 的「系统内部」分组，
 *   因此不会出现在系统设置页面里被误改
 * @param {any} db
 * @param {any} pool 明文池（或前端提交的、含掩码的池）
 * @param {string} encryptionSecret
 */
export async function saveGlobalPool(db, pool, encryptionSecret) {
  if (!db) return;

  const encrypted = await encryptPool(normalizePool(pool), encryptionSecret);
  const value = JSON.stringify(encrypted);

  await db
    .prepare(
      `
      INSERT INTO ${DbTables.SYSTEM_SETTINGS} (
        key, value, description, type, group_id, options, sort_order, flags, updated_at
      )
      VALUES (?, ?, ?, ?, ?, NULL, 0, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `,
    )
    .bind(
      GLOBAL_POOL_SETTING_KEY,
      value,
      GLOBAL_POOL_DESCRIPTION,
      SETTING_TYPES.TEXTAREA,
      SETTING_GROUPS.SYSTEM,
      SETTING_FLAGS.READONLY,
    )
    .run();
}

/**
 * 从 code_repositories 行里取出仓库级明文池
 * @param {object} repoRow
 * @param {object} decryptedConfig parseProviderConfig 的结果（明文）
 */
export function extractRepoPool(decryptedConfig) {
  return normalizePool(decryptedConfig);
}

/**
 * 按「仓库级 -> 全局级」的顺序展开候选条目
 *
 * 注意这里只做「有配置时可作为候选」的挑选，**可用性判断交给调用方**：
 * 是否被限流、是否在冷却期需要查共享账本，那是调度器的事。
 *
 * @param {object} params
 * @param {object} params.repoPool   仓库级明文池
 * @param {object} params.globalPool 全局级明文池
 * @param {'tokens'|'proxies'} params.kind
 * @returns {Array<{ entry: object, source: 'repository'|'global' }>}
 */
export function listCredentialCandidates({ repoPool, globalPool, kind }) {
  const pick = (pool, source) =>
    normalizePool(pool)[kind]
      .filter((entry) => entry.enabled && String(entry.value || "").trim() !== "")
      .map((entry) => ({ entry, source }));

  const fromRepo = pick(repoPool, "repository");
  // 仓库级有配置时，全局池只作为「仓库级全部不可用」时的后备，
  // 因此这里排在后面而不是混在一起
  if (fromRepo.length > 0) {
    return [...fromRepo, ...pick(globalPool, "global")];
  }
  return pick(globalPool, "global");
}

/**
 * 判断池里是否「配置过」某类凭据（不论是否启用）
 * - 用于区分「没配过 -> 可以走匿名」与「配过但全不可用 -> 应当延迟等恢复」
 * @param {any} pool
 * @param {'tokens'|'proxies'} kind
 */
export function hasConfiguredEntries(pool, kind) {
  return normalizePool(pool)[kind].some((entry) => String(entry.value || "").trim() !== "");
}

// ==================== 字段级入口（供 config.js 复用同一套规则）====================
//
// config.js 处理的是 code_repositories.config_json 里的单个数组字段
// （tokens / proxies），规则必须与全局池完全一致，因此统一走这里，
// 避免「仓库级掩码规则」和「全局级掩码规则」各写一套后逐渐跑偏。

/**
 * 解密一个凭据数组字段
 * @param {any} rawEntries
 * @param {string} encryptionSecret
 * @param {'tokens'|'proxies'} kind
 */
export async function decryptEntryList(rawEntries, encryptionSecret, kind = POOL_TOKEN_KEY) {
  return await decryptEntries(normalizeEntries(rawEntries, kind), encryptionSecret);
}

/**
 * 加密一个凭据数组字段
 * @param {any} rawEntries
 * @param {string} encryptionSecret
 * @param {'tokens'|'proxies'} kind
 */
export async function encryptEntryList(rawEntries, encryptionSecret, kind = POOL_TOKEN_KEY) {
  return await encryptEntries(normalizeEntries(rawEntries, kind), encryptionSecret);
}

/**
 * 掩码一个凭据数组字段（下发给前端的形态）
 * @param {any} rawEntries
 * @param {'tokens'|'proxies'} kind
 */
export function maskEntryList(rawEntries, kind = POOL_TOKEN_KEY) {
  return maskEntries(normalizeEntries(rawEntries, kind));
}

/**
 * 合并一个凭据数组字段（按 id 增删改，掩码回传时保留原值）
 * @param {any} existingEntries 现有明文数组
 * @param {any} incomingEntries 前端提交的数组
 * @param {'tokens'|'proxies'} kind
 */
export function mergeEntryList(existingEntries, incomingEntries, kind = POOL_TOKEN_KEY) {
  const merged = mergePool({ [kind]: existingEntries }, { [kind]: incomingEntries });
  return merged[kind];
}

export default {
  GLOBAL_POOL_SETTING_KEY,
  MAX_POOL_ENTRIES,
  POOL_TOKEN_KEY,
  POOL_PROXY_KEY,
  POOL_KEYS,
  emptyPool,
  generateEntryId,
  isMaskedPlaceholder,
  normalizePool,
  decryptPool,
  encryptPool,
  buildPoolView,
  mergePool,
  loadGlobalPool,
  saveGlobalPool,
  extractRepoPool,
  listCredentialCandidates,
  hasConfiguredEntries,
  decryptEntryList,
  encryptEntryList,
  maskEntryList,
  mergeEntryList,
};
