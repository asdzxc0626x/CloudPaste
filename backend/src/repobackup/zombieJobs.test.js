/**
 * 回归测试：卡在 running 的编排任务收尾（修改点：阶段 1 任务卡在 running）
 *
 * 背景
 * ----
 * Cloudflare Workers 的 CPU 超限是运行时直接杀 isolate，JS 捕获不到：
 * JobWorkflow 里 execute-task 外面那层 catch、以及 finalize-task-record
 * 一个都不会执行，于是 tasks 那一行永久停在 running，finished_at /
 * error_message 全是空，「任务管理」页表现为「一直在执行、看不到原因」。
 * Node/Docker 侧由 SQLiteTaskOrchestrator.recoverJobs() 在进程启动时兜住，
 * Workers 侧原先**没有任何收敛路径**。
 *
 * 这一组盯的是「收尾」这件事做错了会很危险的几个点：
 *  1. 必须只收尾确实已经死掉的（running + 长时间没心跳）；
 *  2. 绝不能碰还活着的作业 —— 进度上报会刷新 updated_at，
 *     把一个正在传 355MB 的作业打成 failed，用户会看到假失败；
 *  3. 绝不能碰 pending —— 免费计划有并发实例上限，排队是正常状态，
 *     误判会把还没开始的作业判死；
 *  4. 绝不能覆盖终态 —— 这是「过期任务覆盖新状态」那一类最隐蔽的 bug：
 *     已经 completed 的行被改成 failed，等于凭空制造一次失败；
 *  5. 必须按仓库和任务类型精确过滤，不能连带别的仓库/别的任务；
 *  6. tasks 的收尾必须**独立于**备份历史的收尾 ——
 *     repo_backup_check 压根不写备份历史表，repo_backup 也可能在
 *     创建备份记录之前就被杀掉，这两种情况备份历史是干净的，
 *     而原实现「没有僵尸备份记录就直接 return」会让 tasks 永远没人管。
 *
 * 运行：node --test src/repobackup/zombieJobs.test.js（整仓用 `npm test`）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DatabaseSync } from "node:sqlite";
import { createCodeRepositoryTables, createTasksTables } from "../db/migrations/sqlite/engine/schema.js";
import { CodeRepositoryRepository } from "../repositories/CodeRepositoryRepository.js";
import { finalizeZombieBackups } from "./zombies.js";
import { ZOMBIE_RUNNING_BACKUP_SEC } from "./schedule.js";

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

const ZOMBIE_MS = ZOMBIE_RUNNING_BACKUP_SEC * 1000;
/** 稳稳超过收尾窗口 */
const DEAD_AGO = ZOMBIE_MS + 10 * 60 * 1000;
/** 稳稳在窗口之内（模拟「刚刚还在上报进度」） */
const ALIVE_AGO = 60 * 1000;

async function setup() {
  const db = createTestDb();
  await createCodeRepositoryTables(db);
  await createTasksTables(db);
  return { db, codeRepo: new CodeRepositoryRepository(db) };
}

/**
 * 造一行 tasks
 * @param {object} db
 * @param {{taskId: string, taskType?: string, status: string, repositoryId?: string|null,
 *          updatedAgoMs?: number, payload?: string}} spec
 */
async function seedTask(db, spec) {
  const now = Date.now();
  const updatedAt = now - (spec.updatedAgoMs ?? 0);
  const payload =
    spec.payload !== undefined
      ? spec.payload
      : JSON.stringify({ repositoryId: spec.repositoryId ?? "repo-1" });

  await db
    .prepare(
      `INSERT INTO tasks
        (task_id, task_type, status, payload, stats, user_id, user_type,
         trigger_type, created_at, started_at, updated_at)
       VALUES (?, ?, ?, ?, '{}', 'system', 'admin', 'scheduled', ?, ?, ?)`,
    )
    .bind(
      spec.taskId,
      spec.taskType ?? "repo_backup",
      spec.status,
      payload,
      updatedAt,
      updatedAt,
      updatedAt,
    )
    .run();
}

