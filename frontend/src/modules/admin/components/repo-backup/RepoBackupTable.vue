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
    default:
      return "bg-gray-100 text-gray-600 dark:bg-gray-700/60 dark:text-gray-400";
  }
};

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

const checkSummary = (repo) => {
  const result = props.checkResults[repo.id];
  if (!result) return null;
  return {
    hasUpdate: result.hasUpdate,
    failedCount: result.failedCount || 0,
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
              <div v-if="repo.lastError" class="text-xs mt-1 text-red-600 dark:text-red-400 break-all">
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
                  <template v-if="refCheckMap(repo)[ref]">
                    <span
                      v-if="refCheckMap(repo)[ref].error"
                      class="text-red-500"
                      :title="refCheckMap(repo)[ref].error"
                    >!</span>
                    <span
                      v-else
                      :class="refCheckMap(repo)[ref].hasUpdate ? 'text-blue-500' : 'text-green-500'"
                      :title="refCheckMap(repo)[ref].hasUpdate ? $t('admin.repoBackup.check.refHasUpdate') : $t('admin.repoBackup.check.refUpToDate')"
                    >•</span>
                  </template>
                </span>
                <span v-if="trackRefs(repo).length === 0" class="text-xs" :class="darkMode ? 'text-gray-500' : 'text-gray-400'">-</span>
              </div>
              <div v-if="repo.lastCheckedAt" class="text-[11px] mt-1" :class="darkMode ? 'text-gray-500' : 'text-gray-400'">
                {{ $t("admin.repoBackup.table.checkedAt") }}: {{ formatTime(repo.lastCheckedAt) }}
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
          <div v-if="repo.lastError" class="text-red-600 dark:text-red-400 break-all">{{ repo.lastError }}</div>

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
