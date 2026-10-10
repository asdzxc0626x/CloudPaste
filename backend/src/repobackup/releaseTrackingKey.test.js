/**
 * P0 验收测试：Release 空 Tag 的「跟踪键」语义统一
 * （修改点：P0 Release 空 Tag 水位键错位）
 *
 * 运行：node --test src/repobackup/releaseTrackingKey.test.js
 *
 * 修复的 bug：
 *   Release 模式且 Tag 留空时，检测跟踪键是 `ref=''`（空串）。
 *   Provider 会返回具体 Release Tag（例如 `v9.9.9`），备份成功后水位被写到
 *   一行**全新的** `ref='v9.9.9'` 状态行上，真正的跟踪行 `ref=''` 永远没有
 *   backed_up_commit_sha —— 于是每轮检测都判「有更新」，反复创建备份任务，永久空转。
 *
 * 修复思路（对应需求「检测、备份、水位推进必须统一使用跟踪键」）：
 *   · 跟踪键：repo_detect_states 的状态键（「最新」= 空串），由 resolveTrackRefs
 *     / resolveTrackedRefKeys 产出，是唯一的状态键来源
 *   · 展示引用：provider 解析出的具体版本（v9.9.9），只用于展示 / manifest / 备份记录
 *   · 两者全程分开传递（trackingRef vs ref），任何调用方传错都会被
 *     resolveTrackingRefKey / advanceBackedUpWatermark 收敛回跟踪键
 *
 * 覆盖需求验收点：
 *   1. Release 空 Tag：连续 3 轮只备份一次（且水位正确推进）
 *   2. Release 空 Tag：旧数据迁移后不重复备份
 *
 * 全部用真实 SQL（node:sqlite 内存库 + 真实 DDL）与真实检测 handler，不触网。
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  createCodeRepositoryTables,
  createRepoDetectStatesTable,
  createTasksTables,
} from "../db/migrations/sqlite/engine/schema.js";
import { migrateRepoDetectStates, repairReleaseTrackingKeys } from "../db/migrations/sqlite/engine/migrations.js";
import { RepositoryFactory } from "../repositories/index.js";
import { RepoBackupCheckTaskHandler } from "../storage/fs/tasks/handlers/RepoBackupCheckTaskHandler.js";
import { githubRequestScheduler, clearCoalescedCache } from "./GithubRequestScheduler.js";
import { resetCredentialRotation } from "./providers/GithubRepoProvider.js";
import { resolveTrackRefs } from "./config.js";
import {
  normalizeRef,
  trackingRefToDto,
  resolveTrackingRefKey,
  resolveTrackedRefKeys,
  advanceBackedUpWatermark,
} from "./detect.js";

/**
 * 每个用例前复位跨用例共享的模块级状态
 * （合并缓存 3 秒窗口 + 在飞名额 + 凭据轮询游标，见 detectStatePersistence.test.js 的说明）
 */
beforeEach(() => {
  githubRequestScheduler.setDefaults({ MAX_CONCURRENCY: 4, MIN_INTERVAL_MS: 0, MAX_START_DELAY_MS: 5000 });
  githubRequestScheduler.reset();
  clearCoalescedCache();
  resetCredentialRotation();
});

// ==================== 测试替身 ====================

