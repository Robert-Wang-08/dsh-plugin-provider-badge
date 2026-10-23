#!/usr/bin/env node
/**
 * probe/smoke-host.mjs — provider 徽标宿主半（额度端点）门禁冒烟。
 *
 * 覆盖：
 *   H1  模块形状（name / apply / __test）与数据源表
 *   H2  上游窗口 → 内部窗口的字段校验与夹取（不编造、不越界）
 *   H3  额度响应体 → 条目（窗口按时长排序、套餐/余额/上限态）
 *   H4  凭据读取（grant 型）：只读、四类降级（服务缺失 / 无记录 / 记录形状不符 / 令牌过期）
 *   H5  上游交互：URL 与请求头、非 200 只回状态码、网络异常降级
 *   H6  缓存与单飞：TTL 内不重复打上游、过期重打、invalidate 生效、并发合并
 *   H7  端点行为：非回环 403、非 GET 405、回环 GET 200 且响应体不含令牌
 *   H8  Kimi 数据源：凭据引用（ref 型）解析与降级、计数回退、窗口口径
 *   H9  OpenCode Go 数据源：订阅级三窗口（5h/7d/30d）、未公开端点的降级与鉴权
 *
 * 用法：node probe/smoke-host.mjs   （期望输出 ALL PASSED）
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(new URL('../index.js', import.meta.url))
const {
  name, apply, __test,
} = mod
const {
  PI_AI_NAMESPACE, QUOTA_SOURCES, QUOTA_PATH, CACHE_TTL_MS, EXPIRY_SKEW_MS,
  looseNum, epochSecondsOf, windowSecondsFromKey,
  intOf, fixedPointToCents, moneyOf, extraUsageFromBoosterWallet,
  windowFromRaw, entryFromPayload,
  kimiWindowsFromUsages, kimiWindowsFromCounts, kimiWindowsFromWeeklyUsage, kimiEntryFromPayload,
  OPENCODE_WINDOW_SECONDS, opencodeEntryFromPayload,
  createQuotaService, isLocalRequest,
  CONFIG_PATH, CONFIG_VERSION, CONFIG_DEFAULTS, USAGE_HOST_ALLOWLIST,
  resolveConfig, effectiveSourcesOf, configViewOf,
  providersSectionOf, routeIdsFor, matchedRouteIds, sourceOfRoute,
} = __test

let passed = 0
let failed = 0
function check(label, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok  ${label}`)
  } else {
    failed += 1
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/* ── H1：模块形状 ─────────────────────────────────────────────────── */

check('H1 name = provider-badge', name === 'provider-badge')
check('H1 apply 是函数', typeof apply === 'function')
check('H1 数据源表恰为 codex / kimi / opencode-go 三条', (() => {
  const ids = Object.keys(QUOTA_SOURCES).sort()
  return ids.length === 3 && ids[0] === 'kimi-coding' && ids[1] === 'openai-codex' && ids[2] === 'opencode-go'
})())
check('H1 codex 数据源记录地址为拥有者 scope 形状', QUOTA_SOURCES['openai-codex'].auth.kind === 'grant'
  && QUOTA_SOURCES['openai-codex'].auth.recordKey === 'llm-pi-ai/openai-codex')
check('H1 codex 上游走 wham/usage（codex/usage 实测 403）', QUOTA_SOURCES['openai-codex'].url === 'https://chatgpt.com/backend-api/wham/usage')
check('H1 kimi 数据源走 apiKeyEnv 引用并回退 KIMI_API_KEY', QUOTA_SOURCES['kimi-coding'].auth.kind === 'ref'
  && QUOTA_SOURCES['kimi-coding'].auth.fallbackRefs.join(',') === 'KIMI_API_KEY')
check('H1 kimi 上游走 /coding/v1/usages', QUOTA_SOURCES['kimi-coding'].url === 'https://api.kimi.com/coding/v1/usages')
check('H1 opencode-go 数据源走 apiKeyEnv 引用并回退 OPENCODE_API_KEY / OPENCODEGO_API_KEY', QUOTA_SOURCES['opencode-go'].auth.kind === 'ref'
  && QUOTA_SOURCES['opencode-go'].auth.fallbackRefs.join(',') === 'OPENCODE_API_KEY,OPENCODEGO_API_KEY')
check('H1 opencode-go 用 baseURL 判定真实路由 id（别名 opencode-go / opencodego）', (() => {
  const match = QUOTA_SOURCES['opencode-go'].routeMatch
  return match.baseHosts.join(',') === 'opencode.ai/zen/go'
    && match.aliases.join(',') === 'opencode-go,opencodego'
})())
check('H1 kimi / codex 数据源也声明了 routeMatch（同一套判定入口）', QUOTA_SOURCES['kimi-coding'].routeMatch.baseHosts.join(',') === 'api.kimi.com/coding'
  && QUOTA_SOURCES['openai-codex'].routeMatch.aliases.join(',') === 'openai-codex')
check('H1 opencode-go 上游走 /zen/go/v1/usage（当前 CLI 推导路径）',
  QUOTA_SOURCES['opencode-go'].url === 'https://opencode.ai/zen/go/v1/usage')
check('H1 三条数据源的 headers 只额外加 Codex 专属头', (() => {
  const codex = QUOTA_SOURCES['openai-codex'].headers({ accountId: 'acct-1' })
  return Object.keys(codex).length === 3 && codex.originator === 'pi'
    && Object.keys(QUOTA_SOURCES['kimi-coding'].headers()).length === 0
    && Object.keys(QUOTA_SOURCES['opencode-go'].headers()).length === 0
})())
check('H1 数据源表自带 parse 与 headers', typeof QUOTA_SOURCES['kimi-coding'].parse === 'function'
  && typeof QUOTA_SOURCES['kimi-coding'].headers === 'function'
  && typeof QUOTA_SOURCES['openai-codex'].parse === 'function')
check('H1 数据源表被冻结（运行期不可被改写）', Object.isFrozen(QUOTA_SOURCES) && Object.isFrozen(QUOTA_SOURCES['kimi-coding'].auth))
check('H1 pi-ai 命名空间常量为 llm-pi-ai', PI_AI_NAMESPACE === 'llm-pi-ai')
check('H1 端点路径固定', QUOTA_PATH === '/provider-badge/quota')

/* ── H2：窗口字段校验 ─────────────────────────────────────────────── */

check('H2 合法窗口透传', (() => {
  const w = windowFromRaw({ used_percent: 4, limit_window_seconds: 18000, reset_at: 1792219608, reset_after_seconds: 13363 })
  return w.windowSeconds === 18000 && w.usedPercent === 4 && w.resetsAt === 1792219608 && w.resetAfterSeconds === 13363
})())
check('H2 缺 used_percent → null', windowFromRaw({ limit_window_seconds: 18000 }) === null)
check('H2 缺 limit_window_seconds → null', windowFromRaw({ used_percent: 4 }) === null)
check('H2 时长非正 → null', windowFromRaw({ used_percent: 4, limit_window_seconds: 0 }) === null
  && windowFromRaw({ used_percent: 4, limit_window_seconds: -1 }) === null)
check('H2 非对象 → null', windowFromRaw(null) === null && windowFromRaw('x') === null && windowFromRaw(7) === null)
check('H2 used_percent 夹取到 [0,100]', (() => {
  const high = windowFromRaw({ used_percent: 180, limit_window_seconds: 18000 })
  const low = windowFromRaw({ used_percent: -3, limit_window_seconds: 18000 })
  return high.usedPercent === 100 && low.usedPercent === 0
})())
check('H2 重置字段缺失 → null 而非 0', (() => {
  const w = windowFromRaw({ used_percent: 4, limit_window_seconds: 18000 })
  return w.resetsAt === null && w.resetAfterSeconds === null
})())
check('H2 非法重置字段被丢弃', (() => {
  const w = windowFromRaw({ used_percent: 4, limit_window_seconds: 18000, reset_at: 0, reset_after_seconds: -1 })
  return w.resetsAt === null && w.resetAfterSeconds === null
})())

/* ── H3：响应体 → 条目 ────────────────────────────────────────────── */

const REAL_PAYLOAD = {
  user_id: 'user-x',
  account_id: 'acct-x',
  email: 'nobody@example.invalid',
  plan_type: 'plus',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 4, limit_window_seconds: 18000, reset_after_seconds: 13363, reset_at: 1792219608 },
    secondary_window: { used_percent: 35, limit_window_seconds: 604800, reset_after_seconds: 455917, reset_at: 1792662162 },
  },
  credits: { has_credits: false, unlimited: false, balance: '0' },
}

const entry = entryFromPayload(REAL_PAYLOAD, 1792206238452)
check('H3 条目成型：ok/plan/limitReached', entry !== null && entry.ok === true && entry.plan === 'plus' && entry.limitReached === false)
check('H3 条目不含账号标识（只回用量字段）', (() => {
  const json = JSON.stringify(entry)
  return !json.includes('nobody@example.invalid') && !json.includes('acct-x') && !json.includes('user-x')
})())
check('H3 窗口按时长升序（上游是 5h 在前也重排成同一口径）', entry.windows.length === 2
  && entry.windows[0].windowSeconds === 18000 && entry.windows[1].windowSeconds === 604800)
