import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import "../../factory/StorageFactory.js";
import { S3StorageDriver } from "./S3StorageDriver.js";
import { S3UploadOperations } from "./operations/S3UploadOperations.js";
import { resolveTransferBudget } from "../../../repobackup/transferBudget.js";

const MIB = 1024 * 1024;

for (const scenario of [
  { name: "Workers 备份默认", worker: true, partMb: 16, queueSize: 2 },
  { name: "Workers 显式分片", worker: true, env: { REPO_BACKUP_UPLOAD_PART_MB: "8" }, partMb: 8, queueSize: 2 },
  { name: "Workers 高并发仅缩小分片", worker: true, env: { REPO_BACKUP_UPLOAD_PART_MB: "64", REPO_BACKUP_UPLOAD_QUEUE_SIZE: "4" }, partMb: 10, queueSize: 4 },
  { name: "Node 备份默认", partMb: 8, queueSize: 4 },
  { name: "Node 显式分片", env: { REPO_BACKUP_UPLOAD_PART_MB: "12" }, partMb: 12, queueSize: 4 },
  { name: "Workers 普通上传", worker: true, ordinary: true, partMb: 6, queueSize: 1 },
]) {
  test(`${scenario.name}：驱动配置实际影响 SDK 分片大小，上传并发及进度事件不变`, async (context) => {
    if (scenario.worker) {
      const previous = Object.getOwnPropertyDescriptor(globalThis, "caches");
      Object.defineProperty(globalThis, "caches", { value: {}, configurable: true });
      context.after(() => {
        if (previous) Object.defineProperty(globalThis, "caches", previous);
        else delete globalThis.caches;
      });
    }
    const budget = resolveTransferBudget(scenario.env ?? {});
    const uploadTuning = scenario.ordinary ? undefined : {
      queueSize: budget.uploadQueueSize || undefined,
      partSize: budget.uploadPartSize || undefined,
    };
    const totalBytes = scenario.partMb * MIB * (scenario.queueSize + 1) + 1;
    let remaining = totalBytes;
    const stream = new ReadableStream({
      pull(controller) {
        if (remaining === 0) { controller.close(); return; }
        const length = Math.min(256 * 1024, remaining);
        remaining -= length;
        controller.enqueue(new Uint8Array(length));
      },
    });
    const partSizes = [];
    const progress = [];
    let active = 0;
    let maxActive = 0;
    const client = {
      config: {},
      async send(command) {
        switch (command.constructor.name) {
          case "CreateMultipartUploadCommand": return { UploadId: "test-upload" };
          case "UploadPartCommand":
            partSizes[command.input.PartNumber - 1] = command.input.Body.byteLength;
            active++;
            maxActive = Math.max(maxActive, active);
            await setTimeout(1);
            active--;
            return { ETag: `"part-${command.input.PartNumber}"` };
          case "CompleteMultipartUploadCommand": return { ETag: '"complete"' };
          default: assert.fail(`Unexpected command: ${command.constructor.name}`);
        }
      },
    };
    const config = { bucket_name: "test", endpoint_url: "https://s3.example.invalid", path_style: 1 };
    const driver = new S3StorageDriver(config, "test-secret");
    driver.uploadOps = new S3UploadOperations(client, config, "test-secret");
    driver.initialized = true;
    const result = await driver.uploadFile("archive.tar.gz", stream, {
      filename: "archive.tar.gz",
      contentType: "application/gzip",
      uploadTuning,
      onBytesProgress: (loaded) => progress.push(loaded),
    });
    assert.equal(result.success, true);
    assert.deepEqual(partSizes, [...Array(scenario.queueSize + 1).fill(scenario.partMb * MIB), 1]);
    assert.equal(maxActive, scenario.queueSize);
    assert.equal(progress.at(-1), totalBytes);
  });
}
