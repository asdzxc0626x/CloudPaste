/**
 * 跨存储任务编排的共享类型定义（跨运行时）
 */

import type { JobDescriptor } from './TaskOrchestratorAdapter.js';

/** 任务状态枚举 */
export enum TaskStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  PARTIAL = 'partial',    // 部分项失败
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

/** 单个文件/项目的处理状态 */
export type ItemStatus = 'pending' | 'processing' | 'retrying' | 'success' | 'failed' | 'skipped';

/**
 * 单个项目的处理结果（通用）
 *
 */
export interface ItemResult {
  /** 项目类型（可选）：copy/mount/path/... */
  kind?: string;
  /** 给 UI 展示的短文本（可选） */
  label?: string;

  /** copy 语义字段（可选，copy 任务必填；其他任务可不填） */
  sourcePath?: string;
  targetPath?: string;

  status: ItemStatus;
  error?: string;              // 失败时的错误信息
  message?: string;            // 非失败的提示信息
  fileSize?: number;           // 文件总大小（字节）
  bytesTransferred?: number;   // 已传输字节数
  retryCount?: number;         // 重试次数
  lastRetryAt?: number;        // 最后重试时间戳
  /** 通用耗时（毫秒），用于非 copy 任务描述“处理耗时” */
  durationMs?: number;
  /** 扩展字段 */
  meta?: Record<string, any>;
}

/** 任务统计（通用，可扩展） */
export interface TaskStats {
  totalItems: number;
  processedItems: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  totalBytes?: number;         // 总字节数 (用于进度计算)
  bytesTransferred?: number;   // 已传输字节数
  itemResults?: ItemResult[];  // 每个文件的处理结果
  /** 允许不同任务类型扩展 stats 字段 */
  [key: string]: any;
}

/** 重试策略 */
export interface RetryPolicy {
  limit: number;                      // 最大重试次数
  delay: number;                      // 重试延迟 (ms)
  backoff: 'linear' | 'exponential';  // 退避策略
}

/** 复制任务载荷 */
export interface CopyTaskPayload {
  items: Array<{
    sourcePath: string;
    targetPath: string;
  }>;
  options?: {
    skipExisting?: boolean;
    maxConcurrency?: number;
    retryPolicy?: RetryPolicy;
  };
}

/**
 * 已解析出的版本（修改点：第 4 期 检测与备份分离）
 *
 * 由 repo_backup_check 任务解析并写入 repo_detect_states 后，随 payload 一起
 * 交给 repo_backup 任务。备份任务拿到它就**不再请求 GitHub 版本 API**：
 * 检测阶段已经付过那次额度了，备份阶段再问一次纯属浪费，
 * 而且两次解析之间若有新提交，还会出现「解析到的版本」与「实际下载的内容」不一致。
 */
export interface RepoBackupResolvedRef {
  refType: 'branch' | 'tag';
  /** 分支名 / tag 名；release 模式跟踪「最新」时为 null */
  ref: string | null;
  commitSha: string;
  /** 展示用版本串（main@282ea1c7 / v1.9.1） */
  version?: string | null;
  publishedAt?: string | null;
}

/** 代码仓库备份任务载荷（修改点：新增功能） */
export interface RepoBackupTaskPayload {
  /** code_repositories.id */
  repositoryId: string;
  /** owner/repo（修改点：任务列表显示仓库名）—— 仅用于展示，执行时以 repositoryId 为准 */
  repoIdentifier?: string;
  /** 为 true 时忽略 commitSha 去重，强制重新备份 */
  force?: boolean;
  /**
   * 预解析版本（修改点：第 4 期）
   *
   * - 有值：备份任务直接用这些 commitSha，不再调用 resolveLatestVersion
   * - 缺省：退回到「任务内自行解析」的旧路径。
   *   保留这条退路是为了让「手动备份」「历史任务重试」在不改调用方的情况下继续可用，
   *   并不是双实现 —— 自行解析走的也是同一个 detect 流程（会落库、会推进水位）。
   */
  refs?: RepoBackupResolvedRef[];
}

/**
 * 代码仓库版本检测任务载荷（修改点：第 4 期 repo_backup_check）
 *
 * 为什么检测要独立成一个编排任务，而不是直接在调度 handler 里做：
 *   调度 tick（runDueScheduledJobs）带锁超时，且 Workers 的 cron 执行时间有限，
 *   绝不能在 tick 里做网络 IO —— 现有的 ScheduledRepoBackupTask 就是因为这个
 *   才只负责 createJob。检测要发 GitHub 请求、可能撞限流要退避，
 *   天然属于「编排任务」那一侧，和备份任务同一套重试/取消/进度机制。
 */
export interface RepoBackupCheckTaskPayload {
  /** code_repositories.id */
  repositoryId: string;
  /** owner/repo —— 仅用于任务列表展示 */
  repoIdentifier?: string;
  /**
   * 检测到有新版本时是否自动创建 repo_backup 任务
   * - 定时检测：true（这就是定时备份的新链路）
   * - 手动「检查更新」：false（只看结果，不动手）
   */
  createBackup?: boolean;
  /**
   * 为 true 时忽略 next_detect_after，检测全部跟踪引用
   * （手动触发用：用户明确要求立刻看，不该被退避挡住）
   */
  ignoreDue?: boolean;
  /**
   * 强制备份（手动备份按钮的 force 透传）
   *
   * - false/缺省：只为「有更新」的引用创建备份任务
   * - true：为**全部检测成功**的引用创建备份任务，并把 force 传给 repo_backup，
   *   由它忽略 commitSha 去重重新下载一遍
   *
   * 为什么 force 要经过检测任务而不是直接建备份任务：
   * 这样手动备份也只解析一次版本（在检测阶段），满足「备份任务不再调用 GitHub 版本 API」。
   */
  force?: boolean;
  /** 本轮最多检测多少个引用（削峰），缺省用 DETECT_MAX_REFS_PER_RUN */
  maxRefs?: number;
}

/** 任务数据库记录 */
export interface TaskRecord<TPayload = unknown> {
  task_id: string;
  task_type: string;
  status: TaskStatus;
  payload: TPayload;
  stats: TaskStats;
  error_message?: string;
  user_id: string;
  user_type: string;
  workflow_instance_id?: string;  // Workers 专用
  created_at: number;
  started_at?: number;
  updated_at: number;
  finished_at?: number;
}

/** 复制任务记录 */
export type CopyTaskRecord = TaskRecord<CopyTaskPayload>;

/** 复制作业描述符 (API 响应) */
export interface CopyJobDescriptor {
  jobId: string;
  status: TaskStatus;
  stats: TaskStats;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  items?: Array<{ sourcePath: string; targetPath: string }>;
  userId?: string;
}

/** 创建复制作业参数 */
export interface CreateCopyJobParams {
  userId: string;
  userType: string;
  items: Array<{ sourcePath: string; targetPath: string }>;
  options?: {
    skipExisting?: boolean;
    maxConcurrency?: number;
    retryPolicy?: RetryPolicy;
  };
}

/** 作业过滤条件 */
export interface JobFilter {
  status?: TaskStatus;
  taskType?: string;
  taskTypes?: string[];
  userId?: string;
  limit?: number;
  offset?: number;
}

export interface JobListResult {
  jobs: JobDescriptor[];
  total: number;
}
