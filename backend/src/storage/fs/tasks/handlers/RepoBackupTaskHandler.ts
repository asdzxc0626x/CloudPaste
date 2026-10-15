// cSpell:words tarball repobackup
import type { TaskHandler, InternalJob, ExecutionContext } from "../TaskHandler.js";
import type { TaskStats, ItemResult, RepoBackupResolvedRef } from "../types.js";
import { ValidationError, NotFoundError } from "../../../../http/errors.js";
import { ensureRepositoryFactory } from "../../../../utils/repositories.js";
import { UserType } from "../../../../constants/index.js";
import { RepoProviderFactory } from "../../../../repobackup/providers/index.js";
import {
  parseProviderConfig,
  resolveTrackRefs,
  resolveTargetMountIds,
  buildUnresolvedCommitSha,
} from "../../../../repobackup/config.js";
import { planBackupPaths } from "../../../../repobackup/paths.js";
import { pruneOldVersions, describePruneResult } from "../../../../repobackup/retention.js";
// 修改点（同分支同 sha 只保留一个目录）：目录名带「写入时刻」，同一个 (分支, sha)
// 被重复写入（force 重跑 / 补写 / 并发）会各留一个孤儿目录，写成功后顺手去重
import { dedupeBackupDirs, toReferencedDirs } from "../../../../repobackup/dedupeDirs.js";
// 修改点（第 2 期 错误分类 + 延迟重试）：
// 限流/暂时性故障不记失败，而是算出「最早可重试时间」交给调度层
// 修改点（大仓库备份超 CPU 限制）：再引入两类自产错误 ——
//   BudgetExhaustedError  本次运行额度用尽（可延迟，下一轮接着干）
//   ArchiveTooLargeError  归档体积超上限（永久性，重试也没用）
//   TransientError        传输停滞改抛这个，让它真正落进「可延迟」类别
import {
  planRetryForError,
  describeRetryAt,
  describeErrorKind,
  TransientError,
  BudgetExhaustedError,
  ArchiveTooLargeError,
} from "../../../../repobackup/errors.js";
// 修改点（大仓库备份超 CPU 限制）：单次作业的时间 / 流量预算，见该模块文件头
// 修改点（大仓库备份 CPU/耗时优化）：再引入「按实测吞吐判断这一趟还跑不跑得完」
import {
  resolveTransferBudget,
  estimateTransferMs,
  fitsBeforeDeadline,
  formatBytes,
  formatDuration,
} from "../../../../repobackup/transferBudget.js";
import { deferRepositoryBackupSchedule } from "../../../../repobackup/schedule.js";
// 修改点（第 4 期）：备份成功后推进该引用在 repo_detect_states 里的「已备份水位」，
// 否则下一轮检测仍会认为有更新，同一个版本会被反复备份
// 修改点（P0 水位键错位）：再引入跟踪键的归一与收敛工具，水位只许落在跟踪键上
import {
  advanceBackedUpWatermark,
  normalizeRef,
  resolveTrackingRefKey,
  refTypeOfTrackMode,
} from "../../../../repobackup/detect.js";
/**
 * 修改点（状态显示不一致修复）：条目的「状态」与「结果」分开表达。
 * itemResult.status 仍是任务系统的通用条目状态（pending/processing/success/failed/skipped），
 * 它决定进度条与统计；itemResult.meta.outcome 用统一词汇说明「这次到底怎么样」
 * （up_to_date / deferred / partial / failed …），任务列表与仓库管理页共用同一套取值。
 */
import { REPO_OUTCOME } from "../../../../repobackup/status.js";

/**
 * 代码仓库备份任务（修改点：新增功能）
 *
 * 流程：
 *   解析最新版本 → 按 commitSha 去重 → 创建/复用备份记录 → 流式下载源码归档
 *   → 流式上传到目标挂载点 → 写 manifest → 回写记录与仓库状态
 *
 * 关键设计：
 * - 归档全程流式（provider 给 ReadableStream，直接交给 fileSystem.uploadFile），
 *   不整包读进内存，因此 Workers 128MB 限制下也能处理大仓库
 * - 字节数用 TransformStream 边传边计（Workers/Node 均原生支持），
 *   避免为了拿大小而缓冲整包
 *
 * 优化点（多分支 / 多备份目标 / 版本保留）：
 * - 一个作业处理该仓库的全部跟踪引用（分支模式即多个分支），逐个解析、去重、备份
 * - 每个版本会写入全部选中的目标挂载点；单个目标失败不影响其他目标，
 *   下次运行只补写缺失的目标（不会因为"某个目标成功过"就整版跳过）
 * - 备份成功后按 retention_count 清理最旧版本
 *
 * 取舍说明（多目标的下载开销）：
 *   向 N 个目标写入时按目标逐个「重新拉取一次源码归档」，而不是把同一个流分叉给
 *   N 个消费者。原因：Web Streams 的 tee() 内部缓冲无上限，大仓库在 Workers 上会
 *   撑爆内存；自建带背压的分叉流虽然可行，但一旦某个消费者中途失败，处理其挂起态
 *   的复杂度很高，容易把"单目标失败"放大成"整次备份失败"。逐个拉取的代价是
 *   多目标时 GitHub 侧流量放大 N 倍，换来的是内存可控、目标间故障完全隔离，
 *   以及重跑时只补写缺失目标（已成功的目标不会重复拉取）。
 *
 * 修改点（第 2 期：限流错误分类 + 延迟重试）：
 * - 上游错误先分类（repobackup/errors.js）：限流 / 暂时性 / 永久性
 * - 限流与暂时性错误**不算失败**：不写失败历史、不累计失败数、不抛异常
 *   （抛异常会让 Workflows 步骤与 Node 任务被判失败，还会触发无意义的重试）
 * - 只记下「最早可重试时间」，收尾时把它写进该仓库既有 scheduled_jobs 行的
 *   next_run_after，由调度层到点自动重跑
 * - 永久性错误（仓库/分支不存在等）行为不变，照旧记 failed
 *
 * 修改点（第 3 期：所有 GitHub API 请求统一经过请求调度器）：
 * - provider 由 createProvider 带上 db/env 创建，于是备份过程中的每一次 API 请求
 *   都先过 GithubRequestScheduler：全局并发 <= 2、间隔 >= 800ms、
 *   请求前查共享额度账本（额度不足则不发请求）、同一 URL 的并发查询合并成一次
 * - 调度器抛出的 RateLimitedError 由上面的第 2 期逻辑接住：依旧不记失败、不累计失败数、
 *   只把「最早可重试时间」交给调度层
 * - 源码归档走 codeload.github.com，不消耗 API 额度，因此不经过调度器（第 1 期成果不变）
 *
 * 修改点（大仓库备份超 CPU 限制）：单次作业的工作量必须自己设上限
 * ------------------------------------------------------------
 * 上面那条「取舍说明」带来一个后果：本作业的工作量是 N 个引用 × M 个目标，
 * 每个组合都要完整下载 + 完整上传一遍，而 N、M、仓库体积全由用户配置决定，
 * 代码侧原先没有任何约束。
 *
 * 在 Workers 下这一整串动作跑在**同一个** Workflow 步骤里（JobWorkflow 的 execute-task），
 * 于是同时吃两道限制：该次调用的累计 CPU，以及步骤的 wall-clock 超时。
 * 实测 354MB 归档单趟就要 3.5~20 秒 CPU（上游分片越小越贵），多引用 / 多目标必然撞线。
 *
 * 撞线的后果比「失败」严重得多：CPU 超限是运行时直接杀 isolate，**JS 捕获不到** ——
 * 下面所有 catch、updateBackup({status:'failed'})、last_error 一个都不会执行，
 * 备份记录永远停在 running，于是 ScheduledRepoBackupTask 的「上一次备份仍在进行中」
 * 会继续挡住这个仓库（原先要挡满 6 小时），管理员看不到任何原因。
 * 这正是 yetone/magpie（归档在、manifest 缺失、没有目标行）与
 * FCL-Team/FoldCraftLauncher（354MB，什么都没落下来）的现场。
 *
 * 所以这里加了三道口子，共同的原则是「撞线之前自己收手」：
 *  a) 开工前检查预算（软截止 + 单次作业流量上限），不够就不再领新活，
 *     把没轮到的引用 / 目标记成 deferred 并安排短延迟重试 ——
 *     已成功的目标照常落库，下一轮由既有的「只补写缺失目标」自愈路径接着干
 *  b) 归档体积硬上限：codeload 是 chunked 无 Content-Length，开传之前没人知道多大，
 *     只能边传边数，超了当场中止并记**永久性**失败（重试只会再浪费一遍流量）
 *  c) 传输护栏改用单个巡检定时器，不再每个分片 clearTimeout + setTimeout
 *
 * 配套改动在 wrangler 配置的 [limits] cpu_ms 与 src/repobackup/transferBudget.js
 * （预算口径与环境变量）。
 * 修改点（免费计划部署被 100328 拒绝）：[limits] cpu_ms 现在默认是注释状态 ——
 * 免费计划填这一项会直接部署失败，代价是 CPU 上限回到平台默认的 30 秒。
 * 因此真正在每个部署形态下都生效的是 transferBudget.js 的预算收手。
 *
 * 修改点（大仓库备份 CPU/耗时优化）：再审计一轮逐字节开销后的两处收紧
 * --------------------------------------------------------------
 * 实测（Node 同款 V8，354MB/6MB 分片）各"每个字节都要过一遍"的动作：
 *   lib-storage 组片 Buffer.concat   0.08s   SigV4 载荷哈希（crypto.subtle）0.31s
 *   传输护栏 TransformStream 直通    0.17s（上游 16KB 分片）/ 0.78s（1KB 分片）
 *   AWS SDK 的 CRC32 校验和（纯 JS） 2.70s  ← 唯一的大头，而它本不该被算
 * 结论是逐字节的 JS 开销总计约 0.6s/趟，**护栏不是瓶颈**（所以没有为了省掉
 * 它那 0.17s 去换掉按块计数 —— 那会把停滞检测的精度从"按分片"降到"按 6MB 分片完成"）。
 * 真正值得动的是"趟数"和"每趟的 wall-clock"：
 *  d) 分片上传并发度提到 2：lib-storage 的 queueSize 同时是消费源流的并发度，
 *     为 1 时下载与上传完全串行，单趟 wall-clock 是两者之和。重叠之后一次运行
 *     能完成的目标更多，轮次更少（见下面 uploadTuning 的说明）
 *  e) 领下一个目标前增加"按实测吞吐估算还跑不跑得完"：原先只看软截止有没有到，
 *     于是截止前 1 秒开工、要跑 4 分钟的目标照样被放进去，然后一路跑到步骤超时
 *     被动失败，整趟白费。现在估着来不及就直接让给下一轮（见 budgetExhausted）
 * 另外修掉了 S3 客户端的一处配置漏网：provider_type 取 "Other" 的挂载点从来没命中
 * createS3Client 里的 case（常量写的是 "Other S3 Compatible"），于是关校验和这件事
 * 对它一直没生效 —— 在 AWS SDK ≥ 3.729 上这正好等于给每次上传加一遍上面那 2.70s。
 */

type RepoBackupPayload = {
  repositoryId: string;
  /** owner/repo，仅用于任务列表显示，执行时仍以 repositoryId 为准 */
  repoIdentifier?: string;
  force?: boolean;
  /**
   * 预解析版本（修改点：第 4 期）
   * 由 repo_backup_check 解析并落库后传入；有值时本任务不再请求 GitHub 版本 API
   */
  refs?: RepoBackupResolvedRef[];
};

// 修改点（状态显示不一致修复）：条目状态与「结果」分开表达，
// 统一词汇从 repobackup/status.js 引入（见文件头的 import 说明）。
/** 单个跟踪引用（分支）的备份结果 */
type RefOutcome = {
  ref: string | null;
  status: "success" | "partial" | "failed" | "skipped" | "deferred";
  error?: string;
  sizeBytes?: number | null;
  primaryPath?: string | null;
};

/**
 * 执行阶段（修改点：任务卡住排查 / 详情完善）
 *
 * 之所以要上报阶段：原实现只写 processedItems/successCount 这类计数，
 * 一个引用从开始到结束中间可能有十几分钟（解析 → 下载上传 → 写 manifest → 清理），
 * 这期间前端看到的统计完全不动，无法区分「正在传大仓库」和「真的卡死了」。
 */
type BackupStage = "preparing" | "resolving" | "transferring" | "manifest" | "pruning" | "finished";

