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
 *  - `opencode-go`：`https://opencode.ai/inference/go/v1/usage`（OpenCode Go /
 *    Go Plus 订阅。别名 `/zen/go/v1/usage` 实测同源同响应；`/inference/go/...`
 *    取自官方文档的端点族，故用前者）。凭据同样取该路由生效的 `apiKeyEnv`
 *    引用（本机 `OPENCODE_API_KEY`），回退 `OPENCODE_API_KEY`。
 *    响应只有订阅级三个窗口（rolling/weekly/monthly）的百分比，**不按模型拆**；
 *    窗口时长按官方文档的 5 小时 = 月度 20%、每周 = 50%、每月 = 100% 口径映射。
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
 * 失败一律降级为 `{ok:false, reason}`：额度是锦上添花，任何一环不可用都不
 * 影响模型选择流程（浏览器半对 `ok:false` 不渲染任何东西）。
 */

export const name = 'provider-badge'

/** pi-ai 的 settings 命名空间：路由当前生效的 `apiKeyEnv` 写在它下面。 */
const PI_AI_NAMESPACE = 'llm-pi-ai'

/**
 * 额度取数描述表：路由 id → 数据源。新增数据源只在这里加一条，
 * 浏览器半无需知道路由名（它整表取回，按行 id 命中）。
 *
 * 每条数据源：
 *  - `auth`：`{kind:'grant', recordKey}` 读授权记录；`{kind:'ref',
 *    fallbackRefs}` 读 settings 里该路由的 `apiKeyEnv` 凭据引用。
 *  - `headers(auth)`：除 `authorization` / `accept` 之外的附加请求头。
 *  - `parse(payload, nowMs)`：响应体 → 统一条目；取不到窗口就回 null。
 */
const QUOTA_SOURCES = Object.freeze({
  'openai-codex': Object.freeze({
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
    auth: Object.freeze({ kind: 'ref', fallbackRefs: Object.freeze(['KIMI_API_KEY']) }),
    url: 'https://api.kimi.com/coding/v1/usages',
    headers: () => ({}),
    parse: kimiEntryFromPayload,
  }),
  'opencode-go': Object.freeze({
    auth: Object.freeze({ kind: 'ref', fallbackRefs: Object.freeze(['OPENCODE_API_KEY']) }),
    url: 'https://opencode.ai/inference/go/v1/usage',
    headers: () => ({}),
    parse: opencodeEntryFromPayload,
  }),
})

/** 端点路径：浏览器半按同源相对路径请求。 */
const QUOTA_PATH = '/provider-badge/quota'
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
 * 响应形如 `{usage:{rolling:{status,percent,resetsAt},weekly:{...},monthly:{...}}}`：
 * 只有订阅级百分比，不按模型拆，也不带窗口时长（时长按官方文档口径映射）。
 * 只认 `OPENCODE_WINDOW_SECONDS` 里声明的三个键；`percent` 缺失即丢弃该窗口。
 * 已知局限：`status` 实测只有 `"ok"`，非 ok 的取值**未经验证**——这里按「非 ok
 * 即视为已达上限」处理（与 `percent >= 100` 同为红色判据）。上游不给套餐名
 * （Go 与 Go Plus 不可区分），故 `plan` 恒为 null。
 * @param payload - `/usage` 的 JSON。
 * @param nowMs - 取值时刻（写进 fetchedAt）。
 * @returns 条目或 null。
 */
