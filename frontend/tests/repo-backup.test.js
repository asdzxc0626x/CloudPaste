import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import Icons from "unplugin-icons/vite";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { createI18n } from "vue-i18n";
import messages from "../src/i18n/locales/zh-CN/admin/repoBackup.js";

// 修改点（列表回归测试）：复用 Vite 的 Vue/别名支持，只替换 HTTP 边界。
const root = fileURLToPath(new URL("..", import.meta.url));
const requestKey = Symbol.for("cloudpaste.repo-backup.test-request");
const hadNavigator = "navigator" in globalThis;
let server;
let useRepoBackup;
let RepoBackupTable;
before(async () => {
  // Node 20 没有 navigator，真实时间格式化函数需要浏览器语言信息。
  if (!hadNavigator) globalThis.navigator = { language: "zh-CN", languages: ["zh-CN"] };
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
});
after(async () => {
  delete globalThis[requestKey];
  await server?.close();
  if (!hadNavigator) delete globalThis.navigator;
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
