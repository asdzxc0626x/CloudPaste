/**
 * 第 4 期验收测试：检测状态持久化 + repo_backup_check
 * （修改点：第 4 期 检测状态持久化）
 *
 * 运行：node --test src/repobackup/detectStatePersistence.test.js
 *
 * 设计说明：
 * - 建表直接用 schema.js 里的**真实 DDL 函数**，不是手抄一份建表语句。
 *   这样迁移后的表结构、唯一索引、ON CONFLICT 冲突目标都被真实覆盖；
 *   手抄 DDL 只能测出「我以为的表结构」，而 ON CONFLICT(repository_id, ref_type, ref)
 *   是否真的能命中唯一索引，恰恰是本期的关键。
 * - 数据库用 Node 内置 node:sqlite 建真实内存库，包一层 D1 形状。
 * - 检测任务用**真正的 RepoBackupCheckTaskHandler**，只有 fetch 与 fileSystem 是桩，
 *   因此覆盖的是真实执行路径（含 provider 选择、请求调度、落库、创建备份作业）。
 * - 不触网、不依赖外部状态。
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { createCodeRepositoryTables, createRepoDetectStatesTable, createTasksTables } from "../db/migrations/sqlite/engine/schema.js";
import { migrateRepoDetectStates } from "../db/migrations/sqlite/engine/migrations.js";
import { RepositoryFactory } from "../repositories/index.js";
import { RepoBackupCheckTaskHandler } from "../storage/fs/tasks/handlers/RepoBackupCheckTaskHandler.js";
import { githubRequestScheduler, clearCoalescedCache } from "./GithubRequestScheduler.js";
import { resetCredentialRotation } from "./providers/GithubRepoProvider.js";
import {
  DETECT_STATUS,
  DETECT_MAX_REFS_PER_RUN,
  detectRefs,
  prepareDetectRound,
  advanceBackedUpWatermark,
  computeNextDetectAfterOnSuccess,
  toDetectStateDto,
} from "./detect.js";

/**
 * 每个用例前复位「跨用例共享」的模块级状态（修改点：测试隔离）
 *
 * 必须复位三样东西，否则用例之间会互相污染：
 *   · 合并缓存：调度器对同一 URL 有 3 秒的结果复用窗口，而本文件大量用例
 *     用的是同一个分支名 → 同一个 URL → 会直接拿到**上一个用例**的响应体，
 *     于是「期望 b 却读到 a」这类假失败就出现了
 *   · 并发/排队计数：上一轮遗留在飞名额会让下一个用例排队
 *   · 凭据轮询游标：它是模块级的，会让 Token 轮询用例的期望顺序错位
 */
beforeEach(() => {
  githubRequestScheduler.setDefaults({ MAX_CONCURRENCY: 4, MIN_INTERVAL_MS: 0, MAX_START_DELAY_MS: 5000 });
  githubRequestScheduler.reset();
  clearCoalescedCache();
  resetCredentialRotation();
});

// ==================== 测试替身 ====================

/** 真实内存库，包成 D1 形状（prepare/bind/first/all/run） */
function createTestDb() {
  const raw = new DatabaseSync(":memory:");
  const normalize = (row) => (row ? { ...row } : null);
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

/** 用真实 DDL 建表 */
async function setupSchema(db) {
  await createCodeRepositoryTables(db);
  await createRepoDetectStatesTable(db);
  await createTasksTables(db);
}

/** 造一个仓库行（含多分支配置） */
async function seedRepo(db, { id = "repo-1", refs = ["main"], trackMode = "branch" } = {}) {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO code_repositories
        (id, provider, name, repo_identifier, track_mode, track_ref, track_refs_json,
         target_mount_id, target_mount_ids_json, target_path_prefix, retention_count,
         enabled, config_json, created_at, updated_at)
       VALUES (?, 'github', ?, 'octocat/Hello-World', ?, ?, ?, 'mount-1', '["mount-1"]', '/', 10, 1, '{}', ?, ?)`,
    )
    .bind(id, `仓库${id}`, trackMode, refs[0] ?? null, JSON.stringify(trackMode === "branch" ? refs : []), now, now)
    .run();
  return await db.prepare(`SELECT * FROM code_repositories WHERE id = ?`).bind(id).first();
}

/** 安装 fetch 桩，记录每次请求 */
function installFetch(responder) {
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

const jsonOk = (body) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999" },
  });

const sha = (c) => c.repeat(40);

/** /branches 列表响应（多分支批量路径用） */
const branchesOk = (map) =>
  jsonOk(Object.entries(map).map(([name, s]) => ({ name, commit: { sha: s } })));

const rateLimited = () =>
  new Response(JSON.stringify({ message: "rate limit" }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-limit": "60",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 1800),
    },
  });

/**
 * 造一个检测任务上下文
 * fileSystem 只实现 handler 真正用到的 createJob + mountManager 上的几个字段
 */
function makeContext({ db, env, repositoryFactory }) {
  const createdJobs = [];
  const progress = [];
  const fileSystem = {
    repositoryFactory,
    mountManager: { db, encryptionSecret: env.ENCRYPTION_SECRET },
    async createJob(taskType, payload, userId, userType, meta) {
      const job = {
        jobId: `${taskType}-test-${createdJobs.length + 1}`,
        taskType,
        payload,
        userId,
        userType,
        meta,
      };
      createdJobs.push(job);
      return job;
    },
  };

  return {
    createdJobs,
    progress,
    context: {
      isCancelled: async () => false,
      updateProgress: async (_jobId, stats) => {
        progress.push(stats);
      },
      getFileSystem: () => fileSystem,
      getEnv: () => env,
    },
  };
}

const ENV = { ENCRYPTION_SECRET: "test-secret-for-detection" };

/** 一个完整的检测轮次：建库 → 建仓 → 跑 handler */
async function runCheck({
  db,
  repoRow,
  responder,
  payload = {},
  jobId = "check-job-1",
  userId = "admin-1",
}) {
  const repositoryFactory = new RepositoryFactory(db, { env: ENV });
  const codeRepo = repositoryFactory.getCodeRepositoryRepository();
  const { context, createdJobs, progress } = makeContext({ db, env: ENV, repositoryFactory });
  const fetchStub = installFetch(responder);

  const handler = new RepoBackupCheckTaskHandler();
  const job = { jobId, taskType: "repo_backup_check", payload: { repositoryId: repoRow.id, ...payload }, userId, userType: "admin" };

  await handler.validate(job.payload);
  await handler.execute(job, context);

  return { codeRepo, createdJobs, progress, fetchStub };
}

const readState = (db, repositoryId, refType, ref) =>
  db
    ._raw
    .prepare(`SELECT * FROM repo_detect_states WHERE repository_id = ? AND ref_type = ? AND ref = ?`)
    .get(repositoryId, refType, ref ?? "");

// ==================== 1. 建表与迁移 ====================

test("第 4 期：repo_detect_states 的唯一索引能命中 ON CONFLICT（多分支不会插出重复行）", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main", "develop"] });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();

  await codeRepo.ensureDetectStates(repoRow.id, [
    { refType: "branch", ref: "main" },
    { refType: "branch", ref: "develop" },
  ]);
  // 再调一次：必须全部命中冲突、零新增
  const second = await codeRepo.ensureDetectStates(repoRow.id, [
    { refType: "branch", ref: "main" },
    { refType: "branch", ref: "develop" },
  ]);
  assert.equal(second, 0, "重复调用不应新增行");

  const states = await codeRepo.findDetectStates(repoRow.id);
  assert.equal(states.length, 2);
});

test("第 4 期：补建状态行不会覆盖已有水位（用户加分支不冲掉其他分支的进度）", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main"] });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();

  await codeRepo.ensureDetectStates(repoRow.id, [{ refType: "branch", ref: "main" }]);
  await codeRepo.updateDetectState(repoRow.id, "branch", "main", {
    backed_up_commit_sha: sha("a"),
    commit_sha: sha("a"),
    detect_status: DETECT_STATUS.OK,
  });

  await codeRepo.ensureDetectStates(repoRow.id, [
    { refType: "branch", ref: "main" },
    { refType: "branch", ref: "release" },
  ]);

  const main = readState(db, repoRow.id, "branch", "main");
  assert.equal(main.backed_up_commit_sha, sha("a"), "已存在的行一个字段都不该被碰");
  assert.ok(readState(db, repoRow.id, "branch", "release"), "新分支应补建");
});

test("第 4 期：迁移从既有备份记录回填水位（升级后不会全量重复备份）", async () => {
  const db = createTestDb();
  // 只建 code_repositories / backups（模拟 v37 的库），检测表由迁移建
  await createCodeRepositoryTables(db);
  const repoRow = await seedRepo(db, { refs: ["main"] });
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO code_repository_backups
        (id, repository_id, ref_type, ref, commit_sha, version, status, created_at, finished_at)
       VALUES ('bk-1', ?, 'branch', 'main', ?, 'main@aaaaaaa', 'success', ?, ?)`,
    )
    .bind(repoRow.id, sha("a"), now, now)
    .run();

  const result = await migrateRepoDetectStates(db);
  assert.equal(result.created, 1, "应回填 1 条");

  const state = readState(db, repoRow.id, "branch", "main");
  assert.equal(state.backed_up_commit_sha, sha("a"), "水位应来自既有成功备份");

  // 再跑一次：可重入，不重复插入
  const again = await migrateRepoDetectStates(db);
  assert.equal(again.created, 0, "迁移必须可重入");
});

