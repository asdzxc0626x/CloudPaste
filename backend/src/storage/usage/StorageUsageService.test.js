import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import "../factory/StorageFactory.js";
import { Hono } from "hono";
import systemRoutes from "../../routes/systemRoutes.js";
import { RefreshStorageUsageSnapshotsTask } from "../../scheduled/tasks/RefreshStorageUsageSnapshotsTask.js";
import { RepositoryFactory } from "../../repositories/index.js";
import { createMetricsCacheTables } from "../../db/migrations/sqlite/engine/schema.js";
import { MetricsCacheRepository } from "../../repositories/MetricsCacheRepository.js";
import { S3StorageDriver } from "../drivers/s3/S3StorageDriver.js";
import { StorageUsageService } from "./StorageUsageService.js";
import { getStorageUsageReport } from "../../services/storageUsageReportService.js";

async function setup(t, config = {}) {
  const raw = new DatabaseSync(":memory:");
  t.after(() => raw.close());
  const db = { prepare(sql) {
    const stmt = raw.prepare(sql);
    let args = [];
    const query = {
      bind(...values) { args = values; return query; },
      async first() { const row = stmt.get(...args); return row ? { ...row } : null; },
      async all() { return { results: stmt.all(...args).map((r) => ({ ...r })) }; },
      async run() { return { meta: { changes: Number(stmt.run(...args).changes) } }; },
    };
    return query;
  } };
  await createMetricsCacheTables(db);
  const cfg = { id: t.name, name: "S3", storage_type: "S3", bucket_name: "test", enable_disk_usage: 1, ...config };
  const metrics = new MetricsCacheRepository(db);
  const factory = {
    getStorageConfigRepository: () => ({ findByIdWithSecrets: async () => cfg, findByAdmin: async () => [cfg] }),
    getMetricsCacheRepository: () => metrics,
  };
  const usage = new StorageUsageService(db, "secret", factory);
  t.mock.method(S3StorageDriver.prototype, "initialize", async function () {
    this.initialized = true;
    this.s3Client = { send: async () => { throw new Error("AccessDenied"); } };
  });
  return { cfg, db, factory, metrics, usage };
}

test("an enabled S3 scan failure preserves the previous measured snapshot and reports failure", async (t) => {
  const { cfg, metrics, usage } = await setup(t);
  await metrics.upsertEntry({ scopeType: "storage_config", scopeId: cfg.id, metricKey: "computed_usage", valueNum: 123, valueText: "provider", snapshotAtMs: 1000 });
  t.mock.method(usage, "getVfsNodesUsedBytes", async () => 1);
  const result = await usage.computeAndPersistSnapshot(cfg.id);
  const row = await metrics.getEntry("storage_config", cfg.id, "computed_usage");
  assert.equal(result.ok, false);
  assert.equal(row.value_num, 123);
  assert.equal(row.value_text, "provider");
  assert.equal(row.snapshot_at_ms, 1000);
  assert.match(row.error_message, /AccessDenied/);
});

test("an initial failed S3 scan stays unknown, not zero or an index estimate", async (t) => {
  const { cfg, db, factory, metrics, usage } = await setup(t);
  t.mock.method(usage, "getVfsNodesUsedBytes", async () => 0);
  const result = await usage.computeAndPersistSnapshot(cfg.id);
  assert.equal(result.ok, false);
  assert.equal((await metrics.getEntry("storage_config", cfg.id, "computed_usage")).value_num, null);
  const report = await getStorageUsageReport(db, "admin", "secret", factory);
  assert.equal(report.storages[0].computedUsage, null);
  assert.match(report.storages[0].usageError, /AccessDenied/);
});

