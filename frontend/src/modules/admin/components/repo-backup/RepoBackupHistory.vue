<script setup>
/**
 * 备份历史抽屉（修改点：新增功能）
 * - 列出某仓库的历史备份记录
 * - 支持下载快照与 manifest
 */
import { computed } from "vue";
import { IconClose, IconDownload, IconRefresh } from "@/components/icons";

const props = defineProps({
  repo: { type: Object, default: null },
  items: { type: Array, default: () => [] },
  total: { type: Number, default: 0 },
  paging: { type: Object, required: true },
  loading: { type: Boolean, default: false },
  darkMode: { type: Boolean, default: false },
});

const emit = defineEmits(["close", "refresh", "page-change", "download"]);

const hasPrev = computed(() => props.paging.offset > 0);
const hasNext = computed(() => props.paging.offset + props.paging.limit < props.total);

const statusClass = (status) => {
  switch (status) {
    case "success":
      return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300";
    case "failed":
      return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
    case "running":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";
    default:
      return "bg-gray-100 text-gray-700 dark:bg-gray-700/60 dark:text-gray-300";
  }
};

const formatTime = (value) => {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleString();
};

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
</script>

<template>
  <div class="fixed inset-0 z-50 flex justify-end bg-black/50" @click.self="emit('close')">
    <div class="w-full max-w-2xl h-full overflow-y-auto shadow-xl" :class="darkMode ? 'bg-gray-900' : 'bg-white'">
      <!-- 标题栏 -->
      <div
        class="sticky top-0 z-10 flex items-center justify-between px-5 py-4 border-b"
        :class="darkMode ? 'bg-gray-900 border-gray-700' : 'bg-white border-gray-200'"
      >
        <div class="min-w-0">
          <h3 class="text-base font-medium truncate" :class="darkMode ? 'text-white' : 'text-gray-900'">
            {{ $t("admin.repoBackup.history.title") }}
          </h3>
          <p v-if="repo" class="text-xs mt-0.5 font-mono truncate" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
            {{ repo.repoIdentifier }}
          </p>
        </div>

        <div class="flex items-center gap-2">
          <button
            class="inline-flex items-center px-2 py-1 text-xs rounded border"
            :class="darkMode ? 'border-gray-600 text-gray-200 hover:bg-gray-700' : 'border-gray-300 text-gray-700 hover:bg-gray-100'"
            :disabled="loading"
            @click="emit('refresh')"
          >
            <IconRefresh class="h-3 w-3 mr-1" :class="loading ? 'animate-spin' : ''" />
            {{ $t("admin.repoBackup.history.refresh") }}
          </button>
          <button class="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700" @click="emit('close')">
            <IconClose class="h-4 w-4" :class="darkMode ? 'text-gray-400' : 'text-gray-500'" />
          </button>
        </div>
      </div>

      <div class="px-5 py-4">
        <!-- 空状态 -->
        <div v-if="!loading && items.length === 0" class="py-10 text-center text-sm" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
          {{ $t("admin.repoBackup.history.empty") }}
        </div>

        <!-- 记录列表 -->
        <ul class="space-y-3">
          <li
            v-for="item in items"
            :key="item.id"
            class="p-3 rounded-lg border"
            :class="darkMode ? 'border-gray-700 bg-gray-800/40' : 'border-gray-200 bg-gray-50'"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="px-1.5 py-0.5 text-[10px] rounded font-medium" :class="statusClass(item.status)">
                    {{ $t(`admin.repoBackup.backupStatus.${item.status}`) }}
                  </span>
                  <span class="text-sm font-medium" :class="darkMode ? 'text-white' : 'text-gray-900'">
                    {{ item.version || item.shortCommitSha }}
                  </span>
                  <span class="text-xs font-mono" :class="darkMode ? 'text-gray-500' : 'text-gray-400'">
                    {{ item.refType }}:{{ item.ref }}
                  </span>
                </div>

                <div class="mt-1 text-xs font-mono break-all" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
                  {{ item.commitSha }}
                </div>

                <div class="mt-1 text-xs" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
                  {{ formatTime(item.finishedAt || item.createdAt) }}
                  <span v-if="item.sizeBytes"> · {{ formatSize(item.sizeBytes) }}</span>
                </div>

                <div v-if="item.storagePath" class="mt-1 text-xs font-mono break-all" :class="darkMode ? 'text-gray-500' : 'text-gray-400'">
                  {{ item.storagePath }}
                </div>

                <div v-if="item.errorMessage" class="mt-1 text-xs text-red-600 dark:text-red-400 break-all">
                  {{ item.errorMessage }}
                </div>
              </div>

              <!-- 下载操作 -->
              <div v-if="item.status === 'success'" class="flex flex-col gap-1 shrink-0">
                <button
                  class="inline-flex items-center px-2 py-1 text-xs rounded text-white bg-blue-600 hover:bg-blue-700"
                  @click="emit('download', item, { manifest: false })"
                >
                  <IconDownload class="h-3 w-3 mr-1" />
                  {{ $t("admin.repoBackup.history.downloadArchive") }}
                </button>
                <button
                  v-if="item.manifestPath"
                  class="inline-flex items-center px-2 py-1 text-xs rounded border"
                  :class="darkMode ? 'border-gray-600 text-gray-200 hover:bg-gray-700' : 'border-gray-300 text-gray-700 hover:bg-gray-100'"
                  @click="emit('download', item, { manifest: true })"
                >
                  manifest
                </button>
              </div>
            </div>
          </li>
        </ul>

        <!-- 分页 -->
        <div v-if="total > paging.limit" class="flex items-center justify-between mt-4 pt-3 border-t" :class="darkMode ? 'border-gray-700' : 'border-gray-200'">
          <span class="text-xs" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
            {{ $t("admin.repoBackup.history.pageInfo", { from: paging.offset + 1, to: Math.min(paging.offset + paging.limit, total), total }) }}
          </span>
          <div class="flex gap-2">
            <button
              class="px-2 py-1 text-xs rounded border disabled:opacity-40"
              :class="darkMode ? 'border-gray-600 text-gray-200' : 'border-gray-300 text-gray-700'"
              :disabled="!hasPrev"
              @click="emit('page-change', paging.offset - paging.limit)"
            >
              {{ $t("admin.repoBackup.history.prev") }}
            </button>
            <button
              class="px-2 py-1 text-xs rounded border disabled:opacity-40"
              :class="darkMode ? 'border-gray-600 text-gray-200' : 'border-gray-300 text-gray-700'"
              :disabled="!hasNext"
              @click="emit('page-change', paging.offset + paging.limit)"
            >
              {{ $t("admin.repoBackup.history.next") }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
