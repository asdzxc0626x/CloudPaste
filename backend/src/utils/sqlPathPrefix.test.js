/**
 * 回归测试：路径前缀匹配的「D1 安全」实现
 * （修改点：修复 D1 的 LIKE 模式 50 字符上限导致的挂载浏览 500）
 *
 * 背景：
 * Cloudflare D1 把 SQLITE_LIMIT_LIKE_PATTERN_LENGTH 从上游默认的 50000 压到了 50
 * （官方文档 D1 Limits：LIKE pattern length = 50 characters）。
 * 模式一旦超过 50 字节，D1 直接抛
 *   D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR
 * 而本项目的 FS 路径带挂载段（/b2-1/Github/github__owner__repo/main 已经 52 字节），
 * 深目录下 `fs_path LIKE '<目录>/%'` 必然越界 —— 挂载浏览点进深目录就整个 500。
 *
 * 这套测试锁四件事：
 * 1. 区间边界本身的形态（lower 补 "/"，upper 是末位字节 +1）
 * 2. 与 LIKE 的集合等价性（用真实 SQLite 跑新旧两套查询对比结果集）
 * 3. 有意保留的两处差异：大小写敏感、路径里的 _ 不再被当通配符
 * 4. 深路径下产出的 SQL 里**不含 LIKE** —— 这才是根治点
 *
 * 运行：node --test src/utils/sqlPathPrefix.test.js
 * （用 node:sqlite 建真实内存库，不触网）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { buildPathPrefixBounds, buildPathPrefixCondition } from "./sqlPathPrefix.js";

/** D1 对 LIKE/GLOB 模式的硬上限（字节）——超出即报 LIKE or GLOB pattern too complex */
const D1_LIKE_PATTERN_LIMIT = 50;

/** 建一张只有路径的迷你表，包成 D1 形状的 prepare/bind/all */
function createPathDb(paths) {
  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE entries (mount_id TEXT NOT NULL, fs_path TEXT NOT NULL)");
  const insert = raw.prepare("INSERT INTO entries (mount_id, fs_path) VALUES (?, ?)");
  for (const path of paths) insert.run("m1", path);

  return {
    all(sql, ...args) {
      return raw.prepare(sql).all(...args).map((row) => row.fs_path);
    },
  };
}

/** 改造前的写法：字符串前缀 + LIKE（未转义通配符） */
function oldLikeQuery(db, prefix, { includeExact = false } = {}) {
  const like = prefix.endsWith("/") ? `${prefix}%` : `${prefix}/%`;
  const sql = includeExact
    ? "SELECT fs_path FROM entries WHERE mount_id = ? AND (fs_path = ? OR fs_path LIKE ?)"
    : "SELECT fs_path FROM entries WHERE mount_id = ? AND fs_path LIKE ?";
  const args = includeExact ? ["m1", prefix, like] : ["m1", like];
  return db.all(sql, ...args).sort();
}

/** 改造后的写法：范围查询 */
function newRangeQuery(db, column, prefix, options = {}) {
  const scope = buildPathPrefixCondition(column, prefix, options);
  const sql = `SELECT fs_path FROM entries WHERE mount_id = ? AND ${scope.sql}`;
  return db.all(sql, "m1", ...scope.params).sort();
}

test("区间边界：前缀补上结尾的 '/'，上界是末位字节 +1", () => {
  assert.deepEqual(buildPathPrefixBounds("/a/b"), { exact: "/a/b", lower: "/a/b/", upper: "/a/b0" });
  // 已经带结尾斜杠时结果一致（不会补出 "//"）
  assert.deepEqual(buildPathPrefixBounds("/a/b/"), { exact: "/a/b/", lower: "/a/b/", upper: "/a/b0" });
  // 根目录：FS 路径都以 "/" 开头，["/", "0") 即全集
  assert.deepEqual(buildPathPrefixBounds("/"), { exact: "/", lower: "/", upper: "0" });
});

test("空前缀返回 null（调用方跳过该条件，不产出恒真 SQL）", () => {
  assert.equal(buildPathPrefixBounds(""), null);
  assert.equal(buildPathPrefixBounds("   "), null);
  assert.equal(buildPathPrefixBounds(null), null);
  assert.equal(buildPathPrefixBounds(undefined), null);
  assert.equal(buildPathPrefixCondition("fs_path", ""), null);
});

test("includeExact=false 只要子树，=true 连前缀本身一起匹配", () => {
  const plain = buildPathPrefixCondition("fs_path", "/a/b");
  assert.equal(plain.sql, "fs_path >= ? AND fs_path < ?");
  assert.deepEqual(plain.params, ["/a/b/", "/a/b0"]);

  // 对应原先 `fs_path = ? OR fs_path LIKE ?` 的写法：整体加括号，便于调用方继续 AND 拼接
  const withExact = buildPathPrefixCondition("fs_path", "/a/b", { includeExact: true });
  assert.equal(withExact.sql, "(fs_path = ? OR fs_path >= ? AND fs_path < ?)");
  assert.deepEqual(withExact.params, ["/a/b", "/a/b/", "/a/b0"]);
});

