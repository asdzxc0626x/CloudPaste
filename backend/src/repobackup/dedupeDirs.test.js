/**
 * 回归测试：同分支同 sha 的重复目录去重（修改点：同分支同 sha 只保留一个目录）
 *
 * 背景：目录名是 {yyyyMMdd-HHmmss}__{分支}__{sha7}，时间戳取「本次写入时刻」。
 * 同一个 (分支, sha) 会被重复写入多次（force 重跑 / 部分目标补写 / 预算用尽续跑 / 并发），
 * 每次都生成一个新时间戳的新目录，于是挂载浏览里出现多个同分支同 sha 的文件夹。
 *
 * 这套测试锁三件事：
 * 1. 同身份分组只留一个，且留的是**时间最新**那个（用户要求的口径）
 * 2. 不该碰的一律不碰：不同 sha / 不同分支 / 认不出来的目录名
 * 3. 保护名单优先：仍被数据库记录引用的目录即使不是最新也不删
 *    （删了会让备份历史里的下载链接指向不存在的文件）
 *
 * 运行：node --test src/repobackup/dedupeDirs.test.js
 * （纯函数，不依赖数据库、不触网）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { planDirDedupe, pickKeeper, toReferencedDirs, dedupeBackupDirs } from "./dedupeDirs.js";
import { parseBackupDirName, buildBackupGroupKey, planBackupPaths } from "./paths.js";

const REF_DIR = "/backup/Github/angusdevgo__IDM_Pro_Tool/main/";

test("目录名解析：时间戳 / 分支 / 短 sha 三段各就各位", () => {
  assert.deepEqual(parseBackupDirName("20261005-155036__main__8a7950d"), {
    timestamp: "20261005-155036",
    refSegment: "main",
    shortSha: "8a7950d",
  });
});

test("目录名解析：分支名自带下划线时不能被 split 切坏", () => {
  // sanitizeSegment 不动下划线，所以 feat__new_ui 这种分支名是真实可能出现的
  const parsed = parseBackupDirName("20261005-155036__feat__new_ui__8a7950d");
  assert.deepEqual(parsed, {
    timestamp: "20261005-155036",
    refSegment: "feat__new_ui",
    shortSha: "8a7950d",
  });
  // 身份键不能把 ("a__b", sha) 和 ("a", "b__sha") 混为一谈
  assert.notEqual(
    buildBackupGroupKey({ refSegment: "a__b", shortSha: "8a7950d" }),
    buildBackupGroupKey({ refSegment: "a", shortSha: "b__8a7950d" }),
  );
});

test("目录名解析：认不出来的形态一律返回 null（不碰非本结构目录）", () => {
  assert.equal(parseBackupDirName(""), null);
  assert.equal(parseBackupDirName(null), null);
  // 老结构的仓库目录
  assert.equal(parseBackupDirName("angusdevgo__IDM_Pro_Tool"), null);
  // 时间戳形态不对
  assert.equal(parseBackupDirName("2026-10-05__main__8a7950d"), null);
  // 缺短 sha 段
  assert.equal(parseBackupDirName("20261005-155036__main"), null);
  // 短 sha 不是 7 位
  assert.equal(parseBackupDirName("20261005-155036__main__8a7950"), null);
});

test("同分支同 sha 的多个目录只留时间最新的那个", () => {
  const { removeDirPaths, duplicates } = planDirDedupe({
    refDirPath: REF_DIR,
    dirNames: [
      "20261006-221045__main__8a7950d",
      "20261011-093512__main__8a7950d", // 最新
      "20261009-041203__main__8a7950d",
    ],
  });

  assert.equal(duplicates, 2);
  assert.deepEqual(removeDirPaths.sort(), [
    `${REF_DIR}20261006-221045__main__8a7950d/`,
    `${REF_DIR}20261009-041203__main__8a7950d/`,
  ]);
  // 最新那个不在删除名单里
  assert.ok(!removeDirPaths.includes(`${REF_DIR}20261011-093512__main__8a7950d/`));
});

test("不同 sha 不是重复：各自保留，由「保留版本数」另行管理", () => {
  const { removeDirPaths, duplicates, groups } = planDirDedupe({
    refDirPath: REF_DIR,
    dirNames: [
      "20261011-093512__main__8a7950d",
      "20261002-100000__main__3f1c2ab",
      "20261001-080000__main__77c9e01",
    ],
  });

  assert.equal(groups, 3);
  assert.equal(duplicates, 0);
  assert.deepEqual(removeDirPaths, []);
});

test("同 sha 但不同分支不是重复（分支进身份键）", () => {
  const { removeDirPaths, groups } = planDirDedupe({
    refDirPath: REF_DIR,
    dirNames: ["20261011-093512__main__8a7950d", "20261011-093512__develop__8a7950d"],
  });

  assert.equal(groups, 2);
  assert.deepEqual(removeDirPaths, []);
});

test("认不出来的目录永远不进删除名单（用户自建 / 老结构 / 其它工具）", () => {
  const { removeDirPaths, groups } = planDirDedupe({
    refDirPath: REF_DIR,
    dirNames: [
      "20261011-093512__main__8a7950d",
      "20261009-041203__main__8a7950d",
      "我自己建的文件夹",
      "notes",
      "angusdevgo__IDM_Pro_Tool",
      "2026-10-05__main__8a7950d",
    ],
  });

  assert.equal(groups, 1, "只有能解析的那两个参与分组");
  assert.deepEqual(removeDirPaths, [`${REF_DIR}20261009-041203__main__8a7950d/`]);
  for (const path of removeDirPaths) {
    assert.ok(!path.includes("我自己建的文件夹"));
    assert.ok(!path.includes("notes"));
  }
});

test("保护名单优先：被引用的目录留下，更新但没被引用的目录反而要删", () => {
  /**
   * 这种排列只会出现在「更新的那次写入没走完」时：归档传上去了，
   * 但目标行还没 upsert（并发作业中途被杀 / CPU 超限）。
   * 此时更新的那个目录很可能是半截的，而被引用的那个才是备份历史里能下载的。
   *
   * 所以 keeper 取被引用的，另外两个（含更新的那个）都删 ——
   * 结果仍然是「只剩一个目录」，这正是本次要求的硬约束。
   * 删更新的那个是安全的：没有任何记录指向它，删了不会让下载链接失效。
   */
  const referencedDirs = new Set([`${REF_DIR}20261009-041203__main__8a7950d/`]);
  const { removeDirPaths } = planDirDedupe({
    refDirPath: REF_DIR,
    dirNames: [
      "20261011-093512__main__8a7950d", // 更新，但没被引用（半截写入）
      "20261009-041203__main__8a7950d", // 被引用 -> 必须留
      "20261006-221045__main__8a7950d",
    ],
    referencedDirs,
  });

  assert.deepEqual(removeDirPaths.sort(), [
    `${REF_DIR}20261006-221045__main__8a7950d/`,
    `${REF_DIR}20261011-093512__main__8a7950d/`,
  ]);
  // 被引用的那个绝不能进删除名单
  assert.ok(!removeDirPaths.includes(`${REF_DIR}20261009-041203__main__8a7950d/`));
});

