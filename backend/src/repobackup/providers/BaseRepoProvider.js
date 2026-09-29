/**
 * 代码仓库 Provider 基类
 *
 * 设计目标（修改点：新增功能）：
 * - 把「代码仓库」抽象成与平台无关的两个能力：解析最新版本 + 打开源码归档流
 * - 第一阶段只实现 GitHub，后续 GitLab/Gitea 只需继承本类并在工厂注册
 *
 * 为什么不复用 StorageFactory：
 * - StorageFactory 是「网盘驱动」注册表，带完整的 capabilities 契约与 DriverContractEnforcer
 *   运行时校验（listDirectory/uploadFile/generateDownloadUrl 等一整套方法签名）
 * - 代码仓库只需要「查版本」和「取归档流」，语义完全不同，塞进去会被契约校验拦下
 * - 因此这里另立一个轻量注册表，但形态上刻意与 StorageFactory 保持一致，便于阅读
 */

/**
 * @typedef {Object} RepoVersionInfo 统一的版本描述（各 provider 都必须返回这个结构）
 * @property {'branch'|'tag'} refType   引用类型
 * @property {string} ref               分支名或 tag 名
 * @property {string} commitSha         完整 commit sha（去重键）
 * @property {string} version           展示用版本串，如 'main@282ea1c7' 或 'v1.9.1'
 * @property {string|null} publishedAt  版本时间（ISO 字符串），取不到则为 null
 */

/**
 * @typedef {Object} RepoArchive 源码归档流描述
 * @property {ReadableStream} stream       归档字节流（务必是流，不要整包读进内存）
 * @property {string} filename             建议的文件名（含扩展名）
 * @property {string} contentType          MIME 类型
 * @property {number|null} contentLength   已知大小；GitHub tarball 通常为 null
 */

export class BaseRepoProvider {
  /**
   * @param {Object} config  provider 私有配置（已解密）
   */
  constructor(config = {}) {
    /** @type {string} provider 类型标识，子类必须覆盖 */
    this.type = "BASE";
    this.config = config || {};
  }

  /** provider 类型 */
  getType() {
    return this.type;
  }

  /**
   * 解析仓库当前的最新版本
   * @param {{ repoIdentifier: string, trackMode: 'branch'|'release', trackRef: (string|null) }} _params
   * @returns {Promise<RepoVersionInfo>}
   */
  async resolveLatestVersion(_params) {
    throw new Error(`${this.type}: resolveLatestVersion 未实现`);
  }

  /**
   * 打开指定版本的源码归档流
   * @param {{ repoIdentifier: string, refType: 'branch'|'tag', ref: string, commitSha: string }} _params
   * @returns {Promise<RepoArchive>}
   */
  async openSourceArchive(_params) {
    throw new Error(`${this.type}: openSourceArchive 未实现`);
  }
}