check('H3 上游把 5h 放在 secondary 也能识别（按时长不按角色）', (() => {
  const swapped = {
    rate_limit: {
      primary_window: { used_percent: 35, limit_window_seconds: 604800 },
      secondary_window: { used_percent: 4, limit_window_seconds: 18000 },
    },
  }
  const e = entryFromPayload(swapped, 1)
  return e.windows[0].windowSeconds === 18000 && e.windows[0].usedPercent === 4
    && e.windows[1].windowSeconds === 604800 && e.windows[1].usedPercent === 35
})())
check('H3 只有单窗口也成型', (() => {
  const e = entryFromPayload({ rate_limit: { primary_window: { used_percent: 4, limit_window_seconds: 18000 } } }, 1)
  return e !== null && e.windows.length === 1
})())
check('H3 无窗口 → null（不编造百分比）', entryFromPayload({ plan_type: 'plus' }, 1) === null
  && entryFromPayload({ rate_limit: {} }, 1) === null)
check('H3 非对象 → null', entryFromPayload(null, 1) === null && entryFromPayload('x', 1) === null)
check('H3 limit_reached 透传', entryFromPayload({ rate_limit: { limit_reached: true, primary_window: { used_percent: 100, limit_window_seconds: 18000 } } }, 1).limitReached === true)
check('H3 credits 缺字段 → null 而非空对象', entryFromPayload({ rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 18000 } } }, 1).credits === null)
check('H3 fetchedAt 用传入时刻（可注入）', entryFromPayload(REAL_PAYLOAD, 123456).fetchedAt === 123456)

/* ── 测试替身 ─────────────────────────────────────────────────────── */

const KIMI_KEY = 'kimi-secret-value'
const OPENCODE_KEY = 'opencode-secret-value'
/** 实测响应（原样照抄 240 字节的全部字段）。 */
const REAL_OPENCODE_PAYLOAD = {
  usage: {
    rolling: { status: 'ok', percent: 6, resetsAt: '2026-10-17T08:06:47.000Z' },
    weekly: { status: 'ok', percent: 36, resetsAt: '2026-10-19T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 59, resetsAt: '2026-10-20T09:24:52.000Z' },
  },
}
/** OpenCode 当前 usage 路由的新结构（PR #32913）：plan + windows[]。 */
const CURRENT_OPENCODE_PAYLOAD = {
  plan: 'lite',
  windows: [
    { name: 'weekly', status: 'ok', usagePercent: 36, resetInSec: 455917 },
    { name: '5-hour', status: 'ok', usagePercent: 6, resetInSec: 13363 },
    { name: 'monthly', status: 'ok', usagePercent: 59, resetInSec: 1188832 },
  ],
  useBalance: false,
}
/** 实测响应（裁剪保真：usages + usage + limits + 钱包，另加一个不该外泄的标识字段）。 */
const REAL_KIMI_PAYLOAD = {
  user: { email: 'nobody@example.invalid', id: 'user-x' },
  usages: {
    limit_5h: { used_ratio: 0, reset_time: '2026-10-17T08:20:48Z' },
    limit_7d: { used_ratio: 1, reset_time: '2026-10-17T19:20:48Z' },
  },
  usage: { limit: '100', used: '100', resetTime: '2026-10-17T19:20:48Z' },
  limits: [{
    window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
    detail: { limit: '100', remaining: '100', resetTime: '2026-10-17T08:20:48Z' },
  }],
  booster_wallet: {
    // 结构照抄实测响应；id / userId 是占位串（用来证明解析后不外带这些标识）。
    id: '19f83cf4-c7f2-8cf4-8000-00008b9e3e8a',
    userId: 'user-x',
    balance: {
      id: '19f83cf4-c7c2-888d-8000-00003a4198ad',
      feature: 'FEATURE_OMNI',
      type: 'BOOSTER',
      amount: '15000000000',
      amountLeft: '3276582800',
      unit: 'UNIT_CURRENCY',
      periodStart: '2026-07-21T08:33:47.665133Z',
      periodEnd: '2126-07-21T08:33:48.665133Z',
      userId: 'user-x',
      domain: 'DOMAIN_NEXUS',
    },
    status: 'STATUS_DISABLED',
    allowTopup: true,
    topupLimit: { currency: 'CNY', priceInCents: '300000' },
    autoRefillCharge: { currency: 'CNY', priceInCents: '0' },
    autoRefillThreshold: { currency: 'CNY', priceInCents: '0' },
    monthlyChargeLimit: { currency: 'CNY', priceInCents: '0' },
    monthlyUsed: { currency: 'CNY', priceInCents: '0' },
  },
}

function makeCredentials(record, resolved = { [KIMI_KEY]: KIMI_KEY, LLMKEY_KIMI: KIMI_KEY, OPENCODE_API_KEY: OPENCODE_KEY }) {
  const calls = { read: [], resolve: [], modify: 0 }
  return {
    calls,
    service: {
      async readRecord(key) { calls.read.push(key); return record },
      async resolve(ref) {
        calls.resolve.push(ref)
        const value = resolved[ref]
        return value === undefined ? undefined : { value, source: 'env' }
      },
      async modifyRecord() { calls.modify += 1; throw new Error('本插件不得写凭据') },
    },
  }
}
/**
 * settings 替身：只实现 describe()，暴露 llm-pi-ai.providers[route].apiKeyEnv。
 * 入参是 `{ 路由: 引用名 }`；字符串形式是「只声明 kimi-coding」的简写。
 */
function makeSettings(providersOrRef) {
  const providers = typeof providersOrRef === 'string'
    ? { 'kimi-coding': providersOrRef }
    : (providersOrRef !== null && typeof providersOrRef === 'object' ? providersOrRef : {})
  const calls = { describe: 0 }
  const shape = {}
  for (const [route, ref] of Object.entries(providers)) {
    // 值是字符串时是「只声明 apiKeyEnv」的简写；对象时是完整 provider profile（可带 baseURL）。
    shape[route] = ref === undefined ? {}
      : (ref !== null && typeof ref === 'object' ? { ...ref } : { apiKeyEnv: ref })
  }
  return {
    calls,
    service: {
      describe() {
        calls.describe += 1
        return [{ ns: PI_AI_NAMESPACE, value: { providers: shape } }]
      },
    },
  }
}
function grantRecord(overrides = {}) {
  return {
    kind: 'grant',
    payload: { type: 'oauth', access: 'tok-secret-value', refresh: 'rt-1', expires: Date.now() + 3600_000, accountId: 'acct-1', ...overrides },
  }
}
function makeFetchStub(handler) {
  const calls = []
  const stub = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init, calls.length)
  }
  return { stub, calls }
}
const okResponse = (payload) => ({ status: 200, async json() { return payload } })

/* ── H4：凭据读取与降级 ───────────────────────────────────────────── */

await (async () => {
  const { stub, calls } = makeFetchStub(() => okResponse(REAL_PAYLOAD))
  const service = createQuotaService({ credentialsOf: () => undefined, fetchImpl: stub })
  const res = await service.readOne('openai-codex')
  check('H4 凭据服务缺失 → credentials-unavailable 且不打上游', res.ok === false && res.reason === 'credentials-unavailable' && calls.length === 0)
})()

await (async () => {
  const { stub, calls } = makeFetchStub(() => okResponse(REAL_PAYLOAD))
  const service = createQuotaService({ credentialsOf: () => makeCredentials(undefined).service, fetchImpl: stub })
  const res = await service.readOne('openai-codex')
  check('H4 无记录 → not-configured 且不打上游', res.ok === false && res.reason === 'not-configured' && calls.length === 0)
})()

await (async () => {
  const { stub, calls } = makeFetchStub(() => okResponse(REAL_PAYLOAD))
  const apiKeyRecord = { kind: 'api-key', key: 'sk-x' }
  const service = createQuotaService({ credentialsOf: () => makeCredentials(apiKeyRecord).service, fetchImpl: stub })
  const res = await service.readOne('openai-codex')
  check('H4 记录不是 grant → not-configured 且不打上游', res.ok === false && res.reason === 'not-configured' && calls.length === 0)
})()

await (async () => {
  const { stub, calls } = makeFetchStub(() => okResponse(REAL_PAYLOAD))
  const partial = { kind: 'grant', payload: { type: 'oauth', access: 'tok', expires: Date.now() + 3600_000 } }
  const service = createQuotaService({ credentialsOf: () => makeCredentials(partial).service, fetchImpl: stub })
  const res = await service.readOne('openai-codex')
  check('H4 缺 accountId → not-configured 且不打上游（不回半份凭据）', res.ok === false && res.reason === 'not-configured' && calls.length === 0)
})()

await (async () => {
  const { stub, calls } = makeFetchStub(() => okResponse(REAL_PAYLOAD))
  const expired = grantRecord({ expires: Date.now() - 1000 })
  const service = createQuotaService({ credentialsOf: () => makeCredentials(expired).service, fetchImpl: stub })
  const res = await service.readOne('openai-codex')
  check('H4 令牌过期 → token-expired 且不打上游（刷新留给 pi-ai）', res.ok === false && res.reason === 'token-expired' && calls.length === 0)
})()