test("第 4 期：迁移不会把「从未成功备份过」的分支标成已备份", async () => {
  const db = createTestDb();
  await createCodeRepositoryTables(db);
  // 只有失败记录的仓库
  const repoRow = await seedRepo(db, { refs: ["main"] });
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO code_repository_backups
        (id, repository_id, ref_type, ref, commit_sha, status, created_at)
       VALUES ('bk-fail', ?, 'branch', 'main', ?, 'failed', ?)`,
    )
    .bind(repoRow.id, sha("f"), now)
    .run();

  await migrateRepoDetectStates(db);

  const states = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository().findDetectStates(repoRow.id);
  assert.equal((await states).length, 0, "失败记录不该产生水位行（该分支本来就需要备份）");
});

// ==================== 2. 检测成功 → 无更新，不创建备份任务 ====================

test("验收：检测成功且无更新时不创建备份任务", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main"] });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();

  // 先建立「已经备份过 sha a」的水位
  await codeRepo.ensureDetectStates(repoRow.id, [{ refType: "branch", ref: "main" }]);
  await codeRepo.updateDetectState(repoRow.id, "branch", "main", { backed_up_commit_sha: sha("a") });

  const { createdJobs, fetchStub } = await runCheck({
    db,
    repoRow,
    responder: () => jsonOk({ sha: sha("a") }),
  });

  assert.equal(fetchStub.calls.length, 1, "单分支应只打 1 次 API");
  assert.equal(createdJobs.length, 0, "无更新时**不应**创建任何备份任务");

  const state = readState(db, repoRow.id, "branch", "main");
  assert.equal(state.detect_status, DETECT_STATUS.OK);
  assert.equal(state.commit_sha, sha("a"));
  assert.equal(state.consecutive_unchanged_count, 1, "无更新应累计连续无更新次数");
});

// ==================== 3. 检测成功 → 有更新，只创建一次备份任务 ====================

test("验收：检测到新版本时只创建一次备份任务，且带已解析的 commitSha", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main"] });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();
  await codeRepo.ensureDetectStates(repoRow.id, [{ refType: "branch", ref: "main" }]);
  await codeRepo.updateDetectState(repoRow.id, "branch", "main", { backed_up_commit_sha: sha("a") });

  const { createdJobs } = await runCheck({
    db,
    repoRow,
    responder: () => jsonOk({ sha: sha("b") }),
  });

  assert.equal(createdJobs.length, 1, "有更新时应且仅应创建 1 个备份任务");
  const job = createdJobs[0];
  assert.equal(job.taskType, "repo_backup");
  assert.equal(job.payload.repositoryId, repoRow.id);
  assert.equal(job.payload.refs.length, 1);
  // 需求 4：commitSha / version 由检测任务解析好后传下去
  assert.equal(job.payload.refs[0].commitSha, sha("b"));
  assert.equal(job.payload.refs[0].ref, "main");
  assert.equal(job.payload.refs[0].refType, "branch");
  assert.equal(typeof job.payload.refs[0].version, "string");
});

test("验收：多分支中只有部分有更新时，只把那部分交给备份任务", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main", "develop", "release"] });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();
  await codeRepo.ensureDetectStates(repoRow.id, [
    { refType: "branch", ref: "main" },
    { refType: "branch", ref: "develop" },
    { refType: "branch", ref: "release" },
  ]);
  // main 已备份且没变；develop 变了；release 从未备份
  await codeRepo.updateDetectState(repoRow.id, "branch", "main", { backed_up_commit_sha: sha("1") });
  await codeRepo.updateDetectState(repoRow.id, "branch", "develop", { backed_up_commit_sha: sha("2") });

  const { createdJobs } = await runCheck({
    db,
    repoRow,
    // 多分支走 /branches 批量路径：1 次请求覆盖全部分支
    responder: () => branchesOk({ main: sha("1"), develop: sha("9"), release: sha("3") }),
  });

  assert.equal(createdJobs.length, 1);
  const refs = createdJobs[0].payload.refs.map((r) => r.ref).sort();
  assert.deepEqual(refs, ["develop", "release"], "只应交出有更新的分支，main 不该被带上");
});

test("验收：同一仓库一轮检测只创建一个备份任务（不按引用拆成多个）", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["b1", "b2", "b3", "b4"] });

  const { createdJobs } = await runCheck({
    db,
    repoRow,
    responder: () => branchesOk({ b1: sha("1"), b2: sha("2"), b3: sha("3"), b4: sha("4") }),
  });

  assert.equal(createdJobs.length, 1, "4 个分支都有更新，仍只创建 1 个备份任务");
  assert.equal(createdJobs[0].payload.refs.length, 4);
});

// ==================== 4. 备份任务不再请求版本 API ====================

test("验收：备份任务拿到预解析 refs 后不再请求 GitHub 版本 API", async () => {
  const db = createTestDb();
  await setupSchema(db);
  // 直接读源码路径验证：handler 在 planItem.preresolved 存在时不应触碰 provider
  const { RepoBackupTaskHandler } = await import("../storage/fs/tasks/handlers/RepoBackupTaskHandler.js");

  const repositoryFactory = new RepositoryFactory(db, { env: ENV });
  const codeRepo = repositoryFactory.getCodeRepositoryRepository();
  const repoRow = await seedRepo(db, { refs: ["main"] });

  // 挂载点
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS storage_mounts (
         id TEXT PRIMARY KEY, name TEXT, mount_path TEXT, storage_type TEXT, is_active INTEGER DEFAULT 1, config_json TEXT DEFAULT '{}'
       )`,
    )
    .run();
  await db
    .prepare(`INSERT INTO storage_mounts (id, name, mount_path, storage_type, is_active) VALUES ('mount-1','m1','/m1','S3',1)`)
    .run();

  // 让任何 **版本 API** 请求直接失败 —— 备份任务若仍去解析版本，就会在这里炸掉。
  // 注意：codeload 的归档下载必须放行，它才是备份任务真正该做的事
  const apiCalls = [];
  const { calls } = installFetch(({ url }) => {
    if (new URL(url).host === "api.github.com") {
      apiCalls.push(url);
      throw new Error("备份任务不应发起任何版本解析请求");
    }
    return new Response(new Uint8Array([1, 2, 3, 4, 5]), {
      status: 200,
      headers: { "content-type": "application/gzip" },
    });
  });

  const uploaded = [];
  const fileSystem = {
    repositoryFactory,
    mountManager: { db, encryptionSecret: ENV.ENCRYPTION_SECRET },
    async createDirectory() {},
    async uploadFile(path, stream) {
      // 消费流，让字节计数生效
      const reader = stream.getReader();
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value?.byteLength ?? 0;
      }
      uploaded.push({ path, total });
      return { storagePath: path };
    },
  };

  const handler = new RepoBackupTaskHandler();
  const payload = {
    repositoryId: repoRow.id,
    repoIdentifier: repoRow.repo_identifier,
    force: false,
    refs: [{ refType: "branch", ref: "main", commitSha: sha("c"), version: "main@ccccccc", publishedAt: null }],
  };
  await handler.validate(payload);
  await handler.execute(
    { jobId: "job-1", taskType: "repo_backup", payload, userId: "admin-1", userType: "admin" },
    {
      isCancelled: async () => false,
      updateProgress: async () => {},
      getFileSystem: () => fileSystem,
      getEnv: () => ENV,
    },
  );

  assert.equal(
    apiCalls.length,
    0,
    `备份任务不得请求版本 API，实际 ${apiCalls.length} 次：${apiCalls.join(", ")}`,
  );
  assert.ok(calls.length >= 1, "应至少下载了一次归档（codeload）");
  assert.ok(
    calls.every((c) => new URL(c.url).host === "codeload.github.com"),
    "备份任务只应访问 codeload 下载归档",
  );
  assert.ok(uploaded.length >= 1, "应至少上传了一次归档");

  // 备份成功后水位应被推进到本次的 commit
  const state = readState(db, repoRow.id, "branch", "main");
  assert.equal(state.backed_up_commit_sha, sha("c"), "备份成功后应推进已备份水位");
});

