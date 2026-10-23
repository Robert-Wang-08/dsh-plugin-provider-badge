#!/usr/bin/env node
/**
 * probe/smoke-client.mjs — provider 徽标 M3 门禁冒烟。
 *
 * 覆盖 design.md：
 *   S9  交付形状（classic script 解析、单一 __ModuleLoader__.load 注册、
 *       id 与 package.json 一致、结尾形状、require 白名单、node --check）
 *   S4/S5  文本与颜色推导（确定性、回退链、已知路由集合无色相碰撞）
 *   M1/S3  inject face 降级分支 + 徽标渲染（假 ctx / 假 react）
 *
 * 用法：node probe/smoke-client.mjs   （期望输出 ALL PASSED）
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failed += 1
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/* ── S9：交付形状 ──────────────────────────────────────────────────── */

const LOAD_PREFIX = 'window.__ModuleLoader__.load({'

check('S9 classic-script parse（vm.Script）', (() => {
  try { new vm.Script(source, { filename: 'client.js' }); return true } catch (e) { console.error(e.message); return false }
})())
// 头部 JSDoc 注释合法（先例：keypool client.js 同为「注释 + load 包装」），
// 契约只要求：单一 load 注册、classic script 可解析、结尾闭合。
check('S9 存在 __ModuleLoader__.load 前缀', source.includes(LOAD_PREFIX))
check('S9 恰好 1 个 load 注册', [...source.matchAll(/__ModuleLoader__\.load\(/g)].length === 1)
check('S9 id 与 package.json 一致', source.includes(`id: ${JSON.stringify(pkg.name)}`))
check('S9 结尾形状（return module.exports; … });）', source.trimEnd().endsWith('});') && /return module\.exports;/.test(source))
check('S9 无 ESM import/export 语句', !/^\s*(import|export)\s/m.test(source))

const requires = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1])
check('S9 require 白名单 = react + react-dom', requires.length > 0 && requires.every((r) => r === 'react' || r === 'react-dom'), requires.join(', '))
check('S9 级联经 createPortal 挂载（缺失时内联降级）', source.includes('createPortal(cascadeEl, portalTarget)'))

for (const file of ['client.js', 'index.js']) {
  try {
    // stdio 用 'ignore' 而非 'pipe'：受限环境（如 DSH 文件沙箱）禁止子进程建管道，
    // 'pipe' 会在启动阶段就以 EPERM 失败，与文件是否合法无关。
    execFileSync(process.execPath, ['--check', path.join(root, file)], { cwd: root, stdio: 'ignore' })
    check(`S9 node --check ${file}`, true)
  } catch (e) {
    check(`S9 node --check ${file}`, false, `exit ${e.status ?? '?'} ${e.code ?? ''}`.trim())
  }
}

/* ── 载入模块（假 window.__ModuleLoader__ + 假 react） ──────────────── */

let captured = null
const fakeLS = {
  store: {},
  getItem(key) { return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null },
  setItem(key, value) { this.store[key] = String(value) },
  removeItem(key) { delete this.store[key] },
}
const sandbox = {
  window: { __ModuleLoader__: { load: (mod) => { captured = mod } } },
  localStorage: fakeLS,
}
vm.createContext(sandbox)
new vm.Script(source, { filename: 'client.js' }).runInContext(sandbox)

check('S9 load 捕获到注册', captured !== null && captured.id === pkg.name)

const hookIdentity = (fn) => fn
/**
 * useState 播种：按**调用序号**给某几次 useState 直接指定初值，用于渲染
 * 「级联已打开」这类只有交互才能到达的状态（假 react 不重渲染）。
 * 序号由 hookIndex 计数，每次渲染前由 renderComponent 归零。
 */
let hookIndex = 0
const stateSeeds = new Map()
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useMemo: (fn) => fn(),
  useEffect: hookIdentity,
  useLayoutEffect: hookIdentity,
  useRef: (init) => ({ current: init }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useState: (init) => {
    const index = hookIndex
    hookIndex += 1
    const box = { value: stateSeeds.has(index) ? stateSeeds.get(index) : (typeof init === 'function' ? init() : init) }
    const setter = (next) => { box.value = typeof next === 'function' ? next(box.value) : next }
    return [box.value, setter]
  },
}
// 假 react-dom：createPortal 原样返回子树。沙箱无 document，client.js 的
// portal 分支不会走到这里；此桩只为 require 解析成功。
const fakeReactDOM = { createPortal: (node) => node }
const exports_ = captured.factory((name) => {
  if (name === 'react') return fakeReact
  if (name === 'react-dom') return fakeReactDOM
  throw new Error(`unexpected require: ${name}`)
})

check('exports.inject 权限清单正确', JSON.stringify(exports_.inject) === JSON.stringify(['slots', 'sessions', 'modelDirectories', 'remote', 'remote.session']))
check('exports.__test 探针面就位', exports_.__test !== undefined && typeof exports_.apply === 'function')

const {
  fourLetters, deriveLetters, colorOf, hash32, ROUTE_COLORS, ROUTE_LABELS, STORAGE_KEY, PALETTE,
  parseColor, relativeLuminance, inkFor, wheelDist, hueSlotsFor, routeIdsOf,
  resolveColor, swatchColors, panelPositionFor, loadOverrides, saveOverrides,
  badgeOf, faceOf, UNAVAILABLE,
  selectionFor, cascadePlacementFor, providerIndexByPrefix, nextEnabledIndex, providerRowsOf,
  shouldCloseOnScroll,
  QUOTA_ENDPOINT, QUOTA_CLIENT_TTL_MS, QUOTA_TONES, quotaCache,
  formatWindowSpan, formatCountdown, quotaWindowsOf, quotaTextOf, quotaInlineTextOf, quotaFailureOf, quotaTitleOf, quotaToneOf,
  formatMoney, extraUsageParts, CURRENCY_SYMBOLS,
  ROUTE_ALIASES, canonicalRouteId, aliasLookup, colorPresentationFor,
} = exports_.__test

/** 组件渲染入口：每次渲染前把 useSub 序号归零，保证播种序号稳定。 */
function renderComponent(props) {
  hookIndex = 0
  return registration !== null ? registration.component(props) : null
}

/* ── S4 v2：文本推导（4 字母：多词首字母，不足补尾字母，无符号） ───── */
/* 以下标识符均为泛化示例，不含任何真实路由名。 */

check('S4 fourLetters 多词首字母+尾词补齐', fourLetters('Alpha One') === 'AOne')
check('S4 fourLetters CJK+拉丁混合（按文字系统分词）', fourLetters('智谱GLM') === '智GLM')
check('S4 fourLetters 纯 CJK 按阅读顺序', fourLetters('智谱官方') === '智谱官方')
check('S4 fourLetters 单长词取前 4 字符', fourLetters('providerlongname') === 'prov')
check('S4 fourLetters 符号/括号/减号不入徽标', fourLetters('ab（12cd）-x') === 'a1x2')
check('S4 fourLetters 纯符号 → null', fourLetters('---') === null && fourLetters('()') === null)
check('S4 fourLetters 非串 → null', fourLetters(null) === null && fourLetters(undefined) === null && fourLetters(42) === null)
check('S4 fourLetters 最长 4 字符', fourLetters('kimi-like-name').length === 4 && fourLetters('a').length === 1)
check('S4 deriveLetters 优选显示名（≥4）', deriveLetters('Alpha One', 'provider-alpha') === 'AOne')
check('S4 deriveLetters 显示名过短回退更长的 id 推导', deriveLetters('Ab', 'provider-alpha') === 'palp')
check('S4 deriveLetters 显示名缺失回退 id', deriveLetters(null, 'provider-alpha') === 'palp')
check('S4 deriveLetters 两者皆缺 → null', deriveLetters('', '---') === null)
check('S4 确定性（重复推导同输出）', deriveLetters('Alpha One', 'x') === deriveLetters('Alpha One', 'x'))

/* ── S5 v2：颜色推导（路由色表优先 + 12 槽调色板均匀铺槽） ─────────── */

