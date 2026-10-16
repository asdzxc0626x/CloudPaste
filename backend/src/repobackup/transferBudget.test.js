/**
 * 回归验证：单次备份作业的传输预算与护栏（修改点：大仓库备份超 CPU 限制）
 *
 * 运行：node --test src/repobackup/transferBudget.test.js
 *       （本文件 import 了 .ts 的护栏，整仓统一用 `npm test`（tsx --test）跑）
 *
 * 这一组用例盯的是「大仓库把整次调用搞死」这一类问题。它的现场很特殊：
 * Cloudflare Workers 的 CPU 超限是运行时直接杀掉 isolate，JS 捕获不到 ——
 * 备份任务里所有 catch、updateBackup({status:'failed'}) 一个都不会执行，
 * 于是记录停在 running、失败原因写不进去，管理员只在任务页看到一句
 * `Worker exceeded CPU time limit.`。
 *
 * 所以这里要守住两件事：
 *  1. 预算口径必须正确 —— 算错会要么形同虚设（照旧被杀），
 *     要么过于保守（小仓库也被推迟，永远备不完）；
 *  2. 「主动收手」必须被归成可延迟重试而不是失败 —— 这是它与真故障的根本区别。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveTransferBudget,
  estimateTransferMs,
  fitsBeforeDeadline,
  formatBytes,
  formatDuration,
  REPO_BACKUP_BUDGET_ENV_KEYS,
} from "./transferBudget.js";
import {
  BudgetExhaustedError,
  ArchiveTooLargeError,
  TransientError,
  classifyRepoBackupError,
  planRetryForError,
  describeErrorKind,
  isDeferrableKind,
  REPO_ERROR_KIND,
  RETRY_DELAY_MS,
} from "./errors.js";
import { createTransferGuard } from "../storage/fs/tasks/handlers/RepoBackupTaskHandler.ts";

const MIB = 1024 * 1024;

/**
 * 伪装成 Workers 环境
 * isCloudflareWorkerEnvironment 的判据之一是全局有 caches（Node 没有），
 * 这里临时塞一个，跑完立刻还原，避免污染同进程里的其它用例
 */
function withWorkerEnv(fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "caches");
  const prev = globalThis.caches;
  globalThis.caches = { default: {} };
  try {
    return fn();
  } finally {
    if (had) globalThis.caches = prev;
    else delete globalThis.caches;
  }
}

/** 产出 totalBytes 字节的合成流，按 chunkSize 分片（模拟 codeload 的 chunked 响应） */
function makeSource(totalBytes, chunkSize) {
  let sent = 0;
  return new ReadableStream({
    pull(c) {
      if (sent >= totalBytes) {
        c.close();
        return;
      }
      const n = Math.min(chunkSize, totalBytes - sent);
      sent += n;
      c.enqueue(new Uint8Array(n));
    },
  });
}

async function drain(stream) {
  const reader = stream.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength ?? value.length ?? 0;
  }
  return total;
}

// ==================== 预算口径 ====================

test("Node/Docker 默认不限时间与流量（那里没有 CPU 配额，限制只会让大仓库备份不成）", () => {
  const budget = resolveTransferBudget({});
  assert.equal(budget.environment, "Docker/Server");
  assert.equal(budget.softDeadlineMs, 0);
  assert.equal(budget.jobByteBudget, 0);
  assert.equal(budget.maxArchiveBytes, 0);
  // 停滞看门狗与运行环境无关：它防的是「连接挂死」，必须一直在
  assert.equal(budget.stallTimeoutMs, 120 * 1000);
});

test("Workers 默认给出软截止与流量上限，且软截止必须短于 Workflows 步骤超时（600s）", () => {
  const budget = withWorkerEnv(() => resolveTransferBudget({}));
  assert.equal(budget.environment, "Cloudflare Worker");
  assert.ok(budget.softDeadlineMs > 0, "Workers 下必须有软截止，否则会被运行时直接杀掉");
  assert.ok(
    budget.softDeadlineMs < 600 * 1000,
    "软截止必须留出收尾余量：撞上步骤超时的话，收手这个动作本身都做不完",
  );
  assert.equal(budget.jobByteBudget, 2048 * MIB);
  assert.equal(budget.maxArchiveBytes, 2048 * MIB);
});

test("环境变量可覆盖；显式 0 表示关闭，不会被夹成「按最小值限制」", () => {
  const budget = resolveTransferBudget({
    [REPO_BACKUP_BUDGET_ENV_KEYS.SOFT_DEADLINE_MS]: "0",
    [REPO_BACKUP_BUDGET_ENV_KEYS.JOB_BYTE_BUDGET_MB]: "512",
    [REPO_BACKUP_BUDGET_ENV_KEYS.MAX_ARCHIVE_MB]: "0",
    [REPO_BACKUP_BUDGET_ENV_KEYS.STALL_TIMEOUT_MS]: "30000",
  });
  assert.equal(budget.softDeadlineMs, 0, "0 必须是「不限制」，夹到下限等于用户想关反而限得最死");
  assert.equal(budget.jobByteBudget, 512 * MIB);
  assert.equal(budget.maxArchiveBytes, 0);
  assert.equal(budget.stallTimeoutMs, 30 * 1000);
});

