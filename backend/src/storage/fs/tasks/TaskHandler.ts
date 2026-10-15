import type { TaskStats } from './types.js';

/**
 * 单个执行步骤的配置（修改点：阶段 2 拆分 Workflow 步骤）
 *
 * 字段与 Cloudflare Workflows 的 WorkflowStepConfig 对齐，但**不引用**它的类型 ——
 * 这个接口要同时被 Node/Docker 侧实现，不能把 cloudflare:workers 的类型拖进来。
 */
export interface TaskStepOptions {
  retries?: {
    /** 重试**次数**（不是总次数）：limit=1 表示最多 2 次尝试 */
    limit: number;
    delay: number;
    backoff: 'linear' | 'exponential';
  };
  /** 每次尝试的超时（毫秒），不是整个步骤的总预算 */
  timeout?: number;
}

/**
 * 任务执行上下文 - 提供取消检测、进度更新、文件系统和环境访问
 */
export interface ExecutionContext {
  /** 检查作业是否已被取消 */
  isCancelled(jobId: string): Promise<boolean>;
  /** 更新作业进度统计 */
  updateProgress(jobId: string, stats: Partial<TaskStats>): Promise<void>;
  /** 获取 FileSystem 实例 */
  getFileSystem(): any;
  /** 获取环境绑定 (DB/R2/etc.) */
  getEnv(): any;

  /**
   * 把一段工作登记为编排层的一个**持久化步骤**（修改点：阶段 2 拆分 Workflow 步骤）
   *
   * 这是个**可选能力**，只有 Workers 侧的 JobWorkflow 会提供（底层就是 step.do）。
   * Node/Docker 侧不提供，处理器必须自己退化成「直接调用 fn」——
   * 于是同一份处理器代码在两种宿主下都只写一遍，Node 的行为与拆分前逐字相同。
   *
   * 调用方必须遵守 Workflows 的两条硬规则（developers.cloudflare.com/workflows/
   * build/rules-of-workflows/，2026-10-13 抓取存档于 backend/.audit/docs/）：
   * - name 必须**确定性**生成：「Step names act as the "cache key" in your Workflow.」
   *   动态命名是允许的，但必须源自上一个步骤的输出且遍历顺序固定
   *   （原文：「steps that are dynamically named are constructed in a deterministic way
   *   ... it's fine to dynamically name steps (e.g: create a step per list entry)」）。
   * - 返回值必须可序列化，且**不得包含凭据**：步骤输出会被平台持久化。
   *
   * @param name 步骤名（同一实例内唯一且稳定）
   * @param options 重试与超时；省略则由编排层取默认值
   * @param fn 步骤体。副作用必须全部收在这里面 —— 步骤之外的代码在引擎重启时会被重复执行
   */
  runStep?<T>(name: string, options: TaskStepOptions | undefined, fn: () => Promise<T>): Promise<T>;
}

/**
 * 内部作业对象 - 传递给 TaskHandler.execute() 的作业数据
 */
export interface InternalJob {
  jobId: string;
  taskType: string;
  payload: any;
  userId: string;
  userType: string;
  stats: TaskStats;
  createdAt: Date;
}

/**
 * 任务处理器接口 - 每个任务类型实现一个处理器
 */
export interface TaskHandler {
  /** 任务类型标识符 (必须唯一) */
  readonly taskType: string;

  /** 验证任务载荷 - 在创建作业前调用 */
  validate(payload: any): Promise<void>;

  /** 执行任务 - 遍历处理所有任务项，定期检查取消状态并更新进度 */
  execute(job: InternalJob, context: ExecutionContext): Promise<void>;

  /** 创建统计模板 - 根据载荷初始化统计对象 */
  createStatsTemplate(payload: any): TaskStats;

  /**
   * 声明「本处理器自己用 context.runStep 划分步骤」（修改点：阶段 2 拆分 Workflow 步骤）
   *
   * 不声明（undefined / false）时编排层行为**完全不变**：整个 execute() 仍然被包在
   * 单个 execute-task 步骤里。只有声明为 true 的处理器才会被编排层放到
   * run() 顶层驱动，从而能自己调 step.do —— Workflows 不支持嵌套步骤，
   * 所以「自己拆步骤」和「被 execute-task 包住」只能二选一。
   *
   * 代价是：execute() 里**步骤之外**的代码会在引擎重启时被重复执行，
   * 因此声明 true 的处理器必须保证那部分代码无副作用、无不确定性。
   */
  readonly usesExecutionSteps?: boolean;
}
