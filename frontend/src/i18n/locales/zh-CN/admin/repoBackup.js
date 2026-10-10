// 仓库管理（修改点：新增功能）
export default {
  repoBackup: {
    title: "仓库管理",
    subtitle: "登记外部代码仓库，按各自的备份计划定时检查分支或 Release 更新，并将源码快照备份到一个或多个存储挂载点",

    toolbar: {
      create: "添加仓库",
      refresh: "刷新",
      refreshing: "刷新中...",
      // 修改点（第 3 期 3-B）：全局 Token / 代理池入口
      globalCredentials: "全局凭据",
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
      // 修改点（备份计划支持 cron）
      scheduleCron: "cron {cron}",
      scheduleNext: "下次",
      scheduleLastFailed: "上次调度失败",
      // 修改点（第 4 期 检测状态持久化）：逐引用的检测进度（持久化，重启后仍在）
      nextDetect: "下次检测",
      detectedAt: "检测于",
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
      // 修改点（状态显示不一致修复）：限流/上游暂时不可用是「已安排重试」，
      // 与「无需备份（已跳过）」和「失败」都不相同，必须有自己的状态
      deferred: "已延迟重试",
    },

    /**
     * 统一结果词汇（修改点：状态显示不一致修复）
     *
     * 后端 repobackup/status.js 的 outcome 值 → 文案。仓库管理列表、备份历史、
     * 任务详情三处都读这一套，保证同一件事在哪儿都叫同一个名字。
     */
    outcome: {
      pending: "尚未备份",
      running: "进行中",
      success: "成功完成",
      partial: "部分成功",
      up_to_date: "已是最新",
      update_available: "有新版本待备份",
      deferred: "已延迟重试",
      blocked: "已被阻止",
      failed: "失败",
    },
    state: {
      retryAt: "重试时间 {time}",
      activeJobs: "有 {count} 个任务正在执行",
    },

    /**
     * 检测 / 备份 / 调度三个维度（修改点：第 5 期 前端状态展示）
     *
     * 为什么另起一套文案而不是复用上面的 outcome.*：
     *   outcome.* 是「仓库级合并结论」，备份历史与任务详情也在读它；
     *   这里是仓库管理页并列展示的三个独立维度，语义不同
     *   （例如 up_to_date 在合并结论里叫「已是最新」，在检测维度里叫「无更新」）。
     *   分开之后改这里不会连带影响另外两个页面。
     */
    dimension: {
      detect: "检测",
      backup: "备份",
      schedule: "调度",
    },
    detectStatus: {
      pending: "等待检测",
      detecting: "检测中",
      up_to_date: "无更新",
      update_available: "检测到更新",
      deferred: "延迟重试",
      failed: "失败",
    },
    backupState: {
      pending: "尚无备份",
      running: "备份中",
      success: "已备份",
      partial: "部分成功",
      skipped: "已跳过",
      deferred: "延迟重试",
      failed: "失败",
    },
    scheduleState: {
      none: "未配置定时",
      disabled: "定时已关闭",
      waiting: "等待下次执行",
      failed: "上次调度失败",
    },

    trackMode: {
      branch: "分支 Commit",
      release: "Release / Tag",
    },

    check: {
      hasUpdate: "检测到新版本，可以备份",
      // 修改点（无更新反馈）：明确表达「检查完成且已是最新」，这是一个成功结果，
      // 不是失败也不是空结果。原文案「最新版本已备份」没说清检测有没有跑完。
      upToDate: "检查完成，当前已是最新版本",
      allFailed: "全部跟踪分支检查失败",
      partialFailed: "（{count} 个分支检查失败）",
      refHasUpdate: "该分支有新版本待备份",
      refUpToDate: "该分支已是最新备份",
      // 修改点（第 4 期 检测状态持久化）：限流/上游抽风属于「稍后自动重试」，不是失败
      deferred: "上游限流或暂时不可用，已安排自动重试",
      partialDeferred: "（{count} 个分支已安排自动重试）",
      refDeferred: "该分支因上游限流/暂时不可用已安排自动重试",
      refError: "该分支检测失败",
      // 持久化的检测进度（跨会话可见，不只本次检查结果）
      persistedPending: "尚未检测",
      persistedDeferred: "等待自动重试",
      persistedError: "检测失败",
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

    // 修改点（点击 owner/repo 跳转仓库）：仓库标识的悬停提示
    openRepository: "在新标签页打开仓库页面",

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
      // 修改点（备份默认目录按仓库源区分）：默认目录不再是根目录，而是按仓库类型分目录
      pathPrefixHint: "挂载点内的存放目录，默认按仓库类型分目录（GitHub 对应 /GitHub）；每个仓库会在其下自动建子目录",
      retentionCount: "保留版本数",
      retentionCountHint: "超过该数量后自动删除最旧的版本，默认 {count} 个",

      // 修改点（独立备份计划优化）：每个仓库单独的备份计划，复用后端定时任务机制
      scheduleSection: "备份计划",
      scheduleEnabled: "启用定时备份",
      // 修改点（备份计划支持 cron）：与「定时任务」页一致的两种调度方式
      scheduleMode: "调度方式",
      scheduleModeInterval: "固定间隔",
      scheduleModeCron: "cron 表达式",
      scheduleCron: "cron 表达式",
      scheduleCronHint: "标准 5 段：分 时 日 月 周，最小粒度为分钟。例如 30 3 * * * 表示每天 03:30",
      cronPreset: {
        hourly: "每小时整点",
        everySixHours: "每 6 小时",
        dailyEarly: "每天 03:30",
        weekly: "每周一 04:00",
      },
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

    // 修改点（第 3 期 3-B）：Token / 代理池编辑器
    pool: {
      globalTitle: "全局 GitHub 凭据池",
      globalSubtitle: "配置全局的 Token 与加速代理；仓库未单独配置时自动使用这里的配置",
      tokenPlaceholder: "ghp_xxx",
      proxyPlaceholder: "https://ghproxy.example.com",
      // 修改点（全局凭据恢复原样）：卡片式（一条一张卡片）所需的文案，
      // 全局凭据弹窗使用这一套
      tokenEntry: "Token 备注（可选）",
      proxyEntry: "代理备注（可选）",
      entryLabel: "备注",
      // 修改点（凭据去重）：备注与值都不允许重复，重复时提示重填
      duplicateValue: "这个值已经填过了，请换一个（重复的凭据没有意义）",
      duplicateLabel: "这个备注已经用过了，请换一个",
      add: "添加一条",
      addToken: "添加 Token",
      addProxy: "添加代理",
      remove: "删除",
      enabled: "启用",
      empty: "还没有配置任何条目",
      // 修改点（全局凭据分组可折叠）：折叠标题右侧的条数角标 + 折叠按钮的悬停提示
      entryCount: "{count} 条",
      expandSection: "展开该分组",
      collapseSection: "收起该分组",
      // 修改点（第 3 期 3-B 交互重做）：仓库表单的标签式录入所需文案
      valuePlaceholder: "凭据值",
      inputHint:
        "回车、逗号或换行确认，可一次粘贴多个（空格 / 逗号 / 换行分隔）；点击条目查看明文，点击左侧圆点启用或禁用，点击 × 删除",
      limitReached: "最多 {max} 条，已达上限",
      emptyValue: "（空值）",
      clickToEnable: "已禁用，点击启用",
      clickToDisable: "已启用，点击禁用",
      revealTitle: "点击查看明文",
      hideTitle: "点击隐藏明文",
      removeTitle: "删除这一条",
      priorityHint: "调度优先级：仓库级凭据 → 全局凭据 → 匿名额度。Token 与代理各自独立挑选，不固定绑定；某个凭据被限流或失效时会被暂时避开。",
      save: "保存",
      saving: "保存中...",
      cancel: "取消",
      loading: "加载中...",
      loadFailed: "读取全局凭据池失败",
      saveFailed: "保存全局凭据池失败",
    },

    fields: {
      github: {
        // 修改点（Token / 代理统一为多值字段）：原来的「GitHub Token」与「加速代理」
        // 各自只有一个输入框，现在它们本身就是多值字段（可填多个），
        // 因此不再存在「单值 + 池」两个重复的字段
        tokens: "GitHub Token（可选，可填多个）",
        proxies: "加速代理（可选，可填多个）",
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
        tokens: "公开仓库无需填写；填写后可提高 GitHub API 速率上限，避免频繁检查时被限流。留空则自动使用全局凭据池，全局也没有时按匿名额度调度。配置多个 Token 时，调度器会按额度与限流状态动态挑选，某个被限流不会影响其他",
        proxies: "作为前缀拼接到源码归档下载地址前，用于加速下载。可配置多个，调度时动态组合、不固定绑定；某个节点失败会被暂时避开，全部不可用时自动直连",
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
      // 修改点（历史记录需显示失败记录）
      emptyFiltered: "当前筛选条件下没有记录",
      unresolved: "未解析到版本",
      filter: {
        all: "全部",
        success: "成功",
        failed: "失败",
        running: "进行中",
        skipped: "已跳过",
        // 修改点（状态显示不一致修复）：延迟重试单独一档，不再和「已跳过」混在一起
        deferred: "延迟重试",
      },
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
      // 修改点（备份计划支持 cron）
      cronInvalid: "cron 表达式必须是 5 段：分 时 日 月 周（例如 30 3 * * *）",
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