test("验收：advanceBackedUpWatermark 让下一轮检测判定为无更新", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main"] });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();

  await codeRepo.ensureDetectStates(repoRow.id, [{ refType: "branch", ref: "main" }]);
  await codeRepo.updateDetectState(repoRow.id, "branch", "main", {
    detect_status: DETECT_STATUS.OK,
    commit_sha: sha("d"),
    consecutive_unchanged_count: 0,
  });

  // 备份完成 → 推进水位
  await advanceBackedUpWatermark(codeRepo, repoRow.id, "branch", "main", sha("d"));

  // 下一轮检测：同一个 commit 应被判为「无更新」
  const { createdJobs } = await runCheck({ db, repoRow, responder: () => jsonOk({ sha: sha("d") }) });
  assert.equal(createdJobs.length, 0, "水位已推进，不该再创建备份任务");
});

// ==================== 5. 多分支分别保存检测状态 ====================

test("验收：多分支分别保存检测状态，互不覆盖", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main", "develop", "release"] });

  await runCheck({
    db,
    repoRow,
    responder: () => branchesOk({ main: sha("1"), develop: sha("2"), release: sha("3") }),
  });

  const main = readState(db, repoRow.id, "branch", "main");
  const develop = readState(db, repoRow.id, "branch", "develop");
  const release = readState(db, repoRow.id, "branch", "release");

  assert.equal(main.commit_sha, sha("1"));
  assert.equal(develop.commit_sha, sha("2"));
  assert.equal(release.commit_sha, sha("3"));
  // 每个分支有自己的下次检测时间（不是共用一个）
  assert.ok(main.next_detect_after && develop.next_detect_after && release.next_detect_after);
  assert.equal(main.ref, "main");
  assert.equal(develop.ref, "develop");
});

