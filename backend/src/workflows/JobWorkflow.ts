/**
 * Cloudflare Workflows 通用作业入口点
 * - 支持任意任务类型,通过 TaskRegistry 动态分发
 * - 持久化执行 + 步骤级重试
 * - 双层数据: Workflow 实例 (3-7天) + D1 tasks 表 (永久)
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";

// @ts-ignore - JS modules lack type declarations
import { MountManager } from "../storage/managers/MountManager.js";
// @ts-ignore - JS modules lack type declarations
import { FileSystem } from "../storage/fs/FileSystem.js";
// @ts-ignore - JS modules lack type declarations
import { ensureRepositoryFactory } from "../utils/repositories.js";
import { DbTables } from "../constants/index.js";
import { taskRegistry } from "../storage/fs/tasks/TaskRegistry.js";
import type { ExecutionContext, InternalJob, TaskStepOptions } from "../storage/fs/tasks/TaskHandler.js";
import { TaskStatus } from "../storage/fs/tasks/types.js";
import type { TaskStats } from "../storage/fs/tasks/types.js";

/** Workflow 参数 */
export interface JobWorkflowParams {
  jobId: string;
  taskType: string;
  payload: any;
  userId: string;
  userType: string;
}

/** Workers 环境绑定 */
interface Env {
  DB: D1Database;
  ENCRYPTION_SECRET: string;
}

/**
 * execute-task 的默认步骤配置（修改点：阶段 1 重试放大）
 *
 * 保持与改动前**完全一致**的取值，所有任务类型默认继续走这一套，
 * 这样这次调整不会碰到任何其他任务类型的重试行为。
 *
 * 语义按官方文档核实（workflows/build/sleeping-and-retrying/，
 * 2026-10-12 抓取存档于 backend/.audit/docs/）：
 * - `retries.limit` 是**重试次数**，不是总次数：文档示例 `limit: 10` 注明
 *   "11 attempts total"。所以 limit = 3 意味着**最多 4 次完整尝试**。
 * - `timeout` 是**每次尝试**的超时（原文 "the timeout is set per attempt"），
 *   不是整个步骤的总预算。于是 limit=3 + timeout=600000 的真实 wall-clock
 *   上界是 4 × 10 分钟 + 退避 (10s+20s+40s) ≈ 41 分钟。
 * - 不传配置时平台默认是 `{limit: 5, delay: 10000, backoff: "exponential"},
 *   timeout: "10 minutes"`，所以这里显式写出来是在收紧而非放宽。
 */
const DEFAULT_EXECUTE_STEP_CONFIG = {
  retries: {
    limit: 3,
    delay: 10000,
    backoff: "exponential" as const,
  },
  timeout: 600000,
};

/**
 * 按任务类型覆盖 execute-task 的步骤配置（修改点：阶段 1 重试放大）
 *
 * 为什么只对 repo_backup 收紧，而不是改默认值：
 * 步骤重试是**基础设施级**重试——它把整个 handler.execute() 从头再跑一遍。
 * 对大多数任务（copy / 索引重建等）这是对的：工作量小、失败多半是偶发网络问题。
 *
 * 但 repo_backup 的一次尝试是「N 个引用 × M 个目标，每个组合完整下载 + 完整上传
 * 一遍归档」。一个 355MB 的仓库在 limit=3 下最坏要被完整拉 **4 遍**，代价是：
 * - GitHub 出口流量 ×4（355MB → 1.4GB），而归档下载不走 API 配额调度器，
 *   没有任何东西会拦住它；
 * - 每次被运行时杀掉都会漏掉 lib-storage 的 AbortMultipartUpload
 *   （见 S3UploadOperations 的说明），于是桶里留下 4 套未完成分片持续计费；
 * - 而重试本身救不了它：同样的工作量再跑一遍，撞的还是同一道 CPU /
 *   subrequest 上限（免费计划 10ms / 50 个外部请求，见 transferBudget.js 文件头）。
 *
 * 真正需要的「业务重试」已经由另一套机制承担，且比盲目重跑精确得多：
 * handler 内部捕获业务异常后用 planRetryForError 算出重试时刻，
 * 再由 deferRepositoryBackupSchedule 写进 scheduled_jobs.next_run_after，
 * 下一轮从**没做完的那个目标**接着做，而不是从头重来。
 *
 * 所以这里把重试次数降到 1（= 最多 2 次尝试）：
 * 保留一次重试是为了覆盖「连接卡死导致步骤超时」这类真正偶发的基础设施故障，
 * 不降到 0 是为了让这次改动尽量小、可回退。
 */
