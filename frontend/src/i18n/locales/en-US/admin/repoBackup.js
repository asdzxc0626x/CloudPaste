// Repositories (new feature)
export default {
  repoBackup: {
    title: "Repositories",
    subtitle:
      "Register external code repositories, check branches or releases on each repository's own schedule, and back up source snapshots to one or more storage mounts",

    toolbar: {
      create: "Add Repository",
      refresh: "Refresh",
      refreshing: "Refreshing...",
      // 修改点（第 3 期 3-B）：全局 Token / 代理池入口
      globalCredentials: "Global credentials",
    },

    table: {
      repository: "Repository",
      track: "Tracking",
      target: "Targets",
      lastBackup: "Last Backup",
      actions: "Actions",
      empty: "No repositories registered yet. Click \"Add Repository\" to start.",
      loading: "Loading...",
      checkedAt: "Checked at",
      neverBackedUp: "Never backed up",
      mountMissing: "Mount missing",
      retention: "Keep {count} versions",
      targetsOk: "{ok}/{total} targets written",
      // Per-repository backup schedule
      schedule: "Schedule",
      scheduleOff: "Schedule off",
      scheduleEvery: "Every {interval}",
      scheduleCron: "cron {cron}",
      scheduleNext: "next",
      scheduleLastFailed: "last run failed",
      // 修改点（第 4 期 检测状态持久化）：逐引用的检测进度（持久化，重启后仍在）
      nextDetect: "Next check",
      detectedAt: "Checked",
    },

    status: {
      disabled: "Disabled",
    },

    backupStatus: {
      running: "Running",
      success: "Success",
      // partial = only some of the selected targets were written
      partial: "Partial",
      failed: "Failed",
      skipped: "Skipped",
      // 修改点（状态显示不一致修复）：限流/上游暂时不可用是「已安排重试」，
      // 与「无需备份（已跳过）」和「失败」都不相同，必须有自己的状态
      deferred: "Retry scheduled",
    },

    /**
     * 统一结果词汇（修改点：状态显示不一致修复）
     *
     * 后端 repobackup/status.js 的 outcome 值 → 文案。仓库管理列表、备份历史、
     * 任务详情三处都读这一套，保证同一件事在哪儿都叫同一个名字。
     */
    outcome: {
      pending: "Not backed up yet",
      running: "Running",
      success: "Completed",
      partial: "Partially completed",
      up_to_date: "Up to date",
      update_available: "New version ready to back up",
      deferred: "Retry scheduled",
      blocked: "Blocked",
      failed: "Failed",
    },
    state: {
      retryAt: "Retry at {time}",
      activeJobs: "{count} jobs currently running",
    },

    /**
     * Check / backup / schedule dimensions (phase 5: status display)
     *
     * Kept separate from outcome.* above: outcome.* is the merged repository-level
     * conclusion shared with the backup history and task details, while these are the
     * three independent dimensions shown side by side on the repositories page.
     */
    dimension: {
      detect: "Check",
      backup: "Backup",
      schedule: "Schedule",
    },
    detectStatus: {
      pending: "Awaiting check",
      detecting: "Checking",
      up_to_date: "No update",
      update_available: "Update detected",
      deferred: "Retry scheduled",
      failed: "Failed",
    },
    backupState: {
      pending: "Not backed up",
      running: "Backing up",
      success: "Backed up",
      partial: "Partial",
      skipped: "Skipped",
      deferred: "Retry scheduled",
      failed: "Failed",
    },
    scheduleState: {
      none: "No schedule",
      disabled: "Schedule off",
      waiting: "Next run pending",
      failed: "Last run failed",
    },

    trackMode: {
      branch: "Branch commit",
      release: "Release / Tag",
    },

    check: {
      hasUpdate: "New version detected, ready to back up",
      // 修改点（无更新反馈）：明确表达「检查完成且已是最新」，这是一个成功结果，
      // 不是失败也不是空结果。原文案「最新版本已备份」没说清检测有没有跑完。
      upToDate: "Check complete — already up to date",
      allFailed: "All tracked branches failed to check",
      partialFailed: "({count} branches failed to check)",
      refHasUpdate: "This branch has an unbacked version",
      refUpToDate: "This branch is up to date",
      // 修改点（第 4 期 检测状态持久化）：限流/上游抽风属于「稍后自动重试」，不是失败
      deferred: "Upstream is rate limiting or temporarily unavailable; a retry is scheduled",
      partialDeferred: "({count} branches scheduled for retry)",
      refDeferred: "Scheduled for retry after upstream rate limiting",
      refError: "This branch failed to check",
      persistedPending: "Not checked yet",
      persistedDeferred: "Awaiting automatic retry",
      persistedError: "Check failed",
    },

    actions: {
      check: "Check",
      backup: "Back up now",
      backupDisabledHint: "Repository is disabled, enable it first",
      history: "History",
      edit: "Edit",
      enable: "Enable",
      disable: "Disable",
      delete: "Delete",
    },

    buttons: {
      cancel: "Cancel",
      save: "Save",
      delete: "Delete",
    },

    form: {
      createTitle: "Add Repository",
      editTitle: "Edit Repository",
      basicSection: "Basics",
      provider: "Repository type",
      providerLocked: "Repository type cannot be changed after creation",
      repoIdentifier: "Repository",
      repoIdentifierPlaceholder: "owner/repo",
      repoIdentifierHint: "Accepts owner/repo or a full repository URL; public repositories only for now",
      name: "Display name",
      namePlaceholder: "Defaults to owner/repo",

      trackSection: "Tracking",
      trackMode: "Tracking mode",
      trackModeHint: {
        branch: "Track the latest commit of the selected branches",
        release: "Track the latest release; falls back to the latest tag when no release exists",
      },
      branches: "Branches",
      branchesHint:
        "Add multiple branches; each is checked, de-duplicated and backed up independently. Press Enter or comma to confirm.",
      addBranchPlaceholder: "Add another branch...",
      removeBranch: "Remove this branch",
      tag: "Tag",
      tagPlaceholder: "Empty = latest release",
      tagHint: "Leave empty to always use the latest release",

      targetSection: "Backup targets",
      targetMount: "Target mounts",
      targetMountHint:
        "Multi-select supported: one backup is written to every selected target. Only writable mounts are listed.",
      selectMount: "Select mounts",
      selectedCount: "{count} selected",
      mountMissingCount: "{count} missing",
      noWritableMount: "No writable mount available. Add a writable mount in \"Mount Management\" first.",
      pathPrefix: "Path prefix",
      pathPrefixHint:
        "Directory inside the mount, root by default; each repository gets its own subdirectory",
      retentionCount: "Versions to keep",
      retentionCountHint: "Older versions are deleted automatically beyond this count; default {count}",

      // Per-repository backup schedule, backed by the existing scheduled-jobs mechanism
      scheduleSection: "Backup schedule",
      scheduleEnabled: "Back up on a schedule",
      scheduleMode: "Schedule mode",
      scheduleModeInterval: "Fixed interval",
      scheduleModeCron: "Cron expression",
      scheduleCron: "Cron expression",
      scheduleCronHint:
        "Standard 5 fields: minute hour day month weekday, minute precision. For example 30 3 * * * runs daily at 03:30",
      cronPreset: {
        hourly: "Every hour on the hour",
        everySixHours: "Every 6 hours",
        dailyEarly: "Daily at 03:30",
        weekly: "Mondays at 04:00",
      },
      scheduleInterval: "Interval",
      scheduleIntervalHint:
        "Checks every 6 hours by default; runs with no new version are skipped, so nothing is backed up twice",
      scheduleDisabledHint: "Scheduled backups are off; use \"Back up now\" instead",
      intervalMinutes: "{count} minutes",
      intervalHours: "{count} hours",
      intervalDays: "{count} days",
      intervalCustom: "Custom...",
      intervalCustomHours: "Custom interval (hours)",
      intervalCustomHint: "Between {min} minutes and {max} days; decimals allowed (0.5 = 30 minutes)",

      advancedSection: "Advanced options",
      enabled: "Enable this repository (disabled repositories cannot be backed up)",
      saving: "Saving...",
      show: "Show",
      hide: "Hide",
    },

    // 修改点（第 3 期 3-B）：Token / 代理池编辑器
    pool: {
      globalTitle: "Global GitHub credential pool",
      globalSubtitle: "Tokens and proxies shared by every repository that does not define its own",
      tokenPlaceholder: "ghp_xxx",
      proxyPlaceholder: "https://ghproxy.example.com",
      // 修改点（全局凭据恢复原样）：卡片式（一条一张卡片）所需的文案，
      // 全局凭据弹窗使用这一套
      tokenEntry: "Token label (optional)",
      proxyEntry: "Proxy label (optional)",
      entryLabel: "Label",
      // 修改点（凭据去重）：备注与值都不允许重复，重复时提示重填
      duplicateValue: "This value is already in the list — enter a different one (a duplicate credential has no effect)",
      duplicateLabel: "This label is already in use — pick another",
      add: "Add entry",
      addToken: "Add token",
      addProxy: "Add proxy",
      remove: "Remove",
      enabled: "Enabled",
      empty: "No entries configured yet",
      // 修改点（全局凭据分组可折叠）：折叠标题右侧的条数角标 + 折叠按钮的悬停提示
      entryCount: "{count} configured",
      expandSection: "Expand this section",
      collapseSection: "Collapse this section",
      // 修改点（第 3 期 3-B 交互重做）：仓库表单的标签式录入所需文案
      valuePlaceholder: "Credential value",
      inputHint:
        "Press Enter, comma or newline to confirm, and paste several at once (separated by spaces, commas or newlines). Click an entry to reveal it, click the dot on the left to enable or disable it, click × to remove it.",
      limitReached: "Maximum of {max} entries reached",
      emptyValue: "(empty)",
      clickToEnable: "Disabled — click to enable",
      clickToDisable: "Enabled — click to disable",
      revealTitle: "Click to reveal the plain value",
      hideTitle: "Click to hide the plain value",
      removeTitle: "Remove this entry",
      priorityHint:
        "Selection order: repository credentials, then global credentials, then the anonymous quota. Tokens and proxies are picked independently rather than pinned together; a throttled or invalid credential is avoided temporarily.",
      save: "Save",
      saving: "Saving...",
      cancel: "Cancel",
      loading: "Loading...",
      loadFailed: "Failed to load the global credential pool",
      saveFailed: "Failed to save the global credential pool",
    },

    fields: {
      github: {
        // 修改点（Token / 代理统一为多值字段）：原来的「GitHub Token」与「加速代理」
        // 各自只有一个输入框，现在它们本身就是多值字段（可填多个），
        // 因此不再存在「单值 + 池」两个重复的字段
        tokens: "GitHub token (optional, multiple allowed)",
        proxies: "Acceleration proxy (optional, multiple allowed)",
        endpoint_url: "API endpoint (optional)",
      },
    },

    placeholder: {
      github: {
        token: "ghp_xxx, only used to raise the rate limit",
        gh_proxy: "https://ghproxy.example.com",
        endpoint_url: "https://api.github.com",
      },
    },

    description: {
      github: {
        token:
          "Not needed for public repositories. Providing one raises the GitHub API rate limit so frequent checks are not throttled",
        tokens:
          "Not needed for public repositories. Providing one raises the GitHub API rate limit so frequent checks are not throttled. Leave empty to fall back to the global credential pool; if that is empty too, the anonymous quota is used. With several tokens the scheduler picks dynamically by quota and rate-limit state, so one being throttled does not affect the others",
        proxies:
          "Prepended to the source archive download URL to accelerate downloads. Several can be configured and are combined dynamically at request time rather than pinned together. A failing node is avoided temporarily; when none is usable the request goes direct",
        gh_proxy: "Prepended to the download URL to accelerate source archive downloads",
        endpoint_url: "GitHub Enterprise or self-hosted API endpoint, defaults to https://api.github.com",
      },
    },

    groups: {
      advanced: "Advanced options",
    },

    provider: {
      github: "GitHub",
    },

    history: {
      title: "Backup history",
      refresh: "Refresh",
      empty: "This repository has no backups yet",
      emptyFiltered: "No records match the current filter",
      unresolved: "Version not resolved",
      filter: {
        all: "All",
        success: "Success",
        failed: "Failed",
        running: "Running",
        skipped: "Skipped",
        // 修改点（状态显示不一致修复）：延迟重试单独一档，不再和「已跳过」混在一起
        deferred: "Deferred",
      },
      downloadArchive: "Download snapshot",
      downloadTarget: "Download #{index}",
      prev: "Previous",
      next: "Next",
      pageInfo: "Showing {from} - {to} of {total}",
    },

    delete: {
      title: "Delete repository",
      confirm: "Delete \"{name}\"?",
      hint: "Only the registration and backup records are removed. Snapshot files already uploaded to storage are kept.",
    },

    validation: {
      repoRequired: "Please enter the repository (owner/repo)",
      branchRequired: "Add at least one branch in branch mode",
      mountRequired: "Select at least one backup target mount",
      retentionRange: "Versions to keep must be between {min} and {max}",
      intervalRange: "The backup interval must be between {min} minutes and {max} days",
      cronInvalid: "A cron expression must have 5 fields: minute hour day month weekday (e.g. 30 3 * * *)",
    },

    messages: {
      loadFailed: "Failed to load repositories",
      loadProvidersFailed: "Failed to load repository types",
      loadMountsFailed: "Failed to load mounts",
      saveSuccess: "Saved",
      saveFailed: "Save failed",
      deleteSuccess: "Deleted",
      deleteFailed: "Delete failed",
      toggleFailed: "Failed to toggle state",
      checkFailed: "Failed to check for updates",
      backupCreated: "Backup job created. Check progress in the task list.",
      backupFailed: "Failed to create backup job",
      historyFailed: "Failed to load backup history",
      downloadFailed: "Failed to get the download link",
    },
  },
};
