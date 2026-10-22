import { test } from "node:test";
import assert from "node:assert/strict";
import { StorageFactory } from "../../factory/StorageFactory.js";
import { S3StorageDriver } from "./S3StorageDriver.js";

function driverWithPages(pages, config = {}) {
  const requests = [];
  const driver = new S3StorageDriver({ bucket_name: "test-bucket", enable_disk_usage: 1, ...config }, "secret");
  driver.initialized = true;
  driver.s3Client = {
    async send(command, options) {
      assert.equal(command.constructor.name, "ListObjectsV2Command");
      requests.push(command.input);
      assert.ok(options.abortSignal);
      const page = pages.shift();
      if (page instanceof Error) throw page;
      assert.ok(page, "unexpected extra list request");
      return page;
    },
  };
  return { driver, requests };
}

test("S3 usage sums every page, including repository archives and nested external files", async () => {
  const { driver, requests } = driverWithPages([
    { IsTruncated: true, NextContinuationToken: "page-2", Contents: Array.from({ length: 1000 }, (_, i) => ({ Key: `external/${i}`, Size: 2 })) },
    { IsTruncated: false, Contents: [{ Key: "backups/repo/commit.tar.gz", Size: 40 }, { Key: "folder/", Size: 0 }] },
  ]);
  const stats = await driver.getStats();
  assert.equal(stats.supported, true);
  assert.equal(stats.quota.usedBytes, 2040);
  assert.equal(stats.quota.totalBytes ?? null, null);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].Bucket, "test-bucket");
  assert.equal(requests[0].MaxKeys, 1000);
  assert.equal(requests[0].Delimiter, undefined);
  assert.equal(requests[0].Prefix, undefined);
  assert.equal(requests[1].ContinuationToken, "page-2");
});

test("S3 usage normalizes the configured root prefix, not the default upload folder", async () => {
  const { driver, requests } = driverWithPages([{ IsTruncated: false, Contents: [{ Key: "backups/repo/a", Size: 9 }] }], {
    root_prefix: "/backups//repo/", default_folder: "uploads",
  });
  assert.equal((await driver.getStats()).quota.usedBytes, 9);
  assert.equal(requests[0].Prefix, "backups/repo/");
});

test("S3 disabled usage never lists objects", async () => {
  const { driver, requests } = driverWithPages([], { enable_disk_usage: 0 });
  const stats = await driver.getStats();
  assert.equal(stats.supported, false);
  assert.equal(requests.length, 0);
});

test("an empty S3 bucket has a measured zero usage", async () => {
  const { driver } = driverWithPages([{ IsTruncated: false }]);
  assert.equal((await driver.getStats()).quota.usedBytes, 0);
});

for (const [name, pages] of [
  ["list permission failure", [new Error("AccessDenied")]],
  ["second-page failure", [{ IsTruncated: true, NextContinuationToken: "next", Contents: [{ Key: "a", Size: 30 }] }, new Error("AccessDenied")]],
  ["missing continuation token", [{ IsTruncated: true, Contents: [{ Key: "a", Size: 30 }] }]],
  ["repeated continuation token", [{ IsTruncated: true, NextContinuationToken: "next" }, { IsTruncated: true, NextContinuationToken: "next" }]],
  ["missing object size", [{ IsTruncated: false, Contents: [{ Key: "a" }] }]],
  ["negative object size", [{ IsTruncated: false, Contents: [{ Key: "a", Size: -1 }] }]],
  ["missing pagination status", [{}]],
]) {
  test(`S3 usage rejects ${name} rather than returning a partial total`, async () => {
    const { driver } = driverWithPages(pages);
    await assert.rejects(driver.getStats());
  });
}

test("an aborted S3 scan cannot return a successful snapshot", async () => {
  const { driver } = driverWithPages([{ IsTruncated: false, Contents: [{ Key: "a", Size: 2 }] }]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(driver.getStats({ abortSignal: controller.signal }));
});

test("S3 scans stop at the page limit without publishing an incomplete total", async () => {
  const { driver, requests } = driverWithPages(Array.from({ length: 500 }, (_, i) => ({
    IsTruncated: true, NextContinuationToken: `page-${i + 1}`, Contents: [{ Key: `a-${i}`, Size: 1 }],
  })));
  await assert.rejects(driver.getStats(), /500/);
  assert.equal(requests.length, 500);
});

test("stored S3 usage and root prefix survive config projection with secrets protected", () => {
  const config = StorageFactory.projectConfig("S3", { root_prefix: "backups/", enable_disk_usage: true, secret_access_key: "hidden" });
  assert.equal(config.root_prefix, "backups/");
  assert.equal(config.enable_disk_usage, 1);
  assert.equal(config.secret_access_key, undefined);
  const metadata = StorageFactory.getTypeMetadata("S3");
  assert.ok(metadata.configSchema.fields.some((f) => f.name === "enable_disk_usage" && f.type === "boolean"));
});
