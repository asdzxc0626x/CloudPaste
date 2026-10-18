import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { createTasksTables } from "../db/migrations/sqlite/engine/schema.js";
import { taskRegistry } from "../storage/fs/tasks/TaskRegistry.ts";
import { CodeRepositoryRepository } from "../repositories/CodeRepositoryRepository.js";
import { ZOMBIE_RUNNING_BACKUP_SEC } from "../repobackup/schedule.js";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        url: "data:text/javascript,export class WorkflowEntrypoint { constructor(ctx, env) { this.env = env; } }",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
const { JobWorkflow } = await import("./JobWorkflow.ts");
hooks.deregister();

const INITIAL_STATS = { totalItems: 2, processedItems: 0, successCount: 0, failedCount: 0, skippedCount: 0 };

async function setup(context) {
  const raw = new DatabaseSync(":memory:");
  context.after(() => raw.close());
  let now = 100000;
  context.mock.method(Date, "now", () => now);
  const db = {
    writes: [],
    reads: 0,
    beforeWrite: null,
    prepare(sql) {
      const statement = raw.prepare(sql);
      let args = [];
      const query = {
        bind(...values) { args = values; return query; },
        async first() {
          db.reads++;
          return statement.get(...args) ?? null;
        },
        async run() {
          if (/UPDATE tasks/.test(sql)) {
            if (db.beforeWrite) await db.beforeWrite();
            db.writes.push({ sql, args });
          }
          return { meta: { changes: Number(statement.run(...args).changes) } };
        },
      };
      return query;
    },
  };
  await createTasksTables(db);
  raw.prepare(`INSERT INTO tasks
    (task_id, task_type, status, payload, stats, user_id, user_type, trigger_type, created_at, updated_at)
    VALUES ('job-1', 'repo_backup', 'pending', '{}', ?, 'admin', 'admin', 'manual', ?, ?)`)
    .run(JSON.stringify(INITIAL_STATS), now, now);
  const workflow = new JobWorkflow({}, { DB: db });
  const execution = workflow.createExecutionContext("job-1", null);
  return {
    db, raw, workflow, execution,
    advance: (milliseconds) => { now += milliseconds; },
    row: () => raw.prepare("SELECT * FROM tasks WHERE task_id = 'job-1'").get(),
    stats: () => JSON.parse(raw.prepare("SELECT stats FROM tasks WHERE task_id = 'job-1'").get().stats),
  };
}

test("完整 report 快照与 processedItems/字节变化不会绕过 10 秒 D1 节流", async (context) => {
  const { db, execution, advance, stats, row } = await setup(context);
  await execution.updateProgress("job-1", INITIAL_STATS);
  for (let tick = 1; tick < 10; tick++) {
    advance(1000);
    await execution.updateProgress("job-1", { ...INITIAL_STATS, processedItems: tick, bytesTransferred: tick * 100 });
  }
  assert.equal(db.writes.length, 1);
  assert.equal(db.reads, 1);
  advance(999);
  await execution.updateProgress("job-1", { bytesTransferred: 999 });
  assert.equal(db.writes.length, 1);
  advance(1);
  await execution.updateProgress("job-1", { bytesTransferred: 1000 });
  assert.equal(db.writes.length, 2);
  assert.equal(db.reads, 2);
  assert.equal(stats().processedItems, 9);
  assert.equal(stats().bytesTransferred, 1000);
  assert.equal(stats().heartbeatAtMs, Date.now());
  assert.equal(row().updated_at, Date.now());
});

test("结果计数、阶段、重试和原地修改的条目状态及时落盘，条目字节进度仍节流", async (context) => {
  const { db, execution, stats } = await setup(context);
  const itemResults = [{ sourcePath: "/source", targetPath: "/target", status: "processing", bytesTransferred: 0 }];
  await execution.updateProgress("job-1", { ...INITIAL_STATS, itemResults });
  itemResults[0].bytesTransferred = 123;
  await execution.updateProgress("job-1", { ...INITIAL_STATS, itemResults });
  assert.equal(db.writes.length, 1);
  itemResults[0].status = "retrying";
  itemResults[0].retryCount = 1;
  await execution.updateProgress("job-1", { itemResults });
  assert.equal(db.writes.length, 2);
  assert.equal(stats().itemResults[0].bytesTransferred, 123);
  for (const patch of [
    { totalItems: 3 }, { successCount: 1 }, { failedCount: 1 }, { skippedCount: 1 },
    { deferredCount: 1 }, { stage: "uploading" }, { currentRef: "main" },
    { currentTargetPath: "/backup" }, { currentMountId: "mount-2" },
    { deferRetryAt: "2026-10-18T12:00:00Z" }, { durationMs: 500 },
  ]) {
    const writesBefore = db.writes.length;
    await execution.updateProgress("job-1", patch);
    assert.equal(db.writes.length, writesBefore + 1, JSON.stringify(patch));
    await execution.updateProgress("job-1", patch);
    assert.equal(db.writes.length, writesBefore + 1, "重复关键字段不应强制写盘");
  }
});

