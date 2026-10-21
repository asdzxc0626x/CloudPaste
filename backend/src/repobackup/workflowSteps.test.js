/**
 * 回归测试：仓库备份的 Workflow 步骤拆分（修改点：阶段 2 拆分 Workflow 步骤）
 *
 * 背景
 * ----
 * 拆分前整个 execute() 跑在单个 execute-task 步骤里，于是 N 个引用 × M 个目标
 * 共用**一份** CPU 与外部 subrequest 额度（免费计划 10ms / 50 个外部请求）；
 * 任何一个组合把额度撞掉，整个 isolate 被杀，前面做成的活一起没。
 * 拆分后每个组合是独立步骤 = 独立 invocation（文档 workflows/reference/limits/：
 * 「Each step can run for an unlimited wall time. Individual steps are subject to
 * the configured CPU time limit」），已完成的组合结果由平台缓存下来。
 *
 * 这一组盯的是「拆分做错了会很危险」的几个点：
 *  1. 步骤名必须**确定且唯一**——它是 Workflows 的缓存键（「Step names act as the
 *     "cache key" in your Workflow」）。名字漂移 = 缓存失效 = 整个组合重跑。
 *  2. 步骤数量必须跟着实际工作量动态走，不能写死。
 *  3. 单个组合失败绝不能阻止其他组合，收尾步骤照样要跑。
 *  4. **重放必须幂等**：引擎重启会把 run() 从头重放一遍，已缓存的步骤直接回灌结果。
 *     此时绝不能重复上传、重复写备份历史、重复生成 manifest。
 *  5. 备份目录名里带时间戳，必须取自**已缓存的**时刻 —— 否则同一个组合重试一次
 *     就会多出一个孤儿目录。
 *  6. Node/Docker 侧没有 runStep，必须退化成直接调用，行为与拆分前一致。
 *
 * 运行：node --test src/repobackup/workflowSteps.test.js（整仓用 `npm test`）
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  createCodeRepositoryTables,
  createRepoDetectStatesTable,
  createStorageTables,
  createTasksTables,
} from "../db/migrations/sqlite/engine/schema.js";
import { RepositoryFactory } from "../repositories/index.js";
import { RepoBackupTaskHandler } from "../storage/fs/tasks/handlers/RepoBackupTaskHandler.js";
import { buildTimestamp } from "./paths.js";
import { githubRequestScheduler, clearCoalescedCache } from "./GithubRequestScheduler.js";
import { resetCredentialRotation } from "./providers/GithubRepoProvider.js";
import * as repositoryService from "../services/codeRepositoryService.js";
import * as oneOffConfig from "./oneOff.js";
import { pruneOldVersions } from "./retention.js";
import { planDirDedupe } from "./dedupeDirs.js";

beforeEach(() => {
  // 与同目录其它用例同样的隔离：模块级状态必须逐用例复位
  githubRequestScheduler.setDefaults({ MAX_CONCURRENCY: 4, MIN_INTERVAL_MS: 0, MAX_START_DELAY_MS: 5000 });
  githubRequestScheduler.reset();
  clearCoalescedCache();
  resetCredentialRotation();
});

const ENV = { ENCRYPTION_SECRET: "test-secret-for-workflow-steps" };
const sha = (c) => c.repeat(40);
/** 与下面 fetch 桩返回的归档字节数一致，供 S3 进度回调模拟上报（阶段 3） */
const BYTES_PER_ARCHIVE = 8;

/** 真实内存库，包成 D1 形状（与同目录其它用例一致） */
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

async function setupSchema(db) {
  await createCodeRepositoryTables(db);
  await createRepoDetectStatesTable(db);
  await createStorageTables(db);
  await createTasksTables(db);
}

