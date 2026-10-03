<template>
  <div class="space-y-4">
    <!-- === 概览：仓库 / 阶段 / 已传输 / 目标数 === -->
    <div class="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 p-3">
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div class="min-w-0">
          <div class="text-[11px] uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {{ t('admin.tasks.repoBackup.repository') }}
          </div>
          <div class="mt-0.5 text-sm font-medium text-gray-900 dark:text-gray-100 break-all">
            {{ repoIdentifier || '-' }}
          </div>
        </div>

        <div class="min-w-0">
          <div class="text-[11px] uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {{ t('admin.tasks.repoBackup.stage') }}
          </div>
          <div class="mt-0.5 flex items-center gap-1.5">
            <IconRefresh v-if="stageSpinning" class="w-3.5 h-3.5 text-blue-500 animate-spin flex-shrink-0" />
            <span class="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{{ stageText }}</span>
          </div>
        </div>

        <div class="min-w-0">
          <div class="text-[11px] uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {{ t('admin.tasks.repoBackup.transferred') }}
          </div>
          <div class="mt-0.5 text-sm font-mono font-medium text-gray-900 dark:text-gray-100">
            {{ formatSize(bytesTransferred) }}
          </div>
        </div>

        <div class="min-w-0">
          <div class="text-[11px] uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {{ t('admin.tasks.repoBackup.targets') }}
          </div>
          <div class="mt-0.5 text-sm font-medium text-gray-900 dark:text-gray-100">
            {{ targetMounts.length || '-' }}
          </div>
        </div>
      </div>

      <!-- 运行中：当前正在处理的分支与目标 -->
      <div
        v-if="isRunning && (currentRef || currentTargetPath)"
        class="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700 space-y-1 text-xs"
      >
        <div v-if="currentRef" class="flex items-start gap-2">
          <span class="flex-shrink-0 text-gray-500 dark:text-gray-400">{{ t('admin.tasks.repoBackup.currentRef') }}:</span>
          <span class="font-mono text-gray-800 dark:text-gray-200 break-all">{{ currentRef }}</span>
        </div>
        <div v-if="currentTargetPath" class="flex items-start gap-2">
          <span class="flex-shrink-0 text-gray-500 dark:text-gray-400">{{ t('admin.tasks.repoBackup.currentTarget') }}:</span>
          <span class="font-mono text-gray-800 dark:text-gray-200 break-all">
            {{ currentTargetName ? `${currentTargetName}（${currentTargetPath}）` : currentTargetPath }}
          </span>
        </div>
      </div>

      <!-- 传输阶段的排障提示：字节不涨就是真卡住 -->
      <p
        v-if="isRunning && stage === 'transferring'"
        class="mt-2 text-[11px] text-gray-500 dark:text-gray-400"
      >
        {{ t('admin.tasks.repoBackup.stallHint') }}
      </p>
    </div>

    <!-- === 执行明细：每个跟踪引用一条 === -->
    <div>
      <h3 class="text-sm font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2 mb-2">
        <IconArchive class="w-4 h-4" />
        {{ t('admin.tasks.details.itemList') }}
        <span class="text-gray-500 dark:text-gray-400 font-normal">({{ itemResults.length }})</span>
      </h3>

      <div v-if="itemResults.length > 0" class="space-y-2 max-h-[400px] overflow-y-auto pr-1">
        <div
          v-for="(item, index) in itemResults"
          :key="index"
          class="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3"
        >
          <!-- 引用标题行 -->
          <div class="flex items-start justify-between gap-2 flex-wrap">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span
                  class="px-2 py-0.5 rounded-full text-[11px] font-medium flex-shrink-0"
                  :class="statusBadgeClass(itemStatusKey(item))"
                >
                  {{ itemStatusText(item) }}
                </span>
                <span class="text-sm font-medium text-gray-900 dark:text-gray-100 break-all">
                  {{ item.label }}
                </span>
              </div>

              <div class="mt-1 flex items-center gap-2 flex-wrap text-[11px] text-gray-500 dark:text-gray-400">
                <span v-if="item.meta?.version">
                  {{ t('admin.tasks.repoBackup.version') }}: <span class="font-mono">{{ item.meta.version }}</span>
                </span>
                <span v-if="item.meta?.commitSha" class="font-mono">
                  {{ String(item.meta.commitSha).slice(0, 10) }}
                </span>
                <span v-if="item.durationMs">
                  {{ t('admin.tasks.timeline.duration') }}: {{ formatDuration(item.durationMs) }}
                </span>
                <span v-if="item.fileSize" class="font-mono">{{ formatSize(item.fileSize) }}</span>
              </div>
            </div>
          </div>

          <!-- 每个备份目标的写入结果 -->
          <ul v-if="itemTargets(item).length > 0" class="mt-2 space-y-1">
            <li
              v-for="target in itemTargets(item)"
              :key="target.mountId"
              class="flex items-start gap-1.5 text-[11px] min-w-0"
            >
              <span class="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" :class="targetDotClass(target.status)"></span>
              <!-- truncate 在 flex 子项上必须配 min-w-0，否则不会收缩而是把容器撑破 -->
              <span
                class="min-w-0 truncate font-mono text-gray-600 dark:text-gray-300"
                :title="target.mountPath || ''"
              >
                {{ target.name || target.mountPath || target.mountId }}
              </span>
              <span class="flex-shrink-0 text-gray-500 dark:text-gray-400">
                · {{ statusText(target.status) }}
              </span>
              <span v-if="target.sizeBytes" class="flex-shrink-0 font-mono text-gray-500 dark:text-gray-400">
                · {{ formatSize(target.sizeBytes) }}
              </span>
              <span v-if="target.error" class="min-w-0 text-red-500 dark:text-red-400 break-words">
                · {{ target.error }}
              </span>
            </li>
          </ul>

          <!-- 该引用的错误 / 提示 -->
          <div
            v-if="item.error"
            class="mt-2 flex items-start gap-1.5 px-2 py-1.5 rounded text-[11px]"
            :class="itemMessageClass(item)"
          >
            <IconExclamation class="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span class="break-words">{{ item.error }}</span>
          </div>
          <div
            v-else-if="item.message"
            class="mt-2 flex items-start gap-1.5 px-2 py-1.5 rounded text-[11px]"
            :class="itemMessageClass(item)"
          >
            <span class="break-words">{{ item.message }}</span>
          </div>
        </div>
      </div>

      <div v-else class="text-center py-8 text-gray-500 dark:text-gray-400 text-sm">
        <IconArchive class="w-8 h-8 mx-auto mb-2 opacity-50" />
        <p>{{ t('admin.tasks.repoBackup.noItems') }}</p>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * 代码仓库备份任务详情（修改点：任务卡住且无法查看原因）
 *
 * 为什么需要这个组件：
 * - 原来 TaskDrawer 的 componentMap 里没有 repo_backup，抽屉里只剩时间线和 payload，
 *   一个跑了十几分钟的备份任务看不出它在解析版本、在传输、还是已经卡死
 * - 后端 RepoBackupTaskHandler 现在把阶段（stage）、当前分支/目标、实时字节数
 *   都写进了 stats，这里负责把它们呈现出来
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { IconArchive, IconRefresh, IconExclamation } from '@/components/icons'

