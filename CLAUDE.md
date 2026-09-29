# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

CloudPaste 是无服务器（Serverless）文件管理与 Markdown 分享工具：多存储聚合、30+ 格式在线预览、WebDAV 挂载。前端 Vue 3 + Vite SPA，后端 Hono，可部署为：Cloudflare Workers 一体化（前后端同一 Worker，推荐）、前后端分离（Workers + Pages）、Docker/Node、Vercel。

代码注释、提交信息、文档以中文为主，新增代码请保持中文注释风格，并在修改处明确标注修改点。

## 常用命令

### 后端（`backend/`）

```bash
npm install
npm run dev              # wrangler dev --local，监听 8787（需在 wrangler.toml 填 D1 database_id）
npm run dev:scheduled    # 同上，额外启用 --test-scheduled 以本地触发 cron
npm run deploy           # wrangler publish（分离式后端）
npm run deploy:spa       # wrangler deploy --config wrangler.spa.toml（一体化：后端 + 前端静态资源）
npm run docker-dev       # Node 直跑（tsx unified-entry.js），PORT=8787，DATA_DIR=./data
npm run docker-start     # Node 直跑，DATA_DIR=/data（容器内使用）
npm test                 # node --test --test-concurrency=1（见下方「测试」说明）
```

部署到 Cloudflare 前需要在 `wrangler.toml` / `wrangler.spa.toml` 中设置 `database_id`（CI 会自动创建并回填）。`ENCRYPTION_SECRET` 必填，缺失时 Workers 入口与 Node 入口都会直接抛错。

### 前端（`frontend/`）

```bash
npm install
npm run dev        # Vite，监听 3000，自动打开；/api 代理到 VITE_BACKEND_URL 或 http://localhost:8787
npm run build      # 产物 frontend/dist（enabled PWA）
npm run preview
npm run lint       # eslint src --ext .js,.vue（eslint.config.cjs，flat config）
npm run clean      # 清理依赖/缓存
npm run vercel-build  # Vercel 专用：生成 public/config.js 后构建
```

一体化部署时 `frontend/dist` 由 `backend/wrangler.spa.toml` 的 `[assets]` 托管（`run_worker_first = ["/api/*", "/dav/*"]`），因此构建顺序必须是：先构建前端，再执行 `npm run deploy:spa`。

### Docker

```bash
docker compose up -d                                            # 使用已发布镜像
docker build -t cloudpaste-backend:custom -f docker/backend/Dockerfile .   # 自定义构建（在仓库根目录执行）
docker build -t cloudpaste-frontend:custom -f docker/frontend/Dockerfile .
```

### 测试

后端测试运行器是 Node 内置 `node:test`：`npm test` 跑全量（串行），`npm run test:parallel` 并行；单文件用 `node --test src/xxx.test.js`。注意：当前仓库中不存在任何 `*.test.js` / `*.spec.js` 文件，前端也没有测试脚本——增加测试时需自行建立文件与目录约定。

## 架构

### 运行时：一套代码、两种宿主

入口是 `backend/unified-entry.js`，通过 `typeof caches.default !== "undefined"` 判定运行环境：

- **Cloudflare Workers**：导出 `fetch` / `scheduled`；数据库走 D1 binding（`env.DB`），异步作业走 Workflows binding（`JOB_WORKFLOW`），定时任务由 `wrangler.toml` 的 `triggers.crons`（默认 `*/5 * * * *`）驱动。
- **Node / Docker**：用 `@hono/node-server` 起 HTTP 服务，数据库走 `src/adapters/SQLiteAdapter.js`（better-sqlite3 / sqlite3），定时任务由 `node-schedule` 按 `SCHEDULED_TICK_CRON`（默认每分钟）驱动，并附带 cgroup 内存监控与可选 `global.gc()`。

两条路径最终都调用同一个 Hono app（`src/index.js`）和同一套业务代码。**新增功能时不要依赖 Node 专有 API**，除非先做环境分支（可参考 `utils/environmentUtils.js` 与 `StorageFactory.getSupportedTypes()` 的 LOCAL 类型处理）。

首次请求 / 启动时通过 `ensureDatabaseReady()` 触发建库与迁移。

### 数据库抽象与迁移（`backend/src/db/`）

`db/runtime.js` 由 `env.DB_PROVIDER` / `DB_DIALECT` 推导 provider（默认 `sqlite`，另有 `mysql` / `postgres` 骨架），provider 绑定 dialect；`ensureDatabaseReady()` → `provider.ensureReady()` → `applyMigrations()`。

