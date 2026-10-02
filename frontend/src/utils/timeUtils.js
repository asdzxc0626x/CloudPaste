/**
 * 统一的时间处理工具函数
 * 用于处理从后端接收的 UTC 时间戳，并按「站点时区」统一显示
 *
 * 后端存储与下发的时间一律视为 UTC，共三种形态（均由 parseUTCDate 归一）：
 *   1. SQLite CURRENT_TIMESTAMP  "YYYY-MM-DD HH:mm:ss"（无时区标记，值是 UTC）
 *   2. ISO 字符串                "2026-01-23T08:12:07.000Z"
 *   3. epoch 毫秒                1769155927000（tasks / fs_search_index 等表用 INTEGER 存）
 *
 * 修改点（站点时区一期）：
 * - 新增 epoch 毫秒解析支持（原来遇到数字直接返回 null，这是 tasks / fsIndex 系列组件
 *   各自造一套 formatTimestamp 的根因）
 * - 所有 Intl.DateTimeFormat 统一注入站点时区，不再隐式跟随访问者浏览器时区
 * - 新增 datetime-local 输入框的双向转换，保证「UTC → 站点时区 → 用户编辑 → UTC」不漂移
 *
 * 本期不改动：后端时间存储/下发格式、调度器、cron 语义。
 */

import { ref } from "vue";
import { useLocalStorage } from "@vueuse/core";
import { createLogger } from "@/utils/logger.js";

const storedLanguage = useLocalStorage("language", "zh-CN");
const log = createLogger("TimeUtils");

// ==================== 站点时区（修改点：站点时区一期）====================

/** 默认时区：UTC —— 与后端存储一致，且对所有访问者稳定一致 */
export const DEFAULT_TIME_ZONE = "UTC";

/**
 * siteConfigStore 的 localStorage 缓存键
 * 这里直接读它只为了「首帧同步可用」：站点配置是挂载后异步拉取的，
 * 若等网络返回再决定时区，首屏时间会先按错的时区渲染再跳一次。
 */
const SITE_CONFIG_STORAGE_KEY = "cloudpaste_site_config";

/**
 * 校验是否为运行时认识的 IANA 时区
 * 用 Intl 实际构造一次，避免维护一份会过期的白名单
 */
export const isValidTimeZone = (timeZone) => {
  const text = String(timeZone || "").trim();
  if (!text) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: text });
    return true;
  } catch {
    return false;
  }
};

/** 非法或空值一律回落到 UTC，保证格式化永远不会因为配置脏数据而抛错 */
const normalizeTimeZone = (timeZone) => {
  const text = String(timeZone || "").trim();
  if (!text) return DEFAULT_TIME_ZONE;
  return isValidTimeZone(text) ? text : DEFAULT_TIME_ZONE;
};

/** 从 localStorage 缓存里取出时区，用于模块加载时的首帧值 */
const readTimeZoneFromCache = () => {
  try {
    const raw = localStorage.getItem(SITE_CONFIG_STORAGE_KEY);
    if (!raw) return DEFAULT_TIME_ZONE;
    const parsed = JSON.parse(raw);
    return normalizeTimeZone(parsed?.timezone);
  } catch {
    // 隐私模式 / 缓存损坏：按默认时区工作
    return DEFAULT_TIME_ZONE;
  }
};

/**
 * 当前生效的站点时区
 *
 * 用 ref 而不是普通变量：格式化函数在渲染期间读它，
 * 管理员改完时区（或站点配置拉取完成）后，页面上已显示的时间会自动重新渲染。
 */
const siteTimeZone = ref(readTimeZoneFromCache());

/**
 * 设置当前站点时区（由 siteConfigStore 调用，是唯一的写入口）
 * @param {string} timeZone IANA 时区名
 */
export const setSiteTimeZone = (timeZone) => {
  const next = normalizeTimeZone(timeZone);
  if (next !== siteTimeZone.value) {
    siteTimeZone.value = next;
  }
};