test("多个目录都被引用时：一个都不删（宁可多留，也不能让下载链接失效）", () => {
  // 理论上不该出现（一个 (repo, sha) 只有一条记录），但历史数据错乱时要兜住
  const referencedDirs = new Set([
    `${REF_DIR}20261011-093512__main__8a7950d/`,
    `${REF_DIR}20261009-041203__main__8a7950d/`,
  ]);
  const { removeDirPaths } = planDirDedupe({
    refDirPath: REF_DIR,
    dirNames: ["20261011-093512__main__8a7950d", "20261009-041203__main__8a7950d"],
    referencedDirs,
  });

  assert.deepEqual(removeDirPaths, []);
});

test("正常流程：刚写完的目录必然被引用，不会被自己的去重删掉", () => {
  // RepoBackupTaskHandler 在 upsertBackupTarget 之后才查保护名单，
  // 所以本次写入的目录（也是时间最新的）同时满足「被引用」与「最新」两个条件
  const current = "20261011-093512__main__8a7950d";
  const { removeDirPaths } = planDirDedupe({
    refDirPath: REF_DIR,
    dirNames: [current, "20261009-041203__main__8a7950d", "20261006-221045__main__8a7950d"],
    referencedDirs: new Set([`${REF_DIR}${current}/`]),
  });

  assert.ok(!removeDirPaths.includes(`${REF_DIR}${current}/`));
  assert.equal(removeDirPaths.length, 2, "其余同身份目录全部收掉，最终只剩一个");
});