const props = defineProps({
  task: {
    type: Object,
    required: true
  }
})

const { t } = useI18n()

const stats = computed(() => props.task?.stats || {})
const itemResults = computed(() => stats.value.itemResults || [])
const targetMounts = computed(() => stats.value.targetMounts || [])

const repoIdentifier = computed(() => stats.value.repoIdentifier || props.task?.payload?.repoIdentifier || '')
const stage = computed(() => stats.value.stage || '')
const currentRef = computed(() => stats.value.currentRef || '')
const currentTargetPath = computed(() => stats.value.currentTargetPath || '')
const currentTargetName = computed(() => stats.value.currentTargetName || '')
const bytesTransferred = computed(() => Number(stats.value.bytesTransferred) || 0)

const isRunning = computed(() => props.task?.status === 'running' || props.task?.status === 'pending')

/** 传输/清理这类耗时阶段给个转圈，让"还在跑"一眼可见 */
const stageSpinning = computed(
  () =>
    isRunning.value &&
    // 修改点（第 4 期）：版本检测任务的 detecting / dispatching 也是耗时阶段，
    // 这个详情组件同时给 repo_backup 与 repo_backup_check 两种任务用
    ['resolving', 'transferring', 'manifest', 'pruning', 'detecting', 'dispatching'].includes(stage.value)
)

