/**
 * 回归验证：仓库列表的分页 / 搜索 / 批量删除（修改点：仓库管理分页与搜索、批量删除）
 *
 * 运行：node --test src/repobackup/repositoryPaging.test.js（整仓用 `npm test`）
 *
 * 这一组盯的是分页这件事「做错了也看不出来」的几个点：
 *  1. total 必须跟着筛选条件走 —— 搜索时如果仍返回全库条数，
 *     分页器会算出根本翻不到的页，用户看到的是一片空白；
 *  2. 翻页必须不重不漏 —— 只按 created_at 排序时，同一秒内创建的几条记录
 *     在不同页之间顺序未定义，这个 bug 在「一次返回全部」的旧实现里不可能出现；
 *  3. 搜索范围必须只覆盖列表上看得见的字段 —— config_json 里有加密后的 Token，
 *     一旦进了 LIKE，搜索框就变成了凭据探测器；
 *  4. 批量删除必须逐条独立 —— 列表页里某条已被别人删掉是常态，
 *     整批失败会让用户反复点、每次都失败。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DatabaseSync } from "node:sqlite";
import {
  createCodeRepositoryTables,
  createRepoDetectStatesTable,
  createStorageTables,
  createTasksTables,
  createScheduledJobsTables,
  createScheduledJobRunsTables,
} from "../db/migrations/sqlite/engine/schema.js";
import { listRepositories, batchDeleteRepositories } from "../services/codeRepositoryService.js";
import { CodeRepositoryRepository } from "../repositories/CodeRepositoryRepository.js";
import { ValidationError } from "../http/errors.js";

const ENV = { ENCRYPTION_SECRET: "test-secret-test-secret-test-secret" };

/** 真实内存库，包成 D1 形状（与同目录其它用例一致） */
function createTestDb() {
  const raw = new DatabaseSync(":memory:");
  const normalize = (row) => (row ? { ...row } : null);
  const reads = [];
  return {
    _raw: raw,
    _reads: reads,
    prepare(sql) {
      const stmt = raw.prepare(String(sql));
      const args = [];
      const api = {
        bind(...values) {
          args.push(...values);
          return api;
        },
        async first() {
          reads.push({ sql, params: [...args] });
          return normalize(stmt.get(...args) ?? null);
        },
        async all() {
          reads.push({ sql, params: [...args] });
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

/**
 * 造一条仓库记录
 * @param {object} db
 * @param {{id: string, name?: string, repoIdentifier?: string, createdAt?: string, configJson?: string}} spec
 */
async function seedRepo(db, spec) {
  const createdAt = spec.createdAt || new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO code_repositories
        (id, provider, name, repo_identifier, track_mode, track_ref, track_refs_json,
         target_mount_id, target_mount_ids_json, target_path_prefix, retention_count,
         enabled, config_json, created_at, updated_at)
       VALUES (?, 'github', ?, ?, 'branch', 'main', '["main"]',
               'mount-1', '["mount-1"]', '/', 10, 1, ?, ?, ?)`,
    )
    .bind(
      spec.id,
      spec.name ?? `仓库-${spec.id}`,
      spec.repoIdentifier ?? `octocat/${spec.id}`,
      spec.configJson ?? "{}",
      createdAt,
      createdAt,
    )
    .run();
}

/** 批量造 n 条，created_at 全部相同 —— 专门用来验证翻页的稳定性 */
async function seedMany(db, n, createdAt = "2026-01-01T00:00:00.000Z") {
  for (let i = 1; i <= n; i += 1) {
    await seedRepo(db, { id: `repo-${String(i).padStart(2, "0")}`, createdAt });
  }
}

const list = (db, options) => listRepositories(db, null, ENV.ENCRYPTION_SECRET, ENV, options);

// 修改点（列表刷新提速）：约束真实 SQL 次数，防止重新引入逐仓库查询。
async function seedBackup(db, repositoryId, id, createdAt, status = "success") {
  await db.prepare(`INSERT INTO code_repository_backups
    (id, repository_id, commit_sha, status, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, repositoryId, id, status, createdAt).run();
  await db.prepare(`INSERT INTO code_repository_backup_targets
    (id, backup_id, mount_id, status) VALUES (?, ?, 'mount-1', ?)`)
    .bind(`target-${id}`, id, status).run();
}

test("20 个有备份的仓库最多 8 次查询，不随每行增加往返", async (t) => {
  const db = createTestDb();
  t.after(() => db._raw.close());
  await setupSchema(db);
  await seedMany(db, 20);
  for (let i = 1; i <= 20; i++) {
    const id = `repo-${String(i).padStart(2, "0")}`;
    await seedBackup(db, id, `backup-${id}`, "2026-01-01T00:00:00Z");
  }

  db._reads.length = 0;
  const result = await list(db, { limit: 20 });
  assert.equal(result.items.length, 20);
  for (const item of result.items) {
    assert.equal(item.latestBackup.id, `backup-${item.id}`);
    assert.equal(item.latestBackup.targets[0].id, `target-backup-${item.id}`);
  }
  assert.ok(db._reads.length <= 8, `列表执行了 ${db._reads.length} 次查询，应批量读取备份和目标`);
});

test("批量最近备份不串仓库、不漏无备份行，同时间记录与详情选择一致", async (t) => {
  const db = createTestDb();
  t.after(() => db._raw.close());
  await setupSchema(db);
  await seedMany(db, 4);
  await seedBackup(db, "repo-01", "old", "2026-01-01T00:00:00Z");
  await seedBackup(db, "repo-01", "new", "2026-02-01T00:00:00Z", "failed");
  await seedBackup(db, "repo-02", "tie-a", "2026-02-01T00:00:00Z");
  await seedBackup(db, "repo-02", "tie-z", "2026-02-01T00:00:00Z", "partial");
  await seedBackup(db, "repo-04", "off-page", "2026-03-01T00:00:00Z");

  const result = await list(db, { limit: 3, offset: 1 });
  assert.deepEqual(result.items.map((item) => item.id), ["repo-03", "repo-02", "repo-01"]);
  assert.equal(result.items[0].latestBackup, null);
  assert.equal(result.items[1].latestBackup.id, "tie-z");
  assert.equal(result.items[1].latestBackup.targets[0].id, "target-tie-z");
  assert.equal(result.items[2].latestBackup.id, "new");
  assert.equal(result.items[2].latestBackup.status, "failed");
  assert.equal((await new CodeRepositoryRepository(db).findLatestBackup("repo-02")).id, "tie-z");
});

test("大页和内部全量列表不超 D1 单条 SQL 的 100 个绑定参数", async (t) => {
  const db = createTestDb();
  t.after(() => db._raw.close());
  await setupSchema(db);
  await seedMany(db, 120);
  for (let i = 1; i <= 120; i++) {
    const id = `repo-${String(i).padStart(2, "0")}`;
    await seedBackup(db, id, `backup-${id}`, "2026-01-01T00:00:00Z");
  }
  for (const options of [{ limit: 100 }, { limit: 200 }, {}]) {
    db._reads.length = 0;
    const result = await list(db, options);
    assert.equal(result.items.length, options.limit === 100 ? 100 : 120);
    assert.ok(result.items.every((item) => item.latestBackup?.targets.length === 1));
    assert.ok(db._reads.every(({ params }) => params.length <= 100), "批量查询不能为每个仓库各占一个绑定参数");
  }
});

// ==================== 分页 ====================

test("不传 limit 时返回全部（内部全量调用方不受分页影响）", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMany(db, 5);

  const result = await list(db);
  assert.equal(result.items.length, 5);
  assert.equal(result.total, 5);
  assert.equal(result.limit, 0, "limit=0 表示没有分页");
  assert.equal(result.offset, 0);
});

test("limit/offset 切页：每页条数与总数各算各的", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMany(db, 5);

  const page1 = await list(db, { limit: 2, offset: 0 });
  assert.equal(page1.items.length, 2);
  assert.equal(page1.total, 5, "total 是总条数，不是本页条数");

  const last = await list(db, { limit: 2, offset: 4 });
  assert.equal(last.items.length, 1, "最后一页只剩 1 条");
  assert.equal(last.total, 5);
});

test("offset 越界时返回空页但 total 照旧（前端据此把页码退回去）", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMany(db, 3);

  const result = await list(db, { limit: 20, offset: 100 });
  assert.equal(result.items.length, 0);
  assert.equal(result.total, 3, "total 必须仍然是真实总数，否则分页器会以为一条都没有");
});

test("翻页不重不漏：created_at 完全相同也必须有确定的次序", async () => {
  const db = createTestDb();
  await setupSchema(db);
  // 10 条记录共享同一个 created_at：只按时间排序时顺序未定义
  await seedMany(db, 10, "2026-02-02T02:02:02.000Z");

  const seen = [];
  for (let offset = 0; offset < 10; offset += 3) {
    const page = await list(db, { limit: 3, offset });
    seen.push(...page.items.map((item) => item.id));
  }

  assert.equal(seen.length, 10, "4 页加起来应该正好是全部记录");
  assert.equal(new Set(seen).size, 10, "不允许同一条记录出现在两页里");
});

test("非法分页参数回落为「不分页」，不会把 NaN / 负数拼进 SQL", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMany(db, 3);

  for (const bad of [0, -1, NaN, "abc", null, undefined]) {
    const result = await list(db, { limit: bad, offset: bad });
    assert.equal(result.items.length, 3, `limit=${String(bad)} 应回落为不分页`);
    assert.equal(result.offset, 0, `offset=${String(bad)} 必须归零`);
  }
});

// ==================== 搜索 ====================

test("搜索命中展示名与 owner/repo，且 total 跟着筛选条件走", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedRepo(db, { id: "r1", name: "前端仓库", repoIdentifier: "acme/frontend" });
  await seedRepo(db, { id: "r2", name: "后端仓库", repoIdentifier: "acme/backend" });
  await seedRepo(db, { id: "r3", name: "文档", repoIdentifier: "other/docs" });

  const byName = await list(db, { limit: 20, offset: 0, search: "前端" });
  assert.equal(byName.total, 1, "搜索时的 total 必须是命中条数，不是全库条数");
  assert.equal(byName.items[0].id, "r1");

  const byIdentifier = await list(db, { limit: 20, offset: 0, search: "acme/" });
  assert.equal(byIdentifier.total, 2);
  assert.deepEqual(byIdentifier.items.map((item) => item.id).sort(), ["r1", "r2"]);

  // 大小写不敏感（SQLite 的 LIKE 对 ASCII 不区分大小写）
  const upper = await list(db, { limit: 20, offset: 0, search: "ACME" });
  assert.equal(upper.total, 2);
});