await (async () => {
  const { stub, calls } = makeFetchStub(() => okResponse(REAL_PAYLOAD))
  const skew = grantRecord({ expires: Date.now() + EXPIRY_SKEW_MS / 2 })
  const service = createQuotaService({ credentialsOf: () => makeCredentials(skew).service, fetchImpl: stub })
  const res = await service.readOne('openai-codex')
  check('H4 令牌进入临界区即视为过期', res.ok === false && res.reason === 'token-expired' && calls.length === 0)
})()

await (async () => {
  const { stub } = makeFetchStub(() => okResponse(REAL_PAYLOAD))
  const creds = makeCredentials(grantRecord())
  const service = createQuotaService({ credentialsOf: () => creds.service, fetchImpl: stub })
  await service.readOne('openai-codex')
  check('H4 只走 readRecord，从不写凭据', creds.calls.read.length === 1 && creds.calls.read[0] === 'llm-pi-ai/openai-codex' && creds.calls.modify === 0)
})()

await (async () => {
  const { stub } = makeFetchStub(() => okResponse(REAL_PAYLOAD))
  const broken = { async readRecord() { throw new Error('store locked') } }
  const service = createQuotaService({ credentialsOf: () => broken, fetchImpl: stub })
  const res = await service.readOne('openai-codex')
  check('H4 凭据读取抛错 → credentials-error 不冒泡', res.ok === false && res.reason === 'credentials-error' && res.message.includes('store locked'))
})()

/* ── H5：上游交互 ─────────────────────────────────────────────────── */

await (async () => {
  const { stub, calls } = makeFetchStub(() => okResponse(REAL_PAYLOAD))
  const service = createQuotaService({ credentialsOf: () => makeCredentials(grantRecord()).service, fetchImpl: stub })
  const res = await service.readOne('openai-codex')
  const req = calls[0]
  check('H5 上游 URL 固定', req.url === 'https://chatgpt.com/backend-api/wham/usage')
  check('H5 请求头按 pi-ai 同一口径', req.init.headers.authorization === 'Bearer tok-secret-value'
    && req.init.headers['chatgpt-account-id'] === 'acct-1'
    && req.init.headers.originator === 'pi')
  check('H5 成功条目成型', res.ok === true && res.windows.length === 2)
  check('H5 条目里不含令牌', !JSON.stringify(res).includes('tok-secret-value'))
})()

await (async () => {
  const { stub } = makeFetchStub(() => ({ status: 403, async json() { return { error: 'forbidden', email: 'x@y.z' } } }))
  const service = createQuotaService({ credentialsOf: () => makeCredentials(grantRecord()).service, fetchImpl: stub })
  const res = await service.readOne('openai-codex')
  check('H5 非 200 → 只回状态码，不回响应体', res.ok === false && res.reason === 'http-403' && !JSON.stringify(res).includes('forbidden'))
})()

await (async () => {
  const { stub } = makeFetchStub(() => { throw new Error('getaddrinfo ENOTFOUND') })
  const service = createQuotaService({ credentialsOf: () => makeCredentials(grantRecord()).service, fetchImpl: stub })
  const res = await service.readOne('openai-codex')
  check('H5 网络异常 → network 降级', res.ok === false && res.reason === 'network')
})()

await (async () => {
  const { stub } = makeFetchStub(() => ({ status: 200, async json() { throw new Error('not json') } }))
  const service = createQuotaService({ credentialsOf: () => makeCredentials(grantRecord()).service, fetchImpl: stub })
  const res = await service.readOne('openai-codex')
  check('H5 响应体非 JSON → bad-json', res.ok === false && res.reason === 'bad-json')
})()

await (async () => {
  const { stub } = makeFetchStub(() => okResponse({ plan_type: 'plus' }))
  const service = createQuotaService({ credentialsOf: () => makeCredentials(grantRecord()).service, fetchImpl: stub })
  const res = await service.readOne('openai-codex')
  check('H5 200 但无窗口 → no-windows', res.ok === false && res.reason === 'no-windows')
})()

await (async () => {
  const { stub, calls } = makeFetchStub(() => okResponse(REAL_PAYLOAD))
  const service = createQuotaService({ credentialsOf: () => makeCredentials(grantRecord()).service, fetchImpl: stub })
  const res = await service.readOne('no-such-route')
  check('H5 未知路由 → unsupported 且不打上游', res.ok === false && res.reason === 'unsupported' && calls.length === 0)
})()

/* ── H6：缓存与单飞 ───────────────────────────────────────────────── */

await (async () => {
  let clock = 1_000_000
  const { stub, calls } = makeFetchStub(() => okResponse(REAL_PAYLOAD))
  const service = createQuotaService({ credentialsOf: () => makeCredentials(grantRecord()).service, fetchImpl: stub, now: () => clock })
  await service.readOne('openai-codex')
  await service.readOne('openai-codex')
  check('H6 TTL 内复用缓存（只打一次上游）', calls.length === 1)
  clock += CACHE_TTL_MS - 1
  await service.readOne('openai-codex')
  check('H6 TTL 未到仍复用', calls.length === 1)
  clock += 2
  await service.readOne('openai-codex')
  check('H6 超过 TTL 重新取数', calls.length === 2)
  service.invalidate('openai-codex')
  await service.readOne('openai-codex')
  check('H6 invalidate 立即失效', calls.length === 3)
})()

await (async () => {
  let releaseFetch
  const gate = new Promise((resolve) => { releaseFetch = resolve })
  let callCount = 0
  const stub = async () => { callCount += 1; await gate; return okResponse(REAL_PAYLOAD) }
  const service = createQuotaService({ credentialsOf: () => makeCredentials(grantRecord()).service, fetchImpl: stub })
  const first = service.readOne('openai-codex')
  const second = service.readOne('openai-codex')
  // 两次调用都在上游返回前进入：第二个必须复用第一个的单飞任务。
  const third = service.readOne('openai-codex')
  releaseFetch()
  const [a, b, c] = await Promise.all([first, second, third])
  check('H6 并发进入合并为一次上游请求（单飞）', callCount === 1, `callCount=${callCount}`)
  check('H6 并发返回同一条目', a.ok === true && b.ok === true && c.ok === true
    && a.windows[0].windowSeconds === c.windows[0].windowSeconds)
})()

await (async () => {
  const { stub } = makeFetchStub(() => okResponse(REAL_PAYLOAD))
  const service = createQuotaService({ credentialsOf: () => makeCredentials(grantRecord()).service, fetchImpl: stub })
  const all = await service.readAll()
  check('H6 readAll 覆盖全部数据源且键为路由 id', Object.keys(all).length === Object.keys(QUOTA_SOURCES).length && all['openai-codex'].ok === true)
})()

/* ── H7：端点行为 ─────────────────────────────────────────────────── */

function makeRes() {
  return {
    status: null,
    body: '',
    writeHead(status) { this.status = status },
    end(body) { this.body = body },
  }
}
function mountPlugin(credentials, settings, rawConfig) {
  const registered = []
  const events = []
  const ctx = {
    get: (serviceName) => {
      if (serviceName === 'credentials') return credentials
      if (serviceName === 'settings') return settings
      return undefined
    },
    on: (eventName, handler) => { events.push({ eventName, handler }) },
    effect: (factory) => factory(),
    inject: (deps, callback) => callback({ webServer: { register: (entry) => { registered.push(entry); return () => {} } } }),
    logger: { info: () => {} },
  }
  apply(ctx, rawConfig)
  return { registered, events }
}
const previousFetch = globalThis.fetch
try {
  // 按 URL 分派：Codex 走 wham/usage、Kimi 走 /coding/v1/usages、Go 走 /zen/go/v1/usage。
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/usages')) return okResponse(REAL_KIMI_PAYLOAD)
    if (target.includes('/zen/go/v1/usage')) return okResponse(CURRENT_OPENCODE_PAYLOAD)
    return okResponse(REAL_PAYLOAD)
  }
  const creds = makeCredentials(grantRecord())
  const { registered, events } = mountPlugin(creds.service, makeSettings({ 'kimi-coding': 'LLMKEY_KIMI', 'opencode-go': 'OPENCODE_API_KEY' }).service)
  check('H7 注册了两个只读端点（额度 + 可见配置）', registered.length === 2
    && registered[0].path === QUOTA_PATH && registered[0].kind === 'exact'
    && registered[1].path === CONFIG_PATH && registered[1].kind === 'exact')
  check('H7 订阅了凭据记录变更事件', events.some((e) => e.eventName === 'credentials/record-updated'))

  const handler = registered.find((entry) => entry.path === QUOTA_PATH).handler
  const forbidden = makeRes()
  await handler({ method: 'GET', socket: { remoteAddress: '10.0.0.7' } }, forbidden)
  check('H7 非回环请求 → 403', forbidden.status === 403)

  const wrongMethod = makeRes()
  await handler({ method: 'POST', socket: { remoteAddress: '127.0.0.1' } }, wrongMethod)
  check('H7 非 GET → 405', wrongMethod.status === 405)

  const ok = makeRes()
  await handler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, ok)
  const body = JSON.parse(ok.body)
  check('H7 回环 GET → 200 且形状为 { ok, updatedAt, routes }', ok.status === 200 && body.ok === true
    && typeof body.updatedAt === 'number' && body.routes['openai-codex'].ok === true)
  check('H7 三条数据源都出现在 routes 里（浏览器半按行 id 命中）', body.routes['kimi-coding'] !== undefined
    && body.routes['kimi-coding'].ok === true && body.routes['kimi-coding'].plan === null
    && body.routes['opencode-go'] !== undefined && body.routes['opencode-go'].ok === true
    && body.routes['opencode-go'].plan === 'lite')
  check('H7 端点响应体不含任何令牌', !ok.body.includes('tok-secret-value') && !ok.body.includes(KIMI_KEY)
    && !ok.body.includes(OPENCODE_KEY))
  check('H7 端点响应体不含账号标识', !ok.body.includes('nobody@example.invalid') && !ok.body.includes('user-x'))

  const unknown = makeRes()
  await handler({ method: 'GET', socket: { remoteAddress: '::ffff:127.0.0.1' } }, unknown)
  check('H7 ::ffff:127.0.0.1 视为本机', unknown.status === 200)

  const noSocket = makeRes()
  await handler({ method: 'GET' }, noSocket)
  check('H7 无 socket 信息按本机处理（不 fail-open 到外网响应）', noSocket.status === 200)
} finally {
  globalThis.fetch = previousFetch
}

