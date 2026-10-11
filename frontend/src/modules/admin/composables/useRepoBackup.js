/**
 * 代码仓库备份管理 composable（修改点：新增功能）
 *
 * 职责：把仓库列表 / 表单 / 检查更新 / 备份历史的状态与动作集中管理，
 * 视图只负责渲染，与 useFsMetaManagement 的分层方式保持一致。
 *
 * 表单约定：表单组件自持本地状态，提交时把完整 payload 交回这里，
 * 避免跨组件改写 props（vue/no-mutating-props）。
 *
 * 修改点（仓库管理分页 / 搜索 / 批量 / 手动刷新）：
 * 分页、选择、刷新时间这三件事复用 useAdminBase，与文件管理、文本管理同一套实现
 * （页大小也按页面键持久化）。仓库列表改为服务端分页：
 * 列表接口里逐仓库的查询（最近备份、各目标结果）原本要对全部仓库各跑一遍，
 * 分页之后只对当前这一页跑。
 */

import { ref, reactive, computed } from "vue";
import { useI18n } from "vue-i18n";
import { useAdminBase } from "@/composables/admin-management/useAdminBase.js";
import {
  getProviders,
  listRepositories,
  createRepository,
  updateRepository,
  deleteRepository,
  // 修改点（仓库管理批量删除）
  batchDeleteRepositories,
  setRepositoryEnabled,
  checkRepository,
  triggerBackup,
  listBackups,
  getBackupDownloadLink,
} from "@/api/services/repoBackupService.js";
import { api } from "@/api";

/** 搜索关键词下限：少于 2 个字视为「没在搜索」，与文件管理 / 文本管理一致 */
const SEARCH_MIN_LENGTH = 2;

