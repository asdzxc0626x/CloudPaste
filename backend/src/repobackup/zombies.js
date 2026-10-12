/**
 * 代码仓库备份 - 僵尸 running 记录收尾（修改点：大仓库备份超 CPU 限制）
 *
 * 要解决的现场
 * ------------
 * Cloudflare Workers 的 CPU 超限是运行时**直接杀掉 isolate**，JS 捕获不到：
 * RepoBackupTaskHandler 里所有 catch、updateBackup({status:'failed'})、
 * updateRepository({last_error}) 一个都不会执行。于是
 *   · code_repository_backups 那一行永远停在 running；
 *   · 备份历史里该版本一直显示「进行中」；
 *   · tasks 那一行也永远停在 running，finished_at / error_message 全是空 ——
 *     「任务管理」页表现为「一直在执行、看不到原因」。
 *     修改点（阶段 1）：这一条原先没人收尾。Node/Docker 侧由
 *     SQLiteTaskOrchestrator.recoverJobs() 在进程启动时重置，
 *     而 Workers 侧没有「启动」这个时机，JobWorkflow 的 finalize-task-record
 *     又只在 run() 还能继续执行时才跑得到，CPU 超限时它根本不执行；
 *   · 仓库的 last_error 是空的，页面上看不到任何原因 ——
 *     能看到的只有任务管理页那句 `Worker exceeded CPU time limit.`；
 *   · 在 STALE_RUNNING_BACKUP_SEC（6 小时）窗口内，定时备份的「上一次备份仍在
 *     进行中」守卫还会继续挡住这个仓库。
 * 窗口过去之后，原实现只是「不再把它算作进行中」，脏记录本身没人管。
 *
 * 容器/进程被 kill（Docker 重启、OOM）留下的记录是同一类问题，一并收尾。
 *
 * 为什么单独成模块
 * ----------------
 * 两条路径都需要它，而它们一个在调度层、一个在路由层，没有共同的上层：
 *   · ScheduledRepoBackupTask —— 定时备份每轮开头顺手清理；
 *   · 手动「立即备份」路由 —— 关掉定时备份的仓库只能靠这条路径自愈。
 * 放在任何一边都会让另一边去 import 对方，所以收在 repobackup/ 下。
 */

import { ZOMBIE_RUNNING_BACKUP_SEC } from "./schedule.js";

/**
 * 推断原因文案
 *
 * 措辞刻意写成「推断」：我们只知道「执行进程再也没有回来收尾」，
 * 并不知道具体是 CPU 超限、步骤超时还是进程被重启。把最可能的几个原因列出来，
 * 比写一句无从下手的「未知错误」有用得多。
 *
 * @param {number} minutes 判定窗口（分钟）
 * @returns {string}
 */
function buildZombieReason(minutes) {
  return (
    `备份记录已停留在「进行中」超过 ${minutes} 分钟且执行进程未再回报，判定为异常中断。` +
    `常见原因：Cloudflare Workers CPU 时间超限（该情况下运行时会直接终止执行，` +
    `程序无法写入失败原因）、Workflows 步骤超时，或容器/进程被重启。` +
    // 修改点（免费计划部署被 100328 拒绝）：不再引导用户去改 [limits] cpu_ms。
    // 那一项只有付费计划能设，免费计划填了会直接部署失败（code 100328），
    // 现在 wrangler 配置里默认是注释状态。真正可用的手段是 REPO_BACKUP_* 预算：
    // 把单次作业的工作量压到 CPU 上限之内，剩下的留给下一轮补写。
    `如为大仓库，可减少备份目标数量，或用 REPO_BACKUP_* 预算配置` +
    `（REPO_BACKUP_SOFT_DEADLINE_MS / REPO_BACKUP_JOB_BYTE_BUDGET_MB）` +
    `缩小单次作业的工作量；付费计划还可取消 wrangler 配置中 [limits] cpu_ms 的注释`
  );
}

/**
 * 编排任务行（tasks 表）的收尾原因（修改点：阶段 1 任务卡在 running）
 *
 * 与 buildZombieReason 分开写，是因为两张表给管理员看的是**不同的页面**：
 * 备份历史里要解释「这个版本为什么没备上」，任务管理页要解释
 * 「这个作业为什么一直在跑」。后者还需要点明「作业已经不在执行了」，
 * 否则管理员会继续等。
 *
 * @param {number} minutes 判定窗口（分钟）
 * @returns {string}
 */
function buildZombieJobReason(minutes) {
  return (
    `作业已停留在「执行中」超过 ${minutes} 分钟且未再上报进度，判定为执行体已终止。` +
    `Cloudflare Workers 的 CPU 超限会直接终止 isolate，程序侧捕获不到，` +
    `因此作业无法自己写入失败原因（这正是本条记录被动收尾的原因）。` +
    `真实的 CPU 时间与超限结论请在 Workers Logs 的 invocation log ` +
    `或 wrangler tail 的 outcome 字段（exceededCpu）中核对。`
  );
}

/** 收尾范围内的任务类型（修改点：阶段 1 任务卡在 running） */
const ZOMBIE_JOB_TASK_TYPES = ["repo_backup", "repo_backup_check"];

