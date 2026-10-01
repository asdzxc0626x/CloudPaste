/**
 * 代码仓库备份管理 composable（修改点：新增功能）
 *
 * 职责：把仓库列表 / 表单 / 检查更新 / 备份历史的状态与动作集中管理，
 * 视图只负责渲染，与 useFsMetaManagement 的分层方式保持一致。
 *
 * 表单约定：表单组件自持本地状态，提交时把完整 payload 交回这里，
 * 避免跨组件改写 props（vue/no-mutating-props）。
 */

import { ref, reactive, computed } from "vue";
import { useI18n } from "vue-i18n";
import {
  getProviders,
  listRepositories,
  createRepository,
  updateRepository,
  deleteRepository,
  setRepositoryEnabled,
  checkRepository,
  triggerBackup,
  listBackups,
  getBackupDownloadLink,
} from "@/api/services/repoBackupService.js";
import { api } from "@/api";

export function useRepoBackup() {
  const { t } = useI18n();

  // ==================== 基础状态 ====================
  const loading = ref(false);
  const error = ref("");
  const successMessage = ref("");

  const repositories = ref([]);
  const providers = ref([]);
  const mounts = ref([]);

  // 行级操作中的仓库 ID 集合（避免全局 loading 遮罩）
  const busyRepoIds = ref(new Set());

  // ==================== 表单状态 ====================
  const showForm = ref(false);
  const formSubmitting = ref(false);
  /** 正在编辑的仓库；null 表示新建 */
  const editingRepo = ref(null);

  // ==================== 删除确认 ====================
  const showDeleteConfirm = ref(false);
  const repoToDelete = ref(null);

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

  /** 加载仓库列表 */
  const loadRepositories = async () => {
    loading.value = true;
    clearMessages();
    try {
      const resp = await listRepositories();
      if (resp?.success) repositories.value = resp.data || [];
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
        await loadRepositories();
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
        await loadRepositories();
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
        await loadRepositories();
      }
    } catch (e) {
      notifyError(e, "admin.repoBackup.messages.deleteFailed");
    } finally {
      markBusy(id, false);
      cancelDelete();
    }
  };

  // ==================== 检查更新 ====================

  const handleCheck = async (repo) => {
    clearMessages();
    markBusy(repo.id, true);
    try {
      const resp = await checkRepository(repo.id);
      if (resp?.success) {
        checkResults.value = { ...checkResults.value, [repo.id]: resp.data };
        successMessage.value = resp.message || "";
        // 检查会回写 last_checked_at / last_error，刷新列表保持一致
        await loadRepositories();
      }
    } catch (e) {
      notifyError(e, "admin.repoBackup.messages.checkFailed");
      await loadRepositories();
    } finally {
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
