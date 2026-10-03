<template>
  <div class="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/50" @click.self="emit('close')">
    <div
      class="w-full sm:max-w-3xl flex flex-col rounded-t-xl sm:rounded-lg shadow-xl overflow-hidden max-h-[92vh] sm:max-h-[88vh]"
      :class="darkMode ? 'bg-gray-900' : 'bg-white'"
    >
      <!-- 头部 -->
      <div class="flex items-start justify-between gap-3 px-4 py-3 border-b" :class="darkMode ? 'border-gray-700' : 'border-gray-200'">
        <div class="min-w-0">
          <h3 class="text-base font-medium" :class="darkMode ? 'text-white' : 'text-gray-900'">
            {{ $t("admin.repoBackup.pool.globalTitle") }}
          </h3>
          <p class="mt-0.5 text-xs" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
            {{ $t("admin.repoBackup.pool.globalSubtitle") }}
          </p>
        </div>
        <button
          type="button"
          class="shrink-0 p-1 rounded"
          :class="darkMode ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-700'"
          @click="emit('close')"
        >
          <IconClose class="h-5 w-5" />
        </button>
      </div>

      <!-- 正文：修改点（限制弹窗高度）——补上 min-h-0。
           卡片本身已有 max-h-[88vh]，但 flex 子项默认 min-height:auto，
           不加 min-h-0 时它的最小高度被内容撑住，凭据一多就把卡片顶出 max-h、
           底部「保存」被推出视口。与 RepoBackupForm / RepoBackupHistory 的正文写法保持一致。 -->
      <div class="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
        <div v-if="loadError" class="px-3 py-2 rounded text-sm break-words bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">
          {{ loadError }}
        </div>

        <div v-if="loading" class="text-sm py-6 text-center" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
          {{ $t("admin.repoBackup.pool.loading") }}
        </div>

        <!-- 修改点（全局凭据分组可折叠）：Token / 代理各自成组，默认折叠。
             单组最多 20 条（后端 MAX_POOL_ENTRIES），一屏铺开几十张卡片既难定位，
             也会把「保存」按钮顶到很下面，所以折叠态只留一行标题 + 条数角标。
             正文用 v-show 而非 v-if：子组件内部按条目 id 记着「哪些条目已展开明文」，
             卸载再挂载会把这些状态清空，用户刚输入的 Token 会在收起/展开后变回掩码。 -->
        <template v-else>
          <section :class="cardClass">
            <button
              type="button"
              class="w-full flex items-start gap-2 text-left"
              :title="$t(collapsed.tokens ? 'admin.repoBackup.pool.expandSection' : 'admin.repoBackup.pool.collapseSection')"
              :aria-expanded="!collapsed.tokens"
              @click="toggleSection('tokens')"
            >
              <IconChevronRight
                class="mt-0.5 h-4 w-4 shrink-0 transition-transform duration-200"
                :class="collapsed.tokens ? '' : 'rotate-90'"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1">
                <span :class="sectionTitleClass">{{ $t("admin.repoBackup.fields.github.tokens") }}</span>
                <span :class="countBadgeClass">{{ $t("admin.repoBackup.pool.entryCount", { count: pool.tokens.length }) }}</span>
              </span>
            </button>

            <div v-show="!collapsed.tokens" class="space-y-2.5">
              <p :class="bodyHintClass">{{ $t("admin.repoBackup.description.github.tokens") }}</p>
              <CredentialPoolField
                v-model="pool.tokens"
                :field="tokenField"
                :dark-mode="darkMode"
                variant="cards"
                :reveal="revealAll"
              />
            </div>
          </section>

          <section :class="cardClass">
            <button
              type="button"
              class="w-full flex items-start gap-2 text-left"
              :title="$t(collapsed.proxies ? 'admin.repoBackup.pool.expandSection' : 'admin.repoBackup.pool.collapseSection')"
              :aria-expanded="!collapsed.proxies"
              @click="toggleSection('proxies')"
            >
              <IconChevronRight
                class="mt-0.5 h-4 w-4 shrink-0 transition-transform duration-200"
                :class="collapsed.proxies ? '' : 'rotate-90'"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1">
                <span :class="sectionTitleClass">{{ $t("admin.repoBackup.fields.github.proxies") }}</span>
                <span :class="countBadgeClass">{{ $t("admin.repoBackup.pool.entryCount", { count: pool.proxies.length }) }}</span>
              </span>
            </button>

            <div v-show="!collapsed.proxies" class="space-y-2.5">
              <p :class="bodyHintClass">{{ $t("admin.repoBackup.description.github.proxies") }}</p>
              <CredentialPoolField
                v-model="pool.proxies"
                :field="proxyField"
                :dark-mode="darkMode"
                variant="cards"
                :reveal="revealAll"
              />
            </div>
          </section>

          <p :class="hintClass">{{ $t("admin.repoBackup.pool.priorityHint") }}</p>
        </template>
      </div>

      <!-- 底部 -->
      <div class="px-4 py-3 border-t flex items-center justify-end gap-2" :class="darkMode ? 'border-gray-700' : 'border-gray-200'">
        <button
          type="button"
          class="px-3 py-1.5 text-sm rounded-md border"
          :class="darkMode ? 'border-gray-600 text-gray-300 hover:bg-gray-700' : 'border-gray-300 text-gray-700 hover:bg-gray-50'"
          @click="emit('close')"
        >
          {{ $t("admin.repoBackup.pool.cancel") }}
        </button>
        <button
          type="button"
          class="px-3 py-1.5 text-sm rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
          :disabled="saving || loading"
          @click="save"
        >
          {{ saving ? $t("admin.repoBackup.pool.saving") : $t("admin.repoBackup.pool.save") }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * 全局 GitHub 凭据池弹窗（修改点：第 3 期 3-B）
 *
 * 与仓库表单里的「仓库级池」共用同一个 CredentialPoolField 组件，
 * 区别只在于读写的是 system_settings 里的全局池、而不是某个仓库的 config_json。
 */
import { computed, onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { IconChevronRight, IconClose } from "@/components/icons";
import CredentialPoolField from "./CredentialPoolField.vue";
import { getGlobalCredentials, saveGlobalCredentials } from "@/api/services/repoBackupService";

const props = defineProps({
  darkMode: { type: Boolean, default: false },
});

const emit = defineEmits(["close", "saved"]);

const { t } = useI18n();

const loading = ref(true);
const saving = ref(false);
const loadError = ref("");

const pool = reactive({ tokens: [], proxies: [] });

/**
 * 修改点（全局凭据分组可折叠）：Token / 代理两个分组的折叠状态
 *
 * 默认折叠 —— 凭据列表可能很长，弹窗一打开就铺满卡片会盖住「保存」按钮。
 * 首次加载完成后会按「该分组是否已有条目」再定一次：空分组没什么可折叠的，
 * 直接展开省掉一次多余点击；但用户手动点过之后就不再自动改动（collapsedTouched），
 * 免得用户刚展开又被数据刷新折叠回去。
 */
const collapsed = reactive({ tokens: true, proxies: true });
const collapsedTouched = reactive({ tokens: false, proxies: false });

function toggleSection(key) {
  collapsed[key] = !collapsed[key];
  collapsedTouched[key] = true;
}

/** 只在用户没有手动切换过时生效，避免与用户操作打架 */
function initCollapsed(key, list) {
  if (collapsedTouched[key]) return;
  collapsed[key] = normalize(list).length > 0;
}

/**
 * 复用 configSchema 里的文案 key，避免全局/仓库两处各写一套翻译
 * 修改点（全局凭据恢复原样）：全局弹窗用卡片式（默认 variant），
 * 每条有「备注 + 启用 + 值 + 删除」，因此这里还要给出备注占位与新增按钮文案，
 * 且 Token / 代理各有各的措辞。
 */
const tokenField = {
  ui: {
    valuePlaceholderKey: "admin.repoBackup.pool.tokenPlaceholder",
    entryLabelKey: "admin.repoBackup.pool.tokenEntry",
    addLabelKey: "admin.repoBackup.pool.addToken",
  },
};
const proxyField = {
  ui: {
    valuePlaceholderKey: "admin.repoBackup.pool.proxyPlaceholder",
    entryLabelKey: "admin.repoBackup.pool.proxyEntry",
    addLabelKey: "admin.repoBackup.pool.addProxy",
  },
};

const normalize = (value) => (Array.isArray(value) ? value : []);

async function load() {
  loading.value = true;
  loadError.value = "";
  try {
    const resp = await getGlobalCredentials();
    pool.tokens = normalize(resp?.data?.tokens);
    pool.proxies = normalize(resp?.data?.proxies);
    // 修改点（全局凭据分组可折叠）：拿到数据后再定初始折叠状态——
    // 已有条目的分组折叠，空分组展开（空分组没有可折叠的内容，展开省一次点击）
    initCollapsed("tokens", pool.tokens);
    initCollapsed("proxies", pool.proxies);
  } catch (e) {
    loadError.value = e?.message || t("admin.repoBackup.pool.loadFailed");
  } finally {
    loading.value = false;
  }
}

/** 点「显示」时才去后端取明文；返回整个池，子组件按 id 自行取用 */
async function revealAll() {
  const resp = await getGlobalCredentials({ reveal: "plain" });
  return [...normalize(resp?.data?.tokens), ...normalize(resp?.data?.proxies)];
}

async function save() {
  saving.value = true;
  loadError.value = "";
  try {
    const resp = await saveGlobalCredentials({ tokens: pool.tokens, proxies: pool.proxies });
    pool.tokens = normalize(resp?.data?.tokens);
    pool.proxies = normalize(resp?.data?.proxies);
    emit("saved", resp?.message || "");
  } catch (e) {
    loadError.value = e?.message || t("admin.repoBackup.pool.saveFailed");
  } finally {
    saving.value = false;
  }
}

onMounted(load);

// ==================== 样式 ====================

const cardClass = computed(() =>
  props.darkMode ? "rounded-lg border border-gray-700 bg-gray-800/30 p-3 space-y-2.5" : "rounded-lg border border-gray-200 bg-gray-50/60 p-3 space-y-2.5",
);
const sectionTitleClass = computed(() =>
  props.darkMode ? "text-xs font-semibold text-gray-300 uppercase tracking-wide" : "text-xs font-semibold text-gray-500 uppercase tracking-wide",
);
const hintClass = computed(() => (props.darkMode ? "mt-1 text-[11px] leading-4 text-gray-500" : "mt-1 text-[11px] leading-4 text-gray-400"));

/** 修改点（全局凭据分组可折叠）：说明文字被收进折叠正文区，不再紧跟标题，去掉原本的 mt-1 */
const bodyHintClass = computed(() => (props.darkMode ? "text-[11px] leading-4 text-gray-500" : "text-[11px] leading-4 text-gray-400"));

/** 修改点（全局凭据分组可折叠）：折叠态标题右侧的条数角标，收起后也能看出分组里有多少条 */
const countBadgeClass = computed(() =>
  props.darkMode
    ? "ml-1.5 inline-block align-middle text-[11px] px-1.5 py-0.5 rounded-full bg-gray-700 text-gray-300"
    : "ml-1.5 inline-block align-middle text-[11px] px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-600",
);
</script>
