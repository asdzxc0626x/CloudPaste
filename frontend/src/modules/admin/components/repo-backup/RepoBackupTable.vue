<script setup>
/**
 * 代码仓库列表（修改点：新增功能）
 * - 展示仓库、跟踪分支、备份目标、最近备份状态
 * - 行级操作：检查更新 / 立即备份 / 历史 / 编辑 / 启用禁用 / 删除
 *
 * 优化点（多分支 / 多备份目标 / 独立备份计划 / 响应式）：
 * - 跟踪列展示全部分支；目标列展示全部挂载点
 * - 最近备份列附带该仓库的备份计划（间隔 + 下次执行时间）
 * - 桌面端（md 以上）用表格；移动端改用卡片列表，
 *   避免 5 列表格在窄屏上被迫横向滚动
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import RepoBackupRowActions from "./RepoBackupRowActions.vue";
// 修改点（站点时区一期）：改用统一的 timeUtils。
// 原来的 new Date(value).toLocaleString() 会把后端下发的
// "2026-01-23 08:12:07"（UTC 无时区标记）当成浏览器本地时间解析，导致时间偏移。
import { formatDateTime } from "@/utils/timeUtils.js";

const props = defineProps({
  repositories: { type: Array, default: () => [] },
  checkResults: { type: Object, default: () => ({}) },
  loading: { type: Boolean, default: false },
  darkMode: { type: Boolean, default: false },
  isRepoBusy: { type: Function, required: true },
});

const emit = defineEmits(["check", "backup", "history", "edit", "toggle", "delete"]);

const { t } = useI18n();

const hasData = computed(() => props.repositories.length > 0);

const showEmpty = computed(() => !hasData.value && !props.loading);
const showLoading = computed(() => props.loading && !hasData.value);

/** 备份状态对应的徽章样式 */
const statusClass = (status) => {
  switch (status) {
    case "success":
      return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300";
    case "partial":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
    case "failed":
      return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
    case "running":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";
    case "skipped":
      return "bg-gray-100 text-gray-700 dark:bg-gray-700/60 dark:text-gray-300";
    // 修改点（状态显示不一致修复）：延迟重试不是失败，用琥珀色而不是红色
    case "deferred":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
    default:
      return "bg-gray-100 text-gray-600 dark:bg-gray-700/60 dark:text-gray-400";
  }
};

// ==================== 统一状态（修改点：状态显示不一致修复）====================

/**
 * 后端 repobackup/status.js 推出的仓库级状态，是这一列状态的唯一来源。
 *
 * 为什么不再直接渲染 repo.lastError：
 *   那个字段一旦非空就被渲染成红字，而 handler 曾经把「已安排在 X 自动重试」
 *   这类**非失败**的说明也写进去，于是仓库管理看着像失败、任务列表却显示跳过。
 *   现在 lastError 只承载真正的失败原因，而「算不算失败」由 state.tone 决定。
 */
const repoState = (repo) => repo.state || { outcome: "pending", tone: "muted", message: null, retryAt: null };

/** 结果色调 → 徽章配色 */
const toneClass = (tone) => {
  switch (tone) {
    case "ok":
      return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300";
    case "info":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";
    case "warn":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
    case "error":
      return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
    default:
      return "bg-gray-100 text-gray-700 dark:bg-gray-700/60 dark:text-gray-300";
  }
};

/** 结果文案：与任务详情共用同一套 i18n 取值，两边不会各叫一个名字 */
const stateLabel = (repo) => {
  const outcome = repoState(repo).outcome;
  const key = `admin.repoBackup.outcome.${outcome}`;
  const text = t(key);
  return text === key ? outcome : text;
};

/**
 * 状态详情：优先给「延迟重试时间」（可以直接本地化成当前时区），
 * 其次才用后端给的说明文本。失败时后端说明就是失败原因。
 */
const stateDetail = (repo) => {
  const state = repoState(repo);
  if (state.retryAt) {
    const at = formatTime(state.retryAt);
    const retryText = t("admin.repoBackup.state.retryAt", { time: at === "-" ? state.retryAt : at });
    return state.message ? `${retryText} · ${state.message}` : retryText;
  }
  return state.message || "";
};

