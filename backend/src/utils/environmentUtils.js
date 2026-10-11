/**
 * 环境检测和配置工具
 * 用于根据部署环境（Cloudflare Worker vs Docker/Server）提供最优配置
 */

/**
 * 检测当前是否运行在Cloudflare Worker环境
 * @returns {boolean} 是否为Worker环境
 */
export function isCloudflareWorkerEnvironment() {
  // Wrangler 开发环境检测
  // 检测 Wrangler 特征：有 caches 和 Response，但仍有 process（wrangler dev --local）
  if (typeof caches !== "undefined" && typeof Response !== "undefined" && typeof window === "undefined" && typeof process !== "undefined") {
    // 进一步检测是否为 Wrangler 环境
    const hasWorkerFeatures = typeof navigator !== "undefined" && typeof globalThis !== "undefined";
    if (hasWorkerFeatures) {
      return true;
    }
  }

  // 标准 Cloudflare Workers 检测
  return typeof caches !== "undefined" && typeof Response !== "undefined" && typeof process === "undefined" && typeof window === "undefined";
}

/**
 * 分片上传参数的允许区间（修改点：大仓库备份 CPU/耗时优化）
 *
 * 用于夹取调用方传入的覆盖值，避免把 lib-storage 配成非法参数：
 * - S3 协议规定除最后一片外每片不得小于 5MiB，配小了分片上传会被服务端拒绝；
 * - 上限按 Workers 的 128MB 内存反推：峰值约为 partSize × (queueSize + 1)
 *   （在传的 queueSize 片 + 正在攒的下一片）。
 */
const UPLOAD_TUNING_LIMITS = {
  MIN_PART_SIZE: 5 * 1024 * 1024,
  MAX_PART_SIZE: 64 * 1024 * 1024,
  MIN_QUEUE_SIZE: 1,
  MAX_QUEUE_SIZE: 8,
};

/** 取整并夹到区间内；非数字视为「没给」，返回 fallback */
function clampTuning(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * 获取环境自适应的上传配置
 *
 * 修改点（大仓库备份 CPU/耗时优化）：允许调用方按场景覆盖 partSize / queueSize。
 *
 * 为什么要开这个口子：默认值是给「用户在页面上传文件」定的，Workers 下取
 * queueSize = 1。但 lib-storage 的 queueSize 同时决定**消费源流的并发度** ——
 * 只有 1 个消费者时，它必须「读满一片 → 传完这一片 → 再读下一片」，
 * 下载与上传完全串行，整趟耗时是两者之和。仓库备份搬的是几百 MB 的归档，
 * 串行会让单个目标的 wall-clock 翻倍，于是一次运行里能完成的目标更少、
 * 要跑的轮次更多（每多一轮就要把前面的目标重新走一遍判定）。
 * 调用方自己清楚内存余量时，应当能把并发提到 2 让两段重叠。
 *
 * 不改默认值的原因：这里是所有 S3 流式上传的公共入口（含 WebDAV PUT 与页面上传），
 * 默认值一动就是全局行为变化；备份是唯一明确知道自己在搬大文件的调用方。
 *
 * @param {{ partSize?: number, queueSize?: number }|null} [overrides] 覆盖值，
 *        非法/缺省的字段按环境默认值处理
 * @returns {Object} 上传配置对象
 */
export function getEnvironmentOptimizedUploadConfig(overrides = null) {
  const isWorker = isCloudflareWorkerEnvironment();

  const base = isWorker
    ? {
        partSize: 6 * 1024 * 1024, // 6MB - Worker环境内存限制
        queueSize: 1, // 1并发 - 页面上传的保守默认值（备份路径会按需覆盖）
        environment: "Cloudflare Worker",
        maxConcurrency: 1, // 最大并发数
        bufferSize: 6 * 1024 * 1024, // 缓冲区大小
      }
    : {
        partSize: 8 * 1024 * 1024, // 8MB - Docker环境更大分片
        queueSize: 4, // 4并发
        environment: "Docker/Server",
        maxConcurrency: 4, // 最大并发数
        bufferSize: 32 * 1024 * 1024, // 缓冲区大小
      };

  if (!overrides) return base;

  const partSize = clampTuning(
    overrides.partSize,
    UPLOAD_TUNING_LIMITS.MIN_PART_SIZE,
    UPLOAD_TUNING_LIMITS.MAX_PART_SIZE,
    base.partSize,
  );
  const queueSize = clampTuning(
    overrides.queueSize,
    UPLOAD_TUNING_LIMITS.MIN_QUEUE_SIZE,
    UPLOAD_TUNING_LIMITS.MAX_QUEUE_SIZE,
    base.queueSize,
  );

  return {
    ...base,
    partSize,
    queueSize,
    // maxConcurrency 与 queueSize 是同一件事的两个名字，一起跟着走，
    // 避免下游按 maxConcurrency 做判断时拿到和实际并发不符的值
    maxConcurrency: queueSize,
  };
}

export { UPLOAD_TUNING_LIMITS };

/**
 * 获取环境名称
 * @returns {string} 环境名称
 */
export function getEnvironmentName() {
  return isCloudflareWorkerEnvironment() ? "Cloudflare Worker" : "Docker/Server";
}

/**
 * 获取推荐的分片大小
 * @returns {number} 分片大小（字节）
 */
export function getRecommendedPartSize() {
  return isCloudflareWorkerEnvironment() ? 6 * 1024 * 1024 : 8 * 1024 * 1024;
}

/**
 * 获取推荐的并发数
 * @returns {number} 并发数
 */
export function getRecommendedConcurrency() {
  return isCloudflareWorkerEnvironment() ? 1 : 4;
}

/**
 * 获取加密密钥（统一入口）
 * 优先读取环境变量，回退到默认值
 * @param {import('hono').Context} c
 * @returns {string}
 */
export function getEncryptionSecret(c) {
  const secret = (c && c.env && c.env.ENCRYPTION_SECRET) || (typeof process !== "undefined" ? process.env?.ENCRYPTION_SECRET : null);
  if (!secret) {
    throw new Error("ENCRYPTION_SECRET 未配置，请在环境变量中设置一个安全的随机密钥");
  }
  return secret;
}

/**
 * 把各种“真假值”统一转成 boolean
 *
 * @param {any} value
 * @param {boolean} [defaultValue=false]
 */
export function toBool(value, defaultValue = false) {
  if (value === true) return true;
  if (value === false) return false;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true" || lowered === "yes" || lowered === "on") return true;
    if (lowered === "false" || lowered === "no" || lowered === "off") return false;
  }
  return defaultValue;
}

/**
 * 检测当前是否运行在Node.js环境
 * @returns {boolean} 是否为Node.js环境
 */
export function isNodeJSEnvironment() {
  return typeof process !== "undefined" && process.versions && process.versions.node;
}
