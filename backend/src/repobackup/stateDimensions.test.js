/**
 * 第 5 期验收测试：检测 / 备份 / 调度三个维度
 *
 * 运行：node --test src/repobackup/stateDimensions.test.js
 *
 * 覆盖（对应第 5 期「二、前端状态展示」）：
 *   1. 三个维度各自的取值与色调，覆盖需求里点名的 9 个展示状态
 *   2. 「检测状态 ≠ 备份状态 ≠ 调度状态」：三者互不冒充，
 *      尤其调度维度只认 scheduled_jobs，不用备份历史记录顶替
 *   3. 残留的 running 备份记录不再冒充「备份中」
 *   4. 合并结论新增「检测中」，且旧调用方（只传 activeJobCount）行为不变
 *   5. 中英文案键齐全（键缺失时前端会把 key 直接显示出来）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REPO_OUTCOME,
  DETECT_OUTCOME,
  BACKUP_STATE,
  SCHEDULE_STATE,
  buildDetectState,
  buildBackupState,
  buildScheduleState,
  resolveRepositoryState,
} from "./status.js";
import { STALE_RUNNING_BACKUP_SEC } from "./schedule.js";

import zhRepoBackup from "../../../frontend/src/i18n/locales/zh-CN/admin/repoBackup.js";
import enRepoBackup from "../../../frontend/src/i18n/locales/en-US/admin/repoBackup.js";

import { DatabaseSync } from "node:sqlite";
import {
  createCodeRepositoryTables,
  createRepoDetectStatesTable,
  createStorageTables,
  createTasksTables,
  createScheduledJobsTables,
  createScheduledJobRunsTables,
} from "../db/migrations/sqlite/engine/schema.js";
import { RepositoryFactory } from "../repositories/index.js";
import { listRepositories } from "../services/codeRepositoryService.js";

/** 造一条 toDetectStateDto 形态的检测状态 */
function detectState(overrides = {}) {
  return {
    refType: "branch",
    ref: "main",
    detectStatus: "ok",
    hasUpdate: false,
    alreadyBackedUp: true,
    lastError: null,
    nextDetectAfter: null,
    ...overrides,
  };
}

// ==================== 1. 检测维度 ====================

test("检测维度：等待检测 / 检测中 / 无更新 / 检测到更新 / 延迟重试 / 失败", () => {
  // 等待检测：还没有任何检测状态
  const pending = buildDetectState({});
  assert.equal(pending.status, DETECT_OUTCOME.PENDING);
  assert.equal(pending.tone, "muted");

  // 检测中：有正在跑的检测作业（优先于上一轮的结论）
  const detecting = buildDetectState({
    detectStates: [detectState()],
    activeCheckCount: 1,
  });
  assert.equal(detecting.status, DETECT_OUTCOME.DETECTING);
  assert.equal(detecting.tone, "info");
  assert.equal(detecting.trackedRefCount, 1);

  // 无更新
  const upToDate = buildDetectState({ detectStates: [detectState({ hasUpdate: false })] });
  assert.equal(upToDate.status, DETECT_OUTCOME.UP_TO_DATE);
  assert.equal(upToDate.tone, "ok");

  // 检测到更新：这是「有动作待做」，用 info 而不是正常态的 ok
  const hasUpdate = buildDetectState({ detectStates: [detectState({ hasUpdate: true })] });
  assert.equal(hasUpdate.status, DETECT_OUTCOME.UPDATE_AVAILABLE);
  assert.equal(hasUpdate.tone, "info");
  assert.equal(hasUpdate.updatedRefCount, 1);

  // 延迟重试：带出可本地化的重试时间
  const deferred = buildDetectState({
    detectStates: [detectState({ detectStatus: "deferred", lastError: "限流", nextDetectAfter: "2026-10-05T03:00:00.000Z" })],
  });
  assert.equal(deferred.status, DETECT_OUTCOME.DEFERRED);
  assert.equal(deferred.tone, "warn");
  assert.equal(deferred.retryAt, "2026-10-05T03:00:00.000Z");
  assert.equal(deferred.nextDetectAfter, "2026-10-05T03:00:00.000Z");

  // 失败
  const failed = buildDetectState({
    detectStates: [detectState({ detectStatus: "error", lastError: "分支不存在" })],
  });
  assert.equal(failed.status, DETECT_OUTCOME.FAILED);
  assert.equal(failed.tone, "error");
  assert.equal(failed.message, "分支不存在");
});