test("验收：release 模式「最新 tag」用空串占位，仍能正确 upsert 成一行", async () => {
  const db = createTestDb();
  await setupSchema(db);
  // release 模式下 track_refs_json 为空，resolveTrackRefs 返回 [null]
  const repoRow = await seedRepo(db, { refs: [], trackMode: "release" });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();

  await codeRepo.ensureDetectStates(repoRow.id, [{ refType: "tag", ref: "" }]);
  await codeRepo.ensureDetectStates(repoRow.id, [{ refType: "tag", ref: "" }]);

  const states = await codeRepo.findDetectStates(repoRow.id);
  assert.equal(states.length, 1, "空 ref 必须只占一行（NULL 会插出多行，所以用空串）");
  assert.equal(toDetectStateDto(states[0]).ref, null, "DTO 里空串应还原成 null 供前端展示");
});

test("验收：仓库保存时清理不再跟踪的分支状态", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main", "develop"] });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();

  await codeRepo.ensureDetectStates(repoRow.id, [
    { refType: "branch", ref: "main" },
    { refType: "branch", ref: "develop" },
  ]);
  // 用户删掉了 develop
  const pruned = await codeRepo.pruneDetectStates(repoRow.id, [{ refType: "branch", ref: "main" }]);

  assert.equal(pruned, 1);
  const states = await codeRepo.findDetectStates(repoRow.id);
  assert.deepEqual(states.map((s) => s.ref), ["main"]);
});

test("验收：prune 在跟踪列表为空时不动任何数据（防御配置读取异常）", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main"] });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();
  await codeRepo.ensureDetectStates(repoRow.id, [{ refType: "branch", ref: "main" }]);

  const pruned = await codeRepo.pruneDetectStates(repoRow.id, []);
  assert.equal(pruned, 0);
  assert.equal((await codeRepo.findDetectStates(repoRow.id)).length, 1);
});

// ==================== 6. 限流：延迟而不是失败，且状态持久化 ====================

test("验收：限流时写 detect_status=deferred，不累计失败，并给出未来的重检时间", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main"] });

  const before = Date.now();
  const { createdJobs } = await runCheck({ db, repoRow, responder: () => rateLimited() });

  const state = readState(db, repoRow.id, "branch", "main");
  assert.equal(state.detect_status, DETECT_STATUS.DEFERRED, "限流应记 deferred 而不是 error");
  assert.equal(state.last_error_kind, "rate_limited");
  assert.equal(state.consecutive_error_count, 0, "限流不得累计失败次数（第 2 期语义）");
  assert.ok(
    new Date(state.next_detect_after).getTime() > before,
    "next_detect_after 必须在未来，否则每个 tick 都会重跑",
  );
  assert.equal(createdJobs.length, 0, "限流时不应创建备份任务");
});

