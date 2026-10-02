/**
 * 代码仓库 Provider 工厂（注册表）
 *
 * 修改点：新增功能
 * - 形态刻意对齐 storage/factory/StorageFactory.js（registerProvider / createProvider /
 *   getTypeMetadata / validateConfig），便于维护者按已有心智模型阅读
 * - 但与 StorageFactory 完全独立：代码仓库不是网盘驱动，不走 capabilities 契约校验
 */

import { ValidationError, NotFoundError } from "../../http/errors.js";
import { GithubRepoProvider } from "./GithubRepoProvider.js";

/**
 * provider 注册表
 * - key: provider 类型（小写，例如 'github'）
 * - value: {
 *     ctor: Function,
 *     displayName: string,
 *     validate: Function|null,
 *     trackModes: string[],
 *     configSchema: object|null,
 *     ui: object|null,
 *   }
 */
const registry = new Map();

export class RepoProviderFactory {
  static SUPPORTED_TYPES = {
    GITHUB: "github",
  };

  /**
   * 注册 provider
   * @param {string} type
   * @param {{ ctor: Function, displayName?: string, validate?: Function|null, trackModes?: string[], configSchema?: object|null, ui?: object|null }} meta
   */
  static registerProvider(type, { ctor, displayName = null, validate = null, trackModes = ["branch", "release"], configSchema = null, ui = null } = {}) {
    if (!type || !ctor) {
      throw new ValidationError("registerProvider 需要提供 type 和 ctor");
    }
    registry.set(type, {
      ctor,
      displayName: displayName || type,
      validate,
      trackModes: Array.isArray(trackModes) && trackModes.length > 0 ? trackModes : ["branch"],
      configSchema: configSchema || null,
      ui: ui || null,
    });
  }

  /**
   * 创建 provider 实例
   * @param {string} providerType
   * @param {Object} config 已解密的 provider 配置
   * @param {{ db?: any, env?: object|null }} [runtime] 运行时依赖（修改点：第 3 期）
   *        第 3 期的请求调度器需要数据库句柄读写跨实例共享的额度账本；
   *        不传时 provider 退化为「只做进程内节流」，原有调用方行为不变。
   * @returns {import("./BaseRepoProvider.js").BaseRepoProvider}
   */
  static createProvider(providerType, config = {}, runtime = {}) {
    if (!providerType) {
      throw new ValidationError("provider 类型不能为空");
    }
    const entry = registry.get(providerType);
    if (!entry) {
      throw new NotFoundError(`不支持的代码仓库类型: ${providerType}`);
    }
    return new entry.ctor(config, runtime);
  }

  static isTypeSupported(providerType) {
    return registry.has(providerType);
  }

  static getSupportedTypes() {
    return Array.from(registry.keys());
  }

  static getDisplayName(providerType) {
    return registry.get(providerType)?.displayName || providerType;
  }

  /**
   * 获取单个 provider 的元数据（前端动态表单用）
   * @param {string} providerType
   */
  static getTypeMetadata(providerType) {
    const entry = registry.get(providerType);
    if (!entry) return null;
    return {
      provider: providerType,
      displayName: entry.displayName,
      trackModes: entry.trackModes,
      configSchema: entry.configSchema,
      ui: entry.ui,
    };
  }

  /**
   * 获取全部 provider 元数据
   * @returns {Array<object>}
   */
  static getAllTypeMetadata() {
    const result = [];
    for (const type of registry.keys()) {
      const meta = RepoProviderFactory.getTypeMetadata(type);
      if (meta) result.push(meta);
    }
    return result;
  }

