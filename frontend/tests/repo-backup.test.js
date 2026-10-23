import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import Icons from "unplugin-icons/vite";
import { createSSRApp, createRenderer, h, reactive, ssrContextKey } from "vue";
import { renderToString } from "vue/server-renderer";
import { createI18n } from "vue-i18n";
import messages from "../src/i18n/locales/zh-CN/admin/repoBackup.js";

// 修改点（列表回归测试）：复用 Vite 的 Vue/别名支持，只替换 HTTP 边界。
const root = fileURLToPath(new URL("..", import.meta.url));
const requestKey = Symbol.for("cloudpaste.repo-backup.test-request");
const hadNavigator = "navigator" in globalThis;
const hadDocument = "document" in globalThis;
const formApps = [];
let server;
let useRepoBackup;
let RepoBackupTable;
let RepoBackupForm;
before(async () => {
  // Node 20 没有 navigator，真实时间格式化函数需要浏览器语言信息。
  if (!hadNavigator) globalThis.navigator = { language: "zh-CN", languages: ["zh-CN"] };
  if (!hadDocument) globalThis.document = { addEventListener() {}, removeEventListener() {} };
  server = await createServer({
    root,
    configFile: false,
    plugins: [vue(), Icons({ compiler: "vue3" }), {
      name: "repo-backup-test-http",
      enforce: "pre",
      resolveId(source, importer) {
        if (source === "../client" && importer?.includes("/api/services/")) return "\0test-http";
        if (source.replaceAll("\\", "/").endsWith("/src/api")) return "\0test-mounts";
      },
      load(id) {
        if (id === "\0test-http") return `
          const request = (...args) => globalThis[Symbol.for("cloudpaste.repo-backup.test-request")](...args);
          export { request as get, request as post, request as put, request as del };
        `;
        if (id === "\0test-mounts") return `export const api = { mount: { getMountsList: async () => ({ success: true, data: [] }) } };`;
      },
    }],
    resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  ({ useRepoBackup } = await server.ssrLoadModule("/src/modules/admin/composables/useRepoBackup.js"));
  ({ default: RepoBackupTable } = await server.ssrLoadModule("/src/modules/admin/components/repo-backup/RepoBackupTable.vue"));
  ({ default: RepoBackupForm } = await server.ssrLoadModule("/src/modules/admin/components/repo-backup/RepoBackupForm.vue"));
});
after(async () => {
  for (const app of formApps) app.unmount();
  delete globalThis[requestKey];
  await server?.close();
  if (!hadNavigator) delete globalThis.navigator;
  if (!hadDocument) delete globalThis.document;
});

const withI18n = (app) => app.use(createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": { admin: messages } } }));
async function setup() {
  const pending = [];
  globalThis[requestKey] = (endpoint) => {
    const url = new URL(endpoint, "http://test.local");
    assert.equal(url.pathname, "/admin/repo-backup/repositories");
    const request = { params: url.searchParams };
    request.promise = new Promise((resolve, reject) => {
      request.resolve = resolve;
      request.reject = reject;
    });
    pending.push(request);
    return request.promise;
  };
  let state;
  await renderToString(withI18n(createSSRApp({ setup() {
    state = useRepoBackup();
    return () => null;
  } })));
  return { state, pending };
}
const response = (id, total = 1) => ({ success: true, data: { items: id ? [{ id, name: id }] : [], total } });

test("an older page response cannot overwrite the newest search or its total", async () => {
  const { state, pending } = await setup();
  const old = state.loadRepositories();
  const newest = state.handleGlobalSearch("newest");
  pending[1].resolve(response("newest", 3));
  await newest;
  pending[0].resolve(response("old", 20));
  await old;
  assert.equal(state.repositories.value[0].id, "newest");
  assert.equal(state.pagination.total, 3);
  assert.equal(state.error.value, "");
});

test("an older request finishing does not clear loading for the current search", async () => {
  const { state, pending } = await setup();
  const old = state.handleGlobalSearch("older");
  const newest = state.handleGlobalSearch("newest");
  pending[0].resolve(response("old"));
  await old;
  assert.equal(state.loading.value, true);
  assert.equal(state.searchLoading.value, true);
  assert.equal(state.lastRefreshTime.value, "");
  pending[1].resolve(response("newest"));
  await newest;
  assert.equal(state.loading.value, false);
  assert.equal(state.searchLoading.value, false);
});

test("a superseded error cannot replace a successful search with an error", async () => {
  const { state, pending } = await setup();
  const old = state.loadRepositories();
  const newest = state.handleGlobalSearch("newest");
  pending[1].resolve(response("newest"));
  await newest;
  pending[0].reject(new Error("obsolete failure"));
  await old;
  assert.equal(state.error.value, "");
});

test("refresh keeps visible rows and reports the current failure without changing refresh time", async () => {
  const { state, pending } = await setup();
  const initial = state.loadRepositories();
  pending[0].resolve(response("visible"));
  await initial;
  const refreshTime = state.lastRefreshTime.value;
  assert.notEqual(refreshTime, "");
  assert.equal(state.error.value, "");
  const refresh = state.refreshRepositories();
  assert.equal(state.repositories.value[0].id, "visible");
  pending[1].reject(new Error("current failure"));
  await refresh;
  assert.equal(state.repositories.value[0].id, "visible");
  assert.equal(state.error.value, "current failure");
  assert.equal(state.lastRefreshTime.value, refreshTime);
  assert.equal(state.loading.value, false);
});

test("deleting the last page retries once at the last valid offset", async () => {
  const { state, pending } = await setup();
  const load = state.handleOffsetChange(40);
  pending[0].resolve(response(null, 21));
  await new Promise(setImmediate);
  assert.equal(pending[1].params.get("offset"), "20");
  pending[1].resolve(response("last", 21));
  await load;
  assert.equal(state.repositories.value[0].id, "last");
  assert.equal(state.pagination.offset, 20);
  assert.equal(state.loading.value, false);
});

async function renderTable(props) {
  return renderToString(withI18n(createSSRApp({ render: () => h(RepoBackupTable, { isRepoBusy: () => false, ...props }) })));
}

async function setupForm(overrides = {}) {
  let state;
  const submissions = [];
  const props = reactive({ oneOff: true, repo: null, providers: [], writableMounts: [], ...overrides });
  // Keep the setup scope mounted: SSR disposes watchers after renderToString.
  const renderer = createRenderer({ insert() {}, remove() {}, createComment: () => ({}), parentNode: () => null, nextSibling: () => null });
  const app = withI18n(renderer.createApp({ setup() {
    state = RepoBackupForm.setup(props, { expose() {}, emit: (_event, payload) => submissions.push(payload) });
    return () => null;
  } }));
  app.provide(ssrContextKey, {});
  app.mount({});
  formApps.push(app);
  return { state, submissions };
}

const existingRepo = { id: "existing", provider: "github", repoIdentifier: "owner/repo", trackMode: "branch", trackRefs: ["dev"], targetMountIds: ["mount-1"], targetPathPrefix: "/custom", config: { token: "********tail" } };

test("registered repository form loads, submits and explicitly clears remarks", async () => {
  const { state, submissions } = await setupForm({ oneOff: false, repo: { ...existingRepo, remark: "Existing note" } });
  assert.equal(state.formData.remark, "Existing note");
  state.formData.remark = "  Updated\nNote  ";
  state.handleSubmit();
  assert.equal(submissions[0].remark, "Updated\nNote");
  state.formData.remark = "";
  state.handleSubmit();
  assert.equal(submissions[1].remark, "");
});

test("new repository remarks start empty and cannot submit more than 500 characters", async () => {
  const { state, submissions } = await setupForm({ oneOff: false, writableMounts: [{ id: "mount-1" }] });
  assert.equal(state.formData.remark, "");
  state.formData.repoIdentifier = "owner/new";
  state.formData.remark = "x".repeat(501);
  state.handleSubmit();
  assert.equal(submissions.length, 0);
  assert.match(state.displayError.value, /500/);
  state.formData.remark = "x".repeat(500);
  state.handleSubmit();
  assert.equal(submissions[0].remark.length, 500);
});

test("remarks render as escaped text in desktop rows and mobile cards", async () => {
  const html = await renderTable({ repositories: [{ ...existingRepo, name: "Repository", remark: '<script>alert("note")</script>\nSecond line' }] });
  assert.equal((html.match(/&lt;script&gt;/g) || []).length, 2);
  assert.equal((html.match(/Second line/g) || []).length, 2);
  assert.doesNotMatch(html, /<script>/);
});

test("remark textarea is labeled and limited in create/edit, absent from one-off forms", async () => {
  for (const repo of [null, { ...existingRepo, remark: "Existing note" }]) {
    const context = {};
    await renderToString(withI18n(createSSRApp({ render: () => h(RepoBackupForm, { repo, writableMounts: [{ id: "mount-1" }] }) })), context);
    assert.match(context.teleports.body, /<label[^>]*for="repo-remark"/);
    assert.match(context.teleports.body, /<textarea[^>]*maxlength="500"/);
    if (repo) assert.match(context.teleports.body, /Existing note<\/textarea>/);
  }
  const context = {};
  await renderToString(withI18n(createSSRApp({ render: () => h(RepoBackupForm, { oneOff: true, repo: existingRepo }) })), context);
  assert.doesNotMatch(context.teleports.body, /id="repo-remark"/);
});

test("returning to the original repository while defaults load does not leave submit disabled", async () => {
  let resolveDefaults;
  const { state, submissions } = await setupForm({ repo: existingRepo, loadDefaults: () => new Promise((resolve) => { resolveDefaults = resolve; }) });
  state.formData.repoIdentifier = "owner/other";
  const lookup = state.applyOneOffDefaults();
  state.formData.repoIdentifier = "owner/repo";
  await state.applyOneOffDefaults();
  resolveDefaults({ ...existingRepo, repoIdentifier: "owner/other" });
  await lookup;
  state.formData.commitSha = "a".repeat(40);
  state.handleSubmit();
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].repoIdentifier, "owner/repo");
});

test("editing repository identity cannot reuse or reveal the previous repository credentials", async () => {
  const { state, submissions } = await setupForm({ repo: existingRepo });
  state.formData.repoIdentifier = "owner/other";
  state.formData.commitSha = "a".repeat(40);
  state.handleSubmit();
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].repositoryId, undefined);
  assert.deepEqual(submissions[0].config, {});
  assert.deepEqual(await state.revealRepoPool("tokens"), []);
});

