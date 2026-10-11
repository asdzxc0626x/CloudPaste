<script setup>
/**
 * 代码仓库备份管理视图（修改点：新增功能）
 *
 * 用途：把外部代码仓库的源码快照备份到已配置的 Storage Mount，
 * 防止仓库被删除/封禁导致源码丢失。
 *
 * 修改点（仓库管理分页 / 搜索 / 批量删除 / 手动刷新）：
 * 复刻文件管理与文本管理的既有做法 —— 服务端分页（CommonPagination 的 offset 模式）、
 * 服务端搜索（GlobalSearchBox，2 字起搜）、勾选 + 批量删除、带「上次刷新」时间的手动刷新。
 */
import { onMounted, ref } from "vue";
import { useThemeMode } from "@/composables/core/useThemeMode.js";
import { useRepoBackup } from "@/modules/admin/composables/useRepoBackup.js";
import { IconPlus, IconRefresh, IconKey, IconDelete, IconClock } from "@/components/icons";

import RepoBackupTable from "@/modules/admin/components/repo-backup/RepoBackupTable.vue";
import RepoBackupForm from "@/modules/admin/components/repo-backup/RepoBackupForm.vue";
import RepoBackupHistory from "@/modules/admin/components/repo-backup/RepoBackupHistory.vue";
// 修改点（第 3 期 3-B）：全局 Token / 代理池配置弹窗
import GithubPoolDialog from "@/modules/admin/components/repo-backup/GithubPoolDialog.vue";
// 修改点（仓库管理分页 / 搜索）：与文件管理、文本管理共用同一套通用组件
import CommonPagination from "@/components/common/CommonPagination.vue";
import GlobalSearchBox from "@/components/common/GlobalSearchBox.vue";

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

  // 分页 / 刷新时间（修改点：仓库管理分页、手动刷新）
  pagination,
  pageSizeOptions,
  lastRefreshTime,
  handleOffsetChange,
  handlePageSizeChange,
  refreshRepositories,

  // 搜索（修改点：仓库管理搜索）
  searchQuery,
  isSearchMode,
  searchLoading,
  handleGlobalSearch,
  clearSearch,

  // 选择 / 批量删除（修改点：仓库管理批量删除）
  selectedItems,
  allSelected,
  toggleSelectItem,
  toggleSelectAll,
  showBatchDeleteConfirm,
  batchDeleting,
  confirmBatchDelete,
  cancelBatchDelete,
  handleBatchDelete,

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
  historyStatuses,
  historyStatusCounts,
  openHistory,
  closeHistory,
  loadHistory,
  changeHistoryPage,
  changeHistoryStatuses,
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
    // 修改点（仓库管理分页）：保留当前页与搜索条件，刷新不该把人弹回第一页
    setTimeout(() => loadRepositories({ keepMessages: true }), 1500);
  }
};

/** 修改点（第 3 期 3-B）：全局 Token / 代理池弹窗的开关 */
const showPoolDialog = ref(false);

const onPoolSaved = () => {
  showPoolDialog.value = false;
};

onMounted(() => {
  initialize();
});
</script>

