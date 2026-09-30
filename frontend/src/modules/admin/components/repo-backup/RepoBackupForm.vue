<script setup>
/**
 * 代码仓库表单弹窗（修改点：新增功能）
 *
 * 设计：
 * - 自持本地 formData（与 FsMetaForm 一致的约定），提交时 emit 数据，
 *   避免直接改写 props（vue/no-mutating-props）
 * - 通用字段（仓库标识 / 跟踪模式 / 备份目标）显式渲染，因为它们对所有 provider 一致
 * - provider 私有字段由 /providers 返回的 configSchema 驱动迭代渲染，
 *   新增 GitLab/Gitea 时无需改动本组件
 * - 未复用 DynamicFormField：它不支持 secret 类型（token 需要密码框 + 显示切换）；
 *   也未复用 ConfigForm：它与 storage_configs 的 reveal 接口强耦合
 *
 * 优化点（多分支 / 多备份目标 / 版本保留 / 独立备份计划 / 窗口高度 / 响应式）：
 * - 分支模式支持录入多个分支（回车或逗号添加，chip 展示，可单个删除）
 * - 备份目标改为「同一个下拉框内直接多选」，选中项在最左侧显示绿色 √
 * - 新增保留版本数输入
 * - 新增备份计划（开关 + 间隔预设/自定义小时数），复用后端 scheduled_jobs
 * - 弹窗改为 flex 三段式（标题 / 可滚动正文 / 固定底部按钮），
 *   正文独立滚动，底部按钮始终可见，不再出现"整窗滚动、按钮跑出屏幕"
 * - 高级配置默认折叠，仓库表单的主要字段因此能在一屏内看完
 * - 手机端：单列布局、按钮全宽、弹窗占满安全高度，不产生横向滚动
 */