test("非法列名直接抛错（列名只允许来自代码字面量）", () => {
  assert.throws(() => buildPathPrefixCondition("fs_path; DROP TABLE entries", "/a"), TypeError);
  assert.throws(() => buildPathPrefixCondition("", "/a"), TypeError);
  assert.throws(() => buildPathPrefixCondition("fs_path) OR 1=1 --", "/a"), TypeError);
});

test("与 LIKE 集合等价：边界值前后、同名前缀、兄弟目录都不能错", () => {
  const paths = [
    "/m/a", // 前缀本身
    "/m/a/", // 前缀本身（带斜杠）
    "/m/a/x",
    "/m/a/x/y",
    "/m/a/.hidden",
    "/m/a0", // 同名前缀的兄弟目录
    "/m/a0/z",
    "/m/a-b", // 排序在前缀之前，绝不能被范围查询卷进来
    "/m/ab",
    "/m/b",
  ];
  const db = createPathDb(paths);

  for (const prefix of ["/m/a", "/m/a/"]) {
    assert.deepEqual(newRangeQuery(db, "fs_path", prefix), oldLikeQuery(db, prefix), `前缀 ${prefix} 不带 includeExact`);
    assert.deepEqual(
      newRangeQuery(db, "fs_path", prefix, { includeExact: true }),
      oldLikeQuery(db, prefix, { includeExact: true }),
      `前缀 ${prefix} 带 includeExact`,
    );
  }

  // 具体到集合本身：/m/a-b 排序在 /m/a/ 之前，靠下界排除；/m/a0 靠上界排除
  assert.deepEqual(newRangeQuery(db, "fs_path", "/m/a", { includeExact: true }), [
    "/m/a",
    "/m/a/",
    "/m/a/.hidden",
    "/m/a/x",
    "/m/a/x/y",
  ]);
});

test("有意差异一：路径里的 _ 不再被当成「任意单字符」通配符", () => {
  // 真实场景：仓库目录名里有 __（github__owner__repo），旧写法会把这两处当通配符
  const decoy = "/b2-1/Github/githubXXmisaka10032wXXHan1meViewer/main/f.tar.gz";
  const real = "/b2-1/Github/github__misaka10032w__Han1meViewer/main/f.tar.gz";
  const db = createPathDb([decoy, real]);
  const prefix = "/b2-1/Github/github__misaka10032w__Han1meViewer/main";

  // 旧写法：模式里的 _ 是通配符，兄弟目录被误命中
  assert.ok(oldLikeQuery(db, prefix).includes(decoy), "旧 LIKE 会误命中 _ 位置的其它字符");
  // 新写法：按字面量匹配，只认真正的那个目录
  assert.deepEqual(newRangeQuery(db, "fs_path", prefix), [real]);
});

test("有意差异二：大小写敏感，不再把 /a/b 与 /A/B 混成一棵树", () => {
  const db = createPathDb(["/m/a/x", "/m/A/x"]);
  // 旧 LIKE 对 ASCII 不区分大小写
  assert.deepEqual(oldLikeQuery(db, "/m/a"), ["/m/A/x", "/m/a/x"]);
  // 范围比较按字节比较，只认真正同一条路径
  assert.deepEqual(newRangeQuery(db, "fs_path", "/m/a"), ["/m/a/x"]);
});

test("深路径：产出的 SQL 不含 LIKE，彻底摆脱 D1 的 50 字符上限", () => {
  // 用户实际踩到的路径：/mount-explorer/b2-1/Github/github__misaka10032w__Han1meViewer/main
  const deep = "/b2-1/Github/github__misaka10032w__Han1meViewer/main";
  assert.equal(deep.length, 52);

  // 旧写法的模式长度：52 + "/" + "%" = 54，D1 直接拒绝
  const legacyPattern = `${deep}/%`;
  assert.ok(
    legacyPattern.length > D1_LIKE_PATTERN_LIMIT,
    `旧写法的模式 ${legacyPattern.length} 字节，已超过 D1 的 ${D1_LIKE_PATTERN_LIMIT} 字节上限`,
  );

  // 新写法：SQL 里没有 LIKE（比较操作数没有长度限制），绑定的仍是完整路径
  const scope = buildPathPrefixCondition("fs_path", deep);
  assert.equal(/\bLIKE\b/i.test(scope.sql), false);
  assert.equal(scope.sql, "fs_path >= ? AND fs_path < ?");
  assert.deepEqual(scope.params, [`${deep}/`, `${deep}0`]);
});
