<template>
  <!-- ==================== 卡片式（variant="cards"）====================
       修改点（全局凭据恢复原样）：这是「一条一张卡片」的原始交互 ——
       备注输入框 + 启用复选框 + 值输入框（带显示/隐藏）+ 删除按钮，
       下方一个「添加一条」按钮。全局凭据弹窗使用这一套。 -->
  <div v-if="variant === 'cards'" class="space-y-2">
    <div v-for="(entry, index) in entries" :key="entry.id || index" :class="rowClass">
      <div class="flex items-center gap-2">
        <input
          :value="entry.label"
          :class="[inputClass, 'flex-1 min-w-0']"
          :placeholder="labelPlaceholder"
          @input="updateEntry(index, { label: $event.target.value })"
        />
        <label class="inline-flex items-center gap-1 shrink-0 cursor-pointer" :title="$t('admin.repoBackup.pool.enabled')">
          <input
            type="checkbox"
            class="rounded border-gray-300"
            :checked="entry.enabled !== false"
            @change="updateEntry(index, { enabled: $event.target.checked })"
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
          :type="isRevealed(entry) ? 'text' : 'password'"
          :value="entry.value"
          :class="[inputClass, 'pr-12']"
          :placeholder="valuePlaceholder"
          autocomplete="off"
          spellcheck="false"
          @input="updateEntry(index, { value: $event.target.value })"
        />
        <button
          type="button"
          class="absolute right-2 top-1/2 -translate-y-1/2 text-xs px-1.5 py-0.5 rounded"
          :class="mutedTextClass"
          @click="toggleReveal(entry)"
        >
          {{ isRevealed(entry) ? $t("admin.repoBackup.form.hide") : $t("admin.repoBackup.form.show") }}
        </button>
      </div>
    </div>

    <p v-if="entries.length === 0" :class="hintClass">{{ $t("admin.repoBackup.pool.empty") }}</p>

    <button
      type="button"
      class="text-xs px-2 py-1 rounded border"
      :class="addButtonClass"
      :disabled="atLimit"
      @click="addEmptyEntry"
    >
      {{ addLabel }}
    </button>
  </div>

  <!-- ==================== 标签式（variant="tags"）====================
       修改点（第 3 期 3-B 交互重做）：与仓库表单的「多分支」录入保持同一套交互，
       一个输入框连续录入多条，回车 / 逗号 / 失焦即确认，支持一次粘贴多个。
       仓库的 Token / 代理字段使用这一套。 -->
  <div v-else class="space-y-1">
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
 * 凭据池编辑器（修改点：第 3 期 3-B）
 *
 * 一个组件同时服务「仓库级」与「全局级」两个位置，避免两套界面逐渐跑偏。
 *
 * 修改点（交互分版式）：
 * - variant="tags"（仓库表单）：单框连续录入的标签式，与「多分支」录入一致
 * - variant="cards"（全局凭据，默认）：一条一张卡片，备注 / 启用 / 值 / 删除
 * 两种版式共用同一套数据与安全逻辑（掩码、按 id 取明文、按 id 增删改），
 * 只有模板与录入方式不同。
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
  /**
   * 版式：'cards'（一条一张卡片，全局凭据用）| 'tags'（单框连续录入，仓库表单用）
   * 默认 cards —— 全局凭据弹窗不传该属性时保持它原有的样子
   */
  variant: { type: String, default: "cards" },
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
const valuePlaceholder = computed(() => t(props.field?.ui?.valuePlaceholderKey || "admin.repoBackup.pool.valuePlaceholder"));
const labelPlaceholder = computed(() => t(props.field?.ui?.entryLabelKey || "admin.repoBackup.pool.entryLabel"));
const addLabel = computed(() => t(props.field?.ui?.addLabelKey || "admin.repoBackup.pool.add"));
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

/** 按数组下标改一条（卡片式输入框绑定用，与 patchById 等价但更直接） */
function updateEntry(index, patch) {
  emitEntries(entries.value.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
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
 * 切换一条的明文显示
 *
 * - 卡片式：控制值输入框在 password / text 之间切换（明文直接写回条目，
 *   与改造前的原始交互一致）
 * - 标签式：控制 chip 上显示掩码还是明文
 *
 * 本会话内输入或已经取回过明文的条目，本地切换即可；其余（后端下发的掩码）
 * 需要向父组件要明文；失败时保持掩码，避免给用户一个空条目。
 */
async function toggleReveal(entry) {
  const id = entry?.id;
  if (!id) return;

  if (revealed[id]) {
    revealed[id] = false;
    return;
  }

  const raw = String(entry.value || "");
  // 空条目没有可展开的内容，直接放行（卡片式下就是让空输入框可见）
  if (!raw) {
    revealed[id] = true;
    return;
  }

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

/** 卡片式：新增一条空行，由用户自己填备注与值 */
function addEmptyEntry() {
  if (atLimit.value) return;
  const entry = { id: makeTempId(), label: "", value: "", enabled: true };
  // 空行必然是明文（用户马上要输入），先把显示状态打开，免得输入内容被密码框遮住
  localPlain[entry.id] = true;
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

const addButtonClass = computed(() =>
  props.darkMode
    ? "border-gray-600 text-gray-300 hover:bg-gray-700 disabled:opacity-50"
    : "border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50",
);

const dangerButtonClass = computed(() =>
  props.darkMode ? "text-red-400 hover:text-red-300 hover:bg-gray-700" : "text-red-500 hover:text-red-600 hover:bg-gray-100",
);

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