check('H7 isLocalRequest 判定', isLocalRequest({ socket: { remoteAddress: '::1' } }) === true
  && isLocalRequest({ socket: { remoteAddress: '127.0.0.1' } }) === true
  && isLocalRequest({ socket: { remoteAddress: '192.168.1.9' } }) === false)

/* ── H8：Kimi 数据源 ─────────────────────────────────────────────── */

check('H8 窗口键解析 limit_5h/limit_7d/limit_30m', windowSecondsFromKey('limit_5h') === 18000
  && windowSecondsFromKey('limit_7d') === 604800 && windowSecondsFromKey('limit_30m') === 1800)
check('H8 窗口键大小写不敏感', windowSecondsFromKey('LIMIT_5H') === 18000)
check('H8 非法窗口键 → null（不猜周期）', windowSecondsFromKey('limit_0h') === null
  && windowSecondsFromKey('limit_h') === null && windowSecondsFromKey('limit_5w') === null
  && windowSecondsFromKey('usages') === null && windowSecondsFromKey(5) === null && windowSecondsFromKey(null) === null)
check('H8 ISO 时刻 → epoch 秒', epochSecondsOf('2026-10-17T08:20:48Z') === Date.parse('2026-10-17T08:20:48Z') / 1000)
check('H8 数字秒/毫秒都认，毫秒自动降位', epochSecondsOf(1792219608) === 1792219608
  && epochSecondsOf(1792219608000) === 1792219608)
check('H8 数值字符串时刻也认', epochSecondsOf('1792219608') === 1792219608)
check('H8 零值与不可解析 → null（不当作 1970 年）', epochSecondsOf(0) === null && epochSecondsOf('x') === null
  && epochSecondsOf(null) === null && epochSecondsOf(undefined) === null)
check('H8 looseNum 认字符串数字（Kimi 计数是字符串）', looseNum('100') === 100 && looseNum(100) === 100
  && looseNum('') === null && looseNum('abc') === null && looseNum(true) === null)

const kimiEntry = kimiEntryFromPayload(REAL_KIMI_PAYLOAD, 1792206238452)
check('H8 实测响应 → 条目（5h 0% · 7d 100%）', kimiEntry !== null && kimiEntry.ok === true
  && kimiEntry.windows.length === 2
  && kimiEntry.windows[0].windowSeconds === 18000 && kimiEntry.windows[0].usedPercent === 0
  && kimiEntry.windows[1].windowSeconds === 604800 && kimiEntry.windows[1].usedPercent === 100)
check('H8 窗口按时长升序（5h 在 7d 前）', kimiEntry.windows[0].windowSeconds < kimiEntry.windows[1].windowSeconds)
check('H8 重置时刻取 ISO reset_time', kimiEntry.windows[0].resetsAt === Date.parse('2026-10-17T08:20:48Z') / 1000)
check('H8 resetAfterSeconds 不臆造（客户端按绝对时刻算倒计时）', kimiEntry.windows.every((w) => w.resetAfterSeconds === null))
check('H8 套餐名留空而非猜测', kimiEntry.plan === null)
check('H8 加购钱包不解析（定点整数缺可核对货币口径）', kimiEntry.credits === null)
check('H8 limitReached 由「窗口已用满」推导', kimiEntry.limitReached === true)
check('H8 未用满时 limitReached 为 false', kimiEntryFromPayload({ usages: { limit_5h: { used_ratio: 0.5 } } }, 1).limitReached === false)
check('H8 条目不含账号标识', (() => {
  const json = JSON.stringify(kimiEntry)
  return !json.includes('nobody@example.invalid') && !json.includes('user-x')
})())
check('H8 fetchedAt 用传入时刻（可注入）', kimiEntryFromPayload(REAL_KIMI_PAYLOAD, 123456).fetchedAt === 123456)
check('H8 used_ratio 夹取到 [0,100]', (() => {
  const high = kimiEntryFromPayload({ usages: { limit_5h: { used_ratio: 1.5 } } }, 1)
  const low = kimiEntryFromPayload({ usages: { limit_5h: { used_ratio: -0.2 } } }, 1)
  return high.windows[0].usedPercent === 100 && low.windows[0].usedPercent === 0
})())
check('H8 无 used_ratio 的窗口被丢弃', kimiWindowsFromUsages({ usages: { limit_5h: { reset_time: '2026-10-17T08:20:48Z' } } }).length === 0)
check('H8 usages 非法 → 回退路径不为空数组以外的假设', kimiWindowsFromUsages({ usages: [] }).length === 0
  && kimiWindowsFromUsages({ usages: null }).length === 0 && kimiWindowsFromUsages({}).length === 0)

check('H8 usages 缺席 → limits[] 计数视图回退（同口径 5h 0%）', (() => {
  const only = { limits: REAL_KIMI_PAYLOAD.limits }
  const windows = kimiWindowsFromCounts(only)
  return windows.length === 1 && windows[0].windowSeconds === 18000 && windows[0].usedPercent === 0
})())
check('H8 两条路径口径一致（实测 limits[] 与 usages 不矛盾）', (() => {
  const fromUsages = kimiEntryFromPayload({ usages: REAL_KIMI_PAYLOAD.usages }, 1)
  const fromCounts = kimiEntryFromPayload({ limits: REAL_KIMI_PAYLOAD.limits }, 1)
  return fromUsages.windows[0].windowSeconds === fromCounts.windows[0].windowSeconds
    && fromUsages.windows[0].usedPercent === fromCounts.windows[0].usedPercent
})())
check('H8 计数视图可由 limit-used 求已用', kimiWindowsFromCounts({ limits: [{ window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { limit: '200', used: '50' } }] })[0].usedPercent === 25)
check('H8 无 detail 时退回条目自身字段', kimiWindowsFromCounts({ limits: [{ window: { duration: 1, timeUnit: 'TIME_UNIT_DAY' }, limit: '10', remaining: '9' }] })[0].usedPercent === 10)
check('H8 秒/分/时/天单位都认', (() => {
  const mk = (timeUnit) => kimiWindowsFromCounts({ limits: [{ window: { duration: 1, timeUnit }, detail: { limit: '10', remaining: '9' } }] })[0].windowSeconds
  return mk('TIME_UNIT_SECOND') === 1 && mk('TIME_UNIT_MINUTE') === 60
    && mk('TIME_UNIT_HOUR') === 3600 && mk('TIME_UNIT_DAY') === 86400
})())
check('H8 未知单位/缺 limit 的项被跳过', kimiWindowsFromCounts({ limits: [{ window: { duration: 5, timeUnit: 'TIME_UNIT_FORTNIGHT' }, detail: { limit: '10', remaining: '9' } }] }).length === 0
  && kimiWindowsFromCounts({ limits: [{ window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { remaining: '9' } }] }).length === 0)
check('H8 limit 为 0 不产生除零', kimiWindowsFromCounts({ limits: [{ window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { limit: '0', remaining: '0' } }] }).length === 0)

check('H8 最后兜底：裸 usage 计数按 7 天窗口', (() => {
  const entry = kimiEntryFromPayload({ usage: { limit: '100', used: '40', resetTime: '2026-10-17T19:20:48Z' } }, 1)
  return entry !== null && entry.windows.length === 1 && entry.windows[0].windowSeconds === 604800
    && entry.windows[0].usedPercent === 40 && entry.windows[0].resetsAt === Date.parse('2026-10-17T19:20:48Z') / 1000
})())
check('H8 取不到任何窗口 → null（不显示，也不编造）', kimiEntryFromPayload({}, 1) === null
  && kimiEntryFromPayload({ usages: {}, limits: [], usage: {} }, 1) === null
  && kimiEntryFromPayload({ usage: { limit: '0', used: '0' } }, 1) === null)