<template>
  <div class="p-3 sm:p-4 md:p-5 lg:p-6 flex-1 flex flex-col overflow-y-auto">
    <!-- 顶部操作栏：窄屏允许换行，按钮不被挤压变形 -->
    <div class="flex flex-col space-y-3 mb-4">
      <div class="flex flex-wrap items-start justify-between gap-x-2 gap-y-2">
        <div class="min-w-0 flex-1 basis-full sm:basis-auto">
          <h2 class="text-lg sm:text-xl font-medium" :class="darkMode ? 'text-white' : 'text-gray-900'">
            {{ $t("admin.repoBackup.title") }}
          </h2>
          <p class="text-xs mt-1" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
            {{ $t("admin.repoBackup.subtitle") }}
          </p>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <!-- 修改点（第 3 期 3-B）：全局 Token / 代理池 -->
          <button
            class="inline-flex items-center whitespace-nowrap px-2.5 py-1.5 md:px-4 md:py-2 border text-sm font-medium rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
            :class="
              darkMode
                ? 'border-gray-600 text-gray-200 bg-gray-800 hover:bg-gray-700'
                : 'border-gray-300 text-gray-700 bg-white hover:bg-gray-50'
            "
            @click="showPoolDialog = true"
          >
            <IconKey class="h-4 w-4 mr-1 shrink-0" />
            <span>{{ $t("admin.repoBackup.toolbar.globalCredentials") }}</span>
          </button>

          <button
            class="inline-flex items-center whitespace-nowrap px-2.5 py-1.5 md:px-4 md:py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
            @click="openCreateForm"
          >
            <IconPlus class="h-4 w-4 mr-1 shrink-0" />
            <span>{{ $t("admin.repoBackup.toolbar.create") }}</span>
          </button>

          <button
            class="inline-flex items-center whitespace-nowrap px-2.5 py-1.5 md:px-4 md:py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
            :disabled="loading || searchLoading"
            @click="refreshRepositories"
          >
            <IconRefresh class="h-4 w-4 mr-1 shrink-0" :class="loading || searchLoading ? 'animate-spin' : ''" />
            <span>{{ loading || searchLoading ? $t("admin.repoBackup.toolbar.refreshing") : $t("admin.repoBackup.toolbar.refresh") }}</span>
          </button>
        </div>
      </div>

      <!-- 搜索框（修改点：仓库管理搜索）：服务端搜索，2 个字符起搜，
           清空时自动退回普通列表 —— 与文件管理 / 文本管理的交互一致 -->
      <div class="w-full">
        <GlobalSearchBox
          v-model="searchQuery"
          :placeholder="$t('admin.repoBackup.toolbar.searchPlaceholder')"
          :show-hint="true"
          :search-hint="$t('admin.repoBackup.toolbar.searchHint')"
          size="md"
          :debounce-ms="300"
          @search="handleGlobalSearch"
          @clear="clearSearch"
        />
      </div>

      <!-- 批量操作行（修改点：仓库管理批量删除） -->
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <!-- 移动端没有表头，全选放在这里；桌面端用表头那个勾选框 -->
        <label class="md:hidden inline-flex items-center gap-1.5 text-xs" :class="darkMode ? 'text-gray-300' : 'text-gray-600'">
          <input
            type="checkbox"
            :checked="allSelected"
            class="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded cursor-pointer"
            @change="toggleSelectAll"
          />
          {{ $t("admin.repoBackup.table.selectAll") }}
        </label>

        <button
          :disabled="selectedItems.length === 0 || batchDeleting"
          :class="[
            'inline-flex items-center whitespace-nowrap px-2.5 py-1.5 md:px-4 md:py-2 border border-transparent text-xs sm:text-sm font-medium rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2',
            selectedItems.length === 0 || batchDeleting
              ? 'bg-gray-300 text-gray-500 cursor-not-allowed dark:bg-gray-700 dark:text-gray-500'
              : 'text-white bg-red-600 hover:bg-red-700 focus:ring-red-500',
          ]"
          @click="confirmBatchDelete"
        >
          <IconDelete class="h-3.5 w-3.5 sm:h-4 sm:w-4 mr-1 shrink-0" />
          <span>{{ $t("admin.repoBackup.toolbar.batchDelete") }}{{ selectedItems.length ? `(${selectedItems.length})` : "" }}</span>
        </button>

        <!-- 统计：总数始终是筛选后的真实条数，选中数只会包含当前页看得见的行 -->
        <span class="text-xs" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
          {{ $t("admin.repoBackup.stats.total", { count: pagination.total }) }}
          <template v-if="selectedItems.length > 0">
            · {{ $t("admin.repoBackup.stats.selected", { count: selectedItems.length }) }}
          </template>
        </span>
      </div>

      <!-- 消息提示：长错误信息换行，不撑破容器 -->
      <div v-if="error" class="px-3 py-2 rounded text-sm break-words bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">
        {{ error }}
      </div>
      <div v-if="successMessage" class="px-3 py-2 rounded text-sm break-words bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300">
        {{ successMessage }}
      </div>
    </div>

    <!-- 上次刷新时间（修改点：仓库管理手动刷新） -->
    <div v-if="lastRefreshTime" class="mb-2 sm:mb-3 text-xs sm:text-sm text-gray-500 dark:text-gray-400">
      <span class="inline-flex items-center">
        <IconClock class="h-3 w-3 sm:h-4 sm:w-4 mr-1" />
        {{ $t("admin.repoBackup.toolbar.lastRefresh", { time: lastRefreshTime }) }}
      </span>
    </div>

    <!-- 仓库列表 -->
    <RepoBackupTable
      :repositories="repositories"
      :check-results="checkResults"
      :loading="loading || searchLoading"
      :dark-mode="darkMode"
      :is-repo-busy="isRepoBusy"
      :selected-ids="selectedItems"
      :all-selected="allSelected"
      :search-mode="isSearchMode"
      @check="handleCheck"
      @backup="onBackup"
      @history="openHistory"
      @edit="openEditForm"
      @toggle="toggleEnabled"
      @delete="confirmDelete"
      @toggle-select="toggleSelectItem"
      @toggle-select-all="toggleSelectAll"
    />

    <!-- 分页（修改点：仓库管理分页）：搜索与普通模式共用同一个分页器 -->
    <div class="mt-2 mb-4 sm:mt-4 sm:mb-0">
      <CommonPagination
        :dark-mode="darkMode"
        :pagination="pagination"
        :page-size-options="pageSizeOptions"
        :search-mode="isSearchMode"
        :search-term="searchQuery"
        mode="offset"
        @offset-changed="handleOffsetChange"
        @limit-changed="handlePageSizeChange"
      />
    </div>

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
      :statuses="historyStatuses"
      :status-counts="historyStatusCounts"
      @close="closeHistory"
      @refresh="loadHistory"
      @page-change="changeHistoryPage"
      @status-change="changeHistoryStatuses"
      @download="downloadBackup"
    />

    <!-- 全局 Token / 代理池（修改点：第 3 期 3-B）
         与其它弹窗一样 Teleport 到 body，避免被 AdminLayout 的层叠上下文压住 -->
    <Teleport to="body">
      <GithubPoolDialog v-if="showPoolDialog" :dark-mode="darkMode" @close="showPoolDialog = false" @saved="onPoolSaved" />
    </Teleport>

    <!-- 删除确认：手机端按钮全宽堆叠，仓库名可能很长故允许换行 -->
    <!-- 修改点（弹窗顶部被控制栏遮挡）：Teleport 到 body，脱离 AdminLayout main 容器的
         `md:fixed z-40` 层叠上下文，否则会被 App.vue 的站点头部（sticky z-50）压住 -->
    <Teleport to="body">
    <div v-if="showDeleteConfirm" class="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50" @click.self="cancelDelete">
      <div class="w-full max-w-md rounded-lg shadow-xl p-4 sm:p-5 max-h-[85vh] overflow-y-auto" :class="darkMode ? 'bg-gray-900' : 'bg-white'">
        <h3 class="text-base font-medium mb-2" :class="darkMode ? 'text-white' : 'text-gray-900'">
          {{ $t("admin.repoBackup.delete.title") }}
        </h3>
        <p class="text-sm mb-1 break-words" :class="darkMode ? 'text-gray-300' : 'text-gray-600'">
          {{ $t("admin.repoBackup.delete.confirm", { name: repoToDelete?.name || repoToDelete?.repoIdentifier }) }}
        </p>
        <p class="text-xs mb-4" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
          {{ $t("admin.repoBackup.delete.hint") }}
        </p>

        <div class="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button
            class="w-full sm:w-auto px-4 py-2 text-sm rounded-md border"
            :class="darkMode ? 'border-gray-600 text-gray-200 hover:bg-gray-700' : 'border-gray-300 text-gray-700 hover:bg-gray-100'"
            @click="cancelDelete"
          >
            {{ $t("admin.repoBackup.buttons.cancel") }}
          </button>
          <button class="w-full sm:w-auto px-4 py-2 text-sm rounded-md text-white bg-red-600 hover:bg-red-700" @click="handleDelete">
            {{ $t("admin.repoBackup.buttons.delete") }}
          </button>
        </div>
      </div>
    </div>
    </Teleport>

    <!-- 批量删除确认（修改点：仓库管理批量删除）
         与单条删除同样 Teleport 到 body，避免被 AdminLayout 的层叠上下文压住 -->
    <Teleport to="body">
    <div v-if="showBatchDeleteConfirm" class="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50" @click.self="cancelBatchDelete">
      <div class="w-full max-w-md rounded-lg shadow-xl p-4 sm:p-5 max-h-[85vh] overflow-y-auto" :class="darkMode ? 'bg-gray-900' : 'bg-white'">
        <h3 class="text-base font-medium mb-2" :class="darkMode ? 'text-white' : 'text-gray-900'">
          {{ $t("admin.repoBackup.batchDelete.title") }}
        </h3>
        <p class="text-sm mb-1 break-words" :class="darkMode ? 'text-gray-300' : 'text-gray-600'">
          {{ $t("admin.repoBackup.batchDelete.confirm", { count: selectedItems.length }) }}
        </p>
        <p class="text-xs mb-4" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
          {{ $t("admin.repoBackup.batchDelete.hint") }}
        </p>

        <div class="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button
            class="w-full sm:w-auto px-4 py-2 text-sm rounded-md border"
            :class="darkMode ? 'border-gray-600 text-gray-200 hover:bg-gray-700' : 'border-gray-300 text-gray-700 hover:bg-gray-100'"
            :disabled="batchDeleting"
            @click="cancelBatchDelete"
          >
            {{ $t("admin.repoBackup.buttons.cancel") }}
          </button>
          <button
            class="w-full sm:w-auto px-4 py-2 text-sm rounded-md text-white bg-red-600 hover:bg-red-700 disabled:opacity-50"
            :disabled="batchDeleting"
            @click="handleBatchDelete"
          >
            {{ batchDeleting ? $t("admin.repoBackup.batchDelete.deleting") : $t("admin.repoBackup.buttons.delete") }}
          </button>
        </div>
      </div>
    </div>
    </Teleport>
  </div>
</template>
