// SQLite/D1 schema 版本号（逻辑版本）
// 说明：
// - `app-v01..app-vNN` 的 NN 上限来自这里
// - 这里的版本号用于“迁移编排”，不与具体数据库方言强绑定

// 修改点（仓库备份优化）：35 -> 36，多分支 / 多备份目标 / 版本保留数 + code_repository_backup_targets
// 修改点（仓库备份优化）：36 -> 37，为存量代码仓库回填各自的备份计划（scheduled_jobs 行）
export const APP_SCHEMA_VERSION = 37;

// 兼容命名：历史代码中使用 DB_SCHEMA_VERSION
export const DB_SCHEMA_VERSION = APP_SCHEMA_VERSION;
