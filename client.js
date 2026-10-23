/**
 * dsh-plugin-provider-badge — 客户端半（client.js）
 *
 * 在会话输入框下方工具行的 `conversation.input.right` 席位（list、session
 * 作用域、官方零占用）注册一个纯展示条目，渲染在模型席位
 * （`conversation.input.model`，模型名 + 推理等级）正前方：
 *
 *   [AGLM] my-model ▾   ···   [发送]
 *    ↑
 *    └ provider 徽标（4 字母：多词取各词首字母，不足补尾字母；黑体 +
 *      按底色对比度选字色；有表路由用固定色，其余走可见集合均匀铺槽调色板）。
 *      选色入口移到级联面板一级底部「徽标颜色…」动作，徽标本身只开级联。
 *
 * - 文本：ROUTE_LABELS 缩写表精确命中优先（可超 4 字符）；未入表路由按
 *   provider 显示名（Host 目录 groups[].name）优选推导，缺失回退路由 id
 *   同规则；仅字母数字，不含符号/括号/减号。
 * - 颜色：用户可选 ROUTE_COLORS 表优先；未入表路由走 12 槽调色板（刻意
 *   只留 2 个蓝段），按可见 provider 集合均匀铺槽（排序第 i 落
 *   floor(i×12/n)）；字色白字优先，白字对比度 < 3 时改深墨 #14212B。
 * - 数据：官方共享目录 store（ctx.modelDirectories），useSyncExternalStore
 *   订阅，会话切换模型/路由即时跟随；仅 status==="idle" 时触发一次官方
 *   load()（官方自带去重）。
 * - 级联：点徽标（或 Enter/Space/方向键）打开两级级联菜单：一级只列
 *   provider（成功行 + 失败 disabled 行），悬停/首字母选中 provider 后
 *   二级列该 provider 的模型（模型列默认在右侧；徽标贴近右缘、右侧放不下
 *   完整两列而左侧放得下时**翻转到 provider 左侧**，见 cascadePlacementFor；
 *   两侧都放不下时整体左移并收窄）。弹层经 react-dom createPortal 挂
 *   document.body（脱离 composer 子树，规避祖先 transform/overflow 劫持
 *   position:fixed 包含块；宿主缺 react-dom 时内联渲染降级），定位只在打开
 *   时按常量预留计算一次（垂直 340 上限、水平两列总宽 + clientWidth），
 *   打开后不再重排——悬停引起的高度变化不搬动弹层，避免抖动回路。选择复用
 *   同一 ModelDirectory.select（官方同口径 selectionOf），失败保持菜单并
 *   显示 localError。官方 /model 弹窗与 composer 模型席位零改变。
 * - 降级：modelDirectories 未装载 / directoryFor 抛错 / subagent 转址会话 /
 *   无当前选择 → 渲染 null，不报错不占位。
 *
 * 唯一写入：点 swatch 选色写浏览器 localStorage（key 见 STORAGE_KEY，按路由
 * id，可恢复为自动配色）；不写 settings、不持凭据、不发起任何变更类请求；
 * 模型切换仅经官方共享目录 select。不反映运行期故障转移重路由（与官方模型
 * 席位同口径，反映会话选择）。
 *
 * 交付形状是硬契约：dsh 把每个插件的 client.js 当 classic script 拼进单个
 * /plugins 响应执行 —— 本文件必须保持 CJS + window.__ModuleLoader__.load
 * 包装，不得出现模块级 import/export（先例：dsh-deepseek-keypool/client.js）。
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-provider-badge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require("react");
    const h = react.createElement;
    const useSyncExternalStore = react.useSyncExternalStore;
    const useMemo = react.useMemo;
    const useEffect = react.useEffect;
    const useState = react.useState;
    const useRef = react.useRef;
    // portal 载体：加载器静态模块表含 react-dom（dsh-web-frontend staticModules
    // 的 require 白名单里有 "react-dom"）。缺失或异常时 cascade 内联渲染降级
    // （行为同旧版，接受祖先 transform/overflow 劫持 fixed 包含块的风险）。
    let createPortal = null;
    try {
      const reactDom = require("react-dom");
      if (reactDom !== null && typeof reactDom === "object" && typeof reactDom.createPortal === "function") {
        createPortal = reactDom.createPortal;
      }
    } catch (_) { /* 老 host：无 react-dom → 降级内联渲染 */ }

    /* ── 纯函数：文本与颜色推导（S4/S5 v2，probe 直接断言） ───────────── */

    /**
     * 文本（v2，4 字母）：切词规则 = 非字母数字序列是边界，且**汉字段与
     * 拉丁/数字段的交界也是词边界**（"智谱GLM" = 智谱 + GLM 两个词）；先取
     * 各词首字符；不足 4 个时从最后一个词起、按阅读顺序用词内后续字符补齐
     * （等价于"首字母不够补尾字母"）；天然不含符号/括号/减号。显示名与
     * 路由 id 都推导，取更长者（≥4 优先显示名）。
     */
    function fourLetters(raw) {
      if (typeof raw !== "string") return null;
      const tokens = raw.match(/\p{sc=Han}+|[\p{L}\p{N}]+/gu);
      if (tokens === null || tokens.length === 0) return null;
      const out = [];
      for (const token of tokens) out.push(token[0]);
      for (let ti = tokens.length - 1; ti >= 0 && out.length < 4; ti--) {
        for (let ci = 1; ci < tokens[ti].length && out.length < 4; ci++) out.push(tokens[ti][ci]);
      }
      return out.length === 0 ? null : out.slice(0, 4).join("");
    }

    function deriveLetters(displayName, routeId) {
      const fromName = fourLetters(displayName);
      const fromId = fourLetters(routeId);
      if (fromName !== null && (fromName.length >= 4 || fromId === null || fromId.length <= fromName.length)) return fromName;
      return fromId;
    }

    /** FNV-1a 32 位稳定哈希。 */
    function hash32(raw) {
      const s = String(raw);
      let x = 2166136261;
      for (let i = 0; i < s.length; i++) {
        x ^= s.charCodeAt(i);
        x = Math.imul(x, 16777619);
      }
      return x >>> 0;
    }

    /**
     * 用户可选路由色表（唯一改色入口）：DSH provider 路由 id → 底色。
     * 未出现在本表的路由仍走下方 12 槽自动调色板。
     */
    const ROUTE_COLORS = {
      "anthropic-relay": "#E0501E", // opus，默认路由：橙红
      "codex-relay": "#2F6FEB", // 蓝
      "ais-2dsglm": "#8ECDF7", // 浅蓝
      "openai-codex": "#2E9E5B", // 绿（codex office）
      "kimi-coding": "#A7E0A9", // 浅绿
      "opencode-go": "#7CB342", // 草绿
    };

    /**
     * 用户可选路由缩写表（唯一改名入口）：DSH provider 路由 id → 徽标文字。
     * 未出现在本表的路由仍按显示名/路由 id 自动推导 4 字母缩写。
     */
    const ROUTE_LABELS = {
      "deepseek-official": "ds官", // deepseek 官方
      "codex-relay": "a1gpt",
      "openai-codex": "gpt官", // codex office（官方）
      "anthropic-relay": "claude", // claude relay（opus）
      "opencode-go": "opengo",
      "kimi-coding": "kimi官",
    };

    /**
     * 路由别名表：同一家 provider 在不同设备/profile 里 id 不同（本机 OpenCode Go
     * 注册为 `opencodego`，上游与另一台设备写 `opencode-go`）。查 Color/Label 表与
     * 额度条目时先按原 id 精确命中，未命中再按别名归一化的 id 兜一次，避免命名
     * 差异导致丢色、丢缩写、丢额度。
     */
    const ROUTE_ALIASES = Object.freeze({ opencodego: "opencode-go" });

    /** 路由 id → 别名归一化后的 id；未入表原样返回，非字符串/空 → null。 */
    function canonicalRouteId(routeId) {
      if (typeof routeId !== "string" || routeId.length === 0) return null;
      return Object.prototype.hasOwnProperty.call(ROUTE_ALIASES, routeId) ? ROUTE_ALIASES[routeId] : routeId;
    }

    /**
     * 查表（ROUTE_COLORS / ROUTE_LABELS / 额度整表）：原 id 精确优先，未命中再按别名。
     * @param table - 普通对象（不是 Map）。
     * @param routeId - provider 路由 id。
     * @returns 命中的值或 null。
     */
    function aliasLookup(table, routeId) {
      if (table === null || typeof table !== "object") return null;
      if (Object.prototype.hasOwnProperty.call(table, routeId)) return table[routeId];
      const canonical = canonicalRouteId(routeId);
      if (canonical !== null && Object.prototype.hasOwnProperty.call(table, canonical)) return table[canonical];
      return null;
    }

    /**
     * 额度整表取值：原 id 精确 → 别名归一化 → 反向别名（表里的键是别名、行 id 是
     * 规范名时也要能命中；两台设备可能各报一个名字）。
     * @param routes - 宿主返回的 `routes` 整表（可空）。
     * @param routeId - 行 id。
     * @returns 条目或 null。
     */
    function quotaEntryFor(routes, routeId) {
      const direct = aliasLookup(routes, routeId);
      if (direct !== null) return direct;
      if (routes === null || typeof routes !== "object") return null;
      const canonical = canonicalRouteId(routeId);
      if (canonical === null) return null;
      for (const key of Object.keys(routes)) {
        if (canonicalRouteId(key) === canonical) return routes[key];
      }
      return null;
    }

    /* ── 常用模型快捷按钮：常量（唯一改默认值入口） ──────────────────── */

    /** 槽位上限（= 默认条数）。改这里即可增减按钮数量上限。 */
    const QUICK_MAX_SLOTS = 6;

    /** localStorage 持久化键：常用模型绑定数组（JSON）。 */
    const QUICK_STORAGE_KEY = "dsh-plugin-provider-badge:quick-models";

    /** 默认 6 个常用模型绑定（用户指定初始值）。 */
    const DEFAULT_QUICK_MODELS = [
      { provider: "ais-2dsglm", model: "deepseek-v4.1-flash" },
      { provider: "ais-2dsglm", model: "glm-5.3-flash" },
      { provider: "codex-relay", model: "gpt-6.1-sol" },
      { provider: "opencodego", model: "deepseek-v4.1-flash" },
      { provider: "openai-codex", model: "gpt-6.1-sol" },
      { provider: "kimi-coding", model: "k3-256k" },
    ];

    /** localStorage 持久化键：路由 id → 用户所选底色（JSON 对象）。 */
    const STORAGE_KEY = "dsh-plugin-provider-badge:colors";

    /* ── 额度：宿主端点 + 文案纯函数（probe 直接断言） ─────────────────── */

    /**
     * 额度端点（宿主半）。整表取回形如
     * `{ ok, updatedAt, routes: { <routeId>: <entry> } }`；条目不可用时
     * `entry.ok === false`，宿主不解释原因，浏览器半一律不渲染。
     */
    const QUOTA_ENDPOINT = "/provider-badge/quota";

    /** 客户端缓存窗口：小于宿主的 60s 上游缓存窗口，重开菜单时最多补一次请求。 */
    const QUOTA_CLIENT_TTL_MS = 25000;

    /**
     * 模块级额度缓存：重开菜单、多实例复用同一份数据，避免每次点开都打一次
     * 端点。`at` 是客户端取到数据的时刻（不是服务端 updatedAt），只用于 TTL。
     */
    const quotaCache = { at: 0, routes: null };

    /** 用量色调：只按「最紧的那个窗口」定级，避免两个窗口互相掩盖。 */
    const QUOTA_TONES = { normal: null, warn: "#ffcf7a", danger: "#ff9b9b" };

    /**
     * 秒数 → 窗口标签。按**时长**判定，不按上游 primary/secondary 角色：
     * 角色与「5 小时 / 7 天」的对应关系会变，时长不会。18000→"5h"、
     * 604800→"7d"、3600→"1h"、1800→"30m"；非正数/非数值 → null。
     */
    function formatWindowSpan(seconds) {
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
      const total = Math.round(seconds);
      if (total % 86400 === 0) return String(total / 86400) + "d";
      if (total % 3600 === 0) return String(total / 3600) + "h";
      if (total % 60 === 0) return String(total / 60) + "m";
      return String(total) + "s";
    }

    /** 秒数 → 倒计时短文案（"2d3h" / "3h42m" / "12m"）；非数值 → null。 */
    function formatCountdown(seconds) {
      if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
      let rest = Math.max(0, Math.round(seconds));
      const days = Math.floor(rest / 86400); rest -= days * 86400;
      const hours = Math.floor(rest / 3600); rest -= hours * 3600;
      const minutes = Math.floor(rest / 60);
      if (days > 0) return hours > 0 ? days + "d" + hours + "h" : days + "d";
      if (hours > 0) return minutes > 0 ? hours + "h" + minutes + "m" : hours + "h";
      return Math.max(1, minutes) + "m";
    }

    /**
     * 额度条目 → 窗口列表（按时长升序，5h 在 7d 前）。
     * 条目不可用、缺字段、时长无法成标签的一律丢弃：宁可不显示，也不拿不完整
     * 的数据凑一个百分比。
     * @param entry - 宿主返回的条目。
     * @returns [{ label, usedPercent, windowSeconds, resetsAt, resetAfterSeconds }]。
     */
    function quotaWindowsOf(entry) {
      if (entry === null || typeof entry !== "object" || entry.ok !== true) return [];
      const list = Array.isArray(entry.windows) ? entry.windows : [];
      const out = [];
      for (const raw of list) {
        if (raw === null || typeof raw !== "object") continue;
        const used = typeof raw.usedPercent === "number" && Number.isFinite(raw.usedPercent) ? raw.usedPercent : null;
        const label = formatWindowSpan(raw.windowSeconds);
        if (used === null || label === null) continue;
        out.push({
          label,
          usedPercent: Math.min(100, Math.max(0, used)),
          windowSeconds: raw.windowSeconds,
          resetsAt: typeof raw.resetsAt === "number" && raw.resetsAt > 0 ? raw.resetsAt : null,
          resetAfterSeconds: typeof raw.resetAfterSeconds === "number" && raw.resetAfterSeconds >= 0 ? raw.resetAfterSeconds : null,
        });
      }
      out.sort((a, b) => a.windowSeconds - b.windowSeconds);
      return out;
    }

    /** 额度条目 → 行内文案（"5h 4% · 7d 35%"）；无可用窗口 → null。 */
    function quotaTextOf(entry) {
      const windows = quotaWindowsOf(entry);
      if (windows.length === 0) return null;
      return windows.map((w) => w.label + " " + Math.round(w.usedPercent) + "%").join(" · ");
    }

    /**
     * 不可用条目 → 用户可操作的短状态。服务端只回归一化 reason，不带上游响应体，
     * 因此这里不会把令牌或账号信息带进界面。
     */
    function quotaFailureOf(entry) {
      if (entry === null || typeof entry !== "object" || entry.ok !== false) return null;
      const reason = typeof entry.reason === "string" ? entry.reason : "";
      if (reason === "http-401" || reason === "token-expired") {
        return { text: "额度需登录", title: "额度凭据已失效，请重新登录对应 provider" };
      }
      if (reason === "not-configured") {
        return { text: "额度未配置", title: "未找到该 provider 的额度凭据" };
      }
      if (reason === "http-403") {
        return { text: "额度不可用", title: "凭据无权读取当前套餐额度" };
      }
      return { text: "额度不可用", title: "额度服务暂时不可用" };
    }

    /**
     * 额度条目 → 行内文案（百分比 + 最紧窗口的剩余重置时间）。
     * 保留 `quotaTextOf` 的纯百分比契约；只有真实行渲染使用这个更完整的版本，
     * 这样现有 title/测试与其它调用方仍保持稳定，同时避免三窗口全部展开导致列过宽。
     */
    function quotaInlineTextOf(entry) {
      const windows = quotaWindowsOf(entry);
      if (windows.length === 0) return null;
      const text = windows.map((w) => w.label + " " + Math.round(w.usedPercent) + "%").join(" · ");
      const nowSeconds = Date.now() / 1000;
      let shortest = null;
      for (const w of windows) {
        const remaining = w.resetsAt !== null
          ? w.resetsAt - nowSeconds
          : (w.resetAfterSeconds !== null ? w.resetAfterSeconds : null);
        if (typeof remaining !== "number" || !Number.isFinite(remaining)) continue;
        if (shortest === null || remaining < shortest) shortest = remaining;
      }
      const countdown = shortest === null ? null : formatCountdown(shortest);
      return countdown === null ? text : text + " · 重置 " + countdown;
    }

    /**
     * 分 → 金额文案。符号表照抄常见口径，表外货币回退 "12.34 XYZ" 形式；
     * cents 非数值 → null（不显示这一段）。
     */
    const CURRENCY_SYMBOLS = { CNY: "¥", USD: "$", EUR: "€", GBP: "£", JPY: "¥" };
    function formatMoney(cents, currency) {
      if (typeof cents !== "number" || !Number.isFinite(cents)) return null;
      const code = typeof currency === "string" && currency.length > 0 ? currency : "USD";
      const amount = (cents / 100).toFixed(2);
      const symbol = CURRENCY_SYMBOLS[code];
      return typeof symbol === "string" ? symbol + amount : amount + " " + code;
    }

    /**
     * 账单口径（Extra Usage）→ 悬停说明片段数组。
     * Kimi 的「月度」维度是钱不是用量窗口：`本月已用 ¥x · 月度上限 ¥y|Unlimited ·
     * 加购余额 ¥z`。钱包状态非 STATUS_ACTIVE 时追加标注（CLI 忽略 status，本插件
     * 不忽略：本机 `STATUS_DISABLED` 的余额若不加标注会被当成可用余额）。
     * @param raw - 宿主条目里的 `extraUsage`。
     * @returns 片段数组（可能为空）。
     */
    function extraUsageParts(raw) {
      if (raw === null || typeof raw !== "object") return [];
      const currency = typeof raw.currency === "string" && raw.currency.length > 0 ? raw.currency : "USD";
      const parts = [];
      const used = formatMoney(raw.monthlyUsedCents, currency);
      if (used !== null) parts.push("本月已用 " + used);
      if (raw.monthlyChargeLimitEnabled === true && typeof raw.monthlyChargeLimitCents === "number") {
        const limit = formatMoney(raw.monthlyChargeLimitCents, currency);
        parts.push("月度上限 " + (limit !== null ? limit : "Unlimited"));
      } else {
        parts.push("月度上限 Unlimited");
      }
      let balance = formatMoney(raw.balanceCents, currency);
      if (balance !== null) {
        const status = typeof raw.status === "string" && raw.status.length > 0 ? raw.status : null;
        if (status !== null && status !== "STATUS_ACTIVE") {
          balance += "（" + (status === "STATUS_DISABLED" ? "钱包已停用 " : "钱包状态 ") + status + "）";
        }
        parts.push("加购余额 " + balance);
      }
      return parts;
    }

    /** 额度条目 → 悬停说明（窗口用量 + 重置倒计时 + 套餐 + 余额 + 账单）；无窗口 → null。 */
    function quotaTitleOf(entry) {
      const windows = quotaWindowsOf(entry);
      if (windows.length === 0) return null;
      const nowSeconds = Date.now() / 1000;
      const parts = windows.map((w) => {
        const remaining = w.resetsAt !== null
          ? formatCountdown(w.resetsAt - nowSeconds)
          : (w.resetAfterSeconds !== null ? formatCountdown(w.resetAfterSeconds) : null);
        const head = w.label + " 已用 " + Math.round(w.usedPercent) + "%";
        return remaining !== null ? head + "，" + remaining + "后重置" : head;
      });
      if (typeof entry.plan === "string" && entry.plan.length > 0) parts.push("套餐 " + entry.plan);
      const credits = entry.credits !== null && typeof entry.credits === "object" ? entry.credits : null;
      if (credits !== null && credits.hasCredits === true) {
        parts.push(typeof credits.balance === "string" && credits.balance.length > 0 ? "余额 " + credits.balance : "有额外余额");
      }
      for (const part of extraUsageParts(entry.extraUsage)) parts.push(part);
      return parts.join(" · ");
    }

    /** 额度条目 → 色调（"normal" / "warn" / "danger"）；无可用窗口 → null。 */
    function quotaToneOf(entry) {
      const windows = quotaWindowsOf(entry);
      if (windows.length === 0) return null;
      let worst = 0;
      for (const w of windows) worst = Math.max(worst, w.usedPercent);
      if (entry.limitReached === true || worst >= 90) return "danger";
      if (worst >= 70) return "warn";
      return "normal";
    }

    /**
     * 调色板（v2）：12 个色相槽均匀铺轮、刻意只留 2 个蓝段（218/248），并配
     * 不同的饱和/明度；槽间由分配算法保证距离。字色由 inkFor 按底色对比度选。
     */
    const PALETTE = [
      "hsl(0, 62%, 46%)",
      "hsl(28, 85%, 46%)",
      "hsl(52, 90%, 38%)",
      "hsl(95, 55%, 34%)",
      "hsl(140, 55%, 36%)",
      "hsl(168, 65%, 32%)",
      "hsl(195, 75%, 38%)",
      "hsl(218, 70%, 46%)",
      "hsl(248, 55%, 48%)",
      "hsl(278, 55%, 44%)",
      "hsl(308, 60%, 42%)",
      "hsl(338, 70%, 42%)",
    ];

    const INK_WHITE = "#fff";
    const INK_DARK = "#14212B";

    /**
     * 白字对比度下限：白字对比度 ≥ 此值就用白字，保住本插件“黑体白字”的既有
     * 观感；低于此值（浅蓝/浅绿/草绿一类的浅底）才改用深墨。
     */
    const MIN_WHITE_CONTRAST = 3;

    /**
     * 解析 `#rgb` / `#rrggbb` 或 `hsl(h, s%, l%)` → { r, g, b }（0–1）。
     * 无法解析返回 null。
     */
    function parseColor(raw) {
      if (typeof raw !== "string") return null;
      const s = raw.trim();
      const hex = s.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
      if (hex !== null) {
        let h = hex[1];
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        return {
          r: parseInt(h.slice(0, 2), 16) / 255,
          g: parseInt(h.slice(2, 4), 16) / 255,
          b: parseInt(h.slice(4, 6), 16) / 255,
        };
      }
      const hsl = s.match(/^hsl\(\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)%\s*,\s*([+-]?\d+(?:\.\d+)?)%\s*\)$/i);
      if (hsl !== null) {
        let h = Number(hsl[1]) % 360;
        if (h < 0) h += 360;
        const sat = Math.max(0, Math.min(100, Number(hsl[2]))) / 100;
        const lit = Math.max(0, Math.min(100, Number(hsl[3]))) / 100;
        const c = (1 - Math.abs(2 * lit - 1)) * sat;
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        const m = lit - c / 2;
        let rp = 0;
        let gp = 0;
        let bp = 0;
        if (h < 60) { rp = c; gp = x; }
        else if (h < 120) { rp = x; gp = c; }
        else if (h < 180) { gp = c; bp = x; }
        else if (h < 240) { gp = x; bp = c; }
        else if (h < 300) { rp = x; bp = c; }
        else { rp = c; bp = x; }
        return { r: rp + m, g: gp + m, b: bp + m };
      }
      return null;
    }

    /** WCAG 相对亮度（输入通道已是 0–1 sRGB）。 */
    function relativeLuminance(rgb) {
      const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
      return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
    }

    function contrastRatio(L1, L2) {
      const lighter = Math.max(L1, L2);
      const darker = Math.min(L1, L2);
      return (lighter + 0.05) / (darker + 0.05);
    }

    /**
     * 为底色挑选字色：白字优先（对比度 ≥ MIN_WHITE_CONTRAST），白字不够时才
     * 改用深墨 #14212B。无法解析的颜色安全回退为白。
     */
    function inkFor(background) {
      const bg = parseColor(background);
      if (bg === null) return INK_WHITE;
      const Lbg = relativeLuminance(bg);
      const cWhite = contrastRatio(Lbg, 1);
      if (cWhite >= MIN_WHITE_CONTRAST) return INK_WHITE;
      const cDark = contrastRatio(Lbg, relativeLuminance(parseColor(INK_DARK)));
      return cDark > cWhite ? INK_DARK : INK_WHITE;
    }

    /** 12 槽轮盘上的距离（槽为单位）。 */
    function wheelDist(a, b) {
      const d = Math.abs(a - b);
      return Math.min(d, 12 - d);
    }

    /**
     * 颜色分配（v2）：对可见 provider 集合（排序去重）做**均匀铺槽**——
     * 第 i 个 id 落 floor(i×12/n) 槽，槽距下界 = floor(12/n)（n≤6 时 ≥2 槽
     * 即 60°），从机制上排除"相邻相近色"，直接回应"减少相近蓝色/同前缀
     * 模型难分辨"。代价：集合增减时颜色重排（provider 集合很少变）。
     */
    function hueSlotsFor(ids) {
      const unique = [...new Set([...ids].filter((id) => typeof id === "string" && id.length > 0))].sort();
      const assigned = new Map();
      const n = unique.length;
      for (let i = 0; i < n; i++) assigned.set(unique[i], Math.floor((i * PALETTE.length) / n) % PALETTE.length);
      return assigned;
    }

    /** 快照里的全部 provider id（groups ∪ 当前选择）。 */
    function routeIdsOf(state) {
      const ids = [];
      if (state !== null && typeof state === "object" && Array.isArray(state.groups)) {
        for (const g of state.groups) {
          if (g !== null && typeof g === "object" && typeof g.id === "string") ids.push(g.id);
        }
      }
      if (state !== null && typeof state === "object" && state.current !== null && typeof state.current === "object"
        && typeof state.current.provider === "string" && !ids.includes(state.current.provider)) {
        ids.push(state.current.provider);
      }
      return ids;
    }

    /**
     * 路由 id → 底色：ROUTE_COLORS 精确命中优先；否则可见集合均匀铺槽 /
     * 哈希回退调色板（未入表路由的槽位分配不变）。
     */
    function colorOf(routeId, state) {
      const tabled = typeof routeId === "string" ? aliasLookup(ROUTE_COLORS, routeId) : null;
      if (tabled !== null) return tabled;
      const slots = hueSlotsFor(routeIdsOf(state));
      const slot = slots.get(routeId);
      return PALETTE[slot !== undefined ? slot : hash32(routeId) % PALETTE.length];
    }

    /**
     * 读取用户选色（localStorage JSON 对象）。存储不可用或 JSON 损坏 → {}，
     * 静默降级为默认表/自动调色板；非法颜色条目被剔除。
     * @returns 路由 id → 合法 CSS 颜色串的映射。
     */
    function loadOverrides() {
      try {
        if (typeof localStorage === "undefined" || localStorage === null) return {};
        const raw = localStorage.getItem(STORAGE_KEY);
        if (typeof raw !== "string" || raw.length === 0) return {};
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const out = {};
        for (const key of Object.keys(parsed)) {
          if (typeof parsed[key] === "string" && parseColor(parsed[key]) !== null) out[key] = parsed[key];
        }
        return out;
      } catch (_) {
        return {};
      }
    }

    /**
     * 落盘用户选色；存储不可用/写失败时静默忽略（内存态仍生效到本次渲染）。
     * @param map - 完整路由 id → 颜色映射。
     */
    function saveOverrides(map) {
      try {
        if (typeof localStorage === "undefined" || localStorage === null) return;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
      } catch (_) { /* 隐私模式等：本次会话的内存覆盖仍有效 */ }
    }

    /* ── 纯函数：常用模型快捷按钮（配置归一化 + 状态解析） ───────────── */

    /** 按钮文案截断上限。 */
    const QUICK_LABEL_MAX = 10;

    /** 模型 id 常见前缀（推导按钮文案时剥掉，避免窄按钮被前缀占满）。 */
    const QUICK_LABEL_PREFIXES = ["deepseek-", "gpt-", "glm-", "kimi-", "claude-"];

    /**
     * 按钮文案：显式 `label` 优先；否则由模型 id 去掉常见前缀后截断到 10 字符。
     * @param entry - 配置项（可含 label/provider/model）。
     * @returns 文案或 null。
     */
    function quickLabelOf(entry) {
      if (entry === null || typeof entry !== "object") return null;
      if (typeof entry.label === "string" && entry.label.length > 0) return entry.label;
      const modelId = typeof entry.model === "string" ? entry.model : "";
      if (modelId.length === 0) return null;
      let text = modelId;
      for (const prefix of QUICK_LABEL_PREFIXES) {
        if (text.startsWith(prefix) && text.length > prefix.length) { text = text.slice(prefix.length); break; }
      }
      return text.length > QUICK_LABEL_MAX ? text.slice(0, QUICK_LABEL_MAX) : text;
    }

    /**
     * 配置数组归一化：剔除非法项（provider/model 必须非空字符串）、截断槽位上限。
     * 非数组或全被剔除 → null（调用方据此回退默认）。
     * @param raw - localStorage 读出的原始值。
     * @returns 归一化数组或 null。
     */
    function normalizeQuickModels(raw) {
      if (Array.isArray(raw) !== true) return null;
      const out = [];
      for (const item of raw) {
        if (item === null || typeof item !== "object") continue;
        const provider = typeof item.provider === "string" ? item.provider.trim() : "";
        const model = typeof item.model === "string" ? item.model.trim() : "";
        if (provider.length === 0 || model.length === 0) continue;
        const label = typeof item.label === "string" && item.label.trim().length > 0 ? item.label.trim() : null;
        out.push({ provider, model, label });
        if (out.length >= QUICK_MAX_SLOTS) break;
      }
      return out.length > 0 ? out : null;
    }

    /** 默认绑定的深拷贝（调用方可安全改写，不污染常量）。 */
    function defaultQuickModels() {
      return DEFAULT_QUICK_MODELS.map((entry) => ({ provider: entry.provider, model: entry.model, label: null }));
    }

    /**
     * 读取用户配置：存储不可用 / JSON 损坏 / 归一化后为空 → 回退默认。
     * @returns 绑定数组（至少 1 项）。
     */
    function loadQuickModels() {
      try {
        if (typeof localStorage === "undefined" || localStorage === null) return defaultQuickModels();
        const raw = localStorage.getItem(QUICK_STORAGE_KEY);
        if (typeof raw !== "string" || raw.length === 0) return defaultQuickModels();
        const normalized = normalizeQuickModels(JSON.parse(raw));
        return normalized !== null ? normalized : defaultQuickModels();
      } catch (_) {
        return defaultQuickModels();
      }
    }

    /**
     * 落盘用户配置；归一化后为空时删除键（回到默认）。写失败静默忽略。
     * @param list - 绑定数组。
     */
    function saveQuickModels(list) {
      try {
        if (typeof localStorage === "undefined" || localStorage === null) return;
        const normalized = normalizeQuickModels(list);
        if (normalized === null) localStorage.removeItem(QUICK_STORAGE_KEY);
        else localStorage.setItem(QUICK_STORAGE_KEY, JSON.stringify(normalized));
      } catch (_) { /* 隐私模式等：本次会话的内存态仍生效 */ }
    }

    /**
     * 配置项 → 渲染与点击所需状态（纯函数，probe 直接断言）。
     * 目录行先按 provider 精确匹配，未命中再按 `canonicalRouteId` 别名归一化匹配
     * （本机 `opencodego` ↔ 通用 `opencode-go`）；返回的 `providerId` 恒为目录里的
     * 真实 id —— 提交给官方 select 的必须是目录 id，不是配置里的写法。
     * 判定：provider 缺失或目录未就绪 → disabled；provider 在而模型不在 → **仍可点**，
     * 因为目录快照可能滞后于上游，且 select 自身会给出失败原因。
     * @param entry - 配置项 {provider, model, label?}。
     * @param state - 目录快照。
     * @returns { group, providerId, modelId, model, label, active, providerMissing,
     *   modelFound, ready, disabled, title }。
     */
    function quickStatusOf(entry, state) {
      const binding = entry !== null && typeof entry === "object" ? entry : {};
      const wanted = typeof binding.provider === "string" ? binding.provider : "";
      const modelId = typeof binding.model === "string" ? binding.model : "";
      const groups = state !== null && typeof state === "object" && Array.isArray(state.groups) ? state.groups : [];
      const wantedCanonical = canonicalRouteId(wanted);
      let group;
      for (const row of groups) {
        if (row === null || typeof row !== "object" || typeof row.id !== "string") continue;
        if (row.id === wanted) { group = row; break; }
        if (wantedCanonical !== null && canonicalRouteId(row.id) === wantedCanonical) { group = row; break; }
      }
      const status = state !== null && typeof state === "object" && typeof state.status === "string"
        ? state.status : "idle";
      const ready = status === "ready" || status === "selecting";
      const providerId = group !== undefined && typeof group.id === "string" && group.id.length > 0
        ? group.id : wanted;
      const models = group !== undefined && Array.isArray(group.models) ? group.models : [];
      const model = models.find((row) => row !== null && typeof row === "object" && row.id === modelId);
      const current = state !== null && typeof state === "object"
        && state.current !== null && typeof state.current === "object" ? state.current : null;
      const active = current !== null && current.provider === providerId && current.model === modelId;
      const providerMissing = group === undefined;
      const providerName = group !== undefined && typeof group.name === "string" && group.name.length > 0
        ? group.name : providerId;
      const modelName = model !== undefined && typeof model.name === "string" && model.name.length > 0
        ? model.name : modelId;
      let title = "常用模型：" + providerName + " / " + modelName;
      if (!ready) title += "（模型目录尚未就绪）";
      else if (providerMissing) title += "（该 provider 不在当前目录）";
      else if (model === undefined) title += "（该模型不在目录中，点击仍会尝试切换）";
      return {
        group,
        providerId,
        modelId,
        model,
        label: quickLabelOf(binding),
        active,
        providerMissing,
        modelFound: model !== undefined,
        ready,
        disabled: !ready || providerMissing,
        title,
      };
    }

    /**
     * 生效底色优先级：用户覆盖 > ROUTE_COLORS 默认表 > 可见集合自动调色板。
     * @param routeId - provider 路由 id。
     * @param state - 目录快照（自动调色板需要可见集合）。
     * @param overrides - 用户所选色映射（可空）。
     * @returns CSS 颜色串。
     */
    function resolveColor(routeId, state, overrides) {
      if (typeof routeId === "string"
        && overrides !== null && typeof overrides === "object"
        && Object.prototype.hasOwnProperty.call(overrides, routeId)) {
        const picked = overrides[routeId];
        if (typeof picked === "string" && parseColor(picked) !== null) return picked;
      }
      return colorOf(routeId, state);
    }

    /** 选色面板候选色：用户默认六色在前，补 12 槽调色板其余色（去重保序）。 */
    function swatchColors() {
      const seen = new Set();
      const out = [];
      for (const color of Object.values(ROUTE_COLORS)) {
        if (!seen.has(color)) { seen.add(color); out.push(color); }
      }
      for (const color of PALETTE) {
        if (!seen.has(color)) { seen.add(color); out.push(color); }
      }
      return out;
    }

    /**
     * 计算选色面板的视口位置：优先锚点下方，空间不足则翻到上方，并在视口内夹取。
     * @param anchor - 徽标的视口矩形，至少包含 left、top、bottom。
     * @param viewport - 当前视口宽高。
     * @returns fixed 定位使用的 left/top 坐标。
     */
    function panelPositionFor(anchor, viewport) {
      const margin = 8;
      const panelWidth = 176;
      const panelHeight = 116;
      const leftAnchor = anchor !== null && typeof anchor === "object" && typeof anchor.left === "number"
        ? anchor.left : 0;
      const topAnchor = anchor !== null && typeof anchor === "object" && typeof anchor.top === "number"
        ? anchor.top : 0;
      const bottomAnchor = anchor !== null && typeof anchor === "object" && typeof anchor.bottom === "number"
        ? anchor.bottom : topAnchor;
      const width = viewport !== null && typeof viewport === "object" && typeof viewport.width === "number"
        ? viewport.width : 0;
      const height = viewport !== null && typeof viewport === "object" && typeof viewport.height === "number"
        ? viewport.height : 0;
      const below = bottomAnchor + 6;
      const above = topAnchor - 6 - panelHeight;
      let top;
      if (height > 0 && below + panelHeight <= height - margin) top = below;
      else if (height > 0 && above >= margin) top = above;
      else if (height > 0) top = Math.max(margin, height - panelHeight - margin);
      else top = below;
      const left = width > 0
        ? Math.max(margin, Math.min(leftAnchor, width - panelWidth - margin))
        : leftAnchor;
      return { left, top };
    }

    /* ── 纯函数：级联模型选择（spec §3，probe 直接断言） ──────────────── */

    /**
     * 官方同口径 selection（复刻 dsh-client-ui-model-selection selectionOf）：
     * 同一 provider/model 保留 current.reasoningEffort，否则用
     * model.reasoning.defaultEffort；effort 为 undefined 时不带字段。
     * @param group - ModelProviderGroup（至少 id）。
     * @param model - 模型项（至少 id；可选 reasoning.defaultEffort）。
     * @param current - 当前 ModelSelection（可空）。
     * @returns ModelSelection。
     */
    function selectionFor(group, model, current) {
      const provider = group !== null && typeof group === "object" ? group.id : undefined;
      const modelId = model !== null && typeof model === "object" ? model.id : undefined;
      const reasoning = model !== null && typeof model === "object"
        && model.reasoning !== null && typeof model.reasoning === "object" ? model.reasoning : null;
      const defaultEffort = reasoning !== null ? reasoning.defaultEffort : undefined;
      const same = current !== null && typeof current === "object"
        && current.provider === provider && current.model === modelId;
      let effort;
      if (same && current.reasoningEffort !== undefined && current.reasoningEffort !== null) {
        effort = current.reasoningEffort;
      } else {
        effort = defaultEffort;
      }
      const selection = { provider, model: modelId };
      if (effort !== undefined) selection.reasoningEffort = effort;
      return selection;
    }

    /**
     * 级联菜单定位（含右缘翻转判定）。**只在打开时调用一次**——面板高度有
     * maxHeight 上限、列宽是固定值，所以常量预留（垂直 340、水平两列总宽）
     * 就是最坏情况的精确预算；打开后不按实测尺寸重排，避免悬停切换 provider
     * 时高度变化回搬弹层、与静止光标下的 mouseenter 形成抖动回路。
     * providerWidth 260、modelWidth 236、gap 6、panelHeight 340、视口边距 8。
     * 模型列默认位于 provider 右侧（列顺序不翻转）；徽标右缘空间放不下完整
     * 两列、且左侧放得下时，模型列**翻转到 provider 左侧**（容器
     * flexDirection: row-reverse，容器右缘对齐徽标右缘，键盘 ArrowLeft/
     * ArrowRight 语义随 flipped 取反）。两侧都放不下时回到右侧并按视口
     * 收窄（provider 最窄约 132px、model 取剩余宽度并在 CSS 端 ellipsis）。
     * 水平 clamp 一律用 viewport.clientWidth（排除竖向滚动条宽度）——
     * window.innerWidth 含滚动条，直接用会把面板右缘推进滚动条带。
     * 垂直：优先锚点上方（composer 多在底部），上方不足才下方，最终 clamp。
     * @param anchor - 徽标视口矩形（至少 left/top/bottom；right 用于翻转
     *   判定，缺失按退化锚点处理、不翻转）。
     * @param viewport - { width, height, clientWidth }；clientWidth 缺失回退
     *   width，整对象缺失/非法时按 0 处理。
     * @param providerWidth - provider 列宽度。
     * @param modelWidth - 模型列宽度；色板视图等单列场景传 0。
     * @param gap - 两列间距。
     * @param panelHeight - 面板总高（常量预留）。
     * @returns { left, top, totalWidth, providerWidth, modelWidth, flipped,
     *   panelMaxHeight }：整个级联容器（两列并排）的 fixed 原点、各列宽度、
     *   翻转标记与面板 maxHeight（视口过矮时收缩，供面板样式使用）。
     */
    function cascadePlacementFor(anchor, viewport, providerWidth, modelWidth, gap, panelHeight) {
      const w1 = typeof providerWidth === "number" ? providerWidth : 260;
      const w2 = typeof modelWidth === "number" ? modelWidth : 236;
      const g = typeof gap === "number" ? gap : 6;
      const margin = 8;
      const a = anchor !== null && typeof anchor === "object" ? anchor : {};
      const leftAnchor = typeof a.left === "number" ? a.left : 0;
      const topAnchor = typeof a.top === "number" ? a.top : 0;
      const bottomAnchor = typeof a.bottom === "number" ? a.bottom : topAnchor;
      const rightAnchor = typeof a.right === "number" ? a.right : leftAnchor;
      const v = viewport !== null && typeof viewport === "object" ? viewport : {};
      const height = typeof v.height === "number" ? v.height : 0;
      const innerWidth = typeof v.width === "number" ? v.width : 0;
      const clientW = typeof v.clientWidth === "number" && v.clientWidth > 0 ? v.clientWidth : innerWidth;

      // 视口过矮时收缩预留高度（返回 panelMaxHeight 供面板样式使用）：保证
      // 面板（含内部滚动条）完整落在视口内，超长列表的尾部与滚动条不会坠出
      // 视口外不可达。120px 下限防止极端矮视口下面板完全不可用。
      const phRaw = typeof panelHeight === "number" ? panelHeight : 340;
      const ph = height > 0 ? Math.max(120, Math.min(phRaw, height - margin * 2)) : phRaw;

      // 垂直：优先上方，其次下方，最后夹取（垂直语义与旧版一致）。
      const above = topAnchor - g - ph;
      const below = bottomAnchor + g;
      let top;
      if (height > 0) {
        if (above >= margin) top = above;
        else if (below + ph <= height - margin) top = below;
        else top = below;
        top = Math.max(margin, Math.min(top, height - ph - margin));
        if (height < ph + margin * 2) top = margin;
      } else {
        top = above;
      }

      // 水平：极窄视口先收窄两列（provider 下限 132，模型取剩余）。
      let pw = w1;
      let mw = w2;
      if (clientW > 0 && pw + g + mw > clientW - margin * 2) {
        const available = clientW - margin * 2;
        pw = Math.max(0, Math.min(w1, Math.max(132, available - g - mw)));
        mw = Math.max(0, Math.min(w2, available - g - pw));
      }
      const totalWidth = mw > 0 ? pw + g + mw : pw;

      // 翻转判定：右侧放不下完整两列、且左侧放得下 → 模型列翻到 provider
      // 左侧（仅双列时判定；单列/色板视图永不翻转）。
      let flipped = false;
      if (clientW > 0 && mw > 0) {
        const spaceRight = clientW - rightAnchor;
        const spaceLeft = leftAnchor;
        if (spaceRight + margin < totalWidth && spaceLeft - margin >= totalWidth) flipped = true;
      }

      let left;
      if (clientW > 0) {
        // 未翻转：容器左缘对齐徽标左缘；翻转：容器右缘对齐徽标右缘（镜像）。
        left = flipped ? rightAnchor - totalWidth : leftAnchor;
        left = Math.max(margin, Math.min(left, clientW - totalWidth - margin));
      } else {
        left = leftAnchor;
      }
      return {
        left,
        top,
        totalWidth,
        providerWidth: pw,
        modelWidth: mw,
        flipped,
        panelMaxHeight: ph,
      };
    }

    /**
     * 首字母（含任意前缀）选中 provider：大小写不敏感，优先 group.name，再
     * group.id；从 fromIndex 之后循环查找，重复同字母按当前索引前进。
     * @param rows - provider 行（至少 id；可选 name、disabled）。
     * @param query - 输入缓冲（一个或多个字符）。
     * @param fromIndex - 当前索引（-1 表示从表首开始）。
     * @returns 命中的行索引；无命中返回 -1。
     */
    function providerIndexByPrefix(rows, query, fromIndex) {
      const list = Array.isArray(rows) ? rows : [];
      const n = list.length;
      if (n === 0 || typeof query !== "string" || query.length === 0) return -1;
      const q = query.toLowerCase();
      const start = Number.isInteger(fromIndex) ? fromIndex : -1;
      const enabled = (row) => row !== null && typeof row === "object" && row.disabled !== true;
      const nameMatch = (row) => row !== null && typeof row === "object"
        && typeof row.name === "string" && row.name.toLowerCase().startsWith(q);
      const idMatch = (row) => row !== null && typeof row === "object"
        && typeof row.id === "string" && row.id.toLowerCase().startsWith(q);
      for (const pred of [nameMatch, idMatch]) {
        for (let i = 1; i <= n; i++) {
          const idx = ((start + i) % n + n) % n;
          if (enabled(list[idx]) && pred(list[idx])) return idx;
        }
      }
      return -1;
    }

    /**
     * 下一个可选 provider 行：跳过空 models 行与 failure（disabled）行，循环。
     * @param items - provider 行（每行 models 数组；disabled 标记失败行）。
     * @param current - 当前索引。
     * @param delta - +1 或 -1。
     * @returns 下一个可选行索引；无可选返回 -1。
     */
    function nextEnabledIndex(items, current, delta) {
      const list = Array.isArray(items) ? items : [];
      const n = list.length;
      if (n === 0) return -1;
      const step = delta >= 0 ? 1 : -1;
      const enabled = (row) => row !== null && typeof row === "object"
        && row.disabled !== true && Array.isArray(row.models) && row.models.length > 0;
      let idx = Number.isInteger(current) && current >= 0 ? current : (step > 0 ? -1 : n);
      for (let i = 0; i < n; i++) {
        idx = ((idx + step) % n + n) % n;
        if (enabled(list[idx])) return idx;
      }
      return -1;
    }

    /**
     * 目录快照 → provider 行列表：成功 group（保持目录顺序）+ failures
     * （disabled，仅展示不可选）。空 models 的 group 也 disabled（无法进入
     * 二级）。
     * @param state - 目录快照。
     * @returns 行数组 { kind, id, name, models, disabled, failure }。
     */
    function providerRowsOf(state) {
      const rows = [];
      if (state !== null && typeof state === "object" && Array.isArray(state.groups)) {
        for (const g of state.groups) {
          if (g === null || typeof g !== "object") continue;
          const models = Array.isArray(g.models) ? g.models : [];
          const id = typeof g.id === "string" ? g.id : "";
          rows.push({
            kind: "group",
            id,
            name: typeof g.name === "string" && g.name.length > 0 ? g.name : id,
            models,
            disabled: models.length === 0,
            failure: false,
          });
        }
      }
      if (state !== null && typeof state === "object" && Array.isArray(state.failures)) {
        for (const f of state.failures) {
          if (f === null || typeof f !== "object") continue;
          const id = typeof f.id === "string" ? f.id : "";
          rows.push({
            kind: "failure",
            id,
            name: typeof f.name === "string" && f.name.length > 0 ? f.name : id,
            message: typeof f.message === "string" ? f.message : "",
            models: [],
            disabled: true,
            failure: true,
          });
        }
      }
      return rows;
    }

    /**
     * scroll 事件是否应关闭弹层。
     * scroll 不冒泡但会在捕获阶段自 window 下传，故弹层内部滚动列表时
     * 事件目标命中弹层/徽标容器 → 不关闭；页面滚动等其余情况 → 关闭。
     */
    function shouldCloseOnScroll(target) {
      if (target === null || target === undefined) return true;
      if (typeof target.closest !== "function") return true;
      try {
        if (target.closest("[data-provider-badge-cascade], [data-provider-badge-root]") !== null) return false;
      } catch (e) {
        return true;
      }
      return true;
    }

    /** 目录快照 → 徽标描述 { text, title, routeId }；数据不符返回 null。 */
    function badgeOf(state) {
      if (state === null || typeof state !== "object") return null;
      const current = state.current;
      if (current === null || typeof current !== "object") return null;
      const routeId = current.provider;
      if (typeof routeId !== "string" || routeId.length === 0) return null;
      let displayName = null;
      if (Array.isArray(state.groups)) {
        const group = state.groups.find(
          (g) => g !== null && typeof g === "object"
            && g.id === routeId && typeof g.name === "string" && g.name.trim().length > 0,
        );
        if (group !== undefined) displayName = group.name;
      }
      const override = aliasLookup(ROUTE_LABELS, routeId);
      const text = override !== null ? override : deriveLetters(displayName, routeId);
      if (text === null) return null;
      const title = displayName !== null ? displayName + " (" + routeId + ")" : routeId;
      return { text, title, routeId };
    }

    /* ── inject face：按 sessionId 解析共享目录（复刻官方模型席位口径） ── */

    const UNAVAILABLE = Object.freeze({});

    /**
     * 稳定返回 { store, load, select }：
     * - store 为官方同一 ModelDirectory.store（useSyncExternalStore 订阅）。
     * - load 仅在 status==="idle" 时触发官方 load()（自带去重，吞拒绝）。
     * - select 代理到同一 directory.select（官方同口径），缺 select 或抛错时
     *   返回可判定失败对象（result.ok===false，result.error.code/message），
     *   由组件决定展示。subagent 转址会话 / 目录不可用 / 目录读取异常 →
     *   UNAVAILABLE（无 store/load/select）。
     */
    function faceOf(ctx, sessionId) {
      try {
        if (typeof sessionId !== "string" || sessionId.length === 0) return UNAVAILABLE;
        const sessions = (typeof ctx.get === "function" ? ctx.get("sessions") : undefined) || ctx.sessions;
        if (sessions !== undefined && sessions !== null
          && typeof sessions.subagentAddress === "function"
          && sessions.subagentAddress(sessionId) !== undefined) {
          return UNAVAILABLE;
        }
        const models = (typeof ctx.get === "function" ? ctx.get("modelDirectories") : undefined) || ctx.modelDirectories;
        if (models === undefined || models === null || typeof models.directoryFor !== "function") return UNAVAILABLE;
        const directory = models.directoryFor(sessionId);
        const store = directory !== undefined && directory !== null ? directory.store : undefined;
        if (store === undefined || store === null
          || typeof store.subscribe !== "function" || typeof store.getSnapshot !== "function") {
          return UNAVAILABLE;
        }
        const canSelect = typeof directory.select === "function";
        return {
          store,
          load: () => {
            try {
              const snapshot = store.getSnapshot();
              if (snapshot !== null && typeof snapshot === "object" && snapshot.status === "idle") {
                directory.load().catch(() => {});
              }
            } catch (_) { /* 目录读取失败不打扰用户 */ }
          },
          select: (selection) => {
            if (!canSelect) {
              return Promise.resolve({ ok: false, error: { code: "select/unavailable", message: "模型切换不可用" } });
            }
            try {
              return directory.select(selection);
            } catch (err) {
              return Promise.resolve({
                ok: false,
                error: {
                  code: "select/throw",
                  message: err !== null && typeof err === "object" && typeof err.message === "string"
                    ? err.message : String(err),
                },
              });
            }
          },
        };
      } catch (_) {
        return UNAVAILABLE;
      }
    }

    /* ── 组件 ─────────────────────────────────────────────────────── */

    const noopSubscribe = () => () => {};
    const snapshotNull = () => null;
    const serverSnapshotNull = () => null;

    // provider 列 176 → 200 → 260：额度文案常驻该列右侧，"5h 4% · 7d 35%" 要 200px，
    // 三窗口的 "5h 6% · 7d 36% · 30d 59%"（OpenCode Go）约 25 字符，200px 下显示名
    // 会被挤没，故再放到 260px。定位算法对宽度是参数化的，极窄视口下仍走
    // cascadePlacementFor 的收窄分支。
    const CASCADE_PROVIDER_WIDTH = 260;
    const CASCADE_MODEL_WIDTH = 236;
    const CASCADE_GAP = 6;
    const CASCADE_PANEL_HEIGHT = 340;
    const MENU_BG = "var(--dsw-specific-menu, #20242b)";
    const TYPEAHEAD_MS = 700;

    const BADGE_BASE_STYLE = {
      display: "inline-flex",
      alignItems: "center",
      height: "16px",
      padding: "0 5px",
      borderRadius: "4px",
      fontWeight: 700,
      fontSize: "10px",
      lineHeight: "16px",
      letterSpacing: "0",
      userSelect: "none",
      flex: "none",
    };

    const SPINNER_STYLE = {
      width: "12px",
      height: "12px",
      borderRadius: "50%",
      border: "2px solid rgba(255, 255, 255, 0.25)",
      borderTopColor: "currentColor",
      animation: "provider-badge-spin 0.7s linear infinite",
      flex: "none",
      marginLeft: "8px",
      boxSizing: "border-box",
    };

    const SPIN_KEYFRAMES = h("style", { key: "__provider_badge_spin" },
      "@keyframes provider-badge-spin{to{transform:rotate(360deg)}}");

    const PANEL_BASE_STYLE = {
      maxHeight: CASCADE_PANEL_HEIGHT + "px",
      overflowY: "auto",
      overscrollBehavior: "contain",
      padding: "4px",
      borderRadius: "8px",
      background: MENU_BG,
      boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)",
      display: "flex",
      flexDirection: "column",
      letterSpacing: "0",
      boxSizing: "border-box",
    };

    /** 二级模型首字母选中（name 优先，再 id；大小写不敏感，循环）。 */
    function modelIndexByPrefix(models, query, fromIndex) {
      const list = Array.isArray(models) ? models : [];
      const n = list.length;
      if (n === 0 || typeof query !== "string" || query.length === 0) return -1;
      const q = query.toLowerCase();
      const start = Number.isInteger(fromIndex) ? fromIndex : -1;
      const nameMatch = (m) => m !== null && typeof m === "object"
        && typeof m.name === "string" && m.name.toLowerCase().startsWith(q);
      const idMatch = (m) => m !== null && typeof m === "object"
        && typeof m.id === "string" && m.id.toLowerCase().startsWith(q);
      for (const pred of [nameMatch, idMatch]) {
        for (let i = 1; i <= n; i++) {
          const idx = ((start + i) % n + n) % n;
          if (pred(list[idx])) return idx;
        }
      }
      return -1;
    }

    function ProviderBadge(props) {
      const face = props !== null && typeof props === "object" ? props : UNAVAILABLE;
      const store = face.store;
      const subscribe = useMemo(
        () => (store !== undefined && store !== null ? (fn) => store.subscribe(fn) : noopSubscribe),
        [store],
      );
      const getSnapshot = useMemo(
        () => (store !== undefined && store !== null ? () => store.getSnapshot() : snapshotNull),
        [store],
      );
      const state = useSyncExternalStore(subscribe, getSnapshot, serverSnapshotNull);

      // 用户选色覆盖通过 lazy 初值只读取一次 localStorage。
      const [overrides, setOverrides] = useState(loadOverrides);
      // 一级 panel 是否切到色板视图（原选色面板逻辑并入级联一级底部）。
      const [colorMode, setColorMode] = useState(false);
      // 级联模型选择状态。
      const [cascade, setCascade] = useState(null);
      const [activeProviderId, setActiveProviderId] = useState(null);
      const [focusLevel, setFocusLevel] = useState("providers");
      const [providerIndex, setProviderIndex] = useState(0);
      const [modelIndex, setModelIndex] = useState(0);
      const [localError, setLocalError] = useState(null);
      const [pendingSelection, setPendingSelection] = useState(null);
      // 额度：整表（路由 id → 条目）。lazy 初值直接读模块缓存，重开菜单即时可用。
      const [quotaRoutes, setQuotaRoutes] = useState(() => quotaCache.routes);
      // 常用模型快捷按钮：绑定、配置视图、待指派槽位、行内错误、槽位光标。
      // 新增 hook 一律追加在末尾——probe 用调用序号播种，既有 0..9 序号不得变化。
      const [quickModels, setQuickModels] = useState(loadQuickModels);
      const [quickConfigMode, setQuickConfigMode] = useState(false);
      const [assignSlot, setAssignSlot] = useState(null);
      const [quickError, setQuickError] = useState(null);
      const [quickSlotIndex, setQuickSlotIndex] = useState(0);
      const keyBufferRef = useRef({ text: "", at: 0 });
      const badgeRef = useRef(null);

      useEffect(() => {
        if (typeof face.load === "function") face.load();
      }, [face.load]);

      // 打开级联时补一次额度（既有缓存且未过期就跳过）。
      // 额度取数失败一律静默：它是锦上添花，不能挡住模型选择。
      const cascadeOpen = cascade !== null;
      useEffect(() => {
        if (!cascadeOpen) return undefined;
        if (typeof fetch !== "function") return undefined;
        if (quotaCache.routes !== null && Date.now() - quotaCache.at < QUOTA_CLIENT_TTL_MS) return undefined;
        let cancelled = false;
        const run = async () => {
          try {
            const response = await fetch(QUOTA_ENDPOINT, {
              headers: { accept: "application/json" },
              signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
                ? AbortSignal.timeout(15000)
                : undefined,
            });
            if (response === null || response === undefined || response.ok !== true) return;
            const data = await response.json();
            const routes = data !== null && typeof data === "object"
              && data.routes !== null && typeof data.routes === "object" ? data.routes : null;
            if (cancelled) return;
            quotaCache.at = Date.now();
            quotaCache.routes = routes;
            setQuotaRoutes(routes);
          } catch (_) { /* 端点不可用/网络失败：保持无额度渲染 */ }
        };
        run();
        return () => { cancelled = true; };
      }, [cascadeOpen]);

      const closeAll = () => {
        setCascade(null);
        setColorMode(false);
        setLocalError(null);
        setActiveProviderId(null);
        setFocusLevel("providers");
        setQuickConfigMode(false);
        setAssignSlot(null);
        setQuickError(null);
      };

      // 点 root（徽标/级联容器）以外的位置关闭所有弹层。
      useEffect(() => {
        if (typeof document === "undefined") return;
        const closeOnOutside = (event) => {
          if (event !== null && typeof event === "object"
            && event.target !== null && typeof event.target.closest === "function"
            && event.target.closest("[data-provider-badge-cascade], [data-provider-badge-root]") !== null) return;
          closeAll();
        };
        document.addEventListener("mousedown", closeOnOutside);
        return () => document.removeEventListener("mousedown", closeOnOutside);
      }, []);

      // resize/scroll 关闭弹层，避免 fixed 锚点漂移（README 说明）。
      useEffect(() => {
        if (typeof window === "undefined") return;
        const closeOnMove = () => { closeAll(); };
        const closeOnScroll = (event) => {
          const target = event !== null && typeof event === "object" ? event.target : null;
          if (shouldCloseOnScroll(target)) closeAll();
        };
        window.addEventListener("resize", closeOnMove);
        window.addEventListener("scroll", closeOnScroll, true);
        return () => {
          window.removeEventListener("resize", closeOnMove);
          window.removeEventListener("scroll", closeOnScroll, true);
        };
      }, []);

      const rows = providerRowsOf(state);
      const currentProviderId = state !== null && typeof state === "object"
        && state.current !== null && typeof state.current === "object"
        && typeof state.current.provider === "string" ? state.current.provider : null;
      const currentModelId = state !== null && typeof state === "object"
        && state.current !== null && typeof state.current === "object"
        && typeof state.current.model === "string" ? state.current.model : null;
      const activeRow = activeProviderId !== null ? rows.find((r) => r.id === activeProviderId) : undefined;
      const activeModels = activeRow !== undefined && Array.isArray(activeRow.models) ? activeRow.models : [];
      const directoryPending = state !== null && typeof state === "object"
        && state.pending !== null && typeof state.pending === "object" ? state.pending : null;
      const effectivePending = directoryPending !== null ? directoryPending : pendingSelection;
      const selecting = pendingSelection !== null
        || (state !== null && typeof state === "object" && state.status === "selecting");

      // 翻转标记：键盘方向映射用（C-3）。
      //
      // 定位只在打开时计算一次（见 openCascade）：垂直按 CASCADE_PANEL_HEIGHT
      // 预留、水平按两列总宽 + clientWidth。**打开后刻意不再重排**——悬停
      // 不同 provider 时模型列高度会变（超长列表被 maxHeight 截断 ↔ 短列表
      // 只有几十像素），若按实测高度回搬弹层，会形成「高度变化 → 弹层跳动 →
      // 行在静止光标下移动 → 浏览器补发 mouseenter → hover 到另一 provider →
      // 高度再变」的抖动回路（2026-10-19 用户实测抖动，已修正）。页面滚动/
      // 窗口 resize 仍直接关闭（README 既有设计）。
      const cascadeFlipped = cascade !== null && cascade.flipped === true;

      const typeAhead = (key) => {
        const now = Date.now();
        const buf = keyBufferRef.current;
        if (buf === null || buf === undefined || now - buf.at > TYPEAHEAD_MS) keyBufferRef.current = { text: key, at: now };
        else keyBufferRef.current = { text: buf.text + key, at: now };
        return keyBufferRef.current.text;
      };

      const focusProviderAt = (idx) => {
        if (idx < 0 || idx >= rows.length) return;
        setProviderIndex(idx);
        setActiveProviderId(rows[idx].id);
        setModelIndex(0);
      };

      const moveProvider = (delta) => {
        const idx = nextEnabledIndex(rows, providerIndex, delta);
        if (idx >= 0) focusProviderAt(idx);
      };

      const moveProviderEdge = (which) => {
        const idx = which === "first" ? nextEnabledIndex(rows, -1, 1) : nextEnabledIndex(rows, -1, -1);
        if (idx >= 0) focusProviderAt(idx);
      };

      const enterModels = () => {
        if (activeRow !== undefined && activeModels.length > 0) {
          setFocusLevel("models");
          setModelIndex(0);
        }
      };

      const closeCascade = () => {
        setCascade(null);
        setLocalError(null);
        setActiveProviderId(null);
        setFocusLevel("providers");
        setQuickConfigMode(false);
        setAssignSlot(null);
      };

      const openCascade = (event) => {
        if (event !== null && typeof event === "object" && typeof event.stopPropagation === "function") {
          event.stopPropagation();
        }
        if (cascade !== null) { closeCascade(); return; }
        let idx = rows.findIndex((r) => r.id === currentProviderId && !r.disabled);
        if (idx < 0) idx = nextEnabledIndex(rows, -1, 1);
        const row = idx >= 0 ? rows[idx] : undefined;
        let position = {
          left: 0,
          top: 0,
          totalWidth: CASCADE_PROVIDER_WIDTH + CASCADE_GAP + CASCADE_MODEL_WIDTH,
          providerWidth: CASCADE_PROVIDER_WIDTH,
          modelWidth: CASCADE_MODEL_WIDTH,
          flipped: false,
          panelMaxHeight: CASCADE_PANEL_HEIGHT,
        };
        try {
          const anchorEl = badgeRef.current !== null && badgeRef.current !== undefined
            && typeof badgeRef.current.getBoundingClientRect === "function"
            ? badgeRef.current
            : (event !== null && typeof event === "object" ? event.currentTarget : null);
          const rect = anchorEl !== null && anchorEl !== undefined
            && typeof anchorEl.getBoundingClientRect === "function"
            ? anchorEl.getBoundingClientRect()
            : undefined;
          const viewport = typeof window !== "undefined"
            ? {
              width: window.innerWidth,
              height: window.innerHeight,
              clientWidth: typeof document !== "undefined"
                && document.documentElement !== null
                && typeof document.documentElement.clientWidth === "number"
                ? document.documentElement.clientWidth : undefined,
            }
            : undefined;
          // 定位只在打开时计算一次，恒按**两列满预算**：垂直按
          // CASCADE_PANEL_HEIGHT(340) 预留（面板 maxHeight 上限，悬停切换
          // provider 不会超过），水平按 260+6+236 与 clientWidth。即使打开
          // 时当前行无模型也预留模型列空间，后续悬停其它 provider 弹出模型
          // 列时位置已就绪。打开后不再重排（防抖动回路，见 cascadeFlipped
          // 上方注释）。
          position = cascadePlacementFor(rect, viewport,
            CASCADE_PROVIDER_WIDTH, CASCADE_MODEL_WIDTH, CASCADE_GAP, CASCADE_PANEL_HEIGHT);
        } catch (_) { /* 无 DOM 环境不做定位；菜单落在 (0,0) 不影响逻辑 */ }
        setCascade(position);
        setColorMode(false);
        setQuickConfigMode(false);
        setAssignSlot(null);
        setQuickError(null);
        setActiveProviderId(row !== undefined ? row.id : null);
        setProviderIndex(idx >= 0 ? idx : 0);
        setModelIndex(0);
        setFocusLevel("providers");
        setLocalError(null);
      };

      const pickModel = (group, model) => {
        if (selecting || group === undefined || model === undefined) return;
        // 配置模式：选中模型只写槽位，不切换会话选择（官方 select 零调用）。
        if (assignSlot !== null) {
          const next = quickModels.slice();
          next[assignSlot] = { provider: group.id, model: model.id };
          const normalized = normalizeQuickModels(next);
          const applied = normalized !== null ? normalized : quickModels;
          saveQuickModels(applied);
          setQuickModels(applied);
          setAssignSlot(null);
          setLocalError(null);
          return;
        }
        const selection = selectionFor(group, model, state !== null && typeof state === "object" ? state.current : null);
        setLocalError(null);
        setPendingSelection(selection);
        const fail = (message) => { setPendingSelection(null); setLocalError(message); };
        const stateError = state !== null && typeof state === "object" && typeof state.error === "string" && state.error.length > 0
          ? state.error : null;
        let promise;
        try {
          promise = typeof face.select === "function"
            ? face.select(selection)
            : Promise.resolve({ ok: false, error: { code: "select/unavailable", message: "模型切换不可用" } });
        } catch (err) {
          fail(err !== null && typeof err === "object" && typeof err.message === "string" ? err.message : "模型切换失败");
          return;
        }
        Promise.resolve(promise).then((result) => {
          const ok = result === undefined || result === null ? true : result.ok !== false;
          if (!ok) {
            const err = result !== null && typeof result === "object" ? result.error : null;
            if (err !== null && typeof err === "object" && err.code === "session/writer-held") {
              fail("会话正被其他 DSH 占用");
              return;
            }
            const message = err !== null && typeof err === "object" && typeof err.message === "string" && err.message.length > 0
              ? err.message : stateError;
            fail(message !== null ? message : "模型切换失败");
            return;
          }
          setPendingSelection(null);
          closeCascade();
          try {
            if (badgeRef.current !== null && badgeRef.current !== undefined && typeof badgeRef.current.focus === "function") {
              badgeRef.current.focus();
            }
          } catch (_) { /* 无 DOM 环境忽略聚焦 */ }
        }).catch((err) => {
          fail(err !== null && typeof err === "object" && typeof err.message === "string" ? err.message : "模型切换失败");
        });
      };

      /**
       * 常用模型按钮：一键切换会话模型（与级联走同一条官方 select）。
       * 失败只留在按钮行内的短标记 + title 里（级联通常是关闭的，面板内错误看不见）。
       * @param entry - 配置项 {provider, model}。
       */
      const pickQuickModel = (entry) => {
        if (selecting) return;
        const info = quickStatusOf(entry, state);
        setQuickError(null);
        if (info.disabled) { setQuickError(info.title); return; }
        const group = info.group !== undefined ? info.group : { id: info.providerId, models: [] };
        const model = info.model !== undefined ? info.model : { id: info.modelId };
        const selection = selectionFor(group, model, state !== null && typeof state === "object" ? state.current : null);
        setPendingSelection(selection);
        const fail = (message) => { setPendingSelection(null); setQuickError(message); setLocalError(message); };
        const stateError = state !== null && typeof state === "object" && typeof state.error === "string" && state.error.length > 0
          ? state.error : null;
        let promise;
        try {
          promise = typeof face.select === "function"
            ? face.select(selection)
            : Promise.resolve({ ok: false, error: { code: "select/unavailable", message: "模型切换不可用" } });
        } catch (err) {
          fail(err !== null && typeof err === "object" && typeof err.message === "string" ? err.message : "模型切换失败");
          return;
        }
        Promise.resolve(promise).then((result) => {
          const ok = result === undefined || result === null ? true : result.ok !== false;
          if (!ok) {
            const err = result !== null && typeof result === "object" ? result.error : null;
            if (err !== null && typeof err === "object" && err.code === "session/writer-held") {
              fail("会话正被其他 DSH 占用");
              return;
            }
            const message = err !== null && typeof err === "object" && typeof err.message === "string" && err.message.length > 0
              ? err.message : stateError;
            fail(message !== null ? message : "模型切换失败");
            return;
          }
          setPendingSelection(null);
          setQuickError(null);
        }).catch((err) => {
          fail(err !== null && typeof err === "object" && typeof err.message === "string" ? err.message : "模型切换失败");
        });
      };

      const onKeyDown = (event) => {
        if (event === null || typeof event !== "object") return;
        const key = event.key;
        const consume = () => {
          if (typeof event.preventDefault === "function") event.preventDefault();
          if (typeof event.stopPropagation === "function") event.stopPropagation();
        };
        if (cascade === null) {
          if (key === "Enter" || key === " " || key === "Spacebar" || key === "ArrowDown" || key === "ArrowUp") {
            consume();
            openCascade(event);
          }
          return;
        }
        if (key === "Escape") {
          consume();
          if (assignSlot !== null) setAssignSlot(null);
          else if (quickConfigMode) setQuickConfigMode(false);
          else if (colorMode) setColorMode(false);
          else if (focusLevel === "models") setFocusLevel("providers");
          else closeCascade();
          return;
        }
        if (key === "Tab") return;
        if (colorMode) return;
        // 槽位列表视图：方向键移光标、Enter 进入指派、其余可打印键不落到 provider typeahead。
        if (quickConfigMode && assignSlot === null) {
          const slots = Math.max(1, quickModels.length);
          if (key === "ArrowDown") { consume(); setQuickSlotIndex((i) => (i + 1) % slots); }
          else if (key === "ArrowUp") { consume(); setQuickSlotIndex((i) => (i - 1 + slots) % slots); }
          else if (key === "Enter") { consume(); setAssignSlot(Math.min(quickSlotIndex, slots - 1)); }
          else if (printable) consume();
          return;
        }
        const printable = typeof key === "string" && key.length === 1
          && !event.ctrlKey && !event.metaKey && !event.altKey;
        if (focusLevel === "providers") {
          if (key === "ArrowDown") { consume(); moveProvider(1); }
          else if (key === "ArrowUp") { consume(); moveProvider(-1); }
          else if (key === "Home") { consume(); moveProviderEdge("first"); }
          else if (key === "End") { consume(); moveProviderEdge("last"); }
          else if (key === (cascadeFlipped ? "ArrowLeft" : "ArrowRight") || key === "Enter") { consume(); enterModels(); }
          else if (printable) {
            consume();
            const idx = providerIndexByPrefix(rows, typeAhead(key), providerIndex);
            if (idx >= 0) focusProviderAt(idx);
          }
        } else {
          if (activeModels.length === 0) { setFocusLevel("providers"); return; }
          if (key === "ArrowDown") { consume(); setModelIndex((i) => (i + 1) % activeModels.length); }
          else if (key === "ArrowUp") { consume(); setModelIndex((i) => (i - 1 + activeModels.length) % activeModels.length); }
          else if (key === "Home") { consume(); setModelIndex(0); }
          else if (key === "End") { consume(); setModelIndex(activeModels.length - 1); }
          else if (key === (cascadeFlipped ? "ArrowRight" : "ArrowLeft")) { consume(); setFocusLevel("providers"); }
          else if (key === "Enter") {
            consume();
            const model = activeModels[modelIndex];
            if (model !== undefined) pickModel(activeRow, model);
          } else if (printable) {
            consume();
            const idx = modelIndexByPrefix(activeModels, typeAhead(key), modelIndex);
            if (idx >= 0) setModelIndex(idx);
          }
        }
      };

      /** 一级面板切到色板视图（复用原有 localStorage 选色）。 */
      const openColorPalette = (event) => {
        if (event !== null && typeof event === "object" && typeof event.stopPropagation === "function") {
          event.stopPropagation();
        }
        setColorMode(true);
      };

      const badge = badgeOf(state);
      if (badge === null) return null;
      const background = resolveColor(badge.routeId, state, overrides);

      const badgeEl = h("span", {
        key: "__badge",
        ref: badgeRef,
        role: "button",
        tabIndex: 0,
        title: badge.title,
        "aria-label": badge.title,
        "aria-haspopup": "listbox",
        "aria-expanded": cascade !== null,
        "data-provider-badge-root": true,
        "data-provider-badge-badge": true,
        style: {
          ...BADGE_BASE_STYLE,
          background,
          color: inkFor(background),
          cursor: "pointer",
        },
        onClick: openCascade,
        onKeyDown,
      }, badge.text);

      const pick = (color) => {
        const next = { ...overrides };
        if (color === null) delete next[badge.routeId];
        else next[badge.routeId] = color;
        saveOverrides(next);
        setOverrides(next);
        setColorMode(false);
      };

      /**
       * 常用模型快捷按钮行：徽标左侧的 6 个一键切换胶囊。
       * 颜色沿用 provider 色表（与徽标同源：aliasLookup 已抹平 opencodego/opencode-go），
       * 当前命中项加描边，目录缺失/未就绪时 disabled 并把原因写进 title。
       */
      const quickButtonEls = quickModels.map((entry, index) => {
        const info = quickStatusOf(entry, state);
        const color = resolveColor(info.providerId, state, overrides);
        const isPending = effectivePending !== null
          && effectivePending.provider === info.providerId && effectivePending.model === info.modelId;
        const style = {
          display: "inline-flex",
          alignItems: "center",
          height: "16px",
          padding: "0 5px",
          borderRadius: "3px",
          border: "none",
          background: color,
          color: inkFor(color),
          fontWeight: 700,
          fontSize: "9px",
          lineHeight: "16px",
          letterSpacing: "0",
          userSelect: "none",
          flex: "none",
          boxSizing: "border-box",
          opacity: info.disabled ? 0.45 : 1,
          cursor: info.disabled || selecting ? "default" : "pointer",
        };
        if (info.active) {
          style.outline = "1px solid currentColor";
          style.outlineOffset = "1px";
        }
        if (isPending) style.opacity = 0.6;
        return h("button", {
          key: "quick:" + index,
          type: "button",
          "data-provider-badge-quick": info.providerId + "/" + info.modelId,
          "data-provider-badge-quick-index": index,
          "data-provider-badge-quick-active": info.active ? true : undefined,
          "aria-label": info.title,
          title: info.title,
          disabled: info.disabled || selecting,
          onClick: (event) => {
            if (event !== null && typeof event === "object" && typeof event.stopPropagation === "function") {
              event.stopPropagation();
            }
            pickQuickModel(entry);
          },
          style,
        }, info.label !== null ? info.label : info.modelId);
      });

      const quickBarEl = quickModels.length === 0 ? null : h("span", {
        key: "__quickbar",
        "data-provider-badge-quickbar": true,
        role: "group",
        "aria-label": "常用模型快捷切换",
        style: { display: "inline-flex", alignItems: "center", gap: "3px", flex: "none" },
      }, ...quickButtonEls, quickError === null ? null : h("span", {
        key: "__quick_error",
        "data-provider-badge-quick-error": true,
        title: quickError,
        "aria-live": "polite",
        style: {
          marginLeft: "2px",
          fontSize: "10px",
          lineHeight: "16px",
          fontWeight: 700,
          color: "#ff9b9b",
          flex: "none",
        },
      }, "!"));

      // 分组容器：只要存在常用模型按钮，徽标就与按钮组包在同一个 inline-flex 里，
      // 让按钮紧贴徽标左侧、作为一个 flex 项参与 composer 行的排布。
      const groupEl = h("span", {
        key: "__provider_badge_group",
        "data-provider-badge-group": true,
        style: { display: "inline-flex", alignItems: "center", gap: "3px", flex: "none" },
      }, quickBarEl, badgeEl);

      // 关闭态只渲染「按钮组 + 徽标」（无按钮时退化为只有徽标）。
      if (cascade === null) return groupEl;

      const swatchDot = h("span", {
        key: "__color_dot",
        style: {
          width: "12px",
          height: "12px",
          borderRadius: "50%",
          border: "1px solid rgba(255, 255, 255, 0.35)",
          background,
          flex: "none",
          boxSizing: "border-box",
        },
      }, null);

      const stopIt = (event) => {
        if (event !== null && typeof event === "object" && typeof event.stopPropagation === "function") {
          event.stopPropagation();
        }
      };

      let providerPanel;
      // 面板 maxHeight：视口过矮时 cascadePlacementFor 已收缩（见其
      // panelMaxHeight），保证超长列表的尾部与内部滚动条不坠出视口。
      const panelMaxHeight = cascade.panelMaxHeight !== null
        && typeof cascade.panelMaxHeight === "number" && cascade.panelMaxHeight > 0
        ? cascade.panelMaxHeight : CASCADE_PANEL_HEIGHT;

      if (colorMode) {
        // 一级面板切到原有色板视图（复用 localStorage），可返回 provider 列表。
        const backEl = h("button", {
          type: "button",
          key: "__color_back",
          "data-provider-badge-color-back": true,
          onClick: (event) => { stopIt(event); setColorMode(false); },
          style: {
            display: "flex",
            alignItems: "center",
            height: "30px",
            padding: "0 8px",
            border: "none",
            background: "transparent",
            color: "inherit",
            font: "inherit",
            fontSize: "12px",
            letterSpacing: "0",
            boxSizing: "border-box",
            cursor: "pointer",
            textAlign: "left",
          },
        }, "‹ 返回");
        const gridEl = h("div",
          { key: "__swatches", style: { display: "flex", gap: "6px", flexWrap: "wrap", maxWidth: "232px", padding: "4px 8px" } },
          swatchColors().map((color) => h("button", {
            type: "button",
            key: color,
            title: color,
            "aria-label": color,
            style: {
              width: "20px", height: "20px", padding: "0", borderRadius: "5px",
              border: "1px solid rgba(255, 255, 255, 0.22)", background: color, cursor: "pointer",
            },
            onClick: (event) => { stopIt(event); pick(color); },
          }, null)),
        );
        const autoEl = h("button", {
          type: "button",
          key: "__auto",
          onClick: (event) => { stopIt(event); pick(null); },
          style: {
            alignSelf: "flex-start", padding: "2px 6px", border: "none", borderRadius: "6px",
            background: "transparent", color: "inherit", font: "inherit", fontSize: "12px",
            letterSpacing: "0", cursor: "pointer",
          },
        }, Object.prototype.hasOwnProperty.call(overrides, badge.routeId) ? "恢复自动配色" : "自动配色");
        providerPanel = h("div",
          { key: "__providers", role: "listbox", "aria-label": badge.title, style: { ...PANEL_BASE_STYLE, width: cascade.providerWidth + "px", maxHeight: panelMaxHeight + "px" } },
          backEl, gridEl, autoEl,
        );
      } else if (quickConfigMode && assignSlot === null) {
        // 常用模型配置视图：槽位列表（点槽 → 进入指派，复用 provider/model 两级）。
        const quickBackEl = h("button", {
          type: "button",
          key: "__quick_back",
          "data-provider-badge-quick-back": true,
          onClick: (event) => { stopIt(event); setQuickConfigMode(false); },
          style: {
            display: "flex",
            alignItems: "center",
            height: "30px",
            padding: "0 8px",
            border: "none",
            background: "transparent",
            color: "inherit",
            font: "inherit",
            fontSize: "12px",
            letterSpacing: "0",
            boxSizing: "border-box",
            cursor: "pointer",
          },
        }, "‹ 返回");
        const slotEls = quickModels.map((entry, index) => {
          const info = quickStatusOf(entry, state);
          const isActive = index === quickSlotIndex;
          return h("button", {
            type: "button",
            key: "slot:" + index,
            "data-provider-badge-quick-slot": index,
            title: info.title,
            onClick: (event) => {
              stopIt(event);
              setQuickSlotIndex(index);
              setAssignSlot(index);
              setFocusLevel("providers");
              setLocalError(null);
            },
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
              width: "100%",
              height: "30px",
              padding: "0 8px",
              border: "none",
              borderRadius: "6px",
              background: isActive ? "rgba(255, 255, 255, 0.10)" : "transparent",
              color: info.disabled ? "rgba(255, 255, 255, 0.45)" : "inherit",
              font: "inherit",
              fontSize: "12px",
              letterSpacing: "0",
              boxSizing: "border-box",
              cursor: "pointer",
              textAlign: "left",
            },
          },
          h("span", { key: "label", style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
            (index + 1) + ". " + (info.label !== null ? info.label : info.modelId)),
          h("span", { key: "provider", style: { flex: "none", fontSize: "10px", opacity: 0.62, whiteSpace: "nowrap" } }, info.providerId),
          );
        });
        const quickResetEl = h("button", {
          type: "button",
          key: "__quick_reset",
          "data-provider-badge-quick-reset": true,
          onClick: (event) => {
            stopIt(event);
            const restored = defaultQuickModels();
            saveQuickModels(restored);
            setQuickModels(restored);
            setQuickSlotIndex(0);
            setAssignSlot(null);
          },
          style: {
            display: "flex",
            alignItems: "center",
            width: "100%",
            height: "30px",
            marginTop: "4px",
            padding: "0 8px",
            border: "none",
            borderTop: "1px solid rgba(255, 255, 255, 0.12)",
            background: "transparent",
            color: "inherit",
            font: "inherit",
            fontSize: "12px",
            letterSpacing: "0",
            boxSizing: "border-box",
            cursor: "pointer",
            textAlign: "left",
          },
        }, "恢复默认 6 项");
        providerPanel = h("div",
          { key: "__quick_slots", role: "listbox", "aria-label": "常用模型槽位", style: { ...PANEL_BASE_STYLE, width: cascade.providerWidth + "px", maxHeight: panelMaxHeight + "px" } },
          quickBackEl,
          ...slotEls,
          quickResetEl,
        );
      } else {
        const providerRowEls = rows.map((row, index) => {
          const isActive = activeProviderId === row.id;
          const isCurrent = currentProviderId === row.id;
          const isPending = effectivePending !== null && effectivePending.provider === row.id;
          const rowStyle = {
            height: "30px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 8px",
            borderRadius: "6px",
            fontSize: "12px",
            letterSpacing: "0",
            boxSizing: "border-box",
            cursor: row.disabled ? "default" : "pointer",
            opacity: row.disabled ? 0.5 : 1,
            background: isActive ? "rgba(255, 255, 255, 0.10)" : "transparent",
            color: "inherit",
          };
          if (isCurrent) rowStyle.fontWeight = 700;
          let trailing = row.failure ? "!" : ">";
          if (isPending) trailing = "…";
          // 额度：只对宿主报告了可用条目的路由渲染。本半不认识具体 provider：
          // 命中 row.id 即可渲染（openai-codex / kimi-coding 走同一段代码）。
          // 宿主按 baseURL 判定真实路由 id（本机 opencodego），但旧版本/另一台设备只会
          // 给规范名（opencode-go）：精确 → 别名 → 反向别名三层兜底。
          const quotaEntry = quotaEntryFor(quotaRoutes, row.id);
          const quotaFailure = quotaFailureOf(quotaEntry);
          const quotaSuccessText = quotaInlineTextOf(quotaEntry);
          const quotaText = quotaSuccessText !== null ? quotaSuccessText
            : (quotaFailure !== null ? quotaFailure.text : null);
          const quotaTone = quotaSuccessText !== null ? quotaToneOf(quotaEntry) : null;
          const quotaColor = quotaFailure !== null ? QUOTA_TONES.warn
            : (quotaTone !== null ? QUOTA_TONES[quotaTone] : null);
          const quotaTitle = quotaSuccessText !== null ? quotaTitleOf(quotaEntry)
            : (quotaFailure !== null ? quotaFailure.title : null);
          const quotaEl = quotaText === null ? null : h("span", {
            key: "quota",
            "data-provider-badge-quota": row.id,
            title: quotaTitle !== null ? quotaTitle : undefined,
            style: {
              marginLeft: "8px",
              flex: "none",
              fontSize: "10px",
              lineHeight: "12px",
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
              letterSpacing: "0",
              color: quotaColor !== null ? quotaColor : "inherit",
              opacity: quotaColor === null ? 0.62 : 1,
            },
          }, quotaText);
          return h("div", {
            key: row.id + ":" + index,
            role: "option",
            "aria-selected": isActive,
            "aria-disabled": row.disabled,
            "data-provider-row": row.id,
            style: rowStyle,
            onMouseEnter: () => { if (!row.disabled) { setActiveProviderId(row.id); setProviderIndex(index); setModelIndex(0); } },
            onClick: () => {
              if (row.disabled) return;
              setActiveProviderId(row.id);
              setProviderIndex(index);
              setModelIndex(0);
              setFocusLevel("models");
            },
          },
          // name 需要 minWidth:0 + flex 才能让 ellipsis 生效：额度占住右侧固定宽度后，
          // 长显示名必须让位而不是把额度挤出列宽。
          h("span", { key: "name", style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, row.name),
          quotaEl,
          h("span", { key: "sym", style: { marginLeft: "8px", opacity: 0.7, flex: "none" } }, trailing),
          );
        });
        if (localError !== null) {
          providerRowEls.push(h("div", {
            key: "__error",
            "data-provider-badge-error": true,
            "aria-live": "polite",
            style: {
              padding: "6px 8px",
              fontSize: "11px",
              lineHeight: "1.4",
              letterSpacing: "0",
              color: "#ff9b9b",
              borderTop: "1px solid rgba(255, 255, 255, 0.12)",
            },
          }, localError));
        }
        // 一级底部：选色入口（swatch + 「徽标颜色…」），点击切到色板视图。
        providerRowEls.push(h("button", {
          type: "button",
          key: "__color_action",
          "data-provider-badge-color-action": true,
          title: "设置徽标颜色",
          onClick: openColorPalette,
          style: {
            display: "flex",
            alignItems: "center",
            gap: "8px",
            width: "100%",
            height: "30px",
            marginTop: "4px",
            padding: "0 8px",
            border: "none",
            borderTop: "1px solid rgba(255, 255, 255, 0.12)",
            background: "transparent",
            color: "inherit",
            font: "inherit",
            fontSize: "12px",
            letterSpacing: "0",
            boxSizing: "border-box",
            cursor: "pointer",
            textAlign: "left",
          },
        },
        swatchDot,
        h("span", { key: "label", style: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "徽标颜色…"),
        ));
        // 一级底部：常用模型配置入口（指派模式下追加提示行）。
        providerRowEls.push(h("button", {
          type: "button",
          key: "__quick_action",
          "data-provider-badge-quick-action": true,
          title: "配置徽标左侧的常用模型按钮",
          onClick: (event) => {
            stopIt(event);
            setQuickConfigMode(true);
            setColorMode(false);
            setAssignSlot(null);
            setQuickSlotIndex(0);
          },
          style: {
            display: "flex",
            alignItems: "center",
            width: "100%",
            height: "30px",
            padding: "0 8px",
            border: "none",
            borderTop: "1px solid rgba(255, 255, 255, 0.12)",
            background: "transparent",
            color: "inherit",
            font: "inherit",
            fontSize: "12px",
            letterSpacing: "0",
            boxSizing: "border-box",
            cursor: "pointer",
            textAlign: "left",
          },
        },
        h("span", { key: "label", style: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "常用模型…"),
        ));
        if (assignSlot !== null) {
          providerRowEls.unshift(h("div", {
            key: "__quick_assign",
            "data-provider-badge-quick-assign": assignSlot,
            style: {
              padding: "4px 8px",
              fontSize: "11px",
              lineHeight: "1.4",
              letterSpacing: "0",
              color: "rgba(255, 255, 255, 0.62)",
            },
          }, "为按钮 " + (assignSlot + 1) + " 选择模型 · Esc 取消"));
        }
        providerPanel = h("div",
          { key: "__providers", role: "listbox", "aria-label": badge.title, style: { ...PANEL_BASE_STYLE, width: cascade.providerWidth + "px", maxHeight: panelMaxHeight + "px" } },
          providerRowEls,
        );
      }

      const panels = [providerPanel];
      // 槽位列表视图只显示一列（模型列留给「指派模型」时用）。
      if (!colorMode && !(quickConfigMode && assignSlot === null) && activeRow !== undefined && activeModels.length > 0) {
        const modelRowEls = activeModels.map((model, index) => {
          const isCurrent = currentProviderId === activeRow.id && currentModelId === model.id;
          const isActive = index === modelIndex;
          const isPending = effectivePending !== null
            && effectivePending.provider === activeRow.id && effectivePending.model === model.id;
          const rowStyle = {
            height: "30px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 8px",
            borderRadius: "6px",
            fontSize: "12px",
            letterSpacing: "0",
            boxSizing: "border-box",
            cursor: "pointer",
            background: isActive ? "rgba(255, 255, 255, 0.10)" : "transparent",
            color: "inherit",
          };
          if (isCurrent) rowStyle.fontWeight = 700;
          const trailing = isPending
            ? h("span", { key: "spin", style: SPINNER_STYLE }, null)
            : (isCurrent ? h("span", { key: "check", style: { marginLeft: "8px", opacity: 0.9, flex: "none" } }, "✓") : null);
          return h("div", {
            key: model.id + ":" + index,
            role: "option",
            "aria-selected": isActive,
            "data-model-row": model.id,
            style: rowStyle,
            onMouseEnter: () => setModelIndex(index),
            onClick: () => pickModel(activeRow, model),
          },
          h("span", { key: "name", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
            typeof model.name === "string" && model.name.length > 0 ? model.name : String(model.id)),
          trailing,
          );
        });
        panels.push(h("div",
          { key: "__models", role: "listbox", "aria-label": activeRow.name, style: { ...PANEL_BASE_STYLE, width: cascade.modelWidth + "px", maxHeight: panelMaxHeight + "px" } },
          modelRowEls,
        ));
      }

      const cascadeEl = h("div", {
        key: "__cascade",
        "data-provider-badge-cascade": true,
        role: "group",
        "aria-label": badge.title,
        onKeyDown,
        style: {
          position: "fixed",
          left: cascade.left,
          top: cascade.top,
          zIndex: 1200,
          display: "flex",
          flexDirection: cascade.flipped === true ? "row-reverse" : "row",
          gap: CASCADE_GAP + "px",
          letterSpacing: "0",
        },
      }, SPIN_KEYFRAMES, ...panels);

      // portal 到 document.body：脱离 composer 子树，规避祖先
      // transform/filter/overflow 劫持 position:fixed 的包含块与裁剪（改进
      // 方案 C-1）。宿主缺 react-dom 或无 document（探针沙箱）时内联渲染。
      const portalTarget = typeof document !== "undefined" ? document.body : null;
      const cascadeTree = createPortal !== null && portalTarget !== null
        ? createPortal(cascadeEl, portalTarget)
        : cascadeEl;

      return [groupEl, cascadeTree];
    }

    /* ── 跨插件只读展示桥（sidebar 运行行取模型配色） ─────────────────── */

    /**
     * 版本化只读全局桥：`window.__DSH_PROVIDER_BADGE__`。
     *
     * 约定（`dsh-plugin-sidebar-visibility` 的运行中标识消费）：
     * - 只暴露展示事实，不暴露 select / 凭据 / settings 写入；
     * - `presentationFor(sessionId)` 返回与徽标同一份目录 store 的订阅句柄，
     *   颜色走 `resolveColor`（用户自选色 > ROUTE_COLORS > 自动调色板），
     *   字色走 `inkFor`，因此侧栏颜色与输入框徽标严格同源；
     * - 目录未装载 / subagent 转址会话 / 无当前选择 → null，消费方中性降级；
     * - 句柄按调用现造，不缓存 store（会话 scope 释放后不残留失效句柄）。
     *
     * 语义边界（与徽标一致）：颜色/模型是**会话所选**的 provider 与模型，
     * 不反映运行期故障转移后的实际执行模型。
     */
    const BRIDGE_GLOBAL = "__DSH_PROVIDER_BADGE__";
    const BRIDGE_EVENT = "dsh-provider-badge:bridge";
    const BRIDGE_VERSION = 1;

    function presentationOf(ctx, sessionId) {
      const face = faceOf(ctx, sessionId);
      if (face === UNAVAILABLE) return null;
      const store = face.store;
      let cached = null;
      const compute = () => {
        let state;
        try {
          state = store.getSnapshot();
        } catch (_) {
          return null;
        }
        const badge = badgeOf(state);
        if (badge === null) return null;
        const color = resolveColor(badge.routeId, state, loadOverrides());
        let providerName = badge.routeId;
        let modelId = "";
        let modelName = "";
        const current = state.current;
        if (current !== null && typeof current === "object" && typeof current.model === "string") {
          modelId = current.model;
          modelName = current.model;
        }
        if (Array.isArray(state.groups)) {
          const group = state.groups.find(
            (g) => g !== null && typeof g === "object" && g.id === badge.routeId,
          );
          if (group !== undefined) {
            if (typeof group.name === "string" && group.name.trim().length > 0) providerName = group.name;
            if (modelId !== "" && Array.isArray(group.models)) {
              const model = group.models.find(
                (m) => m !== null && typeof m === "object" && m.id === modelId,
              );
              if (model !== undefined && typeof model.name === "string") modelName = model.name;
            }
          }
        }
        return Object.freeze({
          color,
          ink: inkFor(color),
          text: badge.text,
          providerId: badge.routeId,
          providerName,
          modelId,
          modelName,
        });
      };
      return {
        getSnapshot: () => {
          const next = compute();
          if (next === null) {
            cached = null;
            return null;
          }
          if (cached !== null
            && cached.color === next.color && cached.ink === next.ink && cached.text === next.text
            && cached.providerName === next.providerName
            && cached.modelId === next.modelId && cached.modelName === next.modelName) {
            return cached;
          }
          cached = next;
          return cached;
        },
        subscribe: (listener) => {
          if (typeof listener !== "function") return () => {};
          try {
            return store.subscribe(listener);
          } catch (_) {
            return () => {};
          }
        },
        load: face.load,
      };
    }

    /**
     * 纯色表查询（不依赖 ModelDirectory）：给定 provider 路由 id 与可见 provider
     * 集合，按与徽标完全相同的优先级返回 { color, ink, text }。
     *
     * 用于侧栏列表里**未驻留**的会话 —— 那些会话拿不到共享目录，但会话投影里
     * 已带 provider/模型，只要有这个纯函数就能上色，不必打开会话。
     * 未入 ROUTE_COLORS 的路由按传入集合均匀铺槽（与徽标同一套色阶）。
     */
    function colorPresentationFor(providerId, providerIds) {
      if (typeof providerId !== "string" || providerId.length === 0) return null;
      const ids = Array.isArray(providerIds)
        ? providerIds.filter((id) => typeof id === "string" && id.length > 0)
        : [];
      if (!ids.includes(providerId)) ids.push(providerId);
      const state = {
        current: { provider: providerId, model: "" },
        groups: ids.map((id) => ({ id, name: id, models: [] })),
        status: "ready",
      };
      const color = resolveColor(providerId, state, loadOverrides());
      const label = aliasLookup(ROUTE_LABELS, providerId);
      const text = label !== null ? label : deriveLetters(providerId, providerId);
      if (text === null) return null;
      return Object.freeze({
        color,
        ink: inkFor(color),
        text,
        providerId,
        providerName: providerId,
        modelId: "",
        modelName: "",
      });
    }
    /**
     * 安装桥并广播一次 `dsh-provider-badge:bridge` 事件（消费方可能在桥安装前
     * 已渲染）。ctx 释放时摘除，避免热重载后留下指向旧 ctx 的句柄。
     */
    function installPresentationBridge(ctx) {
      if (typeof window === "undefined" || window === null) return;
      const bridge = {
        version: BRIDGE_VERSION,
        colorFor: (providerId, providerIds) => {
          try {
            return colorPresentationFor(providerId, providerIds);
          } catch (_) {
            return null;
          }
        },
        presentationFor: (sessionId) => {
          try {
            if (typeof sessionId !== "string" || sessionId.length === 0) return null;
            return presentationOf(ctx, sessionId);
          } catch (_) {
            return null;
          }
        },
      };
      window[BRIDGE_GLOBAL] = bridge;
      try {
        window.dispatchEvent(new Event(BRIDGE_EVENT));
      } catch (_) { /* 旧宿主缺 Event 构造：消费方下次渲染自行读取 */ }
      if (typeof ctx.effect === "function") {
        ctx.effect(() => () => {
          if (window[BRIDGE_GLOBAL] === bridge) {
            try {
              delete window[BRIDGE_GLOBAL];
            } catch (_) {
              window[BRIDGE_GLOBAL] = undefined;
            }
          }
        }, "provider-badge: presentation bridge");
      }
    }

    /* ── 注册 ─────────────────────────────────────────────────────── */

    /**
     * cordis 注入权限清单：`modelDirectories` 服务内部访问 `remote.session`
     * （ModelDirectoryResolver.directoryFor → this.ctx.remote.session），所以
     * `remote` / `remote.session` 必须声明，否则 directoryFor 抛
     * "cannot get property remote.session without inject"（先例：官方
     * model-selection 的 inject = ["commandUi","locale","sessions","slots",
     * "remote","remote.session"]）。
     */
    const inject = ["slots", "sessions", "modelDirectories", "remote", "remote.session"];

    function apply(ctx) {
      installPresentationBridge(ctx);
      ctx.slots.inject("conversation.input.right", () =>
        ctx.slots.register(
          {
            name: "conversation.input.right",
            id: "provider-badge",
            inject: (sessionId) => faceOf(ctx, sessionId),
          },
          ProviderBadge,
        ),
        "provider-badge: composer model-seat badge",
      );
    }

    /** probe 专用面：纯函数与 face 出厂的行为断言（不构成任何运行时承诺）。 */
    const __test = {
      fourLetters, deriveLetters, hash32, ROUTE_COLORS, ROUTE_LABELS, STORAGE_KEY, PALETTE,
      ROUTE_ALIASES, canonicalRouteId, aliasLookup, quotaEntryFor,
      parseColor, relativeLuminance, inkFor, wheelDist, hueSlotsFor, routeIdsOf,
      colorOf, resolveColor, swatchColors, panelPositionFor, loadOverrides, saveOverrides,
      badgeOf, faceOf, UNAVAILABLE, presentationOf,
      BRIDGE_GLOBAL, BRIDGE_EVENT, BRIDGE_VERSION, colorPresentationFor,
      QUICK_MAX_SLOTS, QUICK_STORAGE_KEY, DEFAULT_QUICK_MODELS, QUICK_LABEL_MAX,
      quickLabelOf, normalizeQuickModels, defaultQuickModels, loadQuickModels, saveQuickModels, quickStatusOf,
      selectionFor, cascadePlacementFor, providerIndexByPrefix, nextEnabledIndex, providerRowsOf,
      shouldCloseOnScroll,
      QUOTA_ENDPOINT, QUOTA_CLIENT_TTL_MS, QUOTA_TONES, quotaCache,
      formatWindowSpan, formatCountdown, quotaWindowsOf, quotaTextOf, quotaInlineTextOf, quotaFailureOf, quotaTitleOf, quotaToneOf,
      formatMoney, extraUsageParts, CURRENCY_SYMBOLS,
    };

    exports.apply = apply;
    exports.inject = inject;
    exports.__test = __test;
    return module.exports;
  },
});