check('S5 调色板 12 槽且格式合法', PALETTE.length === 12 && PALETTE.every((c) => /^hsl\(\d+, \d+%, \d+%\)$/.test(c)))
check('S5 蓝段槽位 ≤ 2（218/248）', PALETTE.filter((c) => { const h = Number(c.match(/hsl\((\d+),/)[1]); return h >= 210 && h <= 255 }).length === 2)

const EXPECTED_ROUTE_COLORS = {
  'anthropic-relay': '#E0501E',
  'codex-relay': '#2F6FEB',
  'ais-2dsglm': '#8ECDF7',
  'openai-codex': '#2E9E5B',
  'kimi-coding': '#A7E0A9',
  'opencode-go': '#7CB342',
}
for (const [id, hex] of Object.entries(EXPECTED_ROUTE_COLORS)) {
  check(`S5 ROUTE_COLORS ${id} = ${hex}`, ROUTE_COLORS[id] === hex && colorOf(id, { groups: [], current: { provider: id } }) === hex)
}

const KNOWN_ROUTES = ['provider-alpha', 'provider-beta', 'provider-gamma-one', 'provider-gamma-two', 'provider-delta', 'provider-echo']
const slotMap = hueSlotsFor(KNOWN_ROUTES)
const slots6 = KNOWN_ROUTES.map((r) => slotMap.get(r))
const unmappedState = { groups: KNOWN_ROUTES.map((id) => ({ id })), current: { provider: 'provider-alpha' } }
check('S5 已知 6 路由槽位互不相同', new Set(slots6).size === KNOWN_ROUTES.length, JSON.stringify(KNOWN_ROUTES.map((r, i) => `${r}:${slots6[i]}`)))
check('S5 两两轮盘距离 ≥ 2 槽（60°）', (() => {
  for (let i = 0; i < slots6.length; i++) for (let j = i + 1; j < slots6.length; j++) if (wheelDist(slots6[i], slots6[j]) < 2) return false
  return true
})())
check('S5 同前缀对 provider-gamma-one/provider-gamma-two 距离 ≥ 2 槽', wheelDist(slotMap.get('provider-gamma-one'), slotMap.get('provider-gamma-two')) >= 2)
check('S5 蓝段占用的路由 ≤ 2', slots6.filter((s) => s >= 6 && s <= 8).length <= 2, JSON.stringify(slots6))
check('S5 分配确定性', JSON.stringify([...hueSlotsFor(KNOWN_ROUTES)]) === JSON.stringify([...slotMap]))
check('S5 colorOf 落在调色板内且稳定', PALETTE.includes(colorOf('provider-alpha', unmappedState)))
check('S5 未入表路由仍走自动调色板', colorOf('provider-alpha', unmappedState) === PALETTE[slotMap.get('provider-alpha')])
check('S5 routeIdsOf 提取 groups+current 并去重', (() => {
  const ids = routeIdsOf({ groups: [{ id: 'b' }, { id: 'a' }], current: { provider: 'a' } })
  return JSON.stringify(ids) === JSON.stringify(['b', 'a'])
})())
check('S5 空集合安全', hueSlotsFor([]).size === 0 && hueSlotsFor(['x', 42]).size === 1)

/* ── S5b：字色对比度（parseColor / inkFor） ─────────────────────────── */

check('S5b parseColor #rrggbb', (() => {
  const c = parseColor('#2F6FEB')
  return c !== null && Math.abs(c.r - 47 / 255) < 1e-9 && Math.abs(c.g - 111 / 255) < 1e-9 && Math.abs(c.b - 235 / 255) < 1e-9
})())
check('S5b parseColor #rgb', (() => {
  const c = parseColor('#abc')
  return c !== null && Math.abs(c.r - 170 / 255) < 1e-9 && Math.abs(c.g - 187 / 255) < 1e-9 && Math.abs(c.b - 204 / 255) < 1e-9
})())
check('S5b parseColor hsl()', (() => {
  const c = parseColor('hsl(0, 62%, 46%)')
  return c !== null && typeof c.r === 'number' && typeof c.g === 'number' && typeof c.b === 'number'
    && c.r >= 0 && c.r <= 1 && c.g >= 0 && c.g <= 1 && c.b >= 0 && c.b <= 1
})())
check('S5b parseColor 非法 → null', parseColor('not-a-color') === null && parseColor(null) === null)
check('S5b inkFor 浅蓝 #8ECDF7 → 深墨', inkFor('#8ECDF7') === '#14212B')
check('S5b inkFor 浅绿 #A7E0A9 → 深墨', inkFor('#A7E0A9') === '#14212B')
check('S5b inkFor 蓝 #2F6FEB → 白', inkFor('#2F6FEB') === '#fff')
check('S5b inkFor 橘红 #E0501E 白字优先 → 白', inkFor('#E0501E') === '#fff')
check('S5b inkFor 绿 #2E9E5B 白字优先 → 白', inkFor('#2E9E5B') === '#fff')
check('S5b inkFor 草绿 #7CB342 白字对比度不足 → 深墨', inkFor('#7CB342') === '#14212B')
check('S5b inkFor 无法解析 → 白', inkFor('not-a-color') === '#fff')
check('S5b inkFor 调色板 hsl 条目可解析并出字色', (() => {
  const ink = inkFor(PALETTE[0])
  return (ink === '#fff' || ink === '#14212B') && typeof relativeLuminance === 'function'
})())

/* ── badgeOf：目录快照 → 徽标描述 ──────────────────────────────────── */

const goodState = {
  current: { provider: 'provider-alpha', model: 'model-x' },
  groups: [{ id: 'provider-alpha', name: 'Alpha One' }, { id: 'provider-beta', name: 'Beta Two' }],
}
const good = badgeOf(goodState)
check('badgeOf 显示名优选 + title', good !== null && good.text === 'AOne' && good.title === 'Alpha One (provider-alpha)' && good.routeId === 'provider-alpha')
check('badgeOf 颜色由 colorOf 基于可见集合给出', colorOf('provider-alpha', goodState) === colorOf('provider-alpha', goodState) && PALETTE.includes(colorOf('provider-alpha', goodState)))
const fallback = badgeOf({ current: { provider: 'provider-alpha' }, groups: [] })
check('badgeOf 无 groups 回退 id', fallback.text === 'palp' && fallback.title === 'provider-alpha')
const emptyName = badgeOf({ current: { provider: 'provider-alpha' }, groups: [{ id: 'provider-alpha', name: '   ' }] })
check('badgeOf 空白显示名视为缺失', emptyName.text === 'palp')
check('badgeOf 无当前选择 → null', badgeOf({ current: null, groups: goodState.groups }) === null)
check('badgeOf 非法快照 → null', badgeOf(null) === null && badgeOf(undefined) === null && badgeOf('x') === null)
check('badgeOf 空 provider → null', badgeOf({ current: { provider: '' } }) === null)
check('badgeOf 全缺失 → null', badgeOf({ current: { provider: '' }, groups: [] }) === null)

/* ── faceOf：inject face 降级分支（假 ctx） ────────────────────────── */

function makeCtx({ models, sessions, throwOnDirectory = false } = {}) {
  return {
    get(name) {
      if (name === 'modelDirectories') return models
      if (name === 'sessions') return sessions
      return undefined
    },
    directoryFor() {
      if (throwOnDirectory) throw new Error('boom')
      return undefined
    },
  }
}

check('faceOf 无 sessionId → UNAVAILABLE', faceOf(makeCtx(), undefined) === UNAVAILABLE)
check('faceOf 服务全缺 → UNAVAILABLE（store 键不存在）', !('store' in faceOf(makeCtx(), 's1')))

const subCtx = makeCtx({ sessions: { subagentAddress: () => 'sub:1' } })
check('faceOf subagent 转址 → UNAVAILABLE', !('store' in faceOf(subCtx, 's1')))

const plainSessions = { subagentAddress: () => undefined }
const throwCtx = makeCtx({ sessions: plainSessions, models: { directoryFor: () => { throw new Error('unknown session') } } })
check('faceOf directoryFor 抛错 → UNAVAILABLE', !('store' in faceOf(throwCtx, 's1')))

const badStoreCtx = makeCtx({ sessions: plainSessions, models: { directoryFor: () => ({ store: {} }) } })
check('faceOf store 形状不符 → UNAVAILABLE', !('store' in faceOf(badStoreCtx, 's1')))

/* 正常分支：store 透传 + idle 才 load + load 拒绝被吞 */
let loadCalls = 0
let loadShouldReject = false
const selectCalls = []
const storeState = { status: 'idle' }
const fakeStore = {
  subscribe(fn) { return () => fn && fn() },
  getSnapshot() { return storeState },
}
const normalCtxModelDirectories = {
  directoryFor(sessionId) {
    if (sessionId !== 's1') throw new Error('unexpected session')
    return {
      store: fakeStore,
      load() {
        loadCalls += 1
        if (loadShouldReject) return Promise.reject(new Error('catalog down'))
        return Promise.resolve(storeState)
      },
      select(selection) {
        selectCalls.push(selection)
        return Promise.resolve({ ok: true })
      },
    }
  },
}
const normalCtx = makeCtx({
  sessions: plainSessions,
  models: normalCtxModelDirectories,
})
const face = faceOf(normalCtx, 's1')
check('faceOf 正常分支透传 store', 'store' in face && face.store === fakeStore)
check('faceOf idle 才 load（首次触发）', (() => { face.load(); return loadCalls === 1 })())
check('faceOf 非 idle 不再 load', (() => { storeState.status = 'ready'; face.load(); return loadCalls === 1 })())
check('faceOf load 拒绝不冒泡', (() => { loadShouldReject = true; storeState.status = 'idle'; face.load(); return loadCalls === 2 })())
await new Promise((resolve) => setTimeout(resolve, 10))
check('faceOf 未配置时 ctx.get 缺失不抛', !('store' in faceOf({ /* 无 get */ }, 's1')))

/* ── apply：席位注册 ─────────────────────────────────────────────── */

let registeredSeat = null
let registration = null
let registrationTag = null
const applyCtx = {
  get(name) {
    if (name === 'sessions') return plainSessions
    if (name === 'modelDirectories') return normalCtxModelDirectories
    return undefined
  },
  slots: {
    inject(seat, factory, tag) {
      registeredSeat = seat
      registrationTag = tag
      registration = factory()
    },
    register(options, component) {
      return { options, component }
    },
  },
}
exports_.apply(applyCtx)
check('apply 注册在 conversation.input.right', registeredSeat === 'conversation.input.right')
check('apply 条目 id = provider-badge', registration !== null && registration.options.id === 'provider-badge')
check('apply 条目 name 与席位一致', registration.options.name === 'conversation.input.right')
check('apply 携带组件函数', typeof registration.component === 'function')
check('apply inject 出厂接 faceOf', registration.options.inject('s1').store === fakeStore)
check('apply tag 自述', typeof registrationTag === 'string' && registrationTag.includes('provider-badge'))

/* ── 组件渲染（假 react 钩子直读快照） ─────────────────────────────── */

const renderState = {
  status: 'ready',
  current: { provider: 'provider-alpha', model: 'model-x' },
  groups: [{ id: 'provider-alpha', name: 'Alpha One' }],
}
const renderStore = { subscribe: () => () => {}, getSnapshot: () => renderState }
const rendered = renderComponent({ store: renderStore, load: () => {} })
const childText = Array.isArray(rendered?.props?.children) ? rendered.props.children.join('') : rendered?.props?.children
check('渲染：徽标 span + 4 字母文本 + title + 调色板底色 + 对比字色',
  rendered !== null && rendered.type === 'span'
  && childText === 'AOne'
  && rendered.props.title === 'Alpha One (provider-alpha)'
  && rendered.props.style.background === colorOf('provider-alpha', renderState)
  && PALETTE.includes(rendered.props.style.background)
  && rendered.props.style.color === inkFor(rendered.props.style.background)
  && rendered.props.style.fontWeight === 700
  && rendered.props.style.height === '16px')
check('渲染：数据缺失 → null', renderComponent(UNAVAILABLE) === null)
check('渲染：store 快照为空 → null', renderComponent({ store: { subscribe: () => () => {}, getSnapshot: () => ({ current: null }) } }) === null)

/* ── S5c：选色优先级与持久化（resolveColor / localStorage） ─────────── */

const autoState = { groups: [{ id: 'provider-alpha' }, { id: 'anthropic-relay' }], current: { provider: 'provider-alpha' } }
check('S5c 优先级：用户覆盖 > 默认表', resolveColor('anthropic-relay', autoState, { 'anthropic-relay': '#123456' }) === '#123456')
check('S5c 优先级：无覆盖 → 默认表', resolveColor('anthropic-relay', autoState, {}) === ROUTE_COLORS['anthropic-relay'])
check('S5c 优先级：无覆盖且不在表 → 自动调色板', resolveColor('provider-alpha', autoState, {}) === colorOf('provider-alpha', autoState))
check('S5c 覆盖值为非法色 → 忽略走表/自动', resolveColor('anthropic-relay', autoState, { 'anthropic-relay': 'not-a-color' }) === ROUTE_COLORS['anthropic-relay'])
check('S5c 覆盖映射为空 → 忽略', resolveColor('anthropic-relay', autoState, null) === ROUTE_COLORS['anthropic-relay'])

check('S5c loadOverrides 空存储 → {}', JSON.stringify(loadOverrides()) === '{}')
fakeLS.store[STORAGE_KEY] = '{broken json'
check('S5c loadOverrides 损坏 JSON → {}', JSON.stringify(loadOverrides()) === '{}')
fakeLS.store[STORAGE_KEY] = JSON.stringify({ 'route-a': '#112233', 'route-b': 'bogus', 'route-c': 42 })
check('S5c loadOverrides 剔除非法条目', JSON.stringify(loadOverrides()) === JSON.stringify({ 'route-a': '#112233' }))
delete fakeLS.store[STORAGE_KEY]
check('S5c saveOverrides 写回可读', (() => {
  saveOverrides({ 'route-x': '#abcdef' })
  const ok = fakeLS.store[STORAGE_KEY] === JSON.stringify({ 'route-x': '#abcdef' })
  delete fakeLS.store[STORAGE_KEY]
  return ok
})())

const swatches = swatchColors()
check('S5c swatchColors 非空且全部可解析', Array.isArray(swatches) && swatches.length > 0 && swatches.every((c) => parseColor(c) !== null))
check('S5c swatchColors 含六个默认路由色', Object.values(ROUTE_COLORS).every((c) => swatches.includes(c)))
check('S5c swatchColors 去重', new Set(swatches).size === swatches.length)

check('渲染：点击处理器与 root 标记就位', rendered !== null && typeof rendered.props.onClick === 'function' && rendered.props['data-provider-badge-root'] === true)
check('渲染：点击在无 DOM 环境不抛（面板保持关闭）', (() => {
  try { rendered.props.onClick({ stopPropagation() {}, currentTarget: null }); return true }
  catch (e) { console.error(e); return false }
})())
fakeLS.store[STORAGE_KEY] = JSON.stringify({ 'provider-alpha': '#123456' })
const renderedCovered = renderComponent({ store: renderStore, load: () => {} })
const coveredChild = Array.isArray(renderedCovered?.props?.children) ? renderedCovered.props.children.join('') : renderedCovered?.props?.children
check('渲染：localStorage 覆盖色优先于调色板',
  renderedCovered !== null && renderedCovered.type === 'span'
  && coveredChild === 'AOne'
  && renderedCovered.props.style.background === '#123456'
  && renderedCovered.props.style.color === inkFor('#123456'))
delete fakeLS.store[STORAGE_KEY]

/* ── S5d：选色面板自适应定位（panelPositionFor） ─────────────────── */

check('S5d 下方空间充足 → 按钮下方', (() => {
  const pos = panelPositionFor({ left: 100, top: 300, bottom: 316 }, { width: 800, height: 600 })
  return pos.top === 322 && pos.left === 100
})())
check('S5d 下方不足 → 翻到按钮上方', (() => {
  const pos = panelPositionFor({ left: 100, top: 560, bottom: 576 }, { width: 800, height: 600 })
  return pos.top === 560 - 6 - 116
})())
check('S5d 上方也不足 → 夹取在视口内', (() => {
  const pos = panelPositionFor({ left: 100, top: 40, bottom: 56 }, { width: 800, height: 140 })
  return pos.top >= 8 && pos.top + 116 <= 140 - 8 + 8 // top ∈ [8, 140-116-8] 取 max(8, h-116-8)
})())
check('S5d 右边界溢出 → 左移夹取', (() => {
  const pos = panelPositionFor({ left: 740, top: 100, bottom: 116 }, { width: 800, height: 600 })
  return pos.left === 800 - 176 - 8
})())
check('S5d 左边界溢出 → 留边距', (() => {
  const pos = panelPositionFor({ left: -20, top: 100, bottom: 116 }, { width: 800, height: 600 })
  return pos.left === 8
})())
check('S5d 无视口信息 → 兜底不抛', (() => {
  const pos = panelPositionFor({ left: 50, top: 60, bottom: 76 }, undefined)
  return pos.top === 82 && pos.left === 50
})())
check('S5d 锚点为空 → (0,0) 不抛', (() => {
  const pos = panelPositionFor(null, { width: 800, height: 600 })
  return typeof pos.left === 'number' && typeof pos.top === 'number'
})())

/* ── S5e：徽标缩写覆盖表（ROUTE_LABELS） ─────────────────────────── */

const labelState = (routeId, name) => ({
  current: { provider: routeId },
  groups: [{ id: routeId, name }],
})
check('S5e deepseek-official → ds官', badgeOf(labelState('deepseek-official', 'DeepSeek Official')).text === 'ds官')
check('S5e codex-relay → a1gpt', badgeOf(labelState('codex-relay', 'Codex Relay')).text === 'a1gpt')
check('S5e openai-codex → gpt官', badgeOf(labelState('openai-codex', 'gpt（official）')).text === 'gpt官')
check('S5e anthropic-relay → claude', badgeOf(labelState('anthropic-relay', 'Anthropic Relay')).text === 'claude')
check('S5e opencode-go → opengo（允许超 4 字符）', badgeOf(labelState('opencode-go', 'OpenCode Go')).text === 'opengo')
check('S5e kimi-coding → kimi官', badgeOf(labelState('kimi-coding', 'Kimi Coding')).text === 'kimi官')
check('S5e 未入表 ais-2dsglm 仍自动推导', (() => {
  const badge = badgeOf(labelState('ais-2dsglm', 'AIS 2DSGLM'))
  return badge !== null && badge.text === deriveLetters('AIS 2DSGLM', 'ais-2dsglm')
})())
check('S5e 未入表未知路由仍自动推导', (() => {
  const badge = badgeOf(labelState('provider-alpha', 'Alpha One'))
  return badge !== null && badge.text === 'AOne'
})())
check('S5e 覆盖不改变悬停 title', badgeOf(labelState('codex-relay', 'Codex Relay')).title === 'Codex Relay (codex-relay)')

/* ── S5f：路由别名归一化（同一家 provider 的设备命名差异） ─────────── */

check('S5f 别名表只登记 opencodego → opencode-go', JSON.stringify(ROUTE_ALIASES) === '{"opencodego":"opencode-go"}')
check('S5f canonicalRouteId 归一化 / 原样 / 非法输入', canonicalRouteId('opencodego') === 'opencode-go'
  && canonicalRouteId('opencode-go') === 'opencode-go' && canonicalRouteId('provider-alpha') === 'provider-alpha'
  && canonicalRouteId('') === null && canonicalRouteId(null) === null && canonicalRouteId(42) === null)
check('S5f aliasLookup 精确优先、未命中再按别名、两处都缺 → null', (() => {
  const table = { 'opencode-go': 'x', 'kimi-coding': 'y' }
  return aliasLookup(table, 'opencode-go') === 'x' && aliasLookup(table, 'opencodego') === 'x'
    && aliasLookup(table, 'nope') === null && aliasLookup(null, 'x') === null
})())
check('S5f opencodego 命中缩写表 opengo', badgeOf(labelState('opencodego', 'OpenCode Go')).text === 'opengo')
check('S5f opencodego 命中色表草绿（colorOf 与桥一致）', colorOf('opencodego', { groups: [], current: { provider: 'opencodego' } }) === '#7CB342'
  && colorPresentationFor('opencodego', ['opencodego']).color === '#7CB342'
  && colorPresentationFor('opencodego', ['opencodego']).text === 'opengo')
check('S5f 未入别名表的路由行为不变', badgeOf(labelState('provider-alpha', 'Alpha One')).text === 'AOne'
  && colorOf('provider-alpha', { groups: ['provider-alpha'], current: { provider: 'provider-alpha' } }) !== '#7CB342')

/* ── S8：级联模型选择门禁（selectionFor / cascadePlacementFor / ────────── */
/*        providerIndexByPrefix / providerRowsOf / faceOf.select）           */

const groupX = { id: 'provider-alpha', name: 'Alpha One' }
const modelX = { id: 'model-x', name: 'Model X', reasoning: { defaultEffort: 'high' } }
const modelPlain = { id: 'model-plain', name: 'Plain' }

check('S8 selectionFor 换模型用 defaultEffort', (() => {
  const sel = selectionFor(groupX, modelX, { provider: 'provider-beta', model: 'model-y' })
  return sel.provider === 'provider-alpha' && sel.model === 'model-x' && sel.reasoningEffort === 'high'
})())
check('S8 selectionFor 同模型保留 current.reasoningEffort', (() => {
  const sel = selectionFor(groupX, modelX, { provider: 'provider-alpha', model: 'model-x', reasoningEffort: 'low' })
  return sel.reasoningEffort === 'low'
})())
check('S8 selectionFor 同模型但 current 无 effort → defaultEffort', (() => {
  const sel = selectionFor(groupX, modelX, { provider: 'provider-alpha', model: 'model-x' })
  return sel.reasoningEffort === 'high'
})())
check('S8 selectionFor 无 reasoning 不带 effort 字段', (() => {
  const sel = selectionFor(groupX, modelPlain, { provider: 'provider-alpha', model: 'model-x' })
  return !('reasoningEffort' in sel) && sel.provider === 'provider-alpha' && sel.model === 'model-plain'
})())

const VP = { width: 800, height: 600, clientWidth: 800 }
// provider 列宽与 client.js 的 CASCADE_PROVIDER_WIDTH 同值：200 → 260
// （三窗口额度文案 "5h 6% · 7d 36% · 30d 59%" 约 25 字符）。
const PROVIDER_WIDTH = 260
const MODEL_WIDTH = 236
check('S8 cascade 右侧充足：模型列在 provider 右侧、贴锚点', (() => {
  const pos = cascadePlacementFor({ left: 100, right: 160, top: 300, bottom: 316 }, VP)
  const providerRight = pos.left + pos.providerWidth
  const modelLeft = providerRight + 6
  return pos.left === 100 && pos.flipped === false
    && pos.providerWidth === PROVIDER_WIDTH && pos.modelWidth === MODEL_WIDTH
    && pos.totalWidth === PROVIDER_WIDTH + 6 + MODEL_WIDTH
    && modelLeft > providerRight && modelLeft + pos.modelWidth <= 800 - 8
})())
check('S8 cascade 右侧不足、左侧足 → 模型列翻转到 provider 左侧（C-3）', (() => {
  const pos = cascadePlacementFor({ left: 600, right: 660, top: 300, bottom: 316 }, VP)
  // 翻转：容器右缘对齐徽标右缘 660，渲染序 [模型][provider]（row-reverse）。
  return pos.flipped === true
    && pos.left === 660 - pos.totalWidth
    && pos.providerWidth === PROVIDER_WIDTH && pos.modelWidth === MODEL_WIDTH
    && pos.left + pos.totalWidth === 660
    && pos.left + pos.totalWidth <= 800 - 8
})())
check('S8 cascade clientWidth 口径：clamp 用滚动条内宽度，右缘不探入滚动条', (() => {
  // innerWidth 800、clientWidth 783（竖向滚动条 17px）、徽标右缘 790：
  // 翻转 clamp 后右缘必须 = 783-8，而旧 innerWidth 口径会算出 790。
  const pos = cascadePlacementFor({ left: 600, right: 790, top: 300, bottom: 316 }, { width: 800, height: 600, clientWidth: 783 })
  return pos.flipped === true
    && pos.left === 783 - 8 - pos.totalWidth
    && pos.left + pos.totalWidth <= 783 - 8
})())
check('S8 cascade 两侧都放不下：不翻转、整体左移收窄夹取', (() => {
  const pos = cascadePlacementFor({ left: 100, right: 460, top: 300, bottom: 316 }, { width: 500, height: 600, clientWidth: 500 })
  return pos.flipped === false && pos.left === 8
    && pos.totalWidth <= 500 - 8 - 8 + 1e-9
    && pos.providerWidth + 6 + pos.modelWidth === pos.totalWidth
})())
check('S8 cascade 极窄视口 → provider 收窄到下限、模型取剩余', (() => {
  const pos = cascadePlacementFor({ left: 0, right: 60, top: 300, bottom: 316 }, { width: 260, height: 600, clientWidth: 260 })
  return pos.left === 8
    && pos.providerWidth >= 132
    && pos.modelWidth >= 0
    && pos.totalWidth <= 260 - 8 - 8 + 1e-9
    && pos.providerWidth + 6 + pos.modelWidth === pos.totalWidth
})())
check('S8 cascade 单列（色板/无模型）：不翻转且 modelWidth 为 0', (() => {
  const pos = cascadePlacementFor({ left: 600, right: 660, top: 300, bottom: 316 }, VP, PROVIDER_WIDTH, 0, 6, 340)
  return pos.flipped === false && pos.modelWidth === 0 && pos.totalWidth === PROVIDER_WIDTH
    && pos.left >= 8 && pos.left + pos.totalWidth <= 800 - 8
})())
check('S8 cascade 垂直：下方空间足 → 锚点下方', (() => {
  return cascadePlacementFor({ left: 100, top: 40, bottom: 56 }, VP).top === 62
})())
check('S8 cascade 垂直：下方不足 → 翻到锚点上方', (() => {
  return cascadePlacementFor({ left: 100, top: 560, bottom: 576 }, VP).top === 560 - 6 - 340
})())
check('S8 cascade 缺 rect → 安全回退不抛、列宽默认', (() => {
  const pos = cascadePlacementFor(null, VP)
  return typeof pos.left === 'number' && typeof pos.top === 'number'
    && typeof pos.totalWidth === 'number' && pos.providerWidth === PROVIDER_WIDTH && pos.modelWidth === MODEL_WIDTH
})())
check('S8 cascade 无视口 → 不抛且列宽默认', (() => {
  const pos = cascadePlacementFor({ left: 10, top: 10, bottom: 26 }, undefined)
  return pos.providerWidth === PROVIDER_WIDTH && pos.modelWidth === MODEL_WIDTH && pos.left === 10
})())
check('S8 cascade 视口过矮 → 预留高度收缩到视口内（超长列表尾部可达）', (() => {
  const pos = cascadePlacementFor({ left: 100, right: 160, top: 300, bottom: 316 }, { width: 800, height: 300, clientWidth: 800 })
  return pos.panelMaxHeight === 300 - 16
    && pos.top >= 8 && pos.top + pos.panelMaxHeight <= 300 - 8
})())
check('S8 cascade 正常视口 → 预留高度保持 340 上限', (() => {
  const pos = cascadePlacementFor({ left: 100, right: 160, top: 300, bottom: 316 }, VP)
  return pos.panelMaxHeight === 340
})())

const pRows = [
  { id: 'provider-alpha', name: 'Alpha One' },
  { id: 'provider-beta', name: 'Beta Two' },
  { id: 'provider-gamma', name: 'Gamma' },
]
check('S8 providerIndexByPrefix 按 name 首字母', providerIndexByPrefix(pRows, 'b', -1) === 1)
check('S8 providerIndexByPrefix 大小写不敏感', providerIndexByPrefix(pRows, 'B', -1) === 1)
check('S8 providerIndexByPrefix name 未命中回退 id', providerIndexByPrefix(pRows, 'g', -1) === 2)
check('S8 providerIndexByPrefix 从当前索引循环', providerIndexByPrefix(pRows, 'a', 2) === 0)
check('S8 providerIndexByPrefix 多匹配取循环内下一项', (() => {
  const rows = [{ id: 'a1', name: 'Alpha' }, { id: 'a2', name: 'Alpha' }, { id: 'a3', name: 'Alpha' }]
  return providerIndexByPrefix(rows, 'a', 0) === 1 && providerIndexByPrefix(rows, 'a', 2) === 0
})())
check('S8 providerIndexByPrefix 跳过 disabled 行', (() => {
  const rows = [{ id: 'a1', name: 'Alpha', disabled: true }, { id: 'a2', name: 'Alpha' }]
  return providerIndexByPrefix(rows, 'a', -1) === 1
})())
check('S8 providerIndexByPrefix 无匹配 → -1', providerIndexByPrefix(pRows, 'z', -1) === -1)

check('S8 providerRowsOf 成功行保持目录顺序', (() => {
  const rows = providerRowsOf({ groups: [{ id: 'b', name: 'Bee', models: [{ id: 'm1' }] }, { id: 'a', name: 'Ay', models: [{ id: 'm2' }] }] })
  return rows.length === 2 && rows[0].id === 'b' && rows[1].id === 'a'
    && rows[0].disabled === false && rows[0].failure === false
})())
check('S8 providerRowsOf 空 models 行 disabled', (() => {
  const rows = providerRowsOf({ groups: [{ id: 'a', name: 'Ay', models: [] }] })
  return rows.length === 1 && rows[0].disabled === true
})())
check('S8 providerRowsOf failures 追加为 disabled', (() => {
  const rows = providerRowsOf({ groups: [{ id: 'a', name: 'Ay', models: [{ id: 'm' }] }], failures: [{ id: 'dead', name: 'Dead', message: 'boom' }] })
  return rows.length === 2 && rows[1].id === 'dead' && rows[1].disabled === true
    && rows[1].failure === true && rows[1].message === 'boom'
})())
check('S8 providerRowsOf 空目录 → []', providerRowsOf(null).length === 0 && providerRowsOf({}).length === 0)
check('S8 nextEnabledIndex 跳过 disabled 与空 models 行', (() => {
  const rows = [{ id: 'a', models: [] }, { id: 'b', models: [{ id: 'm' }] }, { id: 'c', models: [{ id: 'n' }] }]
  return nextEnabledIndex(rows, -1, 1) === 1 && nextEnabledIndex(rows, 1, 1) === 2
})())

check('S8 faceOf.select 代理同一 directory.select', (() => {
  const before = selectCalls.length
  face.select({ provider: 'provider-alpha', model: 'model-x' })
  return selectCalls.length === before + 1 && selectCalls[selectCalls.length - 1].model === 'model-x'
})())
await (async () => {
  const res = await face.select({ provider: 'provider-alpha', model: 'model-x' })
  check('S8 faceOf.select 成功 result.ok !== false', res !== null && res.ok !== false)
})()
await (async () => {
  const noSelectCtx = makeCtx({ sessions: plainSessions, models: { directoryFor: () => ({ store: fakeStore }) } })
  const f = faceOf(noSelectCtx, 's1')
  const res = await f.select({ provider: 'x', model: 'y' })
  check('S8 faceOf 缺 select → ok:false select/unavailable', res.ok === false && res.error.code === 'select/unavailable')
})()
check('S8 faceOf 目录异常 → UNAVAILABLE 无 select', !('select' in faceOf(throwCtx, 's1')))

/* ── S8b：弹层内滚动不关闭（shouldCloseOnScroll + 源码形状） ─────────── */

const hitNode = (selector) => ({ closest: (sel) => (sel === selector ? {} : null) })
check('S8b shouldCloseOnScroll 弹层内 → false', shouldCloseOnScroll(hitNode('[data-provider-badge-cascade], [data-provider-badge-root]')) === false)
check('S8b shouldCloseOnScroll 徽标 root 内 → false', (() => {
  const node = { parent: true, closest: (sel) => (sel.includes('[data-provider-badge-root]') ? { tag: 'root' } : null) }
  return shouldCloseOnScroll(node) === false
})())
check('S8b shouldCloseOnScroll document（无 closest）→ true', shouldCloseOnScroll({ documentElement: {} }) === true)
check('S8b shouldCloseOnScroll null → true', shouldCloseOnScroll(null) === true && shouldCloseOnScroll(undefined) === true)
check('S8b shouldCloseOnScroll closest 抛错 → true', shouldCloseOnScroll({ closest: () => { throw new Error('boom') } }) === true)

check('S8b 源码：scroll 监听使用 shouldCloseOnScroll', /window\.addEventListener\(\s*["']scroll["']\s*,\s*closeOnScroll\s*,\s*true\s*\)/.test(source)
  && /shouldCloseOnScroll\(\s*target\s*\)/.test(source))
check('S8b 源码：PANEL_BASE_STYLE 含 overscrollBehavior contain', (() => {
  const m = source.match(/PANEL_BASE_STYLE\s*=\s*\{([\s\S]*?)\n\s*\};/)
  return m !== null && /overscrollBehavior\s*:\s*["']contain["']/.test(m[1])
})())
check('S8b 源码：面板仍为 maxHeight + overflowY auto', (() => {
  const m = source.match(/PANEL_BASE_STYLE\s*=\s*\{([\s\S]*?)\n\s*\};/)
  return m !== null && /maxHeight\s*:/.test(m[1]) && /overflowY\s*:\s*["']auto["']/.test(m[1])
})())

/* ── S10：OpenAI Codex 官方额度（宿主端点 → provider 行内文案） ────── */

check('S10 端点路径与宿主半一致', QUOTA_ENDPOINT === '/provider-badge/quota')
check('S10 客户端 TTL 短于宿主上游缓存窗口', QUOTA_CLIENT_TTL_MS > 0 && QUOTA_CLIENT_TTL_MS < 60000)

check('S10 formatWindowSpan 按时长成标签（不按 primary/secondary 角色）',
  formatWindowSpan(18000) === '5h' && formatWindowSpan(604800) === '7d'
  && formatWindowSpan(3600) === '1h' && formatWindowSpan(1800) === '30m' && formatWindowSpan(90) === '90s')
check('S10 formatWindowSpan 非法 → null', formatWindowSpan(0) === null && formatWindowSpan(-5) === null
  && formatWindowSpan('18000') === null && formatWindowSpan(NaN) === null && formatWindowSpan(null) === null)
check('S10 formatCountdown 短文案', formatCountdown(13363) === '3h42m' && formatCountdown(455917) === '5d6h'
  && formatCountdown(59) === '1m' && formatCountdown(0) === '1m' && formatCountdown('x') === null)

const quotaEntry = {
  ok: true,
  plan: 'plus',
  limitReached: false,
  credits: { hasCredits: false, unlimited: false, balance: '0' },
  fetchedAt: 1792206238452,
  windows: [
    { windowSeconds: 604800, usedPercent: 35, resetsAt: 1792662162, resetAfterSeconds: 455917 },
    { windowSeconds: 18000, usedPercent: 4, resetsAt: 1792219608, resetAfterSeconds: 13363 },
  ],
}

check('S10 窗口按时长升序（乱序输入也 5h 在前）', (() => {
  const labels = quotaWindowsOf(quotaEntry).map((w) => w.label)
  return labels.length === 2 && labels[0] === '5h' && labels[1] === '7d'
})())
check('S10 quotaInlineTextOf 追加最紧窗口的重置倒计时', (() => {
  const text = quotaInlineTextOf(quotaEntry)
  return typeof text === 'string' && text.startsWith('5h 4% · 7d 35% · 重置 ')
})())
check('S10 quotaInlineTextOf 无重置字段时保持百分比文案', quotaInlineTextOf({ ok: true, windows: [{ windowSeconds: 18000, usedPercent: 4 }] }) === '5h 4%')
check('S10 quotaInlineTextOf 只选最短剩余时间', quotaInlineTextOf({ ok: true, windows: [
  { windowSeconds: 18000, usedPercent: 4, resetAfterSeconds: 7200 },
  { windowSeconds: 604800, usedPercent: 35, resetAfterSeconds: 3600 },
] }) === '5h 4% · 7d 35% · 重置 1h')
check('S10 quotaTextOf 单窗口', quotaTextOf({ ok: true, windows: [{ windowSeconds: 18000, usedPercent: 4 }] }) === '5h 4%')
check('S10 quotaTextOf 百分比取整', quotaTextOf({ ok: true, windows: [{ windowSeconds: 18000, usedPercent: 4.6 }] }) === '5h 5%')
check('S10 不可用条目不伪造百分比', quotaTextOf(null) === null && quotaTextOf({ ok: false, reason: 'token-expired' }) === null
  && quotaTextOf({ ok: true, windows: [] }) === null && quotaTextOf({ ok: true }) === null)
check('S10 认证失败给出重新登录提示', quotaFailureOf({ ok: false, reason: 'http-401' }).text === '额度需登录'
  && quotaFailureOf({ ok: false, reason: 'token-expired' }).title.includes('重新登录'))
check('S10 未配置和其它失败给出脱敏状态', quotaFailureOf({ ok: false, reason: 'not-configured' }).text === '额度未配置'
  && quotaFailureOf({ ok: false, reason: 'network', message: 'secret detail' }).title === '额度服务暂时不可用'
  && quotaFailureOf({ ok: true }) === null)
check('S10 缺字段窗口被丢弃（不编造百分比）', quotaTextOf({ ok: true, windows: [{ usedPercent: 4 }, { windowSeconds: 18000 }] }) === null)
check('S10 百分比夹取 [0,100]', quotaTextOf({ ok: true, windows: [{ windowSeconds: 18000, usedPercent: 180 }] }) === '5h 100%'
  && quotaTextOf({ ok: true, windows: [{ windowSeconds: 18000, usedPercent: -2 }] }) === '5h 0%')
check('S10 quotaToneOf 分级', quotaToneOf(quotaEntry) === 'normal'
  && quotaToneOf({ ok: true, windows: [{ windowSeconds: 18000, usedPercent: 75 }] }) === 'warn'
  && quotaToneOf({ ok: true, windows: [{ windowSeconds: 18000, usedPercent: 95 }] }) === 'danger'
  && quotaToneOf({ ok: true, limitReached: true, windows: [{ windowSeconds: 18000, usedPercent: 1 }] }) === 'danger'
  && quotaToneOf(null) === null && quotaToneOf({ ok: false }) === null)
check('S10 只按最紧的窗口定级（两窗口互不掩盖）',
  quotaToneOf({ ok: true, windows: [{ windowSeconds: 18000, usedPercent: 2 }, { windowSeconds: 604800, usedPercent: 99 }] }) === 'danger')
check('S10 quotaTitleOf 含用量/倒计时/套餐', (() => {
  const title = quotaTitleOf(quotaEntry)
  return typeof title === 'string' && title.includes('5h 已用 4%') && title.includes('7d 已用 35%')
    && title.includes('后重置') && title.includes('套餐 plus')
})())
check('S10 quotaTitleOf 有额外余额才提示余额', (() => {
  const withCredits = quotaTitleOf({ ...quotaEntry, credits: { hasCredits: true, balance: '12.5' } })
  return withCredits.includes('余额 12.5') && !quotaTitleOf(quotaEntry).includes('余额')
})())
check('S10 色调表：normal 不指定颜色（走继承）',
  QUOTA_TONES.normal === null && typeof QUOTA_TONES.warn === 'string' && typeof QUOTA_TONES.danger === 'string')

/* Kimi 型条目：无套餐名、无余额、只有绝对重置时刻、7 天窗口已用满。 */
// 重置时刻统一留 30s 余量：倒计时按「Math.round(剩余秒数)」分桶，若正好落在
// 整点边界（3600 - ε 会舍入成 3599 → "59m"）断言就会偶发失败。
const nowSeconds = Math.floor(Date.now() / 1000)
const kimiQuotaEntry = {
  ok: true,
  plan: null,
  limitReached: true,
  credits: null,
  fetchedAt: 1,
  windows: [
    { windowSeconds: 604800, usedPercent: 100, resetsAt: nowSeconds + 5 * 86400 + 30, resetAfterSeconds: null },
    { windowSeconds: 18000, usedPercent: 0, resetsAt: nowSeconds + 3600 + 30, resetAfterSeconds: null },
  ],
}

check('S10 Kimi 型条目文案与 Codex 同形', quotaTextOf(kimiQuotaEntry) === '5h 0% · 7d 100%')
check('S10 Kimi 型条目窗口按时长升序', quotaWindowsOf(kimiQuotaEntry).map((w) => w.label).join(',') === '5h,7d')
check('S10 Kimi 型条目无套餐名时不出现「套餐」段', (() => {
  const title = quotaTitleOf(kimiQuotaEntry)
  return typeof title === 'string' && title.includes('5h 已用 0%') && title.includes('7d 已用 100%')
    && !title.includes('套餐') && !title.includes('余额')
})())
check('S10 Kimi 型条目只有绝对时刻也能算倒计时', (() => {
  const title = quotaTitleOf(kimiQuotaEntry)
  return typeof title === 'string' && /1h后重置/.test(title) && /5d后重置/.test(title)
})())
check('S10 Kimi 型 limitReached → danger 色调（上限由宿主推导）', quotaToneOf(kimiQuotaEntry) === 'danger')

/* OpenCode Go 型条目：三窗口（rolling/weekly/monthly → 5h/7d/30d），无套餐名无余额。 */
const opencodeQuotaEntry = {
  ok: true,
  plan: null,
  limitReached: false,
  credits: null,
  fetchedAt: 1,
  windows: [
    { windowSeconds: 2592000, usedPercent: 59, resetsAt: nowSeconds + 3 * 86400 + 30, resetAfterSeconds: null },
    { windowSeconds: 18000, usedPercent: 6, resetsAt: nowSeconds + 3600 + 30, resetAfterSeconds: null },
    { windowSeconds: 604800, usedPercent: 36, resetsAt: nowSeconds + 2 * 86400 + 30, resetAfterSeconds: null },
  ],
}

check('S10 三窗口条目文案（客户端零改动即支持 5h · 7d · 30d）',
  quotaTextOf(opencodeQuotaEntry) === '5h 6% · 7d 36% · 30d 59%')
check('S10 三窗口按时长升序（乱序输入）', quotaWindowsOf(opencodeQuotaEntry).map((w) => w.label).join(',') === '5h,7d,30d')
check('S10 三窗口按最紧的窗口定级（月度 95% → danger）', quotaToneOf({
  ok: true,
  windows: [
    { windowSeconds: 18000, usedPercent: 6 },
    { windowSeconds: 604800, usedPercent: 36 },
    { windowSeconds: 2592000, usedPercent: 95 },
  ],
}) === 'danger')
check('S10 三窗口悬停说明逐窗口带倒计时且无套餐段', (() => {
  const title = quotaTitleOf(opencodeQuotaEntry)
  return typeof title === 'string' && title.includes('5h 已用 6%') && title.includes('7d 已用 36%')
    && title.includes('30d 已用 59%') && (title.match(/后重置/g) || []).length === 3
    && !title.includes('套餐')
})())
check('S10 30 天窗口标签为 30d（不是 4w / 720h）', formatWindowSpan(2592000) === '30d')

/* Kimi 账单口径（Extra Usage）：钱，只进悬停说明，不进徽标行文本。 */
const kimiExtra = {
  totalCents: 15000,
  balanceCents: 3277,
  monthlyUsedCents: 0,
  monthlyChargeLimitCents: 0,
  monthlyChargeLimitEnabled: false,
  currency: 'CNY',
  status: 'STATUS_DISABLED',
}
check('S10 formatMoney 常见币种与回退', formatMoney(3277, 'CNY') === '¥32.77' && formatMoney(0, 'USD') === '$0.00'
  && formatMoney(1234, 'XYZ') === '12.34 XYZ' && formatMoney(1234, undefined) === '$12.34'
  && formatMoney('12', 'CNY') === null && formatMoney(null, 'CNY') === null && formatMoney(NaN, 'CNY') === null)
check('S10 extraUsageParts 三段（上限未启用 → Unlimited，且钱包停用被标注）', (() => {
  const parts = extraUsageParts(kimiExtra)
  return parts.length === 3 && parts[0] === '本月已用 ¥0.00' && parts[1] === '月度上限 Unlimited'
    && parts[2] === '加购余额 ¥32.77（钱包已停用 STATUS_DISABLED）'
})())
check('S10 extraUsageParts 上限启用 → 显示金额；ACTIVE 不标注', (() => {
  const parts = extraUsageParts({ ...kimiExtra, monthlyChargeLimitEnabled: true, monthlyChargeLimitCents: 5000, status: 'STATUS_ACTIVE' })
  return parts.join(' · ') === '本月已用 ¥0.00 · 月度上限 ¥50.00 · 加购余额 ¥32.77'
})())
check('S10 extraUsageParts 未知状态原样标注', extraUsageParts({ ...kimiExtra, status: 'STATUS_FROZEN' })[2]
  === '加购余额 ¥32.77（钱包状态 STATUS_FROZEN）')
check('S10 extraUsageParts 缺字段 → 空数组（不显示空段）', extraUsageParts(null).length === 0
  && extraUsageParts(undefined).length === 0 && extraUsageParts('x').length === 0)
check('S10 extraUsageParts 缺 cents 时跳过对应段', (() => {
  const parts = extraUsageParts({ currency: 'CNY', monthlyChargeLimitEnabled: false })
  return parts.length === 1 && parts[0] === '月度上限 Unlimited'
})())
check('S10 Kimi 悬停说明追加账单段（徽标行文本不变）', (() => {
  const withExtra = { ...kimiQuotaEntry, extraUsage: kimiExtra }
  const title = quotaTitleOf(withExtra)
  return title.includes('7d 已用 100%') && title.includes('本月已用 ¥0.00')
    && title.includes('月度上限 Unlimited') && title.includes('加购余额 ¥32.77（钱包已停用 STATUS_DISABLED）')
    && quotaTextOf(withExtra) === '5h 0% · 7d 100%'
})())
check('S10 无 extraUsage 时说明里不出现账单段（向后兼容）', !quotaTitleOf(kimiQuotaEntry).includes('本月已用'))
check('S10 只有 extraUsage 没有窗口 → 仍不渲染（title null）',
  quotaTitleOf({ ok: true, extraUsage: kimiExtra, windows: [] }) === null)
check('S10 货币符号表覆盖常见币种', CURRENCY_SYMBOLS.CNY === '¥' && CURRENCY_SYMBOLS.USD === '$'
  && CURRENCY_SYMBOLS.EUR === '€' && CURRENCY_SYMBOLS.GBP === '£')

/* ── S10b：级联渲染（播种「级联已打开」+ 额度缓存命中） ─────────────── */

const quotaRenderState = {
  status: 'ready',
  current: { provider: 'openai-codex', model: 'gpt-5.6-sol' },
  groups: [
    { id: 'openai-codex', name: 'gpt（official）', models: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }] },
    { id: 'ais-2dsglm', name: 'AIS 2DSGLM', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }] },
  ],
}
const quotaRenderStore = { subscribe: () => () => {}, getSnapshot: () => quotaRenderState }
const openCascadeSeed = () => ({
  left: 0,
  top: 0,
  totalWidth: PROVIDER_WIDTH + 6 + MODEL_WIDTH,
  providerWidth: PROVIDER_WIDTH,
  modelWidth: MODEL_WIDTH,
})
/** 组件内 useState 调用序：0 overrides / 1 colorMode / 2 cascade / 3 activeProviderId /
 *  4 focusLevel / 5 providerIndex / 6 modelIndex / 7 localError / 8 pendingSelection /
 *  9 quotaRoutes。序号变化时下面的「播种生效」断言会直接失败。 */
const CASCADE_HOOK_INDEX = 2
const ACTIVE_PROVIDER_HOOK_INDEX = 3

const panelsOf = (node) => {
  if (node === null || node === undefined || node.props === undefined) return []
  if (!Array.isArray(node.props.children)) return []
  return node.props.children.filter((child) => child !== null && child !== undefined
    && child.props !== undefined && child.props.role === 'listbox')
}
const rowsOfPanel = (panel) => {
  if (panel === undefined || panel.props === undefined || !Array.isArray(panel.props.children)) return []
  const first = panel.props.children[0]
  return Array.isArray(first) ? first : []
}
const rowOfId = (rows, id) => rows.find((row) => row !== null && row !== undefined
  && row.props !== undefined && row.props['data-provider-row'] === id)
const quotaSpanOfRow = (row) => {
  if (row === undefined || !Array.isArray(row.props.children)) return undefined
  return row.props.children.find((child) => child !== null && child !== undefined
    && child.props !== undefined && child.props['data-provider-badge-quota'] !== undefined)
}
/** 渲染一次「级联已打开」的组件，返回 provider 列的行数组。 */
const renderOpenCascade = () => {
  stateSeeds.set(CASCADE_HOOK_INDEX, openCascadeSeed())
  const render = renderComponent({ store: quotaRenderStore, load: () => {} })
  stateSeeds.clear()
  const panels = panelsOf(Array.isArray(render) ? render[1] : null)
  return { panels, rows: rowsOfPanel(panels[0]) }
}

quotaCache.routes = { 'openai-codex': quotaEntry }
quotaCache.at = Date.now()
stateSeeds.set(ACTIVE_PROVIDER_HOOK_INDEX, 'openai-codex')
const openRender = renderOpenCascade()
stateSeeds.clear()

check('S10b 播种生效：级联打开且 provider/model 两列就位', openRender.panels.length === 2)
check('S10b provider 列含两行 + 选色入口，额度状态按缓存就位',
  openRender.rows.length === 3 && rowOfId(openRender.rows, 'openai-codex') !== undefined
  && rowOfId(openRender.rows, 'ais-2dsglm') !== undefined)

const codexRow = rowOfId(openRender.rows, 'openai-codex')
const codexQuota = quotaSpanOfRow(codexRow)
const quotaTextOfSpan = (span) => {
  if (span === undefined || span.props === undefined) return null
  const kids = span.props.children
  return Array.isArray(kids) ? kids.join('') : kids
}
check('S10b openai-codex 行右侧渲染额度文案与重置倒计时', codexQuota !== undefined
  && quotaTextOfSpan(codexQuota).startsWith('5h 4% · 7d 35% · 重置 '))
check('S10b 额度字号小于行文本、不换行不参与收缩', codexQuota !== undefined
  && codexQuota.props.style.fontSize === '10px' && codexQuota.props.style.whiteSpace === 'nowrap'
  && codexQuota.props.style.flex === 'none' && codexQuota.props.style.marginLeft === '8px')
check('S10b 额度悬停说明带重置与套餐', codexQuota !== undefined && typeof codexQuota.props.title === 'string'
  && codexQuota.props.title.includes('7d 已用 35%') && codexQuota.props.title.includes('套餐 plus'))
check('S10b 未报告额度的行不渲染额度', quotaSpanOfRow(rowOfId(openRender.rows, 'ais-2dsglm')) === undefined)
check('S10b 额度 span 位于 name 之后、trailing 之前', (() => {
  if (codexRow === undefined) return false
  const kids = codexRow.props.children
  if (!Array.isArray(kids)) return false
  const nameIndex = kids.findIndex((c) => c !== null && c !== undefined && c.props !== undefined && c.props.key === 'name')
  const quotaIndex = kids.findIndex((c) => c !== null && c !== undefined && c.props !== undefined && c.props.key === 'quota')
  const symIndex = kids.findIndex((c) => c !== null && c !== undefined && c.props !== undefined && c.props.key === 'sym')
  return nameIndex >= 0 && quotaIndex === nameIndex + 1 && symIndex === quotaIndex + 1
})())
check('S10b 名称列可压缩（minWidth 0 + flex + ellipsis）给额度让位', (() => {
  if (codexRow === undefined) return false
  const name = codexRow.props.children.find((c) => c !== null && c !== undefined && c.props !== undefined && c.props.key === 'name')
  return name !== undefined && name.props.style.minWidth === 0
    && name.props.style.flex === '1 1 auto' && name.props.style.textOverflow === 'ellipsis'
})())

check('S10b 危险用量走 danger 色调', (() => {
  quotaCache.routes = { 'openai-codex': { ok: true, plan: 'plus', limitReached: false, windows: [{ windowSeconds: 18000, usedPercent: 97 }] } }
  quotaCache.at = Date.now()
  const { rows } = renderOpenCascade()
  const span = quotaSpanOfRow(rowOfId(rows, 'openai-codex'))
  return span !== undefined && span.props.style.color === QUOTA_TONES.danger && span.props.style.opacity === 1
})())

check('S10b 无额度缓存时不渲染任何额度 span', (() => {
  quotaCache.routes = null
  quotaCache.at = 0
  const { rows } = renderOpenCascade()
  return quotaSpanOfRow(rowOfId(rows, 'openai-codex')) === undefined
})())

check('S10b ok:false 认证失败保留可操作状态', (() => {
  quotaCache.routes = { 'openai-codex': { ok: false, reason: 'token-expired' } }
  quotaCache.at = Date.now()
  const { rows } = renderOpenCascade()
  const span = quotaSpanOfRow(rowOfId(rows, 'openai-codex'))
  return span !== undefined && quotaTextOfSpan(span) === '额度需登录'
    && span.props.title.includes('重新登录') && span.props.style.color === QUOTA_TONES.warn
})())

check('S10b Kimi 行同样渲染（本半按行 id 命中，不认识具体 provider）', (() => {
  quotaRenderState.groups.push({ id: 'kimi-coding', name: 'Kimi (official)', models: [{ id: 'kimi-k2', name: 'Kimi K2' }] })
  quotaCache.routes = { 'openai-codex': quotaEntry, 'kimi-coding': kimiQuotaEntry }
  quotaCache.at = Date.now()
  const { rows } = renderOpenCascade()
  const span = quotaSpanOfRow(rowOfId(rows, 'kimi-coding'))
  const text = quotaTextOfSpan(span)
  const title = span !== undefined ? span.props.title : null
  quotaRenderState.groups.pop()
  return rows.length === 4 && typeof text === 'string' && text.startsWith('5h 0% · 7d 100% · 重置 ')
    && span !== undefined && span.props.style.color === QUOTA_TONES.danger
    && typeof title === 'string' && title.includes('7d 已用 100%') && !title.includes('套餐')
})())

check('S10b OpenCode Go 行渲染三窗口（provider 列 260px）', (() => {
  quotaRenderState.groups.push({ id: 'opencode-go', name: 'OpenCode Go', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }] })
  quotaCache.routes = { 'opencode-go': opencodeQuotaEntry }
  quotaCache.at = Date.now()
  const { rows } = renderOpenCascade()
  const span = quotaSpanOfRow(rowOfId(rows, 'opencode-go'))
  const text = quotaTextOfSpan(span)
  quotaRenderState.groups.pop()
  return rows.length === 4 && typeof text === 'string' && text.startsWith('5h 6% · 7d 36% · 30d 59% · 重置 ')
    && span !== undefined && span.props.style.flex === 'none'
    && typeof span.props.title === 'string' && span.props.title.includes('30d 已用 59%')
})())

