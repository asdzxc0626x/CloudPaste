/**
 * cron-parser 升级回归测试（时区二期 第 1 步）
 *
 * 运行：node --test src/scheduled/cronParserUpgrade.test.js
 *
 * 背景：
 *   cron-parser 5.4.0 在 DST「前拨日」会把一整天的触发吞掉。当 cron 的小时位
 *   正好等于时钟跳到的那个小时时（欧美都是 03 点），该表达式在转换日完全不触发，
 *   相邻两次间隔 47 小时。实测：
 *
 *     柏林 "30 3 * * *"  2026-03-28 03:30 -> 2026-03-30 03:30   （3/29 整天没跑）
 *     纽约 "30 3 * * *"  2026-03-07 03:30 -> 2026-03-09 03:30   （3/8  整天没跑）
 *
 *   而柏林 3/29 的本地 03:30 是真实存在的时刻，本该触发。根因是前拨时被平移上来的
 *   02:30（-> 03:30）把真正的 03:30 槽位挤掉了。
 *
 *   这不只是前端预览的问题，生产主路径同样中招 —— 本文件对两条路径分别验证：
 *     路径 FRESH：每次从 now 重新 parse 只取一次 next（runDueScheduledJobs 的做法）
 *     路径 ITER ：parse 一次连续调 next（computePreviewNextRuns 的做法）
 *
 *   5.10.1 修复了该问题。本文件同时承担两件事：
 *     1. 锁死 DST 修复（P0），防止将来升级把它改回去
 *     2. 锁死「除该修复以外的行为一律未变」（M4 等价性）
 *
 * 本步骤刻意不做的事（留给第 2 步）：
 *   - 不给 cron-parser 传 tz，cron 仍按宿主时区求值（由「现有语义未变」一节锁定）
 *   - 不接入 site_timezone，不改 computeNextSchedule 的时区逻辑
 *
 * 关于宿主时区切换：
 *   用进程内 process.env.TZ 赋值，不用 `TZ=xxx node ...`。
 *   Windows 上 Node 启动时不读 TZ 环境变量，会静默沿用系统时区 ——
 *   那样跑出来的「三个时区」其实是同一个，测试等于没测。
 *   进程内赋值会触发 tzset，三端都生效；下面还会断言切换确实生效。
 *   node:test 对每个测试文件起独立子进程，所以改 TZ 不会污染其他测试文件。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { CronExpressionParser } from "cron-parser";
import { computeNextSchedule } from "./runDueScheduledJobs.js";

// ==================== 工具 ====================

const ORIGINAL_TZ = process.env.TZ;

/**
 * 在指定宿主时区下执行 fn。
 * 切换后立刻校验 Intl 真的变了，变不了就直接失败 —— 否则「三时区覆盖」会变成
 * 悄悄跑三遍同一个时区的假绿。
 */
