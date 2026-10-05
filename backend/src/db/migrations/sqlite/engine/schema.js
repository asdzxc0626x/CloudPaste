import { DbTables } from "../../../../constants/index.js";

/**
 * SQLite/D1 表结构与索引（engine）
 *
 */

const MIGRATIONS_TABLE = "schema_migrations";

export async function createMigrationTables(db) {
  console.log(`创建迁移执行历史表 ${MIGRATIONS_TABLE}...`);

  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `,
    )
    .run();
}

export async function createPasteTables(db) {
  console.log("创建文本分享相关表...");

  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.PASTES} (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        content TEXT NOT NULL,
        title TEXT,
        remark TEXT,
        password TEXT,
        expires_at DATETIME,
        max_views INTEGER,
        views INTEGER DEFAULT 0,
        is_public BOOLEAN NOT NULL DEFAULT 1,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `
    )
    .run();

  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.PASTE_PASSWORDS} (
        paste_id TEXT PRIMARY KEY,
        plain_password TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (paste_id) REFERENCES ${DbTables.PASTES}(id) ON DELETE CASCADE
      )
    `
    )
    .run();

  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_pastes_is_public ON ${DbTables.PASTES}(is_public)`).run();
}

export async function createAdminTables(db) {
  console.log("创建管理员相关表...");

  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.ADMINS} (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `
    )
    .run();

  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.ADMIN_TOKENS} (
        token TEXT PRIMARY KEY,
        admin_id TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (admin_id) REFERENCES ${DbTables.ADMINS}(id) ON DELETE CASCADE
      )
    `
    )
    .run();

  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.API_KEYS} (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        key TEXT UNIQUE NOT NULL,
        permissions INTEGER DEFAULT 0,
        role TEXT DEFAULT 'GENERAL',
        basic_path TEXT DEFAULT '/',
        is_enable BOOLEAN DEFAULT 0,
        last_used DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL
      )
    `
    )
    .run();
}

export async function createStorageTables(db) {
  console.log("创建存储相关表...");

  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.STORAGE_CONFIGS} (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        storage_type TEXT NOT NULL,
        admin_id TEXT,
        is_public INTEGER NOT NULL DEFAULT 0,
        is_default INTEGER NOT NULL DEFAULT 0,
        remark TEXT,
        url_proxy TEXT,
        status TEXT NOT NULL DEFAULT 'ENABLED',
        config_json TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_used DATETIME
      )
    `
    )
    .run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_storage_admin ON ${DbTables.STORAGE_CONFIGS}(admin_id)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_storage_type ON ${DbTables.STORAGE_CONFIGS}(storage_type)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_storage_public ON ${DbTables.STORAGE_CONFIGS}(is_public)`).run();
  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_default_per_admin ON ${DbTables.STORAGE_CONFIGS}(admin_id) WHERE is_default = 1`).run();

  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.PRINCIPAL_STORAGE_ACL} (
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        storage_config_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (subject_type, subject_id, storage_config_id)
      )
    `
    )
    .run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_psa_storage_config_id ON ${DbTables.PRINCIPAL_STORAGE_ACL}(storage_config_id)`).run();

  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.STORAGE_MOUNTS} (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        storage_type TEXT NOT NULL,
        storage_config_id TEXT,
        mount_path TEXT NOT NULL,
        remark TEXT,
        is_active BOOLEAN DEFAULT 1,
        created_by TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        cache_ttl INTEGER DEFAULT 300,
        web_proxy BOOLEAN DEFAULT 0,
        webdav_policy TEXT DEFAULT '302_redirect',
        enable_sign BOOLEAN DEFAULT 0,
        sign_expires INTEGER DEFAULT NULL,
        enable_folder_summary_compute BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used DATETIME
      )
    `
    )
    .run();
}

export async function createFileTables(db) {
  console.log("创建文件相关表...");

  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.FILES} (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        filename TEXT NOT NULL,

        -- 存储引用（支持多存储类型）
        storage_config_id TEXT NOT NULL,
        storage_type TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        file_path TEXT,

        -- 文件元数据
        mimetype TEXT NOT NULL,
        size INTEGER NOT NULL,
        etag TEXT,

        -- 分享控制（保持现有功能）
        remark TEXT,
        password TEXT,
        expires_at DATETIME,
        max_views INTEGER,
        views INTEGER DEFAULT 0,
        use_proxy BOOLEAN DEFAULT 0,

        -- 元数据
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `
    )
    .run();

  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.FILE_PASSWORDS} (
        file_id TEXT PRIMARY KEY,
        plain_password TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (file_id) REFERENCES ${DbTables.FILES}(id) ON DELETE CASCADE
      )
    `
    )
    .run();
}

export async function createFsMetaTables(db) {
  console.log("创建 FS 目录 Meta 表...");

  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.FS_META} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,

        header_markdown TEXT NULL,
        header_inherit BOOLEAN NOT NULL DEFAULT 0,

        footer_markdown TEXT NULL,
        footer_inherit BOOLEAN NOT NULL DEFAULT 0,

        hide_patterns TEXT NULL,
        hide_inherit BOOLEAN NOT NULL DEFAULT 0,

        password TEXT NULL,
        password_inherit BOOLEAN NOT NULL DEFAULT 0,

        extra JSON NULL,

        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `
    )
    .run();

  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_fs_meta_path ON ${DbTables.FS_META}(path)`).run();
}

export async function createFsSearchIndexTables(db) {
  console.log("创建 FS 搜索索引表（trigram）...");

  // 1) 条目表（派生数据）
  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.FS_SEARCH_INDEX_ENTRIES} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mount_id TEXT NOT NULL,
        fs_path TEXT NOT NULL,
        name TEXT NOT NULL,
        is_dir BOOLEAN NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0,
        modified_ms INTEGER NOT NULL DEFAULT 0,
        mimetype TEXT,
        index_run_id TEXT,
        updated_at_ms INTEGER NOT NULL DEFAULT 0,
        UNIQUE (mount_id, fs_path)
      )
    `,
    )
    .run();

  // 2) 状态表（派生数据）
  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.FS_SEARCH_INDEX_STATE} (
        mount_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        last_indexed_ms INTEGER,
        updated_at_ms INTEGER NOT NULL,
        last_error TEXT
      )
    `,
    )
    .run();

  // 3) dirty 队列（派生数据）：用于增量更新批处理
  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.FS_SEARCH_INDEX_DIRTY} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mount_id TEXT NOT NULL,
        fs_path TEXT NOT NULL,
        op TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE
      )
    `,
    )
    .run();

  // 4) FTS5（trigram）虚表：external content + triggers 同步
  // 注意：
  // - D1 环境下建议使用小写 fts5（社区反馈存在解析/权限怪癖）
  // - 该表为派生结构，备份/导出不作为事实来源
  await db
    .prepare(
      `
      CREATE VIRTUAL TABLE IF NOT EXISTS ${DbTables.FS_SEARCH_INDEX_FTS}
      USING fts5(
        name,
        fs_path,
        tokenize='trigram',
        content='${DbTables.FS_SEARCH_INDEX_ENTRIES}',
        content_rowid='id'
      )
    `,
    )
    .run();

  // 同步触发器（external content table 维护方式）
  await db
    .prepare(
      `
      CREATE TRIGGER IF NOT EXISTS fs_search_index_ai
      AFTER INSERT ON ${DbTables.FS_SEARCH_INDEX_ENTRIES}
      BEGIN
        INSERT INTO ${DbTables.FS_SEARCH_INDEX_FTS}(rowid, name, fs_path)
        VALUES (new.id, new.name, new.fs_path);
      END;
    `,
    )
    .run();

  await db
    .prepare(
      `
      CREATE TRIGGER IF NOT EXISTS fs_search_index_ad
      AFTER DELETE ON ${DbTables.FS_SEARCH_INDEX_ENTRIES}
      BEGIN
        INSERT INTO ${DbTables.FS_SEARCH_INDEX_FTS}(${DbTables.FS_SEARCH_INDEX_FTS}, rowid, name, fs_path)
        VALUES ('delete', old.id, old.name, old.fs_path);
      END;
    `,
    )
    .run();

  await db
    .prepare(
      `
      CREATE TRIGGER IF NOT EXISTS fs_search_index_au
      AFTER UPDATE ON ${DbTables.FS_SEARCH_INDEX_ENTRIES}
      BEGIN
        INSERT INTO ${DbTables.FS_SEARCH_INDEX_FTS}(${DbTables.FS_SEARCH_INDEX_FTS}, rowid, name, fs_path)
        VALUES ('delete', old.id, old.name, old.fs_path);
        INSERT INTO ${DbTables.FS_SEARCH_INDEX_FTS}(rowid, name, fs_path)
        VALUES (new.id, new.name, new.fs_path);
      END;
    `,
    )
    .run();

  // entries 的结构化索引：用于过滤/排序/seek 分页/清理
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_fs_search_entries_mount_path ON ${DbTables.FS_SEARCH_INDEX_ENTRIES}(mount_id, fs_path)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_fs_search_entries_mount_modified ON ${DbTables.FS_SEARCH_INDEX_ENTRIES}(mount_id, modified_ms DESC, id DESC)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_fs_search_entries_modified ON ${DbTables.FS_SEARCH_INDEX_ENTRIES}(modified_ms DESC, id DESC)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_fs_search_entries_mount_run ON ${DbTables.FS_SEARCH_INDEX_ENTRIES}(mount_id, index_run_id)`).run();

  // dirty 队列索引：批处理与清理
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_fs_search_dirty_mount ON ${DbTables.FS_SEARCH_INDEX_DIRTY}(mount_id, created_at_ms ASC)`).run();

  console.log("FS 搜索索引表创建完成");
}