// ==================== 2. 备份维度 ====================

test("备份维度：尚无备份 / 备份中 / 已备份 / 部分成功 / 已跳过 / 延迟重试 / 失败", () => {
  assert.equal(buildBackupState({}).status, BACKUP_STATE.PENDING);
  assert.equal(buildBackupState({}).tone, "muted");

  // 备份中：有新鲜的 running 记录
  const running = buildBackupState({ latestBackup: { status: "running", startedAt: new Date().toISOString() } });
  assert.equal(running.status, BACKUP_STATE.RUNNING);
  assert.equal(running.tone, "info");

  // 有备份作业在跑但记录还没落库，同样算「备份中」
  const runningByJob = buildBackupState({ latestBackup: null, activeBackupCount: 1 });
  assert.equal(runningByJob.status, BACKUP_STATE.RUNNING);

  const success = buildBackupState({ latestBackup: { status: "success", finishedAt: "2026-10-05T01:00:00.000Z", ref: "main" } });
  assert.equal(success.status, BACKUP_STATE.SUCCESS);
  assert.equal(success.tone, "ok");
  assert.equal(success.ref, "main");

  assert.equal(buildBackupState({ latestBackup: { status: "partial" } }).status, BACKUP_STATE.PARTIAL);

  // 已跳过：跑过了但无需备份，既不是成功快照也不是故障
  const skipped = buildBackupState({ latestBackup: { status: "skipped" } });
  assert.equal(skipped.status, BACKUP_STATE.SKIPPED);
  assert.equal(skipped.tone, "muted");

  const deferred = buildBackupState({ latestBackup: { status: "deferred", errorMessage: "限流" } });
  assert.equal(deferred.status, BACKUP_STATE.DEFERRED);
  assert.equal(deferred.tone, "warn");

  const failed = buildBackupState({ latestBackup: { status: "failed", errorMessage: "挂载点不可写" } });
  assert.equal(failed.status, BACKUP_STATE.FAILED);
  assert.equal(failed.tone, "error");
  assert.equal(failed.message, "挂载点不可写");
});

test("备份维度：残留的 running 记录不再冒充「备份中」", () => {
  // 超过超期窗口（6 小时）的 running：任务被杀留下的脏记录
  const staleAt = new Date(Date.now() - (STALE_RUNNING_BACKUP_SEC + 60) * 1000).toISOString();
  const stale = buildBackupState({ latestBackup: { status: "running", startedAt: staleAt, createdAt: staleAt } });
  assert.equal(stale.status, BACKUP_STATE.PENDING, "残留 running 不能一直显示「备份中」");

  // 但真有作业在跑时，仍然显示「备份中」
  const staleButRunning = buildBackupState({
    latestBackup: { status: "running", startedAt: staleAt, createdAt: staleAt },
    activeBackupCount: 1,
  });
  assert.equal(staleButRunning.status, BACKUP_STATE.RUNNING);

  // 窗口内（1 分钟前）的 running 是正常进行中
  const fresh = buildBackupState({
    latestBackup: { status: "running", startedAt: new Date(Date.now() - 60 * 1000).toISOString() },
  });
  assert.equal(fresh.status, BACKUP_STATE.RUNNING);
});

// ==================== 3. 调度维度 ====================

test("调度维度：未配置 / 定时已关闭 / 等待下次执行 / 上次调度失败", () => {
  const none = buildScheduleState({});
  assert.equal(none.status, SCHEDULE_STATE.NONE);
  assert.equal(none.enabled, false);

  const disabled = buildScheduleState({ schedule: { enabled: false, nextRunAfter: "2026-10-06T00:00:00.000Z" } });
  assert.equal(disabled.status, SCHEDULE_STATE.DISABLED);

  const waiting = buildScheduleState({
    schedule: { enabled: true, nextRunAfter: "2026-10-05T12:00:00.000Z", lastRunStatus: "success", runtimeState: "scheduled" },
  });
  assert.equal(waiting.status, SCHEDULE_STATE.WAITING);
  assert.equal(waiting.nextRunAfter, "2026-10-05T12:00:00.000Z");
  assert.equal(waiting.enabled, true);

  const failed = buildScheduleState({ schedule: { enabled: true, lastRunStatus: "failure" } });
  assert.equal(failed.status, SCHEDULE_STATE.FAILED);
  assert.equal(failed.tone, "error");
});

