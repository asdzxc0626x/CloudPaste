// Repository backup (new feature)
export default {
  repoBackup: {
    title: "Repository Backup",
    subtitle:
      "Back up source snapshots of external code repositories to a configured storage mount, protecting against repository deletion or suspension",

    toolbar: {
      create: "Add Repository",
      refresh: "Refresh",
      refreshing: "Refreshing...",
    },

    table: {
      repository: "Repository",
      track: "Tracked Version",
      target: "Backup Target",
      lastBackup: "Last Backup",
      actions: "Actions",
      empty: 'No repositories registered yet. Click "Add Repository" to start',
      loading: "Loading...",
      checkedAt: "Checked at",
      neverBackedUp: "Never backed up",
      mountMissing: "Mount not found",
    },

    status: {
      disabled: "Disabled",
    },

    backupStatus: {
      running: "Running",
      success: "Success",
      failed: "Failed",
      skipped: "Skipped",
    },

    trackMode: {
      branch: "Branch Commit",
      release: "Release / Tag",
    },

    check: {
      hasUpdate: "New version {version} found, ready to back up",
      upToDate: "Latest version {version} is already backed up",
    },

    actions: {
      check: "Check Updates",
      backup: "Back Up Now",
      backupDisabledHint: "Repository is disabled, enable it first",
      history: "History",
      edit: "Edit",
      enable: "Enable",
      disable: "Disable",
      delete: "Delete",
    },

    // Shared button labels (common.save / common.delete do not exist in that namespace)
    buttons: {
      cancel: "Cancel",
      save: "Save",
      delete: "Delete",
    },

    form: {
      createTitle: "Add Repository",
      editTitle: "Edit Repository",
      provider: "Repository Type",
      providerLocked: "Repository type cannot be changed after creation",
      repoIdentifier: "Repository",
      repoIdentifierPlaceholder: "owner/repo",
      repoIdentifierHint: "Accepts owner/repo or a full repository URL. Phase one supports public repositories only",
      name: "Display Name",
      namePlaceholder: "Leave empty to use owner/repo",
      trackMode: "Track Mode",
      trackModeHint: {
        branch: "Track the latest commit on a specific branch",
        release: "Track the latest Release; falls back to the latest tag when no Release exists",
      },
      branch: "Branch",
      tag: "Specific Tag",
      tagPlaceholder: "Empty = latest Release",
      tagHint: "Leave empty to always take the latest Release",
      targetSection: "Backup Target",
      targetMount: "Target Mount",
      targetMountHint: "Only writable mounts are listed (read-only storages cannot be backup targets)",
      selectMount: "Select a mount",
      noWritableMount: 'No writable mount available. Add one in "Mount Management" first',
      pathPrefix: "Path Prefix",
      pathPrefixHint: "Directory inside the mount, defaults to root. Each repository gets its own subdirectory",
      advancedSection: "Advanced",
      enabled: "Enable this repository (disabled repositories cannot be backed up)",
      saving: "Saving...",
      show: "Show",
      hide: "Hide",
    },

    fields: {
      github: {
        token: "GitHub Token (optional)",
        gh_proxy: "Download Proxy (optional)",
        endpoint_url: "API Endpoint (optional)",
      },
    },

    placeholder: {
      github: {
        token: "ghp_xxx, only used to raise rate limits",
        gh_proxy: "https://ghproxy.example.com",
        endpoint_url: "https://api.github.com",
      },
    },

    description: {
      github: {
        token: "Not required for public repositories. Raises the GitHub API rate limit to avoid throttling on frequent checks",
        gh_proxy: "Prepended to the download URL to speed up archive downloads",
        endpoint_url: "GitHub Enterprise or self-hosted API base, defaults to https://api.github.com",
      },
    },

    groups: {
      advanced: "Advanced",
    },

    provider: {
      github: "GitHub",
    },

    history: {
      title: "Backup History",
      refresh: "Refresh",
      empty: "No backup records for this repository yet",
      downloadArchive: "Download",
      prev: "Previous",
      next: "Next",
      pageInfo: "{from} - {to} of {total}",
    },

    delete: {
      title: "Delete Repository",
      confirm: 'Delete "{name}"?',
      hint: "Only the registration and backup records are removed. Snapshot files already uploaded to storage are kept.",
    },

    validation: {
      repoRequired: "Please enter the repository (owner/repo)",
      branchRequired: "Branch name is required in branch mode",
      mountRequired: "Please select a backup target mount",
    },

    messages: {
      loadFailed: "Failed to load repositories",
      loadProvidersFailed: "Failed to load repository types",
      loadMountsFailed: "Failed to load mounts",
      saveSuccess: "Saved successfully",
      saveFailed: "Save failed",
      deleteSuccess: "Deleted successfully",
      deleteFailed: "Delete failed",
      toggleFailed: "Failed to change status",
      checkFailed: "Failed to check for updates",
      backupCreated: 'Backup job created. Track progress in "Tasks"',
      backupFailed: "Failed to create backup job",
      historyFailed: "Failed to load backup history",
      downloadFailed: "Failed to get download link",
    },
  },
};