check('H8 非对象 → null', kimiEntryFromPayload(null, 1) === null && kimiEntryFromPayload('x', 1) === null
  && kimiWindowsFromCounts({ limits: null }).length === 0 && kimiWindowsFromWeeklyUsage({ usage: [] }).length === 0)

await (async () => {
  const { stub, calls } = makeFetchStub(() => okResponse(REAL_KIMI_PAYLOAD))
  const settings = makeSettings('LLMKEY_KIMI')
  const creds = makeCredentials(undefined, { LLMKEY_KIMI: KIMI_KEY })
  const service = createQuotaService({ credentialsOf: () => creds.service, settingsOf: () => settings.service, fetchImpl: stub })
  const res = await service.readOne('kimi-coding')
  check('H8 ref 型凭据按 settings 生效的 apiKeyEnv 解析', creds.calls.resolve.join(',') === 'LLMKEY_KIMI')
  check('H8 成功条目成型', res.ok === true && res.windows[1].usedPercent === 100)
  check('H8 上游 URL 固定', calls[0].url === 'https://api.kimi.com/coding/v1/usages')
  check('H8 请求头只有 Bearer + accept（不带 Codex 专属头）', calls[0].init.headers.authorization === 'Bearer ' + KIMI_KEY
    && calls[0].init.headers.accept === 'application/json'
    && calls[0].init.headers['chatgpt-account-id'] === undefined
    && calls[0].init.headers.originator === undefined)
  check('H8 条目里不含 API key', !JSON.stringify(res).includes(KIMI_KEY))
})()

await (async () => {
  const { stub, calls } = makeFetchStub(() => okResponse(REAL_KIMI_PAYLOAD))
  const creds = makeCredentials(undefined, { KIMI_API_KEY: KIMI_KEY })
  const service = createQuotaService({ credentialsOf: () => creds.service, fetchImpl: stub })
  const res = await service.readOne('kimi-coding')
  check('H8 settings 服务缺失 → 回退 KIMI_API_KEY', res.ok === true && creds.calls.resolve.join(',') === 'KIMI_API_KEY')
  check('H8 回退路径同样打到上游', calls.length === 1)
})()

await (async () => {
  const { stub } = makeFetchStub(() => okResponse(REAL_KIMI_PAYLOAD))
  const creds = makeCredentials(undefined, { KIMI_API_KEY: KIMI_KEY })
  const service = createQuotaService({ credentialsOf: () => creds.service, settingsOf: () => makeSettings('LLMKEY_GONE').service, fetchImpl: stub })
  const res = await service.readOne('kimi-coding')
  check('H8 生效引用取不到值 → 继续尝试回退引用', res.ok === true && creds.calls.resolve.join(',') === 'LLMKEY_GONE,KIMI_API_KEY')
})()

await (async () => {
  const { stub, calls } = makeFetchStub(() => okResponse(REAL_KIMI_PAYLOAD))
  const creds = makeCredentials(undefined, {})
  const service = createQuotaService({ credentialsOf: () => creds.service, settingsOf: () => makeSettings('LLMKEY_KIMI').service, fetchImpl: stub })
  const res = await service.readOne('kimi-coding')
  check('H8 引用全取不到 → not-configured 且不打上游', res.ok === false && res.reason === 'not-configured' && calls.length === 0)
})()

await (async () => {
  const { stub, calls } = makeFetchStub(() => okResponse(REAL_KIMI_PAYLOAD))
  const service = createQuotaService({
    credentialsOf: () => ({ async resolve() { throw new Error('store unreadable') } }),
    settingsOf: () => makeSettings('LLMKEY_KIMI').service,
    fetchImpl: stub,
  })
  const res = await service.readOne('kimi-coding')
  check('H8 引用解析抛错 → credentials-error 不冒泡', res.ok === false && res.reason === 'credentials-error' && calls.length === 0)
})()

await (async () => {
  const { stub, calls } = makeFetchStub(() => okResponse(REAL_KIMI_PAYLOAD))
  const service = createQuotaService({ credentialsOf: () => ({ readRecord: async () => undefined }), fetchImpl: stub })
  const res = await service.readOne('kimi-coding')
  check('H8 凭据服务不支持 resolve → credentials-unavailable 且不打上游', res.ok === false && res.reason === 'credentials-unavailable' && calls.length === 0)
})()

await (async () => {
  const { stub } = makeFetchStub(() => ({ status: 401, async json() { return { error: 'invalid_authentication_error', email: 'x@y.z' } } }))
  const creds = makeCredentials(undefined, { [KIMI_KEY]: KIMI_KEY, LLMKEY_KIMI: KIMI_KEY })
  const service = createQuotaService({ credentialsOf: () => creds.service, settingsOf: () => makeSettings('LLMKEY_KIMI').service, fetchImpl: stub })
  const res = await service.readOne('kimi-coding')
  check('H8 上游 401 → 只回状态码，不回响应体', res.ok === false && res.reason === 'http-401'
    && !JSON.stringify(res).includes('invalid_authentication_error'))
})()

await (async () => {
  let clock = 1_000_000
  const { stub, calls } = makeFetchStub(() => okResponse(REAL_KIMI_PAYLOAD))
  const creds = makeCredentials(undefined, { LLMKEY_KIMI: KIMI_KEY })
  const service = createQuotaService({ credentialsOf: () => creds.service, settingsOf: () => makeSettings('LLMKEY_KIMI').service, fetchImpl: stub, now: () => clock })
  await service.readOne('kimi-coding')
  clock += CACHE_TTL_MS + 1
  await service.readOne('kimi-coding')
  check('H8 缓存对 ref 型数据源同样生效（每次取数都重读引用）', calls.length === 2 && creds.calls.resolve.length === 2)
})()

await (async () => {
  globalThis.fetch = async () => okResponse(REAL_KIMI_PAYLOAD)
  try {
    const creds = makeCredentials(grantRecord())
    const service = createQuotaService({
      credentialsOf: () => creds.service,
      settingsOf: () => makeSettings({ 'kimi-coding': 'LLMKEY_KIMI', 'opencode-go': 'OPENCODE_API_KEY' }).service,
    })
    const all = await service.readAll()
    check('H8 readAll 串起三条数据源（形状不符的两条降级为 no-windows）', Object.keys(all).length === 3
      && all['kimi-coding'].ok === true && all['openai-codex'].ok === false && all['openai-codex'].reason === 'no-windows'
      && all['opencode-go'].ok === false && all['opencode-go'].reason === 'no-windows')
  } finally {
    globalThis.fetch = previousFetch
  }
})()

/* ── H8b：Kimi 账单口径（booster_wallet → Extra Usage，钱不是用量窗口） ── */

check('H8b 定点金额换算（1e6 定点分，不足 1 分算 1 分，其余四舍五入）', (() => {
  return fixedPointToCents(15000000000) === 15000   // ¥150.00
    && fixedPointToCents(3276582800) === 3277       // ¥32.77
    && fixedPointToCents(1500000) === 2             // 1.5 分 → 2
    && fixedPointToCents(500000) === 1              // 0.5 分 → 1（CLI 规则）
    && fixedPointToCents(100000) === 1              // 0.1 分 → 1
    && fixedPointToCents(0) === 0
})())
check('H8b moneyOf 取 {cents, currency}，缺 priceInCents → null', (() => {
  const ok = moneyOf({ currency: 'CNY', priceInCents: '5000' })
  return ok.cents === 5000 && ok.currency === 'CNY'
    && moneyOf({ currency: 'CNY' }) === null
    && moneyOf(null) === null && moneyOf('x') === null
})())
check('H8b 缺 currency 时回空串（由上层决定回退）', moneyOf({ priceInCents: '1' }).currency === '')

const realExtra = extraUsageFromBoosterWallet(REAL_KIMI_PAYLOAD.booster_wallet)
check('H8b 实测钱包 → 账单对象（本机真实值）', realExtra !== null
  && realExtra.totalCents === 15000 && realExtra.balanceCents === 3277
  && realExtra.monthlyUsedCents === 0 && realExtra.monthlyChargeLimitCents === 0
  && realExtra.monthlyChargeLimitEnabled === false
  && realExtra.currency === 'CNY' && realExtra.status === 'STATUS_DISABLED')
