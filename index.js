/**
 * dsh-plugin-provider-badge — node 半（宿主侧）。
 *
 * 两个职责：
 *  1. 作为 bundle roster 行被扫描挂载（徽标与级联菜单全部在 client.js）。
 *  2. 提供只读额度端点 `GET /provider-badge/quota`，供浏览器半在打开
 *     provider 级联菜单时取各官方 provider 的窗口用量（5 小时 / 7 天等）。
 *
 * 额度取数：目标端点与鉴权方式全部由 `QUOTA_SOURCES` 表声明（本插件唯一的
 * 出站请求，URL 硬编码，不接受外部输入）：
 *  - `openai-codex`：`https://chatgpt.com/backend-api/wham/usage`。它与 Codex
 *    CLI 的 `account/rateLimits/read` 同源；同一 token 打
 *    `/backend-api/codex/usage` 实测回 403（HTML 错误页），`/wham/usage` 回
 *    200 JSON。凭据取自宿主凭据服务里 **`llm-pi-ai` 拥有的记录**
 *    `llm-pi-ai/openai-codex`（kind=grant，
 *    payload={type:'oauth',access,refresh,expires,accountId}）。
 *  - `kimi-coding`：`https://api.kimi.com/coding/v1/usages`。凭据取自该路由
 *    在 settings(`llm-pi-ai`) 里**当前生效的 `apiKeyEnv` 引用**（实测 DSH 的
 *    `LLMKEY_KIMI` 即可回 200），回退到 `KIMI_API_KEY`。
 *    Kimi CLI 自己的 `~/.kimi-code/credentials/kimi-code.json` 不参与：那份
 *    OAuth 令牌实测 401，且刷新它就会与 Kimi CLI 抢同一份 refresh token。
 *  - `opencode-go`：`https://opencode.ai/zen/go/v1/usage`（OpenCode Go /
 *    Go Plus 订阅；当前 OpenCode CLI 同样从模型 API URL 推导该路径）。凭据取该
 *    路由生效的 `apiKeyEnv` 引用（本机 `OPENCODE_API_KEY`），并回退同名引用。
 *    解析同时兼容旧 `{usage:{rolling,weekly,monthly}}` 与当前
 *    `{plan,windows:[{name,usagePercent,resetInSec}]}`；两者都只返回订阅级窗口，
 *    不按模型拆。窗口时长仍按 5 小时 / 每周 / 每月（30 天）映射。
 *    该端点在官方 Console API 文档里**未列出**（文档只让去 console 网页看用量），
 *    属于「实测存在但未公开」，故同样纳入静默降级。
 *
 * 对凭据一律**只读**：不刷新、不写回、不落盘、不写日志。令牌过期时直接放弃
 * 本次查询并回 `token-expired` / `not-configured`，把刷新留给 pi-ai 与 Kimi
 * CLI——两处并发刷新会互相把对方的 refresh token 作废（凭据服务的
 * modifyRecord 就是为此串行化）。
 *
 * 安全边界：
 *  - 端点只应答本机回环请求，任何响应都不包含令牌、邮箱、账号 id。
 *  - 上游非 200 时只回状态码，不回响应体（错误页/错误体可能带账号信息）。
 *  - 响应有固定缓存窗口，避免每开一次菜单就打一次上游。
 *
 * 失败一律降级为 `{ok:false, reason}`：额度失败不影响模型选择流程，浏览器半
 * 只把归一化 reason 显示为固定脱敏短状态，不透传上游错误体。
 */

export const name = 'provider-badge'

/** pi-ai 的 settings 命名空间：路由当前生效的 `apiKeyEnv` 写在它下面。 */
const PI_AI_NAMESPACE = 'llm-pi-ai'

/**
 * 额度取数描述表：路由 id → 数据源。新增数据源只在这里加一条，
 * 浏览器半无需知道路由名（它整表取回，按行 id 命中）。
 *
 * 每条数据源：
 *  - `routeMatch`：`{baseHosts, aliases}`——**本机真实路由 id 由 baseURL 判定**，
 *    `aliases` 只作同族命名与兜底（路由 id 因设备而异：本机 `opencodego`、
 *    另一台 `opencode-go`，故不能靠 id 精确匹配）。
 *  - `auth`：`{kind:'grant', recordKey}` 读授权记录；`{kind:'ref',
 *    fallbackRefs}` 读 settings 里该路由的 `apiKeyEnv` 凭据引用。
 *  - `headers(auth)`：除 `authorization` / `accept` 之外的附加请求头。
 *  - `parse(payload, nowMs)`：响应体 → 统一条目；取不到窗口就回 null。
 */
const QUOTA_SOURCES = Object.freeze({
  'openai-codex': Object.freeze({
    routeMatch: Object.freeze({ baseHosts: Object.freeze([]), aliases: Object.freeze(['openai-codex']) }),
    auth: Object.freeze({ kind: 'grant', recordKey: 'llm-pi-ai/openai-codex' }),
    url: 'https://chatgpt.com/backend-api/wham/usage',
    headers: (auth) => ({
      'chatgpt-account-id': auth.accountId,
      // 与 pi-ai 的 Codex 适配器保持同一 originator，避免上游按客户端另算账。
      originator: 'pi',
      'user-agent': 'pi',
    }),
    parse: entryFromPayload,
  }),
  'kimi-coding': Object.freeze({
    routeMatch: Object.freeze({ baseHosts: Object.freeze(['api.kimi.com/coding']), aliases: Object.freeze(['kimi-coding']) }),
    auth: Object.freeze({ kind: 'ref', fallbackRefs: Object.freeze(['KIMI_API_KEY']) }),
    url: 'https://api.kimi.com/coding/v1/usages',
    headers: () => ({}),
    parse: kimiEntryFromPayload,
  }),
  'opencode-go': Object.freeze({
    // 本机 profile 把这条订阅注册成 `opencodego`（apiKeyEnv `OPENCODEGO_API_KEY`），
    // 上游与另一台设备写 `opencode-go`。baseURL 判定 + 两个别名都要有。
    routeMatch: Object.freeze({
      baseHosts: Object.freeze(['opencode.ai/zen/go']),
      aliases: Object.freeze(['opencode-go', 'opencodego']),
    }),
    auth: Object.freeze({ kind: 'ref', fallbackRefs: Object.freeze(['OPENCODE_API_KEY', 'OPENCODEGO_API_KEY']) }),
    url: 'https://opencode.ai/zen/go/v1/usage',
    headers: () => ({}),
    parse: opencodeEntryFromPayload,
  }),
})