test("keeper 选择：被引用 > 时间最新；时间戳相同时结果稳定", () => {
  const referenced = pickKeeper([
    { dirName: "b", timestamp: "20261011-093512", referenced: false },
    { dirName: "a", timestamp: "20261009-041203", referenced: true },
  ]);
  assert.equal(referenced.dirName, "a", "被引用的优先于更新的时间");

  const newest = pickKeeper([
    { dirName: "a", timestamp: "20261009-041203", referenced: false },
    { dirName: "b", timestamp: "20261011-093512", referenced: false },
  ]);
  assert.equal(newest.dirName, "b");

  // 时间戳完全相同：同一输入必须永远选出同一个，否则两次运行会互删
  const tie = [
    { dirName: "20261011-093512__main__8a7950d", timestamp: "20261011-093512", referenced: false },
    { dirName: "20261011-093512__main__8a7950e", timestamp: "20261011-093512", referenced: false },
  ];
  assert.equal(pickKeeper(tie).dirName, pickKeeper([...tie].reverse()).dirName);
});

test("空输入 / 单个目录：什么都不删", () => {
  assert.deepEqual(planDirDedupe({ refDirPath: REF_DIR, dirNames: [] }).removeDirPaths, []);
  assert.deepEqual(planDirDedupe({ refDirPath: REF_DIR, dirNames: undefined }).removeDirPaths, []);
  assert.deepEqual(
    planDirDedupe({ refDirPath: REF_DIR, dirNames: ["20261011-093512__main__8a7950d"] }).removeDirPaths,
    [],
  );
});

test("引用路径收敛成目录集合（快照与 manifest 归到同一个目录）", () => {
  const dirs = toReferencedDirs([
    `${REF_DIR}20261011-093512__main__8a7950d/x.tar.gz`,
    `${REF_DIR}20261011-093512__main__8a7950d/x.manifest.json`,
    null,
    "",
    "裸文件名.tar.gz",
  ]);

  assert.equal(dirs.size, 1);
  assert.ok(dirs.has(`${REF_DIR}20261011-093512__main__8a7950d/`));
});

test("与 planBackupPaths 对齐：刚规划出来的目录能被解析并归入同一身份", () => {
  const first = planBackupPaths({
    mountPath: "/backup",
    pathPrefix: "/Github",
    provider: "github",
    repoIdentifier: "angusdevgo/IDM_Pro_Tool",
    commitSha: "8a7950d1234567890abcdef",
    ref: "main",
    at: new Date(Date.UTC(2026, 9, 5, 15, 50, 36)),
  });
  const later = planBackupPaths({
    mountPath: "/backup",
    pathPrefix: "/Github",
    provider: "github",
    repoIdentifier: "angusdevgo/IDM_Pro_Tool",
    commitSha: "8a7950d1234567890abcdef",
    ref: "main",
    at: new Date(Date.UTC(2026, 9, 11, 9, 35, 12)),
  });

  // 两次规划出两个不同目录 —— 这正是重复目录的来源
  assert.notEqual(first.backupDirName, later.backupDirName);
  // 但身份键相同，所以会被判定为同一份备份
  assert.equal(
    buildBackupGroupKey(parseBackupDirName(first.backupDirName)),
    buildBackupGroupKey(parseBackupDirName(later.backupDirName)),
  );

  // 端到端：扫一遍只剩最新那个
  const { removeDirPaths } = planDirDedupe({
    refDirPath: first.refDirPath,
    dirNames: [first.backupDirName, later.backupDirName],
  });
  assert.deepEqual(removeDirPaths, [`${first.refDirPath}${first.backupDirName}/`]);
});