check('H8b 账单对象不带钱包 id / userId（不泄露标识）', (() => {
  const json = JSON.stringify(realExtra)
  return !json.includes('19f83cf4') && realExtra.userId === undefined && realExtra.id === undefined
    && Object.keys(realExtra).sort().join(',') === 'balanceCents,currency,monthlyChargeLimitCents,monthlyChargeLimitEnabled,monthlyUsedCents,status,totalCents'
})())
check('H8b 类型不是 BOOSTER / amount<=0 / 无 balance → 整段不显示', (() => {
  const base = { balance: { type: 'BOOSTER', amount: '1000000', amountLeft: '500000' } }
  return extraUsageFromBoosterWallet({ ...base, balance: { ...base.balance, type: 'CREDIT' } }) === null
    && extraUsageFromBoosterWallet({ ...base, balance: { ...base.balance, amount: '0' } }) === null
    && extraUsageFromBoosterWallet({ ...base, balance: { ...base.balance, amount: '-5' } }) === null
    && extraUsageFromBoosterWallet({ balance: { type: 'BOOSTER' } }) === null
    && extraUsageFromBoosterWallet({}) === null
    && extraUsageFromBoosterWallet(null) === null
})())
check('H8b 缺 amountLeft → 余额算 0（不抛）', (() => {
  const only = { balance: { type: 'BOOSTER', amount: '1000000' } }
  const parsed = extraUsageFromBoosterWallet(only)
  return parsed !== null && parsed.balanceCents === 0 && parsed.totalCents === 1
})())
check('H8b 月度上限启用时透传 enabled 与金额', (() => {
  const withLimit = {
    balance: { type: 'BOOSTER', amount: '1000000', amountLeft: '1000000' },
    monthlyChargeLimitEnabled: true,
    monthlyChargeLimit: { currency: 'CNY', priceInCents: '5000' },
    monthlyUsed: { currency: 'CNY', priceInCents: '1234' },
    status: 'STATUS_ACTIVE',
  }
  const parsed = extraUsageFromBoosterWallet(withLimit)
  return parsed.monthlyChargeLimitEnabled === true && parsed.monthlyChargeLimitCents === 5000
    && parsed.monthlyUsedCents === 1234 && parsed.status === 'STATUS_ACTIVE'
})())
check('H8b 两个 money 字段都没 currency → 回退 USD', extraUsageFromBoosterWallet({
  balance: { type: 'BOOSTER', amount: '1000000', amountLeft: '1000000' },
  monthlyUsed: { priceInCents: '1' },
}).currency === 'USD')
check('H8b 缺 status 时为 null（客户端不标注）', extraUsageFromBoosterWallet({
  balance: { type: 'BOOSTER', amount: '1000000', amountLeft: '1000000' },
}).status === null)

check('H8b 条目挂上 extraUsage（窗口仍是 5h/7d 两个，不伪造 30d）', (() => {
  const entry = kimiEntryFromPayload(REAL_KIMI_PAYLOAD, 1)
  return entry.extraUsage !== null && entry.extraUsage.balanceCents === 3277
    && entry.windows.length === 2
    && entry.windows.every((w) => w.windowSeconds === 18000 || w.windowSeconds === 604800)
})())
check('H8b 无钱包时 extraUsage 为 null（字段存在但空）', kimiEntryFromPayload({ usages: { limit_5h: { used_ratio: 0 } } }, 1).extraUsage === null)
check('H8b 其它数据源不带 extraUsage 字段', (() => {
  const codex = entryFromPayload(REAL_PAYLOAD, 1)
  const go = opencodeEntryFromPayload(REAL_OPENCODE_PAYLOAD, 1)
  return codex.extraUsage === undefined && go.extraUsage === undefined
})())

await (async () => {
  const { stub } = makeFetchStub(() => okResponse(REAL_KIMI_PAYLOAD))
  const creds = makeCredentials(undefined, { LLMKEY_KIMI: KIMI_KEY })
  const service = createQuotaService({ credentialsOf: () => creds.service, settingsOf: () => makeSettings('LLMKEY_KIMI').service, fetchImpl: stub })
  const res = await service.readOne('kimi-coding')
  check('H8b 经服务层后 extraUsage 仍在（不是只在纯函数里）', res.ok === true && res.extraUsage !== null
    && res.extraUsage.balanceCents === 3277 && res.extraUsage.status === 'STATUS_DISABLED')
})()

/* ── H9：OpenCode Go 数据源（订阅级三窗口，未公开端点） ───────────── */

check('H9 三窗口时长按官方口径固定（5h / 7d / 30d）', OPENCODE_WINDOW_SECONDS.rolling === 18000
  && OPENCODE_WINDOW_SECONDS.weekly === 604800 && OPENCODE_WINDOW_SECONDS.monthly === 2592000)

const opencodeEntry = opencodeEntryFromPayload(REAL_OPENCODE_PAYLOAD, 1792211220093)
check('H9 实测响应 → 条目（5h 6% · 7d 36% · 30d 59%）', opencodeEntry !== null && opencodeEntry.ok === true
  && opencodeEntry.windows.length === 3
  && opencodeEntry.windows[0].windowSeconds === 18000 && opencodeEntry.windows[0].usedPercent === 6
  && opencodeEntry.windows[1].windowSeconds === 604800 && opencodeEntry.windows[1].usedPercent === 36
  && opencodeEntry.windows[2].windowSeconds === 2592000 && opencodeEntry.windows[2].usedPercent === 59)
check('H9 窗口按时长升序（与 JSON 键序无关）', (() => {
  const shuffled = { usage: { monthly: REAL_OPENCODE_PAYLOAD.usage.monthly, rolling: REAL_OPENCODE_PAYLOAD.usage.rolling, weekly: REAL_OPENCODE_PAYLOAD.usage.weekly } }
  const labels = opencodeEntryFromPayload(shuffled, 1).windows.map((w) => w.windowSeconds)
  return labels.join(',') === '18000,604800,2592000'
})())
check('H9 重置时刻取 ISO resetsAt', opencodeEntry.windows[0].resetsAt === Date.parse('2026-10-17T08:06:47.000Z') / 1000
  && opencodeEntry.windows[1].resetsAt === Date.parse('2026-10-19T00:00:00.000Z') / 1000)
check('H9 resetAfterSeconds 不臆造', opencodeEntry.windows.every((w) => w.resetAfterSeconds === null))
const currentOpencodeEntry = opencodeEntryFromPayload(CURRENT_OPENCODE_PAYLOAD, 1792211220093)
check('H9 当前 windows[] 响应 → 5h / 7d / 30d 三窗口', currentOpencodeEntry !== null
  && currentOpencodeEntry.windows.map((w) => w.windowSeconds).join(',') === '18000,604800,2592000'
  && currentOpencodeEntry.windows.map((w) => w.usedPercent).join(',') === '6,36,59')
check('H9 当前 windows[] 响应保留套餐和相对重置时间', currentOpencodeEntry.plan === 'lite'
  && currentOpencodeEntry.windows[0].resetsAt === null && currentOpencodeEntry.windows[0].resetAfterSeconds === 13363
  && currentOpencodeEntry.windows[2].resetAfterSeconds === 1188832)
check('H9 套餐名留空（Go 与 Go Plus 不可区分）', opencodeEntry.plan === null)
check('H9 无余额字段（订阅不含加购余额）', opencodeEntry.credits === null)
check('H9 status=ok 且未满载 → limitReached false', opencodeEntry.limitReached === false)
check('H9 status 非 ok 即视为已达上限（未验证取值，按失败闭合）', (() => {
  const limited = opencodeEntryFromPayload({ usage: { rolling: { status: 'limited', percent: 20 } } }, 1)
  return limited.limitReached === true && limited.windows[0].windowSeconds === 18000
})())
check('H9 percent 满 100 也判为已达上限', opencodeEntryFromPayload({ usage: { monthly: { status: 'ok', percent: 100 } } }, 1).limitReached === true)
check('H9 percent 夹取到 [0,100]', (() => {
  const high = opencodeEntryFromPayload({ usage: { rolling: { percent: 180 } } }, 1)
  const low = opencodeEntryFromPayload({ usage: { rolling: { percent: -5 } } }, 1)
  return high.windows[0].usedPercent === 100 && low.windows[0].usedPercent === 0
})())
check('H9 percent 为字符串数字也认（looseNum）', opencodeEntryFromPayload({ usage: { rolling: { percent: '42' } } }, 1).windows[0].usedPercent === 42)
check('H9 未知窗口键被忽略（只认三个已声明窗口）', (() => {
  const entry = opencodeEntryFromPayload({ usage: { rolling: { percent: 1 }, daily: { percent: 99 }, hourly: { percent: 88 } } }, 1)
  return entry.windows.length === 1 && entry.windows[0].windowSeconds === 18000
})())
check('H9 缺 percent 的窗口被丢弃', opencodeEntryFromPayload({ usage: { rolling: { status: 'ok' }, weekly: { percent: 5 } } }, 1).windows.length === 1)
check('H9 取不到任何窗口 → null（不显示，也不编造）', opencodeEntryFromPayload({}, 1) === null
  && opencodeEntryFromPayload({ usage: {} }, 1) === null
  && opencodeEntryFromPayload({ usage: [] }, 1) === null
  && opencodeEntryFromPayload({ usage: { rolling: { status: 'ok' } } }, 1) === null)