import { computed, reactive, ref, watch, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { IconClose, IconChevronDown, IconCheck } from "@/components/icons";

const props = defineProps({
  /** 编辑的仓库对象；为 null 表示新建 */
  repo: { type: Object, default: null },
  providers: { type: Array, default: () => [] },
  writableMounts: { type: Array, default: () => [] },
  submitting: { type: Boolean, default: false },
  error: { type: String, default: "" },
  darkMode: { type: Boolean, default: false },
});

const emit = defineEmits(["submit", "cancel"]);

const { t, te } = useI18n();

const isEditMode = computed(() => Boolean(props.repo?.id));

/** 保留版本数上下限（与后端 config.js 的常量保持一致） */
const MIN_RETENTION = 1;
const MAX_RETENTION = 100;
const DEFAULT_RETENTION = 10;

/** 备份计划间隔上下限与默认值（与后端 repobackup/schedule.js 的常量保持一致） */
const MIN_INTERVAL_SEC = 15 * 60;
const MAX_INTERVAL_SEC = 30 * 24 * 3600;
const DEFAULT_INTERVAL_SEC = 6 * 3600;

/** 间隔预设：覆盖常见节奏，其余走「自定义小时数」 */
const INTERVAL_PRESETS = [3600, 3 * 3600, 6 * 3600, 12 * 3600, 24 * 3600, 3 * 24 * 3600, 7 * 24 * 3600];

/** 本地表单状态 */
const formData = reactive({
  provider: "github",
  name: "",
  repoIdentifier: "",
  trackMode: "branch",
  /** branch 模式：分支名数组（修改点：多分支） */
  trackRefs: ["main"],
  /** release 模式：单个 tag，空串表示最新 Release */
  trackRef: "",
  /** 备份目标挂载点 ID 数组（修改点：多备份目标） */
  targetMountIds: [],
  targetPathPrefix: "/",
  retentionCount: DEFAULT_RETENTION,
  /** 备份计划开关（修改点：独立备份计划）；间隔由 intervalSelect/customHours 推导 */
  scheduleEnabled: true,
  enabled: true,
  config: {},
});

/**
 * 间隔选择器状态（修改点：独立备份计划）
 * - intervalSelect 为数字表示选中预设，为 "custom" 表示用 customHours 自定义
 * - 真正提交的秒数由 resolvedIntervalSec 推导，避免维护两份状态导致不同步
 */
const intervalSelect = ref(DEFAULT_INTERVAL_SEC);
const customHours = ref(DEFAULT_INTERVAL_SEC / 3600);

const resolvedIntervalSec = computed(() => {
  if (intervalSelect.value === "custom") {
    const hours = Number(customHours.value);
    if (!Number.isFinite(hours)) return NaN;
    return Math.round(hours * 3600);
  }
  return Number(intervalSelect.value);
});

/** 把秒数还原成选择器状态：能对上预设就选预设，否则切到自定义 */
const applyIntervalSec = (seconds) => {
  const value = Number(seconds);
  const safe = Number.isFinite(value) && value > 0 ? value : DEFAULT_INTERVAL_SEC;
  if (INTERVAL_PRESETS.includes(safe)) {
    intervalSelect.value = safe;
    customHours.value = Math.round((safe / 3600) * 100) / 100;
    return;
  }
  intervalSelect.value = "custom";
  customHours.value = Math.round((safe / 3600) * 100) / 100;
};

/** 人类可读的间隔文案（用于预设下拉） */
const formatInterval = (seconds) => {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "-";
  if (value % 86400 === 0) return t("admin.repoBackup.form.intervalDays", { count: value / 86400 });
  if (value % 3600 === 0) return t("admin.repoBackup.form.intervalHours", { count: value / 3600 });
  return t("admin.repoBackup.form.intervalMinutes", { count: Math.round(value / 60) });
};

/** 表单内的本地校验错误 */
const localError = ref("");

/** 分支输入框的临时内容 */
const branchDraft = ref("");

/** secret 字段的明文可见状态 */
const secretVisible = reactive({});

/** 高级配置折叠状态（默认折叠以减少弹窗高度） */
const advancedOpen = ref(false);

/** 备份目标下拉的展开状态 */
const targetOpen = ref(false);

const toggleSecret = (name) => {
  secretVisible[name] = !secretVisible[name];
};

/** 用传入的 repo 初始化表单 */
const resetForm = () => {
  localError.value = "";
  branchDraft.value = "";
  advancedOpen.value = false;
  targetOpen.value = false;

  if (props.repo) {
    const refs = Array.isArray(props.repo.trackRefs) && props.repo.trackRefs.length > 0
      ? props.repo.trackRefs.filter((r) => r != null).map((r) => String(r))
      : [];
    const mountIds = Array.isArray(props.repo.targetMountIds) && props.repo.targetMountIds.length > 0
      ? props.repo.targetMountIds.map((m) => String(m))
      : props.repo.targetMountId
        ? [String(props.repo.targetMountId)]
        : [];

    Object.assign(formData, {
      provider: props.repo.provider,
      name: props.repo.name || "",
      repoIdentifier: props.repo.repoIdentifier || "",
      trackMode: props.repo.trackMode || "branch",
      trackRefs: props.repo.trackMode === "branch" ? (refs.length > 0 ? refs : ["main"]) : ["main"],
      trackRef: props.repo.trackMode === "branch" ? "" : (refs[0] || ""),
      targetMountIds: mountIds,
      targetPathPrefix: props.repo.targetPathPrefix || "/",
      retentionCount: Number(props.repo.retentionCount) || DEFAULT_RETENTION,
      // 修改点（独立备份计划）：计划缺失（v36 及更早的存量仓库）时按默认开启处理
      scheduleEnabled: props.repo.schedule ? props.repo.schedule.enabled !== false : true,
      enabled: props.repo.enabled !== false,
      // 配置中的敏感字段是掩码值，原样提交回后端会被识别并保留原密钥
      config: { ...(props.repo.config || {}) },
    });
    applyIntervalSec(props.repo.schedule?.intervalSec ?? DEFAULT_INTERVAL_SEC);
    return;
  }

  Object.assign(formData, {
    provider: props.providers[0]?.provider || "github",
    name: "",
    repoIdentifier: "",
    trackMode: "branch",
    trackRefs: ["main"],
    trackRef: "",
    // 默认选中第一个可写挂载点，减少一次点击
    targetMountIds: props.writableMounts[0]?.id ? [String(props.writableMounts[0].id)] : [],
    targetPathPrefix: "/",
    retentionCount: DEFAULT_RETENTION,
    scheduleEnabled: true,
    enabled: true,
    config: {},
  });
  applyIntervalSec(DEFAULT_INTERVAL_SEC);
};

watch(() => props.repo, resetForm, { immediate: true });

/** 当前 provider 的元数据 */
const providerMeta = computed(() => props.providers.find((p) => p.provider === formData.provider) || null);

/** provider 私有字段列表（来自后端 configSchema） */
const configFields = computed(() => {
  const fields = providerMeta.value?.configSchema?.fields;
  return Array.isArray(fields) ? fields : [];
});

/** 当前 provider 支持的跟踪模式 */
const trackModes = computed(() => {
  const modes = providerMeta.value?.trackModes;
  return Array.isArray(modes) && modes.length > 0 ? modes : ["branch"];
});

/** 切换跟踪模式时整理引用字段 */
const onTrackModeChange = (mode) => {
  formData.trackMode = mode;
  if (mode === "branch") {
    if (!Array.isArray(formData.trackRefs) || formData.trackRefs.length === 0) {
      formData.trackRefs = ["main"];
    }
    formData.trackRef = "";
  } else {
    // release 模式留空表示取最新 Release
    formData.trackRef = "";
  }
};

/** i18n key 兜底：缺翻译时回退到字段名，避免界面出现原始 key */
const translate = (key, fallback) => (key && te(key) ? t(key) : fallback);

const fieldLabel = (field) => translate(field.labelKey, field.name);
const fieldPlaceholder = (field) => translate(field.ui?.placeholderKey, "");
const fieldDescription = (field) => translate(field.ui?.descriptionKey, "");

const getConfigValue = (name) => formData.config?.[name] ?? "";
const setConfigValue = (name, value) => {
  formData.config[name] = value;
};

// ==================== 多分支：chip 输入 ====================

/** 追加一个分支名（去重、忽略空值） */
const addBranch = (raw) => {
  const text = String(raw ?? "").trim();
  if (!text) return;
  if (formData.trackRefs.includes(text)) {
    branchDraft.value = "";
    return;
  }
  formData.trackRefs.push(text);
  branchDraft.value = "";
};

/** 输入框回车 / 逗号 / 失焦时提交草稿 */
const commitBranchDraft = () => {
  const raw = branchDraft.value;
  if (!raw) return;
  // 支持一次粘贴多个：以逗号、中文逗号、空格、换行分隔
  raw
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach(addBranch);
  branchDraft.value = "";
};

/** 分支输入框按键处理：回车或逗号即确认当前分支 */
const onBranchKeydown = (event) => {
  if (event.key === "Enter" || event.key === "," || event.key === "，") {
    event.preventDefault();
    commitBranchDraft();
  } else if (event.key === "Backspace" && !branchDraft.value && formData.trackRefs.length > 0) {
    // 输入框已空时退格删除最后一个 chip，符合常见的 tag 输入习惯
    formData.trackRefs.pop();
  }
};

const removeBranch = (index) => {
  formData.trackRefs.splice(index, 1);
};

// ==================== 多备份目标：下拉多选 ====================

const selectedMounts = computed(() =>
  formData.targetMountIds
    .map((id) => props.writableMounts.find((m) => String(m.id) === String(id)))
    .filter(Boolean),
);

/** 已选目标失效（挂载点被删除）时仍要能显示出来，避免"选中的目标看不见" */
const danglingMountIds = computed(() =>
  formData.targetMountIds.filter((id) => !props.writableMounts.some((m) => String(m.id) === String(id))),
);

const isMountSelected = (mount) => formData.targetMountIds.some((id) => String(id) === String(mount.id));

const toggleMount = (mount) => {
  const id = String(mount.id);
  const index = formData.targetMountIds.findIndex((item) => String(item) === id);
  if (index >= 0) formData.targetMountIds.splice(index, 1);
  else formData.targetMountIds.push(id);
};

const removeMount = (id) => {
  const index = formData.targetMountIds.findIndex((item) => String(item) === String(id));
  if (index >= 0) formData.targetMountIds.splice(index, 1);
};

const mountLabel = (mount) => mount.name || mount.mount_path;

/** 触发器上展示的摘要文本 */
const targetSummary = computed(() => {
  if (formData.targetMountIds.length === 0) return "";
  const names = selectedMounts.value.map(mountLabel);
  const missing = danglingMountIds.value.length;
  if (missing > 0) names.push(t("admin.repoBackup.form.mountMissingCount", { count: missing }));
  return names.join("、");
});

// ==================== 提交 ====================

/** 提交前的本地校验 */
const handleSubmit = () => {
  localError.value = "";
  commitBranchDraft();

  if (!formData.repoIdentifier?.trim()) {
    localError.value = t("admin.repoBackup.validation.repoRequired");
    return;
  }
  if (formData.trackMode === "branch" && formData.trackRefs.length === 0) {
    localError.value = t("admin.repoBackup.validation.branchRequired");
    return;
  }
  if (formData.targetMountIds.length === 0) {
    localError.value = t("admin.repoBackup.validation.mountRequired");
    return;
  }

  const retention = Number(formData.retentionCount);
  if (!Number.isFinite(retention) || retention < MIN_RETENTION || retention > MAX_RETENTION) {
    localError.value = t("admin.repoBackup.validation.retentionRange", { min: MIN_RETENTION, max: MAX_RETENTION });
    return;
  }

  // 修改点（独立备份计划）：只有启用了定时备份才校验间隔，关闭时间隔值无意义
  const intervalSec = resolvedIntervalSec.value;
  if (formData.scheduleEnabled) {
    if (!Number.isFinite(intervalSec) || intervalSec < MIN_INTERVAL_SEC || intervalSec > MAX_INTERVAL_SEC) {
      localError.value = t("admin.repoBackup.validation.intervalRange", {
        min: MIN_INTERVAL_SEC / 60,
        max: MAX_INTERVAL_SEC / 86400,
      });
      return;
    }
  }

  emit("submit", {
    id: props.repo?.id || null,
    provider: formData.provider,
    name: formData.name?.trim() || undefined,
    repoIdentifier: formData.repoIdentifier.trim(),
    trackMode: formData.trackMode,
    // 修改点（多分支优化）：branch 模式提交数组；release 模式提交单个 tag
    trackRefs: formData.trackMode === "branch" ? [...formData.trackRefs] : [],
    trackRef: formData.trackMode === "branch" ? null : formData.trackRef?.trim() || null,
    // 修改点（多备份目标优化）：提交数组
    targetMountIds: [...formData.targetMountIds],
    targetPathPrefix: formData.targetPathPrefix?.trim() || "/",
    // 修改点（版本保留优化）
    retentionCount: Math.trunc(retention),
    // 修改点（独立备份计划优化）：关闭时也提交当前间隔，重新开启后沿用同一节奏
    scheduleEnabled: formData.scheduleEnabled,
    scheduleIntervalSec: Number.isFinite(intervalSec) ? intervalSec : DEFAULT_INTERVAL_SEC,
    enabled: formData.enabled,
    config: { ...formData.config },
  });
};

/** 展示错误：优先本地校验错误，其次服务端错误 */
const displayError = computed(() => localError.value || props.error);

// ==================== 样式 ====================

const inputClass = computed(() =>
  props.darkMode
    ? "w-full px-2.5 py-1.5 text-sm rounded-md border bg-gray-800 border-gray-600 text-white placeholder-gray-500 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
    : "w-full px-2.5 py-1.5 text-sm rounded-md border bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500",
);

const labelClass = computed(() =>
  props.darkMode ? "block text-xs font-medium text-gray-300 mb-1" : "block text-xs font-medium text-gray-600 mb-1",
);

const hintClass = computed(() => (props.darkMode ? "mt-1 text-[11px] leading-4 text-gray-500" : "mt-1 text-[11px] leading-4 text-gray-400"));

const chipClass = computed(() =>
  props.darkMode
    ? "inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-gray-700 text-gray-200"
    : "inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-gray-100 text-gray-700",
);

const borderedInputClass = computed(() =>
  props.darkMode
    ? "flex flex-wrap items-center gap-1.5 min-h-[34px] px-2 py-1 rounded-md border bg-gray-800 border-gray-600 focus-within:ring-2 focus-within:ring-blue-500"
    : "flex flex-wrap items-center gap-1.5 min-h-[34px] px-2 py-1 rounded-md border bg-white border-gray-300 focus-within:ring-2 focus-within:ring-blue-500",
);

const sectionTitleClass = computed(() =>
  props.darkMode ? "text-xs font-semibold text-gray-300 uppercase tracking-wide" : "text-xs font-semibold text-gray-500 uppercase tracking-wide",
);

/**
 * 分区卡片样式（修改点：编辑窗口高度 / 响应式优化）
 * - 原来各分区是「上边框 + 竖向堆叠」，在宽屏上只用到中间一条，
 *   高度被迫堆到 700px 以上，1080p 笔记本必然出现滚动
 * - 改成卡片后可以在 lg 断点两列并排，主要字段一屏看完
 */
const cardClass = computed(() =>
  props.darkMode ? "rounded-lg border border-gray-700 bg-gray-800/30 p-3 space-y-2.5" : "rounded-lg border border-gray-200 bg-gray-50/60 p-3 space-y-2.5",
);

/** Esc 关闭（下拉展开时优先收起下拉，符合"高层先关"的直觉） */
function onEscClose(event) {
  if (event.key !== "Escape") return;
  if (targetOpen.value) {
    targetOpen.value = false;
    return;
  }
  emit("cancel");
}

onMounted(() => document.addEventListener("keydown", onEscClose));
onBeforeUnmount(() => document.removeEventListener("keydown", onEscClose));
</script>

<template>
  <!--
    修改点（编辑窗口高度 / 响应式优化）：
    - 手机端：底部弹出式（items-end + 上圆角），占满宽度
    - 平板及以上：居中；lg 起放宽到 4xl，让分区能两列并排从而压低整体高度

    修改点（弹窗顶部被控制栏遮挡）：
    - 必须 Teleport 到 body。AdminLayout 的 main 容器在 md 断点是 `fixed z-40`，
      它本身就是一个层叠上下文，弹窗写在它内部时 z-50 只是「40 层内部的 50」，
      整体仍低于 App.vue 里 `sticky top-0 z-50` 的站点头部，于是顶部标题栏被压住。
      88vh 居中时上边缘约在 6vh，笔记本高度下正好落进 64px 的头部区域。
    - 逃出层叠上下文后再用 z-[60] 盖住头部，不依赖 DOM 顺序
  -->
  <Teleport to="body">
  <div
    class="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/50"
    @click.self="emit('cancel')"
  >
    <div
      class="w-full sm:max-w-3xl lg:max-w-5xl flex flex-col rounded-t-xl sm:rounded-lg shadow-xl overflow-hidden max-h-[92vh] sm:max-h-[88vh]"
      :class="darkMode ? 'bg-gray-900' : 'bg-white'"
    >
      <!-- 标题栏（不随正文滚动） -->
      <div
        class="flex items-center justify-between gap-2 px-4 sm:px-5 py-2.5 border-b shrink-0"
        :class="darkMode ? 'border-gray-700' : 'border-gray-200'"
      >
        <h3 class="text-sm sm:text-base font-medium truncate" :class="darkMode ? 'text-white' : 'text-gray-900'">
          {{ isEditMode ? $t("admin.repoBackup.form.editTitle") : $t("admin.repoBackup.form.createTitle") }}
        </h3>
        <button type="button" class="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 shrink-0" @click="emit('cancel')">
          <IconClose class="h-4 w-4" :class="darkMode ? 'text-gray-400' : 'text-gray-500'" />
        </button>
      </div>

      <!-- 正文：独立滚动区 -->
      <form class="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-3" @submit.prevent="handleSubmit">
        <!-- 错误提示 -->
        <div v-if="displayError" class="mb-3 px-3 py-2 rounded text-xs bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">
          {{ displayError }}
        </div>

        <!-- 分区卡片：手机/平板单列，lg 起两列并排 -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
          <!-- 基础信息 -->
          <section :class="cardClass">
            <h4 :class="sectionTitleClass">{{ $t("admin.repoBackup.form.basicSection") }}</h4>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label :class="labelClass">{{ $t("admin.repoBackup.form.provider") }}</label>
                <select v-model="formData.provider" :class="inputClass" :disabled="isEditMode">
                  <option v-for="p in providers" :key="p.provider" :value="p.provider">{{ p.displayName }}</option>
                </select>
              </div>

              <div>
                <label :class="labelClass">{{ $t("admin.repoBackup.form.name") }}</label>
                <input v-model="formData.name" type="text" :class="inputClass" :placeholder="$t('admin.repoBackup.form.namePlaceholder')" />
              </div>
            </div>

            <div>
              <label :class="labelClass">
                {{ $t("admin.repoBackup.form.repoIdentifier") }}
                <span class="text-red-500">*</span>
              </label>
              <input
                v-model="formData.repoIdentifier"
                type="text"
                :class="inputClass"
                :placeholder="$t('admin.repoBackup.form.repoIdentifierPlaceholder')"
              />
              <p :class="hintClass">{{ $t("admin.repoBackup.form.repoIdentifierHint") }}</p>
            </div>
          </section>

          <!-- 跟踪设置：卡片内单列，分支 chip 输入需要完整宽度 -->
          <section :class="cardClass">
            <h4 :class="sectionTitleClass">{{ $t("admin.repoBackup.form.trackSection") }}</h4>

            <div>
              <label :class="labelClass">{{ $t("admin.repoBackup.form.trackMode") }}</label>
              <select :value="formData.trackMode" :class="inputClass" @change="onTrackModeChange($event.target.value)">
                <option v-for="mode in trackModes" :key="mode" :value="mode">
                  {{ $t(`admin.repoBackup.trackMode.${mode}`) }}
                </option>
              </select>
              <p :class="hintClass">{{ $t(`admin.repoBackup.form.trackModeHint.${formData.trackMode}`) }}</p>
            </div>

            <!-- release 模式：单个 tag -->
            <div v-if="formData.trackMode === 'release'">
              <label :class="labelClass">{{ $t("admin.repoBackup.form.tag") }}</label>
              <input v-model="formData.trackRef" type="text" :class="inputClass" :placeholder="$t('admin.repoBackup.form.tagPlaceholder')" />
              <p :class="hintClass">{{ $t("admin.repoBackup.form.tagHint") }}</p>
            </div>

            <!-- branch 模式：多分支录入（修改点：多分支优化） -->
            <div v-else>
              <label :class="labelClass">
                {{ $t("admin.repoBackup.form.branches") }}
                <span class="text-red-500">*</span>
              </label>
              <div :class="borderedInputClass">
                <span v-for="(ref, index) in formData.trackRefs" :key="ref" :class="chipClass">
                  <span class="font-mono max-w-[8rem] sm:max-w-[10rem] truncate">{{ ref }}</span>
                  <button
                    type="button"
                    class="text-gray-400 hover:text-red-500 leading-none"
                    :title="$t('admin.repoBackup.form.removeBranch')"
                    @click="removeBranch(index)"
                  >
                    ×
                  </button>
                </span>
                <input
                  v-model="branchDraft"
                  type="text"
                  class="flex-1 min-w-[6rem] bg-transparent border-0 p-0 text-sm focus:ring-0 focus:outline-none"
                  :class="darkMode ? 'text-white placeholder-gray-500' : 'text-gray-900 placeholder-gray-400'"
                  :placeholder="formData.trackRefs.length === 0 ? 'main' : $t('admin.repoBackup.form.addBranchPlaceholder')"
                  @keydown="onBranchKeydown"
                  @blur="commitBranchDraft"
                />
              </div>
              <p :class="hintClass">{{ $t("admin.repoBackup.form.branchesHint") }}</p>
            </div>
          </section>

          <!-- 备份目标 -->
          <section :class="cardClass">
            <h4 :class="sectionTitleClass">{{ $t("admin.repoBackup.form.targetSection") }}</h4>

            <div>
              <label :class="labelClass">
                {{ $t("admin.repoBackup.form.targetMount") }}
                <span class="text-red-500">*</span>
              </label>

              <!-- 多选下拉：选中的目标在最左侧显示绿色 √（修改点：多备份目标优化） -->
              <div class="relative">
                <button
                  type="button"
                  class="w-full flex items-center gap-2 px-2.5 py-1.5 text-sm rounded-md border text-left"
                  :class="darkMode ? 'bg-gray-800 border-gray-600' : 'bg-white border-gray-300'"
                  :disabled="writableMounts.length === 0"
                  @click="targetOpen = !targetOpen"
                >
                  <span class="flex-1 min-w-0 truncate" :class="targetSummary ? (darkMode ? 'text-gray-100' : 'text-gray-900') : 'text-gray-400'">
                    {{ targetSummary || $t("admin.repoBackup.form.selectMount") }}
                  </span>
                  <span
                    v-if="formData.targetMountIds.length > 0"
                    class="shrink-0 text-[11px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                  >
                    {{ $t("admin.repoBackup.form.selectedCount", { count: formData.targetMountIds.length }) }}
                  </span>
                  <IconChevronDown class="h-4 w-4 shrink-0 transition-transform" :class="[darkMode ? 'text-gray-400' : 'text-gray-500', targetOpen ? 'rotate-180' : '']" />
                </button>

                <!-- 点击遮罩关闭下拉（在移动端比 document 监听更可靠） -->
                <div v-if="targetOpen" class="fixed inset-0 z-10" @click="targetOpen = false"></div>

                <div
                  v-if="targetOpen"
                  class="absolute z-20 mt-1 w-full max-h-44 sm:max-h-52 overflow-y-auto rounded-md border shadow-lg"
                  :class="darkMode ? 'bg-gray-800 border-gray-600' : 'bg-white border-gray-200'"
                >
                  <button
                    v-for="m in writableMounts"
                    :key="m.id"
                    type="button"
                    class="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-sm"
                    :class="darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-50'"
                    @click="toggleMount(m)"
                  >
                    <!-- 绿色 √ 固定在每一行最左侧 -->
                    <span class="w-4 shrink-0 flex items-center justify-center">
                      <IconCheck v-if="isMountSelected(m)" class="h-4 w-4 text-green-500" />
                    </span>
                    <span class="flex-1 min-w-0 truncate" :class="darkMode ? 'text-gray-100' : 'text-gray-900'">
                      {{ mountLabel(m) }}
                    </span>
                    <span class="shrink-0 text-[11px] font-mono truncate max-w-[45%]" :class="darkMode ? 'text-gray-500' : 'text-gray-400'">
                      {{ m.mount_path }}
                    </span>
                  </button>
                </div>
              </div>

              <p v-if="writableMounts.length === 0" class="mt-1 text-[11px] text-red-600 dark:text-red-400">
                {{ $t("admin.repoBackup.form.noWritableMount") }}
              </p>
              <p v-else :class="hintClass">{{ $t("admin.repoBackup.form.targetMountHint") }}</p>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label :class="labelClass">{{ $t("admin.repoBackup.form.pathPrefix") }}</label>
                <input v-model="formData.targetPathPrefix" type="text" :class="inputClass" placeholder="/" />
                <p :class="hintClass">{{ $t("admin.repoBackup.form.pathPrefixHint") }}</p>
              </div>

              <!-- 修改点（版本保留优化） -->
              <div>
                <label :class="labelClass">{{ $t("admin.repoBackup.form.retentionCount") }}</label>
                <input
                  v-model.number="formData.retentionCount"
                  type="number"
                  :min="MIN_RETENTION"
                  :max="MAX_RETENTION"
                  :class="inputClass"
                  :placeholder="String(DEFAULT_RETENTION)"
                />
                <p :class="hintClass">{{ $t("admin.repoBackup.form.retentionCountHint", { count: DEFAULT_RETENTION }) }}</p>
              </div>
            </div>
          </section>

          <!-- 备份计划（修改点：独立备份计划优化） -->
          <section :class="cardClass">
            <div class="flex items-center justify-between gap-2 flex-wrap">
              <h4 :class="sectionTitleClass">{{ $t("admin.repoBackup.form.scheduleSection") }}</h4>
              <label class="inline-flex items-center gap-1.5 shrink-0">
                <input v-model="formData.scheduleEnabled" type="checkbox" class="rounded border-gray-300" />
                <span class="text-xs" :class="darkMode ? 'text-gray-300' : 'text-gray-700'">
                  {{ $t("admin.repoBackup.form.scheduleEnabled") }}
                </span>
              </label>
            </div>

            <div v-if="formData.scheduleEnabled" class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label :class="labelClass">{{ $t("admin.repoBackup.form.scheduleInterval") }}</label>
                <select v-model="intervalSelect" :class="inputClass">
                  <option v-for="preset in INTERVAL_PRESETS" :key="preset" :value="preset">
                    {{ formatInterval(preset) }}
                  </option>
                  <option value="custom">{{ $t("admin.repoBackup.form.intervalCustom") }}</option>
                </select>
                <p :class="hintClass">{{ $t("admin.repoBackup.form.scheduleIntervalHint") }}</p>
              </div>

              <!-- 自定义小时数 -->
              <div v-if="intervalSelect === 'custom'">
                <label :class="labelClass">{{ $t("admin.repoBackup.form.intervalCustomHours") }}</label>
                <input
                  v-model.number="customHours"
                  type="number"
                  :min="MIN_INTERVAL_SEC / 3600"
                  :max="MAX_INTERVAL_SEC / 3600"
                  step="0.25"
                  :class="inputClass"
                />
                <p :class="hintClass">
                  {{ $t("admin.repoBackup.form.intervalCustomHint", { min: MIN_INTERVAL_SEC / 60, max: MAX_INTERVAL_SEC / 86400 }) }}
                </p>
              </div>
            </div>

            <p v-else :class="hintClass">{{ $t("admin.repoBackup.form.scheduleDisabledHint") }}</p>
          </section>

          <!-- provider 私有配置（schema 驱动，默认折叠以减少窗口高度；展开时占满两列） -->
          <section v-if="configFields.length > 0" :class="[cardClass, 'lg:col-span-2']">
            <button type="button" class="w-full flex items-center justify-between gap-2" @click="advancedOpen = !advancedOpen">
              <span :class="sectionTitleClass">{{ $t("admin.repoBackup.form.advancedSection") }}</span>
              <IconChevronDown
                class="h-4 w-4 shrink-0 transition-transform"
                :class="[darkMode ? 'text-gray-400' : 'text-gray-500', advancedOpen ? 'rotate-180' : '']"
              />
            </button>

            <div v-if="advancedOpen" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
              <div v-for="field in configFields" :key="field.name">
                <label :class="labelClass">
                  {{ fieldLabel(field) }}
                  <span v-if="field.required" class="text-red-500">*</span>
                </label>

                <!-- secret 类型：密码框 + 显示切换 -->
                <div v-if="field.type === 'secret'" class="relative">
                  <input
                    :type="secretVisible[field.name] ? 'text' : 'password'"
                    :value="getConfigValue(field.name)"
                    :class="inputClass"
                    class="pr-12"
                    :placeholder="fieldPlaceholder(field)"
                    autocomplete="off"
                    @input="setConfigValue(field.name, $event.target.value)"
                  />
                  <button
                    type="button"
                    class="absolute right-2 top-1/2 -translate-y-1/2 text-xs px-1.5 py-0.5 rounded"
                    :class="darkMode ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-700'"
                    @click="toggleSecret(field.name)"
                  >
                    {{ secretVisible[field.name] ? $t("admin.repoBackup.form.hide") : $t("admin.repoBackup.form.show") }}
                  </button>
                </div>

                <!-- boolean 类型 -->
                <label v-else-if="field.type === 'boolean'" class="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    :checked="Boolean(getConfigValue(field.name))"
                    class="rounded border-gray-300"
                    @change="setConfigValue(field.name, $event.target.checked)"
                  />
                  <span class="text-xs" :class="darkMode ? 'text-gray-300' : 'text-gray-700'">{{ fieldDescription(field) }}</span>
                </label>

                <!-- number 类型 -->
                <input
                  v-else-if="field.type === 'number'"
                  type="number"
                  :value="getConfigValue(field.name)"
                  :class="inputClass"
                  :placeholder="fieldPlaceholder(field)"
                  @input="setConfigValue(field.name, $event.target.value === '' ? '' : Number($event.target.value))"
                />

                <!-- 其余按文本处理 -->
                <input
                  v-else
                  type="text"
                  :value="getConfigValue(field.name)"
                  :class="inputClass"
                  :placeholder="fieldPlaceholder(field)"
                  @input="setConfigValue(field.name, $event.target.value)"
                />

                <p v-if="field.type !== 'boolean' && fieldDescription(field)" :class="hintClass">
                  {{ fieldDescription(field) }}
                </p>
              </div>
            </div>
          </section>
        </div>

        <!-- 启用开关（与分区同级，不占一整张卡片） -->
        <div class="mt-3 flex items-center justify-between gap-3 flex-wrap">
          <label class="inline-flex items-center gap-2">
            <input v-model="formData.enabled" type="checkbox" class="rounded border-gray-300" />
            <span class="text-xs" :class="darkMode ? 'text-gray-300' : 'text-gray-700'">
              {{ $t("admin.repoBackup.form.enabled") }}
            </span>
          </label>
          <p v-if="isEditMode" class="text-[11px] leading-4" :class="darkMode ? 'text-gray-500' : 'text-gray-400'">
            {{ $t("admin.repoBackup.form.providerLocked") }}
          </p>
        </div>
      </form>

      <!-- 底部按钮（固定可见，不随正文滚动） -->
      <div
        class="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 px-4 sm:px-5 py-3 border-t shrink-0"
        :class="darkMode ? 'border-gray-700' : 'border-gray-200'"
      >
        <button
          type="button"
          class="w-full sm:w-auto px-4 py-2 text-sm rounded-md border"
          :class="darkMode ? 'border-gray-600 text-gray-200 hover:bg-gray-700' : 'border-gray-300 text-gray-700 hover:bg-gray-100'"
          @click="emit('cancel')"
        >
          {{ $t("admin.repoBackup.buttons.cancel") }}
        </button>
        <button
          type="button"
          class="w-full sm:w-auto px-4 py-2 text-sm rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
          :disabled="submitting"
          @click="handleSubmit"
        >
          {{ submitting ? $t("admin.repoBackup.form.saving") : $t("admin.repoBackup.buttons.save") }}
        </button>
      </div>
    </div>
  </div>
  </Teleport>
</template>
