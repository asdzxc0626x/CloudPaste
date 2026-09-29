<script setup>
/**
 * 代码仓库备份管理视图（修改点：新增功能）
 *
 * 用途：把外部代码仓库的源码快照备份到已配置的 Storage Mount，
 * 防止仓库被删除/封禁导致源码丢失。
 */
import { onMounted } from "vue";
import { useThemeMode } from "@/composables/core/useThemeMode.js";
import { useRepoBackup } from "@/modules/admin/composables/useRepoBackup.js";
import { IconPlus, IconRefresh } from "@/components/icons";

import RepoBackupTable from "@/modules/admin/components/repo-backup/RepoBackupTable.vue";
import RepoBackupForm from "@/modules/admin/components/repo-backup/RepoBackupForm.vue";
import RepoBackupHistory from "@/modules/admin/components/repo-backup/RepoBackupHistory.vue";

const { isDarkMode: darkMode } = useThemeMode();

const {
  loading,
  error,
  successMessage,
  repositories,
  providers,
  writableMounts,
  checkResults,
  isRepoBusy,

  showForm,
  editingRepo,
  formSubmitting,
  openCreateForm,
  openEditForm,
  closeForm,
  submitForm,

  showDeleteConfirm,
  repoToDelete,
  confirmDelete,
  cancelDelete,
  handleDelete,

  toggleEnabled,
  handleCheck,
  handleBackup,

  showHistory,
  historyRepo,
  historyLoading,
  historyItems,
  historyTotal,
  historyPaging,
  openHistory,
  closeHistory,
  loadHistory,
  changeHistoryPage,
  downloadBackup,

  initialize,
  loadRepositories,
} = useRepoBackup();

/** 备份后刷新列表，让最近备份状态及时反映出来 */
const onBackup = async (repo) => {
  const jobId = await handleBackup(repo);
  if (jobId) {
    // 作业是异步的，这里延迟刷新一次给后端一点执行时间；
    // 详细进度可到「任务管理」页面查看
    setTimeout(() => loadRepositories(), 1500);
  }
};

onMounted(() => {
  initialize();
});
</script>

<template>
  <div class="p-3 sm:p-4 md:p-5 lg:p-6 flex-1 flex flex-col overflow-y-auto">
    <!-- 顶部操作栏 -->
    <div class="flex flex-col space-y-3 mb-4">
      <div class="flex justify-between items-center gap-2">
        <div class="min-w-0">
          <h2 class="text-lg sm:text-xl font-medium" :class="darkMode ? 'text-white' : 'text-gray-900'">
            {{ $t("admin.repoBackup.title") }}
          </h2>
          <p class="text-xs mt-1" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
            {{ $t("admin.repoBackup.subtitle") }}
          </p>
        </div>

        <div class="flex items-center space-x-2 shrink-0">
          <button
            class="inline-flex items-center px-2 py-1 sm:px-3 sm:py-1.5 md:px-4 md:py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
            @click="openCreateForm"
          >
            <IconPlus class="h-3 w-3 sm:h-4 sm:w-4 mr-1" />
            <span>{{ $t("admin.repoBackup.toolbar.create") }}</span>
          </button>

          <button
            class="inline-flex items-center px-2 py-1 sm:px-3 sm:py-1.5 md:px-4 md:py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
            :disabled="loading"
            @click="loadRepositories"
          >
            <IconRefresh class="h-3 w-3 sm:h-4 sm:w-4 mr-1" :class="loading ? 'animate-spin' : ''" />
            <span>{{ loading ? $t("admin.repoBackup.toolbar.refreshing") : $t("admin.repoBackup.toolbar.refresh") }}</span>
          </button>
        </div>
      </div>

      <!-- 消息提示 -->
      <div v-if="error" class="px-3 py-2 rounded text-sm bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">
        {{ error }}
      </div>
      <div v-if="successMessage" class="px-3 py-2 rounded text-sm bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300">
        {{ successMessage }}
      </div>
    </div>

    <!-- 仓库列表 -->
    <RepoBackupTable
      :repositories="repositories"
      :check-results="checkResults"
      :loading="loading"
      :dark-mode="darkMode"
      :is-repo-busy="isRepoBusy"
      @check="handleCheck"
      @backup="onBackup"
      @history="openHistory"
      @edit="openEditForm"
      @toggle="toggleEnabled"
      @delete="confirmDelete"
    />

    <!-- 表单弹窗 -->
    <RepoBackupForm
      v-if="showForm"
      :repo="editingRepo"
      :providers="providers"
      :writable-mounts="writableMounts"
      :submitting="formSubmitting"
      :error="error"
      :dark-mode="darkMode"
      @submit="submitForm"
      @cancel="closeForm"
    />

    <!-- 备份历史抽屉 -->
    <RepoBackupHistory
      v-if="showHistory"
      :repo="historyRepo"
      :items="historyItems"
      :total="historyTotal"
      :paging="historyPaging"
      :loading="historyLoading"
      :dark-mode="darkMode"
      @close="closeHistory"
      @refresh="loadHistory"
      @page-change="changeHistoryPage"
      @download="downloadBackup"
    />

    <!-- 删除确认 -->
    <div v-if="showDeleteConfirm" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" @click.self="cancelDelete">
      <div class="w-full max-w-md rounded-lg shadow-xl p-5" :class="darkMode ? 'bg-gray-900' : 'bg-white'">
        <h3 class="text-base font-medium mb-2" :class="darkMode ? 'text-white' : 'text-gray-900'">
          {{ $t("admin.repoBackup.delete.title") }}
        </h3>
        <p class="text-sm mb-1" :class="darkMode ? 'text-gray-300' : 'text-gray-600'">
          {{ $t("admin.repoBackup.delete.confirm", { name: repoToDelete?.name || repoToDelete?.repoIdentifier }) }}
        </p>
        <p class="text-xs mb-4" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
          {{ $t("admin.repoBackup.delete.hint") }}
        </p>

        <div class="flex justify-end gap-2">
          <button
            class="px-4 py-2 text-sm rounded-md border"
            :class="darkMode ? 'border-gray-600 text-gray-200 hover:bg-gray-700' : 'border-gray-300 text-gray-700 hover:bg-gray-100'"
            @click="cancelDelete"
          >
            {{ $t("admin.repoBackup.buttons.cancel") }}
          </button>
          <button class="px-4 py-2 text-sm rounded-md text-white bg-red-600 hover:bg-red-700" @click="handleDelete">
            {{ $t("admin.repoBackup.buttons.delete") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