/** 真实内存库，包成 D1 形状 */
function createTestDb() {
  const raw = new DatabaseSync(":memory:");
  const normalizeRow = (row) => (row ? { ...row } : null);
  return {
    _raw: raw,
    prepare(sql) {
      const stmt = raw.prepare(String(sql));
      const args = [];
      const api = {
        bind(...values) {
          args.push(...values);
          return api;
        },
        async first() {
          return normalizeRow(stmt.get(...args) ?? null);
        },
        async all() {
          return { results: stmt.all(...args).map(normalizeRow) };
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

async function setupSchema(db) {
  await createCodeRepositoryTables(db);
  await createRepoDetectStatesTable(db);
  await createTasksTables(db);
}

const sha = (c) => c.repeat(40);
const RELEASE_SHA = sha("2");
const RELEASE_TAG = "v9.9.9";

/**
 * 造一个仓库行
 * release 模式下 track_refs_json 恒为 '[]'，track_ref 为 tag（空=最新）
 */
async function seedRepo(db, { id = "repo-1", trackMode = "release", trackRef = null, refs = ["main"] } = {}) {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO code_repositories
        (id, provider, name, repo_identifier, track_mode, track_ref, track_refs_json,
         target_mount_id, target_mount_ids_json, target_path_prefix, retention_count,
         enabled, config_json, created_at, updated_at)
       VALUES (?, 'github', ?, 'octocat/Hello-World', ?, ?, ?, 'mount-1', '["mount-1"]', '/', 10, 1, '{}', ?, ?)`,
    )
    .bind(
      id,
      `仓库${id}`,
      trackMode,
      trackRef,
      JSON.stringify(trackMode === "branch" ? refs : []),
      now,
      now,
    )
    .run();
  return await db.prepare(`SELECT * FROM code_repositories WHERE id = ?`).bind(id).first();
}

/** 造一条备份历史记录（迁移回填的数据源） */
async function seedBackup(db, { id, repositoryId, refType = "tag", ref = null, commitSha, status = "success", at = null }) {
  const when = at || new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO code_repository_backups
        (id, repository_id, ref_type, ref, commit_sha, version, status, job_id, started_at, finished_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .bind(id, repositoryId, refType, ref, commitSha, ref, status, when, when, when)
    .run();
}

/** 直接插一行检测状态（绕过 ensure，用于造「已经错位」的存量数据） */
async function seedDetectState(db, { id, repositoryId, refType, ref, backedUpSha = null, backedUpAt = null, detectStatus = "ok" }) {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO repo_detect_states
        (id, repository_id, ref_type, ref, detect_status, backed_up_commit_sha, backed_up_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, repositoryId, refType, ref, detectStatus, backedUpSha, backedUpAt, now, now)
    .run();
}

const stateRows = (db, repositoryId) =>
  db._raw.prepare(`SELECT * FROM repo_detect_states WHERE repository_id = ? ORDER BY ref`).all(repositoryId);

/** 安装 fetch 桩 */
function installFetch(responder) {
  globalThis.fetch = async (url, init) => {
    const auth = init?.headers?.Authorization || "";
    const record = { token: auth.startsWith("Bearer ") ? auth.slice(7) : null, url: String(url) };
    const result = responder(record);
    if (result instanceof Error) throw result;
    return result;
  };
}

const jsonOk = (body) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999" },
  });

/**
 * Release 模式的 GitHub 应答
 * 走两个请求：releases/latest 拿 tag_name，commits/<tag> 拿 commit sha
 */
const releaseResponder = (tagName = RELEASE_TAG, commitSha = RELEASE_SHA) => (record) => {
  if (record.url.includes("/releases/latest")) {
    return jsonOk({ tag_name: tagName, published_at: "2026-01-01T00:00:00Z" });
  }
  if (record.url.includes(`/commits/${encodeURIComponent(tagName)}`)) {
    return jsonOk({ sha: commitSha });
  }
  throw new Error(`未预期的请求: ${record.url}`);
};

const ENV = { ENCRYPTION_SECRET: "test-secret-for-tracking-key" };

/** 跑一轮真实检测任务，返回它创建的全部作业 */
async function runCheck(db, repoRow, responder, payload = {}) {
  const repositoryFactory = new RepositoryFactory(db, { env: ENV });
  const createdJobs = [];
  const fileSystem = {
    repositoryFactory,
    mountManager: { db, encryptionSecret: ENV.ENCRYPTION_SECRET },
    async createJob(taskType, jobPayload, userId, userType, meta) {
      const job = { jobId: `${taskType}-test-${createdJobs.length + 1}`, taskType, payload: jobPayload, userId, userType, meta };
      createdJobs.push(job);
      return job;
    },
  };
  const context = {
    isCancelled: async () => false,
    updateProgress: async () => {},
    getFileSystem: () => fileSystem,
    getEnv: () => ENV,
  };

  installFetch(responder);
  const handler = new RepoBackupCheckTaskHandler();
  const job = {
    jobId: `check-${createdJobs.length}`,
    taskType: "repo_backup_check",
    payload: { repositoryId: repoRow.id, ...payload },
    userId: "admin-1",
    userType: "admin",
  };
  await handler.validate(job.payload);
  await handler.execute(job, context);

  return createdJobs;
}

const backupJobs = (jobs) => jobs.filter((j) => j.taskType === "repo_backup");

/** 让所有引用的检测状态重新到期（模拟「下一轮」） */
const makeDueAgain = (db, repositoryId) =>
  db._raw
    .prepare(`UPDATE repo_detect_states SET next_detect_after = NULL WHERE repository_id = ?`)
    .run(repositoryId);

// ==================== 1. 跟踪键 vs 展示引用的形态互转 ====================

test("P0：normalizeRef / trackingRefToDto 是互逆的两种形态（DB 键 ↔ 对外展示）", () => {
  // DB 键形态：空串占位（NOT NULL + 唯一索引的要求）
  assert.equal(normalizeRef(null), "");
  assert.equal(normalizeRef(undefined), "");
  assert.equal(normalizeRef(""), "");
  assert.equal(normalizeRef("main"), "main");

  // 对外形态：空串还原成 null（前端显示「最新 Release」而不是空白）
  assert.equal(trackingRefToDto(""), null);
  assert.equal(trackingRefToDto(null), null);
  assert.equal(trackingRefToDto("main"), "main");

  // 往返一致
  for (const value of [null, "", "main", "v9.9.9"]) {
    assert.equal(trackingRefToDto(normalizeRef(value)), value === "" ? null : value);
  }
});

test("P0：resolveTrackRefs 把 Release 空 Tag 的两种历史写法归一到 null", () => {
  // NULL 与空串都必须归到同一个跟踪键，否则同一仓库会长出两行状态
  assert.deepEqual(resolveTrackRefs({ track_mode: "release", track_ref: null }), [null]);
  assert.deepEqual(resolveTrackRefs({ track_mode: "release", track_ref: "" }), [null]);
  assert.deepEqual(resolveTrackRefs({ track_mode: "release", track_ref: "   " }), [null]);

  // 显式 Tag 保留（去除首尾空白）
  assert.deepEqual(resolveTrackRefs({ track_mode: "release", track_ref: "v1.2.3" }), ["v1.2.3"]);
  assert.deepEqual(resolveTrackRefs({ track_mode: "release", track_ref: "  v1.2.3  " }), ["v1.2.3"]);

  // branch 模式不受影响
  assert.deepEqual(
    resolveTrackRefs({ track_mode: "branch", track_ref: "main", track_refs_json: '["main","develop"]' }),
    ["main", "develop"],
  );
});

test("P0：resolveTrackingRefKey 的三种收敛规则（精确匹配 / 唯一引用收敛 / 多引用不猜）", () => {
  const releaseRepo = { track_mode: "release", track_ref: null };
  const branchRepo = { track_mode: "branch", track_ref: "main", track_refs_json: '["main","develop"]' };

  // 规则 1：候选就是跟踪键 → 原样返回
  assert.equal(resolveTrackingRefKey(branchRepo, "main", "branch"), "main");
  assert.equal(resolveTrackingRefKey(releaseRepo, null, "tag"), "");

  // 规则 2（修复主力）：候选对不上，但仓库只跟踪一个引用 → 收敛到那个跟踪键
  // 「release + 空 Tag」正是这种情形：候选是具体 Tag v9.9.9，跟踪键是空串
  assert.equal(resolveTrackingRefKey(releaseRepo, RELEASE_TAG, "tag"), "");
  assert.equal(resolveTrackingRefKey({ track_mode: "branch", track_ref: "main", track_refs_json: "[]" }, "other", "branch"), "main");

  // 规则 3：多引用且候选对不上 → 保持原值，不猜（猜错会污染另一个分支的水位）
  assert.equal(resolveTrackingRefKey(branchRepo, "feature", "branch"), "feature");
});

test("P0：release 仓库的跟踪键集合是单元素 [{tag, ''}]", () => {
  const keys = resolveTrackedRefKeys({ track_mode: "release", track_ref: null });
  assert.deepEqual(keys, [{ refType: "tag", ref: "" }]);
});

// ==================== 2. 水位推进的收敛守卫 ====================

test("P0：水位守卫 —— 传入具体 Tag 时收敛到跟踪键，不建错行", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { id: "r-guard", trackMode: "release", trackRef: null });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();

  // 模拟备份任务的调用：传的是 provider 解析出的具体 Tag
  await advanceBackedUpWatermark(codeRepo, repoRow.id, "tag", RELEASE_TAG, RELEASE_SHA, { repoRow });

  const rows = stateRows(db, repoRow.id);
  assert.equal(rows.length, 1, "只应存在一行状态（跟踪键行），不得为具体 Tag 建出第二行");
  assert.equal(rows[0].ref, "", "状态键必须是空串（跟踪键）");
  assert.equal(rows[0].backed_up_commit_sha, RELEASE_SHA, "水位必须落在跟踪行上");
});

test("P0：水位守卫是必需的 —— 不带 repoRow 时具体 Tag 会落到错行（修复前的行为）", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { id: "r-noguard", trackMode: "release", trackRef: null });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();

  // 先按真实链路建出跟踪行（检测任务的第一件事就是 ensureDetectStates）
  await codeRepo.ensureDetectStates(repoRow.id, resolveTrackedRefKeys(repoRow));
  assert.equal(stateRows(db, repoRow.id).length, 1, "此时只有跟踪行 ref=''");

  // 刻意不传 repoRow：这正是修复前两个调用点的形态。
  // 本用例锁住「守卫为什么必须存在」—— 若哪天有人把 repoRow 参数去掉，
  // 下面这些断言会立刻失败，从而拦住回归。
  await advanceBackedUpWatermark(codeRepo, repoRow.id, "tag", RELEASE_TAG, RELEASE_SHA);

  const rows = stateRows(db, repoRow.id);
  assert.equal(rows.length, 2, "不带 repoRow 时会为具体 Tag 建出第二行 —— 这正是被修复的错位");
  const tracked = rows.find((r) => r.ref === "");
  const stray = rows.find((r) => r.ref === RELEASE_TAG);
  assert.equal(tracked.backed_up_commit_sha, null, "跟踪行拿不到水位 —— 于是每轮都判有更新");
  assert.equal(stray.backed_up_commit_sha, RELEASE_SHA, "水位落在了错行上");
});

test("P0：水位守卫不影响 branch 模式的多分支（精确匹配原样保留）", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { id: "r-branch", trackMode: "branch", refs: ["main", "develop"] });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();

  await advanceBackedUpWatermark(codeRepo, repoRow.id, "branch", "develop", sha("d"), { repoRow });

  const rows = stateRows(db, repoRow.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ref, "develop", "多分支下必须精确落在传进来的那个分支上，不能被收敛到别的分支");
  assert.equal(rows[0].backed_up_commit_sha, sha("d"));
});

// ==================== 3. v38 回填：必须按跟踪键落行 ====================

test("P0：v38 回填按跟踪键落行 —— Release 历史备份的水位不会落到具体 Tag 行", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedRepo(db, { id: "r-mig", trackMode: "release", trackRef: null });

  // 历史备份记录的 ref 存的是**具体 Tag**（provider 解析结果），不是跟踪键
  await seedBackup(db, { id: "bk-1", repositoryId: "r-mig", refType: "tag", ref: RELEASE_TAG, commitSha: RELEASE_SHA });

  await migrateRepoDetectStates(db);

  const rows = stateRows(db, "r-mig");
  assert.equal(rows.length, 1, "只应回填出跟踪键一行，不得回填出 ref='v9.9.9' 的错行");
  assert.equal(rows[0].ref_type, "tag");
  assert.equal(rows[0].ref, "", "回填的状态键必须是跟踪键（空串）");
  assert.equal(rows[0].backed_up_commit_sha, RELEASE_SHA, "水位应回填到跟踪行上");
});

test("P0：v38 回填把同一 Release 仓库的多条历史备份折叠到同一跟踪键（只取最近一条）", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedRepo(db, { id: "r-mig2", trackMode: "release", trackRef: null });

  // 三个历史版本：v1.0.0 → v2.0.0 → v9.9.9（时间递增）
  await seedBackup(db, { id: "bk-a", repositoryId: "r-mig2", ref: "v1.0.0", commitSha: sha("1"), at: "2026-01-01T00:00:00.000Z" });
  await seedBackup(db, { id: "bk-b", repositoryId: "r-mig2", ref: "v2.0.0", commitSha: sha("3"), at: "2026-02-01T00:00:00.000Z" });
  await seedBackup(db, { id: "bk-c", repositoryId: "r-mig2", ref: RELEASE_TAG, commitSha: RELEASE_SHA, at: "2026-03-01T00:00:00.000Z" });

  await migrateRepoDetectStates(db);

  const rows = stateRows(db, "r-mig2");
  // 折叠后落在同一个键上，因此只能有一行 —— 多于一行说明分组没按折叠后的键做（会撞唯一索引）
  assert.equal(rows.length, 1, "多条历史备份必须折叠到同一跟踪键上");
  assert.equal(rows[0].ref, "");
  assert.equal(rows[0].backed_up_commit_sha, RELEASE_SHA, "应取最近那一条成功备份作为水位");
});

test("P0：v38 回填不把留痕占位记录（unresolved-*）当成真实水位", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedRepo(db, { id: "r-mig3", trackMode: "release", trackRef: null });

  await seedBackup(db, { id: "bk-x", repositoryId: "r-mig3", ref: null, commitSha: "unresolved-abc123", status: "skipped" });

  await migrateRepoDetectStates(db);

  assert.equal(stateRows(db, "r-mig3").length, 0, "占位 commit 不是真实水位，不该回填出状态行");
});

test("P0：v38 回填不影响 branch 模式（分支名本身就是跟踪键）", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedRepo(db, { id: "r-mig4", trackMode: "branch", refs: ["main", "develop"] });

  await seedBackup(db, { id: "bk-m", repositoryId: "r-mig4", refType: "branch", ref: "main", commitSha: sha("a") });
  await seedBackup(db, { id: "bk-d", repositoryId: "r-mig4", refType: "branch", ref: "develop", commitSha: sha("d") });

  await migrateRepoDetectStates(db);

  const rows = stateRows(db, "r-mig4");
  assert.equal(rows.length, 2, "两个分支各得一行");
  assert.equal(rows.find((r) => r.ref === "main").backed_up_commit_sha, sha("a"));
  assert.equal(rows.find((r) => r.ref === "develop").backed_up_commit_sha, sha("d"));
});

// ==================== 4. v40 修复迁移：纠正已经错位的存量数据 ====================

test("P0：v40 修复 —— 错行水位搬回跟踪行，错行水位被清空", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedRepo(db, { id: "r-fix", trackMode: "release", trackRef: null });

  // 模拟「跑过错误 v38」之后的库：跟踪行没水位，错行有水位
  await seedDetectState(db, { id: "s-track", repositoryId: "r-fix", refType: "tag", ref: "", backedUpSha: null });
  await seedDetectState(db, {
    id: "s-stray",
    repositoryId: "r-fix",
    refType: "tag",
    ref: RELEASE_TAG,
    backedUpSha: RELEASE_SHA,
    backedUpAt: "2026-03-01T00:00:00.000Z",
  });

  const result = await repairReleaseTrackingKeys(db);
  assert.equal(result.moved, 1, "应搬移 1 行水位");
  assert.equal(result.cleared, 1, "应清理 1 行错行水位");

  const rows = stateRows(db, "r-fix");
  assert.equal(rows.find((r) => r.ref === "").backed_up_commit_sha, RELEASE_SHA, "水位应搬到跟踪行");
  assert.equal(rows.find((r) => r.ref === RELEASE_TAG).backed_up_commit_sha, null, "错行水位应被清空");
});

test("P0：v40 修复 —— 不覆盖跟踪行上更新（运行期已推进）的水位", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedRepo(db, { id: "r-newer", trackMode: "release", trackRef: null });

  const newerSha = sha("9");
  // 跟踪行已有运行期推进过的、更新的水位
  await seedDetectState(db, {
    id: "s-t",
    repositoryId: "r-newer",
    refType: "tag",
    ref: "",
    backedUpSha: newerSha,
    backedUpAt: "2026-04-01T00:00:00.000Z",
  });
  // 错行是更旧的水位
  await seedDetectState(db, {
    id: "s-s",
    repositoryId: "r-newer",
    refType: "tag",
    ref: "v1.0.0",
    backedUpSha: sha("1"),
    backedUpAt: "2026-01-01T00:00:00.000Z",
  });

  await repairReleaseTrackingKeys(db);

  const rows = stateRows(db, "r-newer");
  assert.equal(rows.find((r) => r.ref === "").backed_up_commit_sha, newerSha, "跟踪行的更新水位不得被旧错行覆盖");
  assert.equal(rows.find((r) => r.ref === "v1.0.0").backed_up_commit_sha, null);
});

test("P0：v40 修复 —— 可重入，且不碰 branch 模式", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedRepo(db, { id: "r-re", trackMode: "release", trackRef: null });
  await seedRepo(db, { id: "r-br", trackMode: "branch", refs: ["main"] });

  await seedDetectState(db, { id: "s1", repositoryId: "r-re", refType: "tag", ref: "", backedUpSha: null });
  await seedDetectState(db, { id: "s2", repositoryId: "r-re", refType: "tag", ref: RELEASE_TAG, backedUpSha: RELEASE_SHA });
  // branch 行：ref 就是跟踪键，不该被当成错行
  await seedDetectState(db, { id: "s3", repositoryId: "r-br", refType: "branch", ref: "main", backedUpSha: sha("a") });

  await repairReleaseTrackingKeys(db);
  const again = await repairReleaseTrackingKeys(db);

  assert.equal(again.moved, 0, "重跑不应再搬（跟踪行已有水位）");
  assert.equal(again.cleared, 0, "重跑不应再清（错行水位已是 NULL）");
  assert.equal(stateRows(db, "r-br")[0].backed_up_commit_sha, sha("a"), "branch 模式一行都不该动");
});

test("P0：v40 修复 —— 没有 Release 仓库时是空操作", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedRepo(db, { id: "r-only-branch", trackMode: "branch", refs: ["main"] });

  const result = await repairReleaseTrackingKeys(db);
  assert.deepEqual(result, { ok: true, moved: 0, cleared: 0 });
});

// ==================== 5. 端到端：Release 空 Tag 连续 3 轮只备份一次 ====================

test("P0 验收：Release 空 Tag 连续 3 轮只创建 1 个备份任务，且水位正确推进", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { id: "r3", trackMode: "release", trackRef: null });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();
  const responder = releaseResponder();

  // ---------- 第 1 轮：检测到更新 → 创建 1 个备份任务 ----------
  const round1Jobs = backupJobs(await runCheck(db, repoRow, responder));
  assert.equal(round1Jobs.length, 1, "第 1 轮应创建 1 个备份任务");

  // 关键：payload 必须带跟踪键，且展示引用仍是具体 Tag（两者不能混用）
  const ref0 = round1Jobs[0].payload.refs[0];
  assert.equal(ref0.ref, RELEASE_TAG, "展示引用应是 provider 解析出的具体 Tag");
  assert.equal(ref0.trackingRef, null, "跟踪键应是 null（对应状态键空串），不能是具体 Tag");
  assert.equal(ref0.trackingRefType, "tag");

  // 模拟备份任务成功后的水位推进：完全按备份执行器的调用形态（传 trackingRef + repoRow）
  await advanceBackedUpWatermark(codeRepo, repoRow.id, ref0.trackingRefType, ref0.trackingRef, ref0.commitSha, {
    repoRow,
    markDetected: true,
  });

  const afterRound1 = stateRows(db, repoRow.id);
  assert.equal(afterRound1.length, 1, "全程只应有一行状态（跟踪键行）");
  assert.equal(afterRound1[0].ref, "");
  assert.equal(afterRound1[0].backed_up_commit_sha, RELEASE_SHA, "水位应推进到跟踪行");

  // ---------- 第 2、3 轮：版本未变 → 不得再创建备份任务 ----------
  for (const round of [2, 3]) {
    makeDueAgain(db, repoRow.id);
    const jobs = backupJobs(await runCheck(db, repoRow, responder));
    assert.equal(jobs.length, 0, `第 ${round} 轮版本未变却又创建了备份任务 —— 永久空转`);
  }

  // 三轮之后状态键仍未分裂，水位仍指向同一个 commit
  const finalRows = stateRows(db, repoRow.id);
  assert.equal(finalRows.length, 1);
  assert.equal(finalRows[0].backed_up_commit_sha, RELEASE_SHA);
});

test("P0 验收：Release 空 Tag 的顶部结论能从「有更新」收敛到「已是最新」", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { id: "r-conv", trackMode: "release", trackRef: null });

  // 第 1 轮：检测到更新
  const jobs = backupJobs(await runCheck(db, repoRow, releaseResponder()));
  const detected = await db
    .prepare(`SELECT commit_sha, backed_up_commit_sha FROM repo_detect_states WHERE repository_id = ? AND ref = ''`)
    .bind(repoRow.id)
    .first();
  assert.equal(detected.commit_sha, RELEASE_SHA);
  assert.equal(detected.backed_up_commit_sha, null, "刚检测完还没备份，水位为空 → 判「有更新」");

  // 备份成功后水位跟上 → 该引用应判「已是最新」
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();
  await advanceBackedUpWatermark(codeRepo, repoRow.id, "tag", jobs[0].payload.refs[0].trackingRef, RELEASE_SHA, {
    repoRow,
    markDetected: true,
  });

  const settled = await db
    .prepare(`SELECT commit_sha, backed_up_commit_sha FROM repo_detect_states WHERE repository_id = ? AND ref = ''`)
    .bind(repoRow.id)
    .first();
  assert.equal(settled.commit_sha, settled.backed_up_commit_sha, "水位与检测结果一致 → 判定收敛为「已是最新」");
});

// ==================== 6. 端到端：旧数据迁移后不重复备份 ====================

test("P0 验收：v38 回填后旧 Release 仓库首轮即判「无更新」，不重复备份", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { id: "r-old", trackMode: "release", trackRef: null });

  // 升级前的历史：这个版本已经成功备份过（ref 存的是具体 Tag）
  await seedBackup(db, { id: "bk-old", repositoryId: "r-old", refType: "tag", ref: RELEASE_TAG, commitSha: RELEASE_SHA });

  // 升级：v38 回填水位（修复后按跟踪键落行）
  await migrateRepoDetectStates(db);
  assert.equal(stateRows(db, "r-old")[0].backed_up_commit_sha, RELEASE_SHA);

  // 首轮检测：远端仍是同一个 tag/commit → 应判「无更新」，不创建备份任务
  const jobs = backupJobs(await runCheck(db, repoRow, releaseResponder()));
  assert.equal(jobs.length, 0, "迁移后旧 Release 仓库不得重复备份同一个版本");
});

test("P0 验收：v40 修复后，已经错位的存量库下一轮不再重复备份", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { id: "r-broken", trackMode: "release", trackRef: null });

  // 模拟「跑过错误 v38 + 运行期又写过错行」的真实存量状态：
  // 跟踪行没水位，错行有水位 —— 修复前每轮都会判有更新
  await seedBackup(db, { id: "bk-broken", repositoryId: "r-broken", refType: "tag", ref: RELEASE_TAG, commitSha: RELEASE_SHA });
  await seedDetectState(db, { id: "b-track", repositoryId: "r-broken", refType: "tag", ref: "", backedUpSha: null });
  await seedDetectState(db, { id: "b-stray", repositoryId: "r-broken", refType: "tag", ref: RELEASE_TAG, backedUpSha: RELEASE_SHA });

  // 修复迁移：把错行水位搬回跟踪行
  await repairReleaseTrackingKeys(db);

  const jobs = backupJobs(await runCheck(db, repoRow, releaseResponder()));
  assert.equal(jobs.length, 0, "错位修复后应立刻判「无更新」，不再空转重复备份");
});
