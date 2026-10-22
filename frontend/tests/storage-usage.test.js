import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import Icons from "unplugin-icons/vite";
import { createSSRApp } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createI18n } from "vue-i18n";
import messages from "../src/i18n/locales/zh-CN/admin/dashboard.js";

const fixtureKey = Symbol.for("cloudpaste.storage-usage.fixture");
let server, Dashboard;
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
before(async () => {
  if (!previousWindow) globalThis.window = { addEventListener() {}, removeEventListener() {} };
  server = await createServer({
    configFile: false,
    plugins: [{
      name: "dashboard-fixtures", enforce: "pre",
      resolveId(id) {
        if (id.endsWith("/services/systemService.js")) return "\0test-system";
        if (id.endsWith("/services/dashboardService.js")) return "\0test-dashboard-service";
        if (id.endsWith("/useThemeMode.js")) return "\0test-theme";
        if (id.endsWith("/useStorageTypePresentation.js")) return "\0test-storage-types";
        if (id === "vue-chartjs") return "\0test-charts";
      },
      load(id) {
        if (id === "\0test-system") return `export const useAdminSystemService = () => ({});`;
        if (id === "\0test-dashboard-service") return `export const useDashboardService = () => ({
          refreshStorageUsageSnapshots: async () => globalThis[Symbol.for("cloudpaste.storage-usage.fixture")].refreshResult,
          getStorageUsageReport: async () => globalThis[Symbol.for("cloudpaste.storage-usage.fixture")].report,
        });`;
        if (id === "\0test-theme") return `export const useThemeMode = () => ({isDarkMode: false});`;
        if (id === "\0test-storage-types") return `export const useStorageTypePresentation = () => ({getTypeLabel: t => t, ensureLoaded: async () => {}});`;
        if (id === "\0test-charts") return `export const Bar = {render: () => null}; export const Line = Bar;`;
      },
      transform(code, id) {
        if (id.endsWith("/DashboardView.vue")) return code.replace("</script>", `
          storageUsageReport.value = globalThis[Symbol.for("cloudpaste.storage-usage.fixture")].report;
          selectedStorageId.value = globalThis[Symbol.for("cloudpaste.storage-usage.fixture")].selected;
          statsData.value.lastWeekPastes = Array(7).fill(0);
          statsData.value.lastWeekFiles = Array(7).fill(0);
          if (globalThis[Symbol.for("cloudpaste.storage-usage.fixture")].refreshResult) await handleRefreshStorageSnapshots();
          </script>`);
      },
    }, vue(), Icons({ compiler: "vue3" })],
    resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
    server: { middlewareMode: true, hmr: false }, appType: "custom",
  });
  ({ default: Dashboard } = await server.ssrLoadModule("/src/modules/admin/views/DashboardView.vue"));
});
after(async () => {
  delete globalThis[fixtureKey];
  await server?.close();
  if (!previousWindow) delete globalThis.window;
});

async function render(storages, selected = "s3", refreshResult = null) {
  globalThis[fixtureKey] = { report: { storages }, selected, refreshResult };
  return renderToString(createSSRApp(Dashboard, { permissions: { isAdmin: true } }).use(createI18n({
    legacy: false, locale: "zh-CN", messages: { "zh-CN": { admin: messages } }, missingWarn: false, fallbackWarn: false,
  })));
}

test("dashboard displays unmeasured S3 usage as unknown with the scan error", async () => {
  const html = await render([{ id: "s3", name: "S3", storageType: "S3", computedUsage: null, usageError: "AccessDenied" }]);
  assert.match(html, /尚未统计/);
  assert.match(html, /AccessDenied/);
});

test("S3 current object usage never displays an invented zero total capacity", async () => {
  const html = await render([{ id: "s3", name: "S3", storageType: "S3", computedUsage: {
    usedBytes: 2048, source: "provider", details: { quota: { usedBytes: 2048, totalBytes: null } },
  } }]);
  assert.match(html, /2 KB/);
  assert.doesNotMatch(html, /总容量:\s*0/);
  assert.doesNotMatch(html, /总容量:\s*尚未统计/);
  assert.doesNotMatch(html, /NaN/, html.match(/.{0,80}NaN.{0,80}/)?.[0]);
});

test("aggregate usage is labeled incomplete when a storage snapshot is missing", async () => {
  const html = await render([{ id: "s3", name: "S3", computedUsage: null }], null);
  assert.match(html, /部分存储尚未统计/);
});

test("manual refresh shows failures even when the HTTP request succeeds", async () => {
  const html = await render([{ id: "s3", name: "S3", computedUsage: { usedBytes: 0 } }], "s3", { failCount: 1 });
  assert.match(html, /用量刷新失败（1）/);
});
