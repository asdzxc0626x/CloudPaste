/**
 * 回归测试：FS 搜索索引的路径前缀查询
 * （修改点：修复 D1 的 LIKE 模式 50 字符上限导致的挂载浏览 500）
 *
 * 用户现场：访问 /mount-explorer/b2-1/Github/github__misaka10032w__Han1meViewer/main
 * 报 `D1_ERROR: LIKE or GLOB pattern too complex`。
 *
 * 根因：D1 把 LIKE/GLOB 模式硬限制在 50 字符。该目录的 FS 路径是
 * /b2-1/Github/github__misaka10032w__Han1meViewer/main（52 字节），
 * 旧的 `fs_path LIKE '<目录>/%'` 模式 = 54 字节 → D1 直接拒绝 → 500。
 * 上一级仓库目录 49 字节刚好没过线，所以只有再往里一层打不开。
 *
 * 这套测试跑的是**真实 SQL**（node:sqlite 内存库 + D1 形状的 prepare/bind），
 * 因此同时锁住两件事：结果仍然正确，且产出的 SQL 里不再有 LIKE。
 *
 * 运行：node --test src/storage/fs/search/fsSearchIndexPathPrefix.test.js
 * （不依赖数据库、不触网）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { FsSearchIndexStore } from "./FsSearchIndexStore.js";
import { DbTables } from "../../../constants/index.js";

const MOUNT = "b2-1";
const REPO_DIR = "/b2-1/Github/github__misaka10032w__Han1meViewer";
/** 用户点进去就 500 的那个目录：52 字节 */
const DEEP = `${REPO_DIR}/main`;
const DIR_A = `${DEEP}/20261005-155036__main__8a7950d`;
const DIR_B = `${DEEP}/20261006-010203__main__8a7950d`;
/** 诱饵一：仅字符串前缀相同的兄弟目录（旧写法也匹配不到，用于确认新写法不会多删） */
const DECOY_SIBLING = `${REPO_DIR}/main-other/c.tar.gz`;
/** 诱饵二：旧写法把仓库目录名里的 __ 当通配符，会误命中这条 */
const DECOY_WILDCARD = "/b2-1/Github/githubXXmisaka10032wXXHan1meViewer/main/d.tar.gz";

/** 建只含索引条目表的真实内存库，包成 D1 形状，并记录每次执行的 SQL 与绑定值 */
function createTestDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    CREATE TABLE ${DbTables.FS_SEARCH_INDEX_ENTRIES} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mount_id TEXT NOT NULL,
      fs_path TEXT NOT NULL,
      name TEXT NOT NULL,
      is_dir BOOLEAN NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 0,
      modified_ms INTEGER NOT NULL DEFAULT 0,
      mimetype TEXT,
      index_run_id TEXT,
      updated_at_ms INTEGER NOT NULL DEFAULT 0,
      UNIQUE (mount_id, fs_path)
    )
  `);

  const calls = [];
  const insert = raw.prepare(
    `INSERT INTO ${DbTables.FS_SEARCH_INDEX_ENTRIES} (mount_id, fs_path, name, is_dir, size, modified_ms, index_run_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of [
    [`${DIR_A}/a.tar.gz`, "a.tar.gz", 0, 100, 1000, "run-1"],
    [`${DIR_A}/a.manifest.json`, "a.manifest.json", 0, 10, 2000, "run-1"],
    [`${DIR_B}/b.tar.gz`, "b.tar.gz", 0, 300, 3000, "run-1"],
    [DECOY_SIBLING, "c.tar.gz", 0, 9999, 9000, "run-1"],
    [DECOY_WILDCARD, "d.tar.gz", 0, 8888, 8000, "run-1"],
  ]) {
    insert.run(MOUNT, ...row);
  }

  return {
    calls,
    prepare(sql) {
      const text = String(sql);
      const stmt = raw.prepare(text);
      const args = [];
      const api = {
        bind(...values) {
          args.push(...values);
          return api;
        },
        async all() {
          calls.push({ sql: text, args: [...args] });
          return { results: stmt.all(...args).map((row) => ({ ...row })) };
        },
        async run() {
          calls.push({ sql: text, args: [...args] });
          const info = stmt.run(...args);
          return { meta: { changes: Number(info.changes) || 0 } };
        },
      };
      return api;
    },
    /** 当前库里剩下的路径（排序），用于校验删除范围 */
    remainingPaths() {
      return raw
        .prepare(`SELECT fs_path FROM ${DbTables.FS_SEARCH_INDEX_ENTRIES} ORDER BY fs_path`)
        .all()
        .map((row) => row.fs_path);
    },
  };
}