function opencodeEntryFromPayload(payload, nowMs) {
  if (payload === null || typeof payload !== 'object') return null
  const usage = payload.usage
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return null
  const windows = []
  let statusLimited = false
  for (const key of Object.keys(OPENCODE_WINDOW_SECONDS)) {
    const raw = usage[key]
    if (raw === null || typeof raw !== 'object') continue
    const percent = looseNum(raw.percent)
    if (percent === null) continue
    const status = strOrNull(raw.status)
    if (status !== null && status !== 'ok') statusLimited = true
    windows.push({
      windowSeconds: OPENCODE_WINDOW_SECONDS[key],
      usedPercent: clampPercent(percent),
      resetsAt: epochSecondsOf(raw.resetsAt),
      resetAfterSeconds: null,
    })
  }
  if (windows.length === 0) return null
  windows.sort((a, b) => a.windowSeconds - b.windowSeconds)
  return {
    ok: true,
    plan: null,
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
  const credentialsOf = typeof config.credentialsOf === 'function' ? config.credentialsOf : () => undefined
  const settingsOf = typeof config.settingsOf === 'function' ? config.settingsOf : () => undefined
  const fetchImpl = typeof config.fetchImpl === 'function' ? config.fetchImpl : undefined
  const cache = new Map()
  const inflight = new Map()

  /**
   * settings 里该路由当前生效的凭据引用名；读不到回 null。
   * 不缓存：用户手工改 settings 立即被采纳。
   */
  function configuredRefOf(route) {
    const service = settingsOf()
    if (service === null || service === undefined || typeof service.describe !== 'function') return null
    let section
    try {
      // describe() 只暴露声明了 volatile 字段的条目，llm-pi-ai 的 providers 即是。
      section = service.describe().find((row) => row !== null && typeof row === 'object' && row.ns === PI_AI_NAMESPACE)?.value
    } catch (error) {
      return null
    }
    if (section === null || typeof section !== 'object') return null
    const providers = section.providers
    if (providers === null || typeof providers !== 'object') return null
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
          ? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
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

  async function readOne(route) {
    const source = Object.prototype.hasOwnProperty.call(QUOTA_SOURCES, route) ? QUOTA_SOURCES[route] : undefined
    if (source === undefined) return { ok: false, reason: 'unsupported' }
    const cached = cache.get(route)
    if (cached !== undefined && now() - cached.at < CACHE_TTL_MS) return cached.entry
    const pending = inflight.get(route)
    if (pending !== undefined) return pending
    const task = fetchOne(route, source)
      .catch((error) => ({ ok: false, reason: 'unexpected', message: messageOf(error) }))
      .then((entry) => {
        cache.set(route, { at: now(), entry })
        return entry
      })
      .finally(() => { inflight.delete(route) })
    inflight.set(route, task)
    return task
  }

  async function readAll() {
    const routes = {}
    const ids = Object.keys(QUOTA_SOURCES)
    await Promise.all(ids.map(async (route) => { routes[route] = await readOne(route) }))
    return routes
  }

  function invalidate(route) {
    if (route === undefined) cache.clear()
    else cache.delete(route)
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

export function apply(ctx) {
  const service = createQuotaService({
    credentialsOf: () => ctx.get('credentials'),
    settingsOf: () => ctx.get('settings'),
  })

  // 凭据被 pi-ai 刷新/替换后立刻丢弃缓存：否则过期判断会拿旧令牌继续算 60s。
  // 引用型数据源（apiKeyEnv）没有记录级事件，改动在缓存窗口内自然过期。
  if (typeof ctx.on === 'function') {
    ctx.on('credentials/record-updated', (key) => {
      for (const [route, source] of Object.entries(QUOTA_SOURCES)) {
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
            return sendJson(res, 200, { ok: true, updatedAt: Date.now(), routes: await service.readAll() })
          } catch (error) {
            return sendJson(res, 200, { ok: true, updatedAt: Date.now(), routes: {}, error: messageOf(error) })
          }
        },
      }),
      'provider-badge: ' + QUOTA_PATH,
    )
  })

  ctx.logger?.info?.('[dsh-plugin-provider-badge] host half mounted (client badge + ' + QUOTA_PATH + ')')
}

/** probe 专用面：纯函数与额度服务工厂（不构成任何运行时承诺）。 */
export const __test = {
  PI_AI_NAMESPACE,
  QUOTA_SOURCES,
  QUOTA_PATH,
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
