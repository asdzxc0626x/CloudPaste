<template>
  <div class="space-y-2">
    <div v-for="(entry, index) in entries" :key="entry.id || index" :class="rowClass">
      <div class="flex items-center gap-2">
        <input
          :value="entry.label"
          :class="[inputClass, 'flex-1 min-w-0']"
          :placeholder="labelPlaceholder"
          @input="update(index, { label: $event.target.value })"
        />
        <label class="inline-flex items-center gap-1 shrink-0 cursor-pointer" :title="$t('admin.repoBackup.pool.enabled')">
          <input
            type="checkbox"
            class="rounded border-gray-300"
            :checked="entry.enabled !== false"
            @change="update(index, { enabled: $event.target.checked })"
          />
          <span class="text-[11px]" :class="mutedTextClass">{{ $t("admin.repoBackup.pool.enabled") }}</span>
        </label>
        <button
          type="button"
          class="shrink-0 text-xs px-2 py-1 rounded"
          :class="dangerButtonClass"
          :title="$t('admin.repoBackup.pool.remove')"
          @click="removeEntry(index)"
        >
          {{ $t("admin.repoBackup.pool.remove") }}
        </button>
      </div>

      <div class="relative mt-1.5">
        <input
          :type="isVisible(entry) ? 'text' : 'password'"
          :value="entry.value"
          :class="[inputClass, 'pr-12']"
          :placeholder="valuePlaceholder"
          autocomplete="off"
          spellcheck="false"
          @input="update(index, { value: $event.target.value })"
        />
        <button
          type="button"
          class="absolute right-2 top-1/2 -translate-y-1/2 text-xs px-1.5 py-0.5 rounded"
          :class="mutedTextClass"
          @click="toggleVisible(index, entry)"
        >
          {{ isVisible(entry) ? $t("admin.repoBackup.form.hide") : $t("admin.repoBackup.form.show") }}
        </button>
      </div>
    </div>

    <p v-if="entries.length === 0" :class="hintClass">{{ $t("admin.repoBackup.pool.empty") }}</p>

    <button
      type="button"
      class="text-xs px-2 py-1 rounded border"
      :class="addButtonClass"
      :disabled="entries.length >= maxEntries"
      @click="addEntry"
    >
      {{ $t(addLabelKey) }}
    </button>
  </div>
</template>

<script setup>
/**
 * 凭据池编辑器（修改点：第 3 期 3-B）
 *
 * 一个组件同时服务「仓库级」与「全局级」两个位置，避免两套界面逐渐跑偏。
 *
 * 安全约定：
 * - 界面上默认只显示掩码（形如 ****abcd），明文只在用户点击「显示」时才出现在输入框里
 * - 「显示」分两种情况：本会话新填的条目本来就是明文，直接切换输入框类型即可；
 *   已有值的条目拿到的是掩码，必须通过父组件传入的 reveal() 向后端显式请求明文
 * - 提交时若用户没点过「显示」，回传的仍是掩码串，后端会识别并保留原值
 */
import { reactive, computed } from "vue";
import { useI18n } from "vue-i18n";

const props = defineProps({
  /** 条目数组：[{ id, label, value, enabled, hasValue }] */
  modelValue: { type: Array, default: () => [] },
  /** configSchema 里的字段定义（提供 i18n key 与上限） */
  field: { type: Object, default: () => ({}) },
  /** 关闭时输入的暗色模式 */
  darkMode: { type: Boolean, default: false },
  /**
   * 可选的「取回明文」回调：async () => Array<{id, value}>
   * 不传时「显示」只能切换输入框类型（适用于刚填写、还没有存过值的条目）
   */
  reveal: { type: Function, default: null },
});

const emit = defineEmits(["update:modelValue"]);

const { t } = useI18n();

/** 与后端 credentials.js 的 MAX_POOL_ENTRIES 保持一致 */
const maxEntries = 20;

/**
 * 每行的明文可见状态
 * 用条目 id 做键而不是数组下标：删除中间一行后下标会整体前移，
 * 用下标会让「显示」状态错落到别的条目上
 */
const visible = reactive({});

const isVisible = (entry) => Boolean(visible[entry?.id]);

const entries = computed(() => (Array.isArray(props.modelValue) ? props.modelValue : []));

const addLabelKey = computed(() => props.field?.ui?.addLabelKey || "admin.repoBackup.pool.add");
const labelPlaceholder = computed(() => t(props.field?.ui?.entryLabelKey || "admin.repoBackup.pool.entryLabel"));
const valuePlaceholder = computed(() => t(props.field?.ui?.valuePlaceholderKey || "admin.repoBackup.pool.valuePlaceholder"));

/** 生成一个仅用于前端 v-for / 编辑定位的临时 id（后端保存时会替换成正式 id） */
function makeTempId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `new_${crypto.randomUUID()}`;
  }
  return `new_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function emitEntries(next) {
  emit("update:modelValue", next);
}

function update(index, patch) {
  const next = entries.value.map((entry, i) => (i === index ? { ...entry, ...patch } : entry));
  emitEntries(next);
}

function addEntry() {
  if (entries.value.length >= maxEntries) return;
  emitEntries([...entries.value, { id: makeTempId(), label: "", value: "", enabled: true, hasValue: false }]);
}

function removeEntry(index) {
  emitEntries(entries.value.filter((_, i) => i !== index));
}

/**
 * 切换某一行的明文可见
 * - 值本身是明文（用户刚输入的）时只切输入框类型
 * - 值是掩码且条目本来就有值时才去后端取明文，且每行只取一次
 */
async function toggleVisible(index, entry) {
  const key = entry?.id;
  if (!key) return;

  if (visible[key]) {
    visible[key] = false;
    return;
  }

  const value = String(entry.value || "");
  const isMasked = value.startsWith("*");

  if (isMasked && props.reveal) {
    try {
      const plainEntries = (await props.reveal()) || [];
      const matched = plainEntries.find((item) => item.id === entry.id);
      if (matched && typeof matched.value === "string") {
        update(index, { value: matched.value });
      }
    } catch {
      // 取明文失败（网络 / 权限）时不展开，保持掩码，避免给用户一个空输入框
      return;
    }
  }

  visible[key] = true;
}

// ==================== 样式（与 RepoBackupForm 保持一致）====================

const inputClass = computed(() =>
  props.darkMode
    ? "w-full px-2.5 py-1.5 text-sm rounded-md border bg-gray-800 border-gray-600 text-white placeholder-gray-500 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
    : "w-full px-2.5 py-1.5 text-sm rounded-md border bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500",
);

const rowClass = computed(() =>
  props.darkMode ? "rounded-md border border-gray-700 bg-gray-900/40 p-2" : "rounded-md border border-gray-200 bg-white p-2",
);

const mutedTextClass = computed(() => (props.darkMode ? "text-gray-400 hover:text-gray-200" : "text-gray-500 hover:text-gray-700"));

const hintClass = computed(() => (props.darkMode ? "text-[11px] leading-4 text-gray-500" : "text-[11px] leading-4 text-gray-400"));

const addButtonClass = computed(() =>
  props.darkMode
    ? "border-gray-600 text-gray-300 hover:bg-gray-700 disabled:opacity-50"
    : "border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50",
);

const dangerButtonClass = computed(() =>
  props.darkMode ? "text-red-400 hover:text-red-300 hover:bg-gray-700" : "text-red-500 hover:text-red-600 hover:bg-gray-100",
);
</script>