  /**
   * 校验 provider 配置 + 仓库标识
   * @param {string} providerType
   * @param {{ repoIdentifier?: string, trackMode?: string, trackRef?: string|null, config?: object }} input
   * @returns {{ valid: boolean, errors: string[] }}
   */
  static validateConfig(providerType, input = {}) {
    const entry = registry.get(providerType);
    if (!entry) {
      return { valid: false, errors: [`不支持的代码仓库类型: ${providerType}`] };
    }

    const errors = [];

    // 通用校验：trackMode 必须在 provider 声明的范围内
    const trackMode = input.trackMode || "branch";
    if (!entry.trackModes.includes(trackMode)) {
      errors.push(`track_mode 无效，${entry.displayName} 支持: ${entry.trackModes.join(", ")}`);
    }

    // branch 模式必须指定分支名；release 模式留空表示取最新，是允许的
    if (trackMode === "branch" && !String(input.trackRef || "").trim()) {
      errors.push("track_mode=branch 时必须指定分支名（track_ref）");
    }

    if (typeof entry.validate === "function") {
      const result = entry.validate(input) || {};
      if (Array.isArray(result.errors)) {
        errors.push(...result.errors);
      }
    }

    return { valid: errors.length === 0, errors };
  }
}

// ==================== 注册内建 provider ====================

RepoProviderFactory.registerProvider(RepoProviderFactory.SUPPORTED_TYPES.GITHUB, {
  ctor: GithubRepoProvider,
  displayName: "GitHub",
  trackModes: ["branch", "release"],
  validate: (input) => GithubRepoProvider.validateInput(input),
  ui: {
    icon: "storage-github-api",
    i18nKey: "admin.repoBackup.provider.github",
  },
  configSchema: {
    fields: [
      {
        // 修改点（第 3 期 3-B）：单个 Token 保留为「快速填写」入口，
        // 真正参与调度的是下面的 tokens 池（该字段会被当作池里的第一条）
        name: "token",
        type: "secret",
        required: false,
        labelKey: "admin.repoBackup.fields.github.token",
        ui: {
          fullWidth: true,
          placeholderKey: "admin.repoBackup.placeholder.github.token",
          descriptionKey: "admin.repoBackup.description.github.token",
        },
      },
      {
        // 修改点（第 3 期 3-B）：仓库级 Token 池。
        // 留空则自动使用全局池；全局池也没有时按匿名额度调度。
        name: "tokens",
        type: "secretPool",
        required: false,
        labelKey: "admin.repoBackup.fields.github.tokens",
        ui: {
          fullWidth: true,
          descriptionKey: "admin.repoBackup.description.github.tokens",
          entryLabelKey: "admin.repoBackup.pool.tokenEntry",
          valuePlaceholderKey: "admin.repoBackup.pool.tokenPlaceholder",
          addLabelKey: "admin.repoBackup.pool.addToken",
        },
      },
      {
        // 修改点（第 3 期 3-B）：仓库级加速代理池。
        // 与 Token 池相互独立，调度时动态组合，不固定绑定。
        name: "proxies",
        type: "secretPool",
        required: false,
        labelKey: "admin.repoBackup.fields.github.proxies",
        ui: {
          fullWidth: true,
          descriptionKey: "admin.repoBackup.description.github.proxies",
          entryLabelKey: "admin.repoBackup.pool.proxyEntry",
          valuePlaceholderKey: "admin.repoBackup.pool.proxyPlaceholder",
          addLabelKey: "admin.repoBackup.pool.addProxy",
        },
      },
      {
        name: "gh_proxy",
        type: "string",
        required: false,
        labelKey: "admin.repoBackup.fields.github.gh_proxy",
        validation: { rule: "url" },
        ui: {
          fullWidth: true,
          placeholderKey: "admin.repoBackup.placeholder.github.gh_proxy",
          descriptionKey: "admin.repoBackup.description.github.gh_proxy",
        },
      },
      {
        name: "endpoint_url",
        type: "string",
        required: false,
        defaultValue: "https://api.github.com",
        labelKey: "admin.repoBackup.fields.github.endpoint_url",
        validation: { rule: "url" },
        ui: {
          fullWidth: true,
          placeholderKey: "admin.repoBackup.placeholder.github.endpoint_url",
          descriptionKey: "admin.repoBackup.description.github.endpoint_url",
        },
      },
    ],
    layout: {
      groups: [
        {
          name: "advanced",
          titleKey: "admin.repoBackup.groups.advanced",
          fields: ["token", "tokens", "proxies", "gh_proxy", "endpoint_url"],
        },
      ],
    },
  },
});