check('H9 非对象 → null', opencodeEntryFromPayload(null, 1) === null && opencodeEntryFromPayload('x', 1) === null)
check('H9 fetchedAt 用传入时刻（可注入）', opencodeEntryFromPayload(REAL_OPENCODE_PAYLOAD, 123456).fetchedAt === 123456)
check('H9 条目里没有任何多余字段（只有统一契约的 6 个键）', (() => {
  const keys = Object.keys(opencodeEntry).sort().join(',')
  return keys === 'credits,fetchedAt,limitReached,ok,plan,windows'
    && Object.keys(opencodeEntry.windows[0]).sort().join(',') === 'resetAfterSeconds,resetsAt,usedPercent,windowSeconds'
})())
check('H9 条目不含上游原始字段（不整包透传）', !JSON.stringify(opencodeEntry).includes('resetsAt":"2026')
  && !JSON.stringify(opencodeEntry).includes('status'))

await (async () => {
  const { stub, calls } = makeFetchStub(() => okResponse(REAL_OPENCODE_PAYLOAD))
  const settings = makeSettings({ 'opencode-go': 'OPENCODE_API_KEY' })
  const creds = makeCredentials(undefined, { OPENCODE_API_KEY: OPENCODE_KEY })
  const service = createQuotaService({ credentialsOf: () => creds.service, settingsOf: () => settings.service, fetchImpl: stub })
  const res = await service.readOne('opencode-go')
  check('H9 ref 型凭据按 settings 生效的 apiKeyEnv 解析', creds.calls.resolve.join(',') === 'OPENCODE_API_KEY')
  check('H9 上游 URL 固定为当前 zen usage 路径', calls[0].url === 'https://opencode.ai/zen/go/v1/usage')
  check('H9 请求头只有 Bearer + accept', calls[0].init.headers.authorization === 'Bearer ' + OPENCODE_KEY
    && calls[0].init.headers.accept === 'application/json'
    && calls[0].init.headers.originator === undefined
    && calls[0].init.headers['chatgpt-account-id'] === undefined)
  check('H9 成功条目成型（三窗口）', res.ok === true && res.windows.length === 3)
  check('H9 条目里不含 API key', !JSON.stringify(res).includes(OPENCODE_KEY))
})()

await (async () => {
  const { stub } = makeFetchStub(() => okResponse(REAL_OPENCODE_PAYLOAD))
  const creds = makeCredentials(undefined, { OPENCODE_API_KEY: OPENCODE_KEY })
  const service = createQuotaService({ credentialsOf: () => creds.service, fetchImpl: stub })
  const res = await service.readOne('opencode-go')
  check('H9 settings 服务缺失 → 回退 OPENCODE_API_KEY', res.ok === true && creds.calls.resolve.join(',') === 'OPENCODE_API_KEY')
})()

await (async () => {
  const { stub, calls } = makeFetchStub(() => okResponse(REAL_OPENCODE_PAYLOAD))
  const creds = makeCredentials(undefined, {})
  const service = createQuotaService({ credentialsOf: () => creds.service, settingsOf: () => makeSettings({ 'opencode-go': 'OPENCODE_API_KEY' }).service, fetchImpl: stub })
  const res = await service.readOne('opencode-go')
  check('H9 引用取不到 → not-configured 且不打上游', res.ok === false && res.reason === 'not-configured' && calls.length === 0)
})()

await (async () => {
  const { stub, calls } = makeFetchStub(() => ({ status: 401, async json() { return { error: { type: 'AuthError', message: 'Unauthorized' } } } }))
  const creds = makeCredentials(undefined, { OPENCODE_API_KEY: OPENCODE_KEY })
  const service = createQuotaService({ credentialsOf: () => creds.service, settingsOf: () => makeSettings({ 'opencode-go': 'OPENCODE_API_KEY' }).service, fetchImpl: stub })
  const res = await service.readOne('opencode-go')
  check('H9 上游 401 → 只回状态码，不回响应体', res.ok === false && res.reason === 'http-401'
    && !JSON.stringify(res).includes('Unauthorized') && calls.length === 1)
})()

await (async () => {
  const { stub } = makeFetchStub(() => okResponse({ usage: {} }))
  const creds = makeCredentials(undefined, { OPENCODE_API_KEY: OPENCODE_KEY })
  const service = createQuotaService({ credentialsOf: () => creds.service, settingsOf: () => makeSettings({ 'opencode-go': 'OPENCODE_API_KEY' }).service, fetchImpl: stub })
  const res = await service.readOne('opencode-go')
  check('H9 200 但无窗口 → no-windows', res.ok === false && res.reason === 'no-windows')
})()

await (async () => {
  let clock = 1_000_000
  const { stub, calls } = makeFetchStub(() => okResponse(REAL_OPENCODE_PAYLOAD))
  const creds = makeCredentials(undefined, { OPENCODE_API_KEY: OPENCODE_KEY })
  const service = createQuotaService({ credentialsOf: () => creds.service, settingsOf: () => makeSettings({ 'opencode-go': 'OPENCODE_API_KEY' }).service, fetchImpl: stub, now: () => clock })
  await service.readOne('opencode-go')
  clock += CACHE_TTL_MS + 1
  await service.readOne('opencode-go')
  check('H9 缓存对 opencode-go 同样生效', calls.length === 2 && creds.calls.resolve.length === 2)
})()

/* ── H10：路由 id 因设备而异（baseURL 判定 + 别名） ────────────────── */

const OPENCODE_GO_PROVIDER = {
  displayName: 'OpenCode Go',
  apiKeyEnv: 'OPENCODEGO_API_KEY',
  baseURL: 'https://opencode.ai/zen/go/v1',
}

check('H10 routeIdsFor 按 baseURL 判定本机真实路由 id（别名在前）', (() => {
  const ids = routeIdsFor({ opencodego: OPENCODE_GO_PROVIDER }, QUOTA_SOURCES['opencode-go'])
  return ids.join(',') === 'opencode-go,opencodego'
})())

check('H10 routeIdsFor 去重保序（settings 已有规范名时不重复）', (() => {
  const providers = {
    'opencode-go': { baseURL: 'https://opencode.ai/zen/go/v1', apiKeyEnv: 'OPENCODE_API_KEY' },
    opencodego: OPENCODE_GO_PROVIDER,
  }
  return routeIdsFor(providers, QUOTA_SOURCES['opencode-go']).join(',') === 'opencode-go,opencodego'
})())

check('H10 不误伤无关 provider（baseURL 不含 zen/go）', (() => {
  const providers = { 'gemini-relay': { baseURL: 'https://generativelanguage.googleapis.com/v1beta' } }
  return routeIdsFor(providers, QUOTA_SOURCES['opencode-go']).join(',') === 'opencode-go,opencodego'
    && matchedRouteIds(providers, QUOTA_SOURCES['opencode-go']).length === 0
})())

check('H10 sourceOfRoute 别名与真实 id 命中同一条数据源，未知 id → null', (() => {
  const providers = { opencodego: OPENCODE_GO_PROVIDER }
  const byAlias = sourceOfRoute('opencodego', providers)
  const byCanonical = sourceOfRoute('opencode-go', providers)
  return byAlias !== null && byCanonical !== null
    && byAlias.sourceId === 'opencode-go' && byCanonical.sourceId === 'opencode-go'
    && sourceOfRoute('no-such-route', providers) === null && sourceOfRoute('', providers) === null
})())

check('H10 providersSectionOf 从 settings 服务取出 providers 段', (() => {
  const providers = providersSectionOf(makeSettings({ opencodego: OPENCODE_GO_PROVIDER }).service)
  return providers !== null && providers.opencodego.baseURL === 'https://opencode.ai/zen/go/v1'
    && providersSectionOf(undefined) === null && providersSectionOf({}) === null
})())

await (async () => {
  const { stub, calls } = makeFetchStub(() => okResponse(REAL_OPENCODE_PAYLOAD))
  const settings = makeSettings({ opencodego: OPENCODE_GO_PROVIDER })
  const creds = makeCredentials(undefined, { OPENCODEGO_API_KEY: OPENCODE_KEY, OPENCODE_API_KEY: 'sk-other-account' })
  const service = createQuotaService({ credentialsOf: () => creds.service, settingsOf: () => settings.service, fetchImpl: stub })
  const res = await service.readOne('opencodego')
  check('H10 凭据按真实路由 id 解析（OPENCODEGO_API_KEY 优先于回退名）', creds.calls.resolve.join(',') === 'OPENCODEGO_API_KEY')
  check('H10 opencodego 直接读到三窗口条目，且只打一次上游', res.ok === true && res.windows.length === 3 && calls.length === 1)
})()

await (async () => {
  const { stub, calls } = makeFetchStub(() => okResponse(REAL_OPENCODE_PAYLOAD))
  const settings = makeSettings({ opencodego: OPENCODE_GO_PROVIDER })
  const creds = makeCredentials(undefined, { OPENCODEGO_API_KEY: OPENCODE_KEY })
  const service = createQuotaService({ credentialsOf: () => creds.service, settingsOf: () => settings.service, fetchImpl: stub })
  const all = await service.readAll()
  check('H10 readAll 同时暴露规范名与本机真实 id（同一份条目）', all['opencode-go'] !== undefined && all.opencodego !== undefined
    && JSON.stringify(all['opencode-go']) === JSON.stringify(all.opencodego))
  check('H10 readAll 键数 = 3 + 命中数，且同一数据源只打一次上游', Object.keys(all).length === 4 && calls.length === 1)
})()