SQLite/D1 的迁移约定见 `db/migrations/sqlite/MigrationReadme.md`，核心规则是「版本号即迁移语义边界」——新增版本时改四处：

1. `engine/version.js`：`APP_SCHEMA_VERSION`（当前 34）自增；
2. `engine/migrations.js`：新增 `case N:`，只写「v(N-1) → vN」的差异（幂等/可重入优先）；
3. `engine/schema.js`（最终态建表）+ `engine/seed.js`（默认配置/数据）同步更新，让新库直接建到最新版本；
4. `backend/schema.sql` 仅作为 schema 快照维护，**不要手工写入 `schema_migrations`**。

### 请求链路与鉴权

`src/index.js` 中中间件顺序固定：`structuredLogger`（输出 JSON 访问日志 + reqId）→ CORS（WebDAV 路径与根路径 OPTIONS 跳过自动 CORS）→ `errorBoundary` → `withRepositories` → `securityContext` → 各路由。

- **Repository 层**：`withRepositories()` 每请求构建 `RepositoryFactory` 并挂在 `c.get("repos")`；业务代码用 `utils/repositories.js` 的 `useRepositories(c)` 获取，禁止自行 `new` 或直接用 `c.env.DB` 写 SQL。
- **鉴权与授权分离**：`securityContext` 只做「解析」——通过 `authGateway.performAuth` 把 `Authorization`（`Bearer <adminToken>` / `ApiKey <key>`）或 `X-Custom-Auth-Key` 解析成 principal（`admin` / `apiKey` / `anonymous`，见 `security/middleware/securityContext.js`），**不做拒绝**；是否放行由 `security/policies` + `authorize` 按策略决定。管理员 principal 的 `authorities` 直接取 `PermissionGroup.ALL_PERMISSIONS`。
- **WebDAV**：`/dav`（`WEBDAV_BASE_PATH`）由 `src/webdav/` 自行实现完整协议方法；根路径 `OPTIONS` 额外返回 DAV 能力声明以兼容 1Panel 等客户端。

### 存储抽象（后端最核心的一层）

`storage/factory/StorageFactory.js` 是驱动注册表：每种 `storage_type`（S3 / WEBDAV / LOCAL / ONEDRIVE / GOOGLE_DRIVE / GITHUB_RELEASES / GITHUB_API / TELEGRAM / DISCORD / HUGGINGFACE_DATASETS / MIRROR）通过 `registerDriver()` 注册 `ctor`、`tester`、`validate`、`capabilities`、`configSchema`、`configProjector`。

- **能力驱动契约**：驱动必须声明 `capabilities`（`storage/interfaces/capabilities/`），`REQUIRED_METHODS_BY_CAPABILITY` 定义了每种能力必须实现的方法。`createDriver()` 会先做 `validateDriverContract()`（类型/能力/方法齐备性），再用 `enforceDriverContract()` 包一层 Proxy，在运行时校验入参与返回值形状。
- **改驱动方法的返回值前必读** `storage/factory/DriverContractEnforcer.js`：它强制校验各方法的返回结构（例如 `copyItem.status` 只能是 `success/skipped/failed` 且禁止出现旧字段 `error`/`success`）、以及「第一个参数 subPath 必须等于 `options.subPath`」等约定。违反会直接抛 `DriverContractError`。
- **仅子路径约定**：驱动只接受挂载点内的相对子路径，挂载点前缀由上层解析/剥离；FS 视图路径（`options.path`）与存储子路径（`subPath`）必须同时传递且保持一致。
- **配置与前端表单**：`configSchema` + `layout` 直接驱动前端渲染存储配置表单（`StorageFactory.getTypeMetadata()` → 前端），`configProjector` 负责把 `config_json` 投影为驱动配置，并用 `withSecrets` 控制是否下发密钥字段。新增/修改字段时前后端会一起变，注意 `requiredOnCreate`、`requiredWhen`、`displayOptions` 等 UI 语义。
- **LOCAL 驱动**只在 Node/Docker 环境注册可见，Workers 下自动隐藏（`getSupportedTypes` / `getAllTypeMetadata`）。

`storage/managers/MountManager.js` 负责按 `storage_mounts` 配置创建并缓存驱动实例：驱动缓存**永不过期**，仅由配置更新主动清理（`MAX_CACHE_SIZE = 12`）。调试缓存命中可设 `DEBUG_DRIVER_CACHE=true`。

### 后台任务与调度

