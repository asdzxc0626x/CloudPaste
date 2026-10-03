/**
 * 代码仓库备份 - 版本检测核心（修改点：第 4 期 检测状态持久化）
 *
 * 这里是「检测」这件事的唯一实现，三个入口共用：
 *   1. repo_backup_check 任务（定时检测，发现新版本才创建 repo_backup）
 *   2. 「检查更新」按钮（手动检测）
 *   3. 手动备份前的版本解析
 * 共用的意义不只是省代码 —— 三个入口必须看到**同一份**水位与同一套延迟语义，
 * 否则「页面上显示有更新、定时任务却不备份」这类矛盾就会出现。
 *
 * 为什么不沿用原先的「备份任务内部边解析边下载」：
 *   原实现里版本解析发生在 RepoBackupTaskHandler 内部，于是
 *   - 每个备份周期都要先打一次 GitHub API，即使什么都没变；
 *   - 解析结果只活在那次任务的内存里，进程重启就没了；
 *   - 限流发生在「已经创建了备份任务之后」，任务只能记一个空转。
 *   第 4 期把解析前移成独立的检测阶段并落库，上面三条一次解决。
 *
 * 必须守住的语义（延续第 2 / 3 期，不做任何改动）：
 *   - 限流 / 暂时性错误 = 「延迟」，不是「失败」：写 detect_status='deferred'，
 *     next_detect_after = 上游给的恢复时间，不累计 consecutive_error_count；
 *   - 永久性错误才算失败：consecutive_error_count++ 并按次数退避；
 *   - 所有 GitHub 请求都经由 provider → GithubRequestScheduler（并发/间隔/额度账本）
 *     与 Token / 代理轮询池，本模块不直接碰 fetch，也不自己做节流。
 */

import { resolveTrackRefs } from "./config.js";
import { classifyRepoBackupError, planRetryForError, REPO_ERROR_KIND } from "./errors.js";

/** 检测状态取值 */
export const DETECT_STATUS = {
  /** 还没检测过（新建行 / 迁移回填行的初始值） */
  PENDING: "pending",
  /** 检测成功 */
  OK: "ok",
  /** 限流 / 暂时性错误，已安排延迟重检 */
  DEFERRED: "deferred",
  /** 永久性错误（分支不存在等） */
  ERROR: "error",
};

/**
 * 检测成功后的基础重检间隔
 *
 * 这个值不是「备份间隔」—— 备份间隔仍由 scheduled_jobs 决定。
 * 它是 next_detect_after 的基线：防止同一个引用在一个备份周期内
 * 被反复检测（例如用户连点「检查更新」，或 cron 粒度比备份间隔细）。
 * 取得比最小备份间隔（15 分钟）略小，确保不会挡住正常的备份周期。
 */
export const DETECT_BASE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 「长期没动静」时的重检间隔上限
 *
 * 连续多次检测都发现无更新，说明这个引用不活跃，没必要保持高频检测。
 * 按 consecutive_unchanged_count 线性放大到这个上限为止。
 * 注意这只延后**检测**，不改变用户配置的备份周期：一旦有更新，
 * 下一次到期检测就会发现并立即创建备份。
 */
export const DETECT_MAX_UNCHANGED_INTERVAL_MS = 60 * 60 * 1000;

/** 永久性错误的退避区间：第 N 次连续失败等 N × 基数，封顶 6 小时 */
export const DETECT_ERROR_BACKOFF_BASE_MS = 30 * 60 * 1000;
export const DETECT_ERROR_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

/**
 * next_detect_after 的随机抖动比例
 *
 * 需求 10（多仓库大量到期时不能形成请求洪峰）的第一道闸门：
 * 若所有引用都算出完全相同的下次检测时间，它们会在同一个 tick 一起到期。
 * 给每个引用的间隔叠加 ±15% 的抖动，时间上自然散开。
 */
const DETECT_JITTER_RATIO = 0.15;

/**
 * 单轮检测最多处理多少个引用
 *
 * 需求 10 的第二道闸门。即使某个仓库跟踪了 50 个分支，一轮也只检测前 N 个，
 * 剩下的留给下一轮（findDueDetectStates 按 next_detect_after 升序取，
 * 没轮到的这一批下次自然排在最前面，不会饿死）。
 *
 * 为什么是 8：批量路径下 refCount >= 2 时 provider 用 /branches 列表接口，
 * 一次请求（必要时翻页，上限 3 页 × 100 条）就能覆盖这一批，
 * 实际 API 消耗与 1 个分支几乎相同；真正要限的是 release 模式下
 * 「每个 tag 一次请求」的情况。
 */
