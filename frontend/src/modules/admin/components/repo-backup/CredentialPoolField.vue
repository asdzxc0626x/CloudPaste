<template>
  <div class="space-y-1">
    <!-- 单框多值：与仓库表单的「多分支」录入保持同一套交互（修改点：第 3 期 3-B 交互重做）
         一个输入框连续录入多条，回车 / 逗号 / 失焦即确认，支持一次粘贴多个 -->
    <div :class="boxClass" @click.self="focusInput">
      <span
        v-for="(entry, index) in entries"
        :key="entry.id || index"
        :class="[chipClass, entry.enabled === false ? chipDisabledClass : '']"
      >
        <!-- 启用 / 禁用：左侧圆点，点一下切换，不额外占用一行 -->
        <button
          type="button"
          class="shrink-0 w-2 h-2 rounded-full focus:outline-none"
          :class="entry.enabled === false ? dotOffClass : dotOnClass"
          :title="entry.enabled === false ? $t('admin.repoBackup.pool.clickToEnable') : $t('admin.repoBackup.pool.clickToDisable')"
          @click="toggleEnabled(index)"
        ></button>

        <!-- 值：默认只显示掩码，点击才展开明文；展开后允许换行以便核对 / 复制 -->
        <button
          type="button"
          class="font-mono focus:outline-none"
          :class="isRevealed(entry) ? 'text-left break-all whitespace-normal' : 'max-w-[9rem] truncate'"
          :title="isRevealed(entry) ? $t('admin.repoBackup.pool.hideTitle') : $t('admin.repoBackup.pool.revealTitle')"
          @click="toggleReveal(entry)"
        >
          {{ displayValue(entry) }}
        </button>

        <button
          type="button"
          class="shrink-0 leading-none text-sm text-gray-400 hover:text-red-500 focus:outline-none"
          :title="$t('admin.repoBackup.pool.removeTitle')"
          @click="removeEntry(index)"
        >
          ×
        </button>
      </span>

      <input
        ref="inputRef"
        v-model="draft"
        type="text"
        class="flex-1 min-w-[8rem] bg-transparent border-0 p-0 text-sm focus:ring-0 focus:outline-none"
        :class="darkMode ? 'text-white placeholder-gray-500' : 'text-gray-900 placeholder-gray-400'"
        :placeholder="placeholder"
        :disabled="atLimit"
        autocomplete="off"
        spellcheck="false"
        @keydown="onKeydown"
        @blur="commitDraft"
      />
    </div>

    <p :class="hintClass">{{ hintText }}</p>
  </div>
</template>

<script setup>
/**
 * 凭据池编辑器（修改点：第 3 期 3-B，交互按「多分支」录入重做）
 *
 * 一个组件同时服务「仓库级」与「全局级」两个位置，避免两套界面逐渐跑偏。
 *
 * 交互（与 RepoBackupForm 的分支录入一致）：
 * - 一个输入框连续添加多条，回车 / 逗号 / 失焦即确认，也支持一次粘贴多个
 * - 每条渲染成一个 chip：左侧圆点=启用/禁用，中间值=点击查看或隐藏明文，右侧 ×=删除
 *
 * 安全约定：
 * - 界面上默认只显示掩码（形如 ****abcd），明文只在用户点击条目时才出现在页面上
 * - 本会话内用户自己输入的条目本来就是明文，直接展开即可；已有值的条目拿到的是掩码，
 *   必须通过父组件传入的 reveal() 向后端显式请求明文
 * - 提交时若用户没点开过，回传的仍是掩码串，后端会识别并保留原值
 */
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";

const props = defineProps({
  /** 条目数组：[{ id, label, value, enabled }] */
  modelValue: { type: Array, default: () => [] },
  /** configSchema 里的字段定义（提供 i18n key 与占位符） */
  field: { type: Object, default: () => ({}) },
  /** 暗色模式 */
  darkMode: { type: Boolean, default: false },
  /**
   * 可选的「取回明文」回调：async () => Array<{id, value}>
   * 不传时只能展开本会话内用户自己输入的条目（已落库的掩码值无法还原）
   */
  reveal: { type: Function, default: null },
});

const emit = defineEmits(["update:modelValue"]);

const { t } = useI18n();

/** 与后端 credentials.js 的 MAX_POOL_ENTRIES 保持一致 */
const MAX_ENTRIES = 20;

const inputRef = ref(null);
const draft = ref("");

/**
 * 三条按条目 id 记录的状态
 * 用 id 而不是数组下标做键：删除中间一条后下标会整体前移，
 * 用下标会让「明文已展开」的状态错落到别的条目上
 */
/** 本会话内由用户直接输入的明文条目（这些值不需要向后端取明文） */
const localPlain = reactive({});
/** 明文已展开的条目 */
const revealed = reactive({});
/** 正在向后端取明文的条目，防止重复点击 */
const revealing = reactive({});

const entries = computed(() => (Array.isArray(props.modelValue) ? props.modelValue : []));
const atLimit = computed(() => entries.value.length >= MAX_ENTRIES);

const placeholder = computed(() => t(props.field?.ui?.valuePlaceholderKey || "admin.repoBackup.pool.valuePlaceholder"));
const hintText = computed(() =>
  atLimit.value ? t("admin.repoBackup.pool.limitReached", { max: MAX_ENTRIES }) : t("admin.repoBackup.pool.inputHint"),
);

