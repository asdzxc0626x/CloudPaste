// Repositories (new feature)
export default {
  repoBackup: {
    title: "Repositories",
    subtitle:
      "Register external code repositories, watch them by branch or release, and back up source snapshots to one or more storage mounts",

    toolbar: {
      create: "Add Repository",
      refresh: "Refresh",
      refreshing: "Refreshing...",
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

      advancedSection: "Advanced options",
      enabled: "Enable this repository (disabled repositories cannot be backed up)",
      saving: "Saving...",
      show: "Show",
      hide: "Hide",
    },

    fields: {
      github: {
        token: "GitHub token (optional)",
        gh_proxy: "Acceleration proxy (optional)",
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