/** 端点路径：浏览器半按同源相对路径请求。 */
const QUOTA_PATH = '/provider-badge/quota'
/** 生效配置的只读回显（"可见配置"）：只含引用名与端点，绝不含凭据值。 */
const CONFIG_PATH = '/provider-badge/config'
/** 上游超时：额度面板可以慢，但不能把菜单请求挂死。 */
const UPSTREAM_TIMEOUT_MS = 8000
/** 服务端缓存窗口：同一路由最多每分钟打一次上游。 */
const CACHE_TTL_MS = 60000
/** 令牌剩余寿命低于该值即视为过期（不给临界续期留悬念）。 */
const EXPIRY_SKEW_MS = 60000
const MAX_PERCENT = 100

/** Kimi `usages` 的键形如 `limit_5h` / `limit_7d` / `limit_30m`。 */
const KIMI_WINDOW_KEY = /^limit_(\d+)([mhd])$/i
const WINDOW_UNIT_SECONDS = Object.freeze({ m: 60, h: 3600, d: 86400 })
/** Kimi `limits[].window.timeUnit`。 */
const KIMI_TIME_UNIT_SECONDS = Object.freeze({
  TIME_UNIT_SECOND: 1,
  TIME_UNIT_MINUTE: 60,
  TIME_UNIT_HOUR: 3600,
  TIME_UNIT_DAY: 86400,
})
/**
 * 无窗口信息可用的兜底周期：`usage` 只给「上限/已用」计数。Kimi CLI 把这一段
 * 显示为 “Weekly limit”，且实测与 `usages.limit_7d` 同值，故按 7 天处理。
 */
const KIMI_WEEKLY_WINDOW_SECONDS = 604800

/**
 * OpenCode Go 的三个窗口 → 秒。响应键是 `rolling` / `weekly` / `monthly`，
 * **不带时长字段**，故时长取自官方文档口径：5 小时（月度上限的 20%）、每周
 * （50%）、每月（100%）。`monthly` 按 30 天算，客户端据此显示为 `30d`。
 */
const OPENCODE_WINDOW_SECONDS = Object.freeze({
  rolling: 18000,
  weekly: 604800,
  monthly: 2592000,
})

function messageOf(error) {
  if (error === null || error === undefined) return ''
  if (typeof error === 'string') return error
  if (typeof error.message === 'string') return error.message
  return String(error)
}

function numOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function strOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * settings 服务 → `llm-pi-ai` 的 providers 段；读不到回 null。
 * describe() 只暴露声明了 volatile 字段的条目，llm-pi-ai 的 providers 即是。
 * @param settingsService - 宿主 settings 服务（可空）。
 * @returns providers 对象或 null。
 */
function providersSectionOf(settingsService) {
  if (settingsService === null || settingsService === undefined || typeof settingsService.describe !== 'function') return null
  let section
  try {
    section = settingsService.describe().find((row) => row !== null && typeof row === 'object' && row.ns === PI_AI_NAMESPACE)?.value
  } catch (error) {
    return null
  }
  if (section === null || typeof section !== 'object') return null
  const providers = section.providers
  if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return null
  return providers
}

/**
 * 数据源 → 本机**真实**路由 id（按 provider 的 `baseURL` 判定，不靠 id）。
 * 路由 id 因设备而异（本机 `opencodego`、另一台 `opencode-go`），baseURL 不会。
 * @param providers - settings 的 providers 段（可空）。
 * @param source - 一条 QUOTA_SOURCES 项。
 * @returns 命中的路由 id 数组（无命中回 []）。
 */
function matchedRouteIds(providers, source) {
  const match = source !== null && typeof source === 'object' && source.routeMatch !== null && typeof source.routeMatch === 'object'
    ? source.routeMatch : null
  const hosts = match !== null && Array.isArray(match.baseHosts)
    ? match.baseHosts.filter((host) => typeof host === 'string' && host.length > 0) : []
  const ids = []
  if (hosts.length === 0 || providers === null) return ids
  for (const id of Object.keys(providers)) {
    const profile = providers[id]
    if (profile === null || typeof profile !== 'object') continue
    const baseURL = strOrNull(profile.baseURL)
    if (baseURL === null) continue
    if (hosts.some((host) => baseURL.includes(host)) && ids.includes(id) !== true) ids.push(id)
  }
  return ids
}

/**
 * 数据源 → 可用于命中的路由 id：别名在前、baseURL 判定的真实 id 在后。
 * 消费方（readAll 的键、sourceOfRoute 的命中）都从这里取，保证「同一家 provider
 * 在不同设备上叫什么都能命中」。
 * @param providers - settings 的 providers 段（可空）。
 * @param source - 一条 QUOTA_SOURCES 项。
 * @returns 路由 id 数组（至少别名部分；别名缺失时可能为空）。
 */
function routeIdsFor(providers, source) {
  const match = source !== null && typeof source === 'object' && source.routeMatch !== null && typeof source.routeMatch === 'object'
    ? source.routeMatch : null
  const ids = []
  for (const alias of match !== null && Array.isArray(match.aliases) ? match.aliases : []) {
    if (typeof alias === 'string' && alias.length > 0 && ids.includes(alias) !== true) ids.push(alias)
  }
  for (const id of matchedRouteIds(providers, source)) {
    if (ids.includes(id) !== true) ids.push(id)
  }
  return ids
}

/**
 * 路由 id → 数据源。先精确命中数据源键（规范名），再按别名/baseURL 命中。
 * @param route - 浏览器半的 `row.id`。
 * @param providers - settings 的 providers 段（可空）。
 * @returns `{sourceId, source}` 或 null。
 */
function sourceOfRoute(route, providers, sources) {
  if (typeof route !== 'string' || route.length === 0) return null
  const table = sources !== null && typeof sources === 'object' ? sources : QUOTA_SOURCES
  if (Object.prototype.hasOwnProperty.call(table, route)) {
    return { sourceId: route, source: table[route] }
  }
  for (const sourceId of Object.keys(table)) {
    if (routeIdsFor(providers, table[sourceId]).includes(route)) {
      return { sourceId, source: table[sourceId] }
    }
  }
  return null
}

