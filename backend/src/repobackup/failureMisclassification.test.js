/**
 * 重新审计：端到端确认「不再把可恢复故障误判为永久失败」
 * （修改点：审计修复后的回归验证）
 *
 * 运行：node --test src/repobackup/failureMisclassification.test.js
 *
 * 这一组用例专门打「误判」这一类问题：过去的实现里，下面每一种情况都会走到
 * 「抛永久性错误 -> 备份任务记 failed -> 写进备份历史」这条路径，
 * 让一个本来只是暂时抽风的仓库看起来像是坏了。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { GithubRepoProvider, resetCredentialRotation } from "./providers/GithubRepoProvider.js";
import { githubRequestScheduler, clearCoalescedCache } from "./GithubRequestScheduler.js";
import { classifyRepoBackupError, planRetryForError, REPO_ERROR_KIND } from "./errors.js";

function createTestDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    CREATE TABLE metrics_cache (
      scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, metric_key TEXT NOT NULL,
      value_num INTEGER, value_text TEXT, value_json_text TEXT,
      snapshot_at_ms INTEGER, updated_at_ms INTEGER, error_message TEXT,
      PRIMARY KEY (scope_type, scope_id, metric_key)
    )
  `);
  const n = (r) => (r ? { ...r } : null);
  return {
    _raw: raw,
    prepare(sql) {
      const s = raw.prepare(String(sql));
      const a = [];
      const api = {
        bind(...v) { a.push(...v); return api; },
        async first() { return n(s.get(...a) ?? null); },
        async all() { return { results: s.all(...a).map(n) }; },
        async run() { const i = s.run(...a); return { meta: { changes: Number(i.changes) || 0 } }; },
      };
      return api;
    },
  };
}

function installFetch(responder) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const auth = init?.headers?.Authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const rec = { token, url: String(url) };
    calls.push(rec);
    const r = responder({ ...rec, index: calls.length - 1 });
    if (r instanceof Error) throw r;
    return r;
  };
  return { calls };
}

const ok = (body = { sha: "b".repeat(40) }) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "x-ratelimit-remaining": "4999" } });
const e401 = () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
const e403forbidden = () => new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 });
const e403ratelimit = () =>
  new Response(JSON.stringify({ message: "rate limit" }), {
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 1800) },
  });
const e500 = () => new Response("boom", { status: 500 });
const e404 = () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });

function setup({ tokens = [], proxies = [], db = null } = {}) {
  githubRequestScheduler.setDefaults({ MAX_CONCURRENCY: 4, MIN_INTERVAL_MS: 0, MAX_START_DELAY_MS: 5000 });
  githubRequestScheduler.reset();
  clearCoalescedCache();
  resetCredentialRotation();
  const provider = new GithubRepoProvider(
    { tokens, proxies },
    { db, env: { REPO_BACKUP_GITHUB_MIN_INTERVAL_MS: "0", REPO_BACKUP_GITHUB_MAX_CONCURRENCY: "4" } },
  );
  provider._globalPool = { tokens: [], proxies: [] };
  provider._globalPoolPromise = Promise.resolve(provider._globalPool);
  return provider;
}

const entry = (v, id) => ({ id: id || `tk_${v}`, label: "", value: v, enabled: true });
const pentry = (v, id) => ({ id: id || `px_${v}`, label: "", value: v, enabled: true });

const resolve = (p, ref = "main") =>
  p.resolveLatestVersion({ repoIdentifier: "octocat/Hello-World", trackMode: "branch", trackRef: ref, refCount: 1 });

/** 断言某个错误会被判成「可延迟重试」而不是永久失败 */
function assertDeferrable(err, label) {
  const info = classifyRepoBackupError(err);
  assert.equal(
    ["rate_limited", "transient"].includes(info.kind),
    true,
    `${label} 应判为可延迟重试，实际被判为 ${info.kind}（会被写进失败历史）`,
  );
  const plan = planRetryForError(err);
  assert.equal(plan.deferrable, true, `${label} 的 retry 计划应可延迟`);
  assert.ok(plan.delayMs > 0, `${label} 应有正数的重试延迟`);
}

// ==================== 1. 代理返回错误时不得推断「仓库不存在」 ====================

test("误判回归：配置了坏代理，仓库仍应正常备份（代理不参与 API 请求）", async () => {
  const provider = setup({
    tokens: [entry("ghp_A")],
    // 这个「代理」根本不转发 api.github.com，请求打过去会 404
    proxies: [pentry("https://not-an-api-proxy.example.com")],
  });
  const { calls } = installFetch(({ url }) => {
    // 如果 API 请求被套上了代理，host 就不是 api.github.com
    if (new URL(url).host !== "api.github.com") return e404();
    return ok();
  });

  // 过去的实现会走代理 -> 404 -> NotFoundError -> 记永久失败
  const result = await resolve(provider);
  assert.equal(result.commitSha, "b".repeat(40), "仓库应能正常解析，不应因代理而失败");
  assert.equal(calls.every((c) => new URL(c.url).host === "api.github.com"), true);
});