check('S10b 端点键为本机真实 id（opencodego）时该行渲染额度', (() => {
  quotaRenderState.groups.push({ id: 'opencodego', name: 'OpenCode Go', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }] })
  quotaCache.routes = { opencodego: opencodeQuotaEntry }
  quotaCache.at = Date.now()
  const { rows } = renderOpenCascade()
  const span = quotaSpanOfRow(rowOfId(rows, 'opencodego'))
  const text = quotaTextOfSpan(span)
  quotaRenderState.groups.pop()
  return typeof text === 'string' && text.startsWith('5h 6% · 7d 36% · 30d 59% · 重置 ')
    && span !== undefined && typeof span.props.title === 'string' && span.props.title.includes('30d 已用 59%')
})())

check('S10b 端点只给规范名（opencode-go）时本机 opencodego 行仍渲染（别名兜底）', (() => {
  quotaRenderState.groups.push({ id: 'opencodego', name: 'OpenCode Go', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }] })
  quotaCache.routes = { 'opencode-go': opencodeQuotaEntry }
  quotaCache.at = Date.now()
  const { rows } = renderOpenCascade()
  const span = quotaSpanOfRow(rowOfId(rows, 'opencodego'))
  const text = quotaTextOfSpan(span)
  quotaRenderState.groups.pop()
  return typeof text === 'string' && text.startsWith('5h 6% · 7d 36% · 30d 59%')
    && span !== undefined && span.props.style.flex === 'none'
})())