export const DETECT_MAX_REFS_PER_RUN = 8;

/** 把 ref 规整成能进唯一索引的形式（release 模式「最新」用空串占位） */
export function normalizeRef(ref) {
  return ref === null || ref === undefined ? "" : String(ref);
}

/**
 * 由仓库的 track_mode 推出 detect state 的 ref_type
 * @param {string} trackMode
 * @returns {'branch'|'tag'}
 */
export function refTypeOfTrackMode(trackMode) {
  return String(trackMode || "branch") === "branch" ? "branch" : "tag";
}

/**
 * 把仓库行解析成「它当前跟踪的引用集合」（detect state 的自然键集合）
 * @param {object} repoRow code_repositories 行
 * @returns {Array<{refType: 'branch'|'tag', ref: string}>}
 */
export function resolveTrackedRefKeys(repoRow) {
  const refType = refTypeOfTrackMode(repoRow?.track_mode);
  return resolveTrackRefs(repoRow).map((ref) => ({ refType, ref: normalizeRef(ref) }));
}

/** 给时长叠加 ±DETECT_JITTER_RATIO 的抖动 */
function withJitter(ms) {
  const span = ms * DETECT_JITTER_RATIO;
  return Math.max(1000, Math.round(ms - span + Math.random() * span * 2));
}

/**
 * 计算「检测成功」后的下次检测时间
 *
 * @param {number} consecutiveUnchanged 连续无更新次数（本次之后的值）
 * @param {boolean} hasUpdate 本次是否发现了更新
 * @returns {string} ISO 字符串
 */
export function computeNextDetectAfterOnSuccess(consecutiveUnchanged, hasUpdate) {
  // 有更新时不放大间隔：接下来很可能还会有后续提交，保持基础频率
  if (hasUpdate) {
    return new Date(Date.now() + withJitter(DETECT_BASE_INTERVAL_MS)).toISOString();
  }

  // 无更新：按连续无更新次数线性放大，封顶 DETECT_MAX_UNCHANGED_INTERVAL_MS
  const scaled = DETECT_BASE_INTERVAL_MS * Math.max(1, Math.min(6, consecutiveUnchanged));
  const capped = Math.min(scaled, DETECT_MAX_UNCHANGED_INTERVAL_MS);
  return new Date(Date.now() + withJitter(capped)).toISOString();
}

/**
 * 计算「永久性错误」后的下次检测时间
 * @param {number} consecutiveErrors 连续失败次数（本次之后的值）
 * @returns {string} ISO 字符串
 */
export function computeNextDetectAfterOnError(consecutiveErrors) {
  const n = Math.max(1, Math.trunc(Number(consecutiveErrors) || 1));
  const delay = Math.min(DETECT_ERROR_BACKOFF_BASE_MS * n, DETECT_ERROR_BACKOFF_MAX_MS);
  return new Date(Date.now() + withJitter(delay)).toISOString();
}

/**
 * 把一行 detect state 规整成 API / 任务层使用的结构
 * @param {object} row repo_detect_states 行
 * @returns {object}
 */
export function toDetectStateDto(row) {
  if (!row) return null;
  const commitSha = row.commit_sha ? String(row.commit_sha) : null;
  const backedUpSha = row.backed_up_commit_sha ? String(row.backed_up_commit_sha) : null;
  return {
    refType: row.ref_type || "branch",
    // 空串在 DTO 里还原成 null，前端展示「最新 Release」而不是空白
    ref: row.ref === "" ? null : row.ref,
    detectStatus: row.detect_status || DETECT_STATUS.PENDING,
    commitSha,
    shortCommitSha: commitSha ? commitSha.slice(0, 7) : null,
    version: row.version ?? null,
    publishedAt: row.published_at ?? null,
    backedUpCommitSha: backedUpSha,
    backedUpAt: row.backed_up_at ?? null,
    lastDetectAt: row.last_detect_at ?? null,
    lastSuccessDetectAt: row.last_success_detect_at ?? null,
    nextDetectAfter: row.next_detect_after ?? null,
    lastError: row.last_error ?? null,
    lastErrorKind: row.last_error_kind ?? null,
    consecutiveErrorCount: Number(row.consecutive_error_count) || 0,
    consecutiveUnchangedCount: Number(row.consecutive_unchanged_count) || 0,
    /**
     * 是否有未备份的新版本 —— 判定只看这一处：
     * 解析到的 commit 与已备份水位不同。
     * 不去查 code_repository_backups：那张表按 commit 去重，
     * 回答不了「这个引用当前水位在哪」，两套判定源会给出矛盾答案。
     */
    hasUpdate: Boolean(commitSha) && commitSha !== backedUpSha,
    alreadyBackedUp: Boolean(commitSha) && commitSha === backedUpSha,
  };
}

