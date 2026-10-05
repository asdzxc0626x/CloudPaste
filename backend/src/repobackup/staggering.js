/**
 * 代码仓库备份 - 错峰调度工具（修改点：第 5 期 错峰调度）
 *
 * 为什么单独放一个「零依赖」的模块：
 *   DB 迁移（db/migrations/sqlite/engine/migrations.js）需要用它来重新分散存量
 *   备份计划的执行时间，而 migrations 属于最底层，不应该反向 import
 *   服务层（scheduledJobService 依赖 cron-parser、仓储层等）。
 *   把纯计算逻辑放在这里，迁移与业务两侧共用同一份实现，不会出现
 *   「迁移算一套、运行期算另一套」的漂移。
 *
 * 错峰要解决的问题：
 *   调度层原先在「创建 / 更新 / 每轮推进」三处都写 `now + intervalSec`，
 *   于是所有默认 6 小时间隔的仓库会在**同一个 tick** 一起到期，
 *   同一瞬间向 GitHub 发起请求形成洪峰。
 *   检测层的 ±15% 抖动只作用于 next_detect_after（引用级），
 *   管不到「哪些仓库会在同一 tick 被派发」，所以必须在调度层也做分散。
 */

/**
 * 备份计划「首次执行时间」的分散比例（修改点：第 5 期 错峰调度）
 *
 * 语义：interval 模式下，创建或重置计划时首次执行时间取
 *   now + intervalSec × (1 - ratio + ratio × random())
 * 即落在 **[50%, 100%] × 间隔** 内均匀分布。
 *
 * 为什么不是 [0, 间隔]：下限保留半个间隔，避免「刚添加的仓库立刻就被备份一次」
 * 这种反直觉行为；上限仍是原来的一个完整间隔，所以任何仓库的首次备份
 * 都不会比改动前更晚。
 *
 * 为什么周期性推进不需要再抖动：下一轮 = 本轮实际运行时刻 + 间隔，
 * 而各仓库的实际运行时刻已经被打散，因此分散性自然保持。
 */
export const REPO_BACKUP_SCHEDULE_JITTER_RATIO = 0.5;

/**
 * 单个调度 tick 最多派发多少个仓库备份作业（修改点：第 5 期 错峰调度）
 *
 * 抖动解决「长期对齐」，本配额解决「瞬时批量」：即使用户一次性创建了大量仓库，
 * 或者迁移刚跑完，也不会在一个 tick 里把成百上千个检测作业同时塞进编排器。
 *
 * 取值 5 的理由：
 *   - Node 侧 tick 为 1 分钟、Workers 侧为 5 分钟，两端「单轮派发上限」一致，
 *     差异只在吞吐（Node 排空更快），这正是我们想要的：挡的是单次洪峰大小。
 *   - 未派发到的行**保持到期状态**（不更新 next_run_after），下一轮按
 *     next_run_after 升序优先取到，因此只会延后、不会饿死。
 */
export const REPO_BACKUP_MAX_DISPATCH_PER_TICK = 5;

/**
 * 计算 interval 模式下「首次 / 重置后」的执行时间
 *
 * @param {number} intervalSec 计划间隔（秒）
 * @param {{ nowMs?: number, random?: () => number }} [options]
 *        random 可注入，便于测试得到确定性结果（生产用 Math.random）
 * @returns {string|null} ISO 字符串；intervalSec 非法时返回 null
 */
export function planFirstRunAtIso(intervalSec, options = {}) {
  const seconds = Number(intervalSec);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const random = typeof options.random === "function" ? options.random : Math.random;

  const ratio = Math.max(0, Math.min(1, Number(REPO_BACKUP_SCHEDULE_JITTER_RATIO) || 0));

  // random() 的返回值收敛到 [0,1]，异常值按区间中点处理，绝不让 next_run_after 跑到区间外
  const raw = Number(random());
  const unit = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.5;

  const factor = 1 - ratio + ratio * unit;
  return new Date(nowMs + seconds * 1000 * factor).toISOString();
}

/**
 * 把「首次执行时间分散比例」换算成与间隔相乘的系数
 *
 * 供 scheduledJobService 的创建 / 更新两条路径共用：ratio <= 0（默认）时恒为 1，
 * 完全保持改动前的行为，因此其他调度作业（清理会话、用量快照、同步复制等）
 * 一个字节的行为都不会变。
 *
 * @param {number} jitterRatio
 * @param {() => number} [random]
 * @returns {number} [1 - ratio, 1] 区间内的系数
 */
export function resolveFirstRunFactor(jitterRatio, random = Math.random) {
  const ratio = Number(jitterRatio);
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  const clamped = Math.min(1, ratio);

  const raw = Number(random());
  const unit = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.5;

  return 1 - clamped + clamped * unit;
}

export default {
  REPO_BACKUP_SCHEDULE_JITTER_RATIO,
  REPO_BACKUP_MAX_DISPATCH_PER_TICK,
  planFirstRunAtIso,
  resolveFirstRunFactor,
};
