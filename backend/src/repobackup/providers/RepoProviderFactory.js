/**
 * 代码仓库 Provider 工厂（注册表）
 *
 * 修改点：新增功能
 * - 形态刻意对齐 storage/factory/StorageFactory.js（registerProvider / createProvider /
 *   getTypeMetadata / validateConfig），便于维护者按已有心智模型阅读
 * - 但与 StorageFactory 完全独立：代码仓库不是网盘驱动，不走 capabilities 契约校验
 */

import { ValidationError, NotFoundError } from "../../http/errors.js";
// 修改点（备份默认目录按仓库源区分）：默认目录与用户手填的前缀走同一套清洗规则
import { normalizePathPrefix } from "../paths.js";
// 修改点（点击 owner/repo 跳转仓库）：GitHub 的网页地址推导随 provider 一起注册
import { GithubRepoProvider, buildGithubRepositoryWebUrl } from "./GithubRepoProvider.js";

/**
 * 规范化 provider 声明的默认备份目录（修改点：备份默认目录按仓库源区分）
 * - 复用 paths.js 的 normalizePathPrefix，保证默认值与用户手填值语义一致；
 *   "." / ".." 之类的非法值会在注册阶段直接抛错，属于开发期就该发现的配置错误
 * - 空值 / 根目录一律折成 "/"，前端与创建接口都按「根目录」理解
 * @param {string|null|undefined} prefix
 * @returns {string} 以 / 开头、不以 / 结尾；根目录为 "/"
 */
