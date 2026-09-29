import {
  createAdminTables,
  createFileTables,
  createFsMetaTables,
  createFsSearchIndexTables,
  createIndexes,
  createPasteTables,
  createMigrationTables,
  createScheduledJobRunsTables,
  createScheduledJobsTables,
  createStorageTables,
  createSystemTables,
  createTasksTables,
  createMetricsCacheTables,
  createUploadSessionsTables,
  createUploadPartsTables,
  createVfsTables,
  // 修改点（代码仓库备份功能）：新库直接建出仓库备份相关表
  createCodeRepositoryTables,
} from "./schema.js";
import {
  addCustomContentSettings,
  addDefaultProxySetting,
  addFileNamingStrategySetting,
  addPreviewSettings,
  addSiteSettings,
  createDefaultAdmin,
  createDefaultGuestApiKey,
  initDefaultSettings,
} from "./seed.js";

/**
 * SQLite/D1 初始化（legacy）
 *
 */
export async function initDatabase(db) {
  console.log("开始初始化数据库表结构...");

  await createPasteTables(db);
  await createAdminTables(db);
  await createStorageTables(db);
  await createFileTables(db);
  await createFsMetaTables(db);
  await createFsSearchIndexTables(db);
  await createMigrationTables(db);
  await createSystemTables(db);
  await createTasksTables(db);
  await createScheduledJobsTables(db);
  await createScheduledJobRunsTables(db);
  await createUploadSessionsTables(db);
  await createVfsTables(db);
  await createMetricsCacheTables(db);
  await createUploadPartsTables(db);
  // 修改点（代码仓库备份功能）：创建仓库登记表与备份记录表
  await createCodeRepositoryTables(db);

  await createIndexes(db);

  await initDefaultSettings(db);
  await addPreviewSettings(db);
  await addSiteSettings(db);
  await addCustomContentSettings(db);
  await addFileNamingStrategySetting(db);
  await addDefaultProxySetting(db);

  await createDefaultAdmin(db);
  await createDefaultGuestApiKey(db);

  console.log("数据库初始化完成");
}

export default {
  initDatabase,
};