/**
 * 检测一组引用的最新版本并把结果落库
 *
 * 本函数只做「解析 + 落库」，**不创建备份任务**：
 * 要不要备份是调用方的决定（定时检测会创建，手动「检查更新」不会）。
 *
 * @param {object} params
 * @param {object} params.codeRepo CodeRepositoryRepository 实例
 * @param {object} params.provider RepoProvider 实例（已带 db/env/凭据池）
 * @param {object} params.repoRow code_repositories 行
 * @param {Array<{refType: string, ref: string}>} params.refs 本轮要检测的引用
 * @returns {Promise<{
 *   results: Array<object>,
 *   updatedRefs: Array<object>,
 *   deferredUntilMs: number|null,
 *   deferredKind: string|null,
 *   deferredMessage: string|null,
 *   successCount: number,
 *   errorCount: number,
 *   deferredCount: number,
 * }>}
 */
export async function detectRefs({ codeRepo, provider, repoRow, refs }) {
  const trackMode = String(repoRow?.track_mode || "branch");
  const repositoryId = repoRow.id;
  const list = Array.isArray(refs) ? refs : [];

  /** @type {Array<object>} 逐引用的检测结果（给任务详情 / API 展示） */
  const results = [];
  /** @type {Array<object>} 发现新版本的引用（调用方据此创建备份任务） */
  const updatedRefs = [];

  /**
   * 本轮出现过的「可延迟重试」时间里最早的那个
   * 一处限流就说明额度已经打满，整轮都该按最早的时间重来，
   * 而不是每个引用各排一个时间（与第 2 期 RepoBackupTaskHandler 的口径一致）
   */
  let deferredUntilMs = null;
  let deferredKind = null;
  let deferredMessage = null;

  let successCount = 0;
  let errorCount = 0;
  let deferredCount = 0;

  for (const item of list) {
    const refType = String(item?.refType || refTypeOfTrackMode(trackMode));
    const ref = normalizeRef(item?.ref);
    const nowIso = new Date().toISOString();

    // 已存在的状态行（拿连续计数与当前水位）
    const prior = item?.row || null;
    const priorUnchanged = Number(prior?.consecutive_unchanged_count) || 0;
    const priorErrors = Number(prior?.consecutive_error_count) || 0;
    const backedUpSha = prior?.backed_up_commit_sha ? String(prior.backed_up_commit_sha) : null;

    try {
      const latest = await provider.resolveLatestVersion({
        repoIdentifier: repoRow.repo_identifier,
        trackMode,
        // release 模式下空串要还原成 null（provider 用 null 表示「取最新」）
        trackRef: ref === "" ? null : ref,
        // 第 1 期的批量优化：告诉 provider 本轮一共要解析几个引用，
        // >= 2 时它会用 1 次 /branches 请求覆盖整批
        refCount: list.length,
      });

      const commitSha = latest?.commitSha ? String(latest.commitSha) : null;
      if (!commitSha) {
        throw new Error("检测结果缺少 commit sha");
      }

      const hasUpdate = commitSha !== backedUpSha;
      const nextUnchanged = hasUpdate ? 0 : priorUnchanged + 1;

      await codeRepo.updateDetectState(repositoryId, refType, ref, {
        detect_status: DETECT_STATUS.OK,
        commit_sha: commitSha,
        version: latest.version ?? null,
        published_at: latest.publishedAt ?? null,
        last_detect_at: nowIso,
        last_success_detect_at: nowIso,
        next_detect_after: computeNextDetectAfterOnSuccess(nextUnchanged, hasUpdate),
        // 检测成功就清掉上一次的错误，否则「已经好了」的仓库会一直挂着红字
        last_error: null,
        last_error_kind: null,
        consecutive_error_count: 0,
        consecutive_unchanged_count: nextUnchanged,
      });

      const entry = {
        refType: latest.refType || refType,
        ref: latest.ref ?? (ref === "" ? null : ref),
        commitSha,
        shortCommitSha: commitSha.slice(0, 7),
        version: latest.version ?? null,
        publishedAt: latest.publishedAt ?? null,
        hasUpdate,
        alreadyBackedUp: !hasUpdate,
        detectStatus: DETECT_STATUS.OK,
        error: null,
        errorKind: null,
      };
      results.push(entry);
      if (hasUpdate) updatedRefs.push(entry);
      successCount += 1;
    } catch (error) {
      const info = classifyRepoBackupError(error);
      const plan = planRetryForError(error);

      if (plan.deferrable && plan.retryAtMs !== null) {
        // ---------- 限流 / 暂时性：延迟，不是失败 ----------
        if (deferredUntilMs === null || plan.retryAtMs < deferredUntilMs) {
          deferredUntilMs = plan.retryAtMs;
          deferredKind = plan.kind;
          deferredMessage = plan.message;
        }

        await codeRepo.updateDetectState(repositoryId, refType, ref, {
          detect_status: DETECT_STATUS.DEFERRED,
          last_detect_at: nowIso,
          next_detect_after: new Date(plan.retryAtMs).toISOString(),
          last_error: plan.message,
          last_error_kind: plan.kind,
          // 关键：限流不累计失败次数，否则「上游抽风」会被当成「仓库坏了」
          // 并把重检间隔一路退避到 6 小时
          consecutive_error_count: priorErrors,
        });

        results.push({
          refType,
          ref: ref === "" ? null : ref,
          commitSha: prior?.commit_sha ?? null,
          shortCommitSha: prior?.commit_sha ? String(prior.commit_sha).slice(0, 7) : null,
          version: prior?.version ?? null,
          publishedAt: prior?.published_at ?? null,
          hasUpdate: false,
          alreadyBackedUp: false,
          detectStatus: DETECT_STATUS.DEFERRED,
          error: plan.message,
          errorKind: plan.kind,
          retryAt: new Date(plan.retryAtMs).toISOString(),
        });
        deferredCount += 1;
        continue;
      }

      // ---------- 永久性：记失败并退避 ----------
      const nextErrors = priorErrors + 1;
      await codeRepo.updateDetectState(repositoryId, refType, ref, {
        detect_status: DETECT_STATUS.ERROR,
        last_detect_at: nowIso,
        next_detect_after: computeNextDetectAfterOnError(nextErrors),
        last_error: info.message,
        last_error_kind: REPO_ERROR_KIND.PERMANENT,
        consecutive_error_count: nextErrors,
      });

      results.push({
        refType,
        ref: ref === "" ? null : ref,
        commitSha: prior?.commit_sha ?? null,
        shortCommitSha: prior?.commit_sha ? String(prior.commit_sha).slice(0, 7) : null,
        version: prior?.version ?? null,
        publishedAt: prior?.published_at ?? null,
        hasUpdate: false,
        alreadyBackedUp: false,
        detectStatus: DETECT_STATUS.ERROR,
        error: info.message,
        errorKind: REPO_ERROR_KIND.PERMANENT,
      });
      errorCount += 1;
    }
  }

  return {
    results,
    updatedRefs,
    deferredUntilMs,
    deferredKind,
    deferredMessage,
    successCount,
    errorCount,
    deferredCount,
  };
}