function normalizeDefaultPathPrefix(prefix) {
  const raw = String(prefix ?? "").trim();
  if (!raw) return "/";
  return normalizePathPrefix(raw) || "/";
}

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
 *     webUrlBuilder: Function|null,   // (repoIdentifier, config) => string|null
 *     defaultPathPrefix: string|null, // 备份默认落在挂载点的哪个目录，如 "/Github"
 *                                      // （修改点：默认目录改首字母大写，原为 "/GitHub"）
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
   * @param {{ ctor: Function, displayName?: string, validate?: Function|null, trackModes?: string[], configSchema?: object|null, ui?: object|null, webUrlBuilder?: Function|null, defaultPathPrefix?: string|null }} meta
   *        webUrlBuilder（修改点：点击 owner/repo 跳转仓库）—— 把 'owner/repo' 变成可点击的网页地址。
   *        不提供时该 provider 的仓库标识按纯文本展示（不是错误，只是不跳转）。
   *        defaultPathPrefix（修改点：备份默认目录按仓库源区分）—— 该平台的仓库备份默认落在
   *        挂载点的哪个目录，例如 GitHub 用 "/Github"。不提供时回退到根目录 "/"。
   *        命名约定（修改点：默认目录改首字母大写）：目录名一律「首字母大写 + 其余小写」，
   *        即 Github / Gitea / Gitlab 这种写法，而不是品牌官方的大小写（GitHub）。
   *        原因是目录名要跟存量数据保持一致 —— 线上老备份就落在 /Github，
   *        若新默认写成 /GitHub，同一批备份会被拆到两个只差一个字母的目录里
   */
  static registerProvider(type, { ctor, displayName = null, validate = null, trackModes = ["branch", "release"], configSchema = null, ui = null, webUrlBuilder = null, defaultPathPrefix = null } = {}) {
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
      webUrlBuilder: typeof webUrlBuilder === "function" ? webUrlBuilder : null,
      defaultPathPrefix: normalizeDefaultPathPrefix(defaultPathPrefix),
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
   * 构建仓库的网页访问地址（修改点：点击 owner/repo 跳转仓库）
   *
   * 页面上的 owner/repo 是给人看的标识，点击应当跳到对应平台的仓库页：
   * - 官方 GitHub        -> https://github.com/owner/repo
   * - 自建 / Enterprise  -> 由该 provider 的 endpoint_url 反推出的站点地址
   *
   * @param {string} providerType
   * @param {string} repoIdentifier 'owner/repo'
   * @param {Object} [config] provider 配置（只需非敏感的 endpoint_url）
   * @returns {string|null} null = 无法确定，调用方按纯文本展示
   */
  static buildRepositoryWebUrl(providerType, repoIdentifier, config = {}) {
    const builder = registry.get(providerType)?.webUrlBuilder;
    if (typeof builder !== "function") return null;
    try {
      return builder(repoIdentifier, config) || null;
    } catch (error) {
      // 单个仓库推导失败不能让整个列表接口 500（与 fail-open 的既有风格一致）
      console.warn(
        `[repoBackup] 构建仓库网页地址失败 (provider=${providerType}, repo=${repoIdentifier}):`,
        error?.message || error,
      );
      return null;
    }
  }

  /**
   * 获取某 provider 的默认备份目录（修改点：备份默认目录按仓库源区分）
   *
   * 每个平台有自己的目录习惯（GitHub 的仓库放 /Github，将来 Gitea 放 /Gitea），
   * 让 provider 自己声明，表单默认值与创建接口的兜底值都取自这里，
   * 不会出现「界面显示 /Github、落库却是 /」这种前后端各写一份默认值的偏差。
   * （修改点：默认目录改首字母大写，原先注释与取值都是 /GitHub）
   *
   * @param {string} providerType
   * @returns {string} 以 / 开头、不以 / 结尾；未注册或未声明时为根目录 "/"
   */
  static getDefaultPathPrefix(providerType) {
    return registry.get(providerType)?.defaultPathPrefix || "/";
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
      // 修改点（备份默认目录按仓库源区分）：前端表单据此预填「路径前缀」
      defaultPathPrefix: entry.defaultPathPrefix,
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
  // 修改点（点击 owner/repo 跳转仓库）：默认跳到 github.com；
  // endpoint_url 指向自建 / GitHub Enterprise 时，反推到该实例的网页地址
  webUrlBuilder: buildGithubRepositoryWebUrl,
  // 修改点（备份默认目录按仓库源区分）：GitHub 的仓库默认备份到挂载点的 /Github 目录，
  // 与将来接入 Gitea（/Gitea）等平台天然分开，多来源备份不再混在同一层
  // 修改点（默认目录改首字母大写）：/GitHub -> /Github，与存量备份所在目录一致
  // （目录名统一「首字母大写 + 其余小写」，不是品牌官方写法 GitHub）
  defaultPathPrefix: "/Github",
  ui: {
    icon: "storage-github-api",
    i18nKey: "admin.repoBackup.provider.github",
  },
  configSchema: {
    fields: [
      {
        // 修改点（Token / 代理统一为多值字段）：
        // 原来「GitHub Token」单值字段 + 新增的 token 池是两个字段，本质重复。
        // 现在只保留这一个多值字段（字段名沿用存储层的 tokens），
        // 旧配置里的单值 config.token 会在解析时折进这里（见 repobackup/config.js
        // 的 foldLegacyPoolFields），因此老配置不会丢、界面也不用填两次。
        name: "tokens",
        type: "secretPool",
        required: false,
        labelKey: "admin.repoBackup.fields.github.tokens",
        ui: {
          fullWidth: true,
          descriptionKey: "admin.repoBackup.description.github.tokens",
          // 单框连续录入，只需要占位符文案
          valuePlaceholderKey: "admin.repoBackup.pool.tokenPlaceholder",
        },
      },
      {
        // 修改点（Token / 代理统一为多值字段）：
        // 同理，原来的 gh_proxy 单值字段与 proxies 池合并成这一个多值字段。
        name: "proxies",
        type: "secretPool",
        required: false,
        labelKey: "admin.repoBackup.fields.github.proxies",
        ui: {
          fullWidth: true,
          descriptionKey: "admin.repoBackup.description.github.proxies",
          // 单框连续录入，只需要占位符文案
          valuePlaceholderKey: "admin.repoBackup.pool.proxyPlaceholder",
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
          fields: ["tokens", "proxies", "endpoint_url"],
        },
      ],
    },
  },
});