/* ── 可见配置 ───────────────────────────────────────────────────────────
 * 分层（2026-10-23 拍板）：
 *   - **代码常量是默认值唯一真相**：未装 dsh-config-pack、pack 未更新、整块
 *     config 被替换时不改变行为；
 *   - pack 的 patch `- id: provider-badge` + `config:` 只写**覆盖**；
 *   - `GET /provider-badge/config` 回显生效结果，改了什么不用再读 JS。
 * 三条硬约束：
 *   1) 输出里只有引用名（`apiKeyEnv` / `recordKey` / `fallbackRefs`），没有值；
 *   2) usage 端点只允许「同源路径」或「白名单主机的 https 绝对 URL」——额度请求
 *      带真凭据，URL 自由覆盖等于可被配置注入外发；
 *   3) 任何非法覆盖都降级成默认值 + 一条 warning，绝不让插件崩在启动阶段。
 */

/** patch 结构版本：回显里带上，浏览器半可据此判断是否需要重取。 */
const CONFIG_VERSION = 1

/** 默认值（代码侧真相）。 */
const CONFIG_DEFAULTS = Object.freeze({
  enabled: true,
  cacheTtlMs: 60000,
  timeoutMs: 8000,
})

/** 数值项的合法区间：越界收敛，不报错。 */
const CONFIG_LIMITS = Object.freeze({
  cacheTtlMs: Object.freeze([5000, 600000]),
  timeoutMs: Object.freeze([1000, 30000]),
})

/** usage 端点的允许主机：白名单外一律拒绝覆盖。 */
const USAGE_HOST_ALLOWLIST = Object.freeze(['opencode.ai', 'api.kimi.com', 'chatgpt.com'])

/** URL → origin（如 `https://opencode.ai`）；无效回 null。 */
function originOfUrl(value) {
  const raw = strOrNull(value)
  if (raw === null) return null
  try {
    return new URL(raw).origin
  } catch (error) {
    return null
  }
}

