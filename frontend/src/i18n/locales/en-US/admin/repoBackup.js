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
    },

    trackMode: {
      branch: "Branch commit",
      release: "Release / Tag",
    },

    check: {
      hasUpdate: "New version detected, ready to back up",
      upToDate: "Latest version already backed up",
      allFailed: "All tracked branches failed to check",
      partialFailed: "({count} branches failed to check)",
      refHasUpdate: "This branch has an unbacked version",
      refUpToDate: "This branch is up to date",
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
      // 修改点（第 3 期 3-B 交互重做）：单框连续录入的提示与各项 title
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
        token: "GitHub token (optional)",
        gh_proxy: "Acceleration proxy (optional)",
        // 修改点（第 3 期 3-B）
        tokens: "Repository token pool (optional)",
        proxies: "Repository proxy pool (optional)",
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
          "Leave empty to fall back to the global credential pool; if that is empty too, the anonymous quota is used. With several tokens the scheduler picks dynamically by quota and rate-limit state, so one being throttled does not affect the others",
        proxies:
          "Kept separate from the token pool and combined dynamically at request time rather than pinned together. A failing node is avoided temporarily; when none is usable the request goes direct",
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
