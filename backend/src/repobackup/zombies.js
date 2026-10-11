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
    `如为大仓库，可减少备份目标数量，或参考 wrangler.toml 的 [limits] cpu_ms ` +
    `与 REPO_BACKUP_* 预算配置`
  );
}

/**
 * 把某仓库「卡在 running 的僵尸备份记录」收尾成 failed
 *
 * 安全性：只改 status='running' 且已经过了收尾窗口的行。万一判早了（作业其实还在跑），
 * 作业结束时会自己 updateBackup 覆盖回 success/partial/failed，不会留下错误的终态。
 *
 * 失败处理：收尾只是「补一条说明」，绝不能影响调用方的主流程，
 * 所以整段包在 try 里，出错只打日志并返回空摘要。
 *
 * @param {Object} params
 * @param {Object} params.codeRepo CodeRepositoryRepository 实例
 * @param {string} params.repositoryId
 * @param {string} [params.repoLabel] 仓库显示名（仅用于日志）
 * @returns {Promise<{ finalized: number, summary: string }>} summary 可直接拼进运行摘要；无事可做时为空串
 */
export async function finalizeZombieBackups({ codeRepo, repositoryId, repoLabel = "" }) {
  const empty = { finalized: 0, summary: "" };
  if (!codeRepo || !repositoryId) return empty;

  try {
    const zombieBefore = new Date(Date.now() - ZOMBIE_RUNNING_BACKUP_SEC * 1000).toISOString();
    const zombies = await codeRepo.findRunningBackupsBefore(repositoryId, zombieBefore);
    if (!Array.isArray(zombies) || zombies.length === 0) return empty;

    const reason = buildZombieReason(Math.round(ZOMBIE_RUNNING_BACKUP_SEC / 60));
    let finalized = 0;

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

    if (finalized === 0) return empty;

    // 仓库级 last_error：「仓库管理」页只看这个字段决定是否显示失败
    await codeRepo
      .updateRepository(repositoryId, { last_error: reason })
      .catch((error) => console.warn("[repoBackup] 写入仓库失败原因出错:", error?.message || error));

    console.warn(
      `[repoBackup] 仓库「${repoLabel || repositoryId}」有 ${finalized} 条备份记录长期停在进行中，已收尾为失败`,
    );

    return {
      finalized,
      summary: `同时将 ${finalized} 条长期停在「进行中」的备份记录收尾为失败（疑似执行被运行时中断）`,
    };
  } catch (error) {
    console.warn("[repoBackup] 僵尸备份记录收尾检查出错:", error?.message || error);
    return empty;
  }
}

export default { finalizeZombieBackups };