test("空串/非数字一律当「没配置」，回落默认值（Number(null)===0 这个坑不能踩）", () => {
  const budget = withWorkerEnv(() =>
    resolveTransferBudget({
      [REPO_BACKUP_BUDGET_ENV_KEYS.SOFT_DEADLINE_MS]: "",
      [REPO_BACKUP_BUDGET_ENV_KEYS.JOB_BYTE_BUDGET_MB]: "abc",
      [REPO_BACKUP_BUDGET_ENV_KEYS.MAX_ARCHIVE_MB]: null,
    }),
  );
  assert.ok(budget.softDeadlineMs > 0);
  assert.equal(budget.jobByteBudget, 2048 * MIB);
  assert.equal(budget.maxArchiveBytes, 2048 * MIB);
});

test("停滞看门狗不允许关：配 0 也会回到有效区间", () => {
  const budget = resolveTransferBudget({ [REPO_BACKUP_BUDGET_ENV_KEYS.STALL_TIMEOUT_MS]: "0" });
  assert.ok(budget.stallTimeoutMs >= 5 * 1000, "关掉它等于让挂死的连接一直挂着");
});

// ==================== 分片上传并发度（修改点：大仓库备份 CPU/耗时优化）====================

test("Workers 下把上传并发提到 2：queueSize=1 会让下载与上传完全串行", () => {
  const budget = withWorkerEnv(() => resolveTransferBudget({}));
  assert.equal(budget.uploadQueueSize, 2);
});

test("Node 下不覆盖上传并发（那里驱动默认就是 4，没有串行问题）", () => {
  assert.equal(resolveTransferBudget({}).uploadQueueSize, 0);
});

test("上传并发可被环境变量覆盖，且夹在内存吃得住的区间内", () => {
  const raise = withWorkerEnv(() =>
    resolveTransferBudget({ [REPO_BACKUP_BUDGET_ENV_KEYS.UPLOAD_QUEUE_SIZE]: "99" }),
  );
  assert.equal(raise.uploadQueueSize, 4, "并发越高峰值内存越大，必须夹住");

  const off = withWorkerEnv(() =>
    resolveTransferBudget({ [REPO_BACKUP_BUDGET_ENV_KEYS.UPLOAD_QUEUE_SIZE]: "0" }),
  );
  assert.equal(off.uploadQueueSize, 0, "显式 0 = 回到驱动默认值，用于一键退回改动前行为");
});

// ==================== 「这一趟还跑得完吗」 ====================

test("没有实测样本时估不出耗时（返回 0，调用方据此放行）", () => {
  assert.equal(estimateTransferMs(354 * MIB, 0), 0, "还没跑过一趟，无从估算");
  assert.equal(estimateTransferMs(0, 1024), 0, "不知道要搬多大，同样无从估算");
});

test("按实测吞吐估算耗时", () => {
  // 10 MB/s = 10485.76 字节/毫秒；354MB 约 35.4 秒
  const ms = estimateTransferMs(354 * MIB, 10 * 1024);
  assert.ok(ms > 34 * 1000 && ms < 37 * 1000, `估算 ${ms}ms 不在预期区间`);
});

test("估不出来或没有截止时一律放行 —— 这是前进保证，否则大仓库永远备不上", () => {
  // 本次运行的第一趟必然落在这个分支（还没有任何样本）
  assert.equal(fitsBeforeDeadline({ estimateMs: 0, nowMs: 1000, deadlineAtMs: 1200 }).fits, true);
  // Node 口径：没有软截止
  assert.equal(fitsBeforeDeadline({ estimateMs: 9e9, nowMs: 1000, deadlineAtMs: 0 }).fits, true);
});

test("剩余时间够就放行，不够就拦住（并带上余量系数）", () => {
  const now = 0;
  const deadline = 60 * 1000;

  // 估 30s，余量 1.3 → 需要 39s，剩 60s：放行
  const ok = fitsBeforeDeadline({ estimateMs: 30 * 1000, nowMs: now, deadlineAtMs: deadline });
  assert.equal(ok.fits, true);
  assert.equal(ok.requiredMs, 39 * 1000);

  // 估 50s → 需要 65s > 剩 60s：拦住。
  // 这正是修复前会"放进去然后撞步骤超时"的那一类
  const tight = fitsBeforeDeadline({ estimateMs: 50 * 1000, nowMs: now, deadlineAtMs: deadline });
  assert.equal(tight.fits, false);
  assert.equal(tight.remainingMs, 60 * 1000);
});