/**
 * 准备一轮检测：补建状态行、清理过期引用、挑出到期的引用
 *
 * @param {object} params
 * @param {object} params.codeRepo CodeRepositoryRepository 实例
 * @param {object} params.repoRow code_repositories 行
 * @param {number} [params.maxRefs] 本轮最多检测多少个引用（削峰）
 * @param {boolean} [params.ignoreDue] 为 true 时忽略 next_detect_after，检测全部跟踪引用
 *        （手动「检查更新」用：用户明确要求立刻看，不该被退避挡住）
 * @returns {Promise<{
 *   refs: Array<{refType: string, ref: string, row: object|null}>,
 *   trackedCount: number,
 *   dueCount: number,
 *   prunedCount: number,
 * }>}
 */
export async function prepareDetectRound({ codeRepo, repoRow, maxRefs = DETECT_MAX_REFS_PER_RUN, ignoreDue = false }) {
  const repositoryId = repoRow.id;
  const tracked = resolveTrackedRefKeys(repoRow);

  // 1. 给当前跟踪的引用补建状态行（幂等，已存在的一个字段都不碰）
  await codeRepo.ensureDetectStates(repositoryId, tracked);

  // 2. 清掉已经不再跟踪的引用（用户从表单里删掉了某个分支）
  const prunedCount = await codeRepo.pruneDetectStates(repositoryId, tracked);

  const nowIso = new Date().toISOString();

  // 3. 挑出本轮要检测的引用
  if (ignoreDue) {
    const all = await codeRepo.findDetectStates(repositoryId);
    const byKey = new Map(all.map((row) => [`${row.ref_type}\u0000${row.ref}`, row]));
    return {
      refs: tracked.map((item) => ({
        ...item,
        row: byKey.get(`${item.refType}\u0000${item.ref}`) || null,
      })),
      trackedCount: tracked.length,
      dueCount: tracked.length,
      prunedCount,
    };
  }

  const dueRows = await codeRepo.findDueDetectStates(repositoryId, nowIso, maxRefs);
  const dueCount = await codeRepo.countDueDetectStates(repositoryId, nowIso);

  return {
    refs: dueRows.map((row) => ({
      refType: row.ref_type,
      ref: normalizeRef(row.ref),
      row,
    })),
    trackedCount: tracked.length,
    dueCount,
    prunedCount,
  };
}