test("搜索 + 分页：翻页时筛选条件不丢", async () => {
  const db = createTestDb();
  await setupSchema(db);
  for (let i = 1; i <= 5; i += 1) {
    await seedRepo(db, { id: `hit-${i}`, name: `命中${i}`, repoIdentifier: `acme/hit-${i}` });
  }
  await seedRepo(db, { id: "miss", name: "无关", repoIdentifier: "other/miss" });

  const page2 = await list(db, { limit: 2, offset: 2, search: "acme" });
  assert.equal(page2.total, 5, "6 条里只有 5 条命中");
  assert.equal(page2.items.length, 2);
  assert.ok(
    page2.items.every((item) => item.repoIdentifier.startsWith("acme/")),
    "第二页不能混进没命中的记录",
  );
});

test("搜索不碰 config_json：那里存的是加密后的 Token，不能被搜索框探测出来", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedRepo(db, {
    id: "secret",
    name: "普通仓库",
    repoIdentifier: "acme/plain",
    configJson: JSON.stringify({ token: "ghp_SEARCHABLE_MARKER" }),
  });

  const result = await list(db, { limit: 20, offset: 0, search: "SEARCHABLE_MARKER" });
  assert.equal(result.total, 0);
  assert.equal(result.items.length, 0);
});

test("空白搜索词等于没搜索（前端清空搜索框时不该变成「搜一个空串」）", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMany(db, 3);

  const result = await list(db, { limit: 20, offset: 0, search: "   " });
  assert.equal(result.total, 3);
  assert.equal(result.search, "", "两端空白要被裁掉");
});

