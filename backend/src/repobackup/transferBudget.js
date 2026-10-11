/**
 * 代码仓库备份 - 单次作业的传输预算（修改点：大仓库备份超 CPU 限制）
 *
 * 为什么需要这一层
 * ----------------
 * 一次备份作业要做的事是 N 个引用 × M 个目标，每个组合都要**完整拉取一遍归档再完整写一遍**
 * （归档流只能消费一次，所以多目标必须重新下载，见 RepoBackupTaskHandler 顶部说明）。
 * 工作量上界由「用户跟踪了几个分支」和「仓库有多大」决定，代码侧没有任何约束。
 *
 * 而在 Cloudflare Workers 下，这一整串动作跑在**同一个** Workflow 步骤里，于是同时受两道限制：
 * - 该次调用的 CPU 累计上限（wrangler.toml 的 [limits] cpu_ms，不配就是 30 秒）
 * - Workflow 步骤的 wall-clock 上限（JobWorkflow 里 execute-task 配的 600 秒）
 *
 * 实测数据（真 workerd，与线上同 compatibility_date / nodejs_compat）：
 * - 354MB 归档走 lib-storage（6MB 分片、并发 1）单趟约 3.5 秒 CPU；
 *   加上传输看门狗与进度统计的逐块开销，上游分片越小越贵，
 *   1KB 分片的极端情况下单趟能爬到 20 秒以上。
 * 也就是说：单趟勉强够，**多引用 / 多目标累计必然超**。
 *
 * 超了会怎样（这是本模块存在的真正理由）
 * -------------------------------------
 * CPU 超限是运行时直接把 isolate 杀掉，JS 侧**捕获不到**：
 * catch 不执行、备份记录停在 running、失败原因写不进去，
 * 管理员只在任务页看到一句 `Worker exceeded CPU time limit.`，
 * 而仓库接下来还会被「上一次备份仍在进行中」挡住。
 * 顺带还会漏掉 S3 分片上传的中止调用，把未完成分片留在桶里持续计费。
 *
 * 所以必须**在撞线之前自己收手**：把已完成的目标落库，剩下的交给下一轮。
 * 主动收手是可捕获的，能留下说明、能安排重试；被杀则什么都留不下。
 *
 * 口径
 * ----
 * - 所有阈值 0 表示「不限制」。Node / Docker 下默认全关：那里没有 CPU 配额，
 *   进程想跑多久跑多久，凭空加限制只会让大仓库备份不成。
 * - 阈值是「开工前检查」，不是硬性中断：单趟传输一旦开始就让它走完，
 *   中途掐断只会留下半个文件。唯一的例外是归档体积上限 ——
 *   它必须能中断，否则一个超大仓库会把整次调用拖死（见 maxArchiveBytes）。
 */

import { isCloudflareWorkerEnvironment } from "../utils/environmentUtils.js";

const MIB = 1024 * 1024;

/**
 * 可用环境变量覆盖的参数（Workers 的 vars / Node 的 process.env 都支持）
 * 例：REPO_BACKUP_JOB_BYTE_BUDGET_MB=512 可把单次作业的传输量压到 512MB，用于验证分轮续传
 */
export const REPO_BACKUP_BUDGET_ENV_KEYS = {
  SOFT_DEADLINE_MS: "REPO_BACKUP_SOFT_DEADLINE_MS",
  JOB_BYTE_BUDGET_MB: "REPO_BACKUP_JOB_BYTE_BUDGET_MB",
  MAX_ARCHIVE_MB: "REPO_BACKUP_MAX_ARCHIVE_MB",
  STALL_TIMEOUT_MS: "REPO_BACKUP_STALL_TIMEOUT_MS",
};

/**
 * Workers 下的默认预算
 *
 * softDeadlineMs 取 7 分钟：JobWorkflow 给 execute-task 的步骤超时是 10 分钟，
 * 留 3 分钟给「收尾」—— 当前这一趟传输可能才传到一半，还要写 manifest、落库、清理旧版本。
 * 留得太少，收手的动作本身会撞上步骤超时，白收手一场。
 *
 * jobByteBudget 与 maxArchive 都取 2GiB：
 * - 2GiB 单趟在实测里远在 CPU 上限之内（配了 cpu_ms = 300000 之后），留足余量；
 * - 比它更大的仓库靠调大 cpu_ms 也救不回来，真正该做的是分轮或者换 Node 部署。
 */
const WORKER_DEFAULTS = {
  softDeadlineMs: 7 * 60 * 1000,
  jobByteBudget: 2 * 1024 * MIB,
  maxArchiveBytes: 2 * 1024 * MIB,
  stallTimeoutMs: 120 * 1000,
};

/**
 * Node / Docker 下的默认预算：时间与流量都不限制
 *
 * 这里没有 CPU 配额也没有步骤超时，唯一需要保留的是传输停滞看门狗 ——
 * 它防的是「连接挂死」，和运行环境的配额无关。
 */
