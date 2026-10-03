/**
 * 状态一致性验收测试（修改点：状态显示不一致修复 + 检查更新无反馈）
 *
 * 运行：node --test src/repobackup/statusConsistency.test.js
 *
 * 这一组用例锁定的两个线上问题：
 *   1. 点「检查更新」后，检测成功但没有新版本时界面没有任何结果，
 *      用户分不清「已是最新」和「检查没跑」。
 *   2. 点「立即备份」后，任务列表显示「跳过」，仓库管理却显示「失败」——
 *      同一个结果在两个页面读出两个结论。
 *
 * 覆盖方式：
 *   · 纯映射部分直接打 repobackup/status.js（这是两个页面共同的状态来源）
 *   · 端到端部分用**真实 DDL + 真实 handler**，只有 fetch 与 fileSystem 是桩，
 *     因此「任务列表看到什么」和「仓库管理看到什么」走的是真实执行路径
 *
 * 验收口径（对应用户提出的四条）：
 *   1. 无更新 → 明确是成功检测结果，绝不落到失败/空结果
 *   2. 正常跳过 → 两处显示一致的非失败状态
 *   3. 真失败   → 两处都显示失败并带原因
 *   4. 限流     → 显示延迟/等待，不显示失败
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
import { RepoBackupCheckTaskHandler } from "../storage/fs/tasks/handlers/RepoBackupCheckTaskHandler.js";
import { RepoBackupTaskHandler } from "../storage/fs/tasks/handlers/RepoBackupTaskHandler.js";
import { githubRequestScheduler, clearCoalescedCache } from "./GithubRequestScheduler.js";
import { resetCredentialRotation } from "./providers/GithubRepoProvider.js";
import { DETECT_STATUS, advanceBackedUpWatermark } from "./detect.js";
import {
  REPO_OUTCOME,
  isFailureOutcome,
  isSuccessOutcome,
  outcomeFromBackupStatus,
  outcomeFromDetectStates,
  outcomeTone,
  resolveRepositoryState,
} from "./status.js";

beforeEach(() => {
  // 与 detectStatePersistence.test.js 同样的隔离：模块级状态必须逐用例复位
  githubRequestScheduler.setDefaults({ MAX_CONCURRENCY: 4, MIN_INTERVAL_MS: 0, MAX_START_DELAY_MS: 5000 });
  githubRequestScheduler.reset();
  clearCoalescedCache();
  resetCredentialRotation();
});

// ==================== 测试替身 ====================

/** 真实内存库，包成 D1 形状 */
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

/** 造一个仓库行 */
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