/**
 * 以下三组类型是**步骤返回值**（修改点：阶段 2 拆分 Workflow 步骤）
 * ================================================================
 * 它们受两条硬约束，改这里之前务必先读 TaskHandler.ts 里 runStep 的注释：
 *
 * 1. **必须可序列化**：Workflows 会把步骤输出持久化下来，重放时直接回灌。
 *    所以只能放原始值与纯对象 —— 不能放 Error、Date、Stream、ReadableStream，
 *    也不能放 mount 行或 repoRow 这种带嵌套的数据库行。
 * 2. **不得含凭据**：持久化意味着它离开了 D1 的加密字段。provider 配置、
 *    token、S3 密钥一律不许出现在这里；需要凭据的代码在步骤**内部**自己解密。
 *
 * 另一条设计约束是「确定性」：步骤之外的累计逻辑（预算、吞吐、延迟重试时间）
 * 全部只依赖这些返回值，不读 Date.now()。于是重放时拿到的是同一批缓存输出，
 * 推导出的控制流完全一致 —— 这正是文档要求的
 * 「conditions must be based on deterministic values — either values from
 *  event.payload or return values from previous steps」。
 */

/**
 * 可延迟重试计划的可序列化形态
 *
 * planRetryForError 的返回值里 retryAtMs 是 `Date.now() + delay` 算出来的，
 * 这是个不确定值。所以它必须**在步骤内部**算好并随返回值缓存下来，
 * 否则每次重放都会算出一个新的重试时刻，日志与前端显示会漂移。
 */
type SerializableDeferral = {
  kind: string;
  retryAtMs: number;
  message: string;
};

/** prepare-ref 步骤的结论 */
type PrepareRefResult = {
  /**
   * transfer    —— 需要搬运，missingMountIds 是本次要补写的目标
   * up_to_date  —— 全部目标都已有该 commit 的成功副本（水位已在步骤内补齐）
   * deferred    —— 解析阶段撞上限流/暂时性故障，已安排重试
   * failed      —— 永久性失败
   * cancelled   —— 作业已被取消
   */
  decision: "transfer" | "up_to_date" | "deferred" | "failed" | "cancelled";
  backupId: string | null;
  /** 本次要补写的目标挂载点 ID；顺序与 mounts 一致（遍历顺序必须确定） */
  missingMountIds: string[];
  /** 已有成功副本、本次跳过的目标挂载点 ID */
  doneMountIds: string[];
  /**
   * 本次备份目录的时间基准（毫秒）
   *
   * planBackupPaths 默认用 `new Date()`，而目录名里带时间戳
   * （`时间__分支__sha`）—— 也就是说**同一个组合重跑一次就会多出一个目录**。
   * 把时间基准收进步骤返回值后，步骤重试与实例重放都会复用同一个时间戳，
   * 落到同一个路径上（覆盖写），不再产生孤儿目录。
   * 路径格式本身一个字都没改，dedupeBackupDirs 仍作为兜底保留。
   */
  pathAtMs: number;
  /** 解析出的版本；decision 为 cancelled/failed 的早期分支下可能为 null */
  version: {
    refType: string;
    ref: string | null;
    commitSha: string;
    version: string | null;
    publishedAt: string | null;
  } | null;
  deferral: SerializableDeferral | null;
  error: string | null;
  /** 预算用尽导致这个引用根本没开工；文案给管理员看，不进 last_error */
  budgetReason: string | null;
};

/** 单个 ref × 目标 的传输结果 */
type TransferResult = {
  status: "success" | "failed" | "deferred";
  mountId: string;
  /** 目标显示名（日志与任务详情用） */
  label: string;
  storagePath: string | null;
  manifestPath: string | null;
  manifestWarning: string | null;
  sizeBytes: number | null;
  /** 本趟实际搬了多少字节（失败/中止那趟也算），用于累计流量预算 */
  bytes: number;
  /** 传输成功时的净耗时，用于吞吐估算；失败趟返回 0（不污染速度样本） */
  transferMs: number;
  error: string | null;
  deferral: SerializableDeferral | null;
  /** 预算用尽导致这一趟根本没开始；文案给管理员看，不进 last_error */
  budgetReason: string | null;
};

/** finalize-ref 步骤的结论 */
type FinalizeRefResult = {
  /**
   * success  —— 全部目标都有副本
   * partial  —— 部分目标有副本
   * failed   —— 一个副本都没有，且确实有目标写挂了
   * deferred —— 一个副本都没有，但原因是限流 / 预算用尽，已安排重试
   */
  status: "success" | "partial" | "failed" | "deferred";
  doneCount: number;
  totalTargets: number;
  primaryStoragePath: string | null;
  primarySizeBytes: number | null;
  /** 进备份记录 error_message 的完整说明（含「没轮到」与清理结果） */
  note: string | null;
  /** 进 code_repositories.last_error 的**真实失败**原因；没有真失败时为 null */
  warning: string | null;
  /** 一个副本都没有时给任务条目的说明 */
  message: string | null;
};

/**
 * 元数据类步骤的配置（修改点：阶段 2 拆分 Workflow 步骤）
 *
 * plan-run / prepare-ref / finalize-ref / defer-schedule 都是「几次 D1 读写
 * 加最多一次 GitHub 版本查询」，重试代价极低而收益明确（偶发的 D1/网络抖动），
 * 所以保留 3 次重试。超时给到 120s 是为了容纳 resolveLatestVersion 在
 * 请求调度器里排队（全局并发 <=2、间隔 >=800ms）的等待。
 */
const META_STEP_CONFIG = {
  retries: { limit: 3, delay: 5000, backoff: "exponential" as const },
  timeout: 120000,
};

/**
 * 传输步骤的配置（修改点：阶段 2 拆分 Workflow 步骤）
 *
 * 取值沿用阶段 1 给 repo_backup 定下的 `limit: 1`，理由不变（见 JobWorkflow.ts
 * 的 EXECUTE_STEP_CONFIG_BY_TASK_TYPE 注释）：一次尝试就是「完整下载 + 完整上传
 * 一遍归档」，盲目重跑只会再撞同一道上限，还会在桶里多留一套未完成分片。
 *
 * 拆分带来的改善是**重试的作用域**：阶段 1 的 limit=1 是「整个作业最多跑 2 遍」
 * （N 个引用 × M 个目标全部重来），现在变成「**这一个组合**最多跑 2 遍」，
 * 已经成功的组合不会被牵连 —— 它们的步骤结果已经落盘缓存。
 */
const TRANSFER_STEP_CONFIG = {
  retries: { limit: 1, delay: 10000, backoff: "exponential" as const },
  timeout: 600000,
};

/**
 * 传输停滞超时（修改点：任务卡住排查）
 *
 * GitHub/加速代理的连接可能在中途停止吐数据而不断开，此时下载与上传都会无限期等待，
 * 任务永远停在 running。这里在字节流上挂一个看门狗：超过该时长没有新分片就 abort 掉
 * 整个响应，让这个目标以明确的错误失败（下次运行会自动补写）。
 *
 * 修改点（大仓库备份超 CPU 限制）：实际生效值改由 transferBudget 解析
 * （支持 REPO_BACKUP_STALL_TIMEOUT_MS 覆盖），这里只作为 createTransferGuard 的默认值。
 */
const STALL_TIMEOUT_MS = 120 * 1000;

/** 实时字节进度的上报节流：至少间隔 1.5s，或累计新增 8MB */
const PROGRESS_FLUSH_INTERVAL_MS = 1500;
const PROGRESS_FLUSH_BYTES = 8 * 1024 * 1024;

/** 单次任务只处理一个仓库，统计模板按引用数量展开 */
function buildStats(totalItems: number, overrides: Partial<TaskStats> = {}): TaskStats {
  return {
    totalItems,
    processedItems: 0,
    successCount: 0,
    failedCount: 0,
    skippedCount: 0,
    itemResults: [],
    ...overrides,
  } as TaskStats;
}

function nowIso(): string {
  return new Date().toISOString();
}

