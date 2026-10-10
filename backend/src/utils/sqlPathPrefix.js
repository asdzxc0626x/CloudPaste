/**
 * SQL 路径前缀匹配工具（修改点：修复 D1 的 LIKE 模式 50 字符上限导致的 500）
 *
 * 背景：为什么不能用 LIKE 做路径前缀匹配
 * ------------------------------------
 * Cloudflare D1 把 SQLITE_LIMIT_LIKE_PATTERN_LENGTH 从上游 SQLite 默认的 50000
 * 压到了 50（官方文档 D1 Limits：LIKE pattern length = 50 characters）。
 * 只要 LIKE / GLOB 的**模式**超过 50 字节，D1 就直接抛
 *   D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR
 * 整个请求 500，且 SQL 层没有任何办法调高这个上限。
 *
 * 而本项目的 FS 路径天然很长：/{挂载段}/{仓库目录}/{分支目录}/...
 * 例如 /b2-1/Github/github__owner__repo/main 已经 52 字节，
 * 再补上结尾的 "/" 与 "%" 就是 54 字节 —— 越界。
 * 于是「仓库目录」还能列（49 字节），往里点一层就整个 500；
 * 备份按分支分层后目录层级更深，踩中的概率更高。
 *
 * 做法：用范围查询表达「以 prefix 开头」（集合等价，不依赖 LIKE）
 * ------------------------------------------------------------
 *   col >= lower AND col < upper
 * lower = 前缀（补上结尾的 "/"），upper = 前缀末位字节 +1。
 * 因为 "/" (0x2F) 与 "0" (0x30) 之间没有任何字节，区间
 * [ "/a/b/", "/a/b0" ) 恰好等于 LIKE '/a/b/%' 的集合。
 * 比较操作数不受长度限制，因此再深的路径也不会触发 D1 的上限；
 * 附带两个好处：能吃到 (mount_id, fs_path) 上的索引，路径里的 % / _ 也不再被当通配符。
 *
 * 与 LIKE 的差异（有意为之，不是副作用）
 * ----------------------------------
 * 1) 大小写：LIKE 对 ASCII 不区分大小写，范围比较按字节比较。FS 路径来自存储驱动，
 *    大小写敏感才是正确的 —— 原先列 /a/b 会把 /A/B 下的条目也算进来。
 * 2) 通配符：原先路径里的 "_" 会被 LIKE 当作「任意单字符」，现在按字面量精确匹配。
 */

/** 允许拼进 SQL 的列名形态（列名全部来自代码字面量，这里只是兜底防误用） */
const COLUMN_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/**
 * 计算路径前缀匹配的区间边界
 *
 * @param {string} rawPrefix 目录路径（结尾有无 "/" 均可；"/" 表示根目录）
 * @returns {{exact: string, lower: string, upper: string}|null} 空前缀返回 null
 */
export function buildPathPrefixBounds(rawPrefix) {
  const raw = String(rawPrefix ?? "").trim();
  if (!raw) return null;

  // 根目录：所有 FS 路径都以 "/" 开头，[ "/", "0" ) 即全集
  if (raw === "/") return { exact: raw, lower: "/", upper: "0" };

  const prefix = raw.endsWith("/") ? raw : `${raw}/`;
  // 末位一定是 "/"，+1 得到 "0"，所以上界总是合法 ASCII
  const upper = `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`;
  return { exact: raw, lower: prefix, upper };
}

/**
 * 生成「路径前缀匹配」的 SQL 片段与绑定值
 *
 * @param {string} column 列名（只能是代码里的字面量）
 * @param {string} rawPrefix 目录路径
 * @param {{includeExact?: boolean}} [options] includeExact=true 时额外匹配前缀本身，
 *        对应原先 `fs_path = ? OR fs_path LIKE ?` 的写法
 * @returns {{sql: string, params: any[]}|null} 空前缀返回 null，调用方应跳过该条件
 */
export function buildPathPrefixCondition(column, rawPrefix, options = {}) {
  const col = String(column || "");
  if (!COLUMN_NAME_PATTERN.test(col)) {
    throw new TypeError(`buildPathPrefixCondition: 非法列名 ${JSON.stringify(column)}`);
  }

  const bounds = buildPathPrefixBounds(rawPrefix);
  if (!bounds) return null;

  const clauses = [];
  const params = [];

  if (options?.includeExact) {
    clauses.push(`${col} = ?`);
    params.push(bounds.exact);
  }

  // AND 的优先级高于 OR；多于一个条件时整体加括号，方便调用方继续用 AND 拼接
  clauses.push(`${col} >= ? AND ${col} < ?`);
  params.push(bounds.lower, bounds.upper);

  return {
    sql: clauses.length === 1 ? clauses[0] : `(${clauses.join(" OR ")})`,
    params,
  };
}