const EXECUTE_STEP_CONFIG_BY_TASK_TYPE: Record<string, typeof DEFAULT_EXECUTE_STEP_CONFIG> = {
  repo_backup: {
    retries: {
      limit: 1,
      delay: 10000,
      backoff: "exponential" as const,
    },
    timeout: 600000,
  },
};

/**
 * 取某任务类型的 execute-task 步骤配置（修改点：阶段 1 重试放大）
 * @param taskType 任务类型
 * @returns 未配置覆盖的类型返回默认配置（与改动前一致）
 */
function resolveExecuteStepConfig(taskType: string) {
  return EXECUTE_STEP_CONFIG_BY_TASK_TYPE[taskType] ?? DEFAULT_EXECUTE_STEP_CONFIG;
}

/**
 * 处理器自拆步骤时的默认步骤配置（修改点：阶段 2 拆分 Workflow 步骤）
 *
 * 只在处理器调 context.runStep 时没显式给配置的情况下生效。
 * 取值刻意比 DEFAULT_EXECUTE_STEP_CONFIG 保守（retries.limit 1 而不是 3）：
 * 拆出来的步骤粒度更细，「整体重跑一遍」的代价本来就该更低，
 * 而重试放大正是阶段 1 刚处理掉的问题，不能在这里又放回来。
 */
const DEFAULT_SPLIT_STEP_CONFIG: Required<TaskStepOptions> = {
  retries: {
    limit: 1,
    delay: 10000,
    backoff: "exponential" as const,
  },
  timeout: 600000,
};

/**
 * 单行结构化诊断日志（修改点：阶段 1 补充必要诊断）
 *
 * 口径与约束：
 * - **只写日志，不写 D1**。免费计划下 D1 调用计入「1,000 次 Cloudflare 服务
 *   subrequest / 次调用」的额度，而进度上报已经在用掉其中相当一部分，
 *   诊断绝不能再往里加。日志在 Workers Logs / `wrangler tail` 里就能看。
 * - 单行 `key=value`，方便在 tail 里直接 grep（避免多行 JSON 被日志面板截断）。
 * - 不打印 payload：里面可能有仓库凭据相关字段。只打印标识类信息。
 *
 * 注意：**CPU 时间拿不到**。Workers 没有向 JS 暴露本次调用已用 CPU 的 API，
 * 所以这里记录的 `wallMs` 是 wall-clock，不是 CPU 时间（两者在本任务里差得很远：
 * 绝大部分 wall-clock 花在等网络，不计入 CPU）。真实 CPU 时间只能从
 * Workers Logs 的 invocation log 或 Logpush 的 Trace Events 顶层字段读。
 */
function logJob(event: string, fields: Record<string, unknown>) {
  const parts = [`[JobWorkflow] ${event}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${key}=${value}`);
  }
  console.log(parts.join(" "));
}

