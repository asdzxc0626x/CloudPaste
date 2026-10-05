/**
 * 第 5 期验收测试：错峰调度
 *
 * 运行：node --test src/repobackup/scheduleStaggering.test.js
 *
 * 覆盖三件事（对应第 5 期「一、错峰调度」）：
 *   1. 首次执行时间分散：interval 模式下计划不再全部落在同一个时刻
 *   2. v39 迁移：把已经对齐的存量计划重新分散，且不碰 cron 行与其他调度作业
 *   3. 每 tick 派发上限：大量仓库同时到期时只派发前 N 个，
 *      其余保持到期留给下一轮，且按 next_run_after 升序 —— 只延后，不饿死
 *
 * 全部用真实 SQL（node:sqlite 内存库 + 真实 DDL），不触网。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  REPO_BACKUP_SCHEDULE_JITTER_RATIO,
  REPO_BACKUP_MAX_DISPATCH_PER_TICK,
  planFirstRunAtIso,
  resolveFirstRunFactor,
} from "./staggering.js";
import { createScheduledJob, updateScheduledJob } from "../services/scheduledJobService.js";
import { redistributeRepoBackupScheduleJitter } from "../db/migrations/sqlite/engine/migrations.js";
import { runDueScheduledJobs } from "../scheduled/runDueScheduledJobs.js";
import { scheduledTaskRegistry } from "../scheduled/ScheduledTaskRegistry.js";
import { createScheduledJobsTables, createScheduledJobRunsTables } from "../db/migrations/sqlite/engine/schema.js";

/** 真实内存库，包成 D1 形状（与仓库内其他测试同一套写法） */
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

const INTERVAL_SEC = 6 * 60 * 60;

/** 建调度相关的全部真实表：scheduled_jobs + scheduled_job_runs（执行日志） */
async function setupSchema(db) {
  await createScheduledJobsTables(db);
  await createScheduledJobRunsTables(db);
}

// ==================== 1. 分散算法本身 ====================

test("错峰：planFirstRunAtIso 落在 [50%,100%] × 间隔 内", () => {
  const nowMs = Date.parse("2026-10-05T00:00:00.000Z");
  const minMs = nowMs + INTERVAL_SEC * 1000 * 0.5;
  const maxMs = nowMs + INTERVAL_SEC * 1000;

  // random 边界：0 取下限，1 取上限（闭区间）
  assert.equal(planFirstRunAtIso(INTERVAL_SEC, { nowMs, random: () => 0 }), new Date(minMs).toISOString());
  assert.equal(planFirstRunAtIso(INTERVAL_SEC, { nowMs, random: () => 1 }), new Date(maxMs).toISOString());

  // 中间值不越界
  for (const r of [0.1, 0.25, 0.5, 0.75, 0.99]) {
    const at = Date.parse(planFirstRunAtIso(INTERVAL_SEC, { nowMs, random: () => r }));
    assert.ok(at >= minMs && at <= maxMs, `random=${r} 时越界: ${new Date(at).toISOString()}`);
  }

  // 非法间隔不产生时间（调用方据此跳过）
  assert.equal(planFirstRunAtIso(0, { nowMs }), null);
  assert.equal(planFirstRunAtIso(null, { nowMs }), null);
  assert.equal(planFirstRunAtIso("abc", { nowMs }), null);
});

test("错峰：resolveFirstRunFactor 默认（不传/为 0）恒为 1，不影响其他调度作业", () => {
  assert.equal(resolveFirstRunFactor(undefined), 1);
  assert.equal(resolveFirstRunFactor(null), 1);
  assert.equal(resolveFirstRunFactor(0), 1);
  assert.equal(resolveFirstRunFactor(-1), 1);

  // 传了比例时落在 [1-ratio, 1]
  assert.equal(resolveFirstRunFactor(0.5, () => 0), 0.5);
  assert.equal(resolveFirstRunFactor(0.5, () => 1), 1);
  assert.equal(resolveFirstRunFactor(0.5, () => 0.5), 0.75);
});