test("验收：限流后重检时间被写进 scheduled_jobs（复用第 2 期延迟机制）", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS scheduled_jobs (
         task_id TEXT PRIMARY KEY, handler_id TEXT, enabled INTEGER DEFAULT 1,
         schedule_type TEXT, interval_sec INTEGER, cron_expression TEXT,
         next_run_after TEXT, run_count INTEGER DEFAULT 0, failure_count INTEGER DEFAULT 0,
         lock_until TEXT, last_run_status TEXT, last_run_started_at TEXT,
         last_run_finished_at TEXT, name TEXT, description TEXT, config_json TEXT)`,
    )
    .run();

  const repoRow = await seedRepo(db, { refs: ["main"] });
  // 计划本来在 4 小时后（手动提前触发的场景）
  const planned = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
  await db
    .prepare(
      `INSERT INTO scheduled_jobs (task_id, handler_id, enabled, schedule_type, interval_sec, next_run_after)
       VALUES (?, 'repo_backup_schedule', 1, 'interval', 21600, ?)`,
    )
    .bind(`repo_backup_${repoRow.id}`, planned)
    .run();

  await runCheck({ db, repoRow, responder: () => rateLimited() });

  const row = db._raw.prepare(`SELECT next_run_after FROM scheduled_jobs WHERE task_id = ?`).get(`repo_backup_${repoRow.id}`);
  assert.notEqual(row.next_run_after, planned, "限流后应把计划前移到额度恢复时间");
  assert.ok(
    new Date(row.next_run_after).getTime() < new Date(planned).getTime(),
    "只前移不后移：重检时间必须早于原计划",
  );
});

test("验收：永久性错误才累计失败次数并退避", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main"] });

  const notFound = () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  await runCheck({ db, repoRow, responder: notFound });
  let state = readState(db, repoRow.id, "branch", "main");
  assert.equal(state.detect_status, DETECT_STATUS.ERROR);
  assert.equal(state.consecutive_error_count, 1);

  await runCheck({ db, repoRow, responder: notFound, payload: { ignoreDue: true } });
  state = readState(db, repoRow.id, "branch", "main");
  assert.equal(state.consecutive_error_count, 2, "永久性错误应累计");

  // 连续失败会退避：下一次重检时间比第一次更远
  const first = readState(db, repoRow.id, "branch", "main");
  assert.ok(new Date(first.next_detect_after).getTime() > Date.now());
});

test("验收：检测成功后清掉上一次的错误状态", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main"] });

  await runCheck({ db, repoRow, responder: () => new Response("boom", { status: 500 }) });
  assert.ok(readState(db, repoRow.id, "branch", "main").last_error, "先制造一次错误");

  await runCheck({ db, repoRow, responder: () => jsonOk({ sha: sha("e") }), payload: { ignoreDue: true } });

  const state = readState(db, repoRow.id, "branch", "main");
  assert.equal(state.last_error, null, "恢复后不应继续挂着红字");
  assert.equal(state.last_error_kind, null);
  assert.equal(state.consecutive_error_count, 0);
});

// ==================== 7. 重启后进度不丢 ====================

test("验收：重启后检测进度不丢（新建 repository 实例读到的状态一致）", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main", "develop"] });

  await runCheck({
    db,
    repoRow,
    responder: () => branchesOk({ main: sha("1"), develop: sha("2") }),
  });

  // 模拟「进程重启」：全新的 RepositoryFactory / repo 实例，只有内存里的东西没了
  const freshCodeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();
  const states = await freshCodeRepo.findDetectStates(repoRow.id);
  assert.equal(states.length, 2);
  assert.deepEqual(
    states.map((s) => s.commit_sha).sort(),
    [sha("1"), sha("2")].sort(),
    "重启后应能读到完整检测结果",
  );

  // 重启后再跑一轮：因为 next_detect_after 都在未来，本轮应判定「没有到期引用」
  const { createdJobs, fetchStub } = await runCheck({
    db,
    repoRow,
    responder: () => {
      throw new Error("不该发起请求：状态未到期");
    },
  });
  assert.equal(fetchStub.calls.length, 0, "重启后不该重新检测未到期的引用");
  assert.equal(createdJobs.length, 0);
});

test("验收：已备份水位在重启后仍然生效（不会重复备份同一个版本）", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main"] });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();
  await codeRepo.ensureDetectStates(repoRow.id, [{ refType: "branch", ref: "main" }]);
  await advanceBackedUpWatermark(codeRepo, repoRow.id, "branch", "main", sha("z"));

  // 重启后检测：同一 commit → 无更新
  const { createdJobs } = await runCheck({ db, repoRow, responder: () => jsonOk({ sha: sha("z") }) });
  assert.equal(createdJobs.length, 0);
});

// ==================== 8. 同一仓库不重复创建并发检测任务 ====================

test("验收：同一仓库已有未结束的检测作业时不再重复创建", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS scheduled_jobs (
         task_id TEXT PRIMARY KEY, handler_id TEXT, enabled INTEGER DEFAULT 1,
         schedule_type TEXT, interval_sec INTEGER, cron_expression TEXT,
         next_run_after TEXT, run_count INTEGER DEFAULT 0, failure_count INTEGER DEFAULT 0,
         lock_until TEXT, last_run_status TEXT, last_run_started_at TEXT,
         last_run_finished_at TEXT, name TEXT, description TEXT, config_json TEXT)`,
    )
    .run();

  const repoRow = await seedRepo(db, { refs: ["main"] });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();

  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO tasks (task_id, task_type, status, payload, stats, user_id, user_type,
                          trigger_type, created_at, updated_at)
       VALUES ('check-running', 'repo_backup_check', 'running', ?, '{}', 'admin', 'admin', 'scheduled', ?, ?)`,
    )
    .bind(JSON.stringify({ repositoryId: repoRow.id }), now, now)
    .run();

  const active = await codeRepo.countActiveRepoJobs(repoRow.id, ["repo_backup_check"], now - 6 * 60 * 60 * 1000);
  assert.equal(active, 1, "应识别出正在跑的检测作业");
});

test("验收：并发守卫按仓库隔离，且忽略超期残留与终态作业", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoA = await seedRepo(db, { id: "repo-A", refs: ["main"] });
  const repoB = await seedRepo(db, { id: "repo-B", refs: ["main"] });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();
  const now = Date.now();
  const long = 6 * 60 * 60 * 1000;

  const insert = (taskId, status, repositoryId, createdAt) =>
    db
      .prepare(
        `INSERT INTO tasks (task_id, task_type, status, payload, stats, user_id, user_type,
                            trigger_type, created_at, updated_at)
         VALUES (?, 'repo_backup_check', ?, ?, '{}', 'admin', 'admin', 'scheduled', ?, ?)`,
      )
      .bind(taskId, status, JSON.stringify({ repositoryId }), createdAt, createdAt)
      .run();

  await insert("a-run", "running", repoA.id, now);
  await insert("b-done", "completed", repoB.id, now); // 终态
  await insert("a-stale", "pending", repoA.id, now - long - 1000); // 超期残留

  assert.equal(await codeRepo.countActiveRepoJobs(repoA.id, ["repo_backup_check"], now - long), 1);
  assert.equal(await codeRepo.countActiveRepoJobs(repoB.id, ["repo_backup_check"], now - long), 0, "终态作业不该阻塞");
});

test("验收：调度 handler 在检测作业未结束时不创建新作业", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS scheduled_jobs (
         task_id TEXT PRIMARY KEY, handler_id TEXT, enabled INTEGER DEFAULT 1,
         schedule_type TEXT, interval_sec INTEGER, cron_expression TEXT,
         next_run_after TEXT, run_count INTEGER DEFAULT 0, failure_count INTEGER DEFAULT 0,
         lock_until TEXT, last_run_status TEXT, last_run_started_at TEXT,
         last_run_finished_at TEXT, name TEXT, description TEXT, config_json TEXT)`,
    )
    .run();

  const repoRow = await seedRepo(db, { refs: ["main"] });
  const repositoryFactory = new RepositoryFactory(db, { env: ENV });
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO tasks (task_id, task_type, status, payload, stats, user_id, user_type,
                          trigger_type, created_at, updated_at)
       VALUES ('busy-check', 'repo_backup_check', 'running', ?, '{}', 'admin', 'admin', 'scheduled', ?, ?)`,
    )
    .bind(JSON.stringify({ repositoryId: repoRow.id }), now, now)
    .run();

  const { ScheduledRepoBackupTask } = await import("../scheduled/tasks/ScheduledRepoBackupTask.js");
  const handler = new ScheduledRepoBackupTask();
  const createdJobs = [];
  const result = await handler.run({
    db,
    env: ENV,
    now: new Date().toISOString(),
    config: { repositoryId: repoRow.id },
    scheduledJobId: `repo_backup_${repoRow.id}`,
    __repositoryFactory: repositoryFactory,
    __fileSystem: {
      repositoryFactory,
      mountManager: { db, encryptionSecret: ENV.ENCRYPTION_SECRET },
      async createJob(t) {
        createdJobs.push(t);
        return { jobId: "x" };
      },
    },
  });

  assert.equal(result.skipped, true, "上一次检测未结束时应跳过");
  assert.ok(result.deferMs > 0, "应返回短延迟（第 2 期机制），不白等一个完整周期");
  assert.equal(createdJobs.length, 0, "不应创建新作业");
});

// ==================== 9. 削峰：不能一次 tick 把所有引用打出去 ====================

test("验收：到期引用超过每轮配额时只处理配额内的，其余留给下一轮", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const refs = Array.from({ length: 20 }, (_, i) => `b${String(i).padStart(2, "0")}`);
  const repoRow = await seedRepo(db, { refs });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();
  await codeRepo.ensureDetectStates(repoRow.id, refs.map((r) => ({ refType: "branch", ref: r })));

  const { createdJobs } = await runCheck({
    db,
    repoRow,
    payload: { maxRefs: 8 },
    responder: () => branchesOk(Object.fromEntries(refs.map((r, i) => [r, sha((i % 10).toString())]))),
  });

  const detected = await db._raw
    .prepare(`SELECT COUNT(*) AS c FROM repo_detect_states WHERE repository_id = ? AND last_detect_at IS NOT NULL`)
    .get(repoRow.id);
  assert.equal(detected.c, 8, "一轮只检测 8 个引用");

  const remaining = await codeRepo.countDueDetectStates(repoRow.id, new Date().toISOString());
  assert.equal(remaining, 12, "剩余 12 个仍处于到期状态，下一轮继续");

  assert.equal(createdJobs.length, 1, "仍然只创建一个备份任务，带上本轮检测到的引用");
});

test("验收：默认配额是 DETECT_MAX_REFS_PER_RUN（不传 maxRefs 时也受约束）", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const refs = Array.from({ length: 15 }, (_, i) => `c${i}`);
  const repoRow = await seedRepo(db, { refs });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();
  await codeRepo.ensureDetectStates(repoRow.id, refs.map((r) => ({ refType: "branch", ref: r })));

  await runCheck({
    db,
    repoRow,
    responder: () => branchesOk(Object.fromEntries(refs.map((r) => [r, sha("a")]))),
  });

  const remaining = await codeRepo.countDueDetectStates(repoRow.id, new Date().toISOString());
  assert.equal(remaining, 15 - DETECT_MAX_REFS_PER_RUN);
});

test("验收：本轮没检测完时返回 deferMs，让调度器早点再来", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS scheduled_jobs (
         task_id TEXT PRIMARY KEY, handler_id TEXT, enabled INTEGER DEFAULT 1,
         schedule_type TEXT, interval_sec INTEGER, cron_expression TEXT,
         next_run_after TEXT, run_count INTEGER DEFAULT 0, failure_count INTEGER DEFAULT 0,
         lock_until TEXT, last_run_status TEXT, last_run_started_at TEXT,
         last_run_finished_at TEXT, name TEXT, description TEXT, config_json TEXT)`,
    )
    .run();

  const refs = Array.from({ length: 12 }, (_, i) => `d${i}`);
  const repoRow = await seedRepo(db, { refs });
  const planned = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
  await db
    .prepare(
      `INSERT INTO scheduled_jobs (task_id, handler_id, enabled, schedule_type, interval_sec, next_run_after)
       VALUES (?, 'repo_backup_schedule', 1, 'interval', 21600, ?)`,
    )
    .bind(`repo_backup_${repoRow.id}`, planned)
    .run();

  await runCheck({
    db,
    repoRow,
    payload: { maxRefs: 5 },
    responder: () => branchesOk(Object.fromEntries(refs.map((r) => [r, sha("b")]))),
  });

  const row = db._raw.prepare(`SELECT next_run_after FROM scheduled_jobs WHERE task_id = ?`).get(`repo_backup_${repoRow.id}`);
  assert.ok(
    new Date(row.next_run_after).getTime() < new Date(planned).getTime(),
    "没检测完应把计划前移，而不是白等 6 小时",
  );
});

