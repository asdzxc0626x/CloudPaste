<script setup>
/**
 * 备份历史抽屉（修改点：新增功能）
 * - 列出某仓库的历史备份记录
 * - 支持下载快照与 manifest
 *
 * 优化点（多备份目标 / 响应式）：
 * - 每条记录列出各备份目标的落盘结果（成功/失败），下载按钮按目标给出
 * - 手机端抽屉占满宽度、记录卡改单列堆叠，不产生横向滚动
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { IconClose, IconDownload, IconRefresh } from "@/components/icons";
// 修改点（站点时区一期）：改用统一的 timeUtils。
// 原来的 new Date(value).toLocaleString() 会把后端下发的
// "2026-01-23 08:12:07"（UTC 无时区标记）当成浏览器本地时间解析，导致时间偏移。
import { formatDateTime } from "@/utils/timeUtils.js";

const props = defineProps({
  repo: { type: Object, default: null },
  items: { type: Array, default: () => [] },
  total: { type: Number, default: 0 },
  paging: { type: Object, required: true },
  loading: { type: Boolean, default: false },
  darkMode: { type: Boolean, default: false },
  /** 当前选中的状态筛选（空数组 = 全部）（修改点：历史记录需显示失败记录） */
  statuses: { type: Array, default: () => [] },
  /** 各状态的记录条数，用于在筛选器上显示数量 */
  statusCounts: { type: Object, default: () => ({}) },
});

const emit = defineEmits(["close", "refresh", "page-change", "download", "status-change"]);

// script 里要取 i18n 文案（结果徽章需要按 outcome 回退取值，模板的 $t 做不到回退）
const { t } = useI18n();

const hasPrev = computed(() => props.paging.offset > 0);
const hasNext = computed(() => props.paging.offset + props.paging.limit < props.total);

/**
 * 状态筛选项（修改点：历史记录需显示失败记录）
 * - 「全部」对应空数组；「成功」把 success 与 partial 合并，
 *   因为 partial 也是有可用快照的，用户视角里都算备份成功
 */
const STATUS_FILTERS = [
  { key: "all", statuses: [] },
  { key: "success", statuses: ["success", "partial"] },
  { key: "failed", statuses: ["failed"] },
  { key: "running", statuses: ["running"] },
  { key: "skipped", statuses: ["skipped"] },
  // 修改点（状态显示不一致修复）：延迟重试单独一档。
  // 它既不是成功也不是失败，混进任何一档都会让用户看到错误结论。
  { key: "deferred", statuses: ["deferred"] },
];

/** 当前选中的筛选项 key */
const activeFilter = computed(() => {
  const current = [...(props.statuses || [])].sort().join(",");
  if (!current) return "all";
  const matched = STATUS_FILTERS.find((item) => [...item.statuses].sort().join(",") === current);
  return matched ? matched.key : "all";
});

/** 某个筛选项下有多少条记录（全部 = 各状态求和） */
const filterCount = (filter) => {
  const counts = props.statusCounts || {};
  if (filter.statuses.length === 0) {
    return Object.values(counts).reduce((sum, n) => sum + (Number(n) || 0), 0);
  }
  return filter.statuses.reduce((sum, status) => sum + (Number(counts[status]) || 0), 0);
};

const filterBtnClass = (filter) => {
  const active = activeFilter.value === filter.key;
  if (active) {
    return props.darkMode ? "bg-blue-600 text-white border-blue-600" : "bg-blue-600 text-white border-blue-600";
  }
  return props.darkMode
    ? "border-gray-600 text-gray-300 hover:bg-gray-700"
    : "border-gray-300 text-gray-600 hover:bg-gray-100";
};

/**
 * 目标结果圆点（修改点：状态显示不一致修复）
 * 原先只判断「是不是 success」，其余一律画红 —— 于是「本次跳过」「已延迟重试」
 * 这些非失败的目标也被涂成红色，和「写入失败」看起来一模一样。
 */
const targetDotClass = (status) => {
  switch (status) {
    case "success":
      return "bg-green-500";
    case "failed":
      return "bg-red-500";
    case "deferred":
      return "bg-amber-500";
    default:
      return "bg-gray-400";
  }
};

