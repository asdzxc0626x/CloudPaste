/**
 * 修复验收测试（二）：限流延迟重试的 next_run_after 不被正常调度覆盖
 * （修改点：本次审计修复 4 的针对性验证）
 *
 * 运行：node --test src/scheduled/nextRunAfterProtection.test.js
 *
 * 背景：
 *   仓库备份撞上限流时，handler 会把该仓库的计划前移到「额度恢复时间」。
 *   但 runDueScheduledJobs 在 tick 结束时也会写一次 next_run_after（正常周期）。
 *   两者顺序正常时没问题；若编排任务极快就撞限流（额度预检不发请求，几毫秒返回），
 *   前移会被随后的正常周期覆盖 —— 这一轮的延迟重试就丢了，白等一个完整周期。
 *
 * 本文件验证：updateTaskSchedule 只前移、不覆盖已经前移到未来的计划。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { computeNextSchedule, updateTaskSchedule, resolveNextRunOverride } from "./runDueScheduledJobs.js";
import { deferRepositoryBackupSchedule } from "../repobackup/schedule.js";

/** 真实内存库，包成 D1 形状 */
function createTestDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    CREATE TABLE scheduled_jobs (
      task_id TEXT PRIMARY KEY,
      schedule_type TEXT,
      interval_sec INTEGER,
      cron_expression TEXT,
      next_run_after TEXT,
      enabled INTEGER DEFAULT 1,
      run_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      lock_until TEXT,
      last_run_status TEXT,
      last_run_started_at TEXT,
      last_run_finished_at TEXT
    )
  `);
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

const REPO_ID = "repo-123";
/**
 * 计划行的 task_id 必须与 buildScheduleTaskId 的实现一致，
 * 否则 deferRepositoryBackupSchedule 会找不到行（它按这个 id 定位）。
 */
const TASK_ID = `repo_backup_${REPO_ID}`;

/**
 * 造一个备份计划行
 *
 * 注意 deferRepositoryBackupSchedule 的语义是「只前移不后移」，它能写入的前提是
 * **重试时间早于当前的 next_run_after**。这决定了本文件里两种场景的种子必须不同：
 *
 * - 到期轮次（正常周期推进）：计划已逾期，种子取过去时间
 * - 手动提前触发（竞态保护）：计划还没到期（未来），任务提前跑完撞了限流，
 *   重试时间落在「现在」和「原计划」之间 —— 这才是前移真正会发生的场景。
 *   若把计划种在过去，重试时间必然晚于它，前移会被守护合法拒绝，于是什么也测不到。
 */
function seedJob(db, { nextRunAfter, enabled = 1 } = {}) {
  const dueAt = nextRunAfter ?? new Date(Date.now() - 60 * 60 * 1000).toISOString();
  db._raw
    .prepare(
      `INSERT INTO scheduled_jobs (task_id, schedule_type, interval_sec, next_run_after, enabled)
       VALUES (?, 'interval', 21600, ?, ?)`,
    )
    .run(TASK_ID, dueAt, enabled);
  return {
    task_id: TASK_ID,
    schedule_type: "interval",
    interval_sec: 21600,
    next_run_after: dueAt,
    enabled,
    run_count: 0,
    failure_count: 0,
  };
}

const readNextRun = (db) => db._raw.prepare("SELECT next_run_after FROM scheduled_jobs WHERE task_id = ?").get(TASK_ID).next_run_after;

const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();

// ==================== 正常语义：周期照常推进 ====================

test("正常情况：没有外部前移时，next_run_after 按周期正常推进", async () => {
  const db = createTestDb();
  const startedAt = iso(-1000);
  const row = seedJob(db);

  const nowIso = new Date().toISOString();
  await updateTaskSchedule(db, row, { status: "success", nowIso, startedAt, finishedAt: nowIso });

  const after = new Date(readNextRun(db)).getTime();
  // 应当被推到约 6 小时后（interval_sec = 21600）
  const expected = Date.now() + 21600 * 1000;
  assert.ok(Math.abs(after - expected) < 5000, `应推进一个完整周期，实际 ${readNextRun(db)}`);
});

// ==================== 核心：竞态保护 ====================

test("竞态保护：执行期间已被前移的计划不会被正常周期覆盖（延迟重试不丢失）", async () => {
  const db = createTestDb();
  const startedAt = iso(-500);
  // 手动提前触发的场景：任务还没到期就被跑了一次
  const row = seedJob(db, { nextRunAfter: iso(30 * 60 * 1000) });

  // 模拟第 3 步：任务撞限流，把计划前移到 10 分钟后（早于原定的 30 分钟后）
  const moved = await deferRepositoryBackupSchedule(db, REPO_ID, iso(10 * 60 * 1000));
  assert.equal(moved, true, "前移应当成功（重试时间早于原计划）");
  const deferredTo = readNextRun(db);
  assert.ok(new Date(deferredTo).getTime() < Date.now() + 15 * 60 * 1000, "前移后应在约 10 分钟后");

  // 模拟第 2 步迟到：tick 收尾写入正常周期（6 小时后）
  const nowIso = new Date().toISOString();
  await updateTaskSchedule(db, row, { status: "success", nowIso, startedAt, finishedAt: nowIso });

  // 关键断言：前移的时间必须被保住，不能被 6 小时的正常周期覆盖
  assert.equal(readNextRun(db), deferredTo, "已被前移的 next_run_after 不得被正常调度覆盖");
});

test("竞态保护：前移时间早于正常周期时，保留更早的前移时间", async () => {
  const db = createTestDb();
  const row = seedJob(db, { nextRunAfter: iso(30 * 60 * 1000) });

  // handler 给出的重试时间在 2 小时后（比如额度恢复较晚），但仍早于原计划的 30 分钟？
  // 不成立 —— 这里改用「原计划在 4 小时后」的种子，让 2 小时确实是前移
  const db2 = createTestDb();
  const row2 = seedJob(db2, { nextRunAfter: iso(4 * 60 * 60 * 1000) });
  await deferRepositoryBackupSchedule(db2, REPO_ID, iso(2 * 60 * 60 * 1000));
  const deferredTo = readNextRun(db2);
  assert.ok(deferredTo, "前移应写入");
  assert.ok(new Date(deferredTo).getTime() < Date.now() + 3 * 60 * 60 * 1000, "前移后应在约 2 小时后");

  // 此时正常周期是 6 小时后，比 2 小时更晚 —— 应当保留更早的 2 小时
  const nowIso = new Date().toISOString();
  await updateTaskSchedule(db2, row2, { status: "success", nowIso, startedAt: nowIso, finishedAt: nowIso });
  assert.equal(readNextRun(db2), deferredTo, "应保留更早的前移时间，而不是被推到 6 小时后");
  void db; void row; // 保留未使用变量说明：本用例的两个库是分开的
});

test("边界：一次性任务结束时 next_run_after 仍应被正常清空", async () => {
  const db = createTestDb();
  // schedule_type = once / interval_sec = 0 -> computeNextSchedule 返回 nextRunAfter=null
  db._raw
    .prepare(
      `INSERT INTO scheduled_jobs (task_id, schedule_type, interval_sec, next_run_after, enabled)
       VALUES (?, 'interval', 0, ?, 1)`,
    )
    .run(TASK_ID, iso(-60_000));
  const row = {
    task_id: TASK_ID,
    schedule_type: "interval",
    interval_sec: 0,
    next_run_after: iso(-60_000),
    enabled: 1,
    run_count: 0,
    failure_count: 0,
  };

  const nowIso = new Date().toISOString();
  await updateTaskSchedule(db, row, { status: "success", nowIso });

  assert.equal(readNextRun(db), null, "配置异常被禁用时应清空 next_run_after");
  assert.equal(db._raw.prepare("SELECT enabled FROM scheduled_jobs WHERE task_id=?").get(TASK_ID).enabled, 0);
});

test("边界：执行期间的前移只会前移，不会被 deferRepositoryBackupSchedule 反向推迟", async () => {
  const db = createTestDb();
  // 计划本来就在 1 小时后
  seedJob(db, { nextRunAfter: iso(60 * 60 * 1000) });

  // 尝试「前移」到一个比现有计划更晚的时间（3 小时后）—— 应当被拒绝
  const moved = await deferRepositoryBackupSchedule(db, REPO_ID, iso(3 * 60 * 60 * 1000));
  assert.equal(moved, false, "只前移不后移：比现有计划更晚的时间不应生效");
});

// ==================== 既有语义：handler 的 nextRunAfter / deferMs 仍生效 ====================

test("既有语义：handler 的 nextRunAfter / deferMs 覆盖仍然有效", () => {
  const nowMs = Date.now();

  const byIso = resolveNextRunOverride({ nextRunAfter: new Date(nowMs + 10 * 60 * 1000).toISOString() });
  assert.ok(byIso && new Date(byIso).getTime() > nowMs, "nextRunAfter 应生效");

  const byDefer = resolveNextRunOverride({ deferMs: 5 * 60 * 1000 });
  assert.ok(byDefer && new Date(byDefer).getTime() > nowMs, "deferMs 应生效");

  // 过短 / 非法的延迟应被兜到下限，避免每个 tick 空转
  const tooShort = resolveNextRunOverride({ deferMs: 10 });
  assert.ok(new Date(tooShort).getTime() > nowMs + 25 * 1000, "过短的延迟应被兜到 30 秒下限");

  assert.equal(resolveNextRunOverride({}), null, "没有覆盖信息时返回 null");
  assert.equal(resolveNextRunOverride(null), null);
});

test("既有语义：interval 类型的周期计算未被改动", () => {
  const row = { task_id: "t", schedule_type: "interval", interval_sec: 3600, enabled: 1, run_count: 0 };
  const nowIso = new Date().toISOString();
  const out = computeNextSchedule(row, { status: "success", nowIso });

  const delta = new Date(out.nextRunAfter).getTime() - Date.now();
  assert.ok(Math.abs(delta - 3600 * 1000) < 5000, "interval 周期应保持 1 小时");
  assert.equal(out.runCountDelta, 1);
  assert.equal(out.failureCountDelta, 0);
});
