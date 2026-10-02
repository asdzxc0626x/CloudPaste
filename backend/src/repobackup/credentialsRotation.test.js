/**
 * 修复验收测试：多 Token / 多代理轮询池 + 单凭据故障隔离 + 独立限流
 * （修改点：本次审计修复的针对性验证，不引入需要 session 的依赖）
 *
 * 运行：node --test src/repobackup/credentialsRotation.test.js
 *
 * 设计说明：
 * - 数据库用 Node 内置的 node:sqlite 建真实内存库，并包一层 D1 风格的
 *   prepare/bind/first/all/run。这样 metrics_cache 的 upsert、账本读写、
 *   冷却写入走的是**真实 SQL**，而不是手写的假实现 —— 否则测出来的只是桩的行为。
 * - fetch 用桩：按「当前 Authorization 里的 Token」决定返回 200 还是 401/429，
 *   并记录每次请求实际使用的 Token 与目标 URL，供断言轮询均匀性。
 * - 不触网、不依赖外部状态。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { GithubRepoProvider, resetCredentialRotation } from "./providers/GithubRepoProvider.js";
import {
  githubRequestScheduler,
  clearCoalescedCache,
  ANONYMOUS_SCOPE_ID,
  buildQuotaScopeId,
  buildProxyScopeId,
  readScopeStates,
} from "./GithubRequestScheduler.js";

// ==================== 测试替身 ====================

/** 建一个只含 metrics_cache 的真实内存库，包成 D1 形状 */
function createTestDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    CREATE TABLE metrics_cache (
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      metric_key TEXT NOT NULL,
      value_num INTEGER,
      value_text TEXT,
      value_json_text TEXT,
      snapshot_at_ms INTEGER,
      updated_at_ms INTEGER,
      error_message TEXT,
      PRIMARY KEY (scope_type, scope_id, metric_key)
    )
  `);

  const normalize = (row) => (row ? { ...row } : null);

  return {
    _raw: raw,
    prepare(sql) {
      const text = String(sql);
      const stmt = raw.prepare(text);
      const isSelect = /^\s*select/i.test(text);
      const args = [];
      const api = {
        bind(...values) {
          args.push(...values);
          return api;
        },
        async first() {
          return normalize(stmt.get(...args) ?? null);
        },
        async all() {
          return { results: stmt.all(...args).map(normalize) };
        },
        async run() {
          const info = stmt.run(...args);
          return { meta: { changes: Number(info.changes) || 0 } };
        },
      };
      return api;
    },
  };
}

/**
 * 安装 fetch 桩
 * @param {(ctx: {token: string|null, url: string, index: number}) => Response|Error} responder
 * @returns {{ calls: Array<{token: string|null, url: string}> }}
 */
function installFetchStub(responder) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const auth = init?.headers?.Authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const record = { token, url: String(url) };
    calls.push(record);
    const result = responder({ ...record, index: calls.length - 1 });
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls };
}

/** 构造一个 github API 的 200 响应 */
function jsonOk(body = { sha: "a".repeat(40) }) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999" },
  });
}

/** 构造限流响应 */
function rateLimitedResponse() {
  return new Response(JSON.stringify({ message: "rate limited" }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-limit": "60",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
    },
  });
}

/** 把调度器调成「不排队、不设匿名预算」以便测试快速跑 */
function configureScheduler({ budget = 1 } = {}) {
  githubRequestScheduler.setDefaults({
    MAX_CONCURRENCY: 4,
    MIN_INTERVAL_MS: 0,
    ANONYMOUS_HOURLY_BUDGET: budget,
    MAX_START_DELAY_MS: 5000,
  });
  githubRequestScheduler.reset();
  clearCoalescedCache();
  // 修改点：轮询游标是模块级状态，会跨用例累积，必须一起复位才能断言轮询顺序
  resetCredentialRotation();
}

/**
 * 建一个 provider（仓库级池 + 可选全局池直注，避免依赖加密链路）
 *
 * 注意：匿名小时预算由 provider 在构造时从 env 读取（不是调度器的默认值），
 * 所以要验证预算行为必须从这里传进去。
 */
function makeProvider({ tokens = [], proxies = [], db = null, budget = null } = {}) {
  const env = {
    REPO_BACKUP_GITHUB_MIN_INTERVAL_MS: "0",
    REPO_BACKUP_GITHUB_MAX_CONCURRENCY: "4",
  };
  if (budget !== null) env.REPO_BACKUP_GITHUB_HOURLY_BUDGET = String(budget);

  const provider = new GithubRepoProvider({ tokens, proxies }, { db, env });
  // 直接注入全局池（等价于 loadGlobalPool 的结果），让本测试聚焦轮询与隔离
  provider._globalPool = { tokens: [], proxies: [] };
  provider._globalPoolPromise = Promise.resolve(provider._globalPool);
  return provider;
}

const entry = (value, id) => ({ id: id || `tk_${value}`, label: "", value, enabled: true });
const pentry = (value, id) => ({ id: id || `px_${value}`, label: "", value, enabled: true });

/** 发起一次「解析分支」请求，返回实际用到的 token 列表的增量 */
async function resolveOnce(provider, ref) {
  return await provider.resolveLatestVersion({
    repoIdentifier: "octocat/Hello-World",
    trackMode: "branch",
    trackRef: ref,
    refCount: 1,
  });
}

// ==================== 1. 多 Token 均匀轮询 ====================

test("多 Token 轮询：连续请求应轮流命中池内每个 Token，而不是只用第一个", async () => {
  configureScheduler();
  const tokens = [entry("ghp_AAAA"), entry("ghp_BBBB"), entry("ghp_CCCC")];
  const provider = makeProvider({ tokens });
  const { calls } = installFetchStub(() => jsonOk());

  const used = [];
  for (let i = 0; i < 9; i += 1) {
    clearCoalescedCache();
    await resolveOnce(provider, `branch-${i}`);
    used.push(calls[calls.length - 1].token);
  }

  // 前 3 次必须恰好各用一次（轮询，不是「只用第一个」）
  assert.deepEqual(used.slice(0, 3), ["ghp_AAAA", "ghp_BBBB", "ghp_CCCC"]);
  // 9 次请求应当完全均匀：每个 Token 各 3 次
  const counts = used.reduce((acc, t) => ({ ...acc, [t]: (acc[t] || 0) + 1 }), {});
  assert.deepEqual(counts, { ghp_AAAA: 3, ghp_BBBB: 3, ghp_CCCC: 3 });
  // 没有任何一次请求是匿名的
  assert.equal(used.includes(null), false);
});

test("多 Token 轮询：短池不会把长池的游标压回开头（回归：共享游标被取模）", async () => {
  configureScheduler();
  // 长池 5 条：修复前，只要系统里存在一个短池把游标压低，第 4/5 条永远轮不到
  const longPool = ["ghp_1", "ghp_2", "ghp_3", "ghp_4", "ghp_5"].map((v) => entry(v));
  const shortPool = [entry("ghp_x"), entry("ghp_y")];

  const longProvider = makeProvider({ tokens: longPool });
  const shortProvider = makeProvider({ tokens: shortPool });
  const { calls } = installFetchStub(() => jsonOk());

  // 先用短池跑 4 次，模拟「另一个仓库的池」把共享游标压低
  for (let i = 0; i < 4; i += 1) {
    clearCoalescedCache();
    await resolveOnce(shortProvider, `short-${i}`);
  }

  // 长池再跑 5 次：必须覆盖到全部 5 条
  const used = [];
  for (let i = 0; i < 5; i += 1) {
    clearCoalescedCache();
    await resolveOnce(longProvider, `long-${i}`);
    used.push(calls[calls.length - 1].token);
  }

  assert.equal(new Set(used).size, 5, `长池的 5 个 Token 都应轮到，实际用到: ${used.join(",")}`);
});

// ==================== 2. 多代理均匀轮询 + 不影响 API ====================

test("多代理轮询：归档下载应轮流命中池内每个代理", async () => {
  configureScheduler();
  const provider = makeProvider({
    tokens: [entry("ghp_AAAA")],
    proxies: [pentry("https://px1.example.com"), pentry("https://px2.example.com")],
  });
  const { calls } = installFetchStub(() => new Response("archive", { status: 200 }));

  const hosts = [];
  for (let i = 0; i < 6; i += 1) {
    clearCoalescedCache();
    await provider.openSourceArchive({
      repoIdentifier: "octocat/Hello-World",
      refType: "branch",
      ref: "main",
      commitSha: `sha${i}`,
    });
    hosts.push(new URL(calls[calls.length - 1].url).host);
  }

  assert.deepEqual(hosts.slice(0, 2), ["px1.example.com", "px2.example.com"]);
  const counts = hosts.reduce((acc, h) => ({ ...acc, [h]: (acc[h] || 0) + 1 }), {});
  assert.deepEqual(counts, { "px1.example.com": 3, "px2.example.com": 3 });
});

test("审计修复 1：配置了代理，API 请求仍必须直连 api.github.com", async () => {
  configureScheduler();
  const provider = makeProvider({
    tokens: [entry("ghp_AAAA")],
    proxies: [pentry("https://px1.example.com")],
  });
  const { calls } = installFetchStub(() => jsonOk());

  await resolveOnce(provider, "main");

  assert.equal(calls.length, 1);
  assert.equal(
    new URL(calls[0].url).host,
    "api.github.com",
    "API 请求不得走代理，否则代理返回的 404 会被误判为「仓库不存在」",
  );
});

// ==================== 3. 单凭据故障隔离 ====================

test("单 Token 故障隔离：某个 Token 返回 401 时应换下一个继续，而不是直接判永久失败", async () => {
  configureScheduler();
  const tokens = [entry("ghp_BAD"), entry("ghp_GOOD"), entry("ghp_ALSO")];
  const provider = makeProvider({ tokens });
  const db = createTestDb();
  provider._db = db;

  const { calls } = installFetchStub(({ token }) =>
    token === "ghp_BAD"
      ? new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })
      : jsonOk(),
  );

  // 关键断言：这次调用必须**成功**（换用了别的 Token），而不是抛永久性错误
  const result = await resolveOnce(provider, "main");
  assert.equal(result.commitSha, "a".repeat(40));

  // 第一次用了坏 Token，第二次换成了其它 Token
  assert.equal(calls[0].token, "ghp_BAD");
  assert.notEqual(calls[1].token, "ghp_BAD");
  assert.equal(calls[1].token === "ghp_GOOD" || calls[1].token === "ghp_ALSO", true);

  // 坏 Token 应被写入冷却（15 分钟），后续请求不会再选中它
  const states = await readScopeStates(db);
  const badState = states.get(buildQuotaScopeId("ghp_BAD"));
  assert.ok(badState, "坏 Token 应有账本记录");
  assert.ok(badState.cooldownUntilMs > Date.now(), "坏 Token 应处于冷却中");

  // 再发一次请求：必须仍然成功，且不再使用 Bad Token
  clearCoalescedCache();
  const before = calls.length;
  await resolveOnce(provider, "second");
  const afterTokens = calls.slice(before).map((c) => c.token);
  assert.equal(afterTokens.includes("ghp_BAD"), false, "冷却中的 Token 不应再被选中");
});

test("单 Token 故障隔离：池内仅剩一个 Token 且它失效时，仍然如实报错（不静默降级）", async () => {
  configureScheduler();
  const provider = makeProvider({ tokens: [entry("ghp_ONLY")] });
  const db = createTestDb();
  provider._db = db;
  installFetchStub(() => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }));

  await assert.rejects(() => resolveOnce(provider, "main"), /HTTP 401/);
});

test("单代理故障隔离：某个代理网络失败时应换下一个代理，且失败节点被冷却", async () => {
  configureScheduler();
  const provider = makeProvider({
    proxies: [pentry("https://bad.example.com"), pentry("https://good.example.com")],
  });
  const db = createTestDb();
  provider._db = db;

  const { calls } = installFetchStub(({ url }) => {
    if (new URL(url).host === "bad.example.com") return new Error("ECONNRESET");
    return new Response("archive", { status: 200 });
  });

  await provider.openSourceArchive({
    repoIdentifier: "octocat/Hello-World",
    refType: "branch",
    ref: "main",
    commitSha: "sha1",
  });

  // 坏代理试过之后换成了好代理
  const hosts = calls.map((c) => new URL(c.url).host);
  assert.deepEqual(hosts, ["bad.example.com", "good.example.com"]);

  // 坏代理被写入冷却，其它仓库再也不会先撞它
  const states = await readScopeStates(db);
  const badState = states.get(buildProxyScopeId("https://bad.example.com"));
  assert.ok(badState && badState.cooldownUntilMs > Date.now(), "失败代理应处于冷却中");
});

// ==================== 4. 独立限流 ====================

test("多 Token 轮询：每个新请求都轮到下一个，而不是等当前失败才切换", async () => {
  configureScheduler();
  const tokens = [entry("ghp_A"), entry("ghp_B"), entry("ghp_C")];
  const provider = makeProvider({ tokens });
  // 所有 Token 都正常，没有任何失败 —— 仍然必须轮换
  const { calls } = installFetchStub(() => jsonOk());

  const used = [];
  for (let i = 0; i < 6; i += 1) {
    clearCoalescedCache();
    await resolveOnce(provider, `ref-${i}`);
    used.push(calls[calls.length - 1].token);
  }

  // 关键：全程零失败，但 6 次请求用了 3 个不同的 Token，且按顺序轮转
  assert.deepEqual(used, ["ghp_A", "ghp_B", "ghp_C", "ghp_A", "ghp_B", "ghp_C"]);
});

test("多代理轮询：归档请求同样每个都换下一个代理（零失败也轮转）", async () => {
  configureScheduler();
  const provider = makeProvider({
    proxies: [pentry("https://p1.example.com"), pentry("https://p2.example.com"), pentry("https://p3.example.com")],
  });
  const { calls } = installFetchStub(() => new Response("archive", { status: 200 }));

  const hosts = [];
  for (let i = 0; i < 6; i += 1) {
    clearCoalescedCache();
    await provider.openSourceArchive({
      repoIdentifier: "octocat/Hello-World",
      refType: "branch",
      ref: "main",
      commitSha: `sha${i}`,
    });
    hosts.push(new URL(calls[calls.length - 1].url).host);
  }

  assert.deepEqual(hosts, [
    "p1.example.com",
    "p2.example.com",
    "p3.example.com",
    "p1.example.com",
    "p2.example.com",
    "p3.example.com",
  ]);
});

test("独立限流：某个 Token 被限流不应影响其他 Token，也不应让整次请求失败", async () => {
  configureScheduler();
  const tokens = [entry("ghp_LIMITED"), entry("ghp_FREE")];
  const provider = makeProvider({ tokens });
  const db = createTestDb();
  provider._db = db;

  // 只有 LIMITED 会被 429
  const { calls } = installFetchStub(({ token }) => (token === "ghp_LIMITED" ? rateLimitedResponse() : jsonOk()));

  // 轮询第一次轮到 LIMITED 撞限流 -> 应换 FREE 继续，最终成功
  const result = await resolveOnce(provider, "main");
  assert.equal(result.commitSha, "a".repeat(40));

  const usedTokens = calls.map((c) => c.token);
  assert.equal(usedTokens[0], "ghp_LIMITED", "第一次应轮到被限流的 Token");
  assert.equal(usedTokens.includes("ghp_FREE"), true, "应换到未限流的 Token 完成请求");

  // LIMITED 的额度记账独立：只有它的分区被记为 remaining=0
  const states = await readScopeStates(db);
  const limitedState = states.get(buildQuotaScopeId("ghp_LIMITED"));
  assert.ok(limitedState, "被限流 Token 应有独立账本记录");
  assert.equal(limitedState.remaining, 0);

  // FREE 的分区确实独立存在（拿到的是它自己的额度，而不是 LIMITED 那份）
  // 注意：不能断言 remaining === null —— FREE 走的是 jsonOk()，响应头带 4999，
  // 账本如实记下它自己的额度，这正说明两个 Token 的额度是分开记账的。
  const freeState = states.get(buildQuotaScopeId("ghp_FREE"));
  assert.ok(freeState, "FREE 应写入自己的额度分区");
  assert.equal(freeState.remaining, 4999, "FREE 记录的是它自己的额度，与 LIMITED 的 0 互不干扰");
  assert.equal(
    freeState.remaining <= 0,
    false,
    "FREE 不应被判定为额度见底",
  );

  // 紧接着的请求：应避开被限流的 Token，直接成功
  clearCoalescedCache();
  const before = calls.length;
  await resolveOnce(provider, "second");
  const nextTokens = calls.slice(before).map((c) => c.token);
  assert.equal(nextTokens.includes("ghp_LIMITED"), false, "限流中的 Token 应被暂时避开");
});

test("独立限流：匿名额度用尽时仍然抛出 RateLimitedError（交给延迟重试，不变成失败）", async () => {
  // 匿名小时预算压到 1 次，验证「无 Token 时预算仍生效」这条既有语义没被改坏。
  // 预算必须从 env 传给 provider（它构造时读取），调度器默认值不参与。
  configureScheduler();
  const provider = makeProvider({ tokens: [], budget: 1 });
  const db = createTestDb();
  provider._db = db;
  installFetchStub(() => jsonOk());

  await resolveOnce(provider, "first"); // 用掉唯一 1 次预算
  clearCoalescedCache();

  await assert.rejects(
    () => resolveOnce(provider, "second"),
    (err) => err?.kind === "rate_limited" || /额度|预算/.test(String(err?.message || "")),
    "匿名预算用尽应抛限流错误（第 2 期的延迟重试会接住）",
  );
});

// ==================== 5. 既有语义未被破坏 ====================

test("既有语义：未配置任何 Token 时仍以匿名身份请求（不产生 Authorization 头）", async () => {
  configureScheduler();
  const provider = makeProvider({ tokens: [] });
  const { calls } = installFetchStub(() => jsonOk());

  await resolveOnce(provider, "main");

  assert.equal(calls[0].token, null);
  assert.equal(githubRequestScheduler.activeCount, 0, "请求结束后并发名额必须归还");
  assert.equal(githubRequestScheduler.waitingCount, 0);
});

test("既有语义：仓库级池优先于全局池，且仓库级可用时不掺入全局池的 Token", async () => {
  configureScheduler();
  const provider = makeProvider({ tokens: [entry("ghp_REPO1"), entry("ghp_REPO2")] });
  provider._globalPool = { tokens: [entry("ghp_GLOBAL")], proxies: [] };
  provider._globalPoolPromise = Promise.resolve(provider._globalPool);
  const { calls } = installFetchStub(() => jsonOk());

  const used = [];
  for (let i = 0; i < 4; i += 1) {
    clearCoalescedCache();
    await resolveOnce(provider, `b-${i}`);
    used.push(calls[calls.length - 1].token);
  }

  assert.equal(used.includes("ghp_GLOBAL"), false, "仓库级可用时不应使用全局池");
  assert.deepEqual([...new Set(used)].sort(), ["ghp_REPO1", "ghp_REPO2"]);
});

test("既有语义：匿名分区常量未被轮询改动影响", () => {
  assert.equal(ANONYMOUS_SCOPE_ID, "anonymous");
});