/** 绝对 URL 是否可作 usage 端点（https + 白名单主机）。 */
function isAllowedUsageUrl(value) {
  const raw = strOrNull(value)
  if (raw === null) return false
  let parsed
  try {
    parsed = new URL(raw)
  } catch (error) {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  return USAGE_HOST_ALLOWLIST.includes(parsed.hostname)
}

/**
 * patch 下发的 config → 生效配置 + 警告清单。
 * @param rawConfig - `apply(ctx, rawConfig)` 的第二参数（可空）。
 * @returns `{configVersion, enabled, cacheTtlMs, timeoutMs, sources, ui, warnings}`。
 */
function resolveConfig(rawConfig) {
  const raw = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {}
  const warnings = []
  const warn = (path, message) => { warnings.push({ path, message }) }
  const resolved = {
    configVersion: CONFIG_VERSION,
    enabled: CONFIG_DEFAULTS.enabled,
    cacheTtlMs: CONFIG_DEFAULTS.cacheTtlMs,
    timeoutMs: CONFIG_DEFAULTS.timeoutMs,
    sources: {},
    ui: { labels: {}, colors: {}, aliases: {} },
    warnings,
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') resolved.enabled = raw.enabled
    else warn('enabled', '必须是布尔值，已忽略')
  }
  for (const key of ['cacheTtlMs', 'timeoutMs']) {
    if (raw[key] === undefined) continue
    const value = intOf(raw[key])
    if (value === null) {
      warn(key, '必须是整数毫秒，已忽略')
      continue
    }
    const range = CONFIG_LIMITS[key]
    resolved[key] = Math.min(range[1], Math.max(range[0], value))
  }

  const rawSources = raw.sources !== null && typeof raw.sources === 'object' && Array.isArray(raw.sources) !== true
    ? raw.sources : {}
  for (const sourceId of Object.keys(rawSources)) {
    const override = rawSources[sourceId]
    const path = 'sources.' + sourceId
    if (Object.prototype.hasOwnProperty.call(QUOTA_SOURCES, sourceId) !== true) {
      warn(path, '未知数据源，已忽略')
      continue
    }
    if (override === null || typeof override !== 'object' || Array.isArray(override) === true) {
      warn(path, '必须是对象，已忽略')
      continue
    }
    const next = {}
    if (override.enabled !== undefined) {
      if (typeof override.enabled === 'boolean') next.enabled = override.enabled
      else warn(path + '.enabled', '必须是布尔值，已忽略')
    }
    for (const key of ['baseHosts', 'aliases']) {
      if (override[key] === undefined) continue
      if (Array.isArray(override[key]) !== true) {
        warn(path + '.' + key, '必须是字符串数组，已忽略')
        continue
      }
      const list = override[key]
        .filter((item) => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim())
      if (list.length === 0) {
        warn(path + '.' + key, '空数组等于不覆盖，已忽略')
        continue
      }
      next[key] = list
    }
    if (override.usagePath !== undefined) {
      const value = strOrNull(override.usagePath)
      if (value === null) warn(path + '.usagePath', '必须是非空字符串，已忽略')
      else if (value.startsWith('/')) next.usagePath = value
      else if (isAllowedUsageUrl(value) === true) next.usagePath = value
      else warn(path + '.usagePath', '绝对 URL 必须是 https 且主机属于 ' + USAGE_HOST_ALLOWLIST.join(' / ') + '，已忽略')
    }
    resolved.sources[sourceId] = next
  }

  const rawUi = raw.ui !== null && typeof raw.ui === 'object' && Array.isArray(raw.ui) !== true ? raw.ui : {}
  for (const key of ['labels', 'colors', 'aliases']) {
    const table = rawUi[key]
    if (table === undefined) continue
    if (table === null || typeof table !== 'object' || Array.isArray(table) === true) {
      warn('ui.' + key, '必须是对象，已忽略')
      continue
    }
    for (const routeId of Object.keys(table)) {
      const value = table[routeId]
      const path = 'ui.' + key + '.' + routeId
      const id = strOrNull(routeId)
      const text = strOrNull(value)
      if (id === null || text === null) {
        warn(path, '键与值都必须是非空字符串，已忽略')
        continue
      }
      if (key === 'colors' && /^#[0-9A-Fa-f]{6}$/.test(text) !== true) {
        warn(path, '颜色必须是 #RRGGBB，已忽略')
        continue
      }
      if (key === 'labels' && text.length > 8) {
        warn(path, '缩写不得超过 8 个字符，已忽略')
        continue
      }
      if (key === 'aliases' && text.length > 64) {
        warn(path, '别名目标过长，已忽略')
        continue
      }
      resolved.ui[key][id] = text
    }
  }
  return resolved
}

/**
 * 生效配置 → 每个数据源的最终形态（与 QUOTA_SOURCES 项同结构，供服务与回显共用）。
 * `usagePath` 是路径时拼到默认端点的 origin 上；绝对 URL 已在 resolveConfig 里过白名单。
 * @param resolved - resolveConfig 的返回值。
 * @returns `{ [sourceId]: source }`。
 */
function effectiveSourcesOf(resolved) {
  const sources = {}
  for (const sourceId of Object.keys(QUOTA_SOURCES)) {
    const base = QUOTA_SOURCES[sourceId]
    const override = resolved.sources[sourceId] !== undefined ? resolved.sources[sourceId] : {}
    let url = base.url
    if (override.usagePath !== undefined) {
      if (override.usagePath.startsWith('/')) {
        const origin = originOfUrl(base.url)
        if (origin !== null) url = origin + override.usagePath
      } else {
        url = override.usagePath
      }
    }
    sources[sourceId] = {
      ...base,
      url,
      // 总开关关闭时所有数据源一起停：不读上游、不回条目。
      enabled: resolved.enabled !== false && override.enabled !== false,
      routeMatch: {
        ...base.routeMatch,
        baseHosts: override.baseHosts !== undefined ? override.baseHosts : base.routeMatch.baseHosts,
        aliases: override.aliases !== undefined ? override.aliases : base.routeMatch.aliases,
      },
    }
  }
  return sources
}

/**
 * 回显用的只读视图：生效配置 + 本机命中的真实路由 id + 凭据**引用名**。
 * @param resolved - resolveConfig 的返回值。
 * @param sources - effectiveSourcesOf 的返回值。
 * @param providers - settings 的 providers 段（可空）。
 * @returns 可直接 JSON 化的对象（无凭据值）。
 */
function configViewOf(resolved, sources, providers) {
  const view = {}
  for (const sourceId of Object.keys(sources)) {
    const source = sources[sourceId]
    const routeIds = routeIdsFor(providers, source)
    const refNames = []
    for (let index = routeIds.length - 1; index >= 0; index -= 1) {
      const profile = providers !== null && Object.prototype.hasOwnProperty.call(providers, routeIds[index])
        ? providers[routeIds[index]] : null
      const ref = profile !== null && typeof profile === 'object' ? strOrNull(profile.apiKeyEnv) : null
      if (ref !== null) {
        refNames.push(ref)
        break
      }
    }
    if (source.auth.kind === 'grant') refNames.push(source.auth.recordKey)
    else for (const ref of source.auth.fallbackRefs) refNames.push(ref)
    const uniqueRefs = []
    for (const ref of refNames) if (uniqueRefs.includes(ref) !== true) uniqueRefs.push(ref)
    view[sourceId] = {
      enabled: source.enabled !== false,
      usageUrl: source.url,
      baseHosts: source.routeMatch.baseHosts,
      aliases: source.routeMatch.aliases,
      auth: source.auth.kind,
      refNames: uniqueRefs,
      parser: typeof source.parse === 'function' ? source.parse.name : null,
      routeIds,
    }
  }
  return {
    ok: true,
    configVersion: resolved.configVersion,
    enabled: resolved.enabled,
    cacheTtlMs: resolved.cacheTtlMs,
    timeoutMs: resolved.timeoutMs,
    warnings: resolved.warnings,
    sources: view,
    ui: resolved.ui,
  }
}

/** 宽松取数：Kimi 的计数是字符串数字（`"limit":"100"`），Codex 的是数字。 */
function looseNum(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function clampPercent(percent) {
  return Math.min(MAX_PERCENT, Math.max(0, percent))
}

/** 整数字段（Kimi 的金额/计数是字符串数字）：非整数或不可解析回 null。 */
function intOf(value) {
  const parsed = looseNum(value)
  return parsed === null ? null : Math.trunc(parsed)
}

/**
 * Kimi 定点金额（`1e6` 定点分）→ 分。常量与取整规则取自 Kimi CLI 自己的实现
 * （`fixedPointToCents`）：不足 1 分但大于 0 的余额算 1 分，其余四舍五入。
 */
function fixedPointToCents(value) {
  const cents = value / 1e6
  if (cents > 0 && cents < 1) return 1
  return Math.round(cents)
}

/** Kimi `{currency, priceInCents}` → `{cents, currency}`；缺 priceInCents 回 null。 */
function moneyOf(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const cents = intOf(raw.priceInCents)
  if (cents === null) return null
  return { cents, currency: strOrNull(raw.currency) ?? '' }
}

/**
 * Kimi `booster_wallet` → 账单口径（Extra Usage）。
 * Kimi 的「月度」维度**不是用量窗口而是钱**：CLI 把它渲染成 `Used this month` /
 * `Monthly limit` / `Balance` 三行（见 `buildExtraUsageSection`），本函数按其口径
 * 取值（类型必须是 `BOOSTER`、`amount > 0`，否则整段不显示）。
 * 比 CLI 多做一件：把 `status` 一并带出，供客户端标注钱包停用（CLI 忽略了它，
 * 于是本机 `STATUS_DISABLED` 的余额仍被显示成可用余额）。
 * @param raw - `payload.booster_wallet`。
 * @returns 账单对象或 null。
 */
function extraUsageFromBoosterWallet(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const balance = raw.balance !== null && typeof raw.balance === 'object' ? raw.balance : null
  if (balance === null || balance.type !== 'BOOSTER') return null
  const amount = intOf(balance.amount)
  if (amount === null || amount <= 0) return null
  const amountLeft = intOf(balance.amountLeft)
  const monthlyLimit = moneyOf(raw.monthlyChargeLimit)
  const monthlyUsed = moneyOf(raw.monthlyUsed)
  const currency = (monthlyLimit !== null && monthlyLimit.currency !== '' ? monthlyLimit.currency : null)
    ?? (monthlyUsed !== null && monthlyUsed.currency !== '' ? monthlyUsed.currency : null)
    ?? 'USD'
  return {
    totalCents: fixedPointToCents(amount),
    balanceCents: amountLeft === null ? 0 : fixedPointToCents(amountLeft),
    monthlyUsedCents: monthlyUsed === null ? null : monthlyUsed.cents,
    monthlyChargeLimitCents: monthlyLimit === null ? null : monthlyLimit.cents,
    // 与 CLI 同口径：只有 enabled 且上限 > 0 才当作有月度上限，否则是 Unlimited。
    monthlyChargeLimitEnabled: raw.monthlyChargeLimitEnabled === true,
    currency,
    status: strOrNull(raw.status),
  }
}

/** 秒 / 毫秒时间戳或 ISO 字符串 → epoch 秒；不识别的输入回 null。 */
function epochSecondsOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return null
    return value > 1e12 ? Math.round(value / 1000) : Math.round(value)
  }
  if (typeof value === 'string' && value.length > 0) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric > 0 ? Math.round(numeric) : null
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return Math.round(parsed / 1000)
  }
  return null
}

