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
import { ValidationError, ConflictError } from "../http/errors.js";
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

  /**
   * 结果提示（修改点：无更新反馈 + 状态显示不一致修复）
   *
   * 四种结论分别给话，重点是「无更新」必须被明确说成一次**成功**的检查结果：
   * 原先是「已是最新备份版本」，虽然不算错，但既没提「检查完成」，
   * 也没和「检测失败」「还没检查过」区分开，用户点完按钮容易以为没生效。
   * 限流/延迟与失败各自保留真实状态，不混进成功口径。
   */
  let message;
  switch (result.outcome) {
    case "up_to_date":
      message = `检查完成，当前已是最新版本（${result.checkedCount} 个引用）`;
      break;
    case "update_available":
      message = result.failedCount > 0
        ? `检测到新版本，但有 ${result.failedCount} 个分支检查失败`
        : "检测到新版本，可以备份";
      break;
    case "failed":
      message = "全部跟踪分支检查失败，请查看错误详情";
      break;
    case "deferred":
    default:
      // 限流 / 上游暂时不可用：既不是失败，也没有拿到有效结论
      message = result.hasUpdate
        ? `检测到新版本，另有 ${result.deferredCount} 个分支因上游限流已安排自动重试`
        : `${result.deferredCount || result.checkedCount} 个分支因上游限流或暂时不可用未能检查，已安排自动重试（不算失败）`;
      break;
  }
  // 部分失败仍然要提示，不能因为整体有结论就把它吞掉
  if (result.failedCount > 0 && result.outcome !== "failed" && result.outcome !== "update_available") {
    message = `${message}；另有 ${result.failedCount} 个分支检查失败`;
  }

  return jsonOk(c, result, message);
});

/**
 * 触发一次备份（创建作业，异步执行）
 *
 * 修改点（第 4 期）：创建的是 repo_backup_check 而不是 repo_backup。
 *
 * 为什么手动备份也要先走检测：
 * - 需求「备份任务不再重复调用 GitHub 版本 API」对手动路径同样成立。
 *   若这里直接建 repo_backup，备份任务就必须自己解析版本 —— 又回到
 *   「同一个版本被解析两次」的老路。
 * - 检测任务解析一次、落库、再把 commitSha 交给备份任务，全链路只打一次 GitHub。
 * - force 透传给检测任务：force=true 时它会把全部检测成功的引用都交给备份任务，
 *   并把 force 一起传下去，忽略 commitSha 去重重新下载 —— 原有「强制备份」语义不变。
 *
 * 返回值里的 jobId 变成检测作业的 ID（前端只用它定位任务，不依赖 taskType），
 * 备份作业会在检测完成后由检测任务自动创建，两者都出现在「任务管理」里。
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

  /**
   * 修改点（第 5 期 重复任务优化）：手动路径补上与定时路径相同的并发守卫。
   *
   * 定时备份由 ScheduledRepoBackupTask 挡住「上一次检测仍在进行」，手动「立即备份」
   * 原先没有任何守卫，连点几次就会建出多个检测作业，同一仓库的 GitHub 请求叠在一起
   * （既浪费额度，也让「当前到底在跑哪一个」变得不可知）。
   * activeJobCount 由 getRepository 一并算出，含检测与备份两类作业；
   * 超期残留的作业有 6 小时窗口兜底，不会永久挡住用户。
   */
  if (Number(repo.activeJobCount) > 0) {
    throw new ConflictError(
      `该仓库已有 ${repo.activeJobCount} 个任务正在进行中，请等待其结束后再试`,
    );
  }

  const mountManager = new MountManager(db, encryptionSecret, repositoryFactory, { env });
  const fileSystem = new FileSystem(mountManager, env);

  const job = await fileSystem.createJob(
    "repo_backup_check",
    {
      repositoryId: id,
      // 修改点（任务列表显示仓库名）：payload 里带上 owner/repo，
      // 让「任务管理」列表不必反查仓库表就能显示具体仓库
      repoIdentifier: repo.repoIdentifier,
      createBackup: true,
      // 手动触发：无视退避，立刻检测全部跟踪引用
      ignoreDue: true,
      // 修改点（手动备份在历史里看不到记录）：标明这是用户点出来的一次备份尝试，
      // 于是即使结论是「已是最新、无需备份」也会在备份历史里留一条记录
      manual: true,
      force,
    },
    adminId,
    UserType.ADMIN,
    { triggerType: "manual", triggerRef: "admin/repo-backup/backup" },
  );

  return jsonOk(
    c,
    { jobId: job.jobId, taskType: job.taskType, repositoryId: id, force },
    // 修改点（第 4 期）：措辞与实际行为对齐 —— 先建的是检测作业，
    // 发现新版本后才会接着建备份作业（force 时无条件接着建）
    force ? "强制备份作业已创建（先检测版本，随后开始备份）" : "已创建版本检测作业，检测到新版本后会自动开始备份",
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
