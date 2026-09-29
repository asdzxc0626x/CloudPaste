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
 */
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { IconClose } from "@/components/icons";

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

/** 本地表单状态 */
const formData = reactive({
  provider: "github",
  name: "",
  repoIdentifier: "",
  trackMode: "branch",
  trackRef: "main",
  targetMountId: "",
  targetPathPrefix: "/",
  enabled: true,
  config: {},
});

/** 表单内的本地校验错误 */
const localError = ref("");

/** secret 字段的明文可见状态 */
const secretVisible = reactive({});

const toggleSecret = (name) => {
  secretVisible[name] = !secretVisible[name];
};

/** 用传入的 repo 初始化表单 */
const resetForm = () => {
  localError.value = "";

  if (props.repo) {
    Object.assign(formData, {
      provider: props.repo.provider,
      name: props.repo.name || "",
      repoIdentifier: props.repo.repoIdentifier || "",
      trackMode: props.repo.trackMode || "branch",
      trackRef: props.repo.trackRef || "",
      targetMountId: props.repo.targetMountId || "",
      targetPathPrefix: props.repo.targetPathPrefix || "/",
      enabled: props.repo.enabled !== false,
      // 配置中的敏感字段是掩码值，原样提交回后端会被识别并保留原密钥
      config: { ...(props.repo.config || {}) },
    });
    return;
  }

  Object.assign(formData, {
    provider: props.providers[0]?.provider || "github",
    name: "",
    repoIdentifier: "",
    trackMode: "branch",
    trackRef: "main",
    // 默认选中第一个可写挂载点，减少一次点击
    targetMountId: props.writableMounts[0]?.id || "",
    targetPathPrefix: "/",
    enabled: true,
    config: {},
  });
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

/** 切换跟踪模式时同步默认的 ref */
const onTrackModeChange = (mode) => {
  formData.trackMode = mode;
  if (mode === "branch") {
    if (!formData.trackRef) formData.trackRef = "main";
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

/** 提交前的本地校验 */
const handleSubmit = () => {
  localError.value = "";

  if (!formData.repoIdentifier?.trim()) {
    localError.value = t("admin.repoBackup.validation.repoRequired");
    return;
  }
  if (formData.trackMode === "branch" && !formData.trackRef?.trim()) {
    localError.value = t("admin.repoBackup.validation.branchRequired");
    return;
  }
  if (!formData.targetMountId) {
    localError.value = t("admin.repoBackup.validation.mountRequired");
    return;
  }

  emit("submit", {
    id: props.repo?.id || null,
    provider: formData.provider,
    name: formData.name?.trim() || undefined,
    repoIdentifier: formData.repoIdentifier.trim(),
    trackMode: formData.trackMode,
    trackRef: formData.trackRef?.trim() || null,
    targetMountId: formData.targetMountId,
    targetPathPrefix: formData.targetPathPrefix?.trim() || "/",
    enabled: formData.enabled,
    config: { ...formData.config },
  });
};

/** 展示错误：优先本地校验错误，其次服务端错误 */
const displayError = computed(() => localError.value || props.error);

const inputClass = computed(() =>
  props.darkMode
    ? "w-full px-3 py-2 text-sm rounded-md border bg-gray-800 border-gray-600 text-white placeholder-gray-500 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
    : "w-full px-3 py-2 text-sm rounded-md border bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500",
);

const labelClass = computed(() => (props.darkMode ? "block text-sm font-medium text-gray-200 mb-1" : "block text-sm font-medium text-gray-700 mb-1"));

const hintClass = computed(() => (props.darkMode ? "mt-1 text-xs text-gray-400" : "mt-1 text-xs text-gray-500"));
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" @click.self="emit('cancel')">
    <div class="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg shadow-xl" :class="darkMode ? 'bg-gray-900' : 'bg-white'">
      <!-- 标题栏 -->
      <div class="flex items-center justify-between px-5 py-4 border-b" :class="darkMode ? 'border-gray-700' : 'border-gray-200'">
        <h3 class="text-base font-medium" :class="darkMode ? 'text-white' : 'text-gray-900'">
          {{ isEditMode ? $t("admin.repoBackup.form.editTitle") : $t("admin.repoBackup.form.createTitle") }}
        </h3>
        <button type="button" class="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700" @click="emit('cancel')">
          <IconClose class="h-4 w-4" :class="darkMode ? 'text-gray-400' : 'text-gray-500'" />
        </button>
      </div>

      <form class="px-5 py-4 space-y-4" @submit.prevent="handleSubmit">
        <!-- 错误提示 -->
        <div v-if="displayError" class="px-3 py-2 rounded text-sm bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">
          {{ displayError }}
        </div>

        <!-- 仓库类型 -->
        <div>
          <label :class="labelClass">{{ $t("admin.repoBackup.form.provider") }}</label>
          <select v-model="formData.provider" :class="inputClass" :disabled="isEditMode">
            <option v-for="p in providers" :key="p.provider" :value="p.provider">
              {{ p.displayName }}
            </option>
          </select>
          <p v-if="isEditMode" :class="hintClass">{{ $t("admin.repoBackup.form.providerLocked") }}</p>
        </div>

        <!-- 仓库标识 -->
        <div>
          <label :class="labelClass">
            {{ $t("admin.repoBackup.form.repoIdentifier") }}
            <span class="text-red-500">*</span>
          </label>
          <input v-model="formData.repoIdentifier" type="text" :class="inputClass" :placeholder="$t('admin.repoBackup.form.repoIdentifierPlaceholder')" />
          <p :class="hintClass">{{ $t("admin.repoBackup.form.repoIdentifierHint") }}</p>
        </div>

        <!-- 展示名 -->
        <div>
          <label :class="labelClass">{{ $t("admin.repoBackup.form.name") }}</label>
          <input v-model="formData.name" type="text" :class="inputClass" :placeholder="$t('admin.repoBackup.form.namePlaceholder')" />
        </div>

        <!-- 跟踪模式 -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label :class="labelClass">{{ $t("admin.repoBackup.form.trackMode") }}</label>
            <select :value="formData.trackMode" :class="inputClass" @change="onTrackModeChange($event.target.value)">
              <option v-for="mode in trackModes" :key="mode" :value="mode">
                {{ $t(`admin.repoBackup.trackMode.${mode}`) }}
              </option>
            </select>
            <p :class="hintClass">{{ $t(`admin.repoBackup.form.trackModeHint.${formData.trackMode}`) }}</p>
          </div>

          <div>
            <label :class="labelClass">
              {{ formData.trackMode === "branch" ? $t("admin.repoBackup.form.branch") : $t("admin.repoBackup.form.tag") }}
              <span v-if="formData.trackMode === 'branch'" class="text-red-500">*</span>
            </label>
            <input
              v-model="formData.trackRef"
              type="text"
              :class="inputClass"
              :placeholder="formData.trackMode === 'branch' ? 'main' : $t('admin.repoBackup.form.tagPlaceholder')"
            />
            <p v-if="formData.trackMode === 'release'" :class="hintClass">
              {{ $t("admin.repoBackup.form.tagHint") }}
            </p>
          </div>
        </div>

        <!-- 备份目标 -->
        <div class="pt-2 border-t" :class="darkMode ? 'border-gray-700' : 'border-gray-200'">
          <h4 class="text-sm font-medium mb-3" :class="darkMode ? 'text-gray-200' : 'text-gray-800'">
            {{ $t("admin.repoBackup.form.targetSection") }}
          </h4>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label :class="labelClass">
                {{ $t("admin.repoBackup.form.targetMount") }}
                <span class="text-red-500">*</span>
              </label>
              <select v-model="formData.targetMountId" :class="inputClass">
                <option value="">{{ $t("admin.repoBackup.form.selectMount") }}</option>
                <option v-for="m in writableMounts" :key="m.id" :value="m.id">
                  {{ m.name || m.mount_path }} ({{ m.mount_path }})
                </option>
              </select>
              <p v-if="writableMounts.length === 0" class="mt-1 text-xs text-red-600 dark:text-red-400">
                {{ $t("admin.repoBackup.form.noWritableMount") }}
              </p>
              <p v-else :class="hintClass">{{ $t("admin.repoBackup.form.targetMountHint") }}</p>
            </div>

            <div>
              <label :class="labelClass">{{ $t("admin.repoBackup.form.pathPrefix") }}</label>
              <input v-model="formData.targetPathPrefix" type="text" :class="inputClass" placeholder="/" />
              <p :class="hintClass">{{ $t("admin.repoBackup.form.pathPrefixHint") }}</p>
            </div>
          </div>
        </div>

        <!-- provider 私有配置（schema 驱动） -->
        <div v-if="configFields.length > 0" class="pt-2 border-t" :class="darkMode ? 'border-gray-700' : 'border-gray-200'">
          <h4 class="text-sm font-medium mb-3" :class="darkMode ? 'text-gray-200' : 'text-gray-800'">
            {{ $t("admin.repoBackup.form.advancedSection") }}
          </h4>

          <div class="space-y-4">
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
                <span class="text-sm" :class="darkMode ? 'text-gray-300' : 'text-gray-700'">{{ fieldDescription(field) }}</span>
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
        </div>

        <!-- 启用开关 -->
        <div class="pt-2">
          <label class="inline-flex items-center gap-2">
            <input v-model="formData.enabled" type="checkbox" class="rounded border-gray-300" />
            <span class="text-sm" :class="darkMode ? 'text-gray-300' : 'text-gray-700'">
              {{ $t("admin.repoBackup.form.enabled") }}
            </span>
          </label>
        </div>

        <!-- 底部按钮 -->
        <div class="flex justify-end gap-2 pt-4 border-t" :class="darkMode ? 'border-gray-700' : 'border-gray-200'">
          <button
            type="button"
            class="px-4 py-2 text-sm rounded-md border"
            :class="darkMode ? 'border-gray-600 text-gray-200 hover:bg-gray-700' : 'border-gray-300 text-gray-700 hover:bg-gray-100'"
            @click="emit('cancel')"
          >
            {{ $t("admin.repoBackup.buttons.cancel") }}
          </button>
          <button type="submit" class="px-4 py-2 text-sm rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50" :disabled="submitting">
            {{ submitting ? $t("admin.repoBackup.form.saving") : $t("admin.repoBackup.buttons.save") }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