/** `limit_5h` → 18000；键形不符合或数值不合法回 null。 */
function windowSecondsFromKey(key) {
  if (typeof key !== 'string') return null
  const matched = KIMI_WINDOW_KEY.exec(key)
  if (matched === null) return null
  const amount = Number(matched[1])
  const unit = WINDOW_UNIT_SECONDS[matched[2].toLowerCase()]
  if (Number.isFinite(amount) !== true || amount <= 0 || unit === undefined) return null
  return amount * unit
}

/**
 * 上游窗口对象 → 内部窗口。
 * 窗口语义按 `limit_window_seconds` 判定，**不按 primary/secondary 角色**：
 * 上游角色与「5 小时 / 7 天」的对应关系可以变，时长不会。
 * @param raw - 上游 `primary_window` / `secondary_window`。
 * @returns 内部窗口或 null（字段不全即丢弃，不编造）。
 */
function windowFromRaw(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const usedPercent = numOrNull(raw.used_percent)
  const windowSeconds = numOrNull(raw.limit_window_seconds)
  if (usedPercent === null || windowSeconds === null || windowSeconds <= 0) return null
  const resetsAt = numOrNull(raw.reset_at)
  const resetAfterSeconds = numOrNull(raw.reset_after_seconds)
  return {
    windowSeconds,
    usedPercent: clampPercent(usedPercent),
    resetsAt: resetsAt !== null && resetsAt > 0 ? resetsAt : null,
    resetAfterSeconds: resetAfterSeconds !== null && resetAfterSeconds >= 0 ? resetAfterSeconds : null,
  }
}

/**
 * 额度响应体 → 浏览器半消费的条目。
 * 只取「已用百分比 + 窗口时长 + 重置时刻」这三样能核对的字段；窗口按时长
 * 升序（5h 在 7d 前）。两个窗口都取不到时返回 null —— 宁可不显示，也不拿
 * 缺字段的数据凑一个百分比。
 * @param payload - `wham/usage` 的 JSON。
 * @param nowMs - 取值时刻（写进 fetchedAt）。
 * @returns 条目或 null。
 */
function entryFromPayload(payload, nowMs) {
  if (payload === null || typeof payload !== 'object') return null
  const limits = payload.rate_limit !== null && typeof payload.rate_limit === 'object'
    ? payload.rate_limit
    : (payload.rateLimits !== null && typeof payload.rateLimits === 'object' ? payload.rateLimits : null)
  const windows = []
  if (limits !== null) {
    for (const raw of [limits.primary_window, limits.secondary_window]) {
      const window = windowFromRaw(raw)
      if (window !== null) windows.push(window)
    }
  }
  if (windows.length === 0) return null
  windows.sort((a, b) => a.windowSeconds - b.windowSeconds)
  const credits = payload.credits !== null && typeof payload.credits === 'object'
    ? {
      hasCredits: payload.credits.has_credits === true,
      unlimited: payload.credits.unlimited === true,
      balance: typeof payload.credits.balance === 'string' ? payload.credits.balance : null,
    }
    : null
  return {
    ok: true,
    plan: strOrNull(payload.plan_type),
    limitReached: limits !== null && limits.limit_reached === true,
    windows,
    credits,
    fetchedAt: numOrNull(nowMs) !== null ? nowMs : Date.now(),
  }
}

/**
 * Kimi `usages` 视图 → 内部窗口（首选路径）。
 * 键自带窗口时长（`limit_5h` / `limit_7d`），故不必猜语义；`used_ratio` 实测
 * 是 0..1 的比例（`1` 对应 `limit/used` 的 `100/100`），按比例折算百分比。
 * @param payload - `/usages` 的 JSON。
 * @returns 窗口数组（可能为空）。
 */
function kimiWindowsFromUsages(payload) {
  const usages = payload.usages
  if (usages === null || typeof usages !== 'object' || Array.isArray(usages)) return []
  const windows = []
  for (const key of Object.keys(usages)) {
    const windowSeconds = windowSecondsFromKey(key)
    if (windowSeconds === null) continue
    const raw = usages[key]
    if (raw === null || typeof raw !== 'object') continue
    const ratio = looseNum(raw.used_ratio)
    if (ratio === null) continue
    windows.push({
      windowSeconds,
      usedPercent: clampPercent(ratio * 100),
      resetsAt: epochSecondsOf(raw.reset_time !== undefined ? raw.reset_time : raw.resetTime),
      resetAfterSeconds: null,
    })
  }
  return windows
}

/**
 * Kimi `limits[]` 计数视图 → 内部窗口（`usages` 缺席时的回退，老账号形态）。
 * 计数是字符串数字：`used` 优先由 `limit - remaining` 求得，其次用 `used` 字段。
 * 窗口时长取自 `window.duration` + `window.timeUnit`。
 * @param payload - `/usages` 的 JSON。
 * @returns 窗口数组（可能为空）。
 */
function kimiWindowsFromCounts(payload) {
  if (Array.isArray(payload.limits) !== true) return []
  const windows = []
  for (const item of payload.limits) {
    if (item === null || typeof item !== 'object') continue
    const window = item.window !== null && typeof item.window === 'object' ? item.window : null
    if (window === null) continue
    const detail = item.detail !== null && typeof item.detail === 'object' ? item.detail : item
    const duration = looseNum(window.duration)
    const unitSeconds = KIMI_TIME_UNIT_SECONDS[String(window.timeUnit)]
    if (duration === null || duration <= 0 || unitSeconds === undefined) continue
    const limit = looseNum(detail.limit)
    const remaining = looseNum(detail.remaining)
    const used = looseNum(detail.used)
    let usedPercent = null
    if (limit !== null && limit > 0) {
      const consumed = remaining !== null ? limit - remaining : used
      if (consumed !== null) usedPercent = clampPercent((consumed / limit) * 100)
    }
    if (usedPercent === null) continue
    const resetRaw = detail.reset_time !== undefined ? detail.reset_time : detail.resetTime
    windows.push({
      windowSeconds: duration * unitSeconds,
      usedPercent,
      resetsAt: epochSecondsOf(resetRaw !== undefined ? resetRaw : item.reset_time),
      resetAfterSeconds: null,
    })
  }
  return windows
}

/**
 * Kimi 裸 `usage` 计数 → 内部窗口（最后兜底：两份视图都没有时）。
 * 该字段不带窗口时长，按 `KIMI_WEEKLY_WINDOW_SECONDS` 处理。
 * @param payload - `/usages` 的 JSON。
 * @returns 窗口数组（0 或 1 项）。
 */