test("错峰：仓库备份计划的抖动比例是 [50%,100%]，派发上限为正整数", () => {
  assert.equal(REPO_BACKUP_SCHEDULE_JITTER_RATIO, 0.5);
  assert.ok(Number.isInteger(REPO_BACKUP_MAX_DISPATCH_PER_TICK));
  assert.ok(REPO_BACKUP_MAX_DISPATCH_PER_TICK > 0);
});

// ==================== 2. 创建 / 更新计划时的分散 ====================

test("错峰：createScheduledJob 传 firstRunJitterRatio 时首次执行时间被分散", async () => {
  const db = createTestDb();
  await setupSchema(db);

  await createScheduledJob(db, {
    taskId: "jittered",
    handlerId: "repo_backup_schedule",
    scheduleType: "interval",
    intervalSec: INTERVAL_SEC,
    firstRunJitterRatio: 0.5,
  });
  const jittered = await db.prepare(`SELECT next_run_after FROM scheduled_jobs WHERE task_id = ?`).bind("jittered").first();

  const deltaMs = Date.parse(jittered.next_run_after) - Date.now();
  assert.ok(
    deltaMs >= INTERVAL_SEC * 1000 * 0.5 - 5000 && deltaMs <= INTERVAL_SEC * 1000 + 5000,
    `首次执行时间应落在 [50%,100%] × 间隔 内，实际 ${deltaMs}ms`,
  );
});

test("错峰：不传 firstRunJitterRatio 时保持原行为（now + 间隔）", async () => {
  const db = createTestDb();
  await setupSchema(db);

  await createScheduledJob(db, {
    taskId: "plain",
    handlerId: "refresh_storage_usage_snapshots",
    scheduleType: "interval",
    intervalSec: INTERVAL_SEC,
  });
  const plain = await db.prepare(`SELECT next_run_after FROM scheduled_jobs WHERE task_id = ?`).bind("plain").first();

  const deltaMs = Date.parse(plain.next_run_after) - Date.now();
  // 系数恒为 1：与改动前完全一致
  assert.ok(
    Math.abs(deltaMs - INTERVAL_SEC * 1000) < 5000,
    `未传抖动时必须是 now + 间隔，实际 ${deltaMs}ms`,
  );
});

test("错峰：cron 模式不受抖动影响（用户指定了具体时刻）", async () => {
  const db = createTestDb();
  await setupSchema(db);

  await createScheduledJob(db, {
    taskId: "cron_job",
    handlerId: "repo_backup_schedule",
    scheduleType: "cron",
    cronExpression: "30 3 * * *",
    firstRunJitterRatio: 0.5,
  });
  const row = await db.prepare(`SELECT next_run_after FROM scheduled_jobs WHERE task_id = ?`).bind("cron_job").first();

  const at = new Date(row.next_run_after);
  assert.equal(at.getMinutes(), 30, "cron 的小时:分钟必须完全按表达式，不被抖动改动");
  assert.equal(at.getHours(), 3);
});

test("错峰：updateScheduledJob 重置计划时同样分散", async () => {
  const db = createTestDb();
  await setupSchema(db);

  await createScheduledJob(db, {
    taskId: "reset_me",
    handlerId: "repo_backup_schedule",
    scheduleType: "interval",
    intervalSec: INTERVAL_SEC,
  });

  // 改间隔会触发 next_run_after 重置
  await updateScheduledJob(db, "reset_me", { intervalSec: 2 * 60 * 60, firstRunJitterRatio: 0.5 });
  const row = await db.prepare(`SELECT next_run_after FROM scheduled_jobs WHERE task_id = ?`).bind("reset_me").first();

  const deltaMs = Date.parse(row.next_run_after) - Date.now();
  assert.ok(
    deltaMs >= 2 * 60 * 60 * 1000 * 0.5 - 5000 && deltaMs <= 2 * 60 * 60 * 1000 + 5000,
    `重置后的执行时间应落在 [50%,100%] × 新间隔 内，实际 ${deltaMs}ms`,
  );
});

// ==================== 3. v39 迁移：重新分散存量计划 ====================

