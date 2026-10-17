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
 * - 级联：点徽标（或 Enter/Space/方向键）打开两级向右级联菜单：一级只列
 *   provider（成功行 + 失败 disabled 行），悬停/首字母选中 provider 后右侧
 *   二级列该 provider 的模型（模型列**始终在右侧**，右侧空间不足整体左移并
 *   收窄，不翻左）。选择复用同一 ModelDirectory.select（官方同口径
 *   selectionOf），失败保持菜单并显示 localError。官方 /model 弹窗与
 *   composer 模型席位零改变。
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
      if (typeof routeId === "string" && Object.prototype.hasOwnProperty.call(ROUTE_COLORS, routeId)) {
        return ROUTE_COLORS[routeId];
      }
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
     * 级联菜单定位（spec §3/§7）：providerWidth 260、modelWidth 236、gap 6、
     * panelHeight 340、视口边距 8。
     * 模型列**始终位于 provider 右侧**（列顺序不翻转）：水平按两列总宽定位，
     * 右侧空间不足时整体容器左移；仍不足则按视口宽度收窄（provider 最窄约
     * 132px、model 取剩余宽度并在 CSS 端 ellipsis），最终整体夹取在视口 8px
     * 边距内。绝不返回左侧模型列（不翻左）。
     * 垂直：优先锚点上方（composer 多在底部），上方不足才下方，最终 clamp。
     * 默认列宽与 CASCADE_PROVIDER_WIDTH / CASCADE_MODEL_WIDTH 同值（一处改名两处改）。
     * @param anchor - 徽标视口矩形（至少 left/top/bottom），缺失时安全回退 0。
     * @param viewport - { width, height }，缺失/非法时按 0 处理。
     * @returns { left, top, totalWidth, providerWidth, modelWidth }：整个级联
     *   容器（两列并排）的 fixed 原点与各列宽度。
     */
    function cascadePositionFor(anchor, viewport, providerWidth, modelWidth, gap, panelHeight) {
      const w1 = typeof providerWidth === "number" ? providerWidth : 260;
      const w2 = typeof modelWidth === "number" ? modelWidth : 236;
      const g = typeof gap === "number" ? gap : 6;
      const ph = typeof panelHeight === "number" ? panelHeight : 340;
      const margin = 8;
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

      // 垂直：优先上方，其次下方，最后夹取。
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

      // 水平：两列总宽。右侧不足整体左移；仍不足按视口收窄（模型列仍在右）。
      let pw = w1;
      let mw = w2;
      if (width > 0 && pw + g + mw > width - margin * 2) {
        const available = width - margin * 2;
        pw = Math.max(0, Math.min(w1, Math.max(132, available - g - mw)));
        mw = Math.max(0, Math.min(w2, available - g - pw));
      }
      const totalWidth = pw + g + mw;
      let left;
      if (width > 0) {
        left = leftAnchor;
        if (left + totalWidth > width - margin) left = width - margin - totalWidth;
        left = Math.max(margin, Math.min(left, width - totalWidth - margin));
      } else {
        left = leftAnchor;
      }
      return { left, top, totalWidth, providerWidth: pw, modelWidth: mw };
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
      const override = Object.prototype.hasOwnProperty.call(ROUTE_LABELS, routeId)
        ? ROUTE_LABELS[routeId] : null;
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
    // cascadePositionFor 的收窄分支。
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
      };

      const openCascade = (event) => {
        if (event !== null && typeof event === "object" && typeof event.stopPropagation === "function") {
          event.stopPropagation();
        }
        if (cascade !== null) { closeCascade(); return; }
        let position = {
          left: 0,
          top: 0,
          totalWidth: CASCADE_PROVIDER_WIDTH + CASCADE_GAP + CASCADE_MODEL_WIDTH,
          providerWidth: CASCADE_PROVIDER_WIDTH,
          modelWidth: CASCADE_MODEL_WIDTH,
        };
        try {
          const rect = event !== null && typeof event === "object" && event.currentTarget !== null
            ? event.currentTarget.getBoundingClientRect()
            : undefined;
          const viewport = typeof window !== "undefined"
            ? { width: window.innerWidth, height: window.innerHeight }
            : undefined;
          position = cascadePositionFor(rect, viewport,
            CASCADE_PROVIDER_WIDTH, CASCADE_MODEL_WIDTH, CASCADE_GAP, CASCADE_PANEL_HEIGHT);
        } catch (_) { /* 无 DOM 环境不做定位；菜单落在 (0,0) 不影响逻辑 */ }
        let idx = rows.findIndex((r) => r.id === currentProviderId && !r.disabled);
        if (idx < 0) idx = nextEnabledIndex(rows, -1, 1);
        const row = idx >= 0 ? rows[idx] : undefined;
        setCascade(position);
        setColorMode(false);
        setActiveProviderId(row !== undefined ? row.id : null);
        setProviderIndex(idx >= 0 ? idx : 0);
        setModelIndex(0);
        setFocusLevel("providers");
        setLocalError(null);
      };

      const pickModel = (group, model) => {
        if (selecting || group === undefined || model === undefined) return;
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
          if (colorMode) setColorMode(false);
          else if (focusLevel === "models") setFocusLevel("providers");
          else closeCascade();
          return;
        }
        if (key === "Tab") return;
        if (colorMode) return;
        const printable = typeof key === "string" && key.length === 1
          && !event.ctrlKey && !event.metaKey && !event.altKey;
        if (focusLevel === "providers") {
          if (key === "ArrowDown") { consume(); moveProvider(1); }
          else if (key === "ArrowUp") { consume(); moveProvider(-1); }
          else if (key === "Home") { consume(); moveProviderEdge("first"); }
          else if (key === "End") { consume(); moveProviderEdge("last"); }
          else if (key === "ArrowRight" || key === "Enter") { consume(); enterModels(); }
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
          else if (key === "ArrowLeft") { consume(); setFocusLevel("providers"); }
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

      // 关闭态只渲染徽标本身（保持原有 span 形状与点击/键盘入口）。
      if (cascade === null) return badgeEl;

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
          { key: "__providers", role: "listbox", "aria-label": badge.title, style: { ...PANEL_BASE_STYLE, width: cascade.providerWidth + "px" } },
          backEl, gridEl, autoEl,
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
          const quotaEntry = quotaRoutes !== null && typeof quotaRoutes === "object"
            && Object.prototype.hasOwnProperty.call(quotaRoutes, row.id) ? quotaRoutes[row.id] : null;
          const quotaText = quotaInlineTextOf(quotaEntry);
          const quotaTone = quotaText !== null ? quotaToneOf(quotaEntry) : null;
          const quotaColor = quotaTone !== null ? QUOTA_TONES[quotaTone] : null;
          const quotaTitle = quotaText !== null ? quotaTitleOf(quotaEntry) : null;
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
        providerPanel = h("div",
          { key: "__providers", role: "listbox", "aria-label": badge.title, style: { ...PANEL_BASE_STYLE, width: cascade.providerWidth + "px" } },
          providerRowEls,
        );
      }

      const panels = [providerPanel];
      if (!colorMode && activeRow !== undefined && activeModels.length > 0) {
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
          { key: "__models", role: "listbox", "aria-label": activeRow.name, style: { ...PANEL_BASE_STYLE, width: cascade.modelWidth + "px" } },
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
          flexDirection: "row",
          gap: CASCADE_GAP + "px",
          letterSpacing: "0",
        },
      }, SPIN_KEYFRAMES, ...panels);

      return [badgeEl, cascadeEl];
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
      parseColor, relativeLuminance, inkFor, wheelDist, hueSlotsFor, routeIdsOf,
      colorOf, resolveColor, swatchColors, panelPositionFor, loadOverrides, saveOverrides,
      badgeOf, faceOf, UNAVAILABLE,
      selectionFor, cascadePositionFor, providerIndexByPrefix, nextEnabledIndex, providerRowsOf,
      shouldCloseOnScroll,
      QUOTA_ENDPOINT, QUOTA_CLIENT_TTL_MS, QUOTA_TONES, quotaCache,
      formatWindowSpan, formatCountdown, quotaWindowsOf, quotaTextOf, quotaInlineTextOf, quotaTitleOf, quotaToneOf,
      formatMoney, extraUsageParts, CURRENCY_SYMBOLS,
    };

    exports.apply = apply;
    exports.inject = inject;
    exports.__test = __test;
    return module.exports;
  },
});