两套并行的「任务」概念，别混淆：

- **编排任务（tasks 表）**：`storage/fs/tasks/`。`JobTypeCatalog` + `registerJobTypes.ts` 声明任务类型（含 `visibility` / `createPolicy` / 前端一键重试能力），`TaskRegistry` + `handlers/` 注册执行器；执行由 `TaskOrchestratorAdapter` 分派——Workers 下走 `WorkflowsTaskOrchestrator`（`workflows/JobWorkflow.ts`，持久化执行），Node 下走 `SQLiteTaskOrchestrator`（`TASK_WORKER_POOL_SIZE` 控制并发，代码默认 10，Docker 镜像设为 2）。
- **调度作业（scheduled_jobs 表）**：`scheduled/ScheduledTaskRegistry.js` 注册（清理上传会话、刷新用量快照、FS 索引重建/增量应用、同步复制等），由 `runDueScheduledJobs()` 在每次 tick 时挑出到期作业执行，运行结果写入 `scheduled_job_runs`。

新增任务类型/调度任务时，必须同时在注册入口登记（`registerTaskHandlers` / `registerJobTypes` / `registerScheduledHandlers`），`validateJobTypesConsistency()` 会在启动时校验一致性。

### 缓存与 FS 搜索索引

`src/cache/` 提供目录缓存、文件夹摘要、URL 缓存、搜索缓存等，失效通过 `cacheBus`（EventEmitter，事件 `cache.invalidate`）广播。FS 搜索索引（`fs_search_index_*`）是**派生数据**：SQLite 用 FTS5 虚表 + `dirty` 队列表，由调度作业异步重建/增量应用，删除或损坏都可重建。

### 边缘反代（可选）

仓库根目录的 `Cloudpaste-Proxy.js` 是一份独立的、与平台无关的边缘反代脚本（Cloudflare Workers / Deno Deploy / Vercel Edge），转发到 CloudPaste 后端。它调用 `/api/proxy/link`，并用与后端 `ENCRYPTION_SECRET` 相同的值做 `/proxy/fs` 的 HMAC 签名。修改后端代理签名逻辑时需同步该文件。

### 前端（`frontend/src/`）

分层与边界由 `eslint.config.cjs` **强制**执行，违反会 lint 报错：

- `api/` 只负责 HTTP（client、config、services），不含业务语义；`@` 别名指向 `src/`。
- `modules/<domain>/` 是领域层：`paste`（文本分享）、`fileshare`（文件分享）、`fs`（挂载文件系统浏览器 MountExplorer）、`upload`（上传控制器）、`storage-core`（存储驱动与 Uppy 装配，低层抽象）、`security`（前端鉴权桥）、`pwa-offline`、`admin`（后台）。每个模块有 `index.js` 作为公共出口。
- `components/` 是跨模块通用 UI 层，**禁止 import `modules/*`**（`import/no-restricted-paths`）；需要领域能力时先在 `modules/<domain>` 内封装领域组件。
- **禁止直接 import `@/modules/storage-core/drivers/*` 与 `@/modules/storage-core/uppy/*`**（`no-restricted-imports`），必须走 `modules/storage-core/index` 或 `modules/upload/shareUploadController`；仅 `modules/storage-core/**`、`modules/upload/**` 与 `modules/fs/components/shared/modals/UppyUploadModal.vue` 豁免。

其余：路由单一入口 `router/index.js`；状态用 Pinia（`stores/`：auth / fileSystem / siteConfig / storageConfigs 等）；国际化 vue-i18n（`i18n/locales`）；样式 Tailwind（`styles/` + `tailwind.config.js`）。

**前端 API 基址解析顺序**（`api/config.js`）：`window.appConfig.backendUrl`（运行时注入）→ localStorage（仅非 Docker）→ `VITE_BACKEND_URL` → 生产环境同源 → `http://localhost:8787`。Docker/Pages 部署时由 `docker/frontend/entrypoint.sh`、`frontend/functions/_middleware.js`、`vercel-build.cjs` 分别替换 `__BACKEND_URL__` 占位符。

## 其他约定

- 接口文档：`Api-doc.md`（总览）、`Api-s3_direct.md`（服务端直传）。
- `README.md` 中提到的 `docs/` 目录在当前仓库中不存在，不要引用。
- 前端 lint 使用 ESLint 9 flat config；后端没有 lint 脚本。
- 提交信息使用中文 conventional commits（如 `fix(storage): ...`、`refactor(storage): ...`）。
