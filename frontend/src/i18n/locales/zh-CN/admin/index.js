import common from "./common.js";
import dashboard from "./dashboard.js";
import mount from "./mount.js";
import key from "./key.js";
import settings from "./settings.js";
import backup from "./backup.js";
import fsMeta from "./fsMeta.js";
import fsIndex from "./fsIndex.js";
import tasks from "./tasks.js";
import storage from "./storage.js";
import scheduledJobs from "./scheduledJobs.js";
import paste from "./paste.js";
import fileshare from "./fileshare.js";
// 修改点（代码仓库备份功能）
import repoBackup from "./repoBackup.js";

export default {
  ...common,
  ...dashboard,
  ...mount,
  ...key,
  ...settings,
  ...backup,
  ...fsMeta,
  ...fsIndex,
  ...tasks,
  ...storage,
  ...scheduledJobs,
  ...paste,
  ...fileshare,
  ...repoBackup,
};