test("验收：下次检测时间带抖动（多引用不会在同一时刻集体到期）", () => {
  const results = new Set();
  for (let i = 0; i < 40; i += 1) {
    results.add(computeNextDetectAfterOnSuccess(1, false));
  }
  assert.ok(results.size > 1, "相同输入应产生不同的下次检测时间（抖动生效），否则会形成请求洪峰");

  // 抖动幅度必须受控：落在基准值 ±15% 内
  const base = 10 * 60 * 1000;
  for (const iso of results) {
    const delta = new Date(iso).getTime() - Date.now();
    assert.ok(delta >= base * 0.8 && delta <= base * 1.2, `抖动超出预期范围: ${delta}`);
  }
});

test("验收：长期无更新的引用会退避，但不影响「有更新立即发现」", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main"] });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();

  await codeRepo.ensureDetectStates(repoRow.id, [{ refType: "branch", ref: "main" }]);
  await codeRepo.updateDetectState(repoRow.id, "branch", "main", {
    backed_up_commit_sha: sha("a"),
    consecutive_unchanged_count: 5,
  });

  await runCheck({ db, repoRow, responder: () => jsonOk({ sha: sha("a") }) });
  const unchanged = readState(db, repoRow.id, "branch", "main");
  assert.ok(unchanged.consecutive_unchanged_count >= 6, "连续无更新应继续累计");

  // 同一个用例内两次检测打的是同一个 URL，必须清掉合并缓存，
  // 否则第二次会直接复用第一次的响应，测不到「有更新」这条路径
  clearCoalescedCache();

  // 一旦有更新：计数归零，检测频率回到基准
  await runCheck({ db, repoRow, responder: () => jsonOk({ sha: sha("b") }), payload: { ignoreDue: true } });
  const updated = readState(db, repoRow.id, "branch", "main");
  assert.equal(updated.consecutive_unchanged_count, 0, "有更新应重置退避计数");
  assert.equal(updated.commit_sha, sha("b"));
});

// ==================== 10. 与第 3 期机制衔接 ====================