/** 获取当前站点时区 */
export const getSiteTimeZone = () => siteTimeZone.value;

/** 访问者浏览器所在时区，仅用于设置界面上给管理员做参考 */
export const getBrowserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIME_ZONE;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
};

/**
 * 可选时区列表（供设置界面使用）
 * 优先用 Intl.supportedValuesOf 动态取全量 IANA 列表，取不到时退化为常用时区，
 * 这样不需要在仓库里维护一份会过期的时区表。
 */
export const getSupportedTimeZones = () => {
  try {
    if (typeof Intl.supportedValuesOf === "function") {
      const zones = Intl.supportedValuesOf("timeZone");
      if (Array.isArray(zones) && zones.length > 0) {
        // supportedValuesOf 不含 UTC，但它是我们的默认值，必须可选
        return zones.includes("UTC") ? zones : ["UTC", ...zones];
      }
    }
  } catch {
    // 落到下面的兜底列表
  }
  return [
    "UTC",
    "Asia/Shanghai",
    "Asia/Hong_Kong",
    "Asia/Taipei",
    "Asia/Tokyo",
    "Asia/Seoul",
    "Asia/Singapore",
    "Asia/Kolkata",
    "Asia/Dubai",
    "Europe/London",
    "Europe/Berlin",
    "Europe/Paris",
    "Europe/Moscow",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/Sao_Paulo",
    "Australia/Sydney",
    "Pacific/Auckland",
  ];
};

// 获取当前语言设置
const getCurrentLanguage = () => {
  try {
    return storedLanguage.value || "zh-CN";
  } catch {
    return "zh-CN";
  }
};

// 简单的翻译映射 - 避免在工具函数中使用复杂的国际化
const translations = {
  "zh-CN": {
    unknown: "未知",
    dateInvalid: "日期无效",
    dateFormatError: "日期格式错误",
    soon: "即将",
    justNow: "刚刚",
    minutesAgo: "{count}分钟前",
    minutesLater: "{count}分钟后",
    hoursAgo: "{count}小时前",
    hoursLater: "{count}小时后",
    daysAgo: "{count}天前",
    daysLater: "{count}天后",
    weeksAgo: "{count}周前",
    weeksLater: "{count}周后",
    monthsAgo: "{count}个月前",
    monthsLater: "{count}个月后",
    yearsAgo: "{count}年前",
    yearsLater: "{count}年后",
    neverExpires: "永不过期",
    expired: "已过期",
  },
  "en-US": {
    unknown: "Unknown",
    dateInvalid: "Invalid Date",
    dateFormatError: "Date Format Error",
    soon: "Soon",
    justNow: "Just now",
    minutesAgo: "{count} minutes ago",
    minutesLater: "{count} minutes later",
    hoursAgo: "{count} hours ago",
    hoursLater: "{count} hours later",
    daysAgo: "{count} days ago",
    daysLater: "{count} days later",
    weeksAgo: "{count} weeks ago",
    weeksLater: "{count} weeks later",
    monthsAgo: "{count} months ago",
    monthsLater: "{count} months later",
    yearsAgo: "{count} years ago",
    yearsLater: "{count} years later",
    neverExpires: "Never expires",
    expired: "Expired",
  },
};

// 获取翻译文本
const t = (key, params = {}) => {
  const lang = getCurrentLanguage();
  const langTranslations = translations[lang] || translations["zh-CN"];
  let text = langTranslations[key] || key;

  // 简单的参数替换
  if (params.count !== undefined) {
    text = text.replace("{count}", params.count);
  }

  return text;
};

/**
 * 时间格式化选项配置
 */
