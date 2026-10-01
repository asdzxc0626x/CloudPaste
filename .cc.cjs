// 一次性校验脚本（用完即删）
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = __dirname;
let fail = 0;
const tmp = [];

const jsFiles = [
  "backend/src/repobackup/schedule.js",
  "backend/src/services/codeRepositoryService.js",
  "frontend/src/api/services/repoBackupService.js",
];
const sfcs = [
  "frontend/src/modules/admin/components/repo-backup/RepoBackupForm.vue",
  "frontend/src/modules/admin/components/repo-backup/RepoBackupTable.vue",
];

for (const rel of jsFiles) {
  try {
    execFileSync(process.execPath, ["--check", path.join(root, rel)], { stdio: "pipe" });
    console.log(`OK   语法 ${rel}`);
  } catch (e) {
    fail++;
    console.log(`FAIL 语法 ${rel}\n${e.stderr?.toString() || e.message}`);
  }
}

const VOID = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);
for (const rel of sfcs) {
  const src = fs.readFileSync(path.join(root, rel), "utf8");
  const sm = src.match(/<script setup>([\s\S]*?)\n<\/script>/);
  if (!sm) { fail++; console.log(`FAIL 无 script setup ${rel}`); }
  else {
    const f = path.join(root, `.chk_${path.basename(rel)}.mjs`);
    fs.writeFileSync(f, sm[1]); tmp.push(f);
    try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); console.log(`OK   语法 ${rel} <script setup>`); }
    catch (e) { fail++; console.log(`FAIL 语法 ${rel}\n${e.stderr?.toString() || e.message}`); }
  }
  const tm = src.match(/^<template>([\s\S]*)\n<\/template>/m);
  if (!tm) { fail++; console.log(`FAIL 无 template ${rel}`); continue; }
  const body = tm[1].replace(/<!--[\s\S]*?-->/g, "");
  const stack = []; const re = /<(\/?)([a-zA-Z][\w.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m, bad = null;
  while ((m = re.exec(body))) {
    const [, closing, tag, , self] = m;
    if (VOID.has(tag.toLowerCase()) || self === "/") continue;
    if (closing) { const top = stack.pop(); if (top !== tag) { bad = `</${tag}> 与 <${top}> 不匹配`; break; } }
    else stack.push(tag);
  }
  if (bad) { fail++; console.log(`FAIL 标签 ${rel}: ${bad}`); }
  else if (stack.length) { fail++; console.log(`FAIL 标签 ${rel}: 未闭合 ${stack.join(" > ")}`); }
  else console.log(`OK   标签配平 ${rel}`);
}

// i18n 对齐
function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out.add(key);
  }
}
function load(locale) {
  let src = fs.readFileSync(path.join(root, `frontend/src/i18n/locales/${locale}/admin/repoBackup.js`), "utf8")
    .replace(/^\/\/.*$/gm, "").replace(/^export default\s*/m, "").replace(/;\s*$/, "");
  const out = new Set();
  // eslint-disable-next-line no-eval
  flatten(eval(`(${src})`), "admin", out);
  return out;
}
const zh = load("zh-CN"), en = load("en-US");
for (const k of zh) if (!en.has(k)) { fail++; console.log(`FAIL en-US 缺少 ${k}`); }
for (const k of en) if (!zh.has(k)) { fail++; console.log(`FAIL zh-CN 缺少 ${k}`); }
console.log(`i18n admin.repoBackup: zh=${zh.size} en=${en.size}`);

// 组件静态引用的键
const refFiles = [
  ...sfcs,
  "frontend/src/modules/admin/components/repo-backup/RepoBackupHistory.vue",
  "frontend/src/modules/admin/components/repo-backup/RepoBackupRowActions.vue",
  "frontend/src/modules/admin/views/RepoBackupView.vue",
];
const refs = new Set();
for (const rel of refFiles) {
  const src = fs.readFileSync(path.join(root, rel), "utf8");
  for (const m of src.matchAll(/\$?t\(\s*["'](admin\.repoBackup\.[A-Za-z0-9_.]+)["']/g)) refs.add(m[1]);
}
for (const k of refs) {
  if (!zh.has(k)) { fail++; console.log(`FAIL zh-CN 缺少被引用的 ${k}`); }
  if (!en.has(k)) { fail++; console.log(`FAIL en-US 缺少被引用的 ${k}`); }
}
console.log(`检查了 ${refs.size} 个静态引用键`);

// 动态拼接：cron 预设键必须齐全
const formSrc = fs.readFileSync(path.join(root, sfcs[0]), "utf8");
const presetKeys = [...(formSrc.match(/CRON_PRESETS = \[([\s\S]*?)\];/)?.[1] || "").matchAll(/key:\s*"([A-Za-z]+)"/g)].map(m => m[1]);
if (presetKeys.length === 0) { fail++; console.log("FAIL 未解析到 CRON_PRESETS"); }
for (const key of presetKeys) {
  const k = `admin.repoBackup.form.cronPreset.${key}`;
  if (!zh.has(k)) { fail++; console.log(`FAIL zh-CN 缺少 ${k}`); }
  if (!en.has(k)) { fail++; console.log(`FAIL en-US 缺少 ${k}`); }
}
console.log(`cron 预设: ${presetKeys.join(", ")}`);

// cron 预设表达式必须是 5 段（与后端校验一致）
const exprs = [...(formSrc.match(/CRON_PRESETS = \[([\s\S]*?)\];/)?.[1] || "").matchAll(/expression:\s*"([^"]+)"/g)].map(m => m[1]);
for (const e of exprs) {
  const n = e.trim().split(/\s+/).filter(Boolean).length;
  if (n !== 5) { fail++; console.log(`FAIL cron 预设 "${e}" 是 ${n} 段，必须 5 段`); }
}
const defCron = formSrc.match(/DEFAULT_CRON = "([^"]+)"/)?.[1];
if (!defCron || defCron.trim().split(/\s+/).length !== 5) { fail++; console.log(`FAIL DEFAULT_CRON 非 5 段: ${defCron}`); }
console.log(`预设表达式均为 5 段，DEFAULT_CRON=${defCron}`);

// 后端 schedule.js 必须透传 cron 字段
const schedSrc = fs.readFileSync(path.join(root, "backend/src/repobackup/schedule.js"), "utf8");
for (const token of ["scheduleType", "cronExpression", "scheduleCron"]) {
  if (!schedSrc.includes(token)) { fail++; console.log(`FAIL schedule.js 缺少 ${token}`); }
}
const svcSrc = fs.readFileSync(path.join(root, "backend/src/services/codeRepositoryService.js"), "utf8");
const syncCalls = (svcSrc.match(/syncRepositoryScheduleJob\(db, \{/g) || []).length;
const cronPass = (svcSrc.match(/cronExpression: schedule\.cronExpression/g) || []).length;
if (syncCalls !== cronPass) { fail++; console.log(`FAIL 服务层 ${syncCalls} 处调用只有 ${cronPass} 处透传 cronExpression`); }
else console.log(`服务层 ${syncCalls} 处 syncRepositoryScheduleJob 调用均透传 cron 字段`);

for (const f of tmp) fs.unlinkSync(f);
console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail ? 1 : 0);
