/**
 * dsh-plugin-provider-badge — 客户端半（client.js）
 *
 * 在会话输入框下方工具行的 `conversation.input.right` 席位（list、session
 * 作用域、官方零占用）注册一个纯展示条目，渲染在模型席位
 * （`conversation.input.model`，模型名 + 推理等级）正前方：
 *
 *   [AGLM] my-model ▾   ···   [发送]
 *    ↑
 *    provider 徽标（4 字母：多词取各词首字母，不足补尾字母；黑体 + 按底色
 *    对比度选字色；有表路由用固定色，其余走可见集合均匀铺槽调色板）
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
 * - 降级：modelDirectories 未装载 / directoryFor 抛错 / subagent 转址会话 /
 *   无当前选择 → 渲染 null，不报错不占位。
 * - 交互：点徽标弹出选色面板（当前路由六默认色 + 12 槽调色板，fixed 定位，
 *   点外部关闭）；选色优先级 用户覆盖 > ROUTE_COLORS 表 > 自动调色板。
 *
 * 唯一写入：点徽标选色写浏览器 localStorage（key 见 STORAGE_KEY，按路由 id，
 * 可恢复为自动配色）；不写 settings、不持凭据、不发变更请求；不反映运行期
 * 故障转移重路由（与官方模型席位同口径，反映会话选择）。
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
        };
      } catch (_) {
        return UNAVAILABLE;
      }
    }

    /* ── 组件 ─────────────────────────────────────────────────────── */

    const noopSubscribe = () => () => {};
    const snapshotNull = () => null;
    const serverSnapshotNull = () => null;

    const BADGE_BASE_STYLE = {
      display: "inline-flex",
      alignItems: "center",
      height: "16px",
      padding: "0 5px",
      borderRadius: "4px",
      fontWeight: 700,
      fontSize: "10px",
      lineHeight: "16px",
      letterSpacing: "0.02em",
      userSelect: "none",
      flex: "none",
    };

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
      // 用户选色覆盖通过 lazy 初值只读取一次 localStorage；面板开启状态无持久化。
      const [overrides, setOverrides] = useState(loadOverrides);
      const [panel, setPanel] = useState(null);

      useEffect(() => {
        if (typeof face.load === "function") face.load();
      }, [face.load]);

      // 点面板或徽标以外的位置关闭面板；徽标自身的开合交给 onClick toggle。
      useEffect(() => {
        if (typeof document === "undefined") return;
        const closeOnOutside = (event) => {
          if (event !== null && typeof event === "object"
            && event.target !== null && typeof event.target.closest === "function"
            && event.target.closest("[data-provider-badge-picker], [data-provider-badge-root]") !== null) return;
          setPanel(null);
        };
        document.addEventListener("mousedown", closeOnOutside);
        return () => document.removeEventListener("mousedown", closeOnOutside);
      }, []);

      const badge = badgeOf(state);
      if (badge === null) return null;
      const background = resolveColor(badge.routeId, state, overrides);
      const style = {
        ...BADGE_BASE_STYLE,
        background,
        color: inkFor(background),
        cursor: "pointer",
        position: "relative",
      };

      const openPanel = (event) => {
        if (event !== null && typeof event === "object" && typeof event.stopPropagation === "function") {
          event.stopPropagation();
        }
        if (panel !== null) { setPanel(null); return; }
        let position = { left: 0, top: 0 };
        try {
          const rect = event !== null && typeof event === "object" && event.currentTarget !== null
            ? event.currentTarget.getBoundingClientRect()
            : undefined;
          const viewport = typeof window !== "undefined"
            ? { width: window.innerWidth, height: window.innerHeight }
            : undefined;
          position = panelPositionFor(rect, viewport);
        } catch (_) { /* 无 DOM 环境不做定位；面板落在 (0,0) 不影响逻辑 */ }
        setPanel(position);
      };

      const pick = (color) => {
        const next = { ...overrides };
        if (color === null) delete next[badge.routeId];
        else next[badge.routeId] = color;
        saveOverrides(next);
        setOverrides(next);
        setPanel(null);
      };

      const panelEl = panel === null
        ? undefined
        : h("div",
          {
            "data-provider-badge-picker": true,
            role: "listbox",
            "aria-label": badge.title,
            style: {
              position: "fixed",
              zIndex: 1200,
              minWidth: "160px",
              padding: "8px",
              borderRadius: "12px",
              background: "var(--dsw-specific-menu, #20242b)",
              boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              left: panel.left,
              top: panel.top,
            },
          },
          h("div",
            { style: { display: "flex", gap: "6px", flexWrap: "wrap", maxWidth: "232px" } },
            swatchColors().map((color) => h("button", {
              type: "button",
              key: color,
              title: color,
              "aria-label": color,
              style: {
                width: "20px", height: "20px", padding: "0", borderRadius: "5px",
                border: "1px solid rgba(255, 255, 255, 0.22)", background: color, cursor: "pointer",
              },
              onClick: () => pick(color),
            }, null)),
          ),
          h("button", {
            type: "button",
            style: {
              alignSelf: "flex-start", padding: "2px 4px", border: "none", borderRadius: "6px",
              background: "transparent", color: "inherit", font: "inherit", fontSize: "12px",
              cursor: "pointer",
            },
            onClick: () => pick(null),
          }, Object.prototype.hasOwnProperty.call(overrides, badge.routeId) ? "恢复自动配色" : "自动配色"),
        );

      const badgeEl = h("span", {
        style,
        title: badge.title,
        "data-provider-badge-root": true,
        onClick: openPanel,
      }, badge.text);
      return panelEl === undefined ? badgeEl : [badgeEl, panelEl];
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
    };

    exports.apply = apply;
    exports.inject = inject;
    exports.__test = __test;
    return module.exports;
  },
});
