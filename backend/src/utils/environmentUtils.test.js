/**
 * 回归验证：分片上传参数的按场景覆盖（修改点：大仓库备份 CPU/耗时优化）
 *
 * 运行：node --test src/utils/environmentUtils.test.js（整仓用 `npm test`）
 *
 * 这个覆盖口子是给「明确知道自己在搬大文件」的调用方开的（目前只有仓库备份）。
 * 它有两条必须守住的边界：
 *  1. 不传覆盖值时，结果必须与开这个口子之前**一字不差** ——
 *     这里是所有 S3 流式上传的公共入口（页面上传、WebDAV PUT 都走它），
 *     默认值一旦漂移就是全局行为变化；
 *  2. 传进来的值必须夹到合法区间 —— S3 协议规定除最后一片外分片不得小于 5MiB，
 *     配小了整个分片上传会被服务端拒绝，而这种错误在上传到一半才报出来。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { getEnvironmentOptimizedUploadConfig, UPLOAD_TUNING_LIMITS } from "./environmentUtils.js";

const MIB = 1024 * 1024;

test("不传覆盖值时与改动前完全一致（Node 口径：8MB 分片 / 4 并发）", () => {
  const base = getEnvironmentOptimizedUploadConfig();
  assert.equal(base.partSize, 8 * MIB);
  assert.equal(base.queueSize, 4);
  assert.equal(base.maxConcurrency, 4);
  assert.equal(base.environment, "Docker/Server");

  // null 与 undefined 都表示「没给覆盖值」
  assert.deepEqual(getEnvironmentOptimizedUploadConfig(null), base);
  assert.deepEqual(getEnvironmentOptimizedUploadConfig(undefined), base);
});

test("只覆盖并发度时，分片大小保持环境默认值", () => {
  const cfg = getEnvironmentOptimizedUploadConfig({ queueSize: 2 });
  assert.equal(cfg.queueSize, 2);
  assert.equal(cfg.partSize, 8 * MIB, "没覆盖的字段不许被动过");
});

test("maxConcurrency 跟着 queueSize 走（同一件事的两个名字，不能各说各话）", () => {
  const cfg = getEnvironmentOptimizedUploadConfig({ queueSize: 3 });
  assert.equal(cfg.maxConcurrency, 3);
});

test("分片大小被夹进 S3 允许的区间：低于 5MiB 会让分片上传被服务端拒绝", () => {
  const tooSmall = getEnvironmentOptimizedUploadConfig({ partSize: 1 * MIB });
  assert.equal(tooSmall.partSize, UPLOAD_TUNING_LIMITS.MIN_PART_SIZE);

  const tooBig = getEnvironmentOptimizedUploadConfig({ partSize: 1024 * MIB });
  assert.equal(tooBig.partSize, UPLOAD_TUNING_LIMITS.MAX_PART_SIZE, "上限由 Workers 的内存余量反推");
});

test("并发度被夹进区间：峰值内存约为 partSize × (queueSize + 1)", () => {
  assert.equal(getEnvironmentOptimizedUploadConfig({ queueSize: 999 }).queueSize, UPLOAD_TUNING_LIMITS.MAX_QUEUE_SIZE);
  assert.equal(getEnvironmentOptimizedUploadConfig({ queueSize: 1 }).queueSize, 1);
});

test("非法值一律当「没给」，回落默认值（不能把 NaN / 负数塞给 lib-storage）", () => {
  for (const bad of [0, -1, NaN, "abc", null, undefined, {}]) {
    const cfg = getEnvironmentOptimizedUploadConfig({ queueSize: bad, partSize: bad });
    assert.equal(cfg.queueSize, 4, `queueSize=${String(bad)} 应回落默认值`);
    assert.equal(cfg.partSize, 8 * MIB, `partSize=${String(bad)} 应回落默认值`);
  }
});

test("数值取整：lib-storage 不接受小数分片", () => {
  const cfg = getEnvironmentOptimizedUploadConfig({ partSize: 6.7 * MIB, queueSize: 2.9 });
  assert.ok(Number.isInteger(cfg.partSize));
  assert.equal(cfg.queueSize, 2);
});