function generateId(prefix: string): string {
  try {
    // eslint-disable-next-line no-undef
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      // eslint-disable-next-line no-undef
      return `${prefix}_${crypto.randomUUID()}`;
    }
  } catch {
    // ignore
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 归档传输的护栏（修改点：任务卡住排查）
 *
 * 一次性解决四件事：
 * - 字节计数：counter.value 在流被消费的过程中持续累加
 * - 停滞检测：超过 stallTimeoutMs 没有新分片就 abort 整个响应
 * - 体积上限：累计字节超过 maxBytes 就当场掐断（修改点：大仓库备份超 CPU 限制）
 * - 实时进度：按节流回调 onProgress，让前端能看到字节在涨（不涨就是真卡住了）
 *
 * controller.signal 必须在发起请求前就交给 provider，所以本函数先于 openSourceArchive 调用，
 * 拿到响应后再用 wrap() 套住 body。
 *
 * 修改点（大仓库备份超 CPU 限制）：停滞检测由「每个分片都 clearTimeout + setTimeout」
 * 改成「一个巡检定时器 + 一个时间戳」。原写法在 354MB 归档上要重建十几万次定时器，
 * 纯属浪费 —— 而这里的每一点 CPU 都直接计入 Workers 那条会把 isolate 杀掉的配额。
 * 判定精度从「精确到分片」降为「精确到 stallTimeoutMs/4」，对一个 120 秒的阈值无关紧要。
 *
 * 导出仅供回归测试使用（transferBudget.test.js）：护栏里的体积上限是会「中途掐断传输」
 * 的逻辑，一旦算错就会悄悄产出半个归档，必须能单独验证。业务代码只在本文件内调用。
 */
export function createTransferGuard({
  stallTimeoutMs = STALL_TIMEOUT_MS,
  maxBytes = 0,
  onProgress,
}: {
  stallTimeoutMs?: number;
  /** 累计字节上限，0 表示不限制 */
  maxBytes?: number;
  onProgress?: (bytes: number) => void;
} = {}) {
  const controller = new AbortController();
  const counter = { value: 0 };

  let timer: any = null;
  let stalled = false;
  let oversize = false;
  let disposed = false;
  let lastChunkAtMs = Date.now();
  let lastFlushMs = lastChunkAtMs;
  let lastFlushBytes = 0;

  const abortQuietly = () => {
    try {
      controller.abort();
    } catch {
      // ignore
    }
  };

  const dispose = () => {
    disposed = true;
    if (timer) clearInterval(timer);
    timer = null;
  };

  /**
   * 启动停滞巡检（幂等：重复调用不会建出第二个定时器）
   * wrap() 内部会自动调一次，调用方在拿到响应后再调一次也无妨
   */
  const arm = () => {
    if (disposed || timer) return;
    lastChunkAtMs = Date.now();
    // 巡检周期取阈值的 1/4：最坏情况下晚 1/4 个阈值才判定停滞，完全够用
    const tickMs = Math.max(1000, Math.floor(stallTimeoutMs / 4));
    timer = setInterval(() => {
      if (disposed) return;
      if (Date.now() - lastChunkAtMs < stallTimeoutMs) return;
      stalled = true;
      console.error(`[RepoBackupTaskHandler] 传输停滞超过 ${Math.round(stallTimeoutMs / 1000)}s，中止本次下载`);
      abortQuietly();
      dispose();
    }, tickMs);
    // Node 下让定时器不要拖着事件循环（Workers 上 timer 是数字，可选调用自动跳过）
    try {
      timer?.unref?.();
    } catch {
      // ignore
    }
  };

  /** @param nowMs 复用调用方已经取过的时间戳，省掉每个分片一次 Date.now() */
  const flushProgress = (nowMs: number, force = false) => {
    if (!onProgress) return;
    const grown = counter.value - lastFlushBytes;
    if (!force && nowMs - lastFlushMs < PROGRESS_FLUSH_INTERVAL_MS && grown < PROGRESS_FLUSH_BYTES) {
      return;
    }
    lastFlushMs = nowMs;
    lastFlushBytes = counter.value;
    try {
      onProgress(counter.value);
    } catch {
      // 进度上报失败绝不能影响传输
    }
  };

  /** 套在归档 body 外层：边转发边计数、刷新停滞时间戳、上报进度、拦住超大归档 */
  const wrap = (stream: ReadableStream): ReadableStream => {
    arm();
    // TransformStream 在 Cloudflare Workers 与 Node 18+ 均为全局可用
    const transform = new TransformStream({
      transform(chunk: any, ctrl: any) {
        const nowMs = Date.now();
        lastChunkAtMs = nowMs;

        let size = 0;
        try {
          const raw = chunk?.byteLength ?? chunk?.length ?? 0;
          if (Number.isFinite(raw)) size = raw;
        } catch {
          // 计数失败不应中断传输
        }
        counter.value += size;

        /**
         * 体积硬上限（修改点：大仓库备份超 CPU 限制）
         *
         * 这是唯一一处「传输中途主动掐断」。之所以必须能中途掐断：
         * codeload 的响应是 chunked 不带 Content-Length，开传之前拿不到体积，
         * 而一个远超预算的归档会把整次调用（以及它后面排着的引用 / 目标）全拖死。
         * 掐断留下的是半个文件，但目标行会记 failed、原因写得清清楚楚，
         * 比被运行时静默杀掉强得多。
         */
        if (maxBytes > 0 && counter.value > maxBytes) {
          oversize = true;
          abortQuietly();
          dispose();
          ctrl.error(new Error(`归档体积超过上限 ${formatBytes(maxBytes)}，已中止传输`));
          return;
        }

        flushProgress(nowMs);
        ctrl.enqueue(chunk);
      },
      flush() {
        dispose();
      },
    });
    return stream.pipeThrough(transform);
  };

  return {
    signal: controller.signal,
    counter,
    arm,
    dispose,
    wrap,
    isStalled: () => stalled,
    /** 是否因为超过体积上限而被掐断（修改点：大仓库备份超 CPU 限制） */
    isOversize: () => oversize,
  };
}

export class RepoBackupTaskHandler implements TaskHandler {
  readonly taskType = "repo_backup";

  async validate(payload: any): Promise<void> {
    if (payload === null || typeof payload !== "object") {
      throw new ValidationError("payload 必须是对象");
    }
    if (!payload.repositoryId || typeof payload.repositoryId !== "string") {
      throw new ValidationError("repositoryId 必须是非空字符串");
    }
    if (payload.force !== undefined && typeof payload.force !== "boolean") {
      throw new ValidationError("force 必须是布尔值");
    }
  }

  createStatsTemplate(_payload: any): TaskStats {
    return buildStats(1);
  }

  /**
   * 本处理器自己划分执行步骤（修改点：阶段 2 拆分 Workflow 步骤）
   *
   * 声明之后 JobWorkflow 不再把 execute() 整体包进单个 execute-task 步骤，
   * 而是在 run() 顶层驱动它 —— 因为 Workflows 不支持嵌套步骤，
   * 「被包住」和「自己开步骤」只能二选一（详见 TaskHandler.usesExecutionSteps）。
   *
   * 换来的是：每个 ref × 目标各自成为一个步骤，于是各自拿到一份独立的
   * CPU 与外部 subrequest 额度，且已完成的组合结果会被平台缓存下来 ——
   * 后面的组合撞上限被杀，不会再把前面做成的活一起带走。
   *
   * 代价与纪律（改这个文件前务必先读完）：
   * - execute() 里**步骤之外**的代码会在引擎重启 / 步骤间重放时被重复执行。
   *   所以步骤之外只许有「只读查询 + 纯计算」，所有写操作一律收进步骤。
   * - 步骤之外的控制流只许依赖 payload 与**上一个步骤的返回值**，不许读
   *   Date.now()。预算 / 吞吐 / 重试时刻因此全部改为「步骤内算、随返回值缓存、
   *   步骤外只做累加」。
   */
  readonly usesExecutionSteps = true;

  async execute(job: InternalJob, context: ExecutionContext): Promise<void> {
    const payload = (job.payload || {}) as RepoBackupPayload;
    const force = payload.force === true;

    const fileSystem = context.getFileSystem();
    const env = typeof context.getEnv === "function" ? context.getEnv() : null;
    const db = env?.DB ?? fileSystem?.mountManager?.db;
    if (!db) {
      throw new ValidationError("repo_backup: 缺少 DB 绑定");
    }

    const encryptionSecret = env?.ENCRYPTION_SECRET ?? fileSystem?.mountManager?.encryptionSecret;
    if (!encryptionSecret) {
      throw new ValidationError("repo_backup: 缺少 ENCRYPTION_SECRET");
    }

    const factory = ensureRepositoryFactory(db, fileSystem?.repositoryFactory, env || {});
    const codeRepo = factory.getCodeRepositoryRepository();
    const mountRepository = factory.getMountRepository();

    /**
     * 步骤执行器（修改点：阶段 2 拆分 Workflow 步骤）
     *
     * Workers 下 context.runStep 由 JobWorkflow 提供，底层就是 step.do；
     * Node/Docker 下它不存在，于是退化成「直接调用」—— 那里既没有 CPU 配额
     * 也没有步骤超时，不需要拆分，行为与拆分前**逐字相同**。
     */
    const splitIntoSteps = typeof context.runStep === "function";
    const runStep = <T>(name: string, options: any, fn: () => Promise<T>): Promise<T> =>
      splitIntoSteps ? context.runStep!<T>(name, options, fn) : fn();

    /**
     * 包一层「步骤抛出也不中断整轮」
     *
     * 步骤体内部已经把业务异常都接住并转成返回值了，所以这里兜到的是
     * 步骤超时 / 重试耗尽 / 未预期运行时错误。单个组合崩掉绝不能让剩下的组合
     * 没机会跑 —— 这正是本阶段要求的「隔离失败」。
     *
     * @param fallback 把步骤级错误翻译成与正常返回值同形状的失败结果
     */
    const runStepSafely = async <T>(
      name: string,
      options: any,
      fn: () => Promise<T>,
      fallback: (message: string) => T,
    ): Promise<T> => {
      try {
        return await runStep(name, options, fn);
      } catch (error: any) {
        const message = String(error?.message || error || "未知错误");
        console.error(`[RepoBackupTaskHandler] 步骤 ${name} 异常退出（超时或重试耗尽）: ${message}`);
        return fallback(message);
      }
    };

    /**
     * 本次作业的传输预算（修改点：大仓库备份超 CPU 限制）
     *
     * Workers 下是「软截止 + 流量上限 + 单归档体积上限」，Node 下默认全关
     * （那里没有 CPU 配额也没有步骤超时，加限制只会让大仓库备份不成）。
     * 口径与环境变量见 repobackup/transferBudget.js 的文件头。
     *
     * 修改点（阶段 2 拆分 Workflow 步骤）：软截止的**含义变了**。
     * 拆分前它拦的是「同一次调用里别再领新活」，因为所有组合共用一份 CPU 配额；
     * 拆分后每个组合是独立 invocation（wall time 无上限、CPU 额度各自独立），
     * 它拦的变成「这一轮作业别没完没了地做下去」。取值一个没改，
     * 但别再指望它能救「单个归档本身就超限」——那是下一阶段的事。
     */
    const budget = resolveTransferBudget(env);
    /**
     * 本次作业已经实际搬过的字节数（含失败/中止的那一趟）
     *
     * 与 stats 里的 bytesTransferred 分开记：后者是给前端看的进度，
     * 只累计写成功的部分；预算要算的是「这次调用真花掉了多少」，失败的那趟也算。
     *
     * 修改点（阶段 2）：只在步骤**之外**按步骤返回值累加。
     * 如果在步骤内部累加，重放时步骤体不执行（直接回灌缓存结果），累加就丢了。
     */
    let budgetBytes = 0;

    /**
     * 本次作业实测到的传输吞吐（修改点：大仓库备份 CPU/耗时优化）
     *
     * 只累计「真的从 openSourceArchive 到 uploadFile 走完一趟」的样本：
     *   observedBytes / observedMs = 字节/毫秒
     * 用途是在领下一个目标之前估一下「这一趟跑得完吗」（见 budgetExhausted）。
     * 取整个作业的累计值而不是最后一趟的瞬时值：样本少的时候更稳，
     * 也不会因为某一趟恰好碰上上游抽风就把后面全推迟掉。
     */
    let observedBytes = 0;
    let observedMs = 0;
    /** 上一趟归档的实际体积，作为「下一趟大概多大」的代理值（同仓库各分支体积相近） */
    let lastArchiveBytes = 0;

    // ---------- 1. 读取仓库配置 ----------
    // 修改点（阶段 2）：这一段是纯只读查询，文档明确允许放在步骤之外
    //（原文：「calls that have no side effects can be done outside of steps」）。
    // 代价是每次重放多几次 D1 读；收益是凭据与仓库行完全不进步骤返回值。
    const repoRow = await codeRepo.findRepositoryById(payload.repositoryId);
    if (!repoRow) {
      throw new NotFoundError(`代码仓库不存在: ${payload.repositoryId}`);
    }

    const provider = String(repoRow.provider || "");
    const repoIdentifier = String(repoRow.repo_identifier || "");
    const trackMode = String(repoRow.track_mode || "branch") as "branch" | "release";

    // 修改点（多分支优化）：一个作业处理该仓库的全部跟踪引用
    const trackRefs = resolveTrackRefs(repoRow);

    /**
     * 本次要备份的引用计划（修改点：第 4 期 检测与备份分离）
     *
     * 两种来源：
     *  a) payload.refs 非空 —— repo_backup_check 任务已经解析过版本了，
     *     直接用它给的 commitSha，**本任务不再请求 GitHub 版本 API**。
     *     这是定时备份与手动备份的正常路径。
     *  b) payload.refs 缺省 —— 退回「任务内自行解析」。
     *     保留这条退路只为兼容两类历史调用：
     *       · 升级前就已存在于 tasks 表里的 pending 作业（payload 里没有 refs）
     *       · 直接按 repositoryId 调 createJob 的外部脚本
     *     它不是第二套实现：解析结果同样会写回 repo_detect_states（见下面的
     *     advanceBackedUpWatermark），不会出现两套互相矛盾的水位。
     */
    const preresolvedRefs: RepoBackupResolvedRef[] = Array.isArray(payload.refs)
      ? payload.refs.filter((item) => item && typeof item.commitSha === "string" && item.commitSha.length > 0)
      : [];
    const usePreresolved = preresolvedRefs.length > 0;

    /**
     * 本次要备份的引用计划
     *
     * 修改点（P0 水位键错位）：计划项同时带「展示用 ref」与「跟踪键」两个字段。
     *   trackRef     —— 展示 / 请求 provider 用（release 模式跟踪「最新」时为 null）
     *   trackingRef  —— repo_detect_states 的状态键，推进水位只认它
     * 预解析路径以前直接把 `item.ref`（已经是具体 Tag）当成 trackRef 一路传下去，
     * 水位就落到了错的行上。现在跟踪键单独取，并用 resolveTrackingRefKey
     * 对历史 payload（没有该字段）做收敛兜底。
     *
     * 修改点（阶段 2）：这个数组同时是**步骤名的来源**，所以它必须完全确定 ——
     * 它只依赖 payload 与 repoRow，遍历顺序固定，没有随机或时间参与，
     * 满足文档对动态步骤名的要求（「constructed in a deterministic way」）。
     */
    const backupPlan: Array<{
      trackRef: string | null;
      trackingRef: string;
      trackingRefType: "branch" | "tag";
      preresolved: RepoBackupResolvedRef | null;
    }> = usePreresolved
      ? preresolvedRefs.map((item) => ({
          trackRef: item.ref ?? null,
          trackingRef:
            item.trackingRef !== undefined
              ? normalizeRef(item.trackingRef)
              : resolveTrackingRefKey(repoRow, item.ref ?? null, item.refType),
          // 跟踪键的 ref_type 与仓库 track_mode 同源，不取 provider 返回的那个，
          // 避免「状态键类型」与「状态键」来自两个不同来源
          trackingRefType: refTypeOfTrackMode(trackMode),
          preresolved: item,
        }))
      // 显式标注参数类型：resolveTrackRefs 是 JS 模块（无 .d.ts），不标注会退化成隐式 any
      : trackRefs.map((ref: string | null) => ({
          trackRef: ref ?? null,
          trackingRef: normalizeRef(ref),
          trackingRefType: refTypeOfTrackMode(trackMode),
          preresolved: null,
        }));

    if (backupPlan.length === 0) {
      throw new ValidationError(`仓库未配置任何跟踪引用: ${repoIdentifier}`);
    }

    // 修改点（多备份目标优化）：一次备份写入全部选中的目标
    const targetMountIds = resolveTargetMountIds(repoRow);
    if (targetMountIds.length === 0) {
      throw new ValidationError(`仓库未配置备份目标: ${repoIdentifier}`);
    }

    const mounts: any[] = [];
    for (const mountId of targetMountIds) {
      const mount = await mountRepository.findById(mountId);
      if (!mount) {
        throw new NotFoundError(`备份目标挂载点不存在: ${mountId}`);
      }
      if (mount.is_active === 0) {
        throw new ValidationError(`备份目标挂载点已禁用: ${mount.name || mount.mount_path}`);
      }
      mounts.push(mount);
    }

    // 修改点（第 4 期）：进度分母跟着实际计划走 —— 预解析路径下只备份「有更新的引用」，
    // 用 trackRefs.length 当分母会让进度永远到不了 100%
    const totalItems = backupPlan.length;
    const itemResults: ItemResult[] = [];
    const outcomes: RefOutcome[] = [];

    let totalBytes = 0;
    let bytesTransferred = 0;

    /**
     * 本轮出现过的「可延迟重试」错误（修改点：第 2 期 限流 = 延迟，不是失败）
     *
     * 只保留最早的那个重试时间：一处限流就说明额度已经打满，整轮都该按
     * 最早的时间重来，而不是每个分支各排一个时间。
     *
     * 注意：必须声明在 report() 之前 —— report 会在循环开始前就被调用一次，
     * 而它引用了这几个变量。
     */
    let deferredRetryAtMs: number | null = null;
    let deferredKind: string | null = null;
    let deferredMessage: string | null = null;

    /**
     * 把错误转成**可序列化**的延迟重试计划（修改点：阶段 2 拆分 Workflow 步骤）
     *
     * 只许在步骤**内部**调用。planRetryForError 里的 retryAtMs 是
     * `Date.now() + delay`，是个不确定值；在步骤内算好、随返回值缓存下来，
     * 重放时拿回的才是同一个时刻，否则日志与前端显示的重试时间会每次都漂。
     */
    const toDeferral = (error: unknown): SerializableDeferral | null => {
      const plan = planRetryForError(error);
      if (!plan.deferrable || plan.retryAtMs === null) return null;
      return { kind: plan.kind, retryAtMs: plan.retryAtMs, message: plan.message };
    };

    /**
     * 登记一次延迟重试（修改点：阶段 2 拆分 Workflow 步骤）
     *
     * 与 toDeferral 相反，这个只许在步骤**外部**调用：它改的是跨步骤累计状态，
     * 而输入全部来自已缓存的步骤返回值，所以重放时能一字不差地重新累加出来。
     */
    const noteDeferral = (plan: SerializableDeferral | null) => {
      if (!plan) return null;
      if (deferredRetryAtMs === null || plan.retryAtMs < deferredRetryAtMs) {
        deferredRetryAtMs = plan.retryAtMs;
        deferredKind = plan.kind;
        deferredMessage = plan.message;
      }
      return plan;
    };

    // 修改点（任务卡住排查 / 详情完善）：当前执行阶段与目标，让「任务管理」能看出卡在哪一步
    let currentStage: BackupStage = "preparing";
    let currentRef: string | null = null;
    let currentTarget: { name: string | null; mountPath: string | null } = { name: null, mountPath: null };

    const report = async (processedItems: number, extra: Partial<TaskStats> = {}) => {
      await context.updateProgress(
        job.jobId,
        buildStats(totalItems, {
          processedItems,
          successCount: outcomes.filter((o) => o.status === "success").length,
          failedCount: outcomes.filter((o) => o.status === "failed").length,
          // 修改点（状态显示不一致修复）：被延迟重试的引用**不算失败**，
          // 与「跳过」一起计入 skippedCount，进度条的口径与修复前一致（不产生视觉回归）；
          // 同时单独给出 deferredCount，让详情能区分「无需备份」和「已安排重试」
          skippedCount: outcomes.filter((o) => o.status === "skipped" || o.status === "deferred").length,
          deferredCount: outcomes.filter((o) => o.status === "deferred").length,
          itemResults,
          totalBytes,
          bytesTransferred,
          // 阶段类字段（前端任务详情直接展示）
          stage: currentStage,
          currentRef,
          currentTargetName: currentTarget.name,
          currentTargetPath: currentTarget.mountPath,
          repositoryId: repoRow.id,
          repoIdentifier,
          // 修改点（第 2 期 延迟重试）：本轮被推迟时的重试时间。
          // 前端不渲染该字段，放在 stats 里是为了任务详情能直接看出「为什么没备份」。
          deferRetryAt: deferredRetryAtMs ? describeRetryAt(deferredRetryAtMs) : null,
          targetCount: mounts.length,
          targetMounts: mounts.map((m) => ({
            id: m.id,
            name: m.name ?? null,
            mountPath: m.mount_path ?? null,
          })),
          ...extra,
        }),
      );
    };

    await report(0);

    // ---------- 2. 解析 Provider（失败即整体失败） ----------
    // 修改点（阶段 2）：刻意留在步骤之外。它是「解密 + 构造对象」，没有副作用，
    // 重放时重做一遍只是一点 CPU；更重要的是**凭据绝不能进步骤返回值**——
    // 步骤输出会被平台持久化，那等于把密钥搬出了 D1 的加密字段。
    const providerConfig = await parseProviderConfig(provider, repoRow.config_json, encryptionSecret);
    // 修改点（第 3 期 请求调度）：把 db/env 交给 provider，让备份过程的全部
    // GitHub API 请求统一经过请求调度器（全局并发 <=2、间隔 >=800ms、
    // 请求前查共享额度账本、同名请求合并）。额度不足时会抛出 RateLimitedError，
    // 由下面的第 2 期延迟重试逻辑接住 —— 不记失败，改为安排到点重跑。
    // 修改点（第 3 期 3-B）：再带上 encryptionSecret，provider 才能读取全局凭据池。
    const providerInstance = RepoProviderFactory.createProvider(provider, providerConfig, {
      db,
      env,
      encryptionSecret,
    });

    // ---------- 3. 作业时间锚点（修改点：阶段 2 拆分 Workflow 步骤）----------
    /**
     * 为什么「开工时刻」要做成一个步骤的返回值
     *
     * 软截止原先是 `Date.now() - handler 进入时刻`。拆分之后主干跑在步骤之外，
     * 引擎每次重放都会重新执行它 —— 那个「进入时刻」于是每次都变成「刚刚」，
     * 软截止永远判不到，预算形同虚设。收进步骤返回值后它被缓存下来，
     * 重放拿到的是同一个时刻，判定才稳定。
     *
     * 这就是文档那条红线的直接应用：
     *   「🔴 Bad: Condition based on non-deterministic value outside a step」
     *   「✅ Good: Wrap non-deterministic values in a step」
     */
    const planRun = await runStep("plan-run", META_STEP_CONFIG, async () => ({
      startedAtMs: Date.now(),
      refCount: backupPlan.length,
      targetCount: mounts.length,
    }));
    const startedMs = planRun.startedAtMs;
    const deadlineAtMs = budget.softDeadlineMs > 0 ? startedMs + budget.softDeadlineMs : 0;

    /** 软截止是否已过（修改点：大仓库备份超 CPU 限制） */
    const deadlinePassed = () => deadlineAtMs > 0 && Date.now() >= deadlineAtMs;

    /**
     * 预算是否已耗尽（修改点：大仓库备份超 CPU 限制）
     *
     * 只在「准备领一份新活」之前调用（下一个引用、下一个目标），
     * 不在传输中途调用 —— 中途掐断只会留下半个文件，而我们宁可让这一趟走完。
     *
     * 修改点（大仓库备份 CPU/耗时优化）：除了「截止到了没」「流量用完没」，
     * 再加一问「这一趟按实测速度还跑得完吗」。
     * 原先只看前两项，于是一个在软截止前 1 秒开工、要跑 4 分钟的目标照样会被放进去 ——
     * 传输开始后没有收手机制，它只能一路跑到 Workflow 步骤超时被动失败，
     * 整趟的 CPU、流量全白费。有了上一趟的实测吞吐就能提前让位。
     *
     * 修改点（阶段 2 拆分 Workflow 步骤）：**只许在步骤体内部调用**。
     * 它读 Date.now()，在步骤外调用会让「issue 哪些步骤」变成不确定的，
     * 正是文档禁止的那种写法。现在两个调用点都在步骤里：
     * prepare-ref 开头（这个引用还要不要开工）与 transfer 开头（这个目标还搬不搬）。
     *
     * @returns 耗尽原因（给管理员看的文本）；还够用则返回 null
     */
    const budgetExhausted = (): string | null => {
      if (deadlinePassed()) {
        return (
          `本次运行已持续 ${formatDuration(Date.now() - startedMs)}，` +
          `达到单次作业的时间上限（${formatDuration(budget.softDeadlineMs)}）`
        );
      }
      if (budget.jobByteBudget > 0 && budgetBytes >= budget.jobByteBudget) {
        return (
          `本次运行已传输 ${formatBytes(budgetBytes)}，` +
          `达到单次作业的流量上限（${formatBytes(budget.jobByteBudget)}）`
        );
      }

      /**
       * 来不及再搬一趟了
       *
       * estimateTransferMs 在「没有任何实测样本」时返回 0，fitsBeforeDeadline 对 0
       * 一律放行 —— 这条就是前进保证：本次运行的第一趟永远无条件执行，
       * 不会出现「每轮都估着来不及、于是永远备不上」。
       * 而第二趟起之所以敢推迟，是因为下一轮它就是第一个目标（既有的
       * 「只补写缺失目标」自愈路径），到那时会无条件跑。
       */
      const estimateMs = estimateTransferMs(lastArchiveBytes, observedMs > 0 ? observedBytes / observedMs : 0);
      const fit = fitsBeforeDeadline({ estimateMs, nowMs: Date.now(), deadlineAtMs });
      if (!fit.fits) {
        return (
          `按本次实测速度（${formatBytes(Math.round((observedBytes / observedMs) * 1000))}/秒）估算，` +
          `再搬一趟约需 ${formatDuration(estimateMs)}，` +
          `而距本次运行的时间上限只剩 ${formatDuration(Math.max(0, fit.remainingMs))}，来不及`
        );
      }
      return null;
    };

    currentStage = "resolving";
    await report(0);

    let processed = 0;
    let firstError: Error | null = null;
    /** 作业被取消：停止后续引用（与原实现的 break 行为一致） */
    let runCancelled = false;

    // ---------- 4. 逐个引用（分支）备份 ----------
    for (let refIndex = 0; refIndex < backupPlan.length; refIndex += 1) {
      const planItem = backupPlan[refIndex];
      const trackRef = planItem.trackRef;
      // 修改点（P0 水位键错位）：本轮推进水位要用的状态键，与展示用的 trackRef 分开
      const trackingRef = planItem.trackingRef;
      const trackingRefType = planItem.trackingRefType;
      currentRef = trackRef ?? null;
      const itemResult: ItemResult = {
        kind: "repo",
        label: trackRef ? `${repoIdentifier}@${trackRef}` : repoIdentifier,
        status: "processing",
        meta: { refType: trackMode === "branch" ? "branch" : "tag", ref: trackRef },
      };
      itemResults.push(itemResult);

      const refStartedMs = Date.now();
      /** 本引用内出现的可延迟重试计划（修改点：第 2 期），决定这个引用记「失败」还是「已安排重试」 */
      let refDeferral: SerializableDeferral | null = null;

      /**
       * ---------- 4.1 prepare-ref 步骤 ----------
       *
       * 一个引用「要不要备、备哪个版本、往哪几个目标补写、用哪个备份记录」
       * 全在这一个步骤里定下来，并随返回值缓存。这解决了三件事：
       * - 版本解析（GitHub API）不会因为重放被重复请求，额度不白烧；
       * - backupId 由 generateId() 生成，是个不确定值 —— 缓存之后重放拿回同一个，
       *   不会每次重放都 createBackup 出一条新的备份历史（「避免重复写历史」）；
       * - 「补写哪几个目标」是后面 transfer 步骤名的来源，必须确定。
       */
      const prep = await runStepSafely<PrepareRefResult>(
        `prepare-ref:r${refIndex}`,
        META_STEP_CONFIG,
        async () => {
          const result: PrepareRefResult = {
            decision: "failed",
            backupId: null,
            missingMountIds: [],
            doneMountIds: [],
            pathAtMs: Date.now(),
            version: null,
            deferral: null,
            error: null,
            budgetReason: null,
          };

          /**
           * 开工前先看预算（修改点：大仓库备份超 CPU 限制）
           *
           * 到这一步连 GitHub 都还没请求，什么都没做，所以这里只记任务条目留痕，
           * 不往 code_repository_backups 里写「什么都没干」的记录 —— 备份历史是给人
           * 核对快照用的，塞进一堆「没轮到」会把它变成噪音。重试时间由收尾统一交给调度层。
           */
          const refBudgetReason = budgetExhausted();
          if (refBudgetReason) {
            result.decision = "deferred";
            result.budgetReason = refBudgetReason;
            // BudgetExhaustedError 一定可延迟，这里的 ! 只是类型收窄
            result.deferral = toDeferral(new BudgetExhaustedError(refBudgetReason))!;
            console.warn(
              `[RepoBackupTaskHandler] ${repoIdentifier}@${trackRef || ""} 预算用尽，推迟：${refBudgetReason}`,
            );
            return result;
          }

          let backupId: string | null = null;
          try {
            if (await context.isCancelled(job.jobId)) {
              throw new Error("cancelled");
            }

            /**
             * 修改点（第 4 期 需求 4）：有预解析版本时**不发任何 GitHub 请求**。
             *
             * 这一步是本期省额度的关键：原来每个备份周期都要为每个仓库打一次
             * /branches 或 /commits，即使最终判定「无更新」而跳过。现在那次请求
             * 已经在 repo_backup_check 里付过了，结果也落了库，备份阶段只负责下载。
             *
             * 另一个好处是一致性：检测到的 commitSha 与实际下载的归档严格同一个
             *（openSourceArchive 用 commitSha 拼 codeload 直链），不会因为两次解析
             * 之间分支又有新提交而拿到对不上的内容。
             */
            const version = planItem.preresolved
              ? {
                  refType: planItem.preresolved.refType,
                  ref: planItem.preresolved.ref,
                  commitSha: planItem.preresolved.commitSha,
                  version:
                    planItem.preresolved.version ??
                    `${planItem.preresolved.ref ?? ""}@${planItem.preresolved.commitSha.slice(0, 7)}`,
                  publishedAt: planItem.preresolved.publishedAt ?? null,
                }
              : await providerInstance.resolveLatestVersion({
                  repoIdentifier,
                  trackMode,
                  trackRef: trackRef ?? null,
                  // 修改点（第 1 期请求数量优化）：把本轮要解析的引用总数告诉 provider，
                  // 多分支时它会改用 1 次 /branches 批量请求代替 N 次单分支请求
                  refCount: backupPlan.length,
                });

            result.version = {
              refType: version.refType,
              ref: version.ref ?? null,
              commitSha: version.commitSha,
              version: version.version ?? null,
              publishedAt: version.publishedAt ?? null,
            };

            // 3.2 去重：仅当「所有目标都已有该 commit 的成功副本」且非强制时才跳过
            //     修改点（多备份目标优化）：任一目标缺副本都要重跑，保证自愈
            const existing = await codeRepo.findBackupByCommit(repoRow.id, version.commitSha);
            let missingMounts = mounts;

            if (existing) {
              if (force) {
                missingMounts = mounts;
              } else {
                const existingTargets = await codeRepo.findTargetsByBackup(existing.id);
                const doneMountIds = new Set(
                  existingTargets.filter((t: any) => t.status === "success").map((t: any) => String(t.mount_id)),
                );
                missingMounts = mounts.filter((m) => !doneMountIds.has(String(m.id)));
                result.doneMountIds = mounts
                  .filter((m) => doneMountIds.has(String(m.id)))
                  .map((m) => String(m.id));

                if (missingMounts.length === 0) {
                  /**
                   * 修改点（第 4 期）：所有目标都已有该版本的副本 —— 这说明水位落后于事实。
                   * 正常链路不会走到这里（检测阶段就会判定「无更新」而不创建备份任务），
                   * 能走到说明是以下几种情况之一：
                   *   · 迁移回填时这个引用没有成功备份记录可取（例如 ref 名变过）
                   *   · 用户手动强制备份过一次，水位没跟上
                   *   · 并发：两个备份任务备同一个 commit
                   * 不在这里把水位补上，下一轮检测还会判「有更新」，于是永远在这条
                   * 「创建任务 → 发现已存在 → 跳过」的空转上打转。
                   */
                  await advanceBackedUpWatermark(
                    codeRepo,
                    repoRow.id,
                    // 修改点（P0 水位键错位）：用跟踪键，不用 provider 解析出的具体 Tag。
                    // 这里原先传 `version.ref ?? trackRef`，release 模式跟踪「最新」时
                    // 会把水位写到一行全新的 ref='v9.9.9' 上，跟踪行永远不更新
                    trackingRefType,
                    trackingRef,
                    version.commitSha,
                    // 修改点（正常跳过时的状态一致性）：这次跳过恰好证明了
                    // 「当前版本就是已备份的那个版本」，把它记成一次成功检测，
                    // 仓库管理页才会和任务列表一样显示「已是最新」而不是「成功完成」
                    { markDetected: true, repoRow },
                  );

                  result.decision = "up_to_date";
                  console.log(`[RepoBackupTaskHandler] 跳过重复备份: ${repoIdentifier} @ ${version.commitSha}`);
                  return result;
                }
              }
            }

            if (missingMounts.length < mounts.length) {
              console.log(
                `[RepoBackupTaskHandler] 上次备份有 ${mounts.length - missingMounts.length} 个目标已完成，本次只补写剩余目标`,
              );
            }

            // 3.3 创建/复用备份记录
            // 注意：(repository_id, commit_sha) 上有唯一索引，force 重跑时必须复用原记录而非新插入
            const startedAt = nowIso();
            if (existing) {
              backupId = existing.id;
              await codeRepo.updateBackup(backupId, {
                status: "running",
                ref_type: version.refType,
                ref: version.ref,
                version: version.version,
                job_id: job.jobId,
                error_message: null,
                started_at: startedAt,
                finished_at: null,
              });
            } else {
              backupId = generateId("bk");
              await codeRepo.createBackup({
                id: backupId,
                repository_id: repoRow.id,
                ref_type: version.refType,
                ref: version.ref,
                commit_sha: version.commitSha,
                version: version.version,
                status: "running",
                job_id: job.jobId,
                started_at: startedAt,
              });
            }

            result.decision = "transfer";
            result.backupId = backupId;
            result.missingMountIds = missingMounts.map((m) => String(m.id));
            return result;
          } catch (error: any) {
            // 修改点（第 2 期 错误分类）：先排除「任务被取消」。
            // 传输停滞看门狗触发的 abort 现在被归类为「暂时性错误」，如果任务其实已经
            // 被取消，就不能按可重试处理，否则会安排一次没人想要的延迟重试。
            const cancelled =
              String(error?.message || "").toLowerCase() === "cancelled" ||
              (await Promise.resolve(context.isCancelled(job.jobId)).catch(() => false));
            const message = cancelled ? "备份已取消" : String(error?.message || error || "未知错误");
            result.error = message;
            result.backupId = backupId;

            // 修改点（第 2 期 限流 = 延迟，不是失败）：
            // 限流 / 超时 / 5xx 这类错误会自己好，既不该写进失败历史，也不该累计失败数，
            // 只记下「最早可以重试的时间」，本轮结束后交给调度层安排延迟重试。
            const deferral = cancelled ? null : toDeferral(error);

            if (deferral) {
              const retryAtText = describeRetryAt(deferral.retryAtMs);

              if (backupId) {
                // 已经建好的记录不能留在 running（会永久挡住下一次定时备份），
                // 但绝不能写 failed —— 记 deferred，表示「本次没备份，已安排重试」
                // 修改点（状态显示不一致修复）：原先是 skipped，与「无需备份」共用同一个值
                await codeRepo
                  .updateBackup(backupId, {
                    status: "deferred",
                    error_message: `本次未能完成，已安排在 ${retryAtText} 自动重试：${message}`,
                    finished_at: nowIso(),
                  })
                  .catch((e: any) =>
                    console.warn("[RepoBackupTaskHandler] 更新延迟记录失败:", e?.message || e),
                  );
              } else {
                // 修改点（备份历史缺记录）：解析版本阶段就延迟时，原先**一条记录都不写**
                // （当时的理由是「写进备份历史只会污染它」—— 那是只有 failed/skipped 两种
                // 取值时的取舍）。结果是任务列表里明明有「跳过」，点开该仓库的备份历史
                // 却什么都没有，用户无法核对「这次到底有没有尝试过备份」。
                // 现在 deferred 是一个独立且明确的非失败状态，补一条留痕才说得通：
                // 它记录的是「这次尝试没有产生任何快照，已安排在 X 之后重试」。
                await codeRepo
                  .createBackup({
                    id: generateId("bk"),
                    repository_id: repoRow.id,
                    ref_type: trackMode === "branch" ? "branch" : "tag",
                    ref: trackRef ?? null,
                    // 占位 commit_sha：真 sha 要等解析成功才有，DTO 读取时会还原为 null
                    commit_sha: buildUnresolvedCommitSha(),
                    version: null,
                    status: "deferred",
                    job_id: job.jobId,
                    error_message: `本次未能完成，已安排在 ${retryAtText} 自动重试：${message}`,
                    started_at: new Date(refStartedMs).toISOString(),
                    finished_at: nowIso(),
                  })
                  .catch((e: any) =>
                    console.warn("[RepoBackupTaskHandler] 写入延迟留痕记录出错:", e?.message || e),
                  );
              }

              result.decision = "deferred";
              result.deferral = deferral;
              // 不写 last_error：限流不是这个仓库的问题，留给收尾统一写「已安排重试」的说明
              console.warn(
                `[RepoBackupTaskHandler] 备份被推迟: ${repoIdentifier}@${trackRef || ""} ${message}`,
              );
              return result;
            }

            if (backupId) {
              await codeRepo
                .updateBackup(backupId, {
                  status: cancelled ? "skipped" : "failed",
                  error_message: message,
                  finished_at: nowIso(),
                })
                .catch((e: any) => console.warn("[RepoBackupTaskHandler] 更新备份记录失败:", e?.message || e));
            } else {
              // 修改点（历史记录需显示失败记录）：
              // 解析版本阶段就失败时（限流、网络不通、分支不存在）原本一条记录都不会写，
              // 备份历史里因此永远只看到成功的版本。这里补一条失败留痕，
              // commit_sha 用占位值绕过 NOT NULL + 唯一索引，DTO 读取时会还原为 null。
              await codeRepo
                .createBackup({
                  id: generateId("bk"),
                  repository_id: repoRow.id,
                  ref_type: trackMode === "branch" ? "branch" : "tag",
                  ref: trackRef ?? null,
                  commit_sha: buildUnresolvedCommitSha(),
                  version: null,
                  status: cancelled ? "skipped" : "failed",
                  job_id: job.jobId,
                  error_message: message,
                  started_at: new Date(refStartedMs).toISOString(),
                  finished_at: nowIso(),
                })
                .catch((e: any) => console.warn("[RepoBackupTaskHandler] 写入失败留痕记录出错:", e?.message || e));
            }

            await codeRepo
              .updateRepository(repoRow.id, { last_error: message })
              .catch((e: any) => console.warn("[RepoBackupTaskHandler] 更新仓库状态失败:", e?.message || e));

            result.decision = cancelled ? "cancelled" : "failed";
            console.error(`[RepoBackupTaskHandler] 备份失败: ${repoIdentifier}@${trackRef || ""}`, message);
            return result;
          }
        },
        (message) => ({
          decision: "failed",
          backupId: null,
          missingMountIds: [],
          doneMountIds: [],
          pathAtMs: Date.now(),
          version: null,
          deferral: null,
          error: `准备阶段步骤异常退出：${message}`,
          budgetReason: null,
        }),
      );

      // 步骤外只做累加，输入全部来自已缓存的返回值 → 重放可重现
      if (prep.deferral) {
        noteDeferral(prep.deferral);
        refDeferral = prep.deferral;
      }

      const version = prep.version;

      // 修改点（详情完善）：targets 记录每个目标的写入结果，供任务详情逐条展示
      // 修改点（状态显示不一致修复）：新增 "deferred" —— 目标撞上限流时既不能记
      // success 也不能记 failed，它属于「本次没写成，已安排重试」
      const targetSummaries: Array<{
        mountId: string;
        name: string | null;
        mountPath: string | null;
        status: "pending" | "processing" | "success" | "failed" | "skipped" | "deferred";
        sizeBytes?: number | null;
        error?: string | null;
      }> = mounts.map((m) => ({
        mountId: String(m.id),
        name: m.name ?? null,
        mountPath: m.mount_path ?? null,
        // 已有副本的目标在详情里标为「跳过」，与本次要补写的目标区分开
        status: prep.doneMountIds.includes(String(m.id)) ? "skipped" : "pending",
      }));
      const summaryOf = (mountId: any) => targetSummaries.find((t) => t.mountId === String(mountId));

      if (version) {
        itemResult.meta = {
          refType: version.refType,
          ref: version.ref,
          commitSha: version.commitSha,
          version: version.version,
          targets: targetSummaries,
        };
      }

      // ---------- 4.2 prepare 的非 transfer 结论，各自收尾 ----------
      if (prep.decision === "up_to_date") {
        itemResult.status = "skipped";
        // 修改点（状态显示不一致修复）：这是「已是最新、无需备份」，属于成功结果，
        // 不是失败；用统一词汇标出来，前端据此显示「已是最新」而不是红字
        itemResult.meta = {
          ...(itemResult.meta || {}),
          outcome: REPO_OUTCOME.UP_TO_DATE,
        };
        itemResult.message = `已存在该版本的备份（${version?.version ?? ""}），跳过`;
        itemResult.durationMs = Date.now() - refStartedMs;
        outcomes.push({ ref: version?.ref ?? trackRef ?? null, status: "skipped" });
        processed += 1;
        await report(processed);
        continue;
      }

      if (prep.decision === "deferred") {
        const retryAtText = prep.deferral ? describeRetryAt(prep.deferral.retryAtMs) : "稍后";
        itemResult.status = "skipped";
        itemResult.message = prep.budgetReason
          ? `${prep.budgetReason}，本引用留到下一轮（${retryAtText}）继续`
          : `已延迟重试（${describeErrorKind(prep.deferral?.kind || "")}，重试时间 ${retryAtText}）：${prep.error || ""}`;
        itemResult.durationMs = Date.now() - refStartedMs;
        itemResult.meta = {
          ...(itemResult.meta || {}),
          outcome: REPO_OUTCOME.DEFERRED,
          retryAt: retryAtText,
        };
        outcomes.push({ ref: version?.ref ?? trackRef ?? null, status: "deferred" });
        processed += 1;
        await report(processed);
        continue;
      }

      if (prep.decision === "cancelled" || prep.decision === "failed") {
        const cancelled = prep.decision === "cancelled";
        const message = prep.error || "未知错误";
        itemResult.status = cancelled ? "skipped" : "failed";
        itemResult.error = message;
        itemResult.durationMs = Date.now() - refStartedMs;
        // 修改点（状态显示不一致修复）：取消是「被阻止」，真错误才是「失败」
        itemResult.meta = {
          ...(itemResult.meta || {}),
          outcome: cancelled ? REPO_OUTCOME.BLOCKED : REPO_OUTCOME.FAILED,
        };
        outcomes.push({
          ref: version?.ref ?? trackRef ?? null,
          status: cancelled ? "skipped" : "failed",
          error: message,
        });
        if (!cancelled && !firstError) firstError = new Error(message);
        if (cancelled) runCancelled = true;
        processed += 1;
        await report(processed);
        if (runCancelled) {
          console.log("[RepoBackupTaskHandler] 任务已取消，停止后续引用");
          break;
        }
        continue;
      }

      // 走到这里 decision === "transfer"，backupId 与 version 必然有值
      const backupId = prep.backupId as string;
      const resolvedVersion = version as NonNullable<PrepareRefResult["version"]>;

      // ---------- 4.3 逐个目标写入，每个组合一个独立步骤 ----------
      const targetErrors: string[] = [];
      /**
       * 因预算用尽而没轮到的目标说明（修改点：大仓库备份超 CPU 限制）
       *
       * 与 targetErrors 分开装，因为两者的去向不同：
       * targetErrors 会写进 code_repositories.last_error，前端看到它非空就渲染红色失败；
       * 而「没轮到」是设计内的正常流程，大仓库每轮都会出现，
       * 混进 last_error 会让这类仓库长期显示成故障。它只进备份记录的 error_message
       * 与任务条目说明 —— 能查到，但不报警。
       */
      const budgetNotes: string[] = [];
      let successTargets = 0;
      let attemptedTargets = 0;
      /**
       * 本次写入成功的第一个目标（修改点：阶段 2 拆分 Workflow 步骤）
       *
       * 备份记录的「主路径」原先优先取本次写入的那个，只有补写场景
       * （本次一个都没写、靠历史副本凑齐）才回退到已有的目标行。
       * 拆分后 finalize-ref 是独立步骤、只能看 D1，所以这个偏好必须显式传进去 ——
       * 否则多目标时主路径会变成「D1 返回的第一行」，与改动前选中的目标不一样。
       */
      let runPrimary: { storagePath: string; manifestPath: string | null; sizeBytes: number | null } | null = null;

      for (let mountIndex = 0; mountIndex < mounts.length; mountIndex += 1) {
        const mount = mounts[mountIndex];
        // 本次要补写哪些目标由 prepare-ref 定下并缓存 → 步骤集合完全确定
        if (!prep.missingMountIds.includes(String(mount.id))) continue;

        /**
         * 取消检查放在步骤之外（修改点：阶段 2 拆分 Workflow 步骤）
         *
         * 严格说这是个「步骤外的不确定条件」，但它是**单调**的：一旦取消就永远取消，
         * 只可能让步骤变少、绝不会变成另一组步骤。而且取消本就应该立刻生效，
         * 不该等下一个步骤跑完。真相始终在 D1 里（finalize-ref 按目标行重算结论），
         * 所以少跑几个步骤不会得出错误结果。
         */
        if (await context.isCancelled(job.jobId)) {
          runCancelled = true;
          break;
        }

        attemptedTargets += 1;
        const label = mount.name || mount.mount_path;
        currentTarget = { name: mount.name ?? null, mountPath: mount.mount_path ?? null };
        currentStage = "transferring";

        const transfer = await runStepSafely<TransferResult>(
          `transfer:r${refIndex}:m${mountIndex}`,
          TRANSFER_STEP_CONFIG,
          async () => {
            const outcome: TransferResult = {
              status: "failed",
              mountId: String(mount.id),
              label: String(label),
              storagePath: null,
              manifestPath: null,
              manifestWarning: null,
              sizeBytes: null,
              bytes: 0,
              transferMs: 0,
              error: null,
              deferral: null,
              budgetReason: null,
            };

            /**
             * 领下一个目标之前先看预算（修改点：大仓库备份超 CPU 限制）
             *
             * 这是最关键的一道口子：多目标的代价是「每个目标都要把整个归档重新拉一遍」，
             * 一个 354MB 的仓库写三个目标就是三趟 354MB。前面的目标跑完之后预算往往
             * 已经见底，此时领下一个目标必然撞上 CPU / 步骤超时 —— 而撞上就什么都留不下。
             *
             * 这里记 deferred（不是 failed）：已写成功的目标照常落库，
             * 下一轮 prepare-ref 的去重逻辑会发现「只缺这几个目标」并只补写它们，
             * 即既有的自愈路径，不需要为此另写一套续传。
             *
             * 修改点（阶段 2）：判定移到步骤**内部**，结论随返回值缓存 ——
             * 否则「这个目标跑不跑」在重放时会变，步骤集合就不确定了。
             */
            const targetBudgetReason = budgetExhausted();
            if (targetBudgetReason) {
              outcome.status = "deferred";
              outcome.budgetReason = targetBudgetReason;
              outcome.deferral = toDeferral(new BudgetExhaustedError(targetBudgetReason))!;

              await codeRepo
                .upsertBackupTarget({
                  id: generateId("bkt"),
                  backup_id: backupId,
                  mount_id: mount.id,
                  mount_path: mount.mount_path,
                  status: "deferred",
                  error_message: targetBudgetReason,
                })
                .catch((e: any) =>
                  console.warn("[RepoBackupTaskHandler] 记录目标延迟状态出错:", e?.message || e),
                );

              console.warn(`[RepoBackupTaskHandler] 目标未轮到（${label}）：${targetBudgetReason}`);
              return outcome;
            }

            /**
             * 修改点（阶段 2 拆分 Workflow 步骤）：目录时间戳改用 prepare-ref 缓存的时刻
             *
             * planBackupPaths 默认 `at = new Date()`，而目录名里带时间戳
             * （`时间__分支__sha`）。拆分之后这个步骤会被重试、也会在实例重放时
             * 重新执行，用「当前时刻」就会每次落到一个**新目录**里 ——
             * 那正是本阶段必须避免的「重复上传 / 重复生成 manifest」。
             * 改用 prep.pathAtMs（已缓存）之后，同一个组合无论跑几次都落在同一个路径上，
             * 覆盖写而不是多留一份。路径格式一个字没改，dedupeBackupDirs 仍作兜底。
             */
            const paths = planBackupPaths({
              mountPath: mount.mount_path,
              pathPrefix: repoRow.target_path_prefix,
              provider,
              repoIdentifier,
              commitSha: resolvedVersion.commitSha,
              ref: resolvedVersion.ref,
              at: new Date(prep.pathAtMs),
            });

            // 修改点（任务卡住排查）：传输护栏必须在发起请求前创建，
            // 它的 signal 要交给 provider，才能在停滞时把整个响应中止掉
            // 修改点（大仓库备份超 CPU 限制）：停滞阈值与体积上限都取自本次作业的预算
            const guard = createTransferGuard({
              stallTimeoutMs: budget.stallTimeoutMs,
              maxBytes: budget.maxArchiveBytes,
              onProgress: (bytes) => {
                // 只补 bytesTransferred 这一个字段，避免与 report() 的完整快照互相覆盖；
                // 失败不影响传输（updateProgress 在 Workers 下是异步 D1 写）
                Promise.resolve(
                  context.updateProgress(job.jobId, { bytesTransferred: bytesTransferred + bytes }),
                ).catch(() => {});
              },
            });

            try {
              // createDirectory 对已存在目录是幂等的（返回 alreadyExists）
              // 修改点（备份目录按分支分层）：直接建「本次备份的专属目录」，
              // 其上层（仓库目录 / 分支目录）由驱动的多级创建一并带出；
              // 创建失败不回滚：归档与 manifest 都要落在这个目录里，后续 uploadFile 会再兜一次
              try {
                await fileSystem.createDirectory(paths.backupDirPath, job.userId, job.userType);
              } catch (dirError: any) {
                // 部分对象存储没有真实目录概念，创建失败不影响后续写入
                console.warn(
                  `[RepoBackupTaskHandler] 创建目录失败（继续尝试上传）: ${paths.backupDirPath}`,
                  dirError?.message || dirError,
                );
              }

              console.log(
                `[RepoBackupTaskHandler] 开始备份 ${repoIdentifier}@${resolvedVersion.ref || ""} ${resolvedVersion.version} -> ${paths.archivePath}`,
              );

              await report(processed);

              const archive = await providerInstance.openSourceArchive({
                repoIdentifier,
                refType: resolvedVersion.refType,
                ref: resolvedVersion.ref,
                commitSha: resolvedVersion.commitSha,
                signal: guard.signal,
              });

              // 拿到响应之后才启动停滞看门狗：
              // 「等响应头」那一段由 provider 自己的超时 + 重试负责，两者职责不重叠，
              // 报错信息也才对得上（超时 vs 传输停滞）
              guard.arm();
              const countedStream = guard.wrap(archive.stream);
              const counter = guard.counter;

              let uploadResult: any;
              /**
               * 只掐「真的在搬字节」这一段（修改点：大仓库备份 CPU/耗时优化）
               *
               * 不从 openSourceArchive 开始计时：那一段可能包含限流退避与重试等待，
               * 把它算进吞吐会让速度被严重低估，于是后面的目标被过度推迟。
               * 建目录、写 manifest 这些固定开销同样不计入，由 fitsBeforeDeadline
               * 的余量系数一并兜住。
               */
              const transferStartedMs = Date.now();
              try {
                uploadResult = await fileSystem.uploadFile(
                  paths.archivePath,
                  countedStream,
                  job.userId,
                  job.userType,
                  {
                    filename: paths.archiveFileName,
                    contentType: archive.contentType || "application/gzip",
                    // GitHub tarball 通常是 chunked 无 content-length，此时传 0 表示未知，
                    // 上游的配额守卫会跳过 best-effort 判断，S3 走 lib-storage 自动分片
                    contentLength: archive.contentLength || 0,
                    /**
                     * 修改点（大仓库备份 CPU/耗时优化）：把分片上传并发提到 2
                     *
                     * S3 驱动默认在 Workers 下用 queueSize = 1，而 lib-storage 的
                     * queueSize 同时是**消费源流的并发度** —— 只有 1 个消费者时它必须
                     * 「读满一片 → 传完这一片 → 再读下一片」，下载与上传完全串行，
                     * 单趟 wall-clock ≈ 下载 + 上传。备份搬的是几百 MB 的归档，
                     * 串行会让一次运行能完成的目标数直接腰斩。
                     * 该字段只有 S3 驱动认（其余驱动忽略多余的 option），
                     * 0 表示不覆盖，此时行为与改动前完全一致。
                     */
                    uploadTuning:
                      budget.uploadQueueSize > 0 ? { queueSize: budget.uploadQueueSize } : undefined,
                  },
                );
              } catch (uploadError: any) {
                /**
                 * 体积超限优先判（修改点：大仓库备份超 CPU 限制）
                 *
                 * 护栏掐断时底层报的是 stream/abort 错误，必须换成真实原因，
                 * 否则管理员看到的是一句莫名其妙的 "aborted"。
                 * 这里抛**永久性**错误：这个仓库在当前环境下就是传不动，
                 * 安排重试只会每轮都白拉一遍几 GB 的流量。
                 */
                if (guard.isOversize()) {
                  throw new ArchiveTooLargeError(
                    `归档体积超过单次备份上限 ${formatBytes(budget.maxArchiveBytes)}` +
                      `（传输到 ${formatBytes(counter.value)} 时中止）。` +
                      `如确需备份该仓库，请调大 REPO_BACKUP_MAX_ARCHIVE_MB，或改用 Docker/Node 部署`,
                  );
                }
                // 看门狗触发时底层报的是 abort/stream 错误，换成人看得懂的原因
                // 修改点（大仓库备份超 CPU 限制）：这里原先抛的是普通 Error，
                // 会被 classifyRepoBackupError 判成永久性错误 —— 与本文件
                // 「传输停滞属于暂时性错误」的设计说明不符，连接抽风被记成了备份失败。
                // 改抛 TransientError，让它真正落进「可延迟重试」类别。
                if (guard.isStalled()) {
                  throw new TransientError(
                    `传输停滞超过 ${Math.round(budget.stallTimeoutMs / 1000)} 秒` +
                      `（已传 ${formatBytes(counter.value)}）已中止，可能是 GitHub 或加速代理无响应`,
                  );
                }
                throw uploadError;
              } finally {
                guard.dispose();
                // 修改点（大仓库备份超 CPU 限制）：成功与否都要计入本次作业的流量预算 ——
                // 失败的那一趟同样花掉了 CPU 与带宽，不记的话预算就形同虚设
                // 修改点（阶段 2）：改为随返回值交给步骤外累加，理由见 budgetBytes 的注释
                outcome.bytes = counter.value;
              }

              const sizeBytes = counter.value > 0 ? counter.value : null;

              /**
               * 记一条吞吐样本（修改点：大仓库备份 CPU/耗时优化）
               *
               * 只在传输**成功走完**时记：失败那趟的字节数是半截的、耗时却可能很长
               * （停滞要等满看门狗阈值），拿它算速度会把后续目标全判成「来不及」。
               * 失败趟的流量仍然计入 bytes（在上面的 finally 里），两者口径不同：
               * 预算问「花掉了多少」，吞吐问「正常情况下多快」。
               */
              const transferMs = Date.now() - transferStartedMs;
              if (counter.value > 0 && transferMs > 0) {
                outcome.transferMs = transferMs;
              }

              // manifest 是归档旁的便利副本，元信息在数据库记录中已完整保存。
              // 这里不因它失败而判定该目标失败，但必须把问题暴露给管理员。
              let manifestPath: string | null = null;
              let manifestWarning: string | null = null;
              try {
                currentStage = "manifest";
                const manifest = this.buildManifest({
                  provider,
                  repoIdentifier,
                  repoRow,
                  version: resolvedVersion,
                  backupId,
                  jobId: job.jobId,
                  archive: {
                    path: uploadResult?.storagePath || paths.archivePath,
                    fileName: paths.archiveFileName,
                    contentType: archive.contentType || "application/gzip",
                    sizeBytes,
                  },
                  mount,
                });
                const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
                await fileSystem.uploadFile(paths.manifestPath, manifestBytes, job.userId, job.userType, {
                  filename: paths.manifestFileName,
                  contentType: "application/json",
                  contentLength: manifestBytes.byteLength,
                });
                manifestPath = paths.manifestPath;
              } catch (manifestError: any) {
                manifestWarning = `manifest 写入失败: ${manifestError?.message || String(manifestError)}`;
                console.warn(`[RepoBackupTaskHandler] ${manifestWarning}`);
              }

              const storagePath = uploadResult?.storagePath || paths.archivePath;

              // 修改点（多备份目标优化）：每个目标单独记录结果
              await codeRepo.upsertBackupTarget({
                id: generateId("bkt"),
                backup_id: backupId,
                mount_id: mount.id,
                mount_path: mount.mount_path,
                storage_path: storagePath,
                manifest_path: manifestPath,
                size_bytes: sizeBytes,
                status: "success",
                error_message: manifestWarning,
              });

              outcome.status = "success";
              outcome.sizeBytes = sizeBytes;
              outcome.storagePath = storagePath;
              outcome.manifestPath = manifestPath;
              outcome.manifestWarning = manifestWarning;

              console.log(`[RepoBackupTaskHandler] 目标写入完成: ${storagePath}`);

              /**
               * 收掉同分支同 sha 的重复目录（修改点：同分支同 sha 只保留一个目录）
               *
               * 为什么放在「这个目标刚写完」而不是统一收尾：
               * - 分支目录路径带挂载点前缀，本来就得逐挂载点扫一遍；
               * - 写完就扫，哪怕后面的目标撞上预算用尽、或整个 isolate 被 CPU 限制杀掉，
               *   已经写完的这个挂载点也已经是干净的了。
               *
               * 保护名单（referencedDirs）在 upsertBackupTarget **之后**才查 ——
               * 这样本次刚写的目录必然在名单里，绝不会被自己的去重删掉。
               *
               * 时间上限已过就不扫了：和旧版本清理同一个理由，它是一串网络往返，
               * 在快撞上步骤超时的时候开这个头很可能半途被打断；而重复目录多留一轮毫无影响，
               * 下一次该分支备份成功后照样会扫。
               */
              if (deadlinePassed()) {
                console.warn("[RepoBackupTaskHandler] 本次运行已达时间上限，跳过重复目录去重（下一轮继续）");
              } else {
                try {
                  const referencedDirs = toReferencedDirs(await codeRepo.findReferencedPaths(repoRow.id));
                  await dedupeBackupDirs({
                    fileSystem,
                    refDirPath: paths.refDirPath,
                    referencedDirs,
                    userId: job.userId,
                    userType: job.userType,
                  });
                } catch (dedupeError: any) {
                  // 去重是收拾现场，失败绝不能改变备份结论（本目标已经写成功了）
                  console.warn(
                    "[RepoBackupTaskHandler] 重复目录去重失败（不影响备份结论）:",
                    dedupeError?.message || dedupeError,
                  );
                }
              }

              return outcome;
            } catch (targetError: any) {
              guard.dispose();
              // 单个目标失败不影响其他目标；下次运行会自动补写
              const message = String(targetError?.message || targetError || "未知错误");

              // 修改点（第 2 期 错误分类）：先判断这个目标的失败是不是「限流 / 暂时性」。
              // 是的话本轮不能以失败收尾——目标行记 deferred（而不是 failed），
              // 并记下重试时间，由本轮收尾统一把延迟交给调度层。
              // 修改点（状态显示不一致修复）：这里原先写 skipped，与「无需备份」混为一谈，
              // 前端两个页面各自解读成「跳过」和「失败」。改用独立的 deferred。
              const targetDeferral = toDeferral(targetError);
              outcome.status = targetDeferral ? "deferred" : "failed";
              outcome.error = message;
              outcome.deferral = targetDeferral;

              await codeRepo
                .upsertBackupTarget({
                  id: generateId("bkt"),
                  backup_id: backupId,
                  mount_id: mount.id,
                  mount_path: mount.mount_path,
                  status: targetDeferral ? "deferred" : "failed",
                  error_message: message,
                })
                .catch((e: any) =>
                  console.warn("[RepoBackupTaskHandler] 记录目标失败状态出错:", e?.message || e),
                );

              console.error(
                `[RepoBackupTaskHandler] 目标写入${targetDeferral ? "被推迟" : "失败"} (${label}):`,
                message,
              );
              return outcome;
            }
          },
          (message) => ({
            status: "failed",
            mountId: String(mount.id),
            label: String(label),
            storagePath: null,
            manifestPath: null,
            manifestWarning: null,
            sizeBytes: null,
            bytes: 0,
            transferMs: 0,
            error: `传输步骤异常退出：${message}`,
            deferral: null,
            budgetReason: null,
          }),
        );

        /**
         * 步骤外累加（修改点：阶段 2 拆分 Workflow 步骤）
         *
         * 全部只依赖 transfer 这个已缓存的返回值，所以重放时会一字不差地重新算出来。
         * 这些量原先是在传输代码里就地 += 的，拆分后必须搬到这里 ——
         * 否则重放时步骤体根本不执行（直接回灌缓存），累加就全丢了。
         */
        budgetBytes += transfer.bytes;
        if (transfer.status === "success") {
          successTargets += 1;
          totalBytes += transfer.sizeBytes ?? 0;
          bytesTransferred += transfer.bytes;
          if (transfer.transferMs > 0 && transfer.bytes > 0) {
            observedBytes += transfer.bytes;
            observedMs += transfer.transferMs;
            lastArchiveBytes = transfer.bytes;
          }
          if (!runPrimary && transfer.storagePath) {
            runPrimary = {
              storagePath: transfer.storagePath,
              manifestPath: transfer.manifestPath,
              sizeBytes: transfer.sizeBytes,
            };
          }
          if (transfer.manifestWarning) {
            targetErrors.push(`${transfer.label}: ${transfer.manifestWarning}`);
          }
        } else if (transfer.budgetReason) {
          budgetNotes.push(`${transfer.label}: ${transfer.budgetReason}，已安排下一轮补写`);
        } else if (transfer.deferral) {
          targetErrors.push(
            `${transfer.label}: 已延迟重试（${describeErrorKind(transfer.deferral.kind)}）${transfer.error || ""}`,
          );
        } else {
          targetErrors.push(`${transfer.label}: ${transfer.error || "未知错误"}`);
        }

        if (transfer.deferral) {
          noteDeferral(transfer.deferral);
          if (!refDeferral) refDeferral = transfer.deferral;
        }

        const targetSummary = summaryOf(mount.id);
        if (targetSummary) {
          targetSummary.status = transfer.status;
          targetSummary.sizeBytes = transfer.sizeBytes;
          targetSummary.error = transfer.budgetReason
            ? `本次未轮到：${transfer.budgetReason}`
            : transfer.deferral
              ? `已安排自动重试：${transfer.error || ""}`
              : transfer.status === "success"
                ? transfer.manifestWarning
                : transfer.error;
        }

        await report(processed);
      }

      currentTarget = { name: null, mountPath: null };

      /**
       * ---------- 4.4 finalize-ref 步骤 ----------
       *
       * 这个引用的最终结论**不看本次写入结果，而是重新按「该备份的全部目标行」算**
       * （原实现就是这样，拆分后这一点更关键）：目标行在 D1 里是唯一真相，
       * 所以「上次部分失败、本次补写成功」能正确收敛为 success，
       * 而「某个 transfer 步骤被跳过或被杀掉」也不会让结论算错。
       */
      const fin = await runStepSafely<FinalizeRefResult>(
        `finalize-ref:r${refIndex}`,
        META_STEP_CONFIG,
        async () => {
          const finishedAt = nowIso();

          // 修改点（多备份目标优化）：按「该备份的全部目标行」重算状态，
          // 而不是只看本次写入结果 —— 这样"上次部分失败、本次补写成功"能正确收敛为 success
          const allTargets = await codeRepo.findTargetsByBackup(backupId);
          const okMountIds = new Set(
            allTargets.filter((t: any) => t.status === "success").map((t: any) => String(t.mount_id)),
          );
          const doneCount = mounts.filter((m) => okMountIds.has(String(m.id))).length;
          const anyDone = doneCount > 0;
          const allDone = doneCount === mounts.length;

          const backupWarning = targetErrors.length > 0 ? targetErrors.join("；") : null;
          // 修改点（大仓库备份超 CPU 限制）：「没轮到」的说明单独成句，不进 last_error
          const budgetNote = budgetNotes.length > 0 ? budgetNotes.join("；") : null;

          if (!anyDone) {
            // 所有目标都没有副本
            // 修改点（大仓库备份超 CPU 限制）：可能一个目标都没轮到（预算在本引用之前就见底），
            // 此时 targetErrors 是空的，不能笼统地说「均写入失败」—— 那是在谎报故障
            const message = backupWarning || budgetNote || "所有备份目标均写入失败";

            // 修改点（第 2 期 延迟重试）：写入阶段撞上限流/暂时性故障时不算失败。
            // 记录必须离开 running（否则会挡住下一次定时备份），但绝不能写 failed，
            // 于是记 deferred，并在 error_message 里带上自动重试时间。
            // 修改点（状态显示不一致修复）：原先是 skipped —— 与「无需备份」共用一个值，
            // 前端只能靠猜，任务列表显示「跳过」而仓库管理显示成失败。
            await codeRepo.updateBackup(backupId, {
              status: refDeferral ? "deferred" : "failed",
              error_message: refDeferral
                ? `本次未能完成，已安排在 ${describeRetryAt(refDeferral.retryAtMs)} 自动重试：${message}`
                : message,
              finished_at: finishedAt,
            });

            return {
              status: refDeferral ? "deferred" : "failed",
              doneCount,
              totalTargets: mounts.length,
              primaryStoragePath: null,
              primarySizeBytes: null,
              note: backupWarning,
              warning: refDeferral ? null : backupWarning,
              message,
            } as FinalizeRefResult;
          }

          // 主路径：优先用本次写入的；补写场景下回退到此前已成功的目标
          const primaryRow = allTargets.find((t: any) => t.status === "success" && t.storage_path);
          const primaryStoragePath = runPrimary?.storagePath ?? primaryRow?.storage_path ?? null;
          const primaryManifestPath = runPrimary ? runPrimary.manifestPath : (primaryRow?.manifest_path ?? null);
          const primarySizeBytes = runPrimary ? runPrimary.sizeBytes : (primaryRow?.size_bytes ?? null);

          // 修改点（多备份目标优化）：全部目标有副本 -> success；部分 -> partial
          const status: "success" | "partial" = allDone ? "success" : "partial";

          // 修改点（版本保留优化）：备份成功后清理超出保留数量的最旧版本
          let pruneMessage = "";
          try {
            currentStage = "pruning";
            await report(processed);
            /**
             * 修改点（大仓库备份超 CPU 限制）：软截止已过就不清理了
             *
             * 清理要逐个目标删文件删目录，是一串网络往返，在已经快撞上步骤超时的时候
             * 开这个头很可能半途被打断 —— 而它不是必须现在做的事：
             * 旧版本多留一轮毫无影响，下一次备份成功后照样会清。
             */
            if (deadlinePassed()) {
              console.warn("[RepoBackupTaskHandler] 本次运行已达时间上限，跳过旧版本清理（下一轮继续）");
            } else {
              const pruneSummary = await pruneOldVersions({
                codeRepo,
                fileSystem,
                repositoryRow: repoRow,
                userId: job.userId,
                userType: job.userType,
              });
              pruneMessage = describePruneResult(pruneSummary);
              if (pruneSummary.removedCount > 0) {
                console.log(`[RepoBackupTaskHandler] ${pruneMessage}`);
              }
              for (const err of pruneSummary.errors) {
                console.warn(`[RepoBackupTaskHandler] 版本清理提示: ${err}`);
              }
            }
          } catch (pruneError: any) {
            // 清理失败不影响本次备份结论
            console.warn("[RepoBackupTaskHandler] 版本清理失败:", pruneError?.message || pruneError);
          }

          // 修改点（大仓库备份超 CPU 限制）：budgetNote 进备份记录的 error_message
          // （备份历史里能查到「这个版本还缺哪几个目标、为什么」），但不进 last_error
          const backupNote = [backupWarning, budgetNote, pruneMessage].filter(Boolean).join("；") || null;

          await codeRepo.updateBackup(backupId, {
            status,
            storage_path: primaryStoragePath,
            manifest_path: primaryManifestPath,
            size_bytes: primarySizeBytes,
            error_message: backupNote,
            finished_at: finishedAt,
          });

          await codeRepo.updateRepository(repoRow.id, {
            last_backup_at: finishedAt,
            last_known_commit_sha: resolvedVersion.commitSha,
            // 修改点（状态显示不一致修复）：last_error 只承载**真正的失败原因**。
            // partial 仍要带上警告（目标确实没写全），但整体成功时不再往里写东西 ——
            // 前端只要看到这个字段非空就渲染成红色失败，往里写非失败说明会造成误读。
            last_error: backupWarning,
          });

          /**
           * 修改点（第 4 期）：推进该引用的「已备份水位」
           *
           * 只在 allDone（全部目标都有副本）时推进，partial 时**故意不推进**：
           * 水位一推进，下一轮检测就会判「无更新」而不创建备份任务，
           * 那个写失败的目标就永远补不上了。保持水位落后，下一轮检测照旧判「有更新」，
           * 备份任务跑起来后 prepare-ref 的去重逻辑会识别出「只缺某几个目标」并只补写它们
           * —— 这正是既有的自愈路径，第 4 期不改它，只是别把它掐断。
           */
          if (allDone) {
            await advanceBackedUpWatermark(
              codeRepo,
              repoRow.id,
              trackingRefType,
              // 修改点（P0 水位键错位）：这里原先传 `version.ref ?? trackRef ?? null`，
              // 即 provider 解析出的具体 Tag —— release 模式跟踪「最新」时水位会被写到
              // 一行新建的 ref='v9.9.9' 状态行上，真正的跟踪行 ref='' 永远拿不到水位，
              // 于是每轮检测都判「有更新」→ 反复创建备份任务。改用跟踪键，并带上
              // repoRow 让 advanceBackedUpWatermark 再做一次收敛兜底。
              trackingRef,
              resolvedVersion.commitSha,
              { repoRow },
            );
          }

          return {
            status,
            doneCount,
            totalTargets: mounts.length,
            primaryStoragePath,
            primarySizeBytes,
            note: backupNote,
            warning: backupWarning,
            message: null,
          } as FinalizeRefResult;
        },
        (message) => ({
          status: "failed",
          doneCount: 0,
          totalTargets: mounts.length,
          primaryStoragePath: null,
          primarySizeBytes: null,
          note: null,
          warning: `收尾步骤异常退出：${message}`,
          message: `收尾步骤异常退出：${message}`,
        }),
      );

      if (fin.status === "failed" || fin.status === "deferred") {
        const message = fin.message || "所有备份目标均写入失败";
        itemResult.status = fin.status === "deferred" ? "skipped" : "failed";
        if (fin.status === "deferred" && refDeferral) {
          itemResult.message = `已延迟重试（${describeErrorKind(refDeferral.kind)}，重试时间 ${describeRetryAt(refDeferral.retryAtMs)}）：${message}`;
        } else {
          itemResult.error = message;
        }
        // 修改点（状态显示不一致修复）：延迟重试不是失败，用统一词汇标出来，
        // 任务详情才能把它显示成「已延迟重试」而不是笼统的「跳过」
        itemResult.meta = {
          ...(itemResult.meta || {}),
          outcome: fin.status === "deferred" ? REPO_OUTCOME.DEFERRED : REPO_OUTCOME.FAILED,
          retryAt: fin.status === "deferred" && refDeferral ? describeRetryAt(refDeferral.retryAtMs) : null,
        };
        itemResult.durationMs = Date.now() - refStartedMs;
        outcomes.push({
          ref: resolvedVersion.ref ?? trackRef ?? null,
          status: fin.status === "deferred" ? "deferred" : "failed",
          error: fin.status === "deferred" ? undefined : message,
        });
        if (fin.status === "failed" && !firstError) firstError = new Error(message);
        processed += 1;
        await report(processed);
        if (runCancelled) {
          console.log("[RepoBackupTaskHandler] 任务已取消，停止后续引用");
          break;
        }
        continue;
      }

      const allDone = fin.status === "success";

      // 部分目标成功时：备份记录记为 partial（历史里能看出哪些目标缺副本），
      // 但任务条目仍记为 failed —— 用户要求"写入全部目标"，没写全就不算成功
      //
      // 修改点（大仓库备份超 CPU 限制）：没写全的原因要分开看 ——
      // 真有目标写挂了（targetErrors 非空）才是 failed；
      // 如果只是本次预算用尽、剩下的目标留到下一轮，那是「还没干完」而不是「干坏了」，
      // 记 skipped。大仓库每轮都会走这条路，记成 failed 会让它永远显示红色。
      itemResult.status = allDone ? "success" : targetErrors.length > 0 ? "failed" : "skipped";
      itemResult.targetPath = fin.primaryStoragePath || undefined;
      itemResult.fileSize = fin.primarySizeBytes ?? undefined;
      itemResult.durationMs = Date.now() - refStartedMs;
      if (fin.note) itemResult.message = fin.note;
      // 同理：只有真失败才填 error（前端据此渲染红字），预算用尽的说明已在 message 里
      if (!allDone && targetErrors.length > 0) itemResult.error = fin.warning || "部分目标写入失败";

      /**
       * 修改点（状态显示不一致修复）：统一结果词汇
       *
       * status 保持原样（failedCount 的统计口径不变，任务级结论也不变），
       * 但把「结果」单独标出来给两个页面共用：partial 在仓库管理与备份历史里
       * 都是「部分成功」（快照可用），任务详情也应该显示同一个词，而不是
       * 一边说「部分成功」一边说「失败」。下方 error 文本仍会展示缺哪个目标。
       */
      itemResult.meta = {
        ...(itemResult.meta || {}),
        outcome: allDone ? REPO_OUTCOME.SUCCESS : REPO_OUTCOME.PARTIAL,
        // 修改点（大仓库备份超 CPU 限制）：partial 且已安排续写时，把时间也给出来，
        // 任务详情才能说清「剩下的目标什么时候补」
        ...(refDeferral ? { retryAt: describeRetryAt(refDeferral.retryAtMs) } : {}),
      };

      outcomes.push({
        ref: resolvedVersion.ref ?? trackRef ?? null,
        status: fin.status,
        error: fin.warning || undefined,
        sizeBytes: fin.primarySizeBytes,
        primaryPath: fin.primaryStoragePath,
      });

      console.log(
        `[RepoBackupTaskHandler] 备份完成: ${repoIdentifier}@${resolvedVersion.ref || ""} ${resolvedVersion.version}` +
          `（本次写入 ${successTargets}/${attemptedTargets}，目标副本 ${fin.doneCount}/${fin.totalTargets}）`,
      );

      processed += 1;
      await report(processed);

      if (runCancelled || (await context.isCancelled(job.jobId))) {
        console.log("[RepoBackupTaskHandler] 任务已取消，停止后续引用");
        break;
      }
    }

    // ---------- 5. 延迟重试收尾（修改点：第 2 期 限流 = 延迟，不是失败）----------
    //
    // 走到这里说明本轮至少有一处撞上了限流/暂时性故障，或者（修改点：大仓库备份超
    // CPU 限制）本次作业的预算用尽、还有引用 / 目标没轮到。此时：
    // - 不写任何失败记录（上面已经处理过）
    // - 把该仓库的备份计划提前到「最早可重试时间」，让调度层到点自动重跑，
    //   而不是白等一个完整周期（默认 6 小时）
    // - 函数正常返回、不抛异常：这样 Workflows 的步骤不会被判定失败，
    //   Node 侧的任务也不会被标 failed —— 下一次执行完全由调度器按 next_run_after 决定
    if (deferredRetryAtMs !== null) {
      const retryAtText = describeRetryAt(deferredRetryAtMs);
      const kindText = describeErrorKind(deferredKind || "");
      // 修改点（大仓库备份超 CPU 限制）：原文是「本次未备份」—— 预算用尽的场景下
      // 往往已经备成了好几个引用 / 目标，那句话会把日志读成「这轮什么都没干」
      const note = `${kindText}，已安排在 ${retryAtText} 继续：${deferredMessage || ""}`;

      // 修改点（阶段 2）：收进步骤 —— 这是一次 D1 写，放在步骤外会被重放重复执行。
      // 只前移、不后移，也不会碰 schedule_type / interval_sec / enabled 等其他字段；
      // 仓库未启用定时备份时返回 false，这种情况下只能由管理员手动重试
      const moved = await runStepSafely<boolean>(
        "defer-schedule",
        META_STEP_CONFIG,
        async () => await deferRepositoryBackupSchedule(db, repoRow.id, retryAtText),
        () => false,
      );

      /**
       * 修改点（状态显示不一致修复）：**不再**把这句话写进 code_repositories.last_error。
       *
       * last_error 的语义是「最近一次失败原因」，前端只要看到它非空就渲染成红色失败。
       * 往里写「已安排在 X 自动重试」等于把延迟重试谎报成故障 —— 这正是
       * 「任务列表显示跳过、仓库管理显示失败」的由来。
       * 现在延迟这件事有自己的落点，都已经是结构化的：
       *   · 备份记录 status='deferred' + error_message（含重试时间）
       *   · 检测状态 detect_status='deferred' + last_error + next_detect_after
       * 仓库级状态由 repobackup/status.js 从这些结构化数据推导，前端不再靠猜。
       */
      console.warn(
        `[RepoBackupTaskHandler] ${repoIdentifier} 本轮被推迟：${note}` +
          `（${moved ? "已提前备份计划" : "该仓库未启用定时备份，需手动重试"}）`,
      );
    }

    currentStage = "finished";
    currentRef = null;
    currentTarget = { name: null, mountPath: null };
    await report(processed, { durationMs: Date.now() - startedMs });

    // 全部引用都失败时向上抛出，让任务被标记为失败（部分失败按成功结束，便于重试单条）
    // 修改点（第 2 期）：被推迟的引用记 deferred 而不是 failed，因此
    // 「整轮都是限流」不会被判成失败 —— 它已经交给调度层安排了延迟重试。
    const failedCount = outcomes.filter((o) => o.status === "failed").length;
    if (failedCount > 0 && failedCount === outcomes.length) {
      throw firstError || new Error("全部备份引用均失败");
    }
  }

  /**
   * 构造写入目标旁的 manifest（修改点：多备份目标优化，按目标记录挂载点信息）
   */
  private buildManifest({
    provider,
    repoIdentifier,
    repoRow,
    version,
    backupId,
    jobId,
    archive,
    mount,
  }: any) {
    return {
      schemaVersion: 1,
      provider,
      repoIdentifier,
      repositoryId: repoRow.id,
      repositoryName: repoRow.name || repoIdentifier,
      trackMode: repoRow.track_mode,
      refType: version.refType,
      ref: version.ref,
      commitSha: version.commitSha,
      version: version.version,
      publishedAt: version.publishedAt ?? null,
      backupId,
      backupAt: nowIso(),
      jobId,
      archive,
      mount: {
        id: mount.id,
        name: mount.name ?? null,
        mountPath: mount.mount_path,
        storageType: mount.storage_type ?? null,
      },
    };
  }
}