const stageText = computed(() => {
  if (!stage.value) return t('admin.tasks.repoBackup.stages.unknown')
  const key = `admin.tasks.repoBackup.stages.${stage.value}`
  const text = t(key)
  // 阶段是后端新增字段，老任务或新阶段缺翻译时直接回显原值，不显示 i18n key
  return text === key ? stage.value : text
})

const itemTargets = (item) => (Array.isArray(item?.meta?.targets) ? item.meta.targets : [])

/**
 * 条目展示用的「结果」（修改点：状态显示不一致修复）
 *
 * 后端每个条目除了任务系统的 status，还会带一个来自 repobackup/status.js 的
 * meta.outcome。有 outcome 时以它为准，因为 status 是通用于所有任务的粗粒度值：
 *   · 「无需备份（已是最新）」与「限流已安排重试」在后端都是 skipped，
 *     但它们是两件完全不同的事
 *   · partial（部分目标写成功）在 status 上记 failed，可它并不是彻底失败
 * 没有 outcome 的老任务回落到 status，显示不受影响。
 */
const OUTCOME_TO_STATUS = {
  pending: 'pending',
  running: 'processing',
  success: 'success',
  partial: 'partial',
  up_to_date: 'skipped',
  update_available: 'success',
  deferred: 'deferred',
  blocked: 'skipped',
  failed: 'failed',
}

/** 条目最终用于着色的状态键 */
const itemStatusKey = (item) => {
  const outcome = item?.meta?.outcome
  return (outcome && OUTCOME_TO_STATUS[outcome]) || item?.status || 'pending'
}

/** 条目最终用于显示的文案：outcome 有专门的名字就用它 */
const itemStatusText = (item) => {
  const outcome = item?.meta?.outcome
  if (outcome) {
    const key = `admin.tasks.repoBackup.outcome.${outcome}`
    const text = t(key)
    if (text !== key) return text
  }
  return statusText(item?.status)
}

const statusText = (status) => {
  const map = {
    success: t('admin.tasks.fileStatus.success'),
    processing: t('admin.tasks.fileStatus.processing'),
    failed: t('admin.tasks.fileStatus.failed'),
    skipped: t('admin.tasks.fileStatus.skipped'),
    pending: t('admin.tasks.fileStatus.pending'),
    // 修改点（状态显示不一致修复）：备份目标被限流时是「已延迟重试」，
    // 不能复用通用的「跳过」，也不要落到未翻译的原始值上
    deferred: t('admin.tasks.repoBackup.outcome.deferred')
  }
  return map[status] || status || '-'
}

/**
 * 条目错误块的配色（修改点：状态显示不一致修复）
 * deferred / partial 都会带一段说明文字，但它们不是「失败」，
 * 一律涂红会让用户把「稍后重试」读成「坏了」。
 */
const itemMessageClass = (item) => {
  const key = itemStatusKey(item)
  if (key === 'failed') {
    return 'bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-300'
  }
  if (key === 'partial' || key === 'deferred') {
    return 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300'
  }
  return 'bg-gray-50 dark:bg-gray-900/40 text-gray-600 dark:text-gray-300'
}

const statusBadgeClass = (status) => {
  const map = {
    success: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
    processing: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    failed: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
    skipped: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300',
    pending: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
    // 修改点（状态显示不一致修复）：部分成功 / 已延迟重试都不是失败，用琥珀色
    partial: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    deferred: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
  }
  return map[status] || map.pending
}

const targetDotClass = (status) => {
  const map = {
    success: 'bg-green-500',
    processing: 'bg-blue-500 animate-pulse',
    failed: 'bg-red-500',
    skipped: 'bg-yellow-500',
    pending: 'bg-gray-400',
    // 修改点（状态显示不一致修复）：目标被延迟时不是写入失败
    deferred: 'bg-amber-500'
  }
  return map[status] || map.pending
}

const formatSize = (bytes) => {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(2)} ${units[i]}`
}

const formatDuration = (ms) => {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '-'
  if (n < 1000) return `${n} ms`
  const seconds = n / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes} min ${rest} s`
}
</script>