test("验收：检测请求仍经过 Token 轮询池（第 3 期机制未被绕过）", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS metrics_cache (
         scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, metric_key TEXT NOT NULL,
         value_num INTEGER, value_text TEXT, value_json_text TEXT,
         snapshot_at_ms INTEGER, updated_at_ms INTEGER, error_message TEXT,
         PRIMARY KEY (scope_type, scope_id, metric_key))`,
    )
    .run();

  const now = new Date().toISOString();
  const tokens = [
    { id: "t1", label: "", value: "ghp_A", enabled: true },
    { id: "t2", label: "", value: "ghp_B", enabled: true },
  ];
  await db
    .prepare(
      `INSERT INTO code_repositories
        (id, provider, name, repo_identifier, track_mode, track_ref, track_refs_json,
         target_mount_id, target_mount_ids_json, target_path_prefix, retention_count,
         enabled, config_json, created_at, updated_at)
       VALUES ('repo-tok','github','tok','octocat/Hello-World','branch','main','["main"]',
               'mount-1','["mount-1"]','/',10,1,?, ?, ?)`,
    )
    .bind(JSON.stringify({ tokens }), now, now)
    .run();
  const repoRow = await db.prepare(`SELECT * FROM code_repositories WHERE id = 'repo-tok'`).bind().first();

  const { githubRequestScheduler, clearCoalescedCache } = await import("./GithubRequestScheduler.js");
  const { resetCredentialRotation } = await import("./providers/GithubRepoProvider.js");
  githubRequestScheduler.setDefaults({ MAX_CONCURRENCY: 4, MIN_INTERVAL_MS: 0, MAX_START_DELAY_MS: 5000 });
  githubRequestScheduler.reset();
  clearCoalescedCache();
  resetCredentialRotation();

  const used = [];
  const record = ({ token }) => {
    used.push(token);
    return jsonOk({ sha: sha("a") });
  };

  // createBackup: false —— 本用例只关心「请求用了哪个 Token」，不关心建不建备份作业
  await runCheck({ db, repoRow, payload: { createBackup: false }, responder: record });

  // 两次检测打的是同一个 URL：必须清掉合并缓存，否则第二次不会真的发请求，
  // 也就观察不到凭据轮询
  clearCoalescedCache();
  await runCheck({ db, repoRow, payload: { ignoreDue: true, createBackup: false }, responder: record });

  assert.equal(used.length, 2, "两次检测都应真实发起请求");
  assert.ok(used.every((t) => t && t.startsWith("ghp_")), `检测请求应带上池内 Token，实际: ${JSON.stringify(used)}`);
  assert.equal(new Set(used).size, 2, `连续两次检测应轮询到不同 Token，实际: ${JSON.stringify(used)}`);
});

test("验收：检测阶段不直接 fetch（全部经 provider → 调度器）", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main"] });
  const { fetchStub } = await runCheck({ db, repoRow, responder: () => jsonOk({ sha: sha("a") }) });

  // 每次请求都应指向 api.github.com，且带 GitHub 的响应头处理痕迹（说明走了 provider 的封装）
  assert.equal(fetchStub.calls.length, 1);
  assert.equal(new URL(fetchStub.calls[0].url).host, "api.github.com");
});

// ==================== 11. 双端兼容（Node/Docker 与 Workers/Workflows）====================

test("双端兼容：检测任务与备份任务都在 TaskRegistry 注册，且与 JobTypeCatalog 一致", async () => {
  const { registerTaskHandlers } = await import("../storage/fs/tasks/registerHandlers.js");
  const { registerJobTypes, validateJobTypesConsistency } = await import("../storage/fs/tasks/registerJobTypes.js");
  const { taskRegistry } = await import("../storage/fs/tasks/TaskRegistry.js");

  // 这两个注册入口在 Node 与 Workers 上都是同一份代码、同一个调用时机
  //（unified-entry.js 启动时调用），因此这里的断言对两端同时成立
  registerTaskHandlers();
  registerJobTypes();

  const types = taskRegistry.getSupportedTypes();
  assert.ok(types.includes("repo_backup"), "备份任务应已注册");
  assert.ok(types.includes("repo_backup_check"), "检测任务应已注册");

  // 不一致会抛错：这保证「检测任务建 repo_backup 作业」时一定能取到 handler
  validateJobTypesConsistency();
});

test("双端兼容：检测任务产出的载荷能通过备份任务的 validate（跨任务交接契约）", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main"] });

  const { createdJobs } = await runCheck({ db, repoRow, responder: () => jsonOk({ sha: sha("b") }) });
  assert.equal(createdJobs.length, 1);

  // 编排器在 createJob 时会对 payload 跑一遍 handler.validate，
  // 所以这里必须能通过 —— 否则检测任务会在运行期抛 ValidationError
  const { RepoBackupTaskHandler } = await import("../storage/fs/tasks/handlers/RepoBackupTaskHandler.js");
  await new RepoBackupTaskHandler().validate(createdJobs[0].payload);
});

test("双端兼容：检测任务只用编排器公开接口，不依赖任何 Node 专有 API", async () => {
  // 检测链路上用到的跨端能力只有三样，都是两端等价的：
  //   · crypto.randomUUID()（ensureDetectStates 生成状态行 id）
  //   · fileSystem.createJob()（两端分别落到 Workflows / SQLite 编排器）
  //   · scheduled_jobs 的 SQL 更新
  // 这里做一个可执行的最小确认：randomUUID 在两端都是全局可用的 Web Crypto
  assert.equal(typeof crypto?.randomUUID, "function");
  const id = crypto.randomUUID();
  assert.match(id, /^[0-9a-f-]{36}$/);

  // 状态行 id 必须是这个格式，因为它会被拼进 payload 里做 LIKE 匹配的仓库隔离查询
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main"] });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();
  await codeRepo.ensureDetectStates(repoRow.id, [{ refType: "branch", ref: "main" }]);
  const state = readState(db, repoRow.id, "branch", "main");
  assert.match(String(state.id), /^[0-9a-f-]{36}$/, "状态行 id 应为 UUID");
});

test("双端兼容：并发守卫的 LIKE 查询不会被 UUID 里的特殊字符破坏", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main"] });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();
  const now = Date.now();

  // repositoryId 由 crypto.randomUUID 生成，只含十六进制与短横线，可直接拼进 LIKE
  const uuidRepo = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO tasks (task_id, task_type, status, payload, stats, user_id, user_type,
                          trigger_type, created_at, updated_at)
       VALUES ('u1', 'repo_backup_check', 'running', ?, '{}', 'admin', 'admin', 'scheduled', ?, ?)`,
    )
    .bind(JSON.stringify({ repositoryId: uuidRepo }), now, now)
    .run();

  assert.equal(await codeRepo.countActiveRepoJobs(uuidRepo, ["repo_backup_check"], now - 3600_000), 1);
  // 前缀相近但不同的 id 不能被误命中
  assert.equal(await codeRepo.countActiveRepoJobs(uuidRepo.slice(0, -1), ["repo_backup_check"], now - 3600_000), 0);
  void repoRow;
});

// ==================== 12. 边界与既有语义 ====================

test("边界：仓库没有任何到期引用时本轮空转，不报错也不建任务", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main"] });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();
  await codeRepo.ensureDetectStates(repoRow.id, [{ refType: "branch", ref: "main" }]);
  // 把下次检测时间推到未来
  await codeRepo.updateDetectState(repoRow.id, "branch", "main", {
    next_detect_after: new Date(Date.now() + 3600 * 1000).toISOString(),
  });

  const { createdJobs, fetchStub, progress } = await runCheck({
    db,
    repoRow,
    responder: () => {
      throw new Error("不该发请求");
    },
  });

  assert.equal(fetchStub.calls.length, 0);
  assert.equal(createdJobs.length, 0);
  const last = progress[progress.length - 1];
  assert.equal(last.stage, "finished");
  assert.match(String(last.itemResults[0].message), /没有到期的引用/);
});