/** 造一个仓库行（可配多分支、多目标） */
async function seedRepo(db, { id = "repo-1", refs = ["main"], mountIds = ["mount-1"] } = {}) {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO code_repositories
        (id, provider, name, repo_identifier, track_mode, track_ref, track_refs_json,
         target_mount_id, target_mount_ids_json, target_path_prefix, retention_count,
         enabled, config_json, created_at, updated_at)
       VALUES (?, 'github', ?, 'octocat/Hello-World', 'branch', ?, ?, ?, ?, '/', 10, 1, '{}', ?, ?)`,
    )
    .bind(id, `仓库${id}`, refs[0] ?? null, JSON.stringify(refs), mountIds[0], JSON.stringify(mountIds), now, now)
    .run();
  return await db.prepare(`SELECT * FROM code_repositories WHERE id = ?`).bind(id).first();
}

/** 造备份目标挂载点 */
async function seedMounts(db, ids, { storageType = "S3" } = {}) {
  const now = new Date().toISOString();
  for (const [i, id] of ids.entries()) {
    await db
      .prepare(
        `INSERT INTO storage_mounts
          (id, name, storage_type, mount_path, is_active, created_by, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 'admin-1', ?, ?, ?)`,
      )
      .bind(id, `目标${i + 1}`, storageType, `/backup${i + 1}`, i, now, now)
      .run();
  }
}

/**
 * 跑一次备份任务
 *
 * @param {object} opts
 * @param {Map<string, any>} [opts.stepCache] 传入同一个 Map 跑两次 = 模拟实例重放
 * @param {Set<string>} [opts.throwOnStep] 这些步骤名直接抛错（模拟重试耗尽）
 * @param {Set<string>} [opts.retryOnceStep] 这些步骤名的步骤体跑两遍（模拟步骤重试）
 * @param {boolean} [opts.splitSteps] false 则不提供 runStep（模拟 Node/Docker 宿主）
 * @param {(path: string) => void} [opts.failUploadFor] 指定路径前缀的上传抛错
 */
async function runBackup({
  db,
  repoRow,
  refs,
  stepCache = null,
  throwOnStep = new Set(),
  retryOnceStep = new Set(),
  splitSteps = true,
  env = ENV,
  failUploadForMount = null,
  jobId = "backup-job-1",
  payloadOverrides = {},
  archiveStatus = 200,
}) {
  const repositoryFactory = new RepositoryFactory(db, { env: ENV });
  const codeRepo = repositoryFactory.getCodeRepositoryRepository();

  /** 每个步骤名被「进入」了几次（含重放命中缓存的那次） */
  const stepCalls = [];
  /** 真正执行了步骤体的次数 */
  const stepBodyRuns = [];
  /** 步骤返回值，用来断言缓存内容 */
  const stepResults = new Map();
  /** 实际发生的上传（归档 + manifest） */
  const uploads = [];
  const requests = [];

  globalThis.fetch = async (url) => {
    requests.push(String(url));
    if (new URL(String(url)).host === "api.github.com") {
      throw new Error("用例使用预解析 refs，不应发起版本解析请求");
    }
    // codeload 的归档：给一点字节，让护栏的计数生效
    return new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), {
      status: archiveStatus,
      headers: { "content-type": "application/gzip" },
    });
  };

  const fileSystem = {
    repositoryFactory,
    mountManager: { db, encryptionSecret: ENV.ENCRYPTION_SECRET },
    async createDirectory() {},
    async uploadFile(path, body, _userId, _userType, options) {
      const isArchive = typeof body?.getReader === "function";
      if (isArchive) {
        // 必须消费流，字节计数与护栏才会走完
        const reader = body.getReader();
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      }
      if (failUploadForMount && String(path).startsWith(failUploadForMount)) {
        throw new Error("存储配额不足");
      }
      uploads.push({
        path,
        kind: isArchive ? "archive" : "manifest",
        contentType: options?.contentType,
        uploadTuning: options?.uploadTuning,
        /**
         * 修改点（阶段 3 S3 流式传输 CPU 开销）：记录调用方是否用 SDK 进度事件
         * 替代了逐字节包装。非 S3 驱动收到的是包装过的流（getReader 仍是函数），
         * S3 驱动收到的则是原始流 —— 两者在桩里长得一样，只能靠这个回调区分。
         */
        hasBytesProgress: typeof options?.onBytesProgress === "function",
      });
      // 模拟 S3 SDK 上报进度：真实路径下 loaded 是累计已传字节
      if (typeof options?.onBytesProgress === "function") {
        options.onBytesProgress(BYTES_PER_ARCHIVE, BYTES_PER_ARCHIVE);
      }
      return { storagePath: path };
    },
  };

  const context = {
    isCancelled: async () => false,
    updateProgress: async () => {},
    getFileSystem: () => fileSystem,
    getEnv: () => env,
  };

  if (splitSteps) {
    context.runStep = async (name, _options, fn) => {
      stepCalls.push(name);
      if (stepCache && stepCache.has(name)) {
        // 重放：直接回灌缓存结果，绝不执行步骤体
        return structuredClone(stepCache.get(name));
      }
      if (throwOnStep.has(name)) {
        stepBodyRuns.push(name);
        throw new Error(`步骤 ${name} 重试耗尽`);
      }
      stepBodyRuns.push(name);
      let result = await fn();
      if (retryOnceStep.has(name)) {
        // 模拟步骤重试：步骤体被完整重跑一遍，平台采用最后一次的结果
        stepBodyRuns.push(name);
        result = await fn();
      }
      if (stepCache) stepCache.set(name, structuredClone(result));
      stepResults.set(name, result);
      return result;
    };
  }

  const handler = new RepoBackupTaskHandler();
  const payload = { repositoryId: repoRow.id, repoIdentifier: repoRow.repo_identifier, refs, ...payloadOverrides };
  await handler.validate(payload);

  let thrown = null;
  try {
    await handler.execute({ jobId, taskType: "repo_backup", payload, userId: "admin-1", userType: "admin" }, context);
  } catch (error) {
    thrown = error;
  }

  return { codeRepo, stepCalls, stepBodyRuns, stepResults, uploads, thrown, requests };
}

const readBackups = (db, repositoryId) =>
  db._raw
    .prepare(`SELECT * FROM code_repository_backups WHERE repository_id = ? ORDER BY created_at`)
    .all(repositoryId);

const readTargets = (db, backupId) =>
  db._raw.prepare(`SELECT * FROM code_repository_backup_targets WHERE backup_id = ?`).all(backupId);

const archiveUploads = (uploads) => uploads.filter((u) => u.kind === "archive");
const manifestUploads = (uploads) => uploads.filter((u) => u.kind === "manifest");

const REFS_TWO = [
  { refType: "branch", ref: "main", commitSha: sha("a"), version: "main@aaaaaaa", publishedAt: null },
  { refType: "branch", ref: "dev", commitSha: sha("b"), version: "dev@bbbbbbb", publishedAt: null },
];

test("one-off backup uses exactly the requested SHA without saving config or moving scheduled watermarks", async () => {
  assert.equal(typeof repositoryService.buildOneOffBackupPayload, "function");
  const db = createTestDb();
  await setupSchema(db);
  await seedMounts(db, ["mount-1"]);
  const repoRow = await seedRepo(db);
  db._raw.exec("UPDATE code_repositories SET target_path_prefix = '/custom', enabled = 0, retention_count = 1");
  const before = db._raw.prepare("SELECT * FROM code_repositories").get();
  const factory = new RepositoryFactory(db, { env: ENV });
  const payload = await repositoryService.buildOneOffBackupPayload(db, factory, ENV.ENCRYPTION_SECRET, {
    repositoryId: repoRow.id, branch: "old-branch", commitSha: sha("c"),
  }, ENV);
  assert.notEqual(payload.repositoryId, repoRow.id);
  assert.equal(payload.refs[0].commitSha, sha("c"));
  assert.equal(payload.refs[0].ref, "old-branch");
  assert.doesNotMatch(JSON.stringify(payload), /\/custom|config_json/);
  const run = await runBackup({ db, repoRow, payloadOverrides: payload });
  assert.equal(run.thrown, null);
  assert.match(archiveUploads(run.uploads)[0].path, /\/custom\/octocat__Hello-World\/old-branch\/manual__/);
  assert.equal(readBackups(db, repoRow.id).length, 0);
  const manual = readBackups(db, payload.repositoryId);
  assert.equal(manual.length, 1);
  assert.equal(manual[0].commit_sha, sha("c"));
  assert.equal(manual[0].status, "success");
  assert.ok(run.requests.every((url) => url.endsWith(sha("c"))));
  assert.deepEqual(db._raw.prepare("SELECT * FROM code_repositories").get(), before);
  assert.equal(db._raw.prepare("SELECT count(*) AS n FROM repo_detect_states").get().n, 0);
  assert.equal((await run.codeRepo.findSuccessBackupsBeyondLimit(repoRow.id, 0)).length, 0);
});

test("one-off encrypted task settings are removed on completion/cancellation without modifying other payloads", async () => {
  assert.equal(typeof oneOffConfig.ONE_OFF_TASK_PAYLOAD_SQL, "string");
  const db = createTestDb();
  await createTasksTables(db);
  const envelope = await oneOffConfig.sealOneOffConfig({ config: { token: "private-token" } }, ENV.ENCRYPTION_SECRET);
  assert.doesNotMatch(JSON.stringify(envelope), /private-token/);
  assert.deepEqual(await oneOffConfig.openOneOffConfig(envelope, ENV.ENCRYPTION_SECRET), { config: { token: "private-token" } });
  await assert.rejects(() => oneOffConfig.openOneOffConfig(envelope, "wrong-key"), /解密/);
  const payload = { repositoryId: "oneoff-1", refs: REFS_TWO.slice(0, 1), oneOff: envelope };
  for (const status of ["completed", "failed", "partial", "cancelled"]) {
    db._raw.prepare("INSERT INTO tasks(task_id, task_type, status, payload, stats, user_id, user_type, created_at, updated_at) VALUES (?, 'repo_backup', ?, ?, '{}', 'a', 'admin', 1, 1)").run(status, status, JSON.stringify(payload));
  }
  db._raw.exec(`UPDATE tasks SET payload = ${oneOffConfig.ONE_OFF_TASK_PAYLOAD_SQL}`);
  for (const row of db._raw.prepare("SELECT payload FROM tasks").all()) {
    const stored = JSON.parse(row.payload);
    assert.equal(stored.oneOff, undefined);
    assert.deepEqual(stored.refs, payload.refs);
    assert.equal(stored.repositoryId, payload.repositoryId);
  }
});

test("regular retention and deduplication do not remove one-off snapshots, even at the same SHA", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMounts(db, ["mount-1"]);
  const repoRow = await seedRepo(db);
  const factory = new RepositoryFactory(db, { env: ENV });
  const body = { repositoryId: repoRow.id, branch: "main", commitSha: sha("a") };
  const first = await repositoryService.buildOneOffBackupPayload(db, factory, ENV.ENCRYPTION_SECRET, body, ENV);
  const second = await repositoryService.buildOneOffBackupPayload(db, factory, ENV.ENCRYPTION_SECRET, body, ENV);
  assert.notEqual(first.repositoryId, second.repositoryId);
  for (const payload of [first, second]) {
    const run = await runBackup({ db, repoRow, payloadOverrides: payload });
    assert.equal(run.thrown, null);
    const cache = new Map();
    const replay = await runBackup({ db, repoRow, payloadOverrides: payload, stepCache: cache });
    assert.equal(replay.thrown, null);
    assert.equal(archiveUploads(replay.uploads).length, 0);
    assert.equal(db._raw.prepare("SELECT count(*) AS n FROM repo_detect_states").get().n, 0);
  }
  const regular = await runBackup({ db, repoRow, refs: REFS_TWO.slice(0, 1) });
  assert.equal(archiveUploads(regular.uploads).length, 1);
  const regularBackup = readBackups(db, repoRow.id)[0];
  await regular.codeRepo.createBackup({ id: "newest", repository_id: repoRow.id, commit_sha: sha("b"), status: "success" });
  db._raw.exec("UPDATE code_repository_backups SET created_at = '2000-01-01' WHERE id != 'newest'");
  const removed = [];
  await pruneOldVersions({ codeRepo: regular.codeRepo, repositoryRow: { ...repoRow, retention_count: 1 },
    fileSystem: { batchRemoveItems: async (paths) => { removed.push(...paths); return { success: paths.length }; } }, userId: "a", userType: "admin" });
  assert.equal(await regular.codeRepo.findBackupById(regularBackup.id), null);
  assert.equal(readBackups(db, first.repositoryId).length, 1);
  assert.equal(readBackups(db, second.repositoryId).length, 1);
  assert.ok(removed.every((path) => !path.includes("manual__")));
  const manualNames = [first, second].map((p) => `manual__20261021-000000__main__aaaaaaa__${p.repositoryId}`);
  const dedupe = planDirDedupe({ refDirPath: "/backup/main/", dirNames: [...manualNames, "20261021-000000__main__aaaaaaa", "20261020-000000__main__aaaaaaa"] });
  assert.equal(dedupe.removeDirPaths.length, 1);
  assert.ok(!dedupe.removeDirPaths[0].includes("manual__"));
});

test("missing commit fails once rather than resolving the branch or scheduling a later backup", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMounts(db, ["mount-1"]);
  const repoRow = await seedRepo(db);
  const payload = await repositoryService.buildOneOffBackupPayload(db, new RepositoryFactory(db, { env: ENV }), ENV.ENCRYPTION_SECRET,
    { repositoryId: repoRow.id, branch: "main", commitSha: sha("f") }, ENV);
  const run = await runBackup({ db, repoRow, payloadOverrides: payload, archiveStatus: 404 });
  assert.ok(run.thrown);
  assert.equal(run.requests.length, 1);
  assert.equal(readBackups(db, payload.repositoryId)[0].status, "failed");
  assert.equal(db._raw.prepare("SELECT count(*) AS n FROM repo_detect_states").get().n, 0);
  assert.ok(!run.stepCalls.includes("defer-schedule"));
});

test("one-off backup rejects missing or ambiguous SHA and unsafe paths before creating a task", async () => {
  assert.equal(typeof repositoryService.buildOneOffBackupPayload, "function");
  const db = createTestDb();
  await setupSchema(db);
  await seedMounts(db, ["mount-1"]);
  const factory = new RepositoryFactory(db, { env: ENV });
  const body = { repoIdentifier: "owner/repo", branch: "main", commitSha: sha("d"), targetMountIds: ["mount-1"] };
  for (const commitSha of ["", "main", "abcdef1", "g".repeat(40)]) {
    await assert.rejects(() => repositoryService.buildOneOffBackupPayload(db, factory, ENV.ENCRYPTION_SECRET, { ...body, commitSha }, ENV), /SHA/);
  }
  await assert.rejects(() => repositoryService.buildOneOffBackupPayload(db, factory, ENV.ENCRYPTION_SECRET, { ...body, targetPathPrefix: "/../oops" }, ENV), /前缀/);
  const payload = await repositoryService.buildOneOffBackupPayload(db, factory, ENV.ENCRYPTION_SECRET, body, ENV);
  const run = await runBackup({ db, repoRow: { id: "unused" }, payloadOverrides: payload });
  assert.equal(run.thrown, null);
  assert.equal(db._raw.prepare("SELECT count(*) AS n FROM code_repositories").get().n, 0);
});

// ==================== 步骤划分 ====================

test("多 refs × 多目标：每个组合一个独立步骤，名字确定且唯一", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMounts(db, ["mount-1", "mount-2"]);
  const repoRow = await seedRepo(db, { refs: ["main", "dev"], mountIds: ["mount-1", "mount-2"] });

  const { stepCalls, uploads, thrown } = await runBackup({ db, repoRow, refs: REFS_TWO });

  assert.equal(thrown, null, `不应抛出，实际：${thrown && thrown.message}`);
  assert.deepEqual(stepCalls, [
    "plan-run",
    "prepare-ref:r0",
    "transfer:r0:m0",
    "transfer:r0:m1",
    "finalize-ref:r0",
    "prepare-ref:r1",
    "transfer:r1:m0",
    "transfer:r1:m1",
    "finalize-ref:r1",
  ]);
  // 步骤名是 Workflows 的缓存键，重名会让两个组合互相顶掉彼此的结果
  assert.equal(new Set(stepCalls).size, stepCalls.length, "步骤名必须唯一");
  // 2 个引用 × 2 个目标 = 4 趟归档 + 4 个 manifest
  assert.equal(archiveUploads(uploads).length, 4);
  assert.equal(manifestUploads(uploads).length, 4);
});

test("步骤数量跟着实际工作量走：单 ref 单目标只开 1 个传输步骤", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMounts(db, ["mount-1"]);
  const repoRow = await seedRepo(db, { refs: ["main"], mountIds: ["mount-1"] });

  const { stepCalls } = await runBackup({ db, repoRow, refs: [REFS_TWO[0]] });

  assert.deepEqual(stepCalls, ["plan-run", "prepare-ref:r0", "transfer:r0:m0", "finalize-ref:r0"]);
});

test("目标索引取自完整目标列表：只补写第二个目标时步骤名仍是 m1", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMounts(db, ["mount-1", "mount-2"]);
  const repoRow = await seedRepo(db, { refs: ["main"], mountIds: ["mount-1", "mount-2"] });

  // 先造一次「mount-1 已成功」的历史，于是本轮只该补写 mount-2
  const codeRepoPre = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();
  await codeRepoPre.createBackup({
    id: "bk-existing",
    repository_id: repoRow.id,
    ref_type: "branch",
    ref: "main",
    commit_sha: sha("a"),
    version: "main@aaaaaaa",
    status: "partial",
    job_id: "old-job",
    started_at: new Date().toISOString(),
  });
  await codeRepoPre.upsertBackupTarget({
    id: "bkt-1",
    backup_id: "bk-existing",
    mount_id: "mount-1",
    mount_path: "/backup1",
    storage_path: "/backup1/old",
    status: "success",
  });

  const { stepCalls, uploads } = await runBackup({ db, repoRow, refs: [REFS_TWO[0]] });

  // 名字按挂载点在完整列表里的位置给，而不是按「本次补写列表」的下标 ——
  // 否则补写集合一变，同一个目标的步骤名就会漂到别的组合上去
  assert.deepEqual(stepCalls, ["plan-run", "prepare-ref:r0", "transfer:r0:m1", "finalize-ref:r0"]);
  assert.equal(archiveUploads(uploads).length, 1, "已成功的目标不该重新拉一遍归档");
  assert.ok(archiveUploads(uploads)[0].path.startsWith("/backup2"), "补写的应该是 mount-2");
});

test("全部目标都已有副本：判定为已是最新，不开任何传输与收尾步骤", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMounts(db, ["mount-1"]);
  const repoRow = await seedRepo(db, { refs: ["main"], mountIds: ["mount-1"] });

  const codeRepoPre = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();
  await codeRepoPre.createBackup({
    id: "bk-done",
    repository_id: repoRow.id,
    ref_type: "branch",
    ref: "main",
    commit_sha: sha("a"),
    version: "main@aaaaaaa",
    status: "success",
    job_id: "old-job",
    started_at: new Date().toISOString(),
  });
  await codeRepoPre.upsertBackupTarget({
    id: "bkt-1",
    backup_id: "bk-done",
    mount_id: "mount-1",
    mount_path: "/backup1",
    storage_path: "/backup1/old",
    status: "success",
  });

  const { stepCalls, uploads } = await runBackup({ db, repoRow, refs: [REFS_TWO[0]] });

  assert.deepEqual(stepCalls, ["plan-run", "prepare-ref:r0"]);
  assert.equal(uploads.length, 0, "已是最新不该有任何上传");
});

// ==================== 失败隔离 ====================

test("单个目标上传失败不阻止其他目标，收尾步骤照样跑，结论收敛为 partial", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMounts(db, ["mount-1", "mount-2"]);
  const repoRow = await seedRepo(db, { refs: ["main"], mountIds: ["mount-1", "mount-2"] });

  const { stepCalls, uploads, thrown } = await runBackup({
    db,
    repoRow,
    refs: [REFS_TWO[0]],
    failUploadForMount: "/backup1",
  });

  assert.equal(thrown, null, "部分成功不应让整个任务抛出");
  assert.ok(stepCalls.includes("transfer:r0:m1"), "第一个目标挂了，第二个目标必须还有机会跑");
  assert.ok(stepCalls.includes("finalize-ref:r0"), "收尾步骤必须执行");
  assert.equal(archiveUploads(uploads).length, 1, "只有 mount-2 写成功");

  const backups = readBackups(db, repoRow.id);
  assert.equal(backups.length, 1);
  assert.equal(backups[0].status, "partial");

  const targets = readTargets(db, backups[0].id);
  const byMount = Object.fromEntries(targets.map((t) => [t.mount_id, t.status]));
  assert.equal(byMount["mount-1"], "failed");
  assert.equal(byMount["mount-2"], "success");
});

test("传输步骤整体抛出（重试耗尽）：其他组合与收尾不受影响", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMounts(db, ["mount-1", "mount-2"]);
  const repoRow = await seedRepo(db, { refs: ["main"], mountIds: ["mount-1", "mount-2"] });

  const { stepCalls, uploads, thrown } = await runBackup({
    db,
    repoRow,
    refs: [REFS_TWO[0]],
    throwOnStep: new Set(["transfer:r0:m0"]),
  });

  assert.equal(thrown, null, "步骤级异常必须被处理器接住，不能让整个作业崩掉");
  assert.ok(stepCalls.includes("transfer:r0:m1"));
  assert.ok(stepCalls.includes("finalize-ref:r0"));
  assert.equal(archiveUploads(uploads).length, 1);

  const backups = readBackups(db, repoRow.id);
  assert.equal(backups[0].status, "partial");
  // 步骤级异常也要留下可诊断的原因，而不是一句空白
  assert.match(String(backups[0].error_message), /传输步骤异常退出/);
});

test("prepare-ref 步骤抛出：该引用记失败，不影响后一个引用", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMounts(db, ["mount-1"]);
  const repoRow = await seedRepo(db, { refs: ["main", "dev"], mountIds: ["mount-1"] });

  const { stepCalls, uploads, thrown } = await runBackup({
    db,
    repoRow,
    refs: REFS_TWO,
    throwOnStep: new Set(["prepare-ref:r0"]),
  });

  assert.equal(thrown, null, "一个引用失败、另一个成功 → 整体不抛出");
  // r0 没有版本信息，直接跳到 r1
  assert.ok(!stepCalls.includes("transfer:r0:m0"));
  assert.ok(stepCalls.includes("prepare-ref:r1"));
  assert.ok(stepCalls.includes("transfer:r1:m0"));
  assert.equal(archiveUploads(uploads).length, 1);
});

// ==================== 重放幂等 ====================

test("实例重放：步骤结果回灌，不重复上传、不重复写备份历史、不重复生成 manifest", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMounts(db, ["mount-1", "mount-2"]);
  const repoRow = await seedRepo(db, { refs: ["main"], mountIds: ["mount-1", "mount-2"] });

  const stepCache = new Map();

  const first = await runBackup({ db, repoRow, refs: [REFS_TWO[0]], stepCache });
  assert.equal(first.thrown, null);
  assert.equal(archiveUploads(first.uploads).length, 2);
  assert.equal(manifestUploads(first.uploads).length, 2);

  const backupsAfterFirst = readBackups(db, repoRow.id);
  assert.equal(backupsAfterFirst.length, 1);

  // 同一个 stepCache 再跑一遍 = 引擎重启后把 run() 从头重放
  const replay = await runBackup({ db, repoRow, refs: [REFS_TWO[0]], stepCache });

  assert.equal(replay.thrown, null);
  assert.deepEqual(replay.stepCalls, first.stepCalls, "重放必须走同一组步骤名（缓存键稳定）");
  assert.deepEqual(replay.stepBodyRuns, [], "所有步骤都应命中缓存，步骤体一次都不该执行");
  assert.equal(replay.uploads.length, 0, "重放绝不能重复上传归档或 manifest");

  const backupsAfterReplay = readBackups(db, repoRow.id);
  assert.equal(backupsAfterReplay.length, 1, "重放不能再插一条备份历史");
  assert.equal(backupsAfterReplay[0].id, backupsAfterFirst[0].id, "backupId 必须来自缓存，不能重新生成");
  assert.equal(readTargets(db, backupsAfterReplay[0].id).length, 2);
});

test("备份记录 id 由 prepare-ref 缓存：重放拿回同一个，不会凭空多出一条历史", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMounts(db, ["mount-1"]);
  const repoRow = await seedRepo(db, { refs: ["main"], mountIds: ["mount-1"] });

  const stepCache = new Map();
  const first = await runBackup({ db, repoRow, refs: [REFS_TWO[0]], stepCache });
  const cachedBackupId = stepCache.get("prepare-ref:r0").backupId;

  assert.ok(cachedBackupId, "prepare-ref 必须把 backupId 放进返回值，否则重放会 createBackup 出新行");
  assert.equal(readBackups(db, repoRow.id)[0].id, cachedBackupId);
  assert.equal(first.thrown, null);
});

// ==================== 目录时间戳稳定 ====================

test("备份目录时间戳取自 prepare-ref 缓存的时刻，同一引用的多个目标落在同名目录", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMounts(db, ["mount-1", "mount-2"]);
  const repoRow = await seedRepo(db, { refs: ["main"], mountIds: ["mount-1", "mount-2"] });

  const { stepResults, uploads } = await runBackup({ db, repoRow, refs: [REFS_TWO[0]] });

  const { pathAtMs } = stepResults.get("prepare-ref:r0");
  assert.ok(Number.isFinite(pathAtMs), "prepare-ref 必须返回 pathAtMs");

  // 目录名形如 `时间__分支__sha`，时间段必须等于缓存时刻格式化的结果
  const expected = buildTimestamp(new Date(pathAtMs));
  const archives = archiveUploads(uploads);
  assert.equal(archives.length, 2);
  for (const u of archives) {
    assert.ok(
      u.path.includes(`${expected}__main__${sha("a").slice(0, 7)}`),
      `目录时间戳应取自缓存时刻，实际路径：${u.path}`,
    );
  }
});

test("传输步骤被重试：两次尝试落在同一个归档路径，不产生孤儿目录", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMounts(db, ["mount-1"]);
  const repoRow = await seedRepo(db, { refs: ["main"], mountIds: ["mount-1"] });

  const { uploads, stepBodyRuns, thrown } = await runBackup({
    db,
    repoRow,
    refs: [REFS_TWO[0]],
    retryOnceStep: new Set(["transfer:r0:m0"]),
  });

  assert.equal(thrown, null);
  assert.equal(stepBodyRuns.filter((n) => n === "transfer:r0:m0").length, 2, "步骤体应被重跑一次");

  const archives = archiveUploads(uploads);
  assert.equal(archives.length, 2, "重试确实又传了一趟");
  assert.equal(archives[0].path, archives[1].path, "两趟必须落在同一个路径（覆盖写，而不是多留一个目录）");

  // 目标行按 (backup_id, mount_id) upsert，重试也只有一行
  const backups = readBackups(db, repoRow.id);
  assert.equal(readTargets(db, backups[0].id).length, 1);
});

// ==================== 主路径偏好 ====================

test("备份记录的主路径优先取本次写入的目标，而不是 D1 里碰巧排在前面的历史行", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMounts(db, ["mount-1", "mount-2"]);
  const repoRow = await seedRepo(db, { refs: ["main"], mountIds: ["mount-1", "mount-2"] });

  // mount-1 是上一轮留下的成功副本，本轮只补写 mount-2
  const codeRepoPre = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();
  await codeRepoPre.createBackup({
    id: "bk-existing",
    repository_id: repoRow.id,
    ref_type: "branch",
    ref: "main",
    commit_sha: sha("a"),
    version: "main@aaaaaaa",
    status: "partial",
    job_id: "old-job",
    started_at: new Date().toISOString(),
  });
  await codeRepoPre.upsertBackupTarget({
    id: "bkt-old",
    backup_id: "bk-existing",
    mount_id: "mount-1",
    mount_path: "/backup1",
    storage_path: "/backup1/上一轮的归档.tar.gz",
    status: "success",
  });

  const { uploads } = await runBackup({ db, repoRow, refs: [REFS_TWO[0]] });

  const written = archiveUploads(uploads);
  assert.equal(written.length, 1, "只该补写 mount-2");

  const backups = readBackups(db, repoRow.id);
  assert.equal(backups[0].status, "success", "两个目标都有副本 → success");
  assert.equal(
    backups[0].storage_path,
    written[0].path,
    "主路径必须是本次写入的那个；取成历史行会让备份详情指向一个旧快照",
  );
});

// ==================== Node/Docker 宿主 ====================
test("宿主不提供 runStep（Node/Docker）：退化成直接调用，行为与拆分前一致", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMounts(db, ["mount-1", "mount-2"]);
  const repoRow = await seedRepo(db, { refs: ["main", "dev"], mountIds: ["mount-1", "mount-2"] });

  const { stepCalls, uploads, thrown } = await runBackup({
    db,
    repoRow,
    refs: REFS_TWO,
    splitSteps: false,
  });

  assert.equal(thrown, null);
  assert.deepEqual(stepCalls, [], "没有 runStep 时不应登记任何步骤");
  assert.equal(archiveUploads(uploads).length, 4, "4 个组合照常全部完成");

  const backups = readBackups(db, repoRow.id);
  assert.equal(backups.length, 2);
  for (const row of backups) assert.equal(row.status, "success");
});

test("处理器声明了 usesExecutionSteps，编排层据此决定是否顶层驱动", () => {
  // 这个标志是 JobWorkflow 二选一分支的唯一依据：丢了它就会退回「整体包在
  // execute-task 里」，拆分等于没做，而且不会有任何报错 —— 必须锁住
  assert.equal(new RepoBackupTaskHandler().usesExecutionSteps, true);
});

// ==================== S3 进度事件路径（阶段 3） ====================

test("S3 目标不再套逐字节包装：改由 SDK 进度回调喂护栏", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMounts(db, ["mount-1"], { storageType: "S3" });
  const repoRow = await seedRepo(db, { refs: ["main"], mountIds: ["mount-1"] });

  const { uploads, thrown } = await runBackup({ db, repoRow, refs: [REFS_TWO[0]] });

  assert.equal(thrown, null, `不应抛出，实际：${thrown && thrown.message}`);
  const archives = archiveUploads(uploads);
  assert.equal(archives.length, 1);
  assert.equal(
    archives[0].hasBytesProgress,
    true,
    "S3 目标必须拿到进度回调，否则护栏在 S3 路径上等于瞎的",
  );
  assert.equal(archives[0].uploadTuning, undefined);
});

test("非 S3 驱动保留原有逐字节包装（卸载掉的只是 S3 的额外开销）", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMounts(db, ["mount-1"], { storageType: "WEBDAV" });
  const repoRow = await seedRepo(db, { refs: ["main"], mountIds: ["mount-1"] });

  const { uploads, thrown } = await runBackup({ db, repoRow, refs: [REFS_TWO[0]], env: { ...ENV, REPO_BACKUP_UPLOAD_PART_MB: "16" } });

  assert.equal(thrown, null, `不应抛出，实际：${thrown && thrown.message}`);
  const archives = archiveUploads(uploads);
  assert.equal(archives.length, 1);
  assert.equal(archives[0].uploadTuning, undefined);
  assert.equal(
    archives[0].hasBytesProgress,
    false,
    "WebDAV 没有可靠的进度事件，必须继续走 wrap()，否则停滞检测会失效",
  );
});

test("S3 备份配置透传 partSize，保留原有并发与进度回调，manifest 不受影响", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMounts(db, ["mount-1"]);
  const repoRow = await seedRepo(db);
  const { uploads, thrown } = await runBackup({
    db, repoRow, refs: [REFS_TWO[0]], env: { ...ENV, REPO_BACKUP_UPLOAD_PART_MB: "16" },
  });
  assert.equal(thrown, null);
  const archive = archiveUploads(uploads)[0];
  assert.deepEqual(archive.uploadTuning, { partSize: 16 * 1024 * 1024, queueSize: undefined });
  assert.equal(archive.hasBytesProgress, true);
  assert.ok(manifestUploads(uploads).every((upload) => upload.uploadTuning === undefined));
});