/**
 * 备份成功后推进该引用的水位（修改点：第 4 期）
 *
 * 这是「检测 → 备份」闭环的最后一步。不调用它的后果是：
 * 下一轮检测仍会认为有更新，于是同一个版本被反复备份。
 *
 * 为什么先 ensure 再 update（而不是直接 UPDATE）：
 *   正常链路下这一行必然存在（检测任务建过），但存在两条会缺行的路径：
 *     · 升级前就已入队、payload 里没有 refs 的老作业（走 handler 的自解析退路）
 *     · 直接按 repositoryId 调 createJob 的外部脚本
 *   直接 UPDATE 会命中 0 行、静默什么都不做，于是「备份成功 → 水位不动 →
 *   下轮又判有更新 → 再备份 → 发现重复而跳过 → 水位还是不动」形成空转。
 *   补一次幂等的 ensure 只多一条 INSERT OR NOTHING，却把这条环路堵死。
 *
 * @param {object} codeRepo CodeRepositoryRepository 实例
 * @param {string} repositoryId
 * @param {string} refType 'branch' | 'tag'
 * @param {string|null} ref
 * @param {string} commitSha 刚刚备份成功的 commit
 * @param {{ markDetected?: boolean }} [options]
 *        markDetected=true 时同时把该引用记为「检测成功且水位一致」
 *        （修改点：正常跳过时的状态一致性）
 * @returns {Promise<boolean>}
 */
export async function advanceBackedUpWatermark(codeRepo, repositoryId, refType, ref, commitSha, options = {}) {
  if (!codeRepo || !repositoryId || !commitSha) return false;
  const nowIso = new Date().toISOString();
  // refType 进来时已经是 'branch' | 'tag'，这里只做一次兜底归一
  const normalizedType = String(refType || "branch") === "tag" ? "tag" : "branch";
  const normalizedRef = normalizeRef(ref);

  await codeRepo.ensureDetectStates(repositoryId, [{ refType: normalizedType, ref: normalizedRef }]);

  const patch = {
    backed_up_commit_sha: String(commitSha),
    backed_up_at: nowIso,
    // 水位推进后这个引用就「无更新」了，连续无更新计数从 1 开始
    consecutive_unchanged_count: 1,
  };

  /**
   * 修改点（正常跳过时的状态一致性）：markDetected 额外把这次解析到的版本
   * 记成一次成功的检测。
   *
   * 只在「备份任务发现该 commit 已有完整副本而跳过」时使用。那种情况下我们
   * 确实知道当前版本是什么（来自已解析的 refs 或刚刚的解析）且它已经备份过了，
   * 这正是 detect_status='ok' + commit 水位 = 已备份水位 的含义。
   * 不记的话该引用的状态会停在 pending，仓库管理页就只能显示「成功完成」，
   * 而任务列表显示「已是最新，无需备份」—— 两处又不一致了。
   *
   * 刻意不重算 next_detect_after：检测节奏由检测链路决定，
   * 备份链路不该顺手改动它（保持原有 next_detect_after）。
   */
  if (options.markDetected) {
    patch.detect_status = DETECT_STATUS.OK;
    patch.commit_sha = String(commitSha);
    patch.last_detect_at = nowIso;
    patch.last_success_detect_at = nowIso;
    // 既然确认已备份，之前的错误/延迟痕迹就该清掉
    patch.last_error = null;
    patch.last_error_kind = null;
    patch.consecutive_error_count = 0;
  }

  return await codeRepo.updateDetectState(repositoryId, normalizedType, normalizedRef, patch);
}

export default {
  DETECT_STATUS,
  DETECT_BASE_INTERVAL_MS,
  DETECT_MAX_UNCHANGED_INTERVAL_MS,
  DETECT_ERROR_BACKOFF_BASE_MS,
  DETECT_ERROR_BACKOFF_MAX_MS,
  DETECT_MAX_REFS_PER_RUN,
  normalizeRef,
  refTypeOfTrackMode,
  resolveTrackedRefKeys,
  computeNextDetectAfterOnSuccess,
  computeNextDetectAfterOnError,
  toDetectStateDto,
  detectRefs,
  prepareDetectRound,
  advanceBackedUpWatermark,
};