/**
 * error_message 的展示颜色（修改点：状态显示不一致修复）
 * 它既可能是失败原因，也可能是「已安排在 X 自动重试」或 partial 的告警，
 * 所以按结果色调上色，不再除了 partial 之外一律红字。
 */
const messageClass = (item) => {
  const tone = itemTone(item);
  if (tone === "error") return "text-red-600 dark:text-red-400";
  if (tone === "warn") return "text-amber-600 dark:text-amber-400";
  return "text-gray-500 dark:text-gray-400";
};

// ==================== 结果口径（修改点：旧失败记录压住新结论）====================

/**
 * 记录徽章按 outcome 渲染，不按 status。
 *
 * 旧版本把限流写成 status='failed'，仓库管理页已按语义判成「延迟重试」；
 * 历史若仍按 status 显示红色「失败」，两个页面就又对同一条记录给出不同结论。
 * outcome / outcomeTone 由后端 repobackup/status.js 统一推导，前端只显示。
 *
 * 注意筛选器仍按 status 分档（它筛的是落库值，计数也来自数据库聚合），
 * 因此「失败」档里可能出现一条标着「已延迟重试」的旧记录 —— 这是如实呈现：
 * 落库是 failed，真实语义是限流延迟。
 */
const itemOutcome = (item) => item?.outcome || item?.status || "pending";

const itemTone = (item) => {
  if (item?.outcomeTone) return item.outcomeTone;
  // 老接口回退：按 status 推一次色调
  switch (item?.status) {
    case "success":
      return "ok";
    case "running":
      return "info";
    case "partial":
    case "deferred":
      return "warn";
    case "failed":
      return "error";
    default:
      return "muted";
  }
};

const toneBadgeClass = (tone) => {
  switch (tone) {
    case "ok":
      return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300";
    case "info":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";
    case "warn":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
    case "error":
      return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
    default:
      return "bg-gray-100 text-gray-700 dark:bg-gray-700/60 dark:text-gray-300";
  }
};

const itemBadgeClass = (item) => toneBadgeClass(itemTone(item));

const itemLabel = (item) => {
  const outcome = itemOutcome(item);
  const key = `admin.repoBackup.outcome.${outcome}`;
  const text = t(key);
  if (text !== key) return text;
  const fallbackKey = `admin.repoBackup.backupStatus.${item?.status}`;
  const fallback = t(fallbackKey);
  return fallback === fallbackKey ? outcome : fallback;
};

const formatTime = (value) => {
  if (!value) return "-";
  const text = formatDateTime(value);
  // timeUtils 解析失败时会返回「日期无效 / Invalid Date」，这类值统一显示为 "-"
  return text === "日期无效" || text === "Invalid Date" ? "-" : text;
};