/**
 * 把某仓库「卡在进行中的僵尸记录」收尾成 failed
 *
 * 修改点（阶段 1 任务卡在 running）：现在收尾**两张表**，且彼此独立：
 * 1. code_repository_backups —— 备份历史里停在 running 的版本；
 * 2. tasks —— 编排任务里停在 running 的 repo_backup / repo_backup_check 作业。
 * 第 2 项是 Workers 侧原先完全没有的收敛路径（Node 侧由
 * SQLiteTaskOrchestrator.recoverJobs 在进程启动时承担，Workers 没有这个时机）。
 *
 * 安全性：两边都只改 status='running' 且已经过了收尾窗口的行，
 * 终态行一律不碰，所以不存在「旧状态覆盖新状态」。万一判早了（作业其实还在跑），
 * 作业结束时会自己写回 success/partial/failed，不会留下错误的终态。
 * tasks 侧刻意不碰 pending（那可能只是实例在排队），理由见
 * CodeRepositoryRepository.finalizeStaleRepoJobs 的注释。
 *
 * 幂等性：收尾只改状态和说明，不创建备份、不写备份历史的新行，
 * 因此重复调用（每个调度 tick + 每次手动备份都会调）不会产生重复备份或重复历史。
 *
 * 失败处理：收尾只是「补一条说明」，绝不能影响调用方的主流程，
 * 所以两步各自包在 try 里，出错只打日志，一步失败不影响另一步。
 *
 * @param {Object} params
 * @param {Object} params.codeRepo CodeRepositoryRepository 实例
 * @param {string} params.repositoryId
 * @param {string} [params.repoLabel] 仓库显示名（仅用于日志）
 * @returns {Promise<{ finalized: number, finalizedJobs: number, summary: string }>}
 *          finalized = 收尾的备份历史行数，finalizedJobs = 收尾的任务行数；
 *          summary 可直接拼进运行摘要，无事可做时为空串
 */
export async function finalizeZombieBackups({ codeRepo, repositoryId, repoLabel = "" }) {
  const empty = { finalized: 0, finalizedJobs: 0, summary: "" };
  if (!codeRepo || !repositoryId) return empty;

  const minutes = Math.round(ZOMBIE_RUNNING_BACKUP_SEC / 60);
  const staleBeforeMs = Date.now() - ZOMBIE_RUNNING_BACKUP_SEC * 1000;
  /** 两张表各自的收尾说明，最后拼成一句 summary */
  const notes = [];
  let finalized = 0;
  let finalizedJobs = 0;

  /**
   * 第一步：备份历史表（code_repository_backups）
   *
   * 修改点（阶段 1 任务卡在 running）：原实现在「没有僵尸备份记录」时直接 return，
   * 于是下面的 tasks 收尾根本到不了。这两件事必须相互独立 ——
   * repo_backup_check 压根不写备份历史表，而 repo_backup 也可能在创建备份记录**之前**
   * 就被杀掉；这两种情况下备份历史是干净的，但 tasks 行照样卡在 running。
   */
  try {
    const zombieBefore = new Date(staleBeforeMs).toISOString();
    const zombies = await codeRepo.findRunningBackupsBefore(repositoryId, zombieBefore);

    if (Array.isArray(zombies) && zombies.length > 0) {
      const reason = buildZombieReason(minutes);

      for (const row of zombies) {
        try {
          await codeRepo.updateBackup(row.id, {
            status: "failed",
            error_message: reason,
            finished_at: new Date().toISOString(),
          });
          finalized += 1;
        } catch (error) {
          console.warn(`[repoBackup] 收尾僵尸备份记录失败（${row.id}）:`, error?.message || error);
        }
      }

      if (finalized > 0) {
        // 仓库级 last_error：「仓库管理」页只看这个字段决定是否显示失败
        await codeRepo
          .updateRepository(repositoryId, { last_error: reason })
          .catch((error) => console.warn("[repoBackup] 写入仓库失败原因出错:", error?.message || error));

        console.warn(
          `[repoBackup] 仓库「${repoLabel || repositoryId}」有 ${finalized} 条备份记录长期停在进行中，已收尾为失败`,
        );
        notes.push(`将 ${finalized} 条长期停在「进行中」的备份记录收尾为失败（疑似执行被运行时中断）`);
      }
    }
  } catch (error) {
    console.warn("[repoBackup] 僵尸备份记录收尾检查出错:", error?.message || error);
  }

  /**
   * 第二步：编排任务表（tasks）——修改点（阶段 1 任务卡在 running）
   *
   * 这是 Workers 侧原先完全缺失的收敛路径，详见
   * CodeRepositoryRepository.finalizeStaleRepoJobs 的注释（含三道安全守卫）。
   * 单独 try：它失败不能影响上面已经做完的备份历史收尾。
   */
  try {
    finalizedJobs = await codeRepo.finalizeStaleRepoJobs(
      repositoryId,
      ZOMBIE_JOB_TASK_TYPES,
      staleBeforeMs,
      buildZombieJobReason(minutes),
    );

    if (finalizedJobs > 0) {
      console.warn(
        `[repoBackup] 仓库「${repoLabel || repositoryId}」有 ${finalizedJobs} 个作业长期停在执行中，已收尾为失败`,
      );
      notes.push(`将 ${finalizedJobs} 个长期停在「执行中」的作业收尾为失败（执行体已终止）`);
    }
  } catch (error) {
    console.warn("[repoBackup] 僵尸作业记录收尾检查出错:", error?.message || error);
  }

  if (notes.length === 0) return empty;
  return { finalized, finalizedJobs, summary: `同时${notes.join("；")}` };
}


export default { finalizeZombieBackups };