const TIME_FORMAT_OPTIONS = {
  // 完整日期时间格式（年-月-日 时:分）
  FULL_DATETIME: {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false, // 使用24小时制
  },

  // 完整日期时间格式（包含秒）
  FULL_DATETIME_WITH_SECONDS: {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  },

  // 相对时间单位（毫秒）
  RELATIVE_TIME_UNITS: {
    MINUTE: 60,
    HOUR: 3600,
    DAY: 86400,
    WEEK: 604800,
    MONTH: 2592000, // 30天
    YEAR: 31536000, // 365天
  },
};

/**
 * 给格式化选项补上站点时区（修改点：站点时区一期）
 *
 * 调用方传进来的 options 一律不带 timeZone（原来就不带，于是 Intl 隐式用浏览器时区）。
 * 这里统一补上，是整个项目时间显示的唯一注入点。
 * 若调用方自己显式指定了 timeZone，尊重它，不覆盖。
 */
const withSiteTimeZone = (options = {}) => {
  if (options && options.timeZone) return options;
  return { ...options, timeZone: getSiteTimeZone() };
};

/**
 * 将 UTC 时间转换为 Date 对象
 *
 * 支持三种后端形态（见文件头注释）。注意：返回的 Date 代表一个**绝对时刻**，
 * 不带时区概念；时区只在格式化那一步生效。
 *
 * @param {string|Date|number} utcDateString - UTC 时间字符串、Date 对象或 epoch 毫秒
 * @returns {Date|null} Date 对象，如果无效则返回 null
 */
export const parseUTCDate = (utcDateString) => {
  // 注意不能用 !utcDateString 直接判：epoch 0 是合法时刻（1970-01-01T00:00:00Z）
  if (utcDateString === null || utcDateString === undefined || utcDateString === "") {
    return null;
  }

  try {
    // 如果已经是 Date 对象，直接返回
    if (utcDateString instanceof Date) {
      return isNaN(utcDateString.getTime()) ? null : utcDateString;
    }

    // 修改点（站点时区一期）：支持 epoch 毫秒。
    // tasks / fs_search_index 等表的时间列是 INTEGER，下发到前端就是数字；
    // 原实现遇到非字符串直接返回 null，逼得相关组件各自造一套格式化。
    if (typeof utcDateString === "number") {
      if (!Number.isFinite(utcDateString)) return null;
      const date = new Date(utcDateString);
      return isNaN(date.getTime()) ? null : date;
    }

    if (typeof utcDateString !== "string") {
      return null;
    }

    let dateString = utcDateString.trim();
    if (!dateString) return null;

    // 修改点（站点时区一期）：纯数字字符串按 epoch 毫秒处理。
    // 限定 13 位及以上，避免把 "20260123" 这类紧凑日期误判成时间戳。
    if (/^\d{13,}$/.test(dateString)) {
      const date = new Date(Number(dateString));
      return isNaN(date.getTime()) ? null : date;
    }

    // 处理不同的UTC时间格式
    // 1. 如果已经是ISO格式（带Z或时区偏移），直接解析
    if (dateString.includes("T") && (dateString.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(dateString))) {
      const date = new Date(dateString);
      return isNaN(date.getTime()) ? null : date;
    }

    // 2. 如果是SQLite CURRENT_TIMESTAMP格式 "YYYY-MM-DD HH:mm:ss"，需要明确指定为UTC
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dateString)) {
      // 将空格替换为T，并添加Z表示UTC时间
      dateString = dateString.replace(" ", "T") + "Z";
    }
    // 3. 如果是日期格式 "YYYY-MM-DD"，添加时间和UTC标识
    else if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
      dateString = dateString + "T00:00:00Z";
    }
    // 4. 如果是ISO格式但没有Z，添加Z
    else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(dateString)) {
      dateString = dateString + "Z";
    }

    const date = new Date(dateString);
    return isNaN(date.getTime()) ? null : date;
  } catch (error) {
    log.error("解析 UTC 时间失败:", error, "输入:", utcDateString);
    return null;
  }
};

/**
 * 获取用户的首选语言设置
 * @returns {string} 用户的语言代码
 */