test("软截止已经过去时必然拦住（remainingMs 为负）", () => {
  const past = fitsBeforeDeadline({ estimateMs: 1000, nowMs: 5000, deadlineAtMs: 4000 });
  assert.equal(past.fits, false);
  assert.ok(past.remainingMs < 0);
});

// ==================== 错误分类：收手 ≠ 失败 ====================

test("预算用尽属于「可延迟重试」，不是失败", () => {
  const info = classifyRepoBackupError(new BudgetExhaustedError("本次运行已传输 2.0 GB"));
  assert.equal(info.kind, REPO_ERROR_KIND.BUDGET_EXHAUSTED);
  assert.ok(isDeferrableKind(info.kind));

  const plan = planRetryForError(new BudgetExhaustedError("额度用尽"));
  assert.equal(plan.deferrable, true);
  assert.ok(plan.retryAtMs > Date.now(), "必须给出将来的重试时间，否则调度层无从安排");
  assert.ok(
    plan.delayMs >= RETRY_DELAY_MS.BUDGET_MIN && plan.delayMs <= RETRY_DELAY_MS.BUDGET_MAX,
    `退避 ${plan.delayMs}ms 超出预期区间`,
  );
  // 这句话会出现在任务摘要里，不能有「失败」字样
  assert.ok(!describeErrorKind(info.kind).includes("失败"));
});

test("原型丢失（跨层传递后只剩 code）时仍能认出预算用尽", () => {
  const raw = new BudgetExhaustedError("额度用尽");
  const degraded = { message: raw.message, code: raw.code };
  assert.equal(classifyRepoBackupError(degraded).kind, REPO_ERROR_KIND.BUDGET_EXHAUSTED);
});

test("归档体积超限是永久性错误：重试只会每轮再白拉一遍几 GB", () => {
  const plan = planRetryForError(new ArchiveTooLargeError("归档体积超过单次备份上限 2.0 GB"));
  assert.equal(plan.kind, REPO_ERROR_KIND.PERMANENT);
  assert.equal(plan.deferrable, false);
  assert.equal(plan.retryAtMs, null);
});

test("传输停滞是暂时性错误（修复前抛普通 Error，被判成永久失败，与设计说明相反）", () => {
  const plan = planRetryForError(new TransientError("传输停滞超过 120 秒已中止"));
  assert.equal(plan.kind, REPO_ERROR_KIND.TRANSIENT);
  assert.equal(plan.deferrable, true);
});

// ==================== 传输护栏 ====================

test("护栏如实计数，并原样透传每个分片（不能改动归档内容）", async () => {
  const guard = createTransferGuard({ stallTimeoutMs: 60 * 1000 });
  const passed = await drain(guard.wrap(makeSource(5 * MIB, 64 * 1024)));
  guard.dispose();

  assert.equal(passed, 5 * MIB, "下游收到的字节数必须与源一致");
  assert.equal(guard.counter.value, 5 * MIB);
  assert.equal(guard.isOversize(), false);
  assert.equal(guard.isStalled(), false);
});

test("超过体积上限时当场掐断：流报错、请求被 abort、原因可判别", async () => {
  const maxBytes = 2 * MIB;
  const guard = createTransferGuard({ stallTimeoutMs: 60 * 1000, maxBytes });

  await assert.rejects(
    () => drain(guard.wrap(makeSource(8 * MIB, 256 * 1024))),
    /归档体积超过上限/,
    "掐断必须以错误结束，否则上层会把半个归档当成写完了",
  );

  assert.equal(guard.isOversize(), true, "上层要靠这个标志把底层的 abort 换成真实原因");
  assert.equal(guard.signal.aborted, true, "必须 abort 掉上游响应，不然连接还在吐数据");
  assert.ok(guard.counter.value > maxBytes, "是「超过之后」才掐断，计数应已越过上限");
  guard.dispose();
});

test("maxBytes=0 表示不限制（Node 默认口径），再大的归档也照常透传", async () => {
  const guard = createTransferGuard({ stallTimeoutMs: 60 * 1000, maxBytes: 0 });
  const passed = await drain(guard.wrap(makeSource(6 * MIB, 128 * 1024)));
  guard.dispose();
  assert.equal(passed, 6 * MIB);
  assert.equal(guard.isOversize(), false);
});