function kimiWindowsFromWeeklyUsage(payload) {
  const usage = payload.usage
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return []
  const limit = looseNum(usage.limit)
  const remaining = looseNum(usage.remaining)
  const used = looseNum(usage.used)
  let usedPercent = null
  if (limit !== null && limit > 0) {
    const consumed = remaining !== null ? limit - remaining : used
    if (consumed !== null) usedPercent = clampPercent((consumed / limit) * 100)
  }
  if (usedPercent === null) return []
  const resetRaw = usage.reset_time !== undefined ? usage.reset_time : usage.resetTime
  return [{
    windowSeconds: KIMI_WEEKLY_WINDOW_SECONDS,
    usedPercent,
    resetsAt: epochSecondsOf(resetRaw),
    resetAfterSeconds: null,
  }]
}

/**
 * Kimi `/usages` 响应体 → 浏览器半消费的条目。
 * 取值优先级：`usages`（带窗口时长，最可靠）→ `limits[]`（计数）→ `usage`。
 * 三处都取不到窗口就回 null（不显示）。
 * Kimi 不提供套餐名与 `limit_reached` 标志，故 `plan` 恒为 null、
 * `limitReached` 由「有窗口已用满」推导。
 * **用量窗口只有 5h 与 7d 两个维度**（实测 `usages` 只有 `limit_5h`/`limit_7d`，
 * `limits[]` 只有一条 5h；Kimi CLI 的窗口来源同样只有顶层 `usage`（周）与
 * `limits[]`）。控制台里那个「月度」维度是**账单**（`booster_wallet`），走
 * `extraUsage` 字段交给客户端在悬停说明里展示，不伪装成第三个百分比窗口。
 * @param payload - `/usages` 的 JSON。
 * @param nowMs - 取值时刻（写进 fetchedAt）。
 * @returns 条目或 null。
 */
function kimiEntryFromPayload(payload, nowMs) {
  if (payload === null || typeof payload !== 'object') return null
  let windows = kimiWindowsFromUsages(payload)
  if (windows.length === 0) windows = kimiWindowsFromCounts(payload)
  if (windows.length === 0) windows = kimiWindowsFromWeeklyUsage(payload)
  if (windows.length === 0) return null
  windows.sort((a, b) => a.windowSeconds - b.windowSeconds)
  return {
    ok: true,
    plan: null,
    limitReached: windows.some((window) => window.usedPercent >= MAX_PERCENT),
    windows,
    credits: null,
    extraUsage: extraUsageFromBoosterWallet(payload.booster_wallet),
    fetchedAt: numOrNull(nowMs) !== null ? nowMs : Date.now(),
  }
}

/**
 * OpenCode Go `/usage` 响应体 → 浏览器半消费的条目。
 * 兼容旧 `{usage:{rolling:{status,percent,resetsAt},...}}` 与当前
 * `{plan,windows:[{name,status,usagePercent,resetInSec}]}`。两种结构都只有订阅级
 * 百分比，不按模型拆，也不直接给标准窗口秒数，因此统一映射到 5h / 7d / 30d。
 * 未知窗口名与缺失百分比的窗口会被忽略；非 ok 状态视为已达上限。
 * @param payload - `/usage` 的 JSON。
 * @param nowMs - 取值时刻（写进 fetchedAt）。
 * @returns 条目或 null。
 */
function opencodeEntryFromPayload(payload, nowMs) {
  if (payload === null || typeof payload !== 'object') return null

  const candidates = []
  const legacy = payload.usage
  if (legacy !== null && typeof legacy === 'object' && Array.isArray(legacy) !== true) {
    for (const key of Object.keys(OPENCODE_WINDOW_SECONDS)) {
      const raw = legacy[key]
      if (raw !== null && typeof raw === 'object') candidates.push({ key, raw, legacy: true })
    }
  }
  if (Array.isArray(payload.windows)) {
    for (const raw of payload.windows) {
      if (raw === null || typeof raw !== 'object') continue
      const name = strOrNull(raw.name)?.toLowerCase() ?? ''
      const key = name.includes('month') ? 'monthly'
        : name.includes('week') ? 'weekly'
          : (name.includes('rolling') || name.includes('hour')) ? 'rolling' : null
      if (key !== null) candidates.push({ key, raw, legacy: false })
    }
  }

  const windows = []
  let statusLimited = false
  const seen = new Set()
  for (const candidate of candidates) {
    if (seen.has(candidate.key)) continue
    const raw = candidate.raw
    const percent = looseNum(candidate.legacy ? raw.percent : raw.usagePercent)
    if (percent === null) continue
    seen.add(candidate.key)
    const status = strOrNull(raw.status)
    if (status !== null && status !== 'ok') statusLimited = true
    const resetInSec = candidate.legacy ? null : looseNum(raw.resetInSec)
    windows.push({
      windowSeconds: OPENCODE_WINDOW_SECONDS[candidate.key],
      usedPercent: clampPercent(percent),
      resetsAt: candidate.legacy ? epochSecondsOf(raw.resetsAt) : null,
      resetAfterSeconds: resetInSec !== null && resetInSec >= 0 ? resetInSec : null,
    })
  }
  if (windows.length === 0) return null
  windows.sort((a, b) => a.windowSeconds - b.windowSeconds)
  return {
    ok: true,
    plan: strOrNull(payload.plan),
    limitReached: statusLimited || windows.some((window) => window.usedPercent >= MAX_PERCENT),
    windows,
    credits: null,
    fetchedAt: numOrNull(nowMs) !== null ? nowMs : Date.now(),
  }
}

/**
 * 只读额度服务（无出站副作用之外的状态）：缓存 + 单飞（single-flight）。
 * 同一路由并发进入时共用同一个上游请求，避免并发刷新同一份额度。
 * @param options - { credentialsOf, settingsOf?, now?, fetchImpl? }。
 * @returns { readOne, readAll, invalidate }。
 */