const formatSize = (bytes) => {
  if (bytes == null || !Number.isFinite(Number(bytes))) return "-";
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(2)} ${units[i]}`;
};

/** 某条备份是否可下载（success / partial 都至少有一个目标写成功） */
const canDownload = (item) => item.status === "success" || item.status === "partial";

/** 成功的目标副本（用于逐个下载） */
const successTargets = (item) => (Array.isArray(item.targets) ? item.targets.filter((t) => t.status === "success") : []);

/** 存在多目标时，展示每个目标各自的落盘结果 */
const showTargetList = (item) => Array.isArray(item.targets) && item.targets.length > 0;
</script>

<template>
  <!--
    修改点（弹窗顶部被控制栏遮挡）：必须 Teleport 到 body。
    AdminLayout 的 main 容器是 `md:fixed z-40`，本身构成层叠上下文，
    写在它内部的 z-50 只是「40 层内的 50」，整体低于 App.vue 的站点头部
    （sticky top-0 z-50），抽屉的标题栏会被头部压住。
  -->
  <Teleport to="body">
    <div class="fixed inset-0 z-[60] flex justify-end bg-black/50" @click.self="emit('close')">
    <div class="w-full sm:max-w-2xl h-full flex flex-col shadow-xl" :class="darkMode ? 'bg-gray-900' : 'bg-white'">
      <!-- 标题栏 -->
      <div
        class="flex items-center justify-between gap-2 px-4 sm:px-5 py-3 border-b shrink-0"
        :class="darkMode ? 'border-gray-700' : 'border-gray-200'"
      >
        <div class="min-w-0">
          <h3 class="text-sm sm:text-base font-medium truncate" :class="darkMode ? 'text-white' : 'text-gray-900'">
            {{ $t("admin.repoBackup.history.title") }}
          </h3>
          <p v-if="repo" class="text-[11px] mt-0.5 font-mono truncate" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
            {{ repo.repoIdentifier }}
          </p>
        </div>

        <div class="flex items-center gap-1 shrink-0">
          <button
            class="inline-flex items-center px-2 py-1 text-xs rounded border disabled:opacity-50"
            :class="darkMode ? 'border-gray-600 text-gray-200 hover:bg-gray-700' : 'border-gray-300 text-gray-700 hover:bg-gray-100'"
            :disabled="loading"
            @click="emit('refresh')"
          >
            <IconRefresh class="h-3 w-3 mr-1" :class="loading ? 'animate-spin' : ''" />
            {{ $t("admin.repoBackup.history.refresh") }}
          </button>
          <button class="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700" @click="emit('close')">
            <IconClose class="h-4 w-4" :class="darkMode ? 'text-gray-400' : 'text-gray-500'" />
          </button>
        </div>
      </div>

      <!-- 正文：独立滚动区 -->
      <div class="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-3">
        <!-- 状态筛选（修改点：历史记录需显示失败记录） -->
        <div class="flex items-center gap-1.5 flex-wrap mb-3">
          <button
            v-for="filter in STATUS_FILTERS"
            :key="filter.key"
            type="button"
            class="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-full border transition-colors"
            :class="filterBtnClass(filter)"
            @click="emit('status-change', filter.statuses)"
          >
            {{ $t(`admin.repoBackup.history.filter.${filter.key}`) }}
            <span class="opacity-70">{{ filterCount(filter) }}</span>
          </button>
        </div>

        <!-- 空状态 -->
        <div v-if="!loading && items.length === 0" class="py-10 text-center text-sm" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
          {{ activeFilter === "all" ? $t("admin.repoBackup.history.empty") : $t("admin.repoBackup.history.emptyFiltered") }}
        </div>

        <!-- 记录列表 -->
        <ul class="space-y-2.5">
          <li
            v-for="item in items"
            :key="item.id"
            class="p-3 rounded-lg border"
            :class="darkMode ? 'border-gray-700 bg-gray-800/40' : 'border-gray-200 bg-gray-50'"
          >
            <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5 flex-wrap">
                  <span class="px-1.5 py-0.5 text-[10px] rounded font-medium" :class="itemBadgeClass(item)">
                    {{ itemLabel(item) }}
                  </span>
                  <span
                    v-if="item.ref"
                    class="px-1.5 py-0.5 text-[11px] rounded font-mono"
                    :class="darkMode ? 'bg-gray-700 text-gray-200' : 'bg-gray-200/70 text-gray-700'"
                  >
                    {{ item.ref }}
                  </span>
                  <span class="text-sm font-medium" :class="darkMode ? 'text-white' : 'text-gray-900'">
                    {{ item.version || item.shortCommitSha || $t("admin.repoBackup.history.unresolved") }}
                  </span>
                </div>

                <!-- 解析版本前就失败的记录没有 commit，不渲染空行（修改点：历史记录需显示失败记录） -->
                <div v-if="item.commitSha" class="mt-1 text-[11px] font-mono break-all" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
                  {{ item.commitSha }}
                </div>

                <div class="mt-0.5 text-[11px]" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
                  {{ formatTime(item.finishedAt || item.createdAt) }}
                  <span v-if="item.sizeBytes"> · {{ formatSize(item.sizeBytes) }}</span>
                </div>

                <div v-if="item.errorMessage" class="mt-1 text-[11px] break-all" :class="messageClass(item)">
                  {{ item.errorMessage }}
                </div>

                <!-- 各目标落盘结果（修改点：多备份目标优化） -->
                <div v-if="showTargetList(item)" class="mt-1.5 space-y-1">
                  <div
                    v-for="target in item.targets"
                    :key="target.id"
                    class="flex items-center gap-1.5 text-[11px] min-w-0"
                  >
                    <span
                      class="w-1.5 h-1.5 rounded-full shrink-0"
                      :class="targetDotClass(target.status)"
                    ></span>
                    <!-- truncate 在 flex 子项上必须配 min-w-0，否则不会收缩而是把容器撑破 -->
                    <span class="min-w-0 truncate font-mono" :class="darkMode ? 'text-gray-400' : 'text-gray-500'" :title="target.mountPath || ''">
                      {{ target.mountPath || target.mountId }}
                    </span>
                    <span v-if="target.sizeBytes" class="shrink-0" :class="darkMode ? 'text-gray-500' : 'text-gray-400'">
                      · {{ formatSize(target.sizeBytes) }}
                    </span>
                    <span
                      v-if="target.errorMessage"
                      class="min-w-0 truncate"
                      :class="target.status === 'failed' ? 'text-red-500' : 'text-amber-500'"
                      :title="target.errorMessage"
                    >
                      · {{ target.errorMessage }}
                    </span>
                  </div>
                </div>

                <!-- 单目标（或旧数据）时展示路径 -->
                <div
                  v-else-if="item.storagePath"
                  class="mt-1 text-[11px] font-mono break-all"
                  :class="darkMode ? 'text-gray-500' : 'text-gray-400'"
                >
                  {{ item.storagePath }}
                </div>
              </div>

              <!-- 下载操作：每个成功的目标一个入口 -->
              <div v-if="canDownload(item)" class="flex sm:flex-col gap-1 shrink-0 flex-wrap">
                <button
                  v-for="(target, index) in successTargets(item)"
                  :key="target.id"
                  class="inline-flex items-center px-2 py-1 text-xs rounded text-white bg-blue-600 hover:bg-blue-700"
                  :title="target.mountPath || ''"
                  @click="emit('download', item, { manifest: false, targetId: target.id })"
                >
                  <IconDownload class="h-3 w-3 mr-1" />
                  {{ successTargets(item).length > 1 ? $t("admin.repoBackup.history.downloadTarget", { index: index + 1 }) : $t("admin.repoBackup.history.downloadArchive") }}
                </button>

                <!-- 无目标行（旧数据）时按主路径下载 -->
                <button
                  v-if="successTargets(item).length === 0"
                  class="inline-flex items-center px-2 py-1 text-xs rounded text-white bg-blue-600 hover:bg-blue-700"
                  @click="emit('download', item, { manifest: false })"
                >
                  <IconDownload class="h-3 w-3 mr-1" />
                  {{ $t("admin.repoBackup.history.downloadArchive") }}
                </button>

                <button
                  v-if="item.manifestPath"
                  class="inline-flex items-center px-2 py-1 text-xs rounded border"
                  :class="darkMode ? 'border-gray-600 text-gray-200 hover:bg-gray-700' : 'border-gray-300 text-gray-700 hover:bg-gray-100'"
                  @click="emit('download', item, { manifest: true, targetId: successTargets(item)[0]?.id })"
                >
                  manifest
                </button>
              </div>
            </div>
          </li>
        </ul>

        <!-- 分页 -->
        <div
          v-if="total > paging.limit"
          class="flex items-center justify-between gap-2 mt-3 pt-3 border-t"
          :class="darkMode ? 'border-gray-700' : 'border-gray-200'"
        >
          <span class="text-[11px]" :class="darkMode ? 'text-gray-400' : 'text-gray-500'">
            {{ $t("admin.repoBackup.history.pageInfo", { from: paging.offset + 1, to: Math.min(paging.offset + paging.limit, total), total }) }}
          </span>
          <div class="flex gap-2">
            <button
              class="px-2 py-1 text-xs rounded border disabled:opacity-40"
              :class="darkMode ? 'border-gray-600 text-gray-200' : 'border-gray-300 text-gray-700'"
              :disabled="!hasPrev"
              @click="emit('page-change', paging.offset - paging.limit)"
            >
              {{ $t("admin.repoBackup.history.prev") }}
            </button>
            <button
              class="px-2 py-1 text-xs rounded border disabled:opacity-40"
              :class="darkMode ? 'border-gray-600 text-gray-200' : 'border-gray-300 text-gray-700'"
              :disabled="!hasNext"
              @click="emit('page-change', paging.offset + paging.limit)"
            >
              {{ $t("admin.repoBackup.history.next") }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
  </Teleport>
</template>