test("停滞超时会 abort：源停止吐数据后，巡检定时器判定停滞", async () => {
  // 阈值取 300ms，巡检周期为 max(1s, 阈值/4) = 1s，因此约 1s 后判定
  const guard = createTransferGuard({ stallTimeoutMs: 300 });
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(1024));
      // 之后永不再 enqueue，也不 close —— 模拟「连接不断开但不再吐数据」
    },
  });
  const wrapped = guard.wrap(stream);
  const reader = wrapped.getReader();
  await reader.read();

  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal(guard.isStalled(), true, "挂死的连接必须被判定为停滞");
  assert.equal(guard.signal.aborted, true);
  assert.equal(guard.isOversize(), false, "停滞与体积超限是两种原因，不能混为一谈");
  guard.dispose();
  reader.releaseLock?.();
});

test("进度回调按节流上报，且回调抛错不影响传输", async () => {
  let calls = 0;
  const guard = createTransferGuard({
    stallTimeoutMs: 60 * 1000,
    onProgress: () => {
      calls += 1;
      throw new Error("上报失败也不能把备份带下来");
    },
  });
  // 单片 16MB，超过 PROGRESS_FLUSH_BYTES（8MB）必然触发一次上报
  const passed = await drain(guard.wrap(makeSource(32 * MIB, 16 * MIB)));
  guard.dispose();

  assert.equal(passed, 32 * MIB);
  assert.ok(calls > 0, "大流量下必须有进度上报，否则前端分不清「在传」和「卡死」");
});

// ==================== 护栏：S3 SDK 进度事件路径（阶段 3） ====================

test("observe() 按累计字节喂护栏：体积上限必须在没有 wrap() 的情况下照常生效", () => {
  const maxBytes = 10 * MIB;
  const guard = createTransferGuard({ stallTimeoutMs: 60 * 1000, maxBytes });

  // S3 路径上根本不调 wrap()，counter 完全由 SDK 进度事件驱动
  guard.observe(8 * MIB);
  assert.equal(guard.isOversize(), false, "未越界前不能掐断");
  assert.equal(guard.signal.aborted, false);

  guard.observe(12 * MIB);
  assert.equal(guard.isOversize(), true, "越过上限必须当场掐断，否则护栏在 S3 上是摆设");
  assert.equal(guard.signal.aborted, true, "必须 abort 掉上游响应，不然连接还在吐数据");

  guard.dispose();
});

test("observe() 对乱序/重复/倒退的事件做单调保护（不能漏掉体积上限判定）", () => {
  const maxBytes = 10 * MIB;
  const guard = createTransferGuard({ stallTimeoutMs: 60 * 1000, maxBytes });

  guard.observe(6 * MIB);
  // 多分片并发下事件可能乱序；倒退的旧值绝不能把计数写小
  guard.observe(4 * MIB);
  assert.equal(guard.counter.value, 6 * MIB, "倒退的事件必须被忽略");

  // 重复上报同一个值也不应重复累加
  guard.observe(6 * MIB);
  assert.equal(guard.counter.value, 6 * MIB);

  guard.observe(11 * MIB);
  assert.equal(guard.isOversize(), true, "乱序之后上限判定仍必须触发");

  guard.dispose();
});

test("observe() 刷新停滞时间戳：有进度就不能判停滞，dispose 后不再接受进度", async () => {
  const guard = createTransferGuard({ stallTimeoutMs: 300 });
  // arm() 必须显式调用：S3 分支不经过 wrap()，wrap() 里的自动 arm() 不会执行
  guard.arm();

  // 持续有进度，越过一个巡检周期也不该判停滞
  const tick = setInterval(() => guard.observe(guard.counter.value + 1024), 200);
  await new Promise((resolve) => setTimeout(resolve, 1600));
  clearInterval(tick);

  assert.equal(guard.isStalled(), false, "有进度却被判停滞，等于把正常传输误杀");
  assert.equal(guard.isOversize(), false);

  guard.dispose();
  const frozen = guard.counter.value;
  guard.observe(frozen + 999);
  assert.equal(guard.counter.value, frozen, "dispose 之后不应再接受进度上报");
});

test("observe() 非法字节数不得污染计数（NaN/负数/null 都来不得）", () => {
  const guard = createTransferGuard({ stallTimeoutMs: 60 * 1000, maxBytes: 10 * MIB });
  guard.observe(4 * MIB);

  guard.observe(NaN);
  guard.observe(-1);
  guard.observe(null);
  guard.observe(undefined);
  guard.observe("8");

  assert.equal(guard.counter.value, 4 * MIB, "非法值必须被丢弃，否则上限判定会失效");
  assert.equal(guard.isOversize(), false);
  guard.dispose();
});

// ==================== 文本格式 ====================

test("字节/时长文案可读（它们会直接出现在管理员看到的原因里）", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(354 * MIB), "354.0 MB");
  assert.equal(formatBytes(2048 * MIB), "2.0 GB");

  assert.equal(formatDuration(0), "0 秒");
  assert.equal(formatDuration(1500), "1.5 秒");
  assert.equal(formatDuration(7 * 60 * 1000), "7.0 分钟");
});