const readTask = async (db, taskId) =>
  await db.prepare(`SELECT * FROM tasks WHERE task_id = ?`).bind(taskId).first();

const sweep = (codeRepo, repositoryId = "repo-1") =>
  finalizeZombieBackups({ codeRepo, repositoryId, repoLabel: "测试仓库" });

// ==================== 该收的要收 ====================

test("running 且长时间没心跳：收尾成 failed，并补上原因与 finished_at", async () => {
  const { db, codeRepo } = await setup();
  await seedTask(db, { taskId: "job-dead", status: "running", updatedAgoMs: DEAD_AGO });

  const result = await sweep(codeRepo);
  assert.equal(result.finalizedJobs, 1);

  const row = await readTask(db, "job-dead");
  assert.equal(row.status, "failed");
  assert.ok(row.finished_at > 0, "必须写 finished_at，否则前端仍按未结束渲染");
  // 原因要点明「执行体已终止」，并指向真正能看到 CPU 时间的地方
  assert.match(row.error_message, /执行体已终止/);
  assert.match(row.error_message, /exceededCpu/);
});

test("repo_backup_check 同样在收尾范围内（它压根不写备份历史表）", async () => {
  const { db, codeRepo } = await setup();
  await seedTask(db, {
    taskId: "job-check",
    taskType: "repo_backup_check",
    status: "running",
    updatedAgoMs: DEAD_AGO,
  });

  const result = await sweep(codeRepo);
  assert.equal(result.finalizedJobs, 1);
  assert.equal((await readTask(db, "job-check")).status, "failed");
});

test("备份历史里一条僵尸都没有，tasks 的收尾也必须照常发生（原实现会提前 return）", async () => {
  const { db, codeRepo } = await setup();
  // 刻意不造任何 code_repository_backups 行
  await seedTask(db, { taskId: "job-only", status: "running", updatedAgoMs: DEAD_AGO });

  const result = await sweep(codeRepo);
  assert.equal(result.finalized, 0, "备份历史确实没有可收尾的");
  assert.equal(result.finalizedJobs, 1, "但 tasks 必须被收尾");
  assert.match(result.summary, /作业/);
});

// ==================== 不该碰的一律不碰 ====================

test("running 但刚上报过进度：绝不能碰（否则正在传的大仓库会显示假失败）", async () => {
  const { db, codeRepo } = await setup();
  await seedTask(db, { taskId: "job-alive", status: "running", updatedAgoMs: ALIVE_AGO });

  const result = await sweep(codeRepo);
  assert.equal(result.finalizedJobs, 0);

  const row = await readTask(db, "job-alive");
  assert.equal(row.status, "running");
  assert.equal(row.error_message, null);
  assert.equal(row.finished_at, null);
});

test("pending 即使很旧也不碰：免费计划下实例排队是正常状态", async () => {
  const { db, codeRepo } = await setup();
  await seedTask(db, { taskId: "job-queued", status: "pending", updatedAgoMs: DEAD_AGO });

  assert.equal((await sweep(codeRepo)).finalizedJobs, 0);
  assert.equal((await readTask(db, "job-queued")).status, "pending");
});

test("终态行绝不能被覆盖：completed / failed / partial / cancelled 全部原样保留", async () => {
  const { db, codeRepo } = await setup();
  for (const status of ["completed", "failed", "partial", "cancelled"]) {
    await seedTask(db, { taskId: `job-${status}`, status, updatedAgoMs: DEAD_AGO });
  }

  assert.equal((await sweep(codeRepo)).finalizedJobs, 0);

  for (const status of ["completed", "failed", "partial", "cancelled"]) {
    const row = await readTask(db, `job-${status}`);
    assert.equal(row.status, status, `${status} 被改写了，这正是「过期任务覆盖新状态」`);
    assert.equal(row.finished_at, null, "不该被收尾的行不应补 finished_at");
  }
});

