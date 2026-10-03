/**
 * 回归测试：单个 Token / 代理 统一为多值池之后，老配置必须继续可用
 * （修改点：Token / 代理统一为多值字段）
 *
 * 背景：
 * 仓库表单的高级配置里曾经有四个字段 —— 单值 token、单值 gh_proxy，
 * 外加后来新增的 tokens / proxies 两个池。前两者与后两者本质是同一件事，
 * 界面上重复，用户要填两遍。
 *
 * 现在统一成「一个多值字段」：schema 只保留 tokens / proxies，
 * 老配置里的 config.token / config.gh_proxy 在解析阶段折进对应的池
 * （见 repobackup/config.js 的 foldLegacyPoolFields）。
 *
 * 这套测试锁定的就是「折叠」这件事不能出错的几个点：
 * - 老配置要能在界面上看到、能编辑，不能凭空消失
 * - 不能与已有的池重复
 * - 前端回传掩码时必须还原成原值，绝不能把 ****abcd 当成真的凭据存进去
 * - 保存一次之后 config_json 里不再留重复的旧字段
 *
 * 运行：node --test src/repobackup/legacySingleValueMigration.test.js
 * （不依赖数据库、不触网）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  foldLegacyPoolFields,
  parseProviderConfig,
  serializeProviderConfig,
  buildProviderConfigView,
  mergeProviderConfig,
} from "./config.js";
import { extractRepoPool, listCredentialCandidates, hasConfiguredEntries, POOL_TOKEN_KEY, POOL_PROXY_KEY } from "./credentials.js";
import { maskSecret } from "../utils/crypto.js";

const PROVIDER = "github";
const SECRET = "test-encryption-secret";
const LEGACY_TOKEN = "ghp_legacy_token_value";
const LEGACY_PROXY = "https://ghproxy.legacy.example.com";

/** 构造一份「老配置」的 config_json（token / gh_proxy 都是加密存储的形态） */
async function buildLegacyConfigJson({ token = LEGACY_TOKEN, proxy = LEGACY_PROXY } = {}) {
  const config = {};
  if (token) config.token = token;
  if (proxy) config.gh_proxy = proxy;
  return await serializeProviderConfig(PROVIDER, config, SECRET);
}

// ==================== 折叠本身 ====================

test("折叠：老配置的单个 token / gh_proxy 会变成池里的条目", () => {
  const config = foldLegacyPoolFields(PROVIDER, { token: LEGACY_TOKEN, gh_proxy: LEGACY_PROXY });

  assert.equal(config.tokens.length, 1);
  assert.equal(config.tokens[0].value, LEGACY_TOKEN);
  assert.equal(config.tokens[0].enabled, true);
  // id 必须与 GithubRepoProvider 里的旧值兼容处理保持一致
  assert.equal(config.tokens[0].id, "tk_legacy");

  assert.equal(config.proxies.length, 1);
  assert.equal(config.proxies[0].value, LEGACY_PROXY);
  assert.equal(config.proxies[0].id, "px_legacy");
});

test("折叠：池里已经有值时以池为准，不把旧值再塞一遍", () => {
  const existing = [{ id: "tk_1", label: "", value: "ghp_from_pool", enabled: true }];
  const config = foldLegacyPoolFields(PROVIDER, { token: LEGACY_TOKEN, tokens: existing });

  assert.equal(config.tokens.length, 1);
  assert.equal(config.tokens[0].value, "ghp_from_pool");
});

test("折叠：幂等，重复调用不会产生重复条目", () => {
  const config = { token: LEGACY_TOKEN };
  foldLegacyPoolFields(PROVIDER, config);
  foldLegacyPoolFields(PROVIDER, config);

  assert.equal(config.tokens.length, 1);
  assert.equal(config.tokens[0].value, LEGACY_TOKEN);
});

test("折叠：旧字段为空 / 缺失 / 非 github provider 时都不动配置", () => {
  const empty = foldLegacyPoolFields(PROVIDER, { token: "   ", gh_proxy: null });
  // 没有可折的值时连键都不该创建，保持原样
  assert.equal(empty.tokens, undefined);
  assert.equal(empty.proxies, undefined);

  const other = foldLegacyPoolFields("gitlab", { token: LEGACY_TOKEN });
  assert.equal(other.tokens, undefined);
});

// ==================== 读：老配置要能在界面上看到 ====================