/** 是否需要展示详情文本（正常/已是最新这类无需额外说明） */
const stateHasDetail = (repo) => Boolean(stateDetail(repo));

/**
 * 只有真正的失败才额外展示 last_error
 * （state.message 通常已经带了原因，但 last_error 可能来自另一条链路，
 *   例如「部分目标写入失败」的聚合警告，这里不丢信息）
 */
const showLastError = (repo) => repoState(repo).tone === "error" && Boolean(repo.lastError);

/** 格式化时间（修改点：站点时区一期，改用统一的 timeUtils）*/
const formatTime = (value) => {
  if (!value) return "-";
  const text = formatDateTime(value);
  // timeUtils 解析失败时会返回「日期无效 / Invalid Date」，这类值统一显示为 "-"
  return text === "日期无效" || text === "Invalid Date" ? "-" : text;
};

/** 格式化字节数 */
const formatSize = (bytes) => {
  if (bytes == null || !Number.isFinite(Number(bytes))) return "-";
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(2)} ${units[i]}`;
};

/** 仓库跟踪的分支/标签列表（修改点：多分支优化） */
const trackRefs = (repo) => {
  const refs = Array.isArray(repo.trackRefs) ? repo.trackRefs.filter((r) => r != null) : [];
  if (refs.length > 0) return refs;
  return repo.trackRef ? [repo.trackRef] : [];
};

/** 备份目标挂载点列表（修改点：多备份目标优化） */
const targetMounts = (repo) => (Array.isArray(repo.targetMounts) ? repo.targetMounts.filter(Boolean) : []);

const mountLabel = (mount) => mount.name || mount.mountPath;

/** 逐分支的检查结果（若本次会话检查过） */
const refCheckMap = (repo) => {
  const result = props.checkResults[repo.id];
  if (!result || !Array.isArray(result.refs)) return {};
  const map = {};
  for (const item of result.refs) {
    if (item.ref) map[String(item.ref)] = item;
  }
  return map;
};

/**
 * 逐分支的持久化检测状态（修改点：第 4 期 检测状态持久化）
 *
 * 与 refCheckMap 的区别：refCheckMap 只保存「本次会话点过检查更新」的结果，
 * 刷新页面就没了；这份来自 repo.detectStates，是落库的检测进度，
 * 因此重启/换浏览器后仍能看到每个分支检测到哪个 commit、下次什么时候检测。
 */
const detectStateMap = (repo) => {
  const states = Array.isArray(repo.detectStates) ? repo.detectStates : [];
  const map = {};
  for (const item of states) {
    // 与 trackRefs 的 key 对齐：release 模式「最新」在两侧都用 null 表示
    map[item.ref === null || item.ref === undefined ? "" : String(item.ref)] = item;
  }
  return map;
};

/** 分支 chip 上要展示的状态：优先用本次检查结果，没有则回落到持久化状态 */
const refStatus = (repo, ref) => {
  const session = refCheckMap(repo)[ref];
  if (session) {
    return {
      kind: session.error ? (session.detectStatus === "deferred" ? "deferred" : "error") : "ok",
      hasUpdate: Boolean(session.hasUpdate),
      message: session.error || (session.hasUpdate ? t("admin.repoBackup.check.refHasUpdate") : t("admin.repoBackup.check.refUpToDate")),
    };
  }

  const persisted = detectStateMap(repo)[ref === null || ref === undefined ? "" : String(ref)];
  if (!persisted) return null;

  if (persisted.detectStatus === "error") {
    return { kind: "error", hasUpdate: false, message: persisted.lastError || t("admin.repoBackup.check.refError") };
  }
  if (persisted.detectStatus === "deferred") {
    return { kind: "deferred", hasUpdate: false, message: persisted.lastError || t("admin.repoBackup.check.refDeferred") };
  }
  if (persisted.detectStatus === "pending") {
    return { kind: "pending", hasUpdate: false, message: t("admin.repoBackup.check.persistedPending") };
  }
  return {
    kind: "ok",
    hasUpdate: Boolean(persisted.hasUpdate),
    message: persisted.hasUpdate
      ? t("admin.repoBackup.check.refHasUpdate")
      : t("admin.repoBackup.check.refUpToDate"),
  };
};

/** 是否存在任何已落库的检测状态（决定要不要显示「下次检测」） */
const hasDetectStates = (repo) => Array.isArray(repo.detectStates) && repo.detectStates.length > 0;

/** 所有分支里最早的下次检测时间（列表里只展示一个，避免堆一长串） */
const nextDetectAt = (repo) => {
  const states = (repo.detectStates || []).filter((s) => s.nextDetectAfter);
  if (states.length === 0) return null;
  return states.map((s) => s.nextDetectAfter).sort()[0];
};

const checkSummary = (repo) => {
  const result = props.checkResults[repo.id];
  if (!result) return null;
  return {
    hasUpdate: result.hasUpdate,
    failedCount: result.failedCount || 0,
    // 修改点（第 4 期）：限流/暂时性故障是「已安排重试」，不是失败，必须分开显示
    deferredCount: result.deferredCount || 0,
    allFailed: Boolean(result.allFailed),
  };
};

const chipClass = computed(() =>
  props.darkMode ? "bg-gray-700 text-gray-200" : "bg-gray-100 text-gray-700",
);

// ==================== 备份计划（修改点：独立备份计划优化） ====================

/** 把间隔秒数格式化成人类可读文案 */
const formatInterval = (seconds) => {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "-";
  if (value % 86400 === 0) return t("admin.repoBackup.form.intervalDays", { count: value / 86400 });
  if (value % 3600 === 0) return t("admin.repoBackup.form.intervalHours", { count: value / 3600 });
  return t("admin.repoBackup.form.intervalMinutes", { count: Math.round(value / 60) });
};

/** 计划摘要：未启用 / 每 N 小时 / cron 表达式 */
const scheduleLabel = (repo) => {
  const schedule = repo.schedule;
  if (!schedule || !schedule.enabled) return t("admin.repoBackup.table.scheduleOff");
  // 修改点（备份计划支持 cron）：cron 模式直接显示表达式，比换算成「每 N 小时」更准确
  if (schedule.scheduleType === "cron" && schedule.cronExpression) {
    return t("admin.repoBackup.table.scheduleCron", { cron: schedule.cronExpression });
  }
  return t("admin.repoBackup.table.scheduleEvery", { interval: formatInterval(schedule.intervalSec) });
};

/** 计划已启用时才展示下次执行时间 */
const scheduleNextRun = (repo) => {
  const schedule = repo.schedule;
  if (!schedule || !schedule.enabled || !schedule.nextRunAfter) return "";
  return formatTime(schedule.nextRunAfter);
};

/** 上一次调度执行失败时给出提示（例如仓库被禁用、计划配置失效） */
const scheduleFailed = (repo) => repo.schedule?.enabled === true && repo.schedule?.lastRunStatus === "failure";
</script>

<template>
  <!-- 空状态 -->
  <div
    v-if="showEmpty || showLoading"
    class="rounded-lg border px-4 py-10 text-center text-sm"
    :class="[darkMode ? 'border-gray-700 text-gray-400' : 'border-gray-200 text-gray-500']"
  >
    {{ showLoading ? $t("admin.repoBackup.table.loading") : $t("admin.repoBackup.table.empty") }}
  </div>

  <template v-else>
    <!-- ==================== 桌面端：表格 ==================== -->
    <div class="hidden md:block overflow-x-auto rounded-lg border" :class="darkMode ? 'border-gray-700' : 'border-gray-200'">
      <table class="min-w-full divide-y" :class="darkMode ? 'divide-gray-700' : 'divide-gray-200'">
        <thead :class="darkMode ? 'bg-gray-800' : 'bg-gray-50'">
          <tr>
            <th scope="col" class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" :class="darkMode ? 'text-gray-300' : 'text-gray-500'">
              {{ $t("admin.repoBackup.table.repository") }}
            </th>
            <th scope="col" class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" :class="darkMode ? 'text-gray-300' : 'text-gray-500'">
              {{ $t("admin.repoBackup.table.track") }}
            </th>
            <th scope="col" class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" :class="darkMode ? 'text-gray-300' : 'text-gray-500'">
              {{ $t("admin.repoBackup.table.target") }}
            </th>
            <th scope="col" class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" :class="darkMode ? 'text-gray-300' : 'text-gray-500'">
              {{ $t("admin.repoBackup.table.lastBackup") }}
            </th>
            <th scope="col" class="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider" :class="darkMode ? 'text-gray-300' : 'text-gray-500'">
              {{ $t("admin.repoBackup.table.actions") }}
            </th>
          </tr>
        </thead>

        <tbody :class="darkMode ? 'bg-gray-900 divide-gray-700' : 'bg-white divide-gray-200'" class="divide-y">
          <tr v-for="repo in repositories" :key="repo.id" :class="darkMode ? 'hover:bg-gray-800/60' : 'hover:bg-gray-50'">
            <!-- 仓库 -->
            <td class="px-4 py-3 align-top">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-sm font-medium truncate" :class="darkMode ? 'text-white' : 'text-gray-900'">
                  {{ repo.name }}
                </span>
                <span class="px-1.5 py-0.5 text-[10px] rounded font-medium" :class="chipClass">
                  {{ repo.providerDisplayName }}
                </span>
                <span
                  v-if="!repo.enabled"
                  class="px-1.5 py-0.5 text-[10px] rounded font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300"
                >
                  {{ $t("admin.repoBackup.status.disabled") }}
                </span>
              </div>
              <div class="text-xs mt-0.5 font-mono truncate" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
                {{ repo.repoIdentifier }}
              </div>
              <!-- 状态：统一结果（修改点：状态显示不一致修复）。
                   「已是最新 / 已延迟重试 / 已被阻止」都不是失败，颜色由 tone 决定，
                   不再因为 last_error 非空就渲染成红字。 -->
              <div class="mt-1 flex items-center gap-1.5 flex-wrap">
                <span class="px-1.5 py-0.5 text-[10px] rounded font-medium" :class="toneClass(repoState(repo).tone)">
                  {{ stateLabel(repo) }}
                </span>
                <span
                  v-if="stateHasDetail(repo)"
                  class="text-[11px] break-all"
                  :class="repoState(repo).tone === 'error' ? 'text-red-600 dark:text-red-400' : (darkMode ? 'text-gray-400' : 'text-gray-500')"
                >
                  {{ stateDetail(repo) }}
                </span>
              </div>
              <div v-if="showLastError(repo)" class="text-xs mt-1 text-red-600 dark:text-red-400 break-all">
                {{ repo.lastError }}
              </div>
              <div v-if="checkSummary(repo)" class="text-xs mt-1">
                <span v-if="checkSummary(repo).allFailed" class="text-red-600 dark:text-red-400">
                  {{ $t("admin.repoBackup.check.allFailed") }}
                </span>
                <span v-else :class="checkSummary(repo).hasUpdate ? 'text-blue-600 dark:text-blue-400' : 'text-green-600 dark:text-green-400'">
                  {{ checkSummary(repo).hasUpdate ? $t("admin.repoBackup.check.hasUpdate") : $t("admin.repoBackup.check.upToDate") }}
                </span>
                <span v-if="checkSummary(repo).failedCount > 0" class="text-amber-600 dark:text-amber-400 ml-1">
                  {{ $t("admin.repoBackup.check.partialFailed", { count: checkSummary(repo).failedCount }) }}
                </span>
                <!-- 修改点（第 4 期）：限流/暂时性故障单独提示，避免被读成「检查失败」 -->
                <span v-if="checkSummary(repo).deferredCount > 0" class="text-amber-600 dark:text-amber-400 ml-1">
                  {{ $t("admin.repoBackup.check.partialDeferred", { count: checkSummary(repo).deferredCount }) }}
                </span>
              </div>
            </td>

            <!-- 跟踪版本：多分支逐个展示（修改点：多分支优化） -->
            <td class="px-4 py-3 align-top">
              <div class="text-xs mb-1" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
                {{ $t(`admin.repoBackup.trackMode.${repo.trackMode}`) }}
              </div>
              <div class="flex flex-wrap gap-1 max-w-[16rem]">
                <span
                  v-for="ref in trackRefs(repo)"
                  :key="ref"
                  class="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded font-mono"
                  :class="chipClass"
                >
                  {{ ref }}
                  <!-- 修改点（第 4 期）：优先用本次检查结果，没有则用落库的检测状态 -->
                  <template v-if="refStatus(repo, ref)">
                    <span
                      v-if="refStatus(repo, ref).kind === 'error'"
                      class="text-red-500"
                      :title="refStatus(repo, ref).message"
                    >!</span>
                    <span
                      v-else-if="refStatus(repo, ref).kind === 'deferred'"
                      class="text-amber-500"
                      :title="refStatus(repo, ref).message"
                    >↻</span>
                    <span
                      v-else-if="refStatus(repo, ref).kind === 'pending'"
                      class="text-gray-400"
                      :title="refStatus(repo, ref).message"
                    >·</span>
                    <span
                      v-else
                      :class="refStatus(repo, ref).hasUpdate ? 'text-blue-500' : 'text-green-500'"
                      :title="refStatus(repo, ref).message"
                    >•</span>
                  </template>
                </span>
                <span v-if="trackRefs(repo).length === 0" class="text-xs" :class="darkMode ? 'text-gray-500' : 'text-gray-400'">-</span>
              </div>
              <div v-if="repo.lastCheckedAt" class="text-[11px] mt-1" :class="darkMode ? 'text-gray-500' : 'text-gray-400'">
                {{ $t("admin.repoBackup.table.checkedAt") }}: {{ formatTime(repo.lastCheckedAt) }}
              </div>
              <!-- 修改点（第 4 期）：下次检测时间取自落库的 repo_detect_states，
                   它也是「重启后检测进度不丢」这一条对用户可见的体现 -->
              <div
                v-if="hasDetectStates(repo) && nextDetectAt(repo)"
                class="text-[11px] mt-0.5"
                :class="darkMode ? 'text-gray-500' : 'text-gray-400'"
              >
                {{ $t("admin.repoBackup.table.nextDetect") }}: {{ formatTime(nextDetectAt(repo)) }}
              </div>
            </td>

            <!-- 备份目标：多个挂载点（修改点：多备份目标优化） -->
            <td class="px-4 py-3 align-top">
              <div class="flex flex-wrap gap-1 max-w-[14rem]">
                <span
                  v-for="mount in targetMounts(repo)"
                  :key="mount.id"
                  class="px-1.5 py-0.5 text-[11px] rounded truncate max-w-full"
                  :class="chipClass"
                  :title="mount.mountPath"
                >
                  {{ mountLabel(mount) }}
                </span>
                <span
                  v-if="(repo.missingMountIds || []).length > 0"
                  class="px-1.5 py-0.5 text-[11px] rounded bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                >
                  {{ $t("admin.repoBackup.table.mountMissing") }} {{ (repo.missingMountIds || []).length }}
                </span>
              </div>
              <div v-if="repo.backupFolder" class="text-[11px] mt-1 font-mono break-all" :class="darkMode ? 'text-gray-500' : 'text-gray-400'">
                {{ repo.backupFolder }}
              </div>
              <div class="text-[11px] mt-1" :class="darkMode ? 'text-gray-500' : 'text-gray-400'">
                {{ $t("admin.repoBackup.table.retention", { count: repo.retentionCount }) }}
              </div>
            </td>

            <!-- 最近备份 -->
            <td class="px-4 py-3 align-top">
              <template v-if="repo.latestBackup">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="px-1.5 py-0.5 text-[10px] rounded font-medium" :class="statusClass(repo.latestBackup.status)">
                    {{ $t(`admin.repoBackup.backupStatus.${repo.latestBackup.status}`) }}
                  </span>
                  <span class="text-xs font-mono" :class="darkMode ? 'text-gray-300' : 'text-gray-600'">
                    {{ repo.latestBackup.ref || repo.latestBackup.shortCommitSha }}
                  </span>
                </div>
                <div class="text-xs mt-0.5" :class="darkMode ? 'text-gray-500' : 'text-gray-400'">
                  {{ formatTime(repo.latestBackup.finishedAt || repo.latestBackup.createdAt) }}
                  <span v-if="repo.latestBackup.sizeBytes"> · {{ formatSize(repo.latestBackup.sizeBytes) }}</span>
                </div>
                <!-- 各目标写入情况（修改点：多备份目标优化） -->
                <div v-if="(repo.latestBackup.targets || []).length > 0" class="text-[11px] mt-0.5" :class="darkMode ? 'text-gray-500' : 'text-gray-400'">
                  {{ $t("admin.repoBackup.table.targetsOk", { ok: (repo.latestBackup.targets || []).filter((t) => t.status === 'success').length, total: (repo.latestBackup.targets || []).length }) }}
                </div>
              </template>
              <span v-else class="text-xs" :class="darkMode ? 'text-gray-500' : 'text-gray-400'">
                {{ $t("admin.repoBackup.table.neverBackedUp") }}
              </span>

              <!-- 备份计划（修改点：独立备份计划优化） -->
              <div class="mt-1.5 flex items-center gap-1 flex-wrap text-[11px]">
                <span
                  class="px-1.5 py-0.5 rounded"
                  :class="repo.schedule?.enabled
                    ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300'
                    : (darkMode ? 'bg-gray-700 text-gray-400' : 'bg-gray-100 text-gray-500')"
                >
                  {{ scheduleLabel(repo) }}
                </span>
                <span v-if="scheduleNextRun(repo)" :class="darkMode ? 'text-gray-500' : 'text-gray-400'">
                  {{ $t("admin.repoBackup.table.scheduleNext") }} {{ scheduleNextRun(repo) }}
                </span>
                <span v-if="scheduleFailed(repo)" class="text-amber-600 dark:text-amber-400">
                  {{ $t("admin.repoBackup.table.scheduleLastFailed") }}
                </span>
              </div>
            </td>

            <!-- 操作 -->
            <td class="px-4 py-3 align-top">
              <RepoBackupRowActions
                :repo="repo"
                :busy="isRepoBusy(repo.id)"
                :dark-mode="darkMode"
                icon-only
                @check="emit('check', $event)"
                @backup="emit('backup', $event)"
                @history="emit('history', $event)"
                @edit="emit('edit', $event)"
                @toggle="emit('toggle', $event)"
                @delete="emit('delete', $event)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ==================== 移动端：卡片列表 ==================== -->
    <div class="md:hidden space-y-3">
      <div
        v-for="repo in repositories"
        :key="repo.id"
        class="rounded-lg border p-3"
        :class="darkMode ? 'border-gray-700 bg-gray-900' : 'border-gray-200 bg-white'"
      >
        <!-- 标题行 -->
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="text-sm font-medium truncate" :class="darkMode ? 'text-white' : 'text-gray-900'">{{ repo.name }}</span>
              <span class="px-1.5 py-0.5 text-[10px] rounded font-medium" :class="chipClass">{{ repo.providerDisplayName }}</span>
              <span
                v-if="!repo.enabled"
                class="px-1.5 py-0.5 text-[10px] rounded font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300"
              >
                {{ $t("admin.repoBackup.status.disabled") }}
              </span>
            </div>
            <div class="text-[11px] mt-0.5 font-mono break-all" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
              {{ repo.repoIdentifier }}
            </div>
          </div>
          <span
            v-if="repo.latestBackup"
            class="shrink-0 px-1.5 py-0.5 text-[10px] rounded font-medium"
            :class="statusClass(repo.latestBackup.status)"
          >
            {{ $t(`admin.repoBackup.backupStatus.${repo.latestBackup.status}`) }}
          </span>
        </div>

        <!-- 详情行：标签式，天然换行，不会横向溢出 -->
        <dl class="mt-2 space-y-1.5 text-[11px]">
          <div class="flex gap-2">
            <dt class="shrink-0 w-14" :class="darkMode ? 'text-gray-500' : 'text-gray-400'">{{ $t("admin.repoBackup.table.track") }}</dt>
            <dd class="min-w-0 flex flex-wrap gap-1">
              <span v-for="ref in trackRefs(repo)" :key="ref" class="px-1.5 py-0.5 rounded font-mono" :class="chipClass">{{ ref }}</span>
              <span v-if="trackRefs(repo).length === 0">-</span>
            </dd>
          </div>
          <div class="flex gap-2">
            <dt class="shrink-0 w-14" :class="darkMode ? 'text-gray-500' : 'text-gray-400'">{{ $t("admin.repoBackup.table.target") }}</dt>
            <dd class="min-w-0 flex flex-wrap gap-1">
              <span v-for="mount in targetMounts(repo)" :key="mount.id" class="px-1.5 py-0.5 rounded truncate max-w-[10rem]" :class="chipClass">
                {{ mountLabel(mount) }}
              </span>
              <span v-if="targetMounts(repo).length === 0" class="text-red-600 dark:text-red-400">
                {{ $t("admin.repoBackup.table.mountMissing") }}
              </span>
            </dd>
          </div>
          <div class="flex gap-2">
            <dt class="shrink-0 w-14" :class="darkMode ? 'text-gray-500' : 'text-gray-400'">{{ $t("admin.repoBackup.table.lastBackup") }}</dt>
            <dd class="min-w-0" :class="darkMode ? 'text-gray-300' : 'text-gray-600'">
              <template v-if="repo.latestBackup">
                {{ formatTime(repo.latestBackup.finishedAt || repo.latestBackup.createdAt) }}
                <span v-if="repo.latestBackup.sizeBytes"> · {{ formatSize(repo.latestBackup.sizeBytes) }}</span>
              </template>
              <template v-else>{{ $t("admin.repoBackup.table.neverBackedUp") }}</template>
            </dd>
          </div>
          <div v-if="showLastError(repo)" class="text-red-600 dark:text-red-400 break-all">{{ repo.lastError }}</div>
          <!-- 状态：统一结果（修改点：状态显示不一致修复），移动端与桌面端同一套判定 -->
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="px-1.5 py-0.5 text-[10px] rounded font-medium" :class="toneClass(repoState(repo).tone)">
              {{ stateLabel(repo) }}
            </span>
            <span
              v-if="stateHasDetail(repo)"
              class="min-w-0 text-[11px] break-all"
              :class="repoState(repo).tone === 'error' ? 'text-red-600 dark:text-red-400' : (darkMode ? 'text-gray-400' : 'text-gray-500')"
            >
              {{ stateDetail(repo) }}
            </span>
          </div>

          <!-- 备份计划（修改点：独立备份计划优化） -->
          <div class="flex gap-2">
            <dt class="shrink-0 w-14" :class="darkMode ? 'text-gray-500' : 'text-gray-400'">{{ $t("admin.repoBackup.table.schedule") }}</dt>
            <dd class="min-w-0 flex flex-wrap items-center gap-1">
              <span
                class="px-1.5 py-0.5 rounded"
                :class="repo.schedule?.enabled
                  ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300'
                  : (darkMode ? 'bg-gray-700 text-gray-400' : 'bg-gray-100 text-gray-500')"
              >
                {{ scheduleLabel(repo) }}
              </span>
              <span v-if="scheduleNextRun(repo)" :class="darkMode ? 'text-gray-500' : 'text-gray-400'">
                {{ $t("admin.repoBackup.table.scheduleNext") }} {{ scheduleNextRun(repo) }}
              </span>
              <span v-if="scheduleFailed(repo)" class="text-amber-600 dark:text-amber-400">
                {{ $t("admin.repoBackup.table.scheduleLastFailed") }}
              </span>
            </dd>
          </div>
        </dl>

        <div class="mt-2.5 pt-2.5 border-t" :class="darkMode ? 'border-gray-700' : 'border-gray-200'">
          <RepoBackupRowActions
            :repo="repo"
            :busy="isRepoBusy(repo.id)"
            :dark-mode="darkMode"
            @check="emit('check', $event)"
            @backup="emit('backup', $event)"
            @history="emit('history', $event)"
            @edit="emit('edit', $event)"
            @toggle="emit('toggle', $event)"
            @delete="emit('delete', $event)"
          />
        </div>
      </div>
    </div>
  </template>
</template>
