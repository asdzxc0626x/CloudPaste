/**
 * 代码仓库备份 - 管理端路由（修改点：新增功能）
 *
 * 访问控制：全部要求管理员（usePolicy("admin.all")），与 fs-index / scheduled-jobs 一致
 */

import { Hono } from "hono";
import { UserType } from "../constants/index.js";
import { jsonOk, jsonCreated } from "../utils/common.js";
import { usePolicy } from "../security/policies/policies.js";
import { resolvePrincipal } from "../security/helpers/principal.js";
import { ValidationError } from "../http/errors.js";
import { getEncryptionSecret } from "../utils/environmentUtils.js";
import { MountManager } from "../storage/managers/MountManager.js";
import { FileSystem } from "../storage/fs/FileSystem.js";
import {
  getProviderMetadata,
  listRepositories,
  getRepository,
  createRepository,
  updateRepository,
  setRepositoryEnabled,
  deleteRepository,
  checkRepository,
  listBackups,
  getBackupDownloadLink,
  // 修改点（第 3 期 3-B）：全局 GitHub 凭据池
  getGlobalCredentialPool,
  updateGlobalCredentialPool,
} from "../services/codeRepositoryService.js";

const codeRepositoryRoutes = new Hono();
const requireAdmin = usePolicy("admin.all");

/** 统一解析请求上下文中的公共依赖 */
const resolveContext = (c) => ({
  db: c.env.DB,
  repositoryFactory: c.get("repos"),
  encryptionSecret: getEncryptionSecret(c),
  env: c.env,
});

/** 解析分页参数 */
const parsePaging = (c) => {
  const limitRaw = c.req.query("limit");
  const offsetRaw = c.req.query("offset");
  const limit = limitRaw ? Number(limitRaw) : 50;
  const offset = offsetRaw ? Number(offsetRaw) : 0;
  return {
    limit: Number.isFinite(limit) ? limit : 50,
    offset: Number.isFinite(offset) ? offset : 0,
  };
};

// ==================== Provider 元数据 ====================

/**
 * 获取支持的代码仓库类型及其配置 schema
 * - 前端据此动态渲染表单，避免硬编码 GitHub 字段
 */
codeRepositoryRoutes.get("/api/admin/repo-backup/providers", requireAdmin, async (c) => {
  return jsonOk(c, getProviderMetadata(), "获取代码仓库类型成功");
});

// ==================== 仓库 CRUD ====================

codeRepositoryRoutes.get("/api/admin/repo-backup/repositories", requireAdmin, async (c) => {
  const { db, repositoryFactory, encryptionSecret, env } = resolveContext(c);
  const items = await listRepositories(db, repositoryFactory, encryptionSecret, env);
  return jsonOk(c, items, "获取代码仓库列表成功");
});

// ==================== 全局 GitHub 凭据池（修改点：第 3 期 3-B）====================

/**
 * 读取全局 Token / 代理池
 *
 * 默认返回掩码；`?reveal=plain` 才下发明文。语义与存储配置的
 * `GET /api/admin/storage/:id?reveal=plain` 保持一致，并且同样写一条
 * 不含明文的审计日志 —— 明文只在管理员显式请求时出现。
 */