test("one-off form shows commit inputs and hides scheduling and retention controls", async () => {
  const app = withI18n(createSSRApp({ render: () => h(RepoBackupForm, {
    oneOff: true,
    repo: { id: "existing", provider: "github", repoIdentifier: "owner/repo", trackMode: "branch", trackRefs: ["dev"], targetMountIds: ["mount-1"], targetPathPrefix: "/custom" },
    providers: [{ provider: "github", displayName: "GitHub", defaultPathPrefix: "/Github" }],
    writableMounts: [{ id: "mount-1", mount_path: "/backup" }],
  }) }));
  const context = {};
  await renderToString(app, context);
  const html = context.teleports.body;
  assert.match(html, /Commit SHA/);
  assert.match(html, /value="dev"/);
  assert.match(html, /value="\/custom"/);
  assert.match(html, /仅手动删除/);
  assert.doesNotMatch(html, /type="number"|type="checkbox"|<label[^>]*>保留版本数|启用定时备份/);
});

test("one-off submission calls the separate endpoint, never creates or updates a repository", async () => {
  const { state } = await setup();
  assert.equal(typeof state.openOneOffForm, "function");
  state.openOneOffForm();
  let submitted;
  globalThis[requestKey] = async (endpoint, payload) => {
    assert.equal(endpoint, "/admin/repo-backup/one-off");
    submitted = payload;
    return { success: true, message: "one-shot created", data: { jobId: "job-1" } };
  };
  const payload = { branch: "main", commitSha: "a".repeat(40) };
  assert.equal(await state.submitForm(payload), true);
  assert.deepEqual(submitted, payload);
  assert.equal(state.showForm.value, false);
});

test("initial loading exposes a status and skeleton rather than the empty state", async () => {
  const html = await renderTable({ loading: true });
  assert.match(html, /role="status"/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /motion-safe:animate-pulse/);
  assert.doesNotMatch(html, /还没有登记任何代码仓库/);
});

test("refresh renders existing repositories together with an updating status", async () => {
  const html = await renderTable({ loading: true, repositories: [{
    id: "visible", name: "Visible repository", provider: "github", providerDisplayName: "GitHub",
    repoIdentifier: "owner/visible", trackMode: "branch", trackRefs: ["main"], enabled: true,
    targetMounts: [], retentionCount: 10, latestBackup: null,
  }] });
  assert.match(html, /Visible repository/);
  assert.match(html, /role="status"/);
  assert.match(html, /刷新中/);
});