export async function createSystemTables(db) {
  console.log("创建系统设置表...");

  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.SYSTEM_SETTINGS} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        description TEXT,
        type TEXT DEFAULT 'string',
        group_id INTEGER DEFAULT 1,
        options TEXT,
        sort_order INTEGER DEFAULT 0,
        flags INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `
    )
    .run();
}

export async function createTasksTables(db) {
  console.log("创建任务编排相关表...");

  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.TASKS} (
        -- 核心标识
        task_id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        stats TEXT NOT NULL DEFAULT '{}',
        error_message TEXT,
        user_id TEXT NOT NULL,
        user_type TEXT NOT NULL,
        trigger_type TEXT NOT NULL DEFAULT 'manual',
        trigger_ref TEXT,
        workflow_instance_id TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER
      )
    `,
    )
    .run();

  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON ${DbTables.TASKS}(status, created_at DESC)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_type_status ON ${DbTables.TASKS}(task_type, status)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_user ON ${DbTables.TASKS}(user_id, created_at DESC)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON ${DbTables.TASKS}(workflow_instance_id) WHERE workflow_instance_id IS NOT NULL`).run();

  console.log("任务编排表创建完成");
}

export async function createScheduledJobsTables(db) {
  console.log("创建后台调度作业表 scheduled_jobs...");

  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.SCHEDULED_JOBS} (
        task_id              TEXT PRIMARY KEY,
        handler_id           TEXT,
        name                 TEXT,
        description          TEXT,
        enabled              INTEGER NOT NULL,
        schedule_type        TEXT NOT NULL DEFAULT 'interval',
        interval_sec         INTEGER,
        cron_expression      TEXT,
        run_count            INTEGER NOT NULL DEFAULT 0,
        failure_count        INTEGER NOT NULL DEFAULT 0,
        last_run_status      TEXT,
        last_run_started_at  DATETIME,
        last_run_finished_at DATETIME,
        next_run_after       DATETIME,
        lock_until           DATETIME,
        config_json          TEXT NOT NULL DEFAULT '{}',
        created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `,
    )
    .run();

  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_next_run ON ${DbTables.SCHEDULED_JOBS}(enabled, next_run_after)`).run();

  console.log("scheduled_jobs 表检查/创建完成");
}

export async function createScheduledJobRunsTables(db) {
  console.log("创建后台调度作业运行日志表 scheduled_job_runs...");

  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.SCHEDULED_JOB_RUNS} (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id       TEXT NOT NULL,
        status        TEXT NOT NULL,
        trigger_type  TEXT,
        scheduled_at  DATETIME,
        started_at    DATETIME NOT NULL,
        finished_at   DATETIME,
        duration_ms   INTEGER,
        summary       TEXT,
        error_message TEXT,
        details_json  TEXT,
        created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `,
    )
    .run();

  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_task_started ON ${DbTables.SCHEDULED_JOB_RUNS}(task_id, started_at DESC)`).run();

  console.log("scheduled_job_runs 表检查/创建完成");
}

export async function createUploadSessionsTables(db) {
  console.log("创建上传会话相关表...");

  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.UPLOAD_SESSIONS} (
        id TEXT PRIMARY KEY,

        -- 主体与目标信息
        user_id TEXT NOT NULL,
        user_type TEXT NOT NULL,
        storage_type TEXT NOT NULL,
        storage_config_id TEXT NOT NULL,
        mount_id TEXT,
        fs_path TEXT NOT NULL,
        source TEXT NOT NULL,

        -- 文件级元数据
        file_name TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        mime_type TEXT,
        checksum TEXT,

        -- 文件指纹（用于跨驱动/跨会话识别同一逻辑文件）
        fingerprint_algo TEXT,
        fingerprint_value TEXT,

        -- 策略与进度
        strategy TEXT NOT NULL,
        part_size INTEGER NOT NULL,
        total_parts INTEGER NOT NULL,
        bytes_uploaded INTEGER NOT NULL DEFAULT 0,
        uploaded_parts INTEGER NOT NULL DEFAULT 0,
        next_expected_range TEXT,

        -- provider 会话信息（驱动私有）
        provider_upload_id TEXT,
        provider_upload_url TEXT,
        provider_meta TEXT,

        -- 会话状态与错误
        status TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,

        -- 生命周期
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME
      )
    `,
    )
    .run();

  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_upload_sessions_user ON ${DbTables.UPLOAD_SESSIONS}(user_id, user_type)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_upload_sessions_storage ON ${DbTables.UPLOAD_SESSIONS}(storage_type, storage_config_id)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_upload_sessions_mount_path ON ${DbTables.UPLOAD_SESSIONS}(mount_id, fs_path)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_upload_sessions_status ON ${DbTables.UPLOAD_SESSIONS}(status, updated_at DESC)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_upload_sessions_source ON ${DbTables.UPLOAD_SESSIONS}(source)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_upload_sessions_fingerprint ON ${DbTables.UPLOAD_SESSIONS}(fingerprint_value)`).run();

  console.log("上传会话表创建完成");
}

export async function createVfsTables(db) {
  console.log("创建 VFS 索引表...");

  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.VFS_NODES} (
        id TEXT PRIMARY KEY,

        -- 多用户隔离预留
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,

        -- 归属作用域（用于“无目录树后端”的虚拟目录树真相）
        -- - scope_type='mount'：传统挂载维度（scope_id=storage_mounts.id）
        -- - scope_type='storage_config'：无挂载也可用（scope_id=storage_configs.id）
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,

        -- 目录树结构
        -- root 约定：root 本身不占记录；root 下子节点使用 parent_id = ''（空字符串）
        parent_id TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        node_type TEXT NOT NULL,

        -- 展示/元信息
        mime_type TEXT,
        size INTEGER,
        hash_algo TEXT,
        hash_value TEXT,
        status TEXT NOT NULL DEFAULT 'active',

        -- 内容后端定位
        storage_type TEXT NOT NULL,
        content_ref TEXT,

        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

        UNIQUE (owner_type, owner_id, scope_type, scope_id, parent_id, name)
      )
    `,
    )
    .run();

  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_vfs_nodes_scope ON ${DbTables.VFS_NODES}(owner_type, owner_id, scope_type, scope_id, parent_id)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_vfs_nodes_scope_id ON ${DbTables.VFS_NODES}(scope_type, scope_id)`).run();

  console.log("vfs_nodes 表检查/创建完成");
}

export async function createMetricsCacheTables(db) {
  console.log("创建通用指标缓存表(metrics_cache)...");

  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.METRICS_CACHE} (
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        metric_key TEXT NOT NULL,

        value_num INTEGER,
        value_text TEXT,
        value_json_text TEXT,

        snapshot_at_ms INTEGER,
        updated_at_ms INTEGER NOT NULL,

        error_message TEXT,

        PRIMARY KEY (scope_type, scope_id, metric_key)
      )
    `,
    )
    .run();

  // 索引
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_metrics_cache_scope ON ${DbTables.METRICS_CACHE}(scope_type, scope_id)`).run();

  console.log("metrics_cache 表检查/创建完成");
}

export async function createUploadPartsTables(db) {
  console.log("创建上传分片明细表(upload_parts)...");

  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.UPLOAD_PARTS} (
        id TEXT PRIMARY KEY,
        upload_id TEXT NOT NULL,
        part_no INTEGER NOT NULL,

        byte_start INTEGER,
        byte_end INTEGER,
        size INTEGER NOT NULL,

        checksum_algo TEXT,
        checksum TEXT,

        storage_type TEXT NOT NULL,
        provider_part_id TEXT,
        provider_meta TEXT,

        status TEXT NOT NULL DEFAULT 'uploaded',
        error_code TEXT,
        error_message TEXT,

        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

        UNIQUE (upload_id, part_no)
      )
    `,
    )
    .run();

  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_upload_parts_upload_part_no ON ${DbTables.UPLOAD_PARTS}(upload_id, part_no)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_upload_parts_updated_at ON ${DbTables.UPLOAD_PARTS}(updated_at)`).run();

  console.log("upload_parts 表检查/创建完成");
}

/**
 * 代码仓库备份相关表（修改点：新增功能）
 * - code_repositories：登记的代码仓库（provider 中立，第一阶段仅 github）
 * - code_repository_backups：每次备份的记录（按 commit_sha 去重）
 */
export async function createCodeRepositoryTables(db) {
  console.log("创建代码仓库备份表(code_repositories/code_repository_backups)...");

  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.CODE_REPOSITORIES} (
        id TEXT PRIMARY KEY,

        provider TEXT NOT NULL,                        -- 'github'（预留 gitlab/gitea）
        name TEXT,                                     -- 展示名（可选，默认取 repo_identifier）
        repo_identifier TEXT NOT NULL,                 -- 'owner/repo'

        track_mode TEXT NOT NULL DEFAULT 'branch',     -- 'branch' | 'release'
        track_ref TEXT,                                -- 主跟踪引用：branch 模式为第一个分支名；release 模式为 tag（空=最新）
        -- 修改点（多分支优化）：分支模式支持一次跟踪多个分支，这里存 JSON 数组；track_ref 保留为兼容用的“主分支”
        track_refs_json TEXT NOT NULL DEFAULT '[]',    -- 例：["main","develop"]

        target_mount_id TEXT NOT NULL,                 -- 主备份目标挂载点（storage_mounts.id），兼容旧字段
        -- 修改点（多备份目标优化）：一次备份同步写入多个挂载点，这里存 JSON 数组；target_mount_id 为第一个目标
        target_mount_ids_json TEXT NOT NULL DEFAULT '[]',
        target_path_prefix TEXT NOT NULL DEFAULT '/',  -- 挂载点内路径前缀
        -- 修改点（版本保留优化）：每个仓库最多保留多少个成功版本，超出后自动删除最旧的
        retention_count INTEGER NOT NULL DEFAULT 10,

        enabled INTEGER NOT NULL DEFAULT 1,            -- 1=启用, 0=禁用
        config_json TEXT NOT NULL DEFAULT '{}',        -- provider 私有配置（token 等敏感字段加密存储）

        last_checked_at DATETIME,                      -- 最近一次检查更新的时间
        last_backup_at DATETIME,                       -- 最近一次成功备份的时间
        last_known_commit_sha TEXT,                    -- 最近一次成功备份的 commit sha（去重参考）
        last_error TEXT,                               -- 最近一次失败原因

        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `,
    )
    .run();

  // 同一 provider + 仓库 + 跟踪模式只允许登记一次（分支集合在记录内部以数组表达）
  // 修改点（多分支优化）：原唯一索引基于单个 track_ref，多分支下已不适用，
  // 改为普通索引 + 服务层查重（同时避免存量数据存在重复时迁移失败）
  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_code_repositories_identity
       ON ${DbTables.CODE_REPOSITORIES}(provider, repo_identifier, track_mode)`,
    )
    .run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_code_repositories_enabled ON ${DbTables.CODE_REPOSITORIES}(enabled)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_code_repositories_mount ON ${DbTables.CODE_REPOSITORIES}(target_mount_id)`).run();

  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.CODE_REPOSITORY_BACKUPS} (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,                   -- 对应 code_repositories.id

        ref_type TEXT,                                 -- 'branch' | 'tag'
        ref TEXT,                                      -- 分支名或 tag 名
        commit_sha TEXT NOT NULL,                      -- 去重键
        version TEXT,                                  -- 展示用版本串（main@282ea1c7 / v1.9.1）

        status TEXT NOT NULL,                          -- 'running' | 'success' | 'partial' | 'failed' | 'skipped'
                                                       -- partial = 部分目标写入成功（多备份目标时可能出现）

        storage_path TEXT,                             -- 快照在 FS 中的完整路径
        manifest_path TEXT,                            -- manifest.json 的完整路径
        size_bytes INTEGER,                            -- 快照大小（字节，可能未知）

        job_id TEXT,                                   -- 对应 tasks.task_id
        error_message TEXT,

        started_at DATETIME,
        finished_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `,
    )
    .run();

  // 去重的硬保证：同一仓库同一 commit 只允许一条记录
  await db
    .prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_code_repository_backups_repo_commit
       ON ${DbTables.CODE_REPOSITORY_BACKUPS}(repository_id, commit_sha)`,
    )
    .run();
  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_code_repository_backups_repo_created
       ON ${DbTables.CODE_REPOSITORY_BACKUPS}(repository_id, created_at DESC)`,
    )
    .run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_code_repository_backups_job ON ${DbTables.CODE_REPOSITORY_BACKUPS}(job_id)`).run();

  // 修改点（多备份目标优化）：一次备份会写入多个挂载点，每个目标的落盘结果单独一行
  // - 一个目标失败不影响其他目标，失败原因也按目标分别记录
  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.CODE_REPOSITORY_BACKUP_TARGETS} (
        id TEXT PRIMARY KEY,
        backup_id TEXT NOT NULL,                       -- 对应 code_repository_backups.id

        mount_id TEXT NOT NULL,                        -- 目标挂载点（storage_mounts.id）
        mount_path TEXT,                               -- 冗余挂载点路径，便于挂载点被删后仍可读

        storage_path TEXT,                             -- 该目标上的快照完整路径
        manifest_path TEXT,                            -- 该目标上的 manifest 完整路径
        size_bytes INTEGER,                            -- 该目标上的快照大小

        status TEXT NOT NULL,                          -- 'success' | 'failed' | 'skipped'
        error_message TEXT,

        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `,
    )
    .run();

  // 同一备份在同一挂载点上只允许一条结果（重跑时按此做 upsert）
  await db
    .prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_code_repository_backup_targets_unique
       ON ${DbTables.CODE_REPOSITORY_BACKUP_TARGETS}(backup_id, mount_id)`,
    )
    .run();
  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_code_repository_backup_targets_backup
       ON ${DbTables.CODE_REPOSITORY_BACKUP_TARGETS}(backup_id)`,
    )
    .run();

  // 修改点（第 4 期：检测状态持久化）：每仓库 / 每引用一行检测状态
  await createRepoDetectStatesTable(db);

  console.log("code_repositories/code_repository_backups 表检查/创建完成");
}

/**
 * 创建检测状态表（修改点：第 4 期 检测状态持久化）
 *
 * 为什么需要独立一张表，而不是继续用 code_repositories 上的
 * last_checked_at / last_known_commit_sha：
 * - 那两列是「仓库级」的，但检测本来就是「逐引用」的（多分支仓库一次检测
 *   会得到 N 个不同的 commit）。把 N 个结果塞进 1 列，必然丢失信息，
 *   也没法表达「main 已备份、develop 有新版本」这种常态。
 * - 「下次检测时间」必须是逐引用的，否则无法做削峰（见 next_detect_after）。
 *
 * 为什么不复用 metrics_cache（第 3 期额度账本那套）：
 * - metrics_cache 的定位是「可从上游重建的派生数据」，丢了只是少一层保护。
 *   检测状态里的 backed_up_commit_sha 是**判定是否需要备份的唯一依据**，
 *   丢了会导致全量重复备份，不是派生数据，必须独立持久化。
 *
 * 判定「是否有更新」只看一处：commit_sha != backed_up_commit_sha。
 * 不再用 code_repository_backups 做判据（那张表按 commit 去重，
 * 回答不了「这个分支当前水位在哪」），避免两套判定源给出矛盾答案。
 */
export async function createRepoDetectStatesTable(db) {
  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS ${DbTables.REPO_DETECT_STATES} (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,                   -- 对应 code_repositories.id

        ref_type TEXT NOT NULL,                        -- 'branch' | 'tag'
        -- 引用名。release 模式跟踪「最新 tag」时没有固定名字，统一用空串占位：
        -- 唯一索引里 NULL 彼此不相等，用 NULL 会导致同一仓库插出多行
        ref TEXT NOT NULL DEFAULT '',

        -- ---------- 检测结果 ----------
        detect_status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'ok' | 'deferred' | 'error'
        commit_sha TEXT,                               -- 最近一次检测解析到的 commit
        version TEXT,                                  -- 展示用版本串（main@282ea1c7 / v1.9.1）
        published_at DATETIME,                         -- 该版本的提交/发布时间（批量路径下可能为空）

        -- ---------- 已备份水位（判定「是否有更新」的唯一依据）----------
        backed_up_commit_sha TEXT,                     -- 该引用最近一次成功备份的 commit
        backed_up_at DATETIME,

        -- ---------- 时间 ----------
        last_detect_at DATETIME,                       -- 最近一次检测（含失败）
        last_success_detect_at DATETIME,               -- 最近一次检测成功
        -- 下次允许检测的时间。既是「检测进度」的持久化载体（重启不丢），
        -- 也是削峰的闸门：到期的引用才会进入本轮检测
        next_detect_after DATETIME,

        -- ---------- 错误与连续状态 ----------
        last_error TEXT,
        last_error_kind TEXT,                          -- 'rate_limited' | 'transient' | 'permanent'
        consecutive_error_count INTEGER NOT NULL DEFAULT 0,
        -- 连续「检测成功但无更新」的次数。用于退避：长期不动的仓库自动降低检测频率
        consecutive_unchanged_count INTEGER NOT NULL DEFAULT 0,

        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `,
    )
    .run();

  // 一个仓库的同一引用只有一行状态（upsert 的冲突目标）
  await db
    .prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_detect_states_unique
       ON ${DbTables.REPO_DETECT_STATES}(repository_id, ref_type, ref)`,
    )
    .run();
  // 「挑出到期的引用」是最热的查询路径
  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_repo_detect_states_due
       ON ${DbTables.REPO_DETECT_STATES}(next_detect_after)`,
    )
    .run();
  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_repo_detect_states_repo
       ON ${DbTables.REPO_DETECT_STATES}(repository_id)`,
    )
    .run();
  // 修改点（第 5 期 数据库查询优化）：到期查询同时带 repository_id 与 next_detect_after，
  // 单列索引只能收敛一个条件，补复合索引让两个条件都能走索引（存量库由 v39 迁移补建）
  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_repo_detect_states_repo_due
       ON ${DbTables.REPO_DETECT_STATES}(repository_id, next_detect_after)`,
    )
    .run();
}