test("manual refresh bypasses cached S3 usage and persists updated object sizes", async (t) => {
  const { cfg, metrics, usage } = await setup(t);
  let bytes = 40;
  t.mock.method(S3StorageDriver.prototype, "initialize", async function () {
    this.initialized = true;
    this.s3Client = { send: async () => ({ IsTruncated: false, Contents: [{ Key: "repo/archive", Size: bytes }] }) };
  });
  assert.equal((await usage.computeAndPersistSnapshot(cfg.id)).computed.usedBytes, 40);
  bytes = 80;
  assert.equal((await usage.computeAndPersistSnapshot(cfg.id)).computed.usedBytes, 80);
  const row = await metrics.getEntry("storage_config", cfg.id, "computed_usage");
  assert.equal(row.value_num, 80);
  assert.equal(JSON.parse(row.value_json_text).quota.totalBytes, null);
  assert.equal(JSON.parse(row.value_json_text).quota.percentUsed, null);
});

test("disabled S3 usage retains the existing index fallback without listing the bucket", async (t) => {
  const { cfg, usage } = await setup(t, { enable_disk_usage: 0 });
  t.mock.method(usage, "getVfsNodesUsedBytes", async () => 77);
  const result = await usage.computeAndPersistSnapshot(cfg.id);
  assert.equal(result.ok, true);
  assert.equal(result.computed.source, "vfs_nodes");
  assert.equal(result.computed.usedBytes, 77);
});

test("a report does not coerce a missing saved usage value to zero", async (t) => {
  const { cfg, db, metrics, factory } = await setup(t);
  await metrics.upsertEntry({ scopeType: "storage_config", scopeId: cfg.id, metricKey: "computed_usage", valueNum: null, valueText: "provider", errorMessage: "scan failed" });
  const report = await getStorageUsageReport(db, "admin", "secret", factory);
  assert.equal(report.storages[0].computedUsage, null);
  assert.equal(report.storages[0].usageError, "scan failed");
});

test("S3 usage timeout aborts the pending list request and preserves the old snapshot", async (t) => {
  const { cfg, metrics, usage } = await setup(t);
  await metrics.upsertEntry({ scopeType: "storage_config", scopeId: cfg.id, metricKey: "computed_usage", valueNum: 55, valueText: "provider", snapshotAtMs: 1000 });
  let signal;
  t.mock.method(S3StorageDriver.prototype, "initialize", async function () {
    this.initialized = true;
    this.s3Client = { send: (_command, options) => {
      signal = options.abortSignal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    } };
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const refresh = usage.computeAndPersistSnapshot(cfg.id);
  for (let i = 0; i < 50 && !signal; i += 1) await Promise.resolve();
  assert.ok(signal, "scan started");
  t.mock.timers.tick(30_000);
  const result = await refresh;
  assert.equal(signal.aborted, true);
  assert.equal(result.ok, false);
  assert.equal((await metrics.getEntry("storage_config", cfg.id, "computed_usage")).value_num, 55);
});

test("manual refresh reports a failed scan count rather than success", async (t) => {
  const { db, factory } = await setup(t);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("principal", { id: "admin", type: "admin", isAdmin: true });
    c.set("repos", factory);
    await next();
  });
  app.route("/", systemRoutes);
  const response = await app.request("/api/admin/storage-usage/refresh", { method: "POST" }, { DB: db, ENCRYPTION_SECRET: "secret" });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.okCount, 0);
  assert.equal(body.data.failCount, 1);
  assert.match(body.data.failures[0].error, /AccessDenied/);
});

test("scheduled refresh counts a failed scan without changing its schedule", async (t) => {
  const { cfg, db } = await setup(t);
  await db.prepare("CREATE TABLE storage_configs (id TEXT, updated_at TEXT)").run();
  await db.prepare("INSERT INTO storage_configs VALUES (?, '2026-10-22')").bind(cfg.id).run();
  t.mock.method(RepositoryFactory.prototype, "getStorageConfigRepository", () => ({ findByIdWithSecrets: async () => cfg }));
  const result = await new RefreshStorageUsageSnapshotsTask().run({ db, env: { ENCRYPTION_SECRET: "secret" }, config: {} });
  assert.equal(result.okCount, 0);
  assert.equal(result.failCount, 1);
});