// ==================== 批量删除 ====================

test("批量删除逐条独立：其中一条不存在不影响其余", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMany(db, 3);

  const result = await batchDeleteRepositories(db, null, ["repo-01", "repo-02", "not-exist"], ENV);
  assert.equal(result.total, 3);
  assert.equal(result.success, 2);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, "not-exist");
  assert.match(result.failed[0].error, /不存在/);

  const left = await list(db);
  assert.equal(left.total, 1, "成功的那两条必须真的删掉了");
  assert.equal(left.items[0].id, "repo-03");
});

test("重复 ID 先去重：否则同一条会被删两次，第二次报「不存在」", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedMany(db, 2);

  const result = await batchDeleteRepositories(db, null, ["repo-01", "repo-01"], ENV);
  assert.equal(result.total, 1);
  assert.equal(result.success, 1);
  assert.equal(result.failed.length, 0);
});

test("空列表直接报参数错误（不能当成「删了 0 条」的成功）", async () => {
  const db = createTestDb();
  await setupSchema(db);

  await assert.rejects(() => batchDeleteRepositories(db, null, [], ENV), ValidationError);
  await assert.rejects(() => batchDeleteRepositories(db, null, ["  ", null], ENV), ValidationError);
});

test("批量删除会连带清理备份计划（与单条删除同一条路径）", async () => {
  const db = createTestDb();
  await setupSchema(db);
  await seedRepo(db, { id: "repo-sched" });
  await db
    .prepare(
      `INSERT INTO scheduled_jobs (task_id, handler_id, name, schedule_type, interval_sec, enabled, next_run_after, config_json)
       VALUES ('repo_backup_repo-sched', 'repo_backup_schedule', '仓库备份', 'interval', 21600, 1, ?, '{"repositoryId":"repo-sched"}')`,
    )
    .bind(new Date().toISOString())
    .run();

  const before = await db.prepare(`SELECT COUNT(*) AS count FROM scheduled_jobs`).bind().first();
  assert.equal(Number(before.count), 1);

  await batchDeleteRepositories(db, null, ["repo-sched"], ENV);

  const after = await db.prepare(`SELECT COUNT(*) AS count FROM scheduled_jobs`).bind().first();
  assert.equal(Number(after.count), 0, "留下调度作业等于留下一个永远找不到仓库的定时任务");
});