export const getUserLocale = () => {
  // 优先使用浏览器语言设置
  if (navigator.language) {
    return navigator.language;
  }
  // 备选方案：使用浏览器语言列表的第一个
  if (navigator.languages && navigator.languages.length > 0) {
    return navigator.languages[0];
  }
  // 最后备选：默认中文
  return "zh-CN";
};

/**
 * 格式化日期时间为本地时间显示
 * @param {string} utcDateString - UTC 时间字符串
 * @param {Object} options - 格式化选项，默认为完整日期时间格式
 * @param {string} locale - 地区设置，默认自动检测用户语言
 * @returns {string} 格式化后的本地时间字符串
 */
export const formatDateTime = (utcDateString, options = TIME_FORMAT_OPTIONS.FULL_DATETIME, locale = getUserLocale()) => {
  if (!utcDateString) return t("unknown");

  const date = parseUTCDate(utcDateString);
  if (!date) {
    log.warn("时间解析失败:", utcDateString);
    return t("dateInvalid");
  }

  try {
    return new Intl.DateTimeFormat(locale, withSiteTimeZone(options)).format(date);
  } catch (error) {
    log.error("日期格式化错误:", error, "输入:", utcDateString);
    return t("dateFormatError");
  }
};

/**
 * 格式化日期时间（包含秒）
 * @param {string} utcDateString - UTC 时间字符串
 * @param {string} locale - 地区设置，默认自动检测用户语言
 * @returns {string} 格式化后的时间字符串
 */
export const formatDateTimeWithSeconds = (utcDateString, locale = getUserLocale()) => {
  return formatDateTime(utcDateString, TIME_FORMAT_OPTIONS.FULL_DATETIME_WITH_SECONDS, locale);
};

/**
 * 计算相对时间（如：3天前、2小时后）
 * @param {string} utcDateString - UTC 时间字符串
 * @param {Date} baseDate - 基准时间，默认为当前时间
 * @returns {string} 相对时间描述
 */
export const formatRelativeTime = (utcDateString, baseDate = new Date()) => {
  if (!utcDateString) return "";

  const targetDate = parseUTCDate(utcDateString);
  if (!targetDate) {
    return "";
  }

  try {
    // 计算时间差（秒）
    const diffInSeconds = Math.floor((targetDate - baseDate) / 1000);
    const absDiff = Math.abs(diffInSeconds);
    const isInFuture = diffInSeconds > 0;

    const { MINUTE, HOUR, DAY, WEEK, MONTH, YEAR } = TIME_FORMAT_OPTIONS.RELATIVE_TIME_UNITS;

    // 根据时间差返回不同的描述
    if (absDiff < MINUTE) {
      return isInFuture ? t("soon") : t("justNow");
    } else if (absDiff < HOUR) {
      const minutes = Math.floor(absDiff / MINUTE);
      return isInFuture ? t("minutesLater", { count: minutes }) : t("minutesAgo", { count: minutes });
    } else if (absDiff < DAY) {
      const hours = Math.floor(absDiff / HOUR);
      return isInFuture ? t("hoursLater", { count: hours }) : t("hoursAgo", { count: hours });
    } else if (absDiff < WEEK) {
      const days = Math.floor(absDiff / DAY);
      return isInFuture ? t("daysLater", { count: days }) : t("daysAgo", { count: days });
    } else if (absDiff < MONTH) {
      const weeks = Math.floor(absDiff / WEEK);
      return isInFuture ? t("weeksLater", { count: weeks }) : t("weeksAgo", { count: weeks });
    } else if (absDiff < YEAR) {
      const months = Math.floor(absDiff / MONTH);
      return isInFuture ? t("monthsLater", { count: months }) : t("monthsAgo", { count: months });
    } else {
      const years = Math.floor(absDiff / YEAR);
      return isInFuture ? t("yearsLater", { count: years }) : t("yearsAgo", { count: years });
    }
  } catch (error) {
    log.error("相对时间计算错误:", error);
    return "";
  }
};