export function useRepoBackup() {
  const { t } = useI18n();

  /**
   * 分页 / 选择 / 刷新时间来自 useAdminBase（修改点：仓库管理分页与搜索）
   *
   * 唯独消息提示仍用本文件自己的 error / successMessage：这个页面把提示渲染成
   * 页内横幅（见 RepoBackupView 顶部），改用 base.showError / showSuccess 会
   * 同时再弹一个全局 toast，同一句话显示两遍。
   */
  const base = useAdminBase("repo-backup");
  const { loading, lastRefreshTime, pagination, pageSizeOptions, selectedItems } = base;

  // ==================== 基础状态 ====================
  const error = ref("");
  const successMessage = ref("");

  const repositories = ref([]);
  const providers = ref([]);
  const mounts = ref([]);

  // 行级操作中的仓库 ID 集合（避免全局 loading 遮罩）
  const busyRepoIds = ref(new Set());

  // ==================== 搜索（修改点：仓库管理搜索）====================
  const searchQuery = ref("");
  const isSearchMode = ref(false);
  const searchLoading = ref(false);

  // ==================== 表单状态 ====================
  const showForm = ref(false);
  const formSubmitting = ref(false);
  /** 正在编辑的仓库；null 表示新建 */
  const editingRepo = ref(null);

  // ==================== 删除确认 ====================
  const showDeleteConfirm = ref(false);
  const repoToDelete = ref(null);
  // 修改点（仓库管理批量删除）：批量删除走同一套「页内确认弹窗」的交互
  const showBatchDeleteConfirm = ref(false);
  const batchDeleting = ref(false);

  // ==================== 备份历史 ====================
  const showHistory = ref(false);
  const historyRepo = ref(null);
  const historyLoading = ref(false);
  const historyItems = ref([]);
  const historyTotal = ref(0);
  const historyPaging = reactive({ limit: 20, offset: 0 });
  /**
   * 历史记录状态筛选（修改点：历史记录需显示失败记录）
   * - 空数组 = 全部状态；非空时按选中的状态过滤
   * - statusCounts 由后端返回，用于在筛选器上显示每种状态的条数
   */
  const historyStatuses = ref([]);
  const historyStatusCounts = ref({});

  // ==================== 检查更新结果 ====================
  const checkResults = ref({});

  // ==================== 工具 ====================

  const isRepoBusy = (id) => busyRepoIds.value.has(id);

  const markBusy = (id, busy) => {
    const next = new Set(busyRepoIds.value);
    if (busy) next.add(id);
    else next.delete(id);
    busyRepoIds.value = next;
  };

  const clearMessages = () => {
    error.value = "";
    successMessage.value = "";
  };

  const notifyError = (e, fallbackKey) => {
    error.value = e?.message || t(fallbackKey);
  };

  /** 当前 provider 的元数据由表单组件自行从 providers 推导，这里不再重复维护 */

  /**
   * 只保留可写入的挂载点：只读存储不能作为备份目标
   * 注意：后端 /api/mount/list 返回的 capabilities 是驱动能力原始值
   * （见 backend constants：CAPABILITIES.WRITER === "WriterCapable"），不是 "WRITER"
   */
  const WRITER_CAPABILITY = "WriterCapable";
  const writableMounts = computed(() =>
    mounts.value.filter((m) => Array.isArray(m.capabilities) && m.capabilities.includes(WRITER_CAPABILITY) && m.is_active !== 0),
  );

  // ==================== 数据加载 ====================

  /** 加载 provider 元数据（只需一次） */
  const loadProviders = async () => {
    try {
      const resp = await getProviders();
      if (resp?.success) providers.value = resp.data || [];
    } catch (e) {
      notifyError(e, "admin.repoBackup.messages.loadProvidersFailed");
    }
  };

  /** 加载可选挂载点 */
  const loadMounts = async () => {
    try {
      const resp = await api.mount.getMountsList();
      if (resp?.success) mounts.value = resp.data || [];
    } catch (e) {
      notifyError(e, "admin.repoBackup.messages.loadMountsFailed");
    }
  };

  /**
   * 解析列表响应（修改点：仓库管理分页与搜索）
   *
   * 兼容裸数组：前后端分离部署（Workers + Pages）时两侧不是同时更新的，
   * 前端先上线的那一会儿后端仍返回老结构 —— 多这几行，页面就不会整块白掉。
   *
   * 注意分页口径用的是本地的 limit/offset 而不是响应里的：
   * 后端在「不分页」时会回 limit=0，直接采信会让分页器按 0 算页数。
   */
  const applyListResponse = (data) => {
    if (Array.isArray(data)) {
      repositories.value = data;
      base.updatePagination({ total: data.length, limit: pagination.limit, offset: 0 }, "offset");
      return;
    }
    repositories.value = data?.items || [];
    base.updatePagination({ total: Number(data?.total) || 0, limit: pagination.limit, offset: pagination.offset }, "offset");
  };

  /**
   * 加载仓库列表（分页 + 搜索）
   *
   * 修改点（检查更新没有反馈）：keepMessages 选项。
   * 原先这个方法无条件调用 clearMessages()，而「检查更新」「启用/禁用」的成功提示
   * 是先赋值再紧接着调用它的 —— 提示刚写上就被清掉，用户永远看不到，
   * 于是「检查完成、已是最新」看起来像没有任何结果（失败提示同理被吞掉）。
   * 需要保留提示的调用方传 { keepMessages: true }。
   *
   * 修改点（仓库管理分页与搜索）：带上当前页码与搜索词；
   * 并在「当前页被删空」时把页码退回最后一页 —— 删掉第 21 条之后停在第 2 页，
   * 看到的会是一片空白，而用户并不知道该点哪里才能回去。
   */
  const loadRepositories = async (options = {}) => {
    loading.value = true;
    if (!options.keepMessages) clearMessages();
    try {
      const resp = await listRepositories({
        limit: pagination.limit,
        offset: pagination.offset,
        search: isSearchMode.value ? searchQuery.value.trim() : "",
      });
      if (resp?.success) {
        applyListResponse(resp.data);

        if (!options.retried && repositories.value.length === 0 && pagination.total > 0 && pagination.offset >= pagination.total) {
          const lastOffset = Math.max(0, (Math.ceil(pagination.total / pagination.limit) - 1) * pagination.limit);
          if (lastOffset !== pagination.offset) {
            base.handlePaginationChange(lastOffset, "offset");
            // 只回退一次：避免总数在两次请求之间又变了导致来回拉取
            return await loadRepositories({ ...options, retried: true });
          }
        }

        base.updateLastRefreshTime();
      }
    } catch (e) {
      notifyError(e, "admin.repoBackup.messages.loadFailed");
    } finally {
      loading.value = false;
    }
  };

  /** 初始化：并发加载三类数据 */
  const initialize = async () => {
    await Promise.all([loadProviders(), loadMounts(), loadRepositories()]);
  };

  /**
   * 手动刷新（修改点：仓库管理手动刷新）
   * - 保持当前页码与搜索条件：刷新不该把人甩回第一页
   */
  const refreshRepositories = async () => {
    if (isSearchMode.value) {
      searchLoading.value = true;
      try {
        await loadRepositories();
      } finally {
        searchLoading.value = false;
      }
      return;
    }
    await loadRepositories();
  };

  // ==================== 分页（修改点：仓库管理分页）====================

  /**
   * 翻页
   * - 翻页同时清空选择：不然「已选择 3 个」里可能有两个已经不在当前页上，
   *   而批量删除是不可逆的，看不见的勾选不能留着
   */
  const handleOffsetChange = async (newOffset) => {
    base.handlePaginationChange(newOffset, "offset");
    base.clearSelection();
    await loadRepositories();
  };

  /** 每页条数变化（useAdminBase 内部会持久化并把页码归零） */
  const handlePageSizeChange = async (newLimit) => {
    base.changePageSize(newLimit);
    base.clearSelection();
    await loadRepositories();
  };

  // ==================== 搜索（修改点：仓库管理搜索）====================

  /**
   * 处理搜索框输入（服务端搜索，命中展示名与 owner/repo）
   * - 少于 2 个字视为「没在搜索」，与文件管理一致
   */
  const handleGlobalSearch = async (value) => {
    searchQuery.value = value ?? "";
    if (searchQuery.value.trim().length < SEARCH_MIN_LENGTH) {
      await clearSearch();
      return;
    }

    searchLoading.value = true;
    isSearchMode.value = true;
    base.clearSelection();
    // 筛选条件变了必须把页码归零，否则会停在超出范围的页上看到空列表
    base.resetPagination();
    try {
      await loadRepositories();
    } finally {
      searchLoading.value = false;
    }
  };

  /** 清除搜索，回到正常分页列表 */
  const clearSearch = async () => {
    searchQuery.value = "";
    isSearchMode.value = false;
    base.clearSelection();
    base.resetPagination();
    await loadRepositories();
  };

  // ==================== 选择（修改点：仓库管理批量操作）====================

  /** 全选 / 取消全选：只针对当前页 */
  const toggleSelectAll = () => {
    base.toggleSelectAll(repositories.value, "id");
  };

  const isSelected = (id) => selectedItems.value.includes(id);

  const allSelected = computed(
    () => repositories.value.length > 0 && selectedItems.value.length === repositories.value.length,
  );

  // ==================== 表单动作 ====================

  const openCreateForm = () => {
    clearMessages();
    editingRepo.value = null;
    showForm.value = true;
  };

  const openEditForm = (repo) => {
    clearMessages();
    editingRepo.value = repo;
    showForm.value = true;
  };

  const closeForm = () => {
    showForm.value = false;
    editingRepo.value = null;
  };

  /**
   * 提交表单
   * @param {Object} payload 由表单组件构造并校验过的完整数据（含 id，null 表示新建）
   * @returns {Promise<boolean>}
   */
  const submitForm = async (payload) => {
    clearMessages();
    formSubmitting.value = true;
    try {
      const { id, ...data } = payload || {};
      const resp = id ? await updateRepository(id, data) : await createRepository(data);

      if (resp?.success) {
        successMessage.value = resp.message || t("admin.repoBackup.messages.saveSuccess");
        showForm.value = false;
        editingRepo.value = null;
        /**
         * 新建后回到第一页（修改点：仓库管理分页）
         * 列表按创建时间倒序，新仓库一定在第一页；停在第 3 页的话
         * 用户会以为「保存成功了但没出现」。编辑则保持当前页不动。
         */
        if (!id) base.resetPagination();
        await loadRepositories({ keepMessages: true });
        return true;
      }
      return false;
    } catch (e) {
      notifyError(e, "admin.repoBackup.messages.saveFailed");
      return false;
    } finally {
      formSubmitting.value = false;
    }
  };

  // ==================== 启用 / 禁用 ====================

  const toggleEnabled = async (repo) => {
    clearMessages();
    markBusy(repo.id, true);
    try {
      const resp = await setRepositoryEnabled(repo.id, !repo.enabled);
      if (resp?.success) {
        successMessage.value = resp.message || "";
        // keepMessages：否则刚写上的「已启用 / 已禁用」会被列表刷新清掉（与检查更新同一个坑）
        await loadRepositories({ keepMessages: true });
      }
    } catch (e) {
      notifyError(e, "admin.repoBackup.messages.toggleFailed");
    } finally {
      markBusy(repo.id, false);
    }
  };

  // ==================== 删除 ====================

  const confirmDelete = (repo) => {
    repoToDelete.value = repo;
    showDeleteConfirm.value = true;
  };

  const cancelDelete = () => {
    repoToDelete.value = null;
    showDeleteConfirm.value = false;
  };

  const handleDelete = async () => {
    if (!repoToDelete.value) return;
    clearMessages();
    const id = repoToDelete.value.id;
    markBusy(id, true);
    try {
      const resp = await deleteRepository(id);
      if (resp?.success) {
        successMessage.value = resp.message || t("admin.repoBackup.messages.deleteSuccess");
        // 删掉的那条如果还在选择里，要一并摘掉（修改点：仓库管理批量操作）
        if (isSelected(id)) base.toggleSelectItem(id);
        await loadRepositories({ keepMessages: true });
      }
    } catch (e) {
      notifyError(e, "admin.repoBackup.messages.deleteFailed");
    } finally {
      markBusy(id, false);
      cancelDelete();
    }
  };

  // ==================== 批量删除（修改点：仓库管理批量删除）====================

  const confirmBatchDelete = () => {
    clearMessages();
    if (selectedItems.value.length === 0) {
      error.value = t("admin.repoBackup.messages.noSelection");
      return;
    }
    showBatchDeleteConfirm.value = true;
  };

  const cancelBatchDelete = () => {
    showBatchDeleteConfirm.value = false;
  };

  /**
   * 执行批量删除
   *
   * 部分失败不当成整批失败：成功的那些已经删掉了，必须把成功数与失败明细
   * 同时显示出来，否则用户会对着「删除失败」反复点，而每次都少删几条。
   */
  const handleBatchDelete = async () => {
    const ids = [...selectedItems.value];
    if (ids.length === 0) {
      cancelBatchDelete();
      return;
    }

    clearMessages();
    batchDeleting.value = true;
    try {
      const resp = await batchDeleteRepositories(ids);
      if (resp?.success) {
        const succeeded = Number(resp.data?.success) || 0;
        const failed = Array.isArray(resp.data?.failed) ? resp.data.failed : [];

        if (failed.length > 0) {
          successMessage.value = t("admin.repoBackup.messages.batchDeletePartial", {
            success: succeeded,
            failed: failed.length,
          });
          // 失败明细直接给出「哪一条、为什么」，不然无从判断要不要重试
          error.value = failed.map((item) => `${item.id}: ${item.error}`).join("；");
        } else {
          successMessage.value = t("admin.repoBackup.messages.batchDeleteSuccess", { count: succeeded || ids.length });
        }

        base.clearSelection();
        await loadRepositories({ keepMessages: true });
      }
    } catch (e) {
      notifyError(e, "admin.repoBackup.messages.batchDeleteFailed");
    } finally {
      batchDeleting.value = false;
      cancelBatchDelete();
    }
  };

  // ==================== 检查更新 ====================

  const handleCheck = async (repo) => {
    clearMessages();
    markBusy(repo.id, true);
    // 修改点（检查更新没有反馈）：结果提示必须在列表刷新**之后**再落，
    // 否则会被 loadRepositories 的 clearMessages 吞掉（原先就是这么丢的）
    let message = "";
    try {
      const resp = await checkRepository(repo.id);
      if (resp?.success) {
        checkResults.value = { ...checkResults.value, [repo.id]: resp.data };
        message = resp.message || "";
      }
    } catch (e) {
      notifyError(e, "admin.repoBackup.messages.checkFailed");
    } finally {
      // 检查会回写 last_checked_at / last_error，刷新列表保持一致；
      // keepMessages=true 让上面拿到的提示能留在界面上
      await loadRepositories({ keepMessages: true });
      // 失败时 notifyError 已经写过 error，不要再覆盖成成功提示
      if (message && !error.value) successMessage.value = message;
      markBusy(repo.id, false);
    }
  };

  // ==================== 手动备份 ====================

  /**
   * 触发备份
   * @param {object} repo
   * @param {{force?: boolean}} options
   * @returns {Promise<string|null>} jobId
   */
  const handleBackup = async (repo, options = {}) => {
    clearMessages();
    markBusy(repo.id, true);
    try {
      const resp = await triggerBackup(repo.id, options);
      if (resp?.success) {
        successMessage.value = resp.message || t("admin.repoBackup.messages.backupCreated");
        return resp.data?.jobId || null;
      }
      return null;
    } catch (e) {
      notifyError(e, "admin.repoBackup.messages.backupFailed");
      return null;
    } finally {
      markBusy(repo.id, false);
    }
  };

  // ==================== 备份历史 ====================

  const openHistory = async (repo) => {
    historyRepo.value = repo;
    historyPaging.offset = 0;
    // 每次打开都回到「全部状态」，避免上次的筛选条件让人以为没有记录
    historyStatuses.value = [];
    showHistory.value = true;
    await loadHistory();
  };

  const closeHistory = () => {
    showHistory.value = false;
    historyRepo.value = null;
    historyItems.value = [];
    historyTotal.value = 0;
    historyStatusCounts.value = {};
  };

  const loadHistory = async () => {
    if (!historyRepo.value) return;
    historyLoading.value = true;
    try {
      const resp = await listBackups(historyRepo.value.id, {
        limit: historyPaging.limit,
        offset: historyPaging.offset,
        statuses: historyStatuses.value,
      });
      if (resp?.success) {
        historyItems.value = resp.data?.items || [];
        historyTotal.value = resp.data?.total || 0;
        historyStatusCounts.value = resp.data?.statusCounts || {};
      }
    } catch (e) {
      notifyError(e, "admin.repoBackup.messages.historyFailed");
    } finally {
      historyLoading.value = false;
    }
  };

  const changeHistoryPage = async (offset) => {
    historyPaging.offset = Math.max(0, offset);
    await loadHistory();
  };

  /**
   * 切换历史记录的状态筛选（修改点：历史记录需显示失败记录）
   * - 传 null / 空数组表示「全部」
   * - 筛选条件变化必须把 offset 归零，否则会停在超出范围的页上看到空列表
   */
  const changeHistoryStatuses = async (statuses) => {
    historyStatuses.value = Array.isArray(statuses) ? statuses.filter(Boolean) : [];
    historyPaging.offset = 0;
    await loadHistory();
  };

  /**
   * 下载备份快照或其 manifest
   * @param {object} backup
   * @param {{manifest?: boolean}} options
   */
  const downloadBackup = async (backup, options = {}) => {
    clearMessages();
    try {
      const resp = await getBackupDownloadLink(backup.id, options);
      const url = resp?.data?.url;
      if (!url) {
        error.value = t("admin.repoBackup.messages.downloadFailed");
        return;
      }
      window.open(url, "_blank", "noopener");
    } catch (e) {
      notifyError(e, "admin.repoBackup.messages.downloadFailed");
    }
  };

  return {
    // 状态
    loading,
    error,
    successMessage,
    repositories,
    providers,
    mounts,
    writableMounts,
    checkResults,
    isRepoBusy,
    clearMessages,

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

    // 选择 / 批量（修改点：仓库管理批量删除）
    selectedItems,
    isSelected,
    allSelected,
    toggleSelectItem: base.toggleSelectItem,
    toggleSelectAll,
    clearSelection: base.clearSelection,
    showBatchDeleteConfirm,
    batchDeleting,
    confirmBatchDelete,
    cancelBatchDelete,
    handleBatchDelete,

    // 表单
    showForm,
    editingRepo,
    formSubmitting,
    openCreateForm,
    openEditForm,
    closeForm,
    submitForm,

    // 删除
    showDeleteConfirm,
    repoToDelete,
    confirmDelete,
    cancelDelete,
    handleDelete,

    // 动作
    toggleEnabled,
    handleCheck,
    handleBackup,

    // 历史
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

    // 加载
    initialize,
    loadRepositories,
  };
}
