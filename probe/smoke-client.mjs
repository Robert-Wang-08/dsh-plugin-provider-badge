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
check('S9 require 白名单 = react', requires.length > 0 && requires.every((r) => r === 'react'), requires.join(', '))

for (const file of ['client.js', 'index.js']) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { cwd: root, stdio: 'pipe' })
    check(`S9 node --check ${file}`, true)
  } catch (e) {
    check(`S9 node --check ${file}`, false, String(e.stderr || e.message))
  }
}

/* ── 载入模块（假 window.__ModuleLoader__ + 假 react） ──────────────── */

let captured = null
const sandbox = {
  window: { __ModuleLoader__: { load: (mod) => { captured = mod } } },
}
vm.createContext(sandbox)
new vm.Script(source, { filename: 'client.js' }).runInContext(sandbox)

check('S9 load 捕获到注册', captured !== null && captured.id === pkg.name)

const hookIdentity = (fn) => fn
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useMemo: (fn) => fn(),
  useEffect: hookIdentity,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
const exports_ = captured.factory((name) => {
  if (name !== 'react') throw new Error(`unexpected require: ${name}`)
  return fakeReact
})

check('exports.inject 权限清单正确', JSON.stringify(exports_.inject) === JSON.stringify(['slots', 'sessions', 'modelDirectories', 'remote', 'remote.session']))
check('exports.__test 探针面就位', exports_.__test !== undefined && typeof exports_.apply === 'function')

const { fourLetters, deriveLetters, colorOf, hash32, PALETTE, wheelDist, hueSlotsFor, routeIdsOf, badgeOf, faceOf, UNAVAILABLE } = exports_.__test

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

/* ── S5 v2：颜色推导（12 槽调色板 + 可见集合均匀铺槽） ─────────────── */

check('S5 调色板 12 槽且格式合法', PALETTE.length === 12 && PALETTE.every((c) => /^hsl\(\d+, \d+%, \d+%\)$/.test(c)))
check('S5 蓝段槽位 ≤ 2（218/248）', PALETTE.filter((c) => { const h = Number(c.match(/hsl\((\d+),/)[1]); return h >= 210 && h <= 255 }).length === 2)

const KNOWN_ROUTES = ['provider-alpha', 'provider-beta', 'provider-gamma-one', 'provider-gamma-two', 'provider-delta', 'provider-echo']
const slotMap = hueSlotsFor(KNOWN_ROUTES)
const slots6 = KNOWN_ROUTES.map((r) => slotMap.get(r))
check('S5 已知 6 路由槽位互不相同', new Set(slots6).size === KNOWN_ROUTES.length, JSON.stringify(KNOWN_ROUTES.map((r, i) => `${r}:${slots6[i]}`)))
check('S5 两两轮盘距离 ≥ 2 槽（60°）', (() => {
  for (let i = 0; i < slots6.length; i++) for (let j = i + 1; j < slots6.length; j++) if (wheelDist(slots6[i], slots6[j]) < 2) return false
  return true
})())
check('S5 同前缀对 provider-gamma-one/provider-gamma-two 距离 ≥ 2 槽', wheelDist(slotMap.get('provider-gamma-one'), slotMap.get('provider-gamma-two')) >= 2)
check('S5 蓝段占用的路由 ≤ 2', slots6.filter((s) => s >= 6 && s <= 8).length <= 2, JSON.stringify(slots6))
check('S5 分配确定性', JSON.stringify([...hueSlotsFor(KNOWN_ROUTES)]) === JSON.stringify([...slotMap]))
check('S5 colorOf 落在调色板内且稳定', PALETTE.includes(colorOf('provider-alpha', { groups: KNOWN_ROUTES.map((id) => ({ id })), current: { provider: 'provider-alpha' } })))
check('S5 routeIdsOf 提取 groups+current 并去重', (() => {
  const ids = routeIdsOf({ groups: [{ id: 'b' }, { id: 'a' }], current: { provider: 'a' } })
  return JSON.stringify(ids) === JSON.stringify(['b', 'a'])
})())
check('S5 空集合安全', hueSlotsFor([]).size === 0 && hueSlotsFor(['x', 42]).size === 1)

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
const rendered = registration.component({ store: renderStore, load: () => {} })
const childText = Array.isArray(rendered?.props?.children) ? rendered.props.children.join('') : rendered?.props?.children
check('渲染：徽标 span + 4 字母文本 + title + 调色板底色',
  rendered !== null && rendered.type === 'span'
  && childText === 'AOne'
  && rendered.props.title === 'Alpha One (provider-alpha)'
  && rendered.props.style.background === colorOf('provider-alpha', renderState)
  && PALETTE.includes(rendered.props.style.background)
  && rendered.props.style.fontWeight === 700
  && rendered.props.style.height === '16px')
check('渲染：数据缺失 → null', registration.component(UNAVAILABLE) === null)
check('渲染：store 快照为空 → null', registration.component({ store: { subscribe: () => () => {}, getSnapshot: () => ({ current: null }) } }) === null)

/* ── 汇总 ─────────────────────────────────────────────────────────── */

console.log('')
if (failed > 0) {
  console.error(`FAILED: ${failed} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`ALL PASSED (${passed} checks)`)