/** 造一个可写入的挂载点（备份目标） */
async function seedMount(db, { id = "mount-1" } = {}) {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO storage_mounts
        (id, name, storage_type, mount_path, is_active, created_by, sort_order, created_at, updated_at)
       VALUES (?, '目标', 'S3', '/backup', 1, 'admin-1', 0, ?, ?)`,
    )
    .bind(id, now, now)
    .run();
}

function installFetch(responder) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const record = { url: String(url) };
    calls.push(record);
    const result = responder(record);
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

const branchesOk = (map) =>
  jsonOk(Object.entries(map).map(([name, s]) => ({ name, commit: { sha: s } })));

/**
 * 单引用时的响应形状
 * 只有一个跟踪引用时 provider 走 /commits/{ref}，返回的是单个对象而不是数组；
 * 用错形状会被判成解析失败，用例就会假失败成「永久错误」。
 */
const commitOk = (s) => jsonOk({ sha: s });

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

const notFound = () =>
  new Response(JSON.stringify({ message: "Not Found" }), {
    status: 404,
    headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999" },
  });

const ENV = { ENCRYPTION_SECRET: "test-secret-for-status-consistency" };

/** 造一个任务上下文（fileSystem 只实现 handler 真正用到的方法） */
function makeContext({ db, repositoryFactory, fileSystemOverrides = {} }) {
  const createdJobs = [];
  const progress = [];
  const fileSystem = {
    repositoryFactory,
    mountManager: { db, encryptionSecret: ENV.ENCRYPTION_SECRET },
    async createJob(taskType, payload, userId, userType, meta) {
      const job = { jobId: `${taskType}-test-${createdJobs.length + 1}`, taskType, payload, userId, userType, meta };
      createdJobs.push(job);
      return job;
    },
    ...fileSystemOverrides,
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
      getEnv: () => ENV,
    },
  };
}

/** 跑一次检测任务（真实 handler） */
async function runCheck({ db, repoRow, responder, payload = {}, handler = null }) {
  const repositoryFactory = new RepositoryFactory(db, { env: ENV });
  const codeRepo = repositoryFactory.getCodeRepositoryRepository();
  const { context, createdJobs, progress } = makeContext({ db, repositoryFactory });
  installFetch(responder);

  const instance = handler || new RepoBackupCheckTaskHandler();
  const job = {
    jobId: "check-job-1",
    taskType: "repo_backup_check",
    payload: { repositoryId: repoRow.id, ...payload },
    userId: "admin-1",
    userType: "admin",
  };
  await instance.validate(job.payload);
  await instance.execute(job, context);

  return { codeRepo, createdJobs, progress };
}

/**
 * 跑一次备份任务（真实 handler）
 *
 * 用预解析的 refs，因此不会触发版本 API；只有源码归档与上传是桩。
 */
async function runBackup({ db, repoRow, payload, responder, uploadFile }) {
  const repositoryFactory = new RepositoryFactory(db, { env: ENV });
  const codeRepo = repositoryFactory.getCodeRepositoryRepository();
  const { context, progress } = makeContext({
    db,
    repositoryFactory,
    fileSystemOverrides: {
      async createDirectory() {},
      async uploadFile(path, stream, userId, userType, options) {
        return await uploadFile({ path, stream, options });
      },
    },
  });
  installFetch(responder);

  const instance = new RepoBackupTaskHandler();
  const job = {
    jobId: "backup-job-1",
    taskType: "repo_backup",
    payload: { repositoryId: repoRow.id, ...payload },
    userId: "admin-1",
    userType: "admin",
  };
  await instance.validate(job.payload);
  let thrown = null;
  try {
    await instance.execute(job, context);
  } catch (error) {
    thrown = error;
  }

  return { codeRepo, progress, thrown, jobId: job.jobId };
}

/** 读取该仓库的全部备份记录 */
const readBackups = (db, repositoryId) =>
  db._raw
    .prepare(`SELECT * FROM code_repository_backups WHERE repository_id = ? ORDER BY created_at`)
    .all(repositoryId);

/** 读取仓库行上的 last_error（前端过去就是拿它当「失败」渲染的） */
const readRepoError = (db, repositoryId) =>
  db._raw.prepare(`SELECT last_error FROM code_repositories WHERE id = ?`).get(repositoryId)?.last_error ?? null;

/** 把落库的检测状态转成 DTO 形状，喂给状态推导函数 */
const detectStatesOf = (db, repositoryId) =>
  db._raw
    .prepare(`SELECT * FROM repo_detect_states WHERE repository_id = ?`)
    .all(repositoryId)
    .map((row) => ({
      ref: row.ref === "" ? null : row.ref,
      detectStatus: row.detect_status,
      hasUpdate: Boolean(row.commit_sha) && row.commit_sha !== row.backed_up_commit_sha,
      lastError: row.last_error ?? null,
      nextDetectAfter: row.next_detect_after ?? null,
    }));

/** 由落库数据推导仓库级状态（service 层 toRepositoryDto 走的就是这个函数） */
function repoStateFromDb(db, repositoryId, { activeJobCount = 0, enabled = true } = {}) {
  const backups = readBackups(db, repositoryId);
  const latest = backups.length > 0 ? backups[backups.length - 1] : null;
  return resolveRepositoryState({
    enabled,
    latestBackup: latest
      ? { status: latest.status, errorMessage: latest.error_message, createdAt: latest.created_at }
      : null,
    detectStates: detectStatesOf(db, repositoryId),
    activeJobCount,
  });
}

// ==================== 1. 纯映射：skipped 不得映射成 failed ====================

test("映射：skipped / deferred / blocked 一律不是失败", () => {
  const outcomes = [
    outcomeFromBackupStatus("skipped"),
    outcomeFromBackupStatus("deferred"),
    REPO_OUTCOME.BLOCKED,
    REPO_OUTCOME.UP_TO_DATE,
    REPO_OUTCOME.PARTIAL,
    REPO_OUTCOME.SUCCESS,
    REPO_OUTCOME.RUNNING,
  ];
  for (const outcome of outcomes) {
    assert.equal(isFailureOutcome(outcome), false, `${outcome} 不应被判成失败`);
    assert.notEqual(outcomeTone(outcome), "error", `${outcome} 的色调不应是 error`);
  }

  // 只有真正失败才是 error
  assert.equal(isFailureOutcome(REPO_OUTCOME.FAILED), true);
  assert.equal(outcomeTone(REPO_OUTCOME.FAILED), "error");
});

test("映射：备份记录状态到统一结果的对应关系", () => {
  assert.equal(outcomeFromBackupStatus("success"), REPO_OUTCOME.SUCCESS);
  assert.equal(outcomeFromBackupStatus("partial"), REPO_OUTCOME.PARTIAL);
  assert.equal(outcomeFromBackupStatus("running"), REPO_OUTCOME.RUNNING);
  assert.equal(outcomeFromBackupStatus("failed"), REPO_OUTCOME.FAILED);
  assert.equal(outcomeFromBackupStatus("deferred"), REPO_OUTCOME.DEFERRED);
  // 「无需备份 / 已跳过」属于已是最新，不是失败
  assert.equal(outcomeFromBackupStatus("skipped"), REPO_OUTCOME.UP_TO_DATE);
  // 未知值按「暂无结果」处理，绝不臆断成失败
  assert.equal(outcomeFromBackupStatus("whatever"), REPO_OUTCOME.PENDING);
  assert.equal(outcomeFromBackupStatus(null), REPO_OUTCOME.PENDING);
});

test("映射：升级前写下的 skipped 延迟记录，靠 error_message 仍能识别成延迟", () => {
  // 修复前限流也写 skipped；升级后这些历史行不该显示成「已跳过（已是最新）」
  const legacy = {
    status: "skipped",
    errorMessage: "本次未能完成，已安排在 2026-10-03T10:00:00.000Z 自动重试：GitHub API 限流",
  };
  assert.equal(outcomeFromBackupStatus(legacy.status, legacy), REPO_OUTCOME.DEFERRED);
  assert.equal(isFailureOutcome(outcomeFromBackupStatus(legacy.status, legacy)), false);

  // 普通 skipped（例如任务被取消）仍是「已跳过」
  assert.equal(
    outcomeFromBackupStatus("skipped", { errorMessage: "备份已取消" }),
    REPO_OUTCOME.UP_TO_DATE,
  );
});

test("映射：无更新属于成功检测结果，限流不是失败，全错才是失败", () => {
  const ok = { detectStatus: DETECT_STATUS.OK, hasUpdate: false, lastError: null };
  assert.equal(outcomeFromDetectStates([ok]).outcome, REPO_OUTCOME.UP_TO_DATE);
  assert.equal(isSuccessOutcome(REPO_OUTCOME.UP_TO_DATE), true, "已是最新必须算成功结果");

  const update = { detectStatus: DETECT_STATUS.OK, hasUpdate: true, lastError: null };
  assert.equal(outcomeFromDetectStates([update]).outcome, REPO_OUTCOME.UPDATE_AVAILABLE);

  const deferred = { detectStatus: DETECT_STATUS.DEFERRED, hasUpdate: false, lastError: "限流", nextDetectAfter: "T" };
  const deferredResult = outcomeFromDetectStates([deferred]);
  assert.equal(deferredResult.outcome, REPO_OUTCOME.DEFERRED);
  assert.equal(isFailureOutcome(deferredResult.outcome), false);
  assert.equal(deferredResult.retryAt, "T", "延迟状态要带上重试时间供前端本地化展示");

  const error = { detectStatus: DETECT_STATUS.ERROR, hasUpdate: false, lastError: "分支不存在" };
  assert.equal(outcomeFromDetectStates([error]).outcome, REPO_OUTCOME.FAILED);

  // 一个分支延迟就说明本轮没查全，不能因为别的分支成功就说「已是最新」
  assert.equal(outcomeFromDetectStates([ok, deferred]).outcome, REPO_OUTCOME.DEFERRED);

  assert.equal(outcomeFromDetectStates([]).outcome, REPO_OUTCOME.PENDING);
});

// ==================== 2. 仓库级优先级 ====================

test("仓库级状态：正在写入 > 被占住 > 禁用 > 失败 > 延迟 > 检测结论", () => {
  const running = resolveRepositoryState({ latestBackup: { status: "running" } });
  assert.equal(running.outcome, REPO_OUTCOME.RUNNING);

  const blocked = resolveRepositoryState({ activeJobCount: 2, detectStates: [{ detectStatus: "ok", hasUpdate: false }] });
  assert.equal(blocked.outcome, REPO_OUTCOME.BLOCKED, "有未结束的作业时说明被其他任务占住");
  assert.equal(isFailureOutcome(blocked.outcome), false);

  const disabled = resolveRepositoryState({
    enabled: false,
    latestBackup: { status: "success" },
    detectStates: [{ detectStatus: "ok", hasUpdate: false }],
  });
  assert.equal(disabled.outcome, REPO_OUTCOME.BLOCKED, "仓库禁用时不能显示成成功/已是最新");

  const failed = resolveRepositoryState({ latestBackup: { status: "failed", errorMessage: "挂载点不可写" } });
  assert.equal(failed.outcome, REPO_OUTCOME.FAILED);
  assert.equal(failed.message, "挂载点不可写", "失败必须带原因");
  assert.equal(failed.tone, "error");

  const deferred = resolveRepositoryState({ latestBackup: { status: "deferred", errorMessage: "限流，已安排重试" } });
  assert.equal(deferred.outcome, REPO_OUTCOME.DEFERRED);
  assert.equal(deferred.tone, "warn");
  assert.equal(isFailureOutcome(deferred.outcome), false);

  const upToDate = resolveRepositoryState({
    latestBackup: { status: "success" },
    detectStates: [{ detectStatus: "ok", hasUpdate: false }],
  });
  assert.equal(upToDate.outcome, REPO_OUTCOME.UP_TO_DATE);
  assert.equal(upToDate.tone, "ok");
});

// ==================== 3. 验收一：无更新必须给出明确结果 ====================

test("验收1：检查更新发现无更新 —— 是成功结果，不是失败也不是空结果", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main"] });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();

  // 先把水位推到 b：模拟「这个版本已经备份过了」
  await codeRepo.ensureDetectStates(repoRow.id, [{ refType: "branch", ref: "main" }]);
  await advanceBackedUpWatermark(codeRepo, repoRow.id, "branch", "main", sha("b"));

  const { createdJobs, progress } = await runCheck({
    db,
    repoRow,
    responder: () => commitOk(sha("b")),
    payload: { createBackup: true, ignoreDue: true },
  });

  const stats = progress[progress.length - 1];
  const item = stats.itemResults[0];

  // 1) 检测本身成功，且没有任何失败/跳过计数
  assert.equal(item.status, "success");
  assert.equal(item.meta.outcome, REPO_OUTCOME.UP_TO_DATE);
  assert.match(item.message, /已是最新/, "必须明确说明已是最新，而不是留给用户猜");
  assert.equal(stats.failedCount, 0);
  assert.equal(stats.skippedCount, 0);
  assert.equal(stats.deferredCount, 0);

  // 2) 任务摘要也要说清「检查完成、已是最新」
  assert.match(stats.summary, /检查完成/, `摘要应明确表达检查完成，实际：${stats.summary}`);
  assert.match(stats.summary, /已是最新/);

  // 3) 不创建备份作业（无需备份）
  assert.equal(createdJobs.length, 0);

  // 4) 仓库管理页读到的状态同样是正常的「已是最新」，且没有把任何东西写成失败
  assert.equal(readRepoError(db, repoRow.id), null, "无更新不应在仓库上留下错误文本");
  const state = repoStateFromDb(db, repoRow.id);
  assert.equal(state.outcome, REPO_OUTCOME.UP_TO_DATE);
  assert.equal(state.tone, "ok");
  assert.equal(isFailureOutcome(state.outcome), false);

  // 5) 全程不写备份历史（没有发生任何备份尝试）
  assert.equal(readBackups(db, repoRow.id).length, 0);
});

test("验收1：检查更新发现新版本 —— 创建备份作业并带上已解析版本", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main"] });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();
  await codeRepo.ensureDetectStates(repoRow.id, [{ refType: "branch", ref: "main" }]);
  await advanceBackedUpWatermark(codeRepo, repoRow.id, "branch", "main", sha("b"));

  const { createdJobs, progress } = await runCheck({
    db,
    repoRow,
    responder: () => commitOk(sha("c")),
    payload: { createBackup: true, ignoreDue: true },
  });

  const stats = progress[progress.length - 1];
  assert.equal(stats.itemResults[0].meta.outcome, REPO_OUTCOME.UPDATE_AVAILABLE);
  assert.equal(createdJobs.length, 1);
  assert.equal(createdJobs[0].taskType, "repo_backup");
  assert.equal(createdJobs[0].payload.refs[0].commitSha, sha("c"));
  assert.equal(repoStateFromDb(db, repoRow.id).outcome, REPO_OUTCOME.UPDATE_AVAILABLE);
});

// ==================== 4. 验收四：限流显示延迟，不显示失败 ====================

test("验收4：检查阶段限流 —— 任务与仓库都显示「已延迟重试」，两处都不是失败", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main"] });

  const { progress } = await runCheck({
    db,
    repoRow,
    responder: () => rateLimited(),
    payload: { createBackup: true, ignoreDue: true },
  });

  const stats = progress[progress.length - 1];
  const item = stats.itemResults[0];

  // 任务列表：条目是非失败的「跳过」，但 outcome 明确是延迟，不是「无需备份」
  assert.equal(item.status, "skipped");
  assert.equal(item.meta.outcome, REPO_OUTCOME.DEFERRED);
  assert.equal(stats.failedCount, 0, "限流不得计入失败数（否则任务会被判失败）");
  assert.equal(stats.skippedCount, 1);
  assert.equal(stats.deferredCount, 1);

  // 仓库管理：既不能是失败，也不能在仓库上留下红色错误文本
  assert.equal(readRepoError(db, repoRow.id), null, "限流不是仓库的错，不该写 last_error");
  const state = repoStateFromDb(db, repoRow.id);
  assert.equal(state.outcome, REPO_OUTCOME.DEFERRED);
  assert.equal(state.tone, "warn");
  assert.equal(isFailureOutcome(state.outcome), false);
  assert.ok(state.retryAt, "延迟状态要带上重试时间");

  // 备份历史：这次尝试必须留下痕迹（修复前这里什么都没有，
  // 于是任务列表有「跳过」而历史是空的）
  const backups = readBackups(db, repoRow.id);
  assert.equal(backups.length, 1, "限流的备份尝试也要在历史里留痕");
  assert.equal(backups[0].status, "deferred");
  assert.match(backups[0].error_message, /自动重试/);
});

test("验收4：备份阶段限流 —— 记录写 deferred 而不是 failed，任务不被判失败", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMount(db);
  const repoRow = await seedRepo(db, { refs: ["main"] });

  // 下载源码归档时撞限流：这是「目标写入被推迟」，不是失败
  const { progress, thrown } = await runBackup({
    db,
    repoRow,
    payload: {
      refs: [{ refType: "branch", ref: "main", commitSha: sha("b"), version: "main@bbbbbbb" }],
    },
    responder: () => rateLimited(),
    uploadFile: async () => {
      throw new Error("不应走到上传");
    },
  });

  // 函数不抛异常：抛了会让 Workflows 步骤与 Node 任务被判失败并触发无意义重试
  assert.equal(thrown, null, `限流不应让任务失败，实际抛出：${thrown && thrown.message}`);

  const stats = progress[progress.length - 1];
  assert.equal(stats.failedCount, 0);
  assert.equal(stats.deferredCount, 1);
  assert.equal(stats.itemResults[0].meta.outcome, REPO_OUTCOME.DEFERRED);
  assert.equal(stats.itemResults[0].status, "skipped");

  const backups = readBackups(db, repoRow.id);
  assert.equal(backups.length, 1);
  assert.equal(backups[0].status, "deferred");
  assert.notEqual(backups[0].status, "failed");

  // 关键回归：修复前这里会往 last_error 写「已安排自动重试」，
  // 前端看到非空就渲染成红色失败 —— 两处结论因此不一致
  assert.equal(readRepoError(db, repoRow.id), null, "延迟说明不得写进 last_error");
  const state = repoStateFromDb(db, repoRow.id);
  assert.equal(state.outcome, REPO_OUTCOME.DEFERRED);
  assert.equal(state.tone, "warn");
});

// ==================== 5. 验收二：正常跳过 ====================

test("验收2：已备份过的版本再次备份 —— 两处都是非失败的「已是最新」", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMount(db);
  const repoRow = await seedRepo(db, { refs: ["main"] });
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();

  // 造一条「该 commit 已在全部目标上写成功」的备份记录
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO code_repository_backups
        (id, repository_id, ref_type, ref, commit_sha, version, status, storage_path, started_at, finished_at, created_at)
       VALUES ('bk-1', ?, 'branch', 'main', ?, 'main@bbbbbbb', 'success', '/backup/x.tar.gz', ?, ?, ?)`,
    )
    .bind(repoRow.id, sha("b"), now, now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO code_repository_backup_targets
        (id, backup_id, mount_id, mount_path, storage_path, status)
       VALUES ('bkt-1', 'bk-1', 'mount-1', '/backup', '/backup/x.tar.gz', 'success')`,
    )
    .run();

  const { progress, thrown } = await runBackup({
    db,
    repoRow,
    payload: {
      refs: [{ refType: "branch", ref: "main", commitSha: sha("b"), version: "main@bbbbbbb" }],
    },
    responder: () => {
      throw new Error("已存在的版本不应再请求 GitHub");
    },
    uploadFile: async () => {
      throw new Error("已存在的版本不应再上传");
    },
  });

  assert.equal(thrown, null);
  const stats = progress[progress.length - 1];
  const item = stats.itemResults[0];
  assert.equal(item.status, "skipped");
  assert.equal(item.meta.outcome, REPO_OUTCOME.UP_TO_DATE, "无需备份必须表达成「已是最新」");
  assert.equal(stats.failedCount, 0, "跳过不得计入失败");
  assert.equal(isFailureOutcome(item.meta.outcome), false);

  // 仓库管理读到的也是同一个结论，且没有任何失败文本
  assert.equal(readRepoError(db, repoRow.id), null);
  assert.equal(readBackups(db, repoRow.id).length, 1, "跳过不该新增备份记录");
  const state = repoStateFromDb(db, repoRow.id);
  assert.equal(state.outcome, REPO_OUTCOME.UP_TO_DATE);
  assert.equal(state.tone, "ok");
});

// ==================== 6. 验收三：真正失败 ====================

test("验收3：仓库/分支不存在 —— 两处都显示失败并带原因", async () => {
  const db = createTestDb();
  await setupSchema(db);
  const repoRow = await seedRepo(db, { refs: ["main"] });

  const { progress } = await runCheck({
    db,
    repoRow,
    responder: () => notFound(),
    payload: { createBackup: true, ignoreDue: true },
  });

  const stats = progress[progress.length - 1];
  const item = stats.itemResults[0];
  assert.equal(item.status, "failed");
  assert.equal(item.meta.outcome, REPO_OUTCOME.FAILED);
  assert.equal(stats.failedCount, 1);
  assert.match(stats.summary, /检测未成功/, "全失败时不能说「已是最新」");

  // 仓库管理：失败要看得见，并且带原因
  const state = repoStateFromDb(db, repoRow.id);
  assert.equal(state.outcome, REPO_OUTCOME.FAILED);
  assert.equal(state.tone, "error");
  assert.ok(state.message, "失败必须带原因");

  const backups = readBackups(db, repoRow.id);
  assert.equal(backups.length, 1, "失败的备份尝试要留痕（否则历史里看不到失败）");
  assert.equal(backups[0].status, "failed");
  assert.notEqual(backups[0].status, "deferred");
});

test("验收3：备份目标写入失败 —— 记录 failed，仓库显示失败原因", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMount(db);
  const repoRow = await seedRepo(db, { refs: ["main"] });

  const { progress, thrown } = await runBackup({
    db,
    repoRow,
    payload: {
      refs: [{ refType: "branch", ref: "main", commitSha: sha("c"), version: "main@ccccccc" }],
    },
    responder: () => jsonOk({}),
    uploadFile: async () => {
      throw new Error("存储配额不足");
    },
  });

  // 全部引用都失败：向上抛出，让任务被标记为失败
  assert.ok(thrown, "真正失败仍然要让任务失败（不能因为修 skipped 就把失败也吞掉）");
  const stats = progress[progress.length - 1];
  assert.equal(stats.failedCount, 1);
  assert.equal(stats.itemResults[0].meta.outcome, REPO_OUTCOME.FAILED);

  const backups = readBackups(db, repoRow.id);
  assert.equal(backups.length, 1);
  assert.equal(backups[0].status, "failed");
  assert.match(backups[0].error_message, /存储配额不足/);

  const state = repoStateFromDb(db, repoRow.id);
  assert.equal(state.outcome, REPO_OUTCOME.FAILED);
  assert.equal(state.tone, "error");
  assert.match(String(state.message), /存储配额不足/);
});

// ==================== 7. 端到端：两处结论必须一致 ====================

test("一致性：同一份落库数据推导出的状态，与任务条目给出的 outcome 永远同向", async () => {
  /**
   * 这条用例守的是「两个页面不许再各说各话」：
   * 任务条目的 meta.outcome 与仓库管理页的 state.outcome 都来自 status.js，
   * 因此只要后者是失败，前者就不可能是「已是最新」，反之亦然。
   */
  const cases = [
    { responder: () => rateLimited(), expect: REPO_OUTCOME.DEFERRED },
    { responder: () => notFound(), expect: REPO_OUTCOME.FAILED },
  ];

  for (const scenario of cases) {
    const db = createTestDb();
    await setupSchema(db);
    const repoRow = await seedRepo(db, { refs: ["main"] });

    const { progress } = await runCheck({
      db,
      repoRow,
      responder: scenario.responder,
      payload: { createBackup: true, ignoreDue: true },
    });

    const itemOutcome = progress[progress.length - 1].itemResults[0].meta.outcome;
    const repoOutcome = repoStateFromDb(db, repoRow.id).outcome;

    assert.equal(itemOutcome, scenario.expect);
    assert.equal(repoOutcome, scenario.expect, "任务条目与仓库管理的结论必须一致");
    assert.equal(
      isFailureOutcome(itemOutcome),
      isFailureOutcome(repoOutcome),
      "「算不算失败」两处也必须一致",
    );
  }
});
