<script setup>
/**
 * 代码仓库列表表格（修改点：新增功能）
 * - 展示仓库、跟踪模式、备份目标、最近备份状态
 * - 行级操作：检查更新 / 立即备份 / 历史 / 编辑 / 启用禁用 / 删除
 */
import { computed } from "vue";
import { IconRefresh, IconArchive, IconClock, IconDelete, IconRename } from "@/components/icons";

const props = defineProps({
  repositories: { type: Array, default: () => [] },
  checkResults: { type: Object, default: () => ({}) },
  loading: { type: Boolean, default: false },
  darkMode: { type: Boolean, default: false },
  isRepoBusy: { type: Function, required: true },
});

const emit = defineEmits(["check", "backup", "history", "edit", "toggle", "delete"]);

const hasData = computed(() => props.repositories.length > 0);

/** 备份状态对应的徽章样式 */
const statusClass = (status) => {
  switch (status) {
    case "success":
      return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300";
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

/** 格式化时间（本地时区，缺失显示 -） */
const formatTime = (value) => {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
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

/** 跟踪模式的展示文本 */
const trackLabel = (repo) => {
  if (repo.trackMode === "release") {
    return repo.trackRef ? `Release: ${repo.trackRef}` : "Release: latest";
  }
  return `Branch: ${repo.trackRef || "-"}`;
};
</script>

<template>
  <div class="overflow-x-auto rounded-lg border" :class="darkMode ? 'border-gray-700' : 'border-gray-200'">
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
        <!-- 空状态 -->
        <tr v-if="!hasData && !loading">
          <td colspan="5" class="px-4 py-10 text-center text-sm" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
            {{ $t("admin.repoBackup.table.empty") }}
          </td>
        </tr>

        <!-- 加载中 -->
        <tr v-else-if="loading && !hasData">
          <td colspan="5" class="px-4 py-10 text-center text-sm" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
            {{ $t("admin.repoBackup.table.loading") }}
          </td>
        </tr>

        <tr v-for="repo in repositories" :key="repo.id" :class="darkMode ? 'hover:bg-gray-800/60' : 'hover:bg-gray-50'">
          <!-- 仓库 -->
          <td class="px-4 py-3 align-top">
            <div class="flex items-start gap-2">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium truncate" :class="darkMode ? 'text-white' : 'text-gray-900'">
                    {{ repo.name }}
                  </span>
                  <span
                    class="px-1.5 py-0.5 text-[10px] rounded font-medium"
                    :class="darkMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-600'"
                  >
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
                <!-- 最近一次错误 -->
                <div v-if="repo.lastError" class="text-xs mt-1 text-red-600 dark:text-red-400 break-all">
                  {{ repo.lastError }}
                </div>
                <!-- 检查更新结果 -->
                <div v-if="checkResults[repo.id]" class="text-xs mt-1" :class="checkResults[repo.id].hasUpdate ? 'text-blue-600 dark:text-blue-400' : 'text-green-600 dark:text-green-400'">
                  {{
                    checkResults[repo.id].hasUpdate
                      ? $t("admin.repoBackup.check.hasUpdate", { version: checkResults[repo.id].latest.version })
                      : $t("admin.repoBackup.check.upToDate", { version: checkResults[repo.id].latest.version })
                  }}
                </div>
              </div>
            </div>
          </td>

          <!-- 跟踪模式 -->
          <td class="px-4 py-3 align-top">
            <div class="text-sm" :class="darkMode ? 'text-gray-200' : 'text-gray-700'">
              {{ trackLabel(repo) }}
            </div>
            <div v-if="repo.lastCheckedAt" class="text-xs mt-0.5" :class="darkMode ? 'text-gray-500' : 'text-gray-400'">
              {{ $t("admin.repoBackup.table.checkedAt") }}: {{ formatTime(repo.lastCheckedAt) }}
            </div>
          </td>

          <!-- 备份目标 -->
          <td class="px-4 py-3 align-top">
            <div v-if="repo.targetMount" class="text-sm truncate" :class="darkMode ? 'text-gray-200' : 'text-gray-700'">
              {{ repo.targetMount.name || repo.targetMount.mountPath }}
            </div>
            <div v-else class="text-sm text-red-600 dark:text-red-400">
              {{ $t("admin.repoBackup.table.mountMissing") }}
            </div>
            <div v-if="repo.backupFolder" class="text-xs mt-0.5 font-mono break-all" :class="darkMode ? 'text-gray-500' : 'text-gray-400'">
              {{ repo.backupFolder }}
            </div>
          </td>

          <!-- 最近备份 -->
          <td class="px-4 py-3 align-top">
            <template v-if="repo.latestBackup">
              <div class="flex items-center gap-2">
                <span class="px-1.5 py-0.5 text-[10px] rounded font-medium" :class="statusClass(repo.latestBackup.status)">
                  {{ $t(`admin.repoBackup.backupStatus.${repo.latestBackup.status}`) }}
                </span>
                <span class="text-xs font-mono" :class="darkMode ? 'text-gray-300' : 'text-gray-600'">
                  {{ repo.latestBackup.version || repo.latestBackup.shortCommitSha }}
                </span>
              </div>
              <div class="text-xs mt-0.5" :class="darkMode ? 'text-gray-500' : 'text-gray-400'">
                {{ formatTime(repo.latestBackup.finishedAt || repo.latestBackup.createdAt) }}
                <span v-if="repo.latestBackup.sizeBytes"> · {{ formatSize(repo.latestBackup.sizeBytes) }}</span>
              </div>
            </template>
            <span v-else class="text-xs" :class="darkMode ? 'text-gray-500' : 'text-gray-400'">
              {{ $t("admin.repoBackup.table.neverBackedUp") }}
            </span>
          </td>

          <!-- 操作 -->
          <td class="px-4 py-3 align-top">
            <div class="flex items-center justify-end gap-1 flex-wrap">
              <!-- 检查更新 -->
              <button
                class="inline-flex items-center px-2 py-1 text-xs rounded border transition-colors"
                :class="darkMode ? 'border-gray-600 text-gray-200 hover:bg-gray-700' : 'border-gray-300 text-gray-700 hover:bg-gray-100'"
                :disabled="isRepoBusy(repo.id)"
                :title="$t('admin.repoBackup.actions.check')"
                @click="emit('check', repo)"
              >
                <IconRefresh class="h-3 w-3 mr-1" :class="isRepoBusy(repo.id) ? 'animate-spin' : ''" />
                {{ $t("admin.repoBackup.actions.check") }}
              </button>

              <!-- 立即备份 -->
              <button
                class="inline-flex items-center px-2 py-1 text-xs rounded text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
                :disabled="isRepoBusy(repo.id) || !repo.enabled"
                :title="repo.enabled ? $t('admin.repoBackup.actions.backup') : $t('admin.repoBackup.actions.backupDisabledHint')"
                @click="emit('backup', repo)"
              >
                <IconArchive class="h-3 w-3 mr-1" />
                {{ $t("admin.repoBackup.actions.backup") }}
              </button>

              <!-- 备份历史 -->
              <button
                class="inline-flex items-center px-2 py-1 text-xs rounded border transition-colors"
                :class="darkMode ? 'border-gray-600 text-gray-200 hover:bg-gray-700' : 'border-gray-300 text-gray-700 hover:bg-gray-100'"
                :title="$t('admin.repoBackup.actions.history')"
                @click="emit('history', repo)"
              >
                <IconClock class="h-3 w-3 mr-1" />
                {{ $t("admin.repoBackup.actions.history") }}
              </button>

              <!-- 编辑 -->
              <button
                class="inline-flex items-center px-2 py-1 text-xs rounded border transition-colors"
                :class="darkMode ? 'border-gray-600 text-gray-200 hover:bg-gray-700' : 'border-gray-300 text-gray-700 hover:bg-gray-100'"
                :title="$t('admin.repoBackup.actions.edit')"
                @click="emit('edit', repo)"
              >
                <IconRename class="h-3 w-3" />
              </button>

              <!-- 启用 / 禁用 -->
              <button
                class="inline-flex items-center px-2 py-1 text-xs rounded border transition-colors"
                :class="darkMode ? 'border-gray-600 text-gray-200 hover:bg-gray-700' : 'border-gray-300 text-gray-700 hover:bg-gray-100'"
                :disabled="isRepoBusy(repo.id)"
                @click="emit('toggle', repo)"
              >
                {{ repo.enabled ? $t("admin.repoBackup.actions.disable") : $t("admin.repoBackup.actions.enable") }}
              </button>

              <!-- 删除 -->
              <button
                class="inline-flex items-center px-2 py-1 text-xs rounded border border-red-300 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/30"
                :disabled="isRepoBusy(repo.id)"
                :title="$t('admin.repoBackup.actions.delete')"
                @click="emit('delete', repo)"
              >
                <IconDelete class="h-3 w-3" />
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