function withHostTimeZone(zone, fn) {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try {
    const actual = Intl.DateTimeFormat().resolvedOptions().timeZone;
    assert.equal(actual, zone, `宿主时区切换失败：要求 ${zone}，实际 ${actual}（本平台无法进程内切换时区，测试结论不可信）`);
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

/** 某时刻在指定时区的墙上时钟，形如 "2026-03-29 03:30"（与宿主时区无关） */
function wallClock(date, timeZone) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** 路径 ITER：parse 一次，连续取 count 次 next */
function iterSeq(expr, baseIso, count) {
  const it = CronExpressionParser.parse(expr, { currentDate: baseIso });
  const out = [];
  for (let i = 0; i < count; i++) out.push(it.next().toDate().toISOString());
  return out;
}

/** 路径 FRESH：每次以上一次结果为 now 重新 parse，只取一次 next */
function freshSeq(expr, baseIso, count) {
  const out = [];
  let now = baseIso;
  for (let i = 0; i < count; i++) {
    now = CronExpressionParser.parse(expr, { currentDate: now }).next().toDate().toISOString();
    out.push(now);
  }
  return out;
}

/**
 * 枚举某表达式在「某个本地日期」当天的全部触发（墙上时钟字符串）
 * @param {"ITER"|"FRESH"} path 走哪条路径
 */
function firingsOnLocalDate({ expr, timeZone, localDate, fromIso, path, limit = 400 }) {
  const out = [];
  const step = (() => {
    if (path === "ITER") {
      const it = CronExpressionParser.parse(expr, { currentDate: fromIso });
      return () => it.next().toDate();
    }
    let now = fromIso;
    return () => {
      const d = CronExpressionParser.parse(expr, { currentDate: now }).next().toDate();
      now = d.toISOString();
      return d;
    };
  })();

  for (let i = 0; i < limit; i++) {
    const wall = wallClock(step(), timeZone);
    const day = wall.slice(0, 10);
    if (day > localDate) break;
    if (day === localDate) out.push(wall);
  }
  return out;
}

/** 相邻两次触发的最大间隔（小时） */
function maxGapHours(seq) {
  let max = 0;
  for (let i = 1; i < seq.length; i++) {
    max = Math.max(max, (Date.parse(seq[i]) - Date.parse(seq[i - 1])) / 3_600_000);
  }
  return max;
}

// ==================== 0. 前置：平台能否切换宿主时区 ====================

test("前置：本平台可以在进程内切换宿主时区（否则下面的三时区覆盖全是假的）", () => {
  for (const zone of ["UTC", "Asia/Shanghai", "Europe/Berlin", "America/New_York"]) {
    withHostTimeZone(zone, () => {
      assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, zone);
    });
  }
  // 跑完必须还原，避免影响同文件后续用例
  assert.equal(process.env.TZ, ORIGINAL_TZ);
});

test("前置：cron-parser 跟随宿主时区变化（证明它确实没有缓存启动时的时区）", () => {
  const base = "2026-01-15T00:00:00.000Z";
  const utc = withHostTimeZone("UTC", () => iterSeq("30 3 * * *", base, 1)[0]);
  const sh = withHostTimeZone("Asia/Shanghai", () => iterSeq("30 3 * * *", base, 1)[0]);
  const berlin = withHostTimeZone("Europe/Berlin", () => iterSeq("30 3 * * *", base, 1)[0]);

  assert.equal(utc, "2026-01-15T03:30:00.000Z");
  assert.equal(sh, "2026-01-15T19:30:00.000Z");
  assert.equal(berlin, "2026-01-15T02:30:00.000Z");
});

// ==================== 1. P0：DST 前拨日不再漏跑 ====================

/**
 * 前拨日的全部小时位组合。
 * 03 点那两个是 5.4.0 的原始缺陷点（时钟从 02:00 跳到 03:00）；
 * 其余几个用来确认修复没有顺带改坏别的小时。
 */
const SPRING_FORWARD = [
  {
    zone: "Europe/Berlin",
    localDate: "2026-03-29", // 02:00 CET -> 03:00 CEST
    fromIso: "2026-03-27T00:00:00.000Z",
    expected: {
      "0 1 * * *": ["2026-03-29 01:00"],
      "30 1 * * *": ["2026-03-29 01:30"],
      // 02:xx 这一小时在当地不存在，被平移到 03:xx —— 仍然触发，不丢
      "0 2 * * *": ["2026-03-29 03:00"],
      "30 2 * * *": ["2026-03-29 03:30"],
      // 5.4.0 在这两条上返回 []（整天漏跑），5.10.1 修复
      "0 3 * * *": ["2026-03-29 03:00"],
      "30 3 * * *": ["2026-03-29 03:30"],
      "0 4 * * *": ["2026-03-29 04:00"],
    },
  },
  {
    zone: "America/New_York",
    localDate: "2026-03-08", // 02:00 EST -> 03:00 EDT
    fromIso: "2026-03-06T00:00:00.000Z",
    expected: {
      "0 1 * * *": ["2026-03-08 01:00"],
      "30 1 * * *": ["2026-03-08 01:30"],
      "0 2 * * *": ["2026-03-08 03:00"],
      "30 2 * * *": ["2026-03-08 03:30"],
      // 5.4.0 在这两条上返回 []（整天漏跑），5.10.1 修复
      "0 3 * * *": ["2026-03-08 03:00"],
      "30 3 * * *": ["2026-03-08 03:30"],
      "0 4 * * *": ["2026-03-08 04:00"],
    },
  },
];

for (const c of SPRING_FORWARD) {
  for (const path of ["FRESH", "ITER"]) {
    test(`P0 前拨日不漏跑：${c.zone} ${c.localDate}（路径 ${path}）`, () => {
      withHostTimeZone(c.zone, () => {
        for (const [expr, expected] of Object.entries(c.expected)) {
          const actual = firingsOnLocalDate({
            expr,
            timeZone: c.zone,
            localDate: c.localDate,
            fromIso: c.fromIso,
            path,
          });
          assert.deepEqual(actual, expected, `表达式 "${expr}" 在 ${c.localDate} 的触发不符`);
          assert.ok(actual.length > 0, `表达式 "${expr}" 在前拨日完全没有触发（这正是 5.4.0 的缺陷）`);
        }
      });
    });
  }
}

test("P0 前拨日不漏跑：相邻间隔不得出现 47 小时（5.4.0 的特征值）", () => {
  const cases = [
    { zone: "Europe/Berlin", fromIso: "2026-03-27T00:00:00.000Z" },
    { zone: "America/New_York", fromIso: "2026-03-06T00:00:00.000Z" },
  ];
  for (const { zone, fromIso } of cases) {
    withHostTimeZone(zone, () => {
      for (const expr of ["0 3 * * *", "30 3 * * *", "0 2 * * *", "30 2 * * *"]) {
        for (const seq of [iterSeq(expr, fromIso, 6), freshSeq(expr, fromIso, 6)]) {
          const gap = maxGapHours(seq);
          // 前拨日那次间隔是 23h，其余 24h；47h 即说明漏掉了一天
          assert.ok(gap <= 25, `${zone} "${expr}" 最大间隔 ${gap}h 超过 25h，疑似漏跑：${seq.join(" ")}`);
        }
      }
    });
  }
});

/**
 * 升级前后真正发生变化的那 4 条，逐条钉死。
 * 全矩阵共 228 条用例 × 3 个宿主时区，只有这 4 条变了，其余字节级相同。
 */
test("P0 精确回归：升级改变的 4 条用例（柏林 30 3 * * *）", () => {
  withHostTimeZone("Europe/Berlin", () => {
    // 5.4.0: 2026-03-30T01:30Z, ...（直接跳到 3/30，3/29 被吞）
    assert.deepEqual(iterSeq("30 3 * * *", "2026-03-29T00:30:00.000Z", 4), [
      "2026-03-29T01:30:00.000Z", // 当地 2026-03-29 03:30 CEST —— 5.4.0 漏掉的那次
      "2026-03-30T01:30:00.000Z",
      "2026-03-31T01:30:00.000Z",
      "2026-04-01T01:30:00.000Z",
    ]);
    assert.deepEqual(freshSeq("30 3 * * *", "2026-03-29T00:30:00.000Z", 4), [
      "2026-03-29T01:30:00.000Z",
      "2026-03-30T01:30:00.000Z",
      "2026-03-31T01:30:00.000Z",
      "2026-04-01T01:30:00.000Z",
    ]);

    // 5.4.0: ..., 2026-03-28T02:30Z, 2026-03-30T01:30Z, ...（第三项跳到 3/30）
    assert.deepEqual(iterSeq("30 3 * * *", "2026-03-27T00:00:00.000Z", 4), [
      "2026-03-27T02:30:00.000Z",
      "2026-03-28T02:30:00.000Z",
      "2026-03-29T01:30:00.000Z", // 5.4.0 这里是 2026-03-30T01:30:00.000Z
      "2026-03-30T01:30:00.000Z",
    ]);
    assert.deepEqual(freshSeq("30 3 * * *", "2026-03-27T00:00:00.000Z", 4), [
      "2026-03-27T02:30:00.000Z",
      "2026-03-28T02:30:00.000Z",
      "2026-03-29T01:30:00.000Z",
      "2026-03-30T01:30:00.000Z",
    ]);
  });
});

// ==================== 2. DST 回拨 ====================

test("DST 回拨：重复的墙上时钟只触发一次，不会跑两遍", () => {
  const cases = [
    {
      zone: "Europe/Berlin",
      localDate: "2026-10-25", // 03:00 CEST -> 02:00 CET，02:xx 出现两次
      fromIso: "2026-10-23T00:00:00.000Z",
      expected: {
        "30 1 * * *": ["2026-10-25 01:30"],
        "30 2 * * *": ["2026-10-25 02:30"],
        "30 3 * * *": ["2026-10-25 03:30"],
      },
    },
    {
      zone: "America/New_York",
      localDate: "2026-11-01", // 02:00 EDT -> 01:00 EST，01:xx 出现两次
      fromIso: "2026-10-30T00:00:00.000Z",
      expected: {
        "30 1 * * *": ["2026-11-01 01:30"],
        "30 2 * * *": ["2026-11-01 02:30"],
      },
    },
  ];

  for (const c of cases) {
    withHostTimeZone(c.zone, () => {
      for (const [expr, expected] of Object.entries(c.expected)) {
        for (const path of ["FRESH", "ITER"]) {
          const actual = firingsOnLocalDate({
            expr,
            timeZone: c.zone,
            localDate: c.localDate,
            fromIso: c.fromIso,
            path,
          });
          assert.deepEqual(actual, expected, `${c.zone} "${expr}" 回拨日（路径 ${path}）应只触发一次`);
        }
      }
    });
  }
});

test("DST 回拨：回拨日取的是第一次出现（夏令时那次）", () => {
  withHostTimeZone("Europe/Berlin", () => {
    // 柏林 2026-10-25 02:30 对应两个时刻：00:30Z(CEST) 与 01:30Z(CET)
    assert.equal(iterSeq("30 2 * * *", "2026-10-24T12:00:00.000Z", 1)[0], "2026-10-25T00:30:00.000Z");
  });
});

test("DST：每小时任务在回拨日跑 25 次、前拨日跑 23 次", () => {
  withHostTimeZone("Europe/Berlin", () => {
    const fallBack = firingsOnLocalDate({
      expr: "0 * * * *",
      timeZone: "Europe/Berlin",
      localDate: "2026-10-25",
      fromIso: "2026-10-24T00:00:00.000Z",
      path: "ITER",
    });
    assert.equal(fallBack.length, 25, `回拨日应为 25 次，实际 ${fallBack.length}`);
    // 02:00 出现两次正是「同一墙上时钟的两个真实时刻」
    assert.equal(fallBack.filter((w) => w.endsWith("02:00")).length, 2);

    const springForward = firingsOnLocalDate({
      expr: "0 * * * *",
      timeZone: "Europe/Berlin",
      localDate: "2026-03-29",
      fromIso: "2026-03-28T00:00:00.000Z",
      path: "ITER",
    });
    assert.equal(springForward.length, 23, `前拨日应为 23 次，实际 ${springForward.length}`);
    // 02:00 在当地不存在
    assert.equal(springForward.filter((w) => w.endsWith("02:00")).length, 0);
  });
});

test("无 DST 的时区不受影响：UTC / Asia/Shanghai 跨转换日仍是规整 24 小时", () => {
  for (const zone of ["UTC", "Asia/Shanghai"]) {
    withHostTimeZone(zone, () => {
      for (const fromIso of ["2026-03-27T00:00:00.000Z", "2026-10-23T00:00:00.000Z"]) {
        for (const expr of ["0 2 * * *", "30 2 * * *", "0 3 * * *", "30 3 * * *"]) {
          for (const seq of [iterSeq(expr, fromIso, 6), freshSeq(expr, fromIso, 6)]) {
            for (let i = 1; i < seq.length; i++) {
              const gap = (Date.parse(seq[i]) - Date.parse(seq[i - 1])) / 3_600_000;
              assert.equal(gap, 24, `${zone} "${expr}" 相邻间隔应恒为 24h，实际 ${gap}h`);
            }
          }
        }
      }
    });
  }
});

// ==================== 3. M4 等价性：全矩阵指纹 ====================

/**
 * M4 的做法：把一张固定矩阵的全部输出按固定顺序拼成文本取 SHA-256。
 *
 * 为什么用指纹而不是把 228×3 条期望值全写进来：那是 10 万字符量级的数据，
 * 评审时没人会逐行看，反而把真正要读的断言埋没了。真正变化的那 4 条已在上面
 * 逐条钉死，指纹负责「其余 224 条一个字节都没动」这件事。
 *
 * 指纹不符时会把完整矩阵打到 stderr，可以直接 diff 定位是哪一行变了。
 *
 * 重新生成（确认变化是预期的之后）：
 *   node --test src/scheduled/cronParserUpgrade.test.js 2>&1 | grep "实际指纹"
 */
const M4_EXPRS = [
  "* * * * *",
  "*/5 * * * *",
  "0 * * * *",
  "30 3 * * *",
  "0 4 * * 1",
  "0 */6 * * *",
  "15 */4 * * *",
  "0 0 1 * *",
  "5,25,45 * * * *",
  "*/15 9-17 * * 1-5",
  "0 0 29 2 *",
  "59 23 28 2 *",
];

const M4_BASES = [
  "2026-01-15T00:00:00.000Z", // 平常日
  "2026-03-29T00:30:00.000Z", // 欧洲前拨日当天
  "2026-10-25T00:30:00.000Z", // 欧洲回拨日当天
  "2026-12-31T23:59:59.000Z", // 跨年
  "2024-02-28T00:00:00.000Z", // 闰年
  "2026-03-27T00:00:00.000Z", // 欧洲前拨日前两天（迭代跨过转换点）
  "2026-03-07T00:00:00.000Z", // 美国前拨日前一天
  "2026-10-23T00:00:00.000Z", // 欧洲回拨日前两天
  "2026-10-30T00:00:00.000Z", // 美国回拨日前两天
];

/** 指纹对应的矩阵文本（顺序即算法，改动顺序会改变指纹） */
function buildM4Matrix() {
  const lines = [];
  for (const [kind, seqFn] of [
    ["ITER", iterSeq],
    ["FRESH", freshSeq],
  ]) {
    for (const expr of M4_EXPRS) {
      for (const base of M4_BASES) {
        let value;
        try {
          value = seqFn(expr, base, 4).join(",");
        } catch (e) {
          value = `ERR:${e.message}`;
        }
        lines.push(`${kind}\t${expr}\t${base}\t${value}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * 5.10.1 的指纹。
 *
 * 实测对照（同一矩阵、同一算法，分别在装有两个版本的环境下计算）：
 *   UTC            5.4.0 = 2e23caa3…49b72e   5.10.1 = 2e23caa3…49b72e   相同
 *   Asia/Shanghai  5.4.0 = a2c60e3a…d949a2   5.10.1 = a2c60e3a…d949a2   相同
 *   Europe/Berlin  5.4.0 = 80ff93ee…70d3c7   5.10.1 = 6a5267b5…77e51a   不同
 *
 * 即 216×3 = 648 条用例里只有柏林的 4 条变了，就是上面「P0 精确回归」钉死的
 * 那 4 条 DST 漏跑修复，其余 644 条字节级相同。
 */
const M4_FINGERPRINTS = {
  UTC: "2e23caa3ca7c65b5278a75cdd96048a020f4b5e93486471d1a73a4ab3249b72e",
  "Asia/Shanghai": "a2c60e3a3babcafaf778dd86babffa8f600083576c527e7eb855176d50d949a2",
  // 5.4.0 时为 80ff93eecc26185646cf06e2be8c67c3c5332a7dfd918288ba5432417c70d3c7
  "Europe/Berlin": "6a5267b53dc9af1e634a43510a351e8d3e914e7df97c96a98025f58b6077e51a",
};

for (const zone of Object.keys(M4_FINGERPRINTS)) {
  test(`M4 等价性：${zone} 下 ${M4_EXPRS.length * M4_BASES.length * 2} 条用例的指纹未变`, () => {
    withHostTimeZone(zone, () => {
      const matrix = buildM4Matrix();
      const actual = createHash("sha256").update(matrix, "utf8").digest("hex");
      if (actual !== M4_FINGERPRINTS[zone]) {
        console.error(`\n[${zone}] 实际指纹 ${actual}`);
        console.error(`[${zone}] 完整矩阵如下，可与上一版 diff 定位差异：\n${matrix}\n`);
      }
      assert.equal(actual, M4_FINGERPRINTS[zone], `${zone} 的 cron 行为发生了未预期的变化`);
    });
  });
}

// ==================== 4. M4 等价性：关键用例逐条锁定 ====================

/**
 * 指纹之外再挑几条「看得见」的锁定，便于人工核对。
 * 这些值在 5.4.0 与 5.10.1 下完全相同。
 */
test("M4 逐条：30 3 * * * 在三个宿主时区的首次触发", () => {
  const base = "2026-01-15T00:00:00.000Z";
  const expect = {
    UTC: "2026-01-15T03:30:00.000Z",
    "Asia/Shanghai": "2026-01-15T19:30:00.000Z",
    "Europe/Berlin": "2026-01-15T02:30:00.000Z",
  };
  for (const [zone, iso] of Object.entries(expect)) {
    withHostTimeZone(zone, () => {
      assert.equal(iterSeq("30 3 * * *", base, 1)[0], iso);
      assert.equal(freshSeq("30 3 * * *", base, 1)[0], iso);
      // 当地墙上时钟必须就是表达式字面值
      assert.ok(wallClock(new Date(iso), zone).endsWith("03:30"));
    });
  }
});

test("M4 逐条：常用表达式在 UTC 下的序列", () => {
  withHostTimeZone("UTC", () => {
    assert.deepEqual(iterSeq("*/5 * * * *", "2026-01-15T00:00:00.000Z", 3), [
      "2026-01-15T00:05:00.000Z",
      "2026-01-15T00:10:00.000Z",
      "2026-01-15T00:15:00.000Z",
    ]);
    assert.deepEqual(iterSeq("0 4 * * 1", "2026-01-15T00:00:00.000Z", 2), [
      "2026-01-19T04:00:00.000Z",
      "2026-01-26T04:00:00.000Z",
    ]);
    assert.deepEqual(iterSeq("0 */6 * * *", "2026-01-15T00:00:00.000Z", 4), [
      "2026-01-15T06:00:00.000Z",
      "2026-01-15T12:00:00.000Z",
      "2026-01-15T18:00:00.000Z",
      "2026-01-16T00:00:00.000Z",
    ]);
    // 闰日：只在闰年触发
    assert.deepEqual(iterSeq("0 0 29 2 *", "2024-02-28T00:00:00.000Z", 2), [
      "2024-02-29T00:00:00.000Z",
      "2028-02-29T00:00:00.000Z",
    ]);
    // 跨年
    assert.deepEqual(iterSeq("0 * * * *", "2026-12-31T23:59:59.000Z", 2), [
      "2027-01-01T00:00:00.000Z",
      "2027-01-01T01:00:00.000Z",
    ]);
  });
});

/**
 * 重点时区的显式锁定（UTC 与 Asia/Shanghai 是本项目的实际部署时区）。
 *
 * 这两个时区都没有夏令时，所以本次升级对它们「一个字节都没变」——
 * 指纹已经证明（216 条用例逐条相同），这里再用可读的字面值锁一遍，
 * 便于人工核对，也便于将来升级时一眼看出是哪条变了。
 */
test("M4 重点时区：UTC 与 Asia/Shanghai 的真实表达式逐条锁定", () => {
  const base = "2026-01-15T00:00:00.000Z";

  const expected = {
    UTC: {
      // 表达式 -> 连续 3 次触发（UTC ISO）
      "30 3 * * *": ["2026-01-15T03:30:00.000Z", "2026-01-16T03:30:00.000Z", "2026-01-17T03:30:00.000Z"],
      "0 * * * *": ["2026-01-15T01:00:00.000Z", "2026-01-15T02:00:00.000Z", "2026-01-15T03:00:00.000Z"],
      "0 */6 * * *": ["2026-01-15T06:00:00.000Z", "2026-01-15T12:00:00.000Z", "2026-01-15T18:00:00.000Z"],
      "0 4 * * 1": ["2026-01-19T04:00:00.000Z", "2026-01-26T04:00:00.000Z", "2026-02-02T04:00:00.000Z"],
      "0 0 1 * *": ["2026-02-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z"],
      "*/5 * * * *": ["2026-01-15T00:05:00.000Z", "2026-01-15T00:10:00.000Z", "2026-01-15T00:15:00.000Z"],
    },
    "Asia/Shanghai": {
      // 东八区：当地 03:30 = 前一日 19:30Z
      "30 3 * * *": ["2026-01-15T19:30:00.000Z", "2026-01-16T19:30:00.000Z", "2026-01-17T19:30:00.000Z"],
      "0 * * * *": ["2026-01-15T01:00:00.000Z", "2026-01-15T02:00:00.000Z", "2026-01-15T03:00:00.000Z"],
      "0 */6 * * *": ["2026-01-15T04:00:00.000Z", "2026-01-15T10:00:00.000Z", "2026-01-15T16:00:00.000Z"],
      "0 4 * * 1": ["2026-01-18T20:00:00.000Z", "2026-01-25T20:00:00.000Z", "2026-02-01T20:00:00.000Z"],
      "0 0 1 * *": ["2026-01-31T16:00:00.000Z", "2026-02-28T16:00:00.000Z", "2026-03-31T16:00:00.000Z"],
      "*/5 * * * *": ["2026-01-15T00:05:00.000Z", "2026-01-15T00:10:00.000Z", "2026-01-15T00:15:00.000Z"],
    },
  };

  for (const [zone, table] of Object.entries(expected)) {
    withHostTimeZone(zone, () => {
      for (const [expr, seq] of Object.entries(table)) {
        assert.deepEqual(iterSeq(expr, base, 3), seq, `${zone} "${expr}"（路径 ITER）`);
        assert.deepEqual(freshSeq(expr, base, 3), seq, `${zone} "${expr}"（路径 FRESH）`);
      }
    });
  }
});

test("M4 重点时区：UTC 与 Asia/Shanghai 全年无 DST，任何日期都是规整周期", () => {
  // 覆盖欧美四个 DST 转换日前后，证明这两个时区在那些日子里也毫无特殊性
  const dstDates = [
    "2026-03-07T00:00:00.000Z",
    "2026-03-27T00:00:00.000Z",
    "2026-10-23T00:00:00.000Z",
    "2026-10-30T00:00:00.000Z",
  ];
  for (const zone of ["UTC", "Asia/Shanghai"]) {
    withHostTimeZone(zone, () => {
      for (const base of dstDates) {
        // 日级任务恒 24h
        for (const expr of ["0 3 * * *", "30 3 * * *", "0 0 * * *"]) {
          const seq = iterSeq(expr, base, 8);
          for (let i = 1; i < seq.length; i++) {
            const gap = (Date.parse(seq[i]) - Date.parse(seq[i - 1])) / 3_600_000;
            assert.equal(gap, 24, `${zone} "${expr}" @${base} 第 ${i} 个间隔应为 24h，实际 ${gap}h`);
          }
        }
        // 小时任务恒 60min，且每天恰好 24 次
        const hourly = iterSeq("0 * * * *", base, 48);
        for (let i = 1; i < hourly.length; i++) {
          const gapMin = (Date.parse(hourly[i]) - Date.parse(hourly[i - 1])) / 60_000;
          assert.equal(gapMin, 60, `${zone} "0 * * * *" @${base} 间隔应为 60min，实际 ${gapMin}min`);
        }
      }
    });
  }
});

test("M4 逐条：prev() 行为未变", () => {  withHostTimeZone("UTC", () => {
    const it = CronExpressionParser.parse("30 3 * * *", { currentDate: "2026-06-15T12:00:00.000Z" });
    assert.deepEqual(
      [it.prev().toDate().toISOString(), it.prev().toDate().toISOString()],
      ["2026-06-15T03:30:00.000Z", "2026-06-14T03:30:00.000Z"],
    );
  });
});

test("M4 逐条：非法表达式的接受/拒绝未变（createScheduledJob 依赖抛错做校验）", () => {
  // 实测值，5.4.0 与 5.10.1 完全一致
  const cases = {
    // 空串被解析成 "* * * * *"（每分钟）而不是报错 —— 见下方单独的守卫断言
    "": "ACCEPTED",
    "   ": "REJECTED",
    abc: "REJECTED",
    "60 * * * *": "REJECTED",
    "* * * * * * * *": "REJECTED",
    "0 25 * * *": "REJECTED",
    "0 0 32 * *": "REJECTED",
    "0 0 * 13 *": "REJECTED",
    "30 3 * *": "REJECTED",
  };
  for (const [expr, expected] of Object.entries(cases)) {
    let verdict;
    try {
      CronExpressionParser.parse(expr);
      verdict = "ACCEPTED";
    } catch {
      verdict = "REJECTED";
    }
    assert.equal(verdict, expected, `表达式 ${JSON.stringify(expr)} 的校验结论变了`);
  }
});

/**
 * 空表达式是解析器的一个坑：parse("") 不抛错，而是等价于 "* * * * *"（每分钟）。
 * 生产侧没有因此出问题，是因为 scheduledJobService 在调 parse 之前就挡掉了空值
 * （createScheduledJob / updateScheduledJob 都有 `!cronExpression` 的前置校验）。
 * 这里把「解析器会接受」和「上层必须自己挡」两件事同时钉住：
 * 哪天有人把前置校验删了，这条会提醒他后果是任务变成每分钟跑。
 */
test("M4 逐条：空 cron 表达式等价于每分钟，上层必须自己挡（守卫仍在）", () => {
  withHostTimeZone("UTC", () => {
    assert.equal(CronExpressionParser.parse("").stringify(), "* * * * *");
  });

  // computeNextSchedule 侧：空表达式走的是「非字符串/空」分支，直接禁用，不会变成每分钟
  const out = computeNextSchedule(
    { task_id: "t", schedule_type: "cron", cron_expression: "", enabled: 1, run_count: 0 },
    { status: "success", nowIso: "2026-01-15T00:00:00.000Z" },
  );
  assert.equal(out.nextRunAfter, null);
  assert.equal(out.enabled, 0);
});

// ==================== 5. 现有语义未变：本步骤不接 tz ====================

/**
 * 第 1 步的边界：只升级库，不改时区语义。
 * 这里用真实的 computeNextSchedule 断言「cron 仍按宿主时区求值」——
 * 等第 2 步接入 site_timezone 时，这一节必须被显式改掉，
 * 不会出现「悄悄改了语义但测试还绿」的情况。
 */
test("语义边界：computeNextSchedule 的 cron 仍按宿主时区求值（第 2 步才会改）", () => {
  const row = {
    task_id: "t_cron",
    schedule_type: "cron",
    cron_expression: "30 3 * * *",
    enabled: 1,
    run_count: 0,
  };
  const nowIso = "2026-01-15T00:00:00.000Z";

  const utc = withHostTimeZone("UTC", () => computeNextSchedule(row, { status: "success", nowIso }));
  const sh = withHostTimeZone("Asia/Shanghai", () => computeNextSchedule(row, { status: "success", nowIso }));
  const berlin = withHostTimeZone("Europe/Berlin", () => computeNextSchedule(row, { status: "success", nowIso }));

  assert.equal(utc.nextRunAfter, "2026-01-15T03:30:00.000Z");
  assert.equal(sh.nextRunAfter, "2026-01-15T19:30:00.000Z");
  assert.equal(berlin.nextRunAfter, "2026-01-15T02:30:00.000Z");

  // 三者都应保持启用并计一次执行次数
  for (const out of [utc, sh, berlin]) {
    assert.equal(out.enabled, 1);
    assert.equal(out.runCountDelta, 1);
  }
});

test("语义边界：cron 任务经过前拨日后不再被禁用，且拿到正确的下次时间", () => {
  const row = {
    task_id: "t_cron_dst",
    schedule_type: "cron",
    cron_expression: "30 3 * * *",
    enabled: 1,
    run_count: 0,
  };
  withHostTimeZone("Europe/Berlin", () => {
    // 上一次执行是 3/28 当地 03:30，5.4.0 这里会算出 3/30（跳过 3/29）
    const out = computeNextSchedule(row, { status: "success", nowIso: "2026-03-28T02:30:00.000Z" });
    assert.equal(out.nextRunAfter, "2026-03-29T01:30:00.000Z");
    assert.equal(wallClock(new Date(out.nextRunAfter), "Europe/Berlin"), "2026-03-29 03:30");
    assert.equal(out.enabled, 1);
  });
});

// ==================== 6. interval 调度回归 ====================

test("interval 回归：与宿主时区完全无关", () => {
  const row = {
    task_id: "t_interval",
    schedule_type: "interval",
    interval_sec: 6 * 60 * 60,
    enabled: 1,
    run_count: 0,
  };
  const nowIso = "2026-01-15T00:00:00.000Z";

  const deltas = [];
  for (const zone of ["UTC", "Asia/Shanghai", "Europe/Berlin", "America/New_York"]) {
    withHostTimeZone(zone, () => {
      const out = computeNextSchedule(row, { status: "success", nowIso });
      // interval 用的是 Date.now()，不是 nowIso，所以只能校验「距当前约 6 小时」
      const delta = Date.parse(out.nextRunAfter) - Date.now();
      assert.ok(
        Math.abs(delta - row.interval_sec * 1000) < 5000,
        `${zone}: 下次执行应在约 ${row.interval_sec}s 后，实际 ${Math.round(delta / 1000)}s`,
      );
      // 必须是 UTC ISO 串（next_run_after 列的格式约定，字典序=时间序）
      assert.match(out.nextRunAfter, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.equal(out.enabled, 1);
      deltas.push(Math.round(delta / 1000));
    });
  }
  // 四个时区算出的间隔必须一致（允许执行耗时造成的 1 秒抖动）
  assert.ok(Math.max(...deltas) - Math.min(...deltas) <= 1, `各时区间隔不一致: ${deltas.join(",")}`);
});

test("interval 回归：异常与边界分支未变", () => {
  const nowIso = "2026-01-15T00:00:00.000Z";

  // interval_sec <= 0 -> 禁用任务，避免死循环
  const broken = computeNextSchedule(
    { task_id: "t", schedule_type: "interval", interval_sec: 0, enabled: 1, run_count: 0 },
    { status: "success", nowIso },
  );
  assert.equal(broken.nextRunAfter, null);
  assert.equal(broken.enabled, 0);

  // 已禁用的任务：保持现状，不推进
  const disabled = computeNextSchedule(
    {
      task_id: "t",
      schedule_type: "interval",
      interval_sec: 3600,
      enabled: 0,
      run_count: 0,
      next_run_after: "2026-02-01T00:00:00.000Z",
    },
    { status: "success", nowIso },
  );
  assert.equal(disabled.nextRunAfter, "2026-02-01T00:00:00.000Z");
  assert.equal(disabled.enabled, 0);
  assert.equal(disabled.runCountDelta, 0);

  // handler 给出的延迟重试覆盖正常周期（第 2 期的延迟重试语义）
  const overridden = computeNextSchedule(
    { task_id: "t", schedule_type: "interval", interval_sec: 3600, enabled: 1, run_count: 0 },
    { status: "success", nowIso, nextRunAfterOverride: "2026-01-15T00:20:00.000Z" },
  );
  assert.equal(overridden.nextRunAfter, "2026-01-15T00:20:00.000Z");

  // 非法 cron 表达式 -> 禁用（这条在升级前后都应如此）
  const badCron = computeNextSchedule(
    { task_id: "t", schedule_type: "cron", cron_expression: "not a cron", enabled: 1, run_count: 0 },
    { status: "success", nowIso },
  );
  assert.equal(badCron.nextRunAfter, null);
  assert.equal(badCron.enabled, 0);

  // 未知调度类型 -> 禁用
  const unknown = computeNextSchedule(
    { task_id: "t", schedule_type: "weekly-ish", enabled: 1, run_count: 0 },
    { status: "success", nowIso },
  );
  assert.equal(unknown.nextRunAfter, null);
  assert.equal(unknown.enabled, 0);
});
