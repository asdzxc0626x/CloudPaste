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
 * - 该次调用的 CPU 累计上限（wrangler 配置的 [limits] cpu_ms；该段默认注释掉了，
 *   不配就是平台默认的 30 秒 —— 免费计划只能这样，见下方 WORKER_DEFAULTS 的说明）
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
  // 修改点（大仓库备份 CPU/耗时优化）：分片上传并发度
  UPLOAD_QUEUE_SIZE: "REPO_BACKUP_UPLOAD_QUEUE_SIZE",
};

/**
 * Workers 下的默认预算
 *
 * softDeadlineMs 取 7 分钟：JobWorkflow 给 execute-task 的步骤超时是 10 分钟，
 * 留 3 分钟给「收尾」—— 当前这一趟传输可能才传到一半，还要写 manifest、落库、清理旧版本。
 * 留得太少，收手的动作本身会撞上步骤超时，白收手一场。
 *
 * jobByteBudget 与 maxArchive 都取 2GiB：
 * - 2GiB 单趟在实测里远在 CPU 上限之内（按付费计划配了 cpu_ms = 300000 计），留足余量；
 * - 比它更大的仓库靠调大 cpu_ms 也救不回来，真正该做的是分轮或者换 Node 部署。
 *
 * 修改点（免费计划部署被 100328 拒绝）：cpu_ms 在 wrangler 配置里默认是注释状态，
 * 因为免费计划填这一项会直接部署失败。也就是说免费计划下 CPU 上限是平台默认的
 * 30 秒，上面这套默认值（7 分钟软截止 / 2GiB 单次预算）是按 5 分钟上限定的，
 * 在免费计划上**挡不住** CPU 超限 —— 那时要用 [vars] 里的
 * REPO_BACKUP_SOFT_DEADLINE_MS / REPO_BACKUP_JOB_BYTE_BUDGET_MB 主动压小。
 */
const WORKER_DEFAULTS = {
  softDeadlineMs: 7 * 60 * 1000,
  jobByteBudget: 2 * 1024 * MIB,
  maxArchiveBytes: 2 * 1024 * MIB,
  stallTimeoutMs: 120 * 1000,
  /**
   * 分片上传并发度 2（修改点：大仓库备份 CPU/耗时优化）
   *
   * lib-storage 的 queueSize 同时决定**消费源流的并发度**：只有 1 个消费者时
   * 它必须「读满一片 → 传完这一片 → 再读下一片」，于是下载与上传完全串行，
   * 单趟 wall-clock ≈ 下载耗时 + 上传耗时。提到 2 之后两段重叠，
   * 单趟 ≈ max(下载, 上传)。
   *
   * 这省的是 wall-clock 而不是 CPU，但对本模块的目标同样关键：
   * 软截止是按 wall-clock 算的，一趟省下的时间直接变成「这一轮还能多做一个目标」，
   * 轮次少了，每轮固定开销（解析计划、查目标、建目录、写 manifest）也跟着少。
   * 代价是峰值内存从 partSize × 2 升到约 partSize × 3（6MB → 约 18MB），
   * 在 Workers 的 128MB 下仍有大量余量。
   */
  uploadQueueSize: 2,
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
  // 0 = 不覆盖，沿用 getEnvironmentOptimizedUploadConfig 的 Node 默认值（本就是 4 并发）
  uploadQueueSize: 0,
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
 *   uploadQueueSize: number,
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
  const rawQueueSize = readEnvNumber(env, REPO_BACKUP_BUDGET_ENV_KEYS.UPLOAD_QUEUE_SIZE);

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
    // 0 表示「不覆盖上传驱动的默认并发」；上限 4 是内存余量的保守取值
    // （峰值约 partSize × (queueSize + 1)，6MB × 5 = 30MB）
    uploadQueueSize: resolveOptionalLimit(rawQueueSize, 1, 4, defaults.uploadQueueSize),
    environment: isWorker ? "Cloudflare Worker" : "Docker/Server",
  };
}

/**
 * 按实测吞吐估算「再搬 bytes 字节」还要多久（修改点：大仓库备份 CPU/耗时优化）
 *
 * @param {number} bytes 预计要搬的字节数（用同仓库上一趟的实际体积作代理值）
 * @param {number} bytesPerMs 实测吞吐（字节/毫秒）
 * @returns {number} 毫秒；缺少任一观测值时返回 0，表示**无从估算**
 */
export function estimateTransferMs(bytes, bytesPerMs) {
  const size = Number(bytes);
  const rate = Number(bytesPerMs);
  if (!Number.isFinite(size) || size <= 0) return 0;
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return Math.ceil(size / rate);
}

/**
 * 软截止之前还塞得下这一趟吗（修改点：大仓库备份 CPU/耗时优化）
 *
 * 为什么需要它：原先的预算检查只问「软截止到了吗」，没到就放手去领下一个目标。
 * 于是一个在 6 分 59 秒开工、要跑 4 分钟的目标照样会被放进去 ——
 * 传输一旦开始就没有中途收手的机制（刻意如此，中断只会留下半个文件），
 * 它只能一路跑到 Workflow 步骤超时被动失败：那一趟的字节、CPU、GitHub 流量全部白费，
 * 而且撞的是「被动失败」这条最差的路。
 * 有了上一趟的实测吞吐，这里就能提前判断「这一趟根本跑不完」，
 * 把它原样留给下一轮（下一轮它是第一个目标，会无条件执行）。
 *
 * @param {object} params
 * @param {number} params.estimateMs estimateTransferMs 的结果，0 = 估不出来
 * @param {number} params.nowMs 当前时间
 * @param {number} params.deadlineAtMs 软截止时刻，0 = 不限制（Node 口径）
 * @param {number} [params.safetyRatio] 余量系数，默认 1.3 ——
 *        估算依据是**上一趟**的吞吐，下一趟可能更慢（不同分支体积不同、上游限速波动）
 * @returns {{ fits: boolean, remainingMs: number, requiredMs: number }}
 *          fits=true 表示放行；估不出来或没有截止时一律放行，
 *          **保证至少有一趟能跑**（否则大仓库会每轮都推迟、永远备不上）
 */
export function fitsBeforeDeadline({ estimateMs, nowMs, deadlineAtMs, safetyRatio = 1.3 }) {
  const deadline = Number(deadlineAtMs);
  const estimate = Number(estimateMs);
  if (!Number.isFinite(deadline) || deadline <= 0 || !Number.isFinite(estimate) || estimate <= 0) {
    return { fits: true, remainingMs: 0, requiredMs: 0 };
  }
  const ratio = Number.isFinite(safetyRatio) && safetyRatio > 0 ? safetyRatio : 1;
  const remainingMs = deadline - Number(nowMs);
  const requiredMs = Math.ceil(estimate * ratio);
  return { fits: remainingMs >= requiredMs, remainingMs, requiredMs };
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
  // 修改点（大仓库备份 CPU/耗时优化）：按实测吞吐判断「这一趟还跑得完吗」
  estimateTransferMs,
  fitsBeforeDeadline,
  formatBytes,
  formatDuration,
};