const NODE_DEFAULTS = {
  softDeadlineMs: 0,
  jobByteBudget: 0,
  maxArchiveBytes: 0,
  stallTimeoutMs: 120 * 1000,
};

/**
 * 读取环境变量里的数字
 * - Workers：env 是绑定对象；Node：优先 env，其次 process.env
 * - 空字符串 / 非数字一律当「没配置」，回落到默认值
 * @param {object|null} env
 * @param {string} key
 * @returns {number|null}
 */
function readEnvNumber(env, key) {
  const raw = env?.[key] ?? (typeof process !== "undefined" ? process.env?.[key] : undefined);
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * 取整并夹到区间内
 * - null / undefined 表示「没配置」，回落默认值
 *   （不能只判 Number.isFinite：Number(null) === 0 是有限数，会把默认值吃成 0，
 *   而 0 在本模块里是「不限制」，含义正好相反）
 */
function clampInt(value, min, max, fallback) {
  if (value === null || value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * 解析「可关闭的上限」：显式配 0 表示不限制，其余值夹到 [min, max]
 *
 * 单独抽出来是因为 0 的含义和 clampInt 的夹取逻辑冲突 ——
 * 直接夹到 [min, max] 会把「关闭」变成「按最小值限制」，
 * 那就成了用户想关反而限得最死，是最糟的误解。
 *
 * @param {number|null} value 环境变量读到的值（null = 没配置）
 * @param {number} min 启用时的最小值
 * @param {number} max 启用时的最大值
 * @param {number} fallback 没配置时的默认值
 * @returns {number} 0 表示不限制
 */
function resolveOptionalLimit(value, min, max, fallback) {
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
  if (value <= 0) return 0;
  return clampInt(value, min, max, fallback);
}

/**
 * 解析本次作业的传输预算（备份任务开始时调用一次）
 *
 * @param {object|null} env 运行时环境绑定
 * @returns {{
 *   softDeadlineMs: number,
 *   jobByteBudget: number,
 *   maxArchiveBytes: number,
 *   stallTimeoutMs: number,
 *   environment: string,
 * }}
 */
export function resolveTransferBudget(env = null) {
  const isWorker = isCloudflareWorkerEnvironment();
  const defaults = isWorker ? WORKER_DEFAULTS : NODE_DEFAULTS;

  const rawDeadline = readEnvNumber(env, REPO_BACKUP_BUDGET_ENV_KEYS.SOFT_DEADLINE_MS);
  const rawBudgetMb = readEnvNumber(env, REPO_BACKUP_BUDGET_ENV_KEYS.JOB_BYTE_BUDGET_MB);
  const rawMaxArchiveMb = readEnvNumber(env, REPO_BACKUP_BUDGET_ENV_KEYS.MAX_ARCHIVE_MB);
  const rawStall = readEnvNumber(env, REPO_BACKUP_BUDGET_ENV_KEYS.STALL_TIMEOUT_MS);

  // 截止时间下限 30 秒：比这还短等于一开工就收手，什么都备不成
  const softDeadlineMs = resolveOptionalLimit(rawDeadline, 30 * 1000, 60 * 60 * 1000, defaults.softDeadlineMs);
  // 流量上限下限 16MiB：再小就连一个普通仓库的归档都放不下
  const jobByteBudgetMb = resolveOptionalLimit(
    rawBudgetMb,
    16,
    1024 * 1024,
    Math.trunc(defaults.jobByteBudget / MIB),
  );
  const maxArchiveMb = resolveOptionalLimit(
    rawMaxArchiveMb,
    16,
    1024 * 1024,
    Math.trunc(defaults.maxArchiveBytes / MIB),
  );

  return {
    softDeadlineMs,
    jobByteBudget: jobByteBudgetMb * MIB,
    maxArchiveBytes: maxArchiveMb * MIB,
    // 停滞看门狗不允许关：0 会让「连接挂死」一直挂着，直到步骤超时才被动失败
    stallTimeoutMs: clampInt(rawStall, 5 * 1000, 30 * 60 * 1000, defaults.stallTimeoutMs),
    environment: isWorker ? "Cloudflare Worker" : "Docker/Server",
  };
}

/**
 * 字节数转可读文本（给管理员看的说明里用）
 * - 不依赖 Intl / toLocaleString：Workers 上这类 API 行为不一致
 * @param {number} bytes
 * @returns {string} 例如 "354.2 MB"
 */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.trunc(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * 毫秒转可读文本（"已运行 6.3 分钟" 这类说明里用）
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "0 秒";
  if (n < 60 * 1000) return `${(n / 1000).toFixed(1)} 秒`;
  return `${(n / 60000).toFixed(1)} 分钟`;
}

export default {
  REPO_BACKUP_BUDGET_ENV_KEYS,
  resolveTransferBudget,
  formatBytes,
  formatDuration,
};
