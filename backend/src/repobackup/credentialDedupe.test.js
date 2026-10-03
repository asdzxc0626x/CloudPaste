/**
 * 回归测试：凭据池按「值」去重（修改点：凭据去重）
 *
 * 背景：
 * 全局凭据弹窗与仓库表单都允许填多个 Token / 代理。同一个值填两遍本身没有意义，
 * 而且会在调度器里造成真实伤害：
 * - listCredentialCandidates 是「按条目」展开候选的，重复值会各占一个候选位
 * - 共享额度账本按「值 + 角色」的散列分区记账，重复值会被记成两份互不相干的
 *   冷却状态，表现为「同一个 Token 被连着撞两次」
 *
 * 因此落在 normalizeEntries（所有写路径的公共出口）里按值去重，保留最先出现的一条。
 * 这套测试锁定的就是去重的边界 —— 既要真的去掉重复，又不能误删真实凭据：
 * - 掩码串（****abcd）不是凭据身份，两个不同的 Token 可能长得一模一样，绝不能按它判重
 * - 空值代表「还没填」，多条空行不应互相判重
 * - 备注（label）不去重：不同值的两条凭据可能共用同一个备注，按备注丢弃就是数据损坏
 *
 * 运行：node --test src/repobackup/credentialDedupe.test.js
 * （不依赖数据库、不触网）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizePool,
  mergePool,
  mergeEntryList,
  encryptEntryList,
  POOL_TOKEN_KEY,
  POOL_PROXY_KEY,
} from "./credentials.js";

const TOKEN_A = "ghp_duplicate_token_a";
const TOKEN_B = "ghp_token_b";
const PROXY_A = "https://ghproxy.example.com";

/** 造一条池内条目 */
function entry(value, label = "", extra = {}) {
  return { id: `id_${value || "empty"}`, label, value, enabled: true, ...extra };
}

const valuesOf = (entries) => entries.map((item) => item.value);

test("去重：同一个池里值相同的条目只保留最先出现的一条", () => {
  const pool = normalizePool({
    [POOL_TOKEN_KEY]: [entry(TOKEN_A, "主账号"), entry(TOKEN_A, "重复的一条"), entry(TOKEN_B)],
  });

  assert.equal(pool[POOL_TOKEN_KEY].length, 2);
  assert.deepEqual(valuesOf(pool[POOL_TOKEN_KEY]), [TOKEN_A, TOKEN_B]);
  // 保留的是第一条，备注不会被后来者覆盖
  assert.equal(pool[POOL_TOKEN_KEY][0].label, "主账号");
});

test("去重：Token 与代理各自独立，同一个字符串出现在两边是合法的", () => {
  const pool = normalizePool({
    [POOL_TOKEN_KEY]: [entry(PROXY_A)],
    [POOL_PROXY_KEY]: [entry(PROXY_A)],
  });

  assert.equal(pool[POOL_TOKEN_KEY].length, 1);
  assert.equal(pool[POOL_PROXY_KEY].length, 1);
});

test("去重：掩码串不参与判重（两个不同 Token 的掩码可能完全相同）", () => {
  // 掩码是「保留末 4 位」的投影，****ame4 完全可能对应两个不同的真实 Token
  const pool = normalizePool({
    [POOL_TOKEN_KEY]: [entry("****ame4"), entry("****ame4")],
  });

  assert.equal(pool[POOL_TOKEN_KEY].length, 2, "掩码相同不能当成同一个凭据被删掉");
});

test("去重：空值不参与判重（多条待填写的空行应当都能保留）", () => {
  const pool = normalizePool({
    [POOL_TOKEN_KEY]: [entry(""), entry(""), entry("   ")],
  });

  assert.equal(pool[POOL_TOKEN_KEY].length, 3);
});

test("去重：备注不参与判重 —— 不同值的两条凭据可以共用一个备注", () => {
  const pool = normalizePool({
    [POOL_TOKEN_KEY]: [entry(TOKEN_A, "备用"), entry(TOKEN_B, "备用")],
  });

  assert.equal(pool[POOL_TOKEN_KEY].length, 2, "按备注丢弃会删掉用户真实配置的凭据");
});

test("去重：比较前会去掉首尾空白，肉眼相同的值不会被当成两条", () => {
  const pool = normalizePool({
    [POOL_TOKEN_KEY]: [entry(TOKEN_A), entry(`  ${TOKEN_A}  `)],
  });

  assert.equal(pool[POOL_TOKEN_KEY].length, 1);
});

test("去重：mergeEntryList（仓库级写路径）同样按值去重", () => {
  const merged = mergeEntryList([], [entry(TOKEN_A), entry(TOKEN_A), entry(TOKEN_B)], POOL_TOKEN_KEY);

  assert.equal(merged.length, 2);
  assert.deepEqual(valuesOf(merged), [TOKEN_A, TOKEN_B]);
});

test("去重：encryptEntryList 落库前也只剩一条（密文不会重复占用候选位）", async () => {
  const encrypted = await encryptEntryList([entry(TOKEN_A), entry(TOKEN_A)], "test-encryption-secret", POOL_TOKEN_KEY);

  assert.equal(encrypted.length, 1);
  assert.ok(encrypted[0].value.startsWith("encrypted:"), "去重发生在加密之前，落库的仍是密文");
});

test("去重：masked 回传还原原值后，与已有条目重复的那条会被去掉", () => {
  // 现有池里已经有 TOKEN_A；前端把它的掩码原样回传（未修改），
  // 同时又新增了一条明文 TOKEN_A —— 还原之后两者相等，只应保留一条
  const existing = [entry(TOKEN_A)];
  const incoming = [
    { id: `id_${TOKEN_A}`, label: "", value: "****ken_a", enabled: true },
    { id: "new_1", label: "", value: TOKEN_A, enabled: true },
  ];

  const merged = mergeEntryList(existing, incoming, POOL_TOKEN_KEY);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].value, TOKEN_A);
});

test("幂等：把同一个池原样再存一次，条目不会被改掉或丢失", () => {
  const existing = [entry(TOKEN_A, "旧"), entry(TOKEN_B, "旧")];
  const merged = mergePool({ [POOL_TOKEN_KEY]: existing }, { [POOL_TOKEN_KEY]: existing });

  assert.equal(merged[POOL_TOKEN_KEY].length, 2);
  assert.deepEqual(valuesOf(merged[POOL_TOKEN_KEY]), [TOKEN_A, TOKEN_B]);
});
