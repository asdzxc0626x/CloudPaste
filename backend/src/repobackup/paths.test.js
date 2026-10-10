/**
 * 回归测试：备份落盘路径（修改点：备份目录按分支分层 + 快照按仓库名命名）
 *
 * 背景（本次改动的目标形态）：
 *   仓库目录 /{owner}__{repo}/
 *     └ 分支目录 {ref}/
 *         └ 本次备份专属目录 {yyyyMMdd-HHmmss}__{ref}__{sha7}/
 *             ├ {owner}__{repo}__{ref}__{sha7}.tar.gz
 *             └ {owner}__{repo}__{ref}__{sha7}.manifest.json
 * 例：/Github/angusdevgo__IDM_Pro_Tool/test/20261005-155036__test__8a7950d/angusdevgo__IDM_Pro_Tool__test__8a7950d.tar.gz
 * （修改点：仓库目录去掉平台前缀，原先是 github__owner__repo；
 *   修改点：默认目录改首字母大写，示例里的 /Github 与 provider 默认值一致）
 *
 * 注：用例里的 pathPrefix 是「用户/表单传入的前缀」，不是 provider 默认值，
 * 这里取 /Github 只是为了让示例与线上实际目录一致
 *
 * 这套测试锁三件事：
 * 1. 路径形态本身（分支目录、专属目录、目录名与文件名的分工）
 * 2. 边界：ref 缺失 / 分支名带斜杠 / prefix 多级，都不能拼出非法或歧义路径
 * 3. 版本保留清理用的「反推专属目录」只认新结构 —— 老记录（父目录是仓库目录）
 *    必须返回 null，否则保留清理会把整个仓库目录删掉。目录名与文件名已经不同名，
 *    这套测试专门盯住「判定只看目录名」这一点
 *
 * 运行：node --test src/repobackup/paths.test.js
 * （不依赖数据库、不触网）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { planBackupPaths, resolveBackupDirFromFilePath, buildTimestamp, buildRepoFolderName } from "./paths.js";

/** 造一个固定的时间点，避免用例受运行时刻影响 */
const AT = new Date(Date.UTC(2026, 9, 5, 15, 50, 36)); // 2026-10-05 15:50:36 UTC -> 20261005-155036

const BASE = {
  mountPath: "/backup",
  pathPrefix: "/Github",
  provider: "github",
  repoIdentifier: "angusdevgo/IDM_Pro_Tool",
  commitSha: "8a7950d1234567890abcdef",
  at: AT,
};

const REPO_DIR = "/backup/Github/angusdevgo__IDM_Pro_Tool";

test("新结构：分支目录 + 本次备份专属目录，目录名与文件名各司其职", () => {
  const paths = planBackupPaths({ ...BASE, ref: "main" });

  const dirName = "20261005-155036__main__8a7950d";
  const fileBase = "angusdevgo__IDM_Pro_Tool__main__8a7950d";

  assert.equal(paths.repoDirPath, `${REPO_DIR}/`);
  assert.equal(paths.refDirPath, `${REPO_DIR}/main/`);
  assert.equal(paths.backupDirPath, `${REPO_DIR}/main/${dirName}/`);
  assert.equal(paths.archivePath, `${REPO_DIR}/main/${dirName}/${fileBase}.tar.gz`);
  assert.equal(paths.manifestPath, `${REPO_DIR}/main/${dirName}/${fileBase}.manifest.json`);

  assert.equal(paths.backupDirName, dirName);
  assert.equal(paths.fileBaseName, fileBase);
  assert.equal(paths.archiveFileName, `${fileBase}.tar.gz`);
  assert.equal(paths.manifestFileName, `${fileBase}.manifest.json`);
  assert.equal(paths.refSegment, "main");
});

test("文件名用 owner__repo 而不是仓库目录名（不含平台前缀）", () => {
  const paths = planBackupPaths({ ...BASE, ref: "test" });

  assert.equal(paths.fileBaseName, "angusdevgo__IDM_Pro_Tool__test__8a7950d");
  // 平台前缀只出现在路径里，不重复进文件名
  assert.ok(!paths.archiveFileName.includes("github"));
});

test("同一仓库的不同分支落在各自的目录下，文件名也带各自的引用名", () => {
  const main = planBackupPaths({ ...BASE, ref: "main" });
  const other = planBackupPaths({ ...BASE, ref: "test" });

  assert.notEqual(main.refDirPath, other.refDirPath);
  assert.ok(other.archivePath.startsWith(`${REPO_DIR}/test/`));
  assert.ok(other.archiveFileName.startsWith("angusdevgo__IDM_Pro_Tool__test__"));
  // 仓库根目录是两者共同的父目录，分支维度只在它之下展开
  assert.equal(main.repoDirPath, other.repoDirPath);
});

test("同一分支的两次备份各自独占一个目录（时间戳不同）", () => {
  const first = planBackupPaths({ ...BASE, ref: "main" });
  const later = planBackupPaths({ ...BASE, ref: "main", at: new Date(Date.UTC(2026, 9, 6, 1, 2, 3)) });

  assert.notEqual(first.backupDirPath, later.backupDirPath);
  assert.equal(later.backupDirPath, `${REPO_DIR}/main/20261006-010203__main__8a7950d/`);
  // 时间戳只进目录名，文件名保持「仓库_分支_sha」不变
  assert.equal(later.archiveFileName, "angusdevgo__IDM_Pro_Tool__main__8a7950d.tar.gz");
});