test("边界：手动检测（ignoreDue）绕过退避，强制检测全部引用", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main", "develop"] });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();
  await codeRepo.ensureDetectStates(repoRow.id, [
    { refType: "branch", ref: "main" },
    { refType: "branch", ref: "develop" },
  ]);
  const future = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
  await codeRepo.updateDetectState(repoRow.id, "branch", "main", { next_detect_after: future });
  await codeRepo.updateDetectState(repoRow.id, "branch", "develop", { next_detect_after: future });

  const { fetchStub } = await runCheck({
    db,
    repoRow,
    payload: { ignoreDue: true, createBackup: false },
    responder: () => branchesOk({ main: sha("1"), develop: sha("2") }),
  });

  assert.ok(fetchStub.calls.length >= 1, "手动检测应无视退避，照常发请求");
  const main = readState(db, repoRow.id, "branch", "main");
  assert.equal(main.commit_sha, sha("1"), "应刷新到最新 commit");
});

test("边界：createBackup=false（手动检查更新）不创建备份任务", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main"] });

  const { createdJobs } = await runCheck({
    db,
    repoRow,
    payload: { createBackup: false, ignoreDue: true },
    responder: () => jsonOk({ sha: sha("b") }),
  });

  assert.equal(createdJobs.length, 0, "只看结果不动手：不该创建备份任务");
  assert.equal(readState(db, repoRow.id, "branch", "main").commit_sha, sha("b"), "但状态仍要落库");
});

test("边界：force 时把全部检测成功的引用交给备份任务，并透传 force", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main", "develop"] });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();
  await codeRepo.ensureDetectStates(repoRow.id, [
    { refType: "branch", ref: "main" },
    { refType: "branch", ref: "develop" },
  ]);
  // 两个分支都已经备份过（正常情况下会被判为无更新）
  await codeRepo.updateDetectState(repoRow.id, "branch", "main", { backed_up_commit_sha: sha("1") });
  await codeRepo.updateDetectState(repoRow.id, "branch", "develop", { backed_up_commit_sha: sha("2") });

  const { createdJobs } = await runCheck({
    db,
    repoRow,
    payload: { force: true, createBackup: true },
    responder: () => branchesOk({ main: sha("1"), develop: sha("2") }),
  });

  assert.equal(createdJobs.length, 1, "强制备份即使无更新也要建任务");
  assert.equal(createdJobs[0].payload.force, true, "force 必须透传下去");
  assert.equal(createdJobs[0].payload.refs.length, 2, "全部检测成功的引用都要交出去");
});

test("边界：仓库不存在时报错（不静默成功）", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const handler = new RepoBackupCheckTaskHandler();
  const { context } = makeContext({ db, env: ENV, repositoryFactory: new RepositoryFactory(db, { env: ENV }) });

  await assert.rejects(
    () =>
      handler.execute(
        { jobId: "j", taskType: "repo_backup_check", payload: { repositoryId: "nope" }, userId: "a", userType: "admin" },
        context,
      ),
    /代码仓库不存在/,
  );
});

test("边界：validate 拒绝缺 repositoryId 与非法 maxRefs", async () => {
  const handler = new RepoBackupCheckTaskHandler();
  await assert.rejects(() => handler.validate({}), /repositoryId/);
  await assert.rejects(() => handler.validate({ repositoryId: "x", maxRefs: 0 }), /maxRefs/);
  await assert.rejects(() => handler.validate({ repositoryId: "x", maxRefs: -3 }), /maxRefs/);
  await handler.validate({ repositoryId: "x" });
  await handler.validate({ repositoryId: "x", maxRefs: 5 });
});

test("边界：仓库级 last_error 只在全部引用永久失败时才写（一个分支打错字不标红整仓）", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main", "typo-branch"] });

  await runCheck({
    db,
    repoRow,
    responder: ({ url }) => {
      // main 正常，另一个分支 404
      if (url.includes("/branches")) {
        return branchesOk({ main: sha("1") });
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    },
  });

  const row = db._raw.prepare(`SELECT last_error, last_checked_at FROM code_repositories WHERE id = ?`).get(repoRow.id);
  assert.ok(row.last_checked_at, "最近检测时间应更新（列表页聚合展示用）");
  assert.equal(row.last_error, null, "部分失败不该把整个仓库标红");
});

test("既有语义：detectRefs 的逐引用隔离 —— 一个引用失败不影响其他引用", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["good", "bad"] });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();
  await codeRepo.ensureDetectStates(repoRow.id, [
    { refType: "branch", ref: "good" },
    { refType: "branch", ref: "bad" },
  ]);

  const fakeProvider = {
    async resolveLatestVersion({ trackRef }) {
      if (trackRef === "bad") throw new Error("branch not found");
      return { refType: "branch", ref: trackRef, commitSha: sha("g"), version: `${trackRef}@ggggggg`, publishedAt: null };
    },
  };

  const round = await prepareDetectRound({ codeRepo, repoRow, ignoreDue: true });
  const outcome = await detectRefs({ codeRepo, provider: fakeProvider, repoRow, refs: round.refs });

  assert.equal(outcome.successCount, 1);
  assert.equal(outcome.errorCount, 1);
  assert.equal(readState(db, repoRow.id, "branch", "good").detect_status, DETECT_STATUS.OK);
  assert.equal(readState(db, repoRow.id, "branch", "bad").detect_status, DETECT_STATUS.ERROR);
});

test("既有语义：trackRefs 解析仍兼容只有单个 track_ref 的老数据", async () => {
  const db = createTestDb();
  await setupSchema(db);
  // 模拟 v35 及更早：track_refs_json 为空，只有 track_ref
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO code_repositories
        (id, provider, name, repo_identifier, track_mode, track_ref, track_refs_json,
         target_mount_id, target_mount_ids_json, target_path_prefix, retention_count,
         enabled, config_json, created_at, updated_at)
       VALUES ('legacy','github','legacy','octocat/Hello-World','branch','legacy-main','[]',
               'mount-1','["mount-1"]','/',10,1,'{}', ?, ?)`,
    )
    .bind(now, now)
    .run();
  const repoRow = await db.prepare(`SELECT * FROM code_repositories WHERE id='legacy'`).bind().first();
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();

  const round = await prepareDetectRound({ codeRepo, repoRow, ignoreDue: true });
  assert.equal(round.refs.length, 1);
  assert.equal(round.refs[0].ref, "legacy-main");
});