test("错峰迁移 v39：已对齐的存量计划被重新分散，cron 与其他调度作业不动", async () => {
  const db = createTestDb();
  await setupSchema(db);

  // 模拟 v37 的回填结果：所有仓库计划的 next_run_after 完全相同（迁移的由来）
  const alignedAt = new Date(Date.now() + INTERVAL_SEC * 1000).toISOString();
  const insert = db._raw.prepare(
    `INSERT INTO scheduled_jobs (task_id, handler_id, name, schedule_type, interval_sec, cron_expression, enabled, next_run_after, config_json)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, '{}')`,
  );

  for (let i = 0; i < 12; i += 1) {
    insert.run(`repo_backup_repo-${i}`, "repo_backup_schedule", `仓库${i}`, "interval", INTERVAL_SEC, null, alignedAt);
  }
  // 不该被触碰的三类行
  insert.run("repo_backup_cron", "repo_backup_schedule", "cron 仓库", "cron", null, "30 3 * * *", alignedAt);
  insert.run("repo_backup_disabled", "repo_backup_schedule", "已关闭", "interval", INTERVAL_SEC, null, alignedAt);
  insert.run("refresh_storage_usage_snapshots", "refresh_storage_usage_snapshots", "用量快照", "interval", INTERVAL_SEC, null, alignedAt);
  // 已关闭的那一行要单独置 enabled=0
  db._raw.prepare(`UPDATE scheduled_jobs SET enabled = 0 WHERE task_id = ?`).run("repo_backup_disabled");

  const result = await redistributeRepoBackupScheduleJitter(db);
  assert.equal(result.updated, 12, "只应重排 12 个启用中的 interval 仓库计划");

  const rows = db._raw.prepare(`SELECT task_id, next_run_after FROM scheduled_jobs`).all();
  const byId = new Map(rows.map((r) => [r.task_id, r.next_run_after]));

  // 12 个仓库不再全部落在同一时刻
  const repoRows = rows.filter((r) => r.task_id.startsWith("repo_backup_repo-"));
  assert.equal(new Set(repoRows.map((r) => r.next_run_after)).size > 1, true, "重新分散后不应仍然完全相同");

  // 每个都落在 [50%,100%] × 间隔 内
  for (const row of repoRows) {
    const deltaMs = Date.parse(row.next_run_after) - Date.now();
    assert.ok(
      deltaMs >= INTERVAL_SEC * 1000 * 0.5 - 5000 && deltaMs <= INTERVAL_SEC * 1000 + 5000,
      `${row.task_id} 的分散结果越界: ${row.next_run_after}`,
    );
  }

  // cron / 已关闭 / 其他 handler 一律保持原值
  assert.equal(byId.get("repo_backup_cron"), alignedAt, "cron 行是用户指定时刻，不应被抖动");
  assert.equal(byId.get("repo_backup_disabled"), alignedAt, "已关闭的计划不需要重排");
  assert.equal(byId.get("refresh_storage_usage_snapshots"), alignedAt, "其他调度作业不受影响");
});

test("错峰迁移 v39：可重入，重跑不会报错也不会丢配置", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await createScheduledJob(db, {
    taskId: "repo_backup_a",
    handlerId: "repo_backup_schedule",
    scheduleType: "interval",
    intervalSec: INTERVAL_SEC,
  });

  await redistributeRepoBackupScheduleJitter(db);
  await redistributeRepoBackupScheduleJitter(db);

  const row = await db.prepare(`SELECT interval_sec, enabled, handler_id FROM scheduled_jobs WHERE task_id = ?`).bind("repo_backup_a").first();
  assert.equal(row.interval_sec, INTERVAL_SEC, "重排不得改动间隔配置");
  assert.equal(row.enabled, 1);
  assert.equal(row.handler_id, "repo_backup_schedule");
});

// ==================== 4. 每 tick 派发上限 ====================

/** 注册一个临时 handler，返回卸载函数 */
function registerTestHandler(id, { maxDispatchPerTick, run }) {
  const handler = {
    id,
    name: `测试 handler ${id}`,
    description: "测试用",
    category: "business",
    configSchema: [],
    run,
  };
  if (maxDispatchPerTick !== undefined) handler.maxDispatchPerTick = maxDispatchPerTick;
  scheduledTaskRegistry.register(handler);
  return () => scheduledTaskRegistry.handlers.delete(id);
}