test("深目录取子目录聚合：结果正确，且 SQL 里不再有 LIKE", async () => {
  const db = createTestDb();
  const store = new FsSearchIndexStore(db);

  const rows = await store.getChildDirectoryAggregates(MOUNT, DEEP);
  assert.deepEqual(
    rows
      .map((row) => [row.dir_path, row.total_size, row.latest_modified_ms])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [
      [`${DIR_A}/`, 110, 2000],
      [`${DIR_B}/`, 300, 3000],
    ],
  );

  // 关键断言：这条查询以前是 `fs_path LIKE ?`，模式 54 字节，D1 直接拒绝
  const call = db.calls.at(-1);
  assert.equal(/\bLIKE\b/i.test(call.sql), false, "路径前缀过滤不能再出现 LIKE");
  assert.equal(`${DEEP}/%`.length > 50, true, "旧写法在该路径上必然超过 D1 的 50 字符上限");
  assert.deepEqual(call.args, [`${DEEP}/`.length + 1, MOUNT, `${DEEP}/`, `${DEEP}0`, `${DEEP}/`]);
});

test("深目录取子目录聚合：诱饵不会被卷进来", async () => {
  const db = createTestDb();
  const store = new FsSearchIndexStore(db);

  const dirPaths = (await store.getChildDirectoryAggregates(MOUNT, DEEP)).map((row) => row.dir_path);
  // 旧写法把仓库目录名里的 __ 当通配符，会额外算出一个 githubXX... 的目录
  assert.equal(dirPaths.some((path) => String(path).includes("githubXX")), false);
  // 仅在字符串前缀上相同的兄弟目录也不属于本目录
  assert.equal(dirPaths.some((path) => String(path).includes("main-other")), false);
});

test("按目录前缀删除：只删该子树，诱饵与 SQL 形态都正确", async () => {
  const db = createTestDb();
  const store = new FsSearchIndexStore(db);

  await store.deleteByPathPrefix(MOUNT, DEEP);

  assert.deepEqual(db.remainingPaths(), [DECOY_WILDCARD, DECOY_SIBLING].sort());
  const call = db.calls.at(-1);
  assert.equal(/\bLIKE\b/i.test(call.sql), false);
  // 原写法是 `fs_path = ? OR fs_path LIKE ?`，集合等价：前缀本身 + 其下全部条目
  assert.deepEqual(call.args, [MOUNT, DEEP, `${DEEP}/`, `${DEEP}0`]);
});

test("按 runId 清理旧条目：同样不使用 LIKE", async () => {
  const db = createTestDb();
  const store = new FsSearchIndexStore(db);

  await store.cleanupPrefixByRunId(MOUNT, DEEP, "run-2");

  const call = db.calls.at(-1);
  assert.equal(/\bLIKE\b/i.test(call.sql), false);
  assert.deepEqual(call.args, [MOUNT, DEEP, `${DEEP}/`, `${DEEP}0`, "run-2"]);
  // run-1 的条目都在该前缀下，应被清掉；诱饵不在前缀下，必须留下
  assert.deepEqual(db.remainingPaths(), [DECOY_WILDCARD, DECOY_SIBLING].sort());
});