test("ref 缺失时用 default 兜底，目录与文件名都不塌陷", () => {
  const paths = planBackupPaths({ ...BASE, ref: null });

  assert.equal(paths.refSegment, "default");
  assert.ok(paths.backupDirPath.includes("/default/20261005-155036__default__8a7950d/"));
  assert.equal(paths.archiveFileName, "angusdevgo__IDM_Pro_Tool__default__8a7950d.tar.gz");
  // 反推仍能认出专属目录（判定只看目录名）
  assert.equal(resolveBackupDirFromFilePath(paths.archivePath), paths.backupDirPath);
});

test("分支名带斜杠不会拼出多级目录", () => {
  const paths = planBackupPaths({ ...BASE, ref: "feature/login" });

  assert.equal(paths.refSegment, "feature-login");
  assert.ok(paths.backupDirPath.includes("/feature-login/20261005-155036__feature-login__8a7950d/"));
  assert.equal(paths.archiveFileName, "angusdevgo__IDM_Pro_Tool__feature-login__8a7950d.tar.gz");
  // 目录层级固定为「仓库 / 分支 / 备份」三层，ref 里的斜杠不能改变层数
  const depth = paths.backupDirPath.replace("/backup/Github/", "").split("/").filter(Boolean).length;
  assert.equal(depth, 3);
});

test("prefix 为根目录时不多出空目录段", () => {
  const paths = planBackupPaths({ ...BASE, pathPrefix: "/", ref: "main" });

  assert.ok(paths.archivePath.startsWith("/backup/angusdevgo__IDM_Pro_Tool/main/"));
  assert.ok(!paths.archivePath.includes("//"));
});

test("挂载点路径无效时仍然抛错（原有行为不变）", () => {
  assert.throws(() => planBackupPaths({ ...BASE, mountPath: "", ref: "main" }));
});

test("仓库目录名是 owner__repo（修改点：去掉平台前缀）", () => {
  assert.equal(
    buildRepoFolderName({ provider: "github", repoIdentifier: "angusdevgo/IDM_Pro_Tool" }),
    "angusdevgo__IDM_Pro_Tool",
  );
  // 仓库源由上级前缀目录体现（GitHub → /Github），不再重复进目录名
  // （修改点：默认目录改首字母大写，原为 /GitHub）
  assert.equal(
    buildRepoFolderName({ provider: "github", repoIdentifier: "angusdevgo/IDM_Pro_Tool" }),
    buildRepoFolderName({ provider: "anything-else", repoIdentifier: "angusdevgo/IDM_Pro_Tool" }),
  );
  // 仓库标识残缺时的兜底也与改造前一致
  assert.equal(buildRepoFolderName({ provider: "github", repoIdentifier: "" }), "unknown__unknown");
  // 清洗规则不变：非法字符仍然被规范化
  assert.equal(buildRepoFolderName({ repoIdentifier: "a/b:c" }), "a__b-c");
});

test("反推专属目录：新结构返回目录，快照与 manifest 得到同一个目录", () => {
  const paths = planBackupPaths({ ...BASE, ref: "main" });

  assert.equal(resolveBackupDirFromFilePath(paths.archivePath), paths.backupDirPath);
  assert.equal(resolveBackupDirFromFilePath(paths.manifestPath), paths.backupDirPath);
});

test("反推专属目录：老结构（父目录是仓库目录）必须返回 null，避免误删整个仓库目录", () => {
  // 分层改造前的平铺形态：快照直接放在仓库目录下
  assert.equal(resolveBackupDirFromFilePath(`${REPO_DIR}/20261005-155036__main__8a7950d.tar.gz`), null);
  assert.equal(resolveBackupDirFromFilePath(`${REPO_DIR}/20261005-155036__8a7950d.tar.gz`), null);
  assert.equal(resolveBackupDirFromFilePath(`${REPO_DIR}/20261005-155036__main__8a7950d.manifest.json`), null);
});

test("反推专属目录：只看目录名像不像时间戳，文件名是什么都不影响", () => {
  const dirPath = `${REPO_DIR}/main/20261005-155036__main__8a7950d/`;
  // 时间戳形态不对（只有年月日 / 缺短 sha）一律不认
  assert.equal(resolveBackupDirFromFilePath(`${REPO_DIR}/main/2026-10-05__main__8a7950d/x.tar.gz`), null);
  assert.equal(resolveBackupDirFromFilePath(`${REPO_DIR}/main/20261005-155036__main/x.tar.gz`), null);
  // 目录名对得上时，不管文件名长什么样都返回该目录
  assert.equal(resolveBackupDirFromFilePath(`${dirPath}whatever.tar.gz`), dirPath);
});

test("反推专属目录：空值与裸文件名一律返回 null", () => {
  assert.equal(resolveBackupDirFromFilePath(""), null);
  assert.equal(resolveBackupDirFromFilePath(null), null);
  assert.equal(resolveBackupDirFromFilePath(undefined), null);
  assert.equal(resolveBackupDirFromFilePath("snapshot.tar.gz"), null);
});

test("buildTimestamp 仍是 UTC 的 yyyyMMdd-HHmmss（原有行为不变）", () => {
  assert.equal(buildTimestamp(AT), "20261005-155036");
});
