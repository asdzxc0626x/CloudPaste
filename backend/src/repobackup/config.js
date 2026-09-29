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

  return JSON.stringify(result);
}

/**
 * 构建返回给前端的配置视图（敏感字段掩码，不下发明文）
 * @param {string} provider
 * @param {string|null|undefined} configJson
 * @param {string} encryptionSecret
 * @returns {Promise<Object>}
 */
export async function buildProviderConfigView(provider, configJson, encryptionSecret) {
  const config = await parseProviderConfig(provider, configJson, encryptionSecret);
  const view = { ...config };

  for (const field of getSecretFields(provider)) {
    if (view[field] === undefined || view[field] === null || view[field] === "") {
      // 明确告诉前端「未配置」，便于区分「未填」与「已填但不下发」
      view[field] = "";
      view[`has_${field}`] = false;
      continue;
    }
    view[field] = maskSecret(String(view[field]));
    view[`has_${field}`] = true;
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

  for (const [key, value] of Object.entries(incomingConfig || {})) {
    if (value === undefined) continue;

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
