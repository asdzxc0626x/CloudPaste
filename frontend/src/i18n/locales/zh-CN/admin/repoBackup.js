// 仓库管理（修改点：新增功能）
export default {
  repoBackup: {
    title: "仓库管理",
    subtitle: "登记外部代码仓库，按各自的备份计划定时检查分支或 Release 更新，并将源码快照备份到一个或多个存储挂载点",

    toolbar: {
      create: "添加仓库",
      refresh: "刷新",
      refreshing: "刷新中...",
    },

    table: {
      repository: "仓库",
      track: "跟踪版本",
      target: "备份目标",
      lastBackup: "最近备份",
      actions: "操作",
      empty: "还没有登记任何代码仓库，点击「添加仓库」开始",
      loading: "加载中...",
      checkedAt: "检查于",
      neverBackedUp: "尚未备份",
      mountMissing: "挂载点已丢失",
      retention: "保留 {count} 个版本",
      targetsOk: "目标 {ok}/{total} 写入成功",
      // 修改点（独立备份计划优化）
      schedule: "备份计划",
      scheduleOff: "未启用定时备份",
      scheduleEvery: "每 {interval}",
      scheduleNext: "下次",
      scheduleLastFailed: "上次调度失败",
    },

    status: {
      disabled: "已禁用",
    },

    backupStatus: {
      running: "进行中",
      success: "成功",
      // partial = 多目标时只有部分目标写成功
      partial: "部分成功",
      failed: "失败",
      skipped: "已跳过",
    },

    trackMode: {
      branch: "分支 Commit",
      release: "Release / Tag",
    },

    check: {
      hasUpdate: "检测到新版本，可以备份",
      upToDate: "最新版本已备份",
      allFailed: "全部跟踪分支检查失败",
      partialFailed: "（{count} 个分支检查失败）",
      refHasUpdate: "该分支有新版本待备份",
      refUpToDate: "该分支已是最新备份",
    },

    actions: {
      check: "检查更新",
      backup: "立即备份",
      backupDisabledHint: "仓库已禁用，请先启用",
      history: "历史",
      edit: "编辑",
      enable: "启用",
      disable: "禁用",
      delete: "删除",
    },

    // 按钮通用文案（不用 common.save/common.delete：该命名空间下不存在这两个键）
    buttons: {
      cancel: "取消",
      save: "保存",
      delete: "删除",
    },

    form: {
      createTitle: "添加代码仓库",
      editTitle: "编辑代码仓库",
      // 修改点（编辑窗口 / 响应式优化）：分区卡片标题
      basicSection: "基础信息",
      provider: "仓库类型",
      providerLocked: "仓库类型创建后不可修改",
      repoIdentifier: "仓库标识",
      repoIdentifierPlaceholder: "owner/repo",
      repoIdentifierHint: "支持 owner/repo 或完整仓库 URL，第一阶段仅支持公开仓库",
      name: "展示名称",
      namePlaceholder: "留空则使用 owner/repo",

      trackSection: "跟踪设置",
      trackMode: "跟踪模式",
      trackModeHint: {
        branch: "跟踪指定分支的最新 commit",
        release: "跟踪最新 Release；仓库没有 Release 时回退到最新 Tag",
      },
      branches: "跟踪分支",
      branchesHint: "可添加多个分支，每个分支独立检查更新、去重与备份。输入后按回车或逗号确认",
      addBranchPlaceholder: "继续添加分支…",
      removeBranch: "移除该分支",
      tag: "指定 Tag",
      tagPlaceholder: "留空 = 最新 Release",
      tagHint: "留空表示每次取最新 Release",

      targetSection: "备份目标",
      targetMount: "目标挂载点",
      targetMountHint: "可多选，一次备份会同步写入全部选中的目标；只列出支持写入的挂载点",
      selectMount: "请选择挂载点",
      selectedCount: "已选 {count} 个",
      mountMissingCount: "{count} 个已丢失",
      noWritableMount: "没有可写入的挂载点，请先在「挂载管理」中添加一个支持写入的挂载点",
      pathPrefix: "路径前缀",
      pathPrefixHint: "挂载点内的存放目录，默认根目录；每个仓库会在其下自动建子目录",
      retentionCount: "保留版本数",
      retentionCountHint: "超过该数量后自动删除最旧的版本，默认 {count} 个",

      // 修改点（独立备份计划优化）：每个仓库单独的备份计划，复用后端定时任务机制
      scheduleSection: "备份计划",
      scheduleEnabled: "启用定时备份",
      scheduleInterval: "备份间隔",
      scheduleIntervalHint: "默认每 6 小时检查一次；没有新版本时会自动跳过，不会重复备份",
      scheduleDisabledHint: "已关闭定时备份，只能手动点击「立即备份」",
      intervalMinutes: "{count} 分钟",
      intervalHours: "{count} 小时",
      intervalDays: "{count} 天",
      intervalCustom: "自定义…",
      intervalCustomHours: "自定义间隔（小时）",
      intervalCustomHint: "范围 {min} 分钟 ~ {max} 天，支持小数（如 0.5 = 30 分钟）",

      advancedSection: "高级配置（可选）",
      enabled: "启用该仓库（禁用后不可备份）",
      saving: "保存中...",
      show: "显示",
      hide: "隐藏",
    },

    fields: {
      github: {
        token: "GitHub Token（可选）",
        gh_proxy: "加速代理（可选）",
        endpoint_url: "API 地址（可选）",
      },
    },

    placeholder: {
      github: {
        token: "ghp_xxx，仅用于提高速率上限",
        gh_proxy: "https://ghproxy.example.com",
        endpoint_url: "https://api.github.com",
      },
    },

    description: {
      github: {
        token: "公开仓库无需填写。填写后可提高 GitHub API 速率上限，避免频繁检查时被限流",
        gh_proxy: "作为前缀拼接到下载地址前，用于加速源码归档下载",
        endpoint_url: "GitHub Enterprise 或自建 API 地址，默认 https://api.github.com",
      },
    },

    groups: {
      advanced: "高级配置",
    },

    provider: {
      github: "GitHub",
    },

    history: {
      title: "备份历史",
      refresh: "刷新",
      empty: "该仓库还没有备份记录",
      downloadArchive: "下载快照",
      downloadTarget: "下载 #{index}",
      prev: "上一页",
      next: "下一页",
      pageInfo: "第 {from} - {to} 条，共 {total} 条",
    },

    delete: {
      title: "删除代码仓库",
      confirm: "确定要删除「{name}」吗？",
      hint: "仅删除登记信息与备份记录，已上传到存储的快照文件会保留。",
    },

    validation: {
      repoRequired: "请填写仓库标识（owner/repo）",
      branchRequired: "分支模式下至少需要添加一个分支",
      mountRequired: "请至少选择一个备份目标挂载点",
      retentionRange: "保留版本数必须在 {min} ~ {max} 之间",
      intervalRange: "备份间隔必须在 {min} 分钟 ~ {max} 天之间",
    },

    messages: {
      loadFailed: "加载代码仓库列表失败",
      loadProvidersFailed: "加载仓库类型失败",
      loadMountsFailed: "加载挂载点列表失败",
      saveSuccess: "保存成功",
      saveFailed: "保存失败",
      deleteSuccess: "删除成功",
      deleteFailed: "删除失败",
      toggleFailed: "切换状态失败",
      checkFailed: "检查更新失败",
      backupCreated: "备份作业已创建，可在「任务列表」查看进度",
      backupFailed: "创建备份作业失败",
      historyFailed: "加载备份历史失败",
      downloadFailed: "获取下载链接失败",
    },
  },
};