/** 生成一个仅用于前端 v-for / 状态定位的临时 id（后端保存时会替换成正式 id） */
function makeTempId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `new_${crypto.randomUUID()}`;
  }
  return `new_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function emitEntries(next) {
  emit("update:modelValue", next);
}

/** 掩码规则与后端 utils/crypto.js 的 maskSecret 完全一致（保留末 4 位） */
function maskLocal(value) {
  const text = String(value ?? "");
  if (!text) return "";
  // 后端下发的本来就是掩码，再掩一次会看不出原样
  if (text.startsWith("*")) return text;
  if (text.length <= 4) return "*".repeat(text.length);
  return "*".repeat(text.length - 4) + text.slice(-4);
}

const isRevealed = (entry) => Boolean(entry?.id && revealed[entry.id]);

function displayValue(entry) {
  const raw = String(entry?.value || "");
  if (!raw) return t("admin.repoBackup.pool.emptyValue");
  return isRevealed(entry) ? raw : maskLocal(raw);
}

/** 按 id 打补丁：await 之后数组可能已经变了，用下标会改错条目 */
function patchById(id, patch) {
  emitEntries(entries.value.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
}

function toggleEnabled(index) {
  const next = entries.value.map((item, i) => (i === index ? { ...item, enabled: item.enabled === false } : item));
  emitEntries(next);
}

function removeEntry(index) {
  const target = entries.value[index];
  if (target?.id) {
    delete revealed[target.id];
    delete localPlain[target.id];
    delete revealing[target.id];
  }
  emitEntries(entries.value.filter((_, i) => i !== index));
}

/**
 * 点击值：在明文与掩码之间切换
 * - 本会话内输入或已经取回过明文的条目，本地切换即可
 * - 其余（后端下发的掩码）需要向父组件要明文；失败时保持掩码，
 *   避免给用户一个空条目
 */
async function toggleReveal(entry) {
  const id = entry?.id;
  if (!id) return;

  if (revealed[id]) {
    revealed[id] = false;
    return;
  }

  const raw = String(entry.value || "");
  if (!raw) return;

  if (localPlain[id] || !raw.startsWith("*")) {
    revealed[id] = true;
    return;
  }

  if (!props.reveal || revealing[id]) return;

  revealing[id] = true;
  try {
    const plainEntries = (await props.reveal()) || [];
    const matched = plainEntries.find((item) => item.id === id);
    if (matched && typeof matched.value === "string" && matched.value !== "") {
      patchById(id, { value: matched.value });
      localPlain[id] = true;
      revealed[id] = true;
    }
  } catch {
    // 取明文失败（网络 / 权限）时不展开，保持掩码
  } finally {
    revealing[id] = false;
  }
}

/** 追加一条（去重、忽略空值、受上限约束） */
function addEntry(raw) {
  const text = String(raw ?? "").trim();
  if (!text || atLimit.value) return;
  // 已有的掩码条目无法比较明文，这里只拦完全相同的值（含重复粘贴）
  if (entries.value.some((entry) => String(entry.value || "") === text)) return;

  const entry = { id: makeTempId(), label: "", value: text, enabled: true };
  localPlain[entry.id] = true;
  // 刚录入的先展开，方便用户当场核对；点击即可收起
  revealed[entry.id] = true;
  emitEntries([...entries.value, entry]);
}

/** 输入框回车 / 逗号 / 失焦时提交草稿，支持一次粘贴多个 */
function commitDraft() {
  const raw = draft.value;
  if (!raw) return;
  draft.value = "";
  // 与分支录入一致：空格、逗号（中英文）、换行都视为分隔符
  raw
    .split(/[,，\s]+/)
    .map((text) => text.trim())
    .filter(Boolean)
    .forEach(addEntry);
}

function onKeydown(event) {
  if (event.key === "Enter" || event.key === "," || event.key === "，") {
    // 阻止回车触发表单提交
    event.preventDefault();
    commitDraft();
  }
}

function focusInput() {
  inputRef.value?.focus();
}

// ==================== 样式（与 RepoBackupForm 的分支录入保持一致）====================

const boxClass = computed(() =>
  props.darkMode
    ? "flex flex-wrap items-center gap-1.5 min-h-[34px] px-2 py-1 rounded-md border bg-gray-800 border-gray-600 focus-within:ring-2 focus-within:ring-blue-500"
    : "flex flex-wrap items-center gap-1.5 min-h-[34px] px-2 py-1 rounded-md border bg-white border-gray-300 focus-within:ring-2 focus-within:ring-blue-500",
);

const chipClass = computed(() =>
  props.darkMode
    ? "inline-flex items-center gap-1 max-w-full px-2 py-0.5 text-xs rounded bg-gray-700 text-gray-200"
    : "inline-flex items-center gap-1 max-w-full px-2 py-0.5 text-xs rounded bg-gray-100 text-gray-700",
);

/** 已禁用：整条压暗，语义由左侧圆点与提示承担 */
const chipDisabledClass = "opacity-50";

const dotOnClass = "bg-green-500 hover:bg-green-400";
const dotOffClass = computed(() => (props.darkMode ? "bg-gray-500 hover:bg-gray-400" : "bg-gray-400 hover:bg-gray-500"));

const hintClass = computed(() => (props.darkMode ? "text-[11px] leading-4 text-gray-500" : "text-[11px] leading-4 text-gray-400"));
</script>
