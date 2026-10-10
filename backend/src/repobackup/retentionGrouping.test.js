/**
 * 回归测试：保留清理的待删路径分组（修改点：备份目录按分支分层）
 *
 * 背景：
 * 分层之后，一次备份的快照与 manifest 都躺在同一个「时间_分支_sha」目录里。
 * 保留清理把这两个文件删掉之后，目录本身还留着，本地 / WebDAV 这类真实目录的
 * 存储上会越堆越多空目录，所以要把该目录一并带进删除列表。
 *
 * 这套测试锁的是一条**不可逆**的边界：目录删除必须严格限定在「本次备份的专属目录」。
 * 一旦把改造前的老记录（父目录是仓库目录 github__owner__repo）也算成可删目录，
 * 清理一个旧版本就会连整个仓库的历史备份一起删掉。
 *
 * 注意（修改点：快照按仓库名命名）：专属目录里的文件名是 owner__repo__分支__sha，
 * 与目录名并不同名，因此判定只能看目录名 —— 这条也在下面的用例里盯着。
 *
 * 运行：node --test src/repobackup/retentionGrouping.test.js
 * （不依赖数据库、不触网）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { groupPathsByMount } from "./retention.js";

const MOUNT_A = "mount-a";
const REPO_DIR = "/mnt/GitHub/github__owner__repo";

/** 造一条 code_repository_backup_targets 行 */
function target(mountId, storagePath, manifestPath) {
  return { mount_id: mountId, storage_path: storagePath, manifest_path: manifestPath };
}

test("新结构：文件按挂载点分组，快照与 manifest 所在的专属目录各出现一次", () => {
  const dir = `${REPO_DIR}/main/20261005-155036__main__8a7950d/`;
  const { files, dirs } = groupPathsByMount(
    [
      target(
        MOUNT_A,
        `${dir}owner__repo__main__8a7950d.tar.gz`,
        `${dir}owner__repo__main__8a7950d.manifest.json`,
      ),
    ],
    null,
  );

  assert.deepEqual(files.get(MOUNT_A), [
    `${dir}owner__repo__main__8a7950d.tar.gz`,
    `${dir}owner__repo__main__8a7950d.manifest.json`,
  ]);
  // 两条路径推出同一个目录，去重后只删一次
  assert.deepEqual(dirs.get(MOUNT_A), [dir]);
});

test("老结构：只删文件，绝不把仓库目录当成可删目录", () => {
  const { files, dirs } = groupPathsByMount(
    [
      target(
        MOUNT_A,
        `${REPO_DIR}/20261005-155036__main__8a7950d.tar.gz`,
        `${REPO_DIR}/20261005-155036__main__8a7950d.manifest.json`,
      ),
    ],
    null,
  );

  assert.equal(files.get(MOUNT_A).length, 2);
  assert.deepEqual(dirs.get(MOUNT_A), undefined);
});

test("多个目标挂在同一个挂载点时，目录不会重复", () => {
  const dir1 = `${REPO_DIR}/a/20261001-000000__a__1111111/`;
  const dir2 = `${REPO_DIR}/b/20261002-000000__b__2222222/`;
  const { dirs } = groupPathsByMount(
    [
      target(MOUNT_A, `${dir1}owner__repo__a__1111111.tar.gz`, null),
      target(MOUNT_A, `${dir2}owner__repo__b__2222222.tar.gz`, null),
    ],
    null,
  );

  assert.deepEqual(dirs.get(MOUNT_A), [dir1, dir2]);
});

test("v35 老记录（路径直接存在备份记录上）走同一套判定", () => {
  const legacyDir = `${REPO_DIR}/main/20261005-155036__main__8a7950d/`;
  const { files, dirs } = groupPathsByMount([], {
    target_mount_id: MOUNT_A,
    storage_path: `${legacyDir}owner__repo__main__8a7950d.tar.gz`,
    manifest_path: `${legacyDir}owner__repo__main__8a7950d.manifest.json`,
  });

  assert.equal(files.get(MOUNT_A).length, 2);
  assert.deepEqual(dirs.get(MOUNT_A), [legacyDir]);
});

test("缺 manifest 或路径为空时不产出垃圾条目（原有行为不变）", () => {
  const { files, dirs } = groupPathsByMount([target(MOUNT_A, null, null)], null);

  assert.deepEqual(files.get(MOUNT_A), undefined);
  assert.deepEqual(dirs.get(MOUNT_A), undefined);
});
