<script setup>
/**
 * 仓库行操作按钮组（修改点：响应式优化时抽出来复用）
 *
 * 抽成独立组件的原因：桌面端是表格行、移动端是卡片列表，
 * 两处需要完全一致的操作按钮，避免复制两份后行为漂移。
 */
import { IconRefresh, IconArchive, IconClock, IconDelete, IconRename } from "@/components/icons";

const props = defineProps({
  repo: { type: Object, required: true },
  busy: { type: Boolean, default: false },
  darkMode: { type: Boolean, default: false },
  /** true 时按钮只显示图标（表格行内更紧凑） */
  iconOnly: { type: Boolean, default: false },
});

const emit = defineEmits(["check", "backup", "history", "edit", "toggle", "delete"]);

const neutralBtnClass = () =>
  props.darkMode
    ? "border-gray-600 text-gray-200 hover:bg-gray-700"
    : "border-gray-300 text-gray-700 hover:bg-gray-100";
</script>

<template>
  <div class="flex items-center gap-1 flex-wrap justify-end">
    <!-- 检查更新 -->
    <button
      class="inline-flex items-center px-2 py-1 text-xs rounded border transition-colors disabled:opacity-50"
      :class="neutralBtnClass()"
      :disabled="busy"
      :title="$t('admin.repoBackup.actions.check')"
      @click="emit('check', repo)"
    >
      <IconRefresh class="h-3 w-3" :class="[busy ? 'animate-spin' : '', iconOnly ? '' : 'mr-1']" />
      <span v-if="!iconOnly">{{ $t("admin.repoBackup.actions.check") }}</span>
    </button>

    <!-- 立即备份 -->
    <button
      class="inline-flex items-center px-2 py-1 text-xs rounded text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
      :disabled="busy || !repo.enabled"
      :title="repo.enabled ? $t('admin.repoBackup.actions.backup') : $t('admin.repoBackup.actions.backupDisabledHint')"
      @click="emit('backup', repo)"
    >
      <IconArchive class="h-3 w-3" :class="iconOnly ? '' : 'mr-1'" />
      <span v-if="!iconOnly">{{ $t("admin.repoBackup.actions.backup") }}</span>
    </button>

    <!-- 备份历史 -->
    <button
      class="inline-flex items-center px-2 py-1 text-xs rounded border transition-colors"
      :class="neutralBtnClass()"
      :title="$t('admin.repoBackup.actions.history')"
      @click="emit('history', repo)"
    >
      <IconClock class="h-3 w-3" :class="iconOnly ? '' : 'mr-1'" />
      <span v-if="!iconOnly">{{ $t("admin.repoBackup.actions.history") }}</span>
    </button>

    <!-- 编辑 -->
    <button
      class="inline-flex items-center px-2 py-1 text-xs rounded border transition-colors"
      :class="neutralBtnClass()"
      :title="$t('admin.repoBackup.actions.edit')"
      @click="emit('edit', repo)"
    >
      <IconRename class="h-3 w-3" :class="iconOnly ? '' : 'mr-1'" />
      <span v-if="!iconOnly">{{ $t("admin.repoBackup.actions.edit") }}</span>
    </button>

    <!-- 启用 / 禁用 -->
    <button
      class="inline-flex items-center px-2 py-1 text-xs rounded border transition-colors disabled:opacity-50"
      :class="neutralBtnClass()"
      :disabled="busy"
      @click="emit('toggle', repo)"
    >
      {{ repo.enabled ? $t("admin.repoBackup.actions.disable") : $t("admin.repoBackup.actions.enable") }}
    </button>

    <!-- 删除 -->
    <button
      class="inline-flex items-center px-2 py-1 text-xs rounded border border-red-300 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/30 disabled:opacity-50"
      :disabled="busy"
      :title="$t('admin.repoBackup.actions.delete')"
      @click="emit('delete', repo)"
    >
      <IconDelete class="h-3 w-3" :class="iconOnly ? '' : 'mr-1'" />
      <span v-if="!iconOnly">{{ $t("admin.repoBackup.actions.delete") }}</span>
    </button>
  </div>
</template>