function createQuotaService(options) {
  const config = options !== null && typeof options === 'object' ? options : {}
  const now = typeof config.now === 'function' ? config.now : Date.now
  /** 生效数据源表（默认为代码常量表，测试可注入）。 */
  const sources = config.sources !== null && typeof config.sources === 'object' ? config.sources : QUOTA_SOURCES
  const cacheTtlMs = intOf(config.cacheTtlMs) !== null ? config.cacheTtlMs : CACHE_TTL_MS
  const timeoutMs = intOf(config.timeoutMs) !== null ? config.timeoutMs : UPSTREAM_TIMEOUT_MS
  const credentialsOf = typeof config.credentialsOf === 'function' ? config.credentialsOf : () => undefined
  const settingsOf = typeof config.settingsOf === 'function' ? config.settingsOf : () => undefined
  const fetchImpl = typeof config.fetchImpl === 'function' ? config.fetchImpl : undefined
  const cache = new Map()
  const inflight = new Map()

  /**
   * settings 里该路由当前生效的凭据引用名；读不到回 null。
   * 不缓存：用户手工改 settings 立即被采纳。
   * `route` 必须是**本机真实路由 id**（如 `opencodego`）——传规范名会让回退引用名
   * 顶替掉该路由真正配置的那把 key，从而读到另一账号的额度。
   */
  function configuredRefOf(route) {
    const providers = providersSectionOf(settingsOf())
    if (providers === null) return null
    const profile = providers[route]
    if (profile === null || typeof profile !== 'object') return null
    return strOrNull(profile.apiKeyEnv)
  }

  /**
   * 解析数据源凭据 → `{token, accountId?, ref?}`，或 `{failure}`。
   * 全部只读：不续期、不写回。任一步失败都失败闭合，不回半份凭据。
   */
  async function authOf(route, source) {
    const credentials = credentialsOf()
    if (credentials === null || credentials === undefined) {
      return { failure: { ok: false, reason: 'credentials-unavailable' } }
    }
    const spec = source.auth
    if (spec.kind === 'grant') {
      if (typeof credentials.readRecord !== 'function') {
        return { failure: { ok: false, reason: 'credentials-unavailable' } }
      }
      let record
      try {
        record = await credentials.readRecord(spec.recordKey)
      } catch (error) {
        return { failure: { ok: false, reason: 'credentials-error', message: messageOf(error) } }
      }
      if (record === null || record === undefined || record.kind !== 'grant') {
        return { failure: { ok: false, reason: 'not-configured' } }
      }
      const payload = record.payload
      if (payload === null || typeof payload !== 'object') return { failure: { ok: false, reason: 'not-configured' } }
      const access = strOrNull(payload.access)
      const accountId = strOrNull(payload.accountId)
      if (access === null || accountId === null) return { failure: { ok: false, reason: 'not-configured' } }
      const expires = numOrNull(payload.expires)
      if (expires !== null && expires <= now() + EXPIRY_SKEW_MS) return { failure: { ok: false, reason: 'token-expired' } }
      return { token: access, accountId }
    }
    if (spec.kind === 'ref') {
      if (typeof credentials.resolve !== 'function') {
        return { failure: { ok: false, reason: 'credentials-unavailable' } }
      }
      // 以路由当前生效的 apiKeyEnv 为准，再依次回退到声明的兼容引用名。
      const candidates = []
      const configured = configuredRefOf(route)
      if (configured !== null) candidates.push(configured)
      for (const fallback of Array.isArray(spec.fallbackRefs) ? spec.fallbackRefs : []) {
        if (typeof fallback === 'string' && fallback.length > 0 && candidates.includes(fallback) !== true) {
          candidates.push(fallback)
        }
      }
      if (candidates.length === 0) return { failure: { ok: false, reason: 'not-configured' } }
      let failed = false
      for (const ref of candidates) {
        let hit
        try {
          hit = await credentials.resolve(ref)
        } catch (error) {
          failed = true
          continue
        }
        const value = hit !== null && typeof hit === 'object' ? strOrNull(hit.value) : null
        if (value !== null) return { token: value, ref }
      }
      // 引用存在但取不到值：实在分不清「没配」和「读失败」时按没配置处理，
      // 只有 resolve 真的抛错才回 credentials-error。
      return { failure: { ok: false, reason: failed ? 'credentials-error' : 'not-configured' } }
    }
    return { failure: { ok: false, reason: 'unsupported' } }
  }

  async function fetchOne(route, source) {
    const auth = await authOf(route, source)
    if (auth.failure !== undefined) return auth.failure
    const doFetch = fetchImpl !== undefined ? fetchImpl : (typeof fetch === 'function' ? fetch : undefined)
    if (doFetch === undefined) return { ok: false, reason: 'fetch-unavailable' }
    let response
    try {
      response = await doFetch(source.url, {
        method: 'GET',
        headers: {
          authorization: 'Bearer ' + auth.token,
          accept: 'application/json',
          ...source.headers(auth),
        },
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(timeoutMs)
          : undefined,
      })
    } catch (error) {
      return { ok: false, reason: 'network', message: messageOf(error) }
    }
    const status = response !== null && typeof response === 'object' ? response.status : undefined
    if (status !== 200) return { ok: false, reason: 'http-' + String(status) }
    let payload
    try {
      payload = await response.json()
    } catch (error) {
      return { ok: false, reason: 'bad-json' }
    }
    return source.parse(payload, now()) ?? { ok: false, reason: 'no-windows' }
  }

  /** 该数据源在 readAll 里对外暴露的键：规范名 + baseURL 判定的真实 id。 */
  function emittedIdsOf(providers, sourceId) {
    const ids = [sourceId]
    for (const id of matchedRouteIds(providers, sources[sourceId])) {
      if (ids.includes(id) !== true) ids.push(id)
    }
    return ids
  }

  /**
   * 决定用哪把凭据的路由 id：优先 settings 里真实存在的那个（命中 baseURL 的），
   * 否则回数据源规范名。
   */
  function credentialRouteIdOf(providers, sourceId) {
    if (providers !== null) {
      const ids = matchedRouteIds(providers, sources[sourceId])
      for (let index = ids.length - 1; index >= 0; index -= 1) {
        const profile = providers[ids[index]]
        if (profile !== null && typeof profile === 'object') return ids[index]
      }
    }
    return sourceId
  }

  /**
   * 按 **sourceId** 缓存 / 单飞：同一份上游数据即使被多个路由 id 共用也只打一次。
   * @param sourceId - QUOTA_SOURCES 的键。
   * @param credentialRouteId - 解析凭据用的真实路由 id。
   */
  function readSource(sourceId, credentialRouteId) {
    const source = sources[sourceId]
    if (source === undefined) return Promise.resolve({ ok: false, reason: 'unsupported' })
    if (source.enabled === false) return Promise.resolve({ ok: false, reason: 'disabled' })
    const cached = cache.get(sourceId)
    if (cached !== undefined && now() - cached.at < cacheTtlMs) return Promise.resolve(cached.entry)
    const pending = inflight.get(sourceId)
    if (pending !== undefined) return pending
    const task = fetchOne(credentialRouteId, source)
      .catch((error) => ({ ok: false, reason: 'unexpected', message: messageOf(error) }))
      .then((entry) => {
        cache.set(sourceId, { at: now(), entry })
        return entry
      })
      .finally(() => { inflight.delete(sourceId) })
    inflight.set(sourceId, task)
    return task
  }

  async function readOne(route) {
    const providers = providersSectionOf(settingsOf())
    const hit = sourceOfRoute(route, providers, sources)
    if (hit === null) return { ok: false, reason: 'unsupported' }
    return readSource(hit.sourceId, credentialRouteIdOf(providers, hit.sourceId))
  }

  async function readAll() {
    const providers = providersSectionOf(settingsOf())
    const routes = {}
    await Promise.all(Object.keys(sources).map(async (sourceId) => {
      const entry = await readSource(sourceId, credentialRouteIdOf(providers, sourceId))
      // 同一份条目写给每个键：本机 id（如 opencodego）与规范名（opencode-go）都能命中。
      for (const id of emittedIdsOf(providers, sourceId)) routes[id] = entry
    }))
    return routes
  }

  function invalidate(route) {
    if (route === undefined) { cache.clear(); return }
    const hit = sourceOfRoute(route, providersSectionOf(settingsOf()), sources)
    cache.delete(hit !== null ? hit.sourceId : route)
  }

  return { readOne, readAll, invalidate }
}