test("异步进度写入串行化，较早写入不会覆盖关键结果或吞掉 pending", async (context) => {
  const { db, execution, advance, stats } = await setup(context);
  await execution.updateProgress("job-1", INITIAL_STATS);
  advance(10000);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  db.beforeWrite = async () => {
    db.beforeWrite = null;
    started.resolve();
    await release.promise;
  };
  const progress = execution.updateProgress("job-1", { bytesTransferred: 100 });
  await started.promise;
  const result = execution.updateProgress("job-1", { successCount: 1, processedItems: 1, bytesTransferred: 200 });
  release.resolve();
  await Promise.all([progress, result]);
  assert.equal(stats().successCount, 1);
  assert.equal(stats().processedItems, 1);
  assert.equal(stats().bytesTransferred, 200);
  assert.equal(db.writes.length, 3);
});

test("D1 写失败保留待写快照，下次更新可重试，不丢结果或提前推进节流时钟", async (context) => {
  const { db, execution, stats } = await setup(context);
  db.beforeWrite = async () => { db.beforeWrite = null; throw new Error("D1 unavailable"); };
  await assert.rejects(execution.updateProgress("job-1", { successCount: 1, bytesTransferred: 100 }), /D1 unavailable/);
  await execution.updateProgress("job-1", { bytesTransferred: 200 });
  assert.equal(stats().successCount, 1);
  assert.equal(stats().bytesTransferred, 200);
  assert.equal(db.writes.length, 1);
});

test("10 秒进度心跳不被阶段 1 僵尸收尾误杀，停止上报后仍可收敛", async (context) => {
  const { db, raw, execution, advance, row } = await setup(context);
  raw.prepare(`UPDATE tasks SET status = 'running', payload = '{"repositoryId":"repo-1"}'`).run();
  const repository = new CodeRepositoryRepository(db);
  const staleMs = ZOMBIE_RUNNING_BACKUP_SEC * 1000;
  await execution.updateProgress("job-1", INITIAL_STATS);
  advance(staleMs);
  await execution.updateProgress("job-1", { bytesTransferred: 123 });
  advance(9999);
  const reap = () => repository.finalizeStaleRepoJobs("repo-1", ["repo_backup"], Date.now() - staleMs, "stale");
  assert.equal(await reap(), 0);
  assert.equal(row().status, "running");
  advance(staleMs);
  assert.equal(await reap(), 1);
  assert.equal(row().status, "failed");
});

for (const splitSteps of [false, true]) {
  for (const outcome of ["completed", "failed", "cancelled", "partial"]) {
    test(`${splitSteps ? "拆分步骤" : "单步骤"}任务 ${outcome}：开始与最终状态及时持久化，收尾刷新最后不足 10 秒的进度`, async (context) => {
      const { db, raw, workflow, advance, stats, row } = await setup(context);
      const handler = {
        usesExecutionSteps: splitSteps,
        async execute(job, execution) {
          assert.equal(row().status, "running");
          const body = async () => {
            await execution.updateProgress(job.jobId, INITIAL_STATS);
            advance(1000);
            await execution.updateProgress(job.jobId, { processedItems: 1, bytesTransferred: 355 });
            assert.equal(stats().bytesTransferred, undefined);
            if (outcome === "cancelled") raw.prepare("UPDATE tasks SET status = 'cancelled' WHERE task_id = 'job-1'").run();
            if (outcome === "partial") await execution.updateProgress(job.jobId, { successCount: 1, failedCount: 1 });
            if (outcome === "failed") throw new Error("transfer failed");
          };
          if (splitSteps) await execution.runStep("transfer", undefined, body);
          else await body();
        },
      };
      context.mock.method(taskRegistry, "getHandler", () => handler);
      const steps = [];
      const step = {
        async do(name, ...args) {
          steps.push(name);
          const result = await args.at(-1)();
          if (name === "transfer" || name === "execute-task") assert.equal(stats().bytesTransferred, 355);
          return result;
        },
      };
      const result = await workflow.run({ payload: { jobId: "job-1", taskType: "repo_backup", payload: {}, userId: "admin", userType: "admin" } }, step);
      assert.equal(row().status, outcome);
      assert.equal(stats().bytesTransferred, 355);
      assert.equal(result.processedItems, 1);
      assert.ok(steps.includes("finalize-task-record"));
      if (outcome !== "cancelled") assert.equal(row().finished_at, Date.now());
      if (outcome === "failed") assert.match(row().error_message, /transfer failed/);
      assert.ok(db.writes.length >= 3);
    });
  }
}

test("步骤恢复：缓存命中不重复执行，重建上下文仍能保存缓存结果与最终进度", async (context) => {
  const { workflow, stats } = await setup(context);
  const cache = new Map();
  let executions = 0;
  const step = {
    async do(name, ...args) {
      if (!cache.has(name)) cache.set(name, await args.at(-1)());
      return structuredClone(cache.get(name));
    },
  };
  for (let replay = 0; replay < 2; replay++) {
    const execution = workflow.createExecutionContext("job-1", { step, invocation: String(replay) });
    const result = await execution.runStep("transfer", undefined, async () => {
      executions++;
      await execution.updateProgress("job-1", INITIAL_STATS);
      await execution.updateProgress("job-1", { bytesTransferred: 123 });
      return { successCount: 1, processedItems: 1, bytesTransferred: 123 };
    });
    assert.equal(stats().bytesTransferred, 123);
    await execution.updateProgress("job-1", result);
    await execution.flushProgress();
  }
  assert.equal(executions, 1);
  assert.equal(stats().successCount, 1);
  assert.equal(stats().processedItems, 1);
});