// ==================== dedupeBackupDirs（IO 层的失败兜底）====================

/** 造一个最小 FileSystem 替身 */
function fakeFileSystem({ items, onRemove, listError }) {
  return {
    listDirectory: async () => {
      if (listError) throw listError;
      return { items };
    },
    batchRemoveItems: async (paths) => {
      if (onRemove) return onRemove(paths);
      return { success: paths.length, failed: [] };
    },
  };
}

test("dedupeBackupDirs：只删目录项，文件项不参与（避免把快照当目录删）", async () => {
  let removedPaths = null;
  const fs = fakeFileSystem({
    items: [
      { name: "20261011-093512__main__8a7950d", isDirectory: true },
      { name: "20261009-041203__main__8a7950d", isDirectory: true },
      // 分支目录下混入的文件：名字恰好像专属目录名，但它不是目录
      { name: "20261006-221045__main__8a7950d", isDirectory: false },
    ],
    onRemove: (paths) => {
      removedPaths = paths;
      return { success: paths.length, failed: [] };
    },
  });

  const summary = await dedupeBackupDirs({
    fileSystem: fs,
    refDirPath: REF_DIR,
    userId: "admin",
    userType: "admin",
  });

  assert.deepEqual(removedPaths, [`${REF_DIR}20261009-041203__main__8a7950d/`]);
  assert.equal(summary.removed, 1);
  assert.equal(summary.failed, 0);
});

test("dedupeBackupDirs：列目录失败时静默收手，不抛错（不能让备份任务失败）", async () => {
  const fs = fakeFileSystem({ listError: new Error("挂载点不存在") });

  const summary = await dedupeBackupDirs({
    fileSystem: fs,
    refDirPath: REF_DIR,
    userId: "admin",
    userType: "admin",
  });

  assert.deepEqual(summary, { removed: 0, failed: 0, duplicates: 0 });
});

test("dedupeBackupDirs：删除失败只计数，不抛错", async () => {
  const fs = fakeFileSystem({
    items: [
      { name: "20261011-093512__main__8a7950d", isDirectory: true },
      { name: "20261009-041203__main__8a7950d", isDirectory: true },
    ],
    onRemove: () => {
      throw new Error("驱动只读");
    },
  });

  const summary = await dedupeBackupDirs({
    fileSystem: fs,
    refDirPath: REF_DIR,
    userId: "admin",
    userType: "admin",
  });

  assert.equal(summary.removed, 0);
  assert.equal(summary.failed, 1);
  assert.equal(summary.duplicates, 1);
});

test("dedupeBackupDirs：没有重复时不发起任何删除请求", async () => {
  let called = false;
  const fs = fakeFileSystem({
    items: [
      { name: "20261011-093512__main__8a7950d", isDirectory: true },
      { name: "20261002-100000__main__3f1c2ab", isDirectory: true },
    ],
    onRemove: () => {
      called = true;
      return { success: 0, failed: [] };
    },
  });

  const summary = await dedupeBackupDirs({
    fileSystem: fs,
    refDirPath: REF_DIR,
    userId: "admin",
    userType: "admin",
  });

  assert.equal(called, false, "无重复时不该调用 batchRemoveItems");
  assert.equal(summary.duplicates, 0);
});

test("dedupeBackupDirs：缺少 fileSystem / refDirPath 时安全返回", async () => {
  assert.deepEqual(await dedupeBackupDirs({ refDirPath: REF_DIR }), {
    removed: 0,
    failed: 0,
    duplicates: 0,
  });
  assert.deepEqual(await dedupeBackupDirs({ fileSystem: fakeFileSystem({ items: [] }) }), {
    removed: 0,
    failed: 0,
    duplicates: 0,
  });
});