export async function createIndexes(db) {
  console.log("创建数据库索引...");

  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_next_run ON ${DbTables.SCHEDULED_JOBS}(enabled, next_run_after)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_task_started ON ${DbTables.SCHEDULED_JOB_RUNS}(task_id, started_at DESC)`).run();

  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_pastes_slug ON ${DbTables.PASTES}(slug)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_pastes_created_at ON ${DbTables.PASTES}(created_at DESC)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_pastes_created_by ON ${DbTables.PASTES}(created_by)`).run();

  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_api_keys_key ON ${DbTables.API_KEYS}(key)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_api_keys_role ON ${DbTables.API_KEYS}(role)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_api_keys_permissions ON ${DbTables.API_KEYS}(permissions)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_api_keys_expires_at ON ${DbTables.API_KEYS}(expires_at)`).run();

  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_files_slug ON ${DbTables.FILES}(slug)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_files_storage_config_id ON ${DbTables.FILES}(storage_config_id)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_files_storage_type ON ${DbTables.FILES}(storage_type)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_files_file_path ON ${DbTables.FILES}(file_path)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_files_created_at ON ${DbTables.FILES}(created_at)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_files_expires_at ON ${DbTables.FILES}(expires_at)`).run();

  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_storage_mounts_mount_path ON ${DbTables.STORAGE_MOUNTS}(mount_path)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_storage_mounts_storage_config_id ON ${DbTables.STORAGE_MOUNTS}(storage_config_id)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_storage_mounts_created_by ON ${DbTables.STORAGE_MOUNTS}(created_by)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_storage_mounts_is_active ON ${DbTables.STORAGE_MOUNTS}(is_active)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_storage_mounts_sort_order ON ${DbTables.STORAGE_MOUNTS}(sort_order)`).run();
}

export default {
  createPasteTables,
  createAdminTables,
  createStorageTables,
  createFileTables,
  createFsMetaTables,
  createFsSearchIndexTables,
  createSystemTables,
  createTasksTables,
  createScheduledJobsTables,
  createScheduledJobRunsTables,
  createUploadSessionsTables,
  createVfsTables,
  createUploadPartsTables,
  // 修改点（代码仓库备份功能）：导出新增建表函数
  createCodeRepositoryTables,
  createIndexes,
};