test("读取：老配置解析后池里有值，运行期仍能选中这个 Token", async () => {
  const configJson = await buildLegacyConfigJson();
  const parsed = await parseProviderConfig(PROVIDER, configJson, SECRET);

  assert.equal(parsed.tokens.length, 1);
  assert.equal(parsed.tokens[0].value, LEGACY_TOKEN);

  // 运行期（GithubRepoProvider 走的就是 extractRepoPool）必须把它当成池里的候选
  const repoPool = extractRepoPool(parsed);
  assert.equal(hasConfiguredEntries(repoPool, POOL_TOKEN_KEY), true);
  assert.equal(hasConfiguredEntries(repoPool, POOL_PROXY_KEY), true);

  const candidates = listCredentialCandidates({ repoPool, globalPool: null, kind: POOL_TOKEN_KEY });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].entry.value, LEGACY_TOKEN);
});

test("读取：下发给前端的视图里，老值出现在池字段中且是掩码", async () => {
  const configJson = await buildLegacyConfigJson();
  const view = await buildProviderConfigView(PROVIDER, configJson, SECRET);

  assert.equal(view.tokens.length, 1);
  assert.equal(view.tokens[0].value, maskSecret(LEGACY_TOKEN));
  assert.notEqual(view.tokens[0].value, LEGACY_TOKEN);
  assert.equal(view.tokens[0].hasValue, true);

  // 显式 reveal 时才给明文
  const plainView = await buildProviderConfigView(PROVIDER, configJson, SECRET, { reveal: "plain" });
  assert.equal(plainView.tokens[0].value, LEGACY_TOKEN);
});

// ==================== 写：掩码回传必须还原成原值 ====================

test("保存：前端原样回传掩码时保留原值，并清掉重复的旧字段", async () => {
  const configJson = await buildLegacyConfigJson();
  const existing = await parseProviderConfig(PROVIDER, configJson, SECRET);
  const view = await buildProviderConfigView(PROVIDER, configJson, SECRET);

  // 前端把「没改动过」的条目连同掩码一起回传
  const merged = mergeProviderConfig(PROVIDER, existing, { tokens: view.tokens, proxies: view.proxies });

  assert.equal(merged.tokens.length, 1);
  assert.equal(merged.tokens[0].value, LEGACY_TOKEN, "掩码回传必须还原成原值，不能把掩码当凭据存下来");
  assert.equal(merged.proxies[0].value, LEGACY_PROXY);

  // 旧字段已折进池里，config_json 不该再留一份重复的
  assert.equal(merged.token, undefined);
  assert.equal(merged.gh_proxy, undefined);

  // 落库 -> 再读回来，值仍然正确（不重复、不丢失）
  const roundTrip = await parseProviderConfig(PROVIDER, await serializeProviderConfig(PROVIDER, merged, SECRET), SECRET);
  assert.equal(roundTrip.tokens.length, 1);
  assert.equal(roundTrip.tokens[0].value, LEGACY_TOKEN);
  assert.equal(roundTrip.token, undefined);
});

test("保存：用户显式删掉老条目后，旧字段不会被复活", async () => {
  const configJson = await buildLegacyConfigJson();
  const existing = await parseProviderConfig(PROVIDER, configJson, SECRET);

  // 前端提交空池 = 用户把这条删了
  const merged = mergeProviderConfig(PROVIDER, existing, { tokens: [], proxies: [] });

  assert.deepEqual(merged.tokens, []);
  assert.equal(merged.token, undefined);

  const roundTrip = await parseProviderConfig(PROVIDER, await serializeProviderConfig(PROVIDER, merged, SECRET), SECRET);
  assert.deepEqual(roundTrip.tokens, []);
  assert.equal(hasConfiguredEntries(extractRepoPool(roundTrip), POOL_TOKEN_KEY), false);
});

test("保存：本次没提交池字段时（例如只改 API 地址）不动老值", async () => {
  const configJson = await buildLegacyConfigJson();
  const existing = await parseProviderConfig(PROVIDER, configJson, SECRET);

  const merged = mergeProviderConfig(PROVIDER, existing, { endpoint_url: "https://ghe.example.com" });

  assert.equal(merged.token, LEGACY_TOKEN, "只改别的字段不该顺手把旧值清掉");
  assert.equal(merged.gh_proxy, LEGACY_PROXY);
  assert.equal(merged.endpoint_url, "https://ghe.example.com");
});