/** 只读 JSON 端点助手（与宿主 webServer 的 register 形状对齐）。 */
function sendJson(res, status, payload) {
  let body
  try {
    body = JSON.stringify(payload)
  } catch (error) {
    body = '{"ok":false,"error":"response is not serializable"}'
    status = 500
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** 只应答本机回环：额度端点不对外网暴露。 */
function isLocalRequest(req) {
  const socket = req !== null && req !== undefined ? req.socket : undefined
  const addr = socket !== null && socket !== undefined ? socket.remoteAddress : undefined
  if (typeof addr !== 'string' || addr.length === 0) return true
  return addr === '::1' || addr === '::ffff:127.0.0.1' || addr.indexOf('127.') === 0
}

export function apply(ctx, rawConfig) {
  const resolved = resolveConfig(rawConfig)
  const sources = effectiveSourcesOf(resolved)
  const service = createQuotaService({
    credentialsOf: () => ctx.get('credentials'),
    settingsOf: () => ctx.get('settings'),
    sources,
    cacheTtlMs: resolved.cacheTtlMs,
    timeoutMs: resolved.timeoutMs,
  })
  for (const warning of resolved.warnings) {
    ctx.logger?.warn?.('[dsh-plugin-provider-badge] config ' + warning.path + ': ' + warning.message)
  }

  // 凭据被 pi-ai 刷新/替换后立刻丢弃缓存：否则过期判断会拿旧令牌继续算 60s。
  // 引用型数据源（apiKeyEnv）没有记录级事件，改动在缓存窗口内自然过期。
  if (typeof ctx.on === 'function') {
    ctx.on('credentials/record-updated', (key) => {
      for (const [route, source] of Object.entries(sources)) {
        if (source.auth.kind === 'grant' && source.auth.recordKey === key) service.invalidate(route)
      }
    })
  }

  ctx.inject(['webServer'], (webCtx) => {
    ctx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: QUOTA_PATH,
        handler: async (req, res) => {
          if (isLocalRequest(req) !== true) return sendJson(res, 403, { ok: false, error: 'local requests only' })
          if (req !== null && typeof req === 'object' && req.method !== 'GET') {
            return sendJson(res, 405, { ok: false, error: 'GET only' })
          }
          try {
            // 总开关关闭：不读上游、不回条目，浏览器半据此不渲染任何额度。
            if (resolved.enabled !== true) {
              return sendJson(res, 200, { ok: true, updatedAt: Date.now(), routes: {}, disabled: true })
            }
            return sendJson(res, 200, { ok: true, updatedAt: Date.now(), routes: await service.readAll() })
          } catch (error) {
            return sendJson(res, 200, { ok: true, updatedAt: Date.now(), routes: {}, error: messageOf(error) })
          }
        },
      }),
      'provider-badge: ' + QUOTA_PATH,
    )

    // 可见配置：只读回显生效结果（无凭据值），改了配置不用再读 JS。
    ctx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: CONFIG_PATH,
        handler: async (req, res) => {
          if (isLocalRequest(req) !== true) return sendJson(res, 403, { ok: false, error: 'local requests only' })
          if (req !== null && typeof req === 'object' && req.method !== 'GET') {
            return sendJson(res, 405, { ok: false, error: 'GET only' })
          }
          try {
            return sendJson(res, 200, configViewOf(resolved, sources, providersSectionOf(ctx.get('settings'))))
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: messageOf(error) })
          }
        },
      }),
      'provider-badge: ' + CONFIG_PATH,
    )
  })

  if (resolved.enabled !== true) {
    ctx.logger?.warn?.('[dsh-plugin-provider-badge] config enabled=false: 额度端点仍挂载但一律返回 disabled')
  }
  ctx.logger?.info?.('[dsh-plugin-provider-badge] host half mounted (client badge + ' + QUOTA_PATH + ' + ' + CONFIG_PATH + ')')
}

/** probe 专用面：纯函数与额度服务工厂（不构成任何运行时承诺）。 */
export const __test = {
  PI_AI_NAMESPACE,
  QUOTA_SOURCES,
  QUOTA_PATH,
  providersSectionOf,
  CONFIG_PATH,
  CONFIG_VERSION,
  CONFIG_DEFAULTS,
  CONFIG_LIMITS,
  USAGE_HOST_ALLOWLIST,
  originOfUrl,
  isAllowedUsageUrl,
  resolveConfig,
  effectiveSourcesOf,
  configViewOf,
  routeIdsFor,
  matchedRouteIds,
  sourceOfRoute,
  CACHE_TTL_MS,
  EXPIRY_SKEW_MS,
  clampPercent,
  looseNum,
  intOf,
  fixedPointToCents,
  moneyOf,
  extraUsageFromBoosterWallet,
  epochSecondsOf,
  windowSecondsFromKey,
  windowFromRaw,
  entryFromPayload,
  kimiWindowsFromUsages,
  kimiWindowsFromCounts,
  kimiWindowsFromWeeklyUsage,
  kimiEntryFromPayload,
  OPENCODE_WINDOW_SECONDS,
  opencodeEntryFromPayload,
  createQuotaService,
  isLocalRequest,
}