check('S10b 别名为真实 id 时不影响其它行（opencode-go 行照旧渲染）', (() => {
  quotaRenderState.groups.push({ id: 'opencode-go', name: 'OpenCode Go', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }] })
  quotaCache.routes = { opencodego: opencodeQuotaEntry }
  quotaCache.at = Date.now()
  const { rows } = renderOpenCascade()
  const span = quotaSpanOfRow(rowOfId(rows, 'opencode-go'))
  const text = quotaTextOfSpan(span)
  quotaRenderState.groups.pop()
  return typeof text === 'string' && text.startsWith('5h 6% · 7d 36%')
})())

quotaCache.routes = null
quotaCache.at = 0

check('S10b 源码：级联打开时才请求额度端点，端点整体不可达时静默', /fetch\(\s*QUOTA_ENDPOINT/.test(source)
  && /if \(!cascadeOpen\) return undefined;/.test(source))
check('S10b 源码：额度不写 settings/不碰凭据（客户端半零凭据引用）',
  !/credentials/.test(source) && !/localStorage\.setItem\(\s*["']dsh-plugin-provider-badge:quota/.test(source))

/* ── 汇总 ─────────────────────────────────────────────────────────── */

console.log('')
if (failed > 0) {
  console.error(`FAILED: ${failed} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`ALL PASSED (${passed} checks)`)