// ==================== 2. 5xx / 超时 / 连接重置 ====================

test("误判回归：上游 5xx 持续时应判为可延迟重试，而不是永久失败", async () => {
  const provider = setup({ tokens: [entry("ghp_A")] });
  installFetch(() => e500());

  // 5xx 会先在请求内重试，耗尽后抛 TransientError
  await assert.rejects(
    () => resolve(provider),
    (err) => { assertDeferrable(err, "HTTP 500"); return true; },
  );
});

test("误判回归：网络错误（连接重置）应判为可延迟重试", async () => {
  const provider = setup({ tokens: [entry("ghp_A")] });
  installFetch(() => new Error("ECONNRESET"));

  await assert.rejects(
    () => resolve(provider),
    (err) => { assertDeferrable(err, "连接重置"); return true; },
  );
});

// ==================== 3. 限流（429 / 403+remaining=0） ====================

test("误判回归：429 限流应判为可延迟重试", async () => {
  const provider = setup({ tokens: [entry("ghp_A")] });
  installFetch(() =>
    new Response(JSON.stringify({ message: "rate limit" }), {
      status: 429,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 1800) },
    }),
  );

  await assert.rejects(
    () => resolve(provider),
    (err) => { assertDeferrable(err, "HTTP 429"); return true; },
  );
});

test("误判回归：403 + remaining=0（限流）应判为可延迟重试", async () => {
  const provider = setup({ tokens: [entry("ghp_A")] });
  installFetch(() => e403ratelimit());

  await assert.rejects(
    () => resolve(provider),
    (err) => { assertDeferrable(err, "403 限流"); return true; },
  );
});

// ==================== 4. 权限类 403：换 Token 后应成功 ====================

test("误判回归：403（受限 Token）应换用其他 Token 完成，而不是判失败", async () => {
  const provider = setup({ tokens: [entry("ghp_NOACCESS"), entry("ghp_OK")] });
  const db = createTestDb();
  provider._db = db;
  const { calls } = installFetch(({ token }) => (token === "ghp_NOACCESS" ? e403forbidden() : ok()));

  const result = await resolve(provider);
  assert.equal(result.commitSha, "b".repeat(40), "应换用有权限的 Token 完成请求");
  assert.equal(calls[0].token, "ghp_NOACCESS");
  assert.equal(calls.some((c) => c.token === "ghp_OK"), true);
});

// ==================== 5. 真·永久错误仍然必须记失败 ====================

test("反向确认：仓库确实不存在（404）仍应判为永久失败，不能被误放行", async () => {
  const provider = setup({ tokens: [entry("ghp_A")] });
  installFetch(() => e404());

  await assert.rejects(
    () => resolve(provider),
    (err) => {
      const info = classifyRepoBackupError(err);
      assert.equal(info.kind, REPO_ERROR_KIND.PERMANENT, "真 404 必须仍是永久性错误");
      return true;
    },
  );
});

test("反向确认：匿名降级时的 404 应判为可重试（私有仓库 + Token 全不可用）", async () => {
  const provider = setup({ tokens: [] });
  // 仓库级配了 Token（模拟「配过但此刻全不可用」），因此会降级成匿名
  provider._repoPool = { tokens: [entry("ghp_DISABLED")], proxies: [] };
  // 让唯一那个 Token 处于冷却中 -> _pickCredential 挑不到 -> 匿名
  provider._db = createTestDb();
  const { buildQuotaScopeId, markScopeCooldown } = await import("./GithubRequestScheduler.js");
  await markScopeCooldown(provider._db, buildQuotaScopeId("ghp_DISABLED"), Date.now() + 600000, "token-invalid");

  installFetch(() => e404());

  await assert.rejects(
    () => resolve(provider),
    (err) => { assertDeferrable(err, "匿名降级 404"); return true; },
  );
});

// ==================== 6. 轮询不该在失败时把额度烧光 ====================

test("轮询安全：整池 Token 都失效时应有限次尝试后停手，而不是无限轮询", async () => {
  const provider = setup({ tokens: [entry("t1"), entry("t2"), entry("t3")] });
  provider._db = createTestDb();
  const { calls } = installFetch(() => e401());

  await assert.rejects(() => resolve(provider));

  // 换凭据有独立上限（MAX_CREDENTIAL_SWITCHES=5），加首次共 6 次；再算上网络重试也不该失控
  assert.ok(calls.length <= 10, `尝试次数应有上限，实际 ${calls.length} 次`);
  assert.ok(calls.length >= 3, `应至少尝试过池内多个 Token，实际 ${calls.length} 次`);
});