/**
 * 格式化过期时间显示
 * @param {string} expiryDateString - 过期时间的 UTC 字符串
 * @returns {string} 格式化后的过期时间描述
 */
export const formatExpiry = (expiryDateString) => {
  if (!expiryDateString) return t("neverExpires");

  const expiryDate = parseUTCDate(expiryDateString);
  if (!expiryDate) {
    return t("dateInvalid");
  }

  const now = new Date();

  try {
    // 判断是否已过期
    if (expiryDate < now) {
      return t("expired");
    }

    // 显示具体日期和相对时间
    const formattedDate = formatDateTime(expiryDateString);
    const relativeTime = formatRelativeTime(expiryDateString, now);

    return `${formattedDate} (${relativeTime})`;
  } catch (error) {
    log.error("过期时间格式化错误:", error);
    return t("dateFormatError");
  }
};

/**
 * 检查时间是否已过期
 * @param {string} expiryDateString - 过期时间的 UTC 字符串
 * @returns {boolean} 是否已过期
 */
export const isExpired = (expiryDateString) => {
  if (!expiryDateString) return false;

  const expiryDate = parseUTCDate(expiryDateString);
  if (!expiryDate) return false;

  return expiryDate < new Date();
};

/**
 * 格式化时间用于显示"最后刷新时间"等场景
 * @returns {string} 当前时间的简短格式（站点时区）
 */
export const formatCurrentTime = () => {
  const now = new Date();
  // 修改点（站点时区一期）：补上站点时区，与页面其它时间保持一致
  return now.toLocaleTimeString(getUserLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: getSiteTimeZone(),
  });
};

// ==================== 站点时区下的「墙上时钟」换算（修改点：站点时区一期）====================

/**
 * 取某个绝对时刻在指定时区下的墙上时钟读数，并表示成「假装这读数是 UTC」的时间戳
 *
 * 这是不引入日期库就能做时区换算的标准手法：Intl 能把一个时刻按目标时区
 * 拆成年月日时分秒，再用 Date.UTC 把这些数字拼回去，就得到一个便于做算术的值。
 */
const wallClockAsUTC = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  let hour = get("hour");
  // 部分实现用 24 表示午夜，Date.UTC 会把它滚到第二天，这里先归零
  if (hour === 24) hour = 0;

  return Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
};

/** 指定时区在某个时刻的 UTC 偏移（毫秒），夏令时会随时刻变化 */
const zoneOffsetMs = (date, timeZone) => wallClockAsUTC(date, timeZone) - date.getTime();

/**
 * UTC 时间 -> `<input type="datetime-local">` 需要的 `YYYY-MM-DDTHH:mm`
 *
 * 输入框没有时区概念，显示的必须是「站点时区下的墙上时钟」，
 * 否则管理员看到的过期时间和列表里显示的不是同一个。
 *
 * @param {string|Date|number} value 后端下发的 UTC 时间（三种形态均可）
 * @returns {string} `YYYY-MM-DDTHH:mm`，无法解析时返回空串
 */
export const formatForDateTimeLocalInput = (value) => {
  const date = parseUTCDate(value);
  if (!date) return "";

  try {
    const shifted = new Date(wallClockAsUTC(date, getSiteTimeZone()));
    const pad = (n) => String(n).padStart(2, "0");
    return (
      `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
      `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
    );
  } catch (error) {
    log.error("datetime-local 格式化失败:", error, "输入:", value);
    return "";
  }
};