test("错峰：单轮派发上限 —— 大量仓库同时到期时只派发前 N 个，其余留到下一轮", async () => {
  const db = createTestDb();
  await setupSchema(db);

  const executed = [];
  const unregister = registerTestHandler("test_capped_schedule", {
    maxDispatchPerTick: 3,
    run: async (ctx) => {
      executed.push(ctx.scheduledJobId);
      return { summary: "ok" };
    },
  });

  try {
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const insert = db._raw.prepare(
      `INSERT INTO scheduled_jobs (task_id, handler_id, name, schedule_type, interval_sec, enabled, next_run_after, config_json)
       VALUES (?, 'test_capped_schedule', ?, 'interval', 21600, 1, ?, '{}')`,
    );
    // 故意打乱插入顺序：验证选取依据是 next_run_after 而不是插入顺序
    const dueTimes = [
      ["job-d", "2026-10-05T00:04:00.000Z"],
      ["job-a", "2026-10-05T00:01:00.000Z"],
      ["job-f", "2026-10-05T00:06:00.000Z"],
      ["job-b", "2026-10-05T00:02:00.000Z"],
      ["job-e", "2026-10-05T00:05:00.000Z"],
      ["job-c", "2026-10-05T00:03:00.000Z"],
    ];
    for (const [taskId, at] of dueTimes) insert.run(taskId, taskId, at);
    void dueAt;

    const stats = await runDueScheduledJobs(db, {}, {});
    assert.equal(stats.dueCount, 6);
    assert.equal(stats.executedCount, 3, "本轮只应派发 3 个");
    assert.equal(stats.throttledCount, 3, "其余 3 个应记为「留给下一轮」而不是跳过或失败");
    assert.deepEqual(executed, ["job-a", "job-b", "job-c"], "必须按 next_run_after 升序，等得最久的先派发");

    // 未派发的行保持到期（next_run_after 未被推进），下一轮仍会被选中
    const pending = db._raw
      .prepare(`SELECT task_id FROM scheduled_jobs WHERE next_run_after <= ? ORDER BY next_run_after ASC`)
      .all(new Date().toISOString())
      .map((r) => r.task_id);
    assert.deepEqual(pending, ["job-d", "job-e", "job-f"], "被限流的行必须保持到期状态");

    // 下一轮继续派发，且仍是「等得最久的优先」—— 多轮之后全部执行，不饿死
    executed.length = 0;
    const second = await runDueScheduledJobs(db, {}, {});
    assert.deepEqual(executed, ["job-d", "job-e", "job-f"]);
    assert.equal(second.throttledCount, 0);

    const stillDue = db._raw.prepare(`SELECT COUNT(*) AS c FROM scheduled_jobs WHERE next_run_after <= ?`).get(new Date().toISOString());
    assert.equal(Number(stillDue.c), 0, "所有到期作业最终都被执行");
  } finally {
    unregister();
  }
});

test("错峰：未声明上限的 handler 不受配额影响", async () => {
  const db = createTestDb();
  await setupSchema(db);

  let count = 0;
  const unregister = registerTestHandler("test_uncapped_schedule", {
    run: async () => {
      count += 1;
      return { summary: "ok" };
    },
  });

  try {
    const insert = db._raw.prepare(
      `INSERT INTO scheduled_jobs (task_id, handler_id, name, schedule_type, interval_sec, enabled, next_run_after, config_json)
       VALUES (?, 'test_uncapped_schedule', ?, 'interval', 21600, 1, '2026-10-05T00:00:00.000Z', '{}')`,
    );
    for (let i = 0; i < 8; i += 1) insert.run(`uncapped-${i}`, `uncapped-${i}`);

    const stats = await runDueScheduledJobs(db, {}, {});
    assert.equal(count, 8, "没有声明 maxDispatchPerTick 的 handler 行为与改动前一致");
    assert.equal(stats.throttledCount, 0);
  } finally {
    unregister();
  }
});