codeRepositoryRoutes.get("/api/admin/repo-backup/credentials", requireAdmin, async (c) => {
  const { db, encryptionSecret } = resolveContext(c);
  const identity = resolvePrincipal(c, { allowedTypes: [UserType.ADMIN] });

  const reveal = c.req.query("reveal");
  const revealPlain = reveal === "plain";

  const pool = await getGlobalCredentialPool(db, encryptionSecret, { reveal: revealPlain ? "plain" : null });

  if (revealPlain) {
    // 简要审计日志：只记谁在什么时候看了明文，不记明文本身
    console.log(
      JSON.stringify({
        type: "repo_backup.credentials.reveal",
        scope: "global",
        adminId: identity?.userId ?? null,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  return jsonOk(c, pool, "获取全局 GitHub 凭据池成功");
});

/**
 * 保存全局 Token / 代理池（整体保存）
 * - 前端每次提交完整的池；掩码值会被还原成原值，不会因为「只改备注」而抹掉 Token
 */
codeRepositoryRoutes.put("/api/admin/repo-backup/credentials", requireAdmin, async (c) => {
  const { db, encryptionSecret } = resolveContext(c);
  resolvePrincipal(c, { allowedTypes: [UserType.ADMIN] });

  const body = await c.req.json().catch(() => ({}));
  const pool = await updateGlobalCredentialPool(db, encryptionSecret, body);
  return jsonOk(c, pool, "全局 GitHub 凭据池已保存");
});

codeRepositoryRoutes.get("/api/admin/repo-backup/repositories/:id", requireAdmin, async (c) => {
  const { db, repositoryFactory, encryptionSecret, env } = resolveContext(c);
  const { id } = c.req.param();

  // 修改点（第 3 期 3-B）：仓库级凭据池同样支持显式 reveal（仅管理员）
  const revealPlain = c.req.query("reveal") === "plain";
  const repo = await getRepository(db, repositoryFactory, encryptionSecret, id, env, {
    reveal: revealPlain ? "plain" : null,
  });

  if (revealPlain) {
    const identity = resolvePrincipal(c, { allowedTypes: [UserType.ADMIN] });
    console.log(
      JSON.stringify({
        type: "repo_backup.credentials.reveal",
        scope: "repository",
        repositoryId: id,
        adminId: identity?.userId ?? null,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  return jsonOk(c, repo, "获取代码仓库成功");
});

codeRepositoryRoutes.post("/api/admin/repo-backup/repositories", requireAdmin, async (c) => {
  const { db, repositoryFactory, encryptionSecret, env } = resolveContext(c);
  resolvePrincipal(c, { allowedTypes: [UserType.ADMIN] });

  const body = await c.req.json().catch(() => ({}));
  const repo = await createRepository(db, repositoryFactory, encryptionSecret, body, env);
  return jsonCreated(c, repo, "代码仓库添加成功");
});

codeRepositoryRoutes.put("/api/admin/repo-backup/repositories/:id", requireAdmin, async (c) => {
  const { db, repositoryFactory, encryptionSecret, env } = resolveContext(c);
  resolvePrincipal(c, { allowedTypes: [UserType.ADMIN] });

  const { id } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  const repo = await updateRepository(db, repositoryFactory, encryptionSecret, id, body, env);
  return jsonOk(c, repo, "代码仓库已更新");
});

codeRepositoryRoutes.delete("/api/admin/repo-backup/repositories/:id", requireAdmin, async (c) => {
  const { db, repositoryFactory, env } = resolveContext(c);
  resolvePrincipal(c, { allowedTypes: [UserType.ADMIN] });

  const { id } = c.req.param();
  const result = await deleteRepository(db, repositoryFactory, id, env);
  return jsonOk(c, result, "代码仓库已删除（已上传的备份文件保留）");
});

/** 启用 / 禁用 */
codeRepositoryRoutes.post("/api/admin/repo-backup/repositories/:id/enable", requireAdmin, async (c) => {
  const { db, repositoryFactory, env } = resolveContext(c);
  resolvePrincipal(c, { allowedTypes: [UserType.ADMIN] });

  const { id } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  if (typeof body?.enabled !== "boolean") {
    throw new ValidationError("enabled 必须是布尔值");
  }

  const result = await setRepositoryEnabled(db, repositoryFactory, id, body.enabled, env);
  return jsonOk(c, result, body.enabled ? "代码仓库已启用" : "代码仓库已禁用");
});

// ==================== 检查更新 / 手动备份 ====================

/**
 * 检查仓库是否有更新（同步执行，只查版本不下载）
 * 修改点（多分支优化）：返回逐分支结果，部分分支失败也能拿到其余分支的状态
 */
codeRepositoryRoutes.post("/api/admin/repo-backup/repositories/:id/check", requireAdmin, async (c) => {
  const { db, repositoryFactory, encryptionSecret, env } = resolveContext(c);
  resolvePrincipal(c, { allowedTypes: [UserType.ADMIN] });

  const { id } = c.req.param();
  const result = await checkRepository(db, repositoryFactory, encryptionSecret, id, env);

  let message = result.hasUpdate ? "检测到新版本" : "已是最新备份版本";
  if (result.failedCount > 0) {
    message = result.hasUpdate
      ? `检测到新版本，但有 ${result.failedCount} 个分支检查失败`
      : `有 ${result.failedCount} 个分支检查失败`;
  }
  if (result.allFailed) message = "全部跟踪分支检查失败，请查看错误详情";

  return jsonOk(c, result, message);
});

/**
 * 触发一次备份（创建 repo_backup 作业，异步执行）
 */
codeRepositoryRoutes.post("/api/admin/repo-backup/repositories/:id/backup", requireAdmin, async (c) => {
  const { db, repositoryFactory, encryptionSecret, env } = resolveContext(c);
  const { userId: adminId } = resolvePrincipal(c, { allowedTypes: [UserType.ADMIN] });

  const { id } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  const force = body?.force === true;

  // 仓库不存在时这里会抛 NotFound，避免创建注定失败的作业
  const repo = await getRepository(db, repositoryFactory, encryptionSecret, id, env);
  if (!repo.enabled) {
    throw new ValidationError("该代码仓库已禁用，请先启用后再备份");
  }

  const mountManager = new MountManager(db, encryptionSecret, repositoryFactory, { env });
  const fileSystem = new FileSystem(mountManager, env);

  const job = await fileSystem.createJob(
    "repo_backup",
    // 修改点（任务列表显示仓库名）：payload 里带上 owner/repo，
    // 让「任务管理」列表不必反查仓库表就能显示具体仓库
    { repositoryId: id, repoIdentifier: repo.repoIdentifier, force },
    adminId,
    UserType.ADMIN,
    { triggerType: "manual", triggerRef: "admin/repo-backup/backup" },
  );

  return jsonOk(
    c,
    { jobId: job.jobId, taskType: job.taskType, repositoryId: id, force },
    "备份作业已创建",
  );
});

// ==================== 备份记录 ====================

codeRepositoryRoutes.get("/api/admin/repo-backup/repositories/:id/backups", requireAdmin, async (c) => {
  const { db, repositoryFactory, env } = resolveContext(c);
  const { id } = c.req.param();

  // 修改点（历史记录需显示失败记录）：?status=failed 或 ?status=failed,partial 按状态筛选
  const statusRaw = c.req.query("status") || "";
  const statuses = statusRaw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const result = await listBackups(db, repositoryFactory, id, { ...parsePaging(c), statuses }, env);
  return jsonOk(c, result, "获取备份记录成功");
});

/**
 * 获取备份快照（或 manifest）的下载链接
 * - ?manifest=true 时返回 manifest.json 的链接
 * - ?targetId=<id> 时从指定目标的副本下载（修改点：多备份目标优化）
 */
codeRepositoryRoutes.get("/api/admin/repo-backup/backups/:backupId/link", requireAdmin, async (c) => {
  const { db, repositoryFactory, encryptionSecret, env } = resolveContext(c);
  const { userId: adminId } = resolvePrincipal(c, { allowedTypes: [UserType.ADMIN] });

  const { backupId } = c.req.param();
  const wantManifest = c.req.query("manifest") === "true";
  const targetId = c.req.query("targetId") || null;

  const mountManager = new MountManager(db, encryptionSecret, repositoryFactory, { env });
  const fileSystem = new FileSystem(mountManager, env);

  const link = await getBackupDownloadLink(
    db,
    repositoryFactory,
    fileSystem,
    backupId,
    { manifest: wantManifest, targetId, userId: adminId, userType: UserType.ADMIN },
    env,
  );

  return jsonOk(c, link, "获取下载链接成功");
});

export default codeRepositoryRoutes;