test("调度维度只认 scheduled_jobs：没有计划就是「未配置」，不会被备份记录顶替", () => {
  // 即便最近一次备份是成功的，只要没有备份计划，调度维度就是「未配置定时」
  const state = buildScheduleState({ schedule: null });
  assert.equal(state.status, SCHEDULE_STATE.NONE);
  assert.equal(state.nextRunAfter, null);
});

// ==================== 4. 合并结论：新增「检测中」，旧调用方行为不变 ====================

test("合并结论：检测作业在跑显示「检测中」，不是「已被阻止」", () => {
  const detecting = resolveRepositoryState({
    detectStates: [detectState()],
    activeCheckCount: 1,
    activeBackupCount: 0,
  });
  assert.equal(detecting.outcome, REPO_OUTCOME.DETECTING);
  assert.equal(detecting.tone, "info");
});

test("合并结论：备份作业占用仍然是「已被阻止」，优先于「检测中」", () => {
  const blocked = resolveRepositoryState({
    detectStates: [detectState()],
    activeCheckCount: 1,
    activeBackupCount: 1,
  });
  assert.equal(blocked.outcome, REPO_OUTCOME.BLOCKED);
  assert.match(blocked.message, /1 个任务正在进行中/);
});

test("合并结论：只传 activeJobCount 的旧调用方行为完全不变", () => {
  const legacy = resolveRepositoryState({
    detectStates: [detectState()],
    activeJobCount: 2,
  });
  assert.equal(legacy.outcome, REPO_OUTCOME.BLOCKED, "旧口径下活跃作业一律按「被占住」处理");
});

test("合并结论：残留 running 记录不再让仓库永远停在「进行中」", () => {
  const staleAt = new Date(Date.now() - (STALE_RUNNING_BACKUP_SEC + 60) * 1000).toISOString();
  const state = resolveRepositoryState({
    latestBackup: { status: "running", startedAt: staleAt, createdAt: staleAt },
    detectStates: [detectState({ hasUpdate: false })],
  });
  assert.equal(state.outcome, REPO_OUTCOME.UP_TO_DATE, "残留 running 应被忽略，回落到检测结论");
});

// ==================== 5. 文案键齐全 ====================

test("文案：三个维度的全部取值在 zh-CN / en-US 都有对应文案", () => {
  const check = (dict, namespace, values, label) => {
    for (const value of values) {
      const text = dict?.repoBackup?.[namespace]?.[value];
      assert.equal(typeof text, "string", `${label} 缺少 admin.repoBackup.${namespace}.${value}`);
      assert.ok(text.length > 0, `${label} 的 admin.repoBackup.${namespace}.${value} 是空文案`);
    }
  };

  const detectValues = Object.values(DETECT_OUTCOME);
  const backupValues = Object.values(BACKUP_STATE);
  const scheduleValues = Object.values(SCHEDULE_STATE);

  for (const [dict, label] of [[zhRepoBackup, "zh-CN"], [enRepoBackup, "en-US"]]) {
    check(dict, "detectStatus", detectValues, label);
    check(dict, "backupState", backupValues, label);
    check(dict, "scheduleState", scheduleValues, label);
    // 维度名（检测 / 备份 / 调度）
    for (const name of ["detect", "backup", "schedule"]) {
      const text = dict?.repoBackup?.dimension?.[name];
      assert.equal(typeof text, "string", `${label} 缺少 admin.repoBackup.dimension.${name}`);
    }
  }
});

// ==================== 6. 端到端：列表接口下发三个维度 ====================

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
  await createScheduledJobsTables(db);
  await createScheduledJobRunsTables(db);
}

const ENV = { ENCRYPTION_SECRET: "test-secret-test-secret-test-secret" };