test("只收尾本仓库：别的仓库的僵尸作业不受影响", async () => {
  const { db, codeRepo } = await setup();
  await seedTask(db, { taskId: "job-mine", status: "running", updatedAgoMs: DEAD_AGO, repositoryId: "repo-1" });
  await seedTask(db, { taskId: "job-other", status: "running", updatedAgoMs: DEAD_AGO, repositoryId: "repo-2" });

  assert.equal((await sweep(codeRepo, "repo-1")).finalizedJobs, 1);
  assert.equal((await readTask(db, "job-mine")).status, "failed");
  assert.equal((await readTask(db, "job-other")).status, "running");
});

test("不在范围内的任务类型不碰（copy 等任务有自己的生命周期）", async () => {
  const { db, codeRepo } = await setup();
  await seedTask(db, { taskId: "job-copy", taskType: "copy", status: "running", updatedAgoMs: DEAD_AGO });

  assert.equal((await sweep(codeRepo)).finalizedJobs, 0);
  assert.equal((await readTask(db, "job-copy")).status, "running");
});

test("payload 不是合法 JSON 的历史脏数据：跳过而不是让整条 SQL 报错", async () => {
  const { db, codeRepo } = await setup();
  await seedTask(db, { taskId: "job-broken", status: "running", updatedAgoMs: DEAD_AGO, payload: "not-json" });

  // 不抛异常，且不误伤
  assert.equal((await sweep(codeRepo)).finalizedJobs, 0);
  assert.equal((await readTask(db, "job-broken")).status, "running");
});

// ==================== 幂等 ====================

test("重复调用幂等：每个 tick 和每次手动备份都会调，不能重复计数或反复改写", async () => {
  const { db, codeRepo } = await setup();
  await seedTask(db, { taskId: "job-dead", status: "running", updatedAgoMs: DEAD_AGO });

  assert.equal((await sweep(codeRepo)).finalizedJobs, 1);
  const first = await readTask(db, "job-dead");

  // 第二次：已经是终态，收尾范围内不应再有它
  const second = await sweep(codeRepo);
  assert.equal(second.finalizedJobs, 0);
  assert.equal(second.summary, "");

  const after = await readTask(db, "job-dead");
  assert.equal(after.finished_at, first.finished_at, "终态行不应被反复改写");
});

test("无事可做时返回空摘要，不污染调度运行摘要", async () => {
  const { codeRepo } = await setup();
  const result = await sweep(codeRepo);
  assert.deepEqual(result, { finalized: 0, finalizedJobs: 0, summary: "" });
});

// ==================== 调用方契约 ====================

test("缺少必要参数时安全返回，绝不抛错打断调用方主流程", async () => {
  const { codeRepo } = await setup();
  assert.deepEqual(await finalizeZombieBackups({ codeRepo, repositoryId: "" }), {
    finalized: 0,
    finalizedJobs: 0,
    summary: "",
  });
  assert.deepEqual(await finalizeZombieBackups({ codeRepo: null, repositoryId: "repo-1" }), {
    finalized: 0,
    finalizedJobs: 0,
    summary: "",
  });
});

test("仓库层查询出错时也不抛错：收尾只是补说明，不能影响备份主流程", async () => {
  const { codeRepo } = await setup();
  // 两个依赖都换成会抛错的实现
  codeRepo.findRunningBackupsBefore = async () => {
    throw new Error("D1 unavailable");
  };
  codeRepo.finalizeStaleRepoJobs = async () => {
    throw new Error("D1 unavailable");
  };

  const result = await finalizeZombieBackups({ codeRepo, repositoryId: "repo-1" });
  assert.deepEqual(result, { finalized: 0, finalizedJobs: 0, summary: "" });
});

test("备份历史收尾失败，不影响 tasks 收尾（两步相互独立）", async () => {
  const { db, codeRepo } = await setup();
  await seedTask(db, { taskId: "job-dead", status: "running", updatedAgoMs: DEAD_AGO });
  codeRepo.findRunningBackupsBefore = async () => {
    throw new Error("D1 unavailable");
  };

  const result = await finalizeZombieBackups({ codeRepo, repositoryId: "repo-1" });
  assert.equal(result.finalizedJobs, 1);
  assert.equal((await readTask(db, "job-dead")).status, "failed");
});