/** 通用作业 Workflow - 持久化执行 + 自动重试 */
export class JobWorkflow extends WorkflowEntrypoint<Env, JobWorkflowParams> {
  async run(event: WorkflowEvent<JobWorkflowParams>, step: WorkflowStep) {
    const { jobId, taskType, payload, userId, userType } = event.payload;

    /**
     * 修改点（阶段 1 补充必要诊断）：本次 run() 调用的标识
     *
     * Workflows 没有向 JS 暴露「这是第几次尝试」的 API，所以用一个
     * 每次调用都重新生成的随机 token 来替代：**同一个 jobId 出现多个
     * 不同的 invocation，就说明发生了步骤重试或实例重放**。
     * 这是在不写任何 D1 的前提下能拿到的最接近「重试次数」的信号。
     *
     * instanceId 与 jobId 在本项目里是同一个值（WorkflowsTaskOrchestrator
     * 用 `JOB_WORKFLOW.create({ id: jobId })` 创建实例），这里仍然分开打，
     * 以便将来改了 ID 策略时日志不会误导。
     */
    const invocation = Math.random().toString(36).slice(2, 10);
    const instanceId = (event as any)?.instanceId ?? jobId;
    const runStartedAtMs = Date.now();

    logJob("run 开始", {
      jobId,
      taskType,
      instanceId,
      invocation,
      eventAt: (event as any)?.timestamp
        ? new Date((event as any).timestamp).toISOString()
        : undefined,
    });

    // 获取任务处理器
    let handler;
    try {
      handler = taskRegistry.getHandler(taskType);
    } catch (error: any) {
      console.error(`[JobWorkflow] 未知任务类型 ${taskType}:`, error);

      await step.do('record-invalid-task-type', async () => {
        await this.env.DB.prepare(`
          UPDATE ${DbTables.TASKS}
          SET status = ?, error_message = ?, updated_at = ?, finished_at = ?
          WHERE task_id = ?
        `).bind(
          'failed',
          `未知任务类型: ${taskType}`,
          Date.now(),
          Date.now(),
          jobId
        ).run();
        return { error: 'invalid_task_type' };
      });

      throw error;
    }

    // 标记为 running
    await step.do('mark-running', async () => {
      await this.env.DB.prepare(`
        UPDATE ${DbTables.TASKS}
        SET status = ?, started_at = ?, updated_at = ?
        WHERE task_id = ?
      `).bind(
        'running',
        Date.now(),
        Date.now(),
        jobId
      ).run();
      return { success: true };
    });

    // 执行任务
    let taskSuccess = true;
    let taskError: Error | null = null;

    /**
     * 修改点（任务卡住排查）：execute-task 抛出时也必须走到最终化步骤。
     *
     * 这个 step 配了 timeout: 600000 + retries.limit: 3。handler 内部会自己捕获业务异常
     * 并返回 {success:false}，所以 step 真正抛出的场景是「步骤超时」或运行时异常；
     * 原实现里 await step.do(...) 一旦抛出，run() 直接结束，
     * finalize-task-record 永远不执行 —— D1 里的 tasks 行就永久停在 running，
     * 既没有 finished_at 也没有 error_message，前端表现就是「卡住且看不到原因」。
     */
    const executeStepConfig = resolveExecuteStepConfig(taskType);

    const buildJob = (): InternalJob => ({
      jobId,
      taskType,
      payload,
      userId,
      userType,
      stats: {
        totalItems: 0,
        processedItems: 0,
        successCount: 0,
        failedCount: 0,
        skippedCount: 0,
      },
      createdAt: new Date(),
    });

    /**
     * 两种驱动方式，按处理器声明二选一（修改点：阶段 2 拆分 Workflow 步骤）
     *
     * Workflows **不支持嵌套步骤**（step 只从 run() 的参数拿到，无法在 step.do 内部再开
     * 一个 step），所以「处理器自己拆步骤」与「被 execute-task 整体包住」必须互斥：
     * - 声明了 usesExecutionSteps 的处理器（目前只有 repo_backup）由 run() **顶层**驱动，
     *   它自己用 context.runStep 把每个 ref × 目标登记成独立步骤，于是每个组合都拿到
     *   一份独立的 CPU 与 subrequest 额度（文档 workflows/reference/limits/ 的
     *   「Workflows (per step) — Wall time limit: Unlimited ... Individual steps are
     *   subject to the configured CPU time limit」，以及脚注「A Workflow instance can run
     *   forever, as long as **each step** does not take more than the CPU time limit」）。
     * - 其余所有任务类型走下面的 else 分支，与改动前**逐字相同**，不受本次影响。
     */
    const usesExecutionSteps = (handler as any)?.usesExecutionSteps === true;

    if (usesExecutionSteps) {
      const attemptStartedAtMs = Date.now();
      logJob("顶层驱动开始", {
        jobId,
        taskType,
        invocation,
        mode: "processor-steps",
      });

      try {
        await handler.execute(buildJob(), this.createExecutionContext(jobId, { step, invocation }));
        logJob("顶层驱动成功", {
          jobId,
          taskType,
          invocation,
          wallMs: Date.now() - attemptStartedAtMs,
        });
      } catch (error: any) {
        /**
         * 这里兜住的是「处理器自己没兜住」的异常：某个 runStep 重试耗尽后抛出、
         * 或处理器步骤之外的代码出错。与 else 分支一样，绝不让任务停在 running ——
         * 下面的 finalize-task-record 照常执行。
         */
        taskSuccess = false;
        taskError = error instanceof Error ? error : new Error(String(error));
        logJob("顶层驱动失败", {
          jobId,
          taskType,
          invocation,
          wallMs: Date.now() - attemptStartedAtMs,
          errorName: error?.name,
          errorMessage: error?.message || String(error),
        });
        console.error(`[JobWorkflow] ✗ 任务 ${jobId} 顶层驱动异常退出:`, error);
      }
    } else {
      try {
        await step.do(
          'execute-task',
          executeStepConfig,
          async () => {
          /**
           * 修改点（阶段 1 补充必要诊断）：每次尝试各自计时
           *
           * 这个闭包会被**完整重跑**一遍（每次重试都是一次新的尝试），
           * 所以计时必须放在闭包内部，放外面量到的是「首次尝试到现在」。
           */
          const attemptStartedAtMs = Date.now();
          logJob("execute-task 尝试开始", {
            jobId,
            taskType,
            invocation,
            retryLimit: executeStepConfig.retries.limit,
            attemptTimeoutMs: executeStepConfig.timeout,
          });

          try {
            await handler.execute(buildJob(), this.createExecutionContext(jobId, null));

            // 修改点（阶段 1 补充必要诊断）：wallMs 是 wall-clock，不是 CPU 时间
            logJob("execute-task 尝试成功", {
              jobId,
              taskType,
              invocation,
              wallMs: Date.now() - attemptStartedAtMs,
            });
            return { success: true };
          } catch (error: any) {
            taskSuccess = false;
            taskError = error;
            logJob("execute-task 尝试失败", {
              jobId,
              taskType,
              invocation,
              wallMs: Date.now() - attemptStartedAtMs,
              // handler 自己捕获业务异常并返回，所以走到这里多半是未预期的运行时错误
              errorName: error?.name,
              errorMessage: error?.message || String(error),
            });
            console.error(`[JobWorkflow] ✗ 任务 ${jobId} 执行失败:`, error);

            return {
              success: false,
              error: error.message || String(error),
            };
          }
          }
        );
      } catch (stepError: any) {
        // 步骤超时 / 重试耗尽 / 运行时异常：记下原因，继续走最终化，绝不让任务停在 running
        taskSuccess = false;
        taskError = stepError instanceof Error ? stepError : new Error(String(stepError));
        logJob("execute-task 步骤退出", {
          jobId,
          taskType,
          invocation,
          wallMs: Date.now() - runStartedAtMs,
          errorName: stepError?.name,
          errorMessage: stepError?.message || String(stepError),
        });
        console.error(
          `[JobWorkflow] ✗ 任务 ${jobId} 的 execute-task 步骤异常退出（超时或重试耗尽）:`,
          stepError
        );
      }
    }

    // 最终化状态
    await step.do('finalize-task-record', async () => {
      console.log(`[JobWorkflow] 最终化作业记录 ${jobId}`);

      const finalRow = await this.env.DB.prepare(`
        SELECT status, stats FROM ${DbTables.TASKS} WHERE task_id = ?
      `).bind(jobId).first();

      if (finalRow?.status === 'cancelled') {
        console.log(`[JobWorkflow] 作业 ${jobId} 已被用户取消,保持 cancelled 状态`);
        return { cancelled: true };
      }

      const finalStats = JSON.parse(finalRow?.stats as string || '{}') as TaskStats;
      let finalStatus: TaskStatus;

      if (!taskSuccess && taskError) {
        finalStatus = TaskStatus.FAILED;
      } else {
        finalStatus =
          finalStats.failedCount === 0 ? TaskStatus.COMPLETED :
          finalStats.successCount === 0 ? TaskStatus.FAILED :
          TaskStatus.PARTIAL;
      }

      const errorMessage =
        finalRow?.status === 'cancelled' ? '任务已被用户取消' :
        taskError ? taskError.message || String(taskError) :
        finalStats.failedCount > 0 ? `部分项目失败 (${finalStats.failedCount}/${finalStats.totalItems})` :
        null;

      await this.env.DB.prepare(`
        UPDATE ${DbTables.TASKS}
        SET status = ?, stats = ?, finished_at = ?, updated_at = ?, error_message = ?
        WHERE task_id = ?
      `).bind(
        finalStatus,
        JSON.stringify(finalStats),
        Date.now(),
        Date.now(),
        errorMessage,
        jobId
      ).run();

      console.log(`[JobWorkflow] ✓ 作业记录已最终化,状态: ${finalStatus}`);
      /**
       * 修改点（阶段 1 补充必要诊断）：最终状态与可诊断的错误信息
       *
       * prevStatus 一并打出来是为了识别「僵尸收尾先到、Workflow 后到」的情况：
       * 收尾会把长期停在 running 的行改成 failed（见 repobackup/zombies.js），
       * 之后实例若仍活着走到这里，这里的判定更准确，会覆盖它 —— 这是预期行为，
       * 日志里能看到 prevStatus=failed → status=... 的交接过程。
       */
      logJob("finalize 完成", {
        jobId,
        taskType,
        invocation,
        prevStatus: finalRow?.status,
        status: finalStatus,
        totalWallMs: Date.now() - runStartedAtMs,
        successCount: finalStats.successCount,
        failedCount: finalStats.failedCount,
        skippedCount: finalStats.skippedCount,
        bytesTransferred: (finalStats as any)?.bytesTransferred,
        errorMessage: errorMessage ?? undefined,
      });
      return { status: finalStatus };
    });

    const finalRow = await this.env.DB.prepare(`
      SELECT stats FROM ${DbTables.TASKS} WHERE task_id = ?
    `).bind(jobId).first();

    const finalStats = finalRow ? JSON.parse(finalRow.stats as string) as TaskStats : {
      totalItems: 0,
      processedItems: 0,
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
    };

    return {
      ...finalStats,
      finishedAt: new Date().toISOString(),
    };
  }