/* ── H11：可见配置（默认值 / 覆盖 / 白名单 / 回显） ─────────────────── */

check('H11 缺省配置 = 代码常量（未装 pack 时行为不变）', (() => {
  const resolved = resolveConfig(undefined)
  return resolved.configVersion === CONFIG_VERSION && resolved.enabled === true
    && resolved.cacheTtlMs === CONFIG_DEFAULTS.cacheTtlMs && resolved.timeoutMs === CONFIG_DEFAULTS.timeoutMs
    && resolved.warnings.length === 0 && Object.keys(resolved.sources).length === 0
    && Object.keys(resolved.ui.labels).length === 0
})())

check('H11 数值项越界收敛、非数字忽略并记 warning', (() => {
  const low = resolveConfig({ cacheTtlMs: 1, timeoutMs: 1 })
  const high = resolveConfig({ cacheTtlMs: 99999999, timeoutMs: 99999999 })
  const bad = resolveConfig({ cacheTtlMs: 'soon' })
  return low.cacheTtlMs === 5000 && low.timeoutMs === 1000
    && high.cacheTtlMs === 600000 && high.timeoutMs === 30000
    && bad.cacheTtlMs === CONFIG_DEFAULTS.cacheTtlMs && bad.warnings.length === 1 && bad.warnings[0].path === 'cacheTtlMs'
})())

check('H11 未知数据源被忽略并记 warning', (() => {
  const resolved = resolveConfig({ sources: { 'no-such-source': { enabled: false } } })
  return resolved.warnings.length === 1 && resolved.warnings[0].path === 'sources.no-such-source'
    && Object.keys(resolved.sources).length === 0
})())

check('H11 usagePath 相对路径拼到默认端点 origin 上', (() => {
  const sources = effectiveSourcesOf(resolveConfig({ sources: { 'opencode-go': { usagePath: '/zen/go/v2/usage' } } }))
  return sources['opencode-go'].url === 'https://opencode.ai/zen/go/v2/usage'
    && sources['kimi-coding'].url === 'https://api.kimi.com/coding/v1/usages'
})())

check('H11 usagePath 绝对 URL：白名单外一律拒绝（防凭据外发）', (() => {
  const resolved = resolveConfig({ sources: { 'opencode-go': { usagePath: 'https://evil.example.com/usage' } } })
  const sources = effectiveSourcesOf(resolved)
  const plain = resolveConfig({ sources: { 'opencode-go': { usagePath: 'http://opencode.ai/zen/go/v1/usage' } } })
  return resolved.warnings.length === 1 && resolved.warnings[0].path === 'sources.opencode-go.usagePath'
    && sources['opencode-go'].url === 'https://opencode.ai/zen/go/v1/usage'
    && plain.warnings.length === 1 && effectiveSourcesOf(plain)['opencode-go'].url === 'https://opencode.ai/zen/go/v1/usage'
})())

check('H11 usagePath 绝对 URL：白名单内允许（镜像/自建代理）', (() => {
  const resolved = resolveConfig({ sources: { 'kimi-coding': { usagePath: 'https://api.kimi.com/coding/v1/usages' } } })
  return resolved.warnings.length === 0
    && effectiveSourcesOf(resolved)['kimi-coding'].url === 'https://api.kimi.com/coding/v1/usages'
    && USAGE_HOST_ALLOWLIST.join(',') === 'opencode.ai,api.kimi.com,chatgpt.com'
})())

check('H11 baseHosts / aliases 覆盖后按新值判定真实路由', (() => {
  const sources = effectiveSourcesOf(resolveConfig({
    sources: { 'opencode-go': { baseHosts: ['mirror.example.com/go'], aliases: ['opencode-go', 'myopencode'] } },
  }))
  const providers = { myopencode: { baseURL: 'https://mirror.example.com/go/v1' } }
  const ids = routeIdsFor(providers, sources['opencode-go'])
  return ids.join(',') === 'opencode-go,myopencode'
})())

check('H11 ui 校验：坏色值/超长缩写被拒，合法项保留', (() => {
  const resolved = resolveConfig({
    ui: {
      colors: { 'opencode-go': '#7CB342', opencodego: 'green', 'kimi-coding': '#12345' },
      labels: { opencodego: 'opengo', 'kimi-coding': '123456789' },
      aliases: { opencodego: 'opencode-go' },
    },
  })
  return resolved.ui.colors['opencode-go'] === '#7CB342' && resolved.ui.colors.opencodego === undefined
    && resolved.ui.colors['kimi-coding'] === undefined
    && resolved.ui.labels.opencodego === 'opengo' && resolved.ui.labels['kimi-coding'] === undefined
    && resolved.ui.aliases.opencodego === 'opencode-go'
    && resolved.warnings.length === 3
})())

check('H11 回显只带引用名，不含任何凭据值', (() => {
  const providers = { opencodego: { apiKeyEnv: 'OPENCODEGO_API_KEY', baseURL: 'https://opencode.ai/zen/go/v1' } }
  const view = configViewOf(resolveConfig(undefined), effectiveSourcesOf(resolveConfig(undefined)), providers)
  const text = JSON.stringify(view)
  return view.ok === true && view.sources['opencode-go'].refNames.join(',') === 'OPENCODEGO_API_KEY,OPENCODE_API_KEY'
    && view.sources['opencode-go'].routeIds.join(',') === 'opencode-go,opencodego'
    && view.sources['openai-codex'].refNames.join(',') === 'llm-pi-ai/openai-codex'
    && !text.includes('sk-') && !text.includes(OPENCODE_KEY) && view.ui !== undefined
})())

await (async () => {
  const { stub, calls } = makeFetchStub(() => okResponse(CURRENT_OPENCODE_PAYLOAD))
  const sources = effectiveSourcesOf(resolveConfig({ enabled: false }))
  const service = createQuotaService({
    credentialsOf: () => makeCredentials(undefined, { OPENCODE_API_KEY: OPENCODE_KEY }).service,
    sources,
    fetchImpl: stub,
  })
  const res = await service.readAll()
  check('H11 总开关关闭 → 数据源 disabled 且零上游请求', calls.length === 0 && res['opencode-go'].reason === 'disabled')
})()

await (async () => {
  const { stub, calls } = makeFetchStub(() => okResponse(CURRENT_OPENCODE_PAYLOAD))
  const sources = effectiveSourcesOf(resolveConfig({ sources: { 'kimi-coding': { enabled: false } } }))
  const creds = makeCredentials(undefined, { OPENCODE_API_KEY: OPENCODE_KEY })
  const service = createQuotaService({ credentialsOf: () => creds.service, sources, fetchImpl: stub })
  const res = await service.readAll()
  check('H11 单源关闭：该源 disabled、其它源照常且只打自己一次', res['kimi-coding'].reason === 'disabled'
    && res['opencode-go'].ok === true && calls.length === 1 && calls[0].url.includes('/zen/go/v1/usage'))
})()

await (async () => {
  const fetched = []
  globalThis.fetch = async (url) => { fetched.push(String(url)); return okResponse(CURRENT_OPENCODE_PAYLOAD) }
  const creds = makeCredentials(undefined, { OPENCODEGO_API_KEY: OPENCODE_KEY })
  const settings = makeSettings({ opencodego: { apiKeyEnv: 'OPENCODEGO_API_KEY', baseURL: 'https://opencode.ai/zen/go/v1' } })
  const { registered } = mountPlugin(creds.service, settings.service, { ui: { labels: { opencodego: 'opengo' } } })
  const configHandler = registered.find((entry) => entry.path === CONFIG_PATH).handler
  const res = makeRes()
  await configHandler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, res)
  const body = JSON.parse(res.body)
  check('H11 配置端点：回环 GET → 200，回显覆盖与本机真实 id', res.status === 200 && body.ok === true
    && body.ui.labels.opencodego === 'opengo' && body.sources['opencode-go'].routeIds.includes('opencodego')
    && body.configVersion === CONFIG_VERSION && fetched.length === 0)
  check('H11 配置端点不含密钥，且同样只答回环', !res.body.includes(OPENCODE_KEY) && !res.body.includes('sk-')
    && (await (async () => { const bad = makeRes(); await configHandler({ method: 'GET', socket: { remoteAddress: '10.0.0.7' } }, bad); return bad.status === 403 })()))
  check('H11 配置端点拒绝非 GET', await (async () => { const bad = makeRes(); await configHandler({ method: 'POST', socket: { remoteAddress: '127.0.0.1' } }, bad); return bad.status === 405 })())
})()

check('H11 坏配置不崩（sources/ui 类型错都降级）', (() => {
  for (const bad of [{ sources: [] }, { sources: 'x' }, { ui: null }, { ui: { labels: [] } }, { sources: { 'opencode-go': 'x' } }, { enabled: 'yes' }]) {
    const resolved = resolveConfig(bad)
    if (resolved.enabled !== true) return false
  }
  return true
})())

/* ── 汇总 ─────────────────────────────────────────────────────────── */

console.log('')
if (failed > 0) {
  console.error(`FAILED: ${failed} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`ALL PASSED (${passed} checks)`)