/**
 * `<input type="datetime-local">` 的值 -> UTC Date
 *
 * 用户在输入框里填的是「站点时区的墙上时钟」，必须按站点时区反解回绝对时刻；
 * 直接 `new Date("2026-01-23T08:12")` 会被 JS 当成**浏览器本地时间**，那就漂了。
 *
 * 夏令时的两种疑难情形都要处理：
 * - 回拨日有「重复的一小时」（柏林 10/25 的 02:30 出现两次）：取**最早**那次，
 *   与 Temporal 的默认消歧策略一致，也保证「格式化 → 解析」能严格往返
 * - 前拨日有「不存在的一小时」（柏林 3/29 的 02:30 被跳过）：没有候选能对上，
 *   退回两步迭代得到紧邻的真实时刻，不返回 null（否则用户填了个合法样子的值却被判非法）
 *
 * @param {string} text `YYYY-MM-DDTHH:mm`（可带秒）
 * @returns {Date|null} 对应的绝对时刻
 */
export const parseDateTimeLocalInput = (text) => {
  const matched = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(text || "").trim());
  if (!matched) return null;

  try {
    const timeZone = getSiteTimeZone();
    // 把用户填的读数当成 UTC 拼出一个时间戳，纯粹用来做算术
    const target = Date.UTC(
      Number(matched[1]),
      Number(matched[2]) - 1,
      Number(matched[3]),
      Number(matched[4]),
      Number(matched[5]),
      matched[6] ? Number(matched[6]) : 0,
    );

    const DAY_MS = 24 * 60 * 60 * 1000;
    // 用目标前后各一天的偏移作为候选：夏令时一天最多切换一次，
    // 这两个偏移必然把切换点夹在中间，于是覆盖了所有可能的解
    const offsets = [
      zoneOffsetMs(new Date(target - DAY_MS), timeZone),
      zoneOffsetMs(new Date(target + DAY_MS), timeZone),
    ];

    const candidates = [...new Set(offsets.map((offset) => target - offset))]
      // 只留下「按站点时区渲染回去确实等于用户填的读数」的候选
      .filter((ms) => wallClockAsUTC(new Date(ms), timeZone) === target)
      .sort((a, b) => a - b);

    if (candidates.length > 0) {
      return new Date(candidates[0]);
    }

    // 落到这里说明这个墙上时钟在该时区并不存在（前拨跳过的那一小时）：
    // 用两步迭代给出紧邻的真实时刻
    let instant = target - zoneOffsetMs(new Date(target), timeZone);
    instant = target - zoneOffsetMs(new Date(instant), timeZone);

    const date = new Date(instant);
    return isNaN(date.getTime()) ? null : date;
  } catch (error) {
    log.error("datetime-local 解析失败:", error, "输入:", text);
    return null;
  }
};

/**
 * 获取当前日期时间的文件名存档格式
 * 用于压缩包、拷贝、导出等场景
 * 格式: YYYY-MM-DD-HH-mm-ss
 *
 * 修改点（站点时区一期）：改按站点时区取值，
 * 让导出文件名里的时间和界面上显示的时间对得上。
 */
export const formatNowForFilename = () => {
  const shifted = new Date(wallClockAsUTC(new Date(), getSiteTimeZone()));
  const pad = (n) => String(n).padStart(2, "0");

  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `-${pad(shifted.getUTCHours())}-${pad(shifted.getUTCMinutes())}-${pad(shifted.getUTCSeconds())}`
  );
};

/**
 * 将Date/日期字符串等转换为本地化的日期+时间字符串(包括秒)
 * @param {Date|string|number} date - Date对象/日期字符串/时间戳
 * @returns {string} 格式化的本地日期时间字符串
 */
export const formatLocalDateTimeWithSeconds = (date) => {
  if (!date) return t("unknown");

  const parsed = parseUTCDate(date);
  if (!parsed) {
    return t("dateInvalid");
  }

  try {
    return new Intl.DateTimeFormat(getUserLocale(), withSiteTimeZone(TIME_FORMAT_OPTIONS.FULL_DATETIME_WITH_SECONDS)).format(parsed);
  } catch (error) {
    log.error("日期格式化错误:", error, "输入:", date);
    return t("dateFormatError");
  }
};


// 导出时间格式选项，供其他组件使用
export { TIME_FORMAT_OPTIONS };