  /**
   * 构造任务执行上下文（修改点：阶段 2 拆分 Workflow 步骤）
   *
   * 原先这段代码内联在 execute-task 的闭包里。抽成方法是因为现在有两条驱动路径
   * （见 run() 里的 usesExecutionSteps 分支），两边必须用**同一个**上下文实现，
   * 否则「Node 与 Workers 行为一致」这件事就只能靠人去比对两份拷贝。
   *
   * @param jobId 作业 ID
   * @param stepCtx 非空时额外挂上 runStep 能力（即允许处理器自己开步骤）；
   *                传 null 则上下文与改动前**逐字相同**，不含 runStep
   */
  private createExecutionContext(
    jobId: string,
    stepCtx: { step: WorkflowStep; invocation: string } | null,
  ): ExecutionContext {
    // 进度更新节流：避免高频写 D1 导致放大
    // - Handler 积极地上报（例如每 N 个目录/每批 upsert）
    let lastProgressWriteAtMs = 0;
    let pendingProgressPatch: Partial<TaskStats> | null = null;

    const context: ExecutionContext = {
      isCancelled: async (jobId: string) => {
        const row = await this.env.DB.prepare(`
          SELECT status FROM ${DbTables.TASKS} WHERE task_id = ?
        `).bind(jobId).first();
        return row?.status === 'cancelled';
      },

      updateProgress: async (jobId: string, stats: Partial<TaskStats>) => {
        const nowMs = Date.now();

        // 合并到 pending（低成本，避免频繁读写 DB）
        pendingProgressPatch = { ...(pendingProgressPatch || {}), ...(stats || {}) };

        // 强制写入条件：关键统计变化（mount 级/结果级）
        const forceWrite =
          stats?.processedItems !== undefined ||
          stats?.totalItems !== undefined ||
          stats?.successCount !== undefined ||
          stats?.failedCount !== undefined ||
          stats?.skippedCount !== undefined;

        // 时间节流：默认 2s 写一次（forceWrite 例外）
        if (!forceWrite && nowMs - lastProgressWriteAtMs < 2000) {
          return;
        }
        lastProgressWriteAtMs = nowMs;

        const currentRow = await this.env.DB.prepare(`
          SELECT stats FROM ${DbTables.TASKS} WHERE task_id = ?
        `).bind(jobId).first();

        if (!currentRow) {
          console.error(`[JobWorkflow] 作业 ${jobId} 未找到,无法更新进度`);
          return;
        }

        const currentStats = JSON.parse(currentRow.stats as string);
        const updatedStats = {
          ...currentStats,
          ...(pendingProgressPatch || {}),
          heartbeatAtMs: nowMs,
        };
        pendingProgressPatch = null;

        await this.env.DB.prepare(`
          UPDATE ${DbTables.TASKS}
          SET stats = ?, updated_at = ?
          WHERE task_id = ?
        `).bind(
          JSON.stringify(updatedStats),
          Date.now(),
          jobId
        ).run();
      },

      getFileSystem: () => {
        const repositoryFactory = ensureRepositoryFactory(this.env.DB);
        const mountManager = new MountManager(
          this.env.DB,
          this.env.ENCRYPTION_SECRET,
          repositoryFactory,
          { env: this.env as any },
        );
        return new FileSystem(mountManager, this.env);
      },

      getEnv: () => this.env,
    };

    if (stepCtx) {
      /**
       * 把处理器的一段工作登记成一个真正的 Workflow 步骤
       *
       * 日志刻意放在 step.do **外面**：文档明确说「logic outside of the steps may be
       * duplicated」「a console.log() outside of workflow steps may cause the logs to
       * print twice when the engine restarts」。这里正好利用这个性质 ——
       * 同一个 step= 名字配着不同的 invocation= 重复出现，就说明 run() 发生了重放，
       * 这是在不写任何 D1 的前提下能观测到重放次数的唯一办法（延续阶段 1 的诊断口径）。
       */
      context.runStep = async <T>(
        name: string,
        options: TaskStepOptions | undefined,
        fn: () => Promise<T>,
      ): Promise<T> => {
        const config = {
          retries: options?.retries ?? DEFAULT_SPLIT_STEP_CONFIG.retries,
          timeout: options?.timeout ?? DEFAULT_SPLIT_STEP_CONFIG.timeout,
        };
        const startedAtMs = Date.now();

        logJob("step 进入", {
          jobId,
          step: name,
          invocation: stepCtx.invocation,
          retryLimit: config.retries.limit,
          attemptTimeoutMs: config.timeout,
        });

        try {
          const result = (await stepCtx.step.do(name, config, fn as any)) as T;
          logJob("step 完成", {
            jobId,
            step: name,
            invocation: stepCtx.invocation,
            wallMs: Date.now() - startedAtMs,
          });
          return result;
        } catch (error: any) {
          // 抛出去由处理器决定「这个组合算失败，其他组合继续」还是整体放弃
          logJob("step 退出", {
            jobId,
            step: name,
            invocation: stepCtx.invocation,
            wallMs: Date.now() - startedAtMs,
            errorName: error?.name,
            errorMessage: error?.message || String(error),
          });
          throw error;
        }
      };
    }

    return context;
  }
}