async function seedRepo(db, id = "repo-1") {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO code_repositories
        (id, provider, name, repo_identifier, track_mode, track_ref, track_refs_json,
         target_mount_id, target_mount_ids_json, target_path_prefix, retention_count,
         enabled, config_json, created_at, updated_at)
       VALUES (?, 'github', ?, 'octocat/Hello-World', 'branch', 'main', '["main"]',
               'mount-1', '["mount-1"]', '/', 10, 1, '{}', ?, ?)`,
    )
    .bind(id, `仓库${id}`, now, now)
    .run();
}

/** 造一条「未结束的作业」（并发守卫与「检测中」都读它） */
async function seedActiveTask(db, { taskId, taskType, repositoryId, status = "running" }) {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO tasks (task_id, task_type, status, payload, stats, user_id, user_type, trigger_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, '{}', 'admin', 'admin', 'scheduled', ?, ?)`,
    )
    .bind(taskId, taskType, status, JSON.stringify({ repositoryId }), now, now)
    .run();
}

test("端到端：列表接口同时下发三个维度，且调度维度来自 scheduled_jobs", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedRepo(db, "repo-e2e");

  // 检测状态：上一轮成功、无更新
  const codeRepo = new RepositoryFactory(db, { env: ENV }).getCodeRepositoryRepository();
  await codeRepo.ensureDetectStates("repo-e2e", [{ refType: "branch", ref: "main" }]);
  await codeRepo.updateDetectState("repo-e2e", "branch", "main", {
    detect_status: "ok",
    commit_sha: "a".repeat(40),
    backed_up_commit_sha: "a".repeat(40),
    last_success_detect_at: new Date().toISOString(),
  });

  // 一个正在跑的检测作业 → 检测中
  await seedActiveTask(db, { taskId: "t-check", taskType: "repo_backup_check", repositoryId: "repo-e2e" });

  // 备份计划：启用中、上次调度失败 → 调度维度应为「上次调度失败」
  const nextRunAfter = new Date(Date.now() + 3600_000).toISOString();
  await db
    .prepare(
      `INSERT INTO scheduled_jobs (task_id, handler_id, name, schedule_type, interval_sec, enabled, next_run_after, last_run_status, config_json)
       VALUES ('repo_backup_repo-e2e', 'repo_backup_schedule', '仓库备份', 'interval', 21600, 1, ?, 'failure', '{"repositoryId":"repo-e2e"}')`,
    )
    .bind(nextRunAfter)
    .run();

  const list = await listRepositories(db, null, ENV.ENCRYPTION_SECRET, ENV);
  assert.equal(list.length, 1);
  const dto = list[0];

  // 作业数按类型拆分（批量查询路径）
  assert.equal(dto.activeCheckCount, 1, "应识别出 1 个未结束的检测作业");
  assert.equal(dto.activeBackupCount, 0);
  assert.equal(dto.activeJobCount, 1);

  // 检测维度：作业在跑 → 检测中
  assert.equal(dto.detectState.status, DETECT_OUTCOME.DETECTING);
  assert.equal(dto.detectState.trackedRefCount, 1);

  // 备份维度：没有任何备份记录 → 尚无备份（不是「已跳过」，也不是「已备份」）
  assert.equal(dto.backupState.status, BACKUP_STATE.PENDING);

  // 调度维度：完全来自 scheduled_jobs
  assert.equal(dto.scheduleState.status, SCHEDULE_STATE.FAILED);
  assert.equal(dto.scheduleState.nextRunAfter, nextRunAfter);
  assert.equal(dto.scheduleState.enabled, true);

  // 合并结论：检测中优先于「已是最新」的检测结论
  assert.equal(dto.state.outcome, REPO_OUTCOME.DETECTING);
});

test("端到端：批量统计作业数不会把别的仓库算进来", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedRepo(db, "repo-a");
  await seedRepo(db, "repo-b");

  await seedActiveTask(db, { taskId: "t-a", taskType: "repo_backup_check", repositoryId: "repo-a" });
  await seedActiveTask(db, { taskId: "t-b1", taskType: "repo_backup", repositoryId: "repo-b" });
  await seedActiveTask(db, { taskId: "t-b2", taskType: "repo_backup_check", repositoryId: "repo-b" });

  const list = await listRepositories(db, null, ENV.ENCRYPTION_SECRET, ENV);
  const byId = new Map(list.map((item) => [item.id, item]));

  assert.equal(byId.get("repo-a").activeCheckCount, 1);
  assert.equal(byId.get("repo-a").activeBackupCount, 0);

  assert.equal(byId.get("repo-b").activeCheckCount, 1);
  assert.equal(byId.get("repo-b").activeBackupCount, 1);
  assert.equal(byId.get("repo-b").activeJobCount, 2);
});
