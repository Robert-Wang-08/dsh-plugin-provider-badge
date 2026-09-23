/**
 * dsh-plugin-provider-badge — 客户端半（client.js）
 *
 * 在会话输入框下方工具行的 `conversation.input.right` 席位（list、session
 * 作用域、官方零占用）注册一个纯展示条目，渲染在模型席位
 * （`conversation.input.model`，模型名 + 推理等级）正前方：
 *
 *   [AGLM] my-model ▾   ···   [发送]
 *    ↑
 *    provider 徽标（4 字母：多词取各词首字母，不足补尾字母；黑体白字、
 *    高区分度调色板底色——可见 provider 集合内均匀铺槽拉开色距）
 *
 * - 文本：provider 显示名（Host 目录 groups[].name）优选，缺失回退路由 id
 *   同规则；仅字母数字，不含符号/括号/减号。
 * - 颜色：12 槽调色板（刻意只留 2 个蓝段），按可见 provider 集合均匀铺槽
 *   （排序第 i 落 floor(i×12/n)），集合内两两色距有下限；同集合内同路由
 *   恒同色。
 * - 数据：官方共享目录 store（ctx.modelDirectories），useSyncExternalStore
 *   订阅，会话切换模型/路由即时跟随；仅 status==="idle" 时触发一次官方
 *   load()（官方自带去重）。
 * - 降级：modelDirectories 未装载 / directoryFor 抛错 / subagent 转址会话 /
 *   无当前选择 → 渲染 null，不报错不占位。
 *
 * 零写入：不写 settings、不持凭据、不发变更请求；不反映运行期故障转移
 * 重路由（与官方模型席位同口径，反映会话选择）。
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
     * 调色板（v2）：12 个色相槽均匀铺轮、刻意只留 2 个蓝段（218/248），并配
     * 不同的饱和/明度，白字黑体均有对比度；槽间由分配算法保证距离。
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

    /** 路由 id → 调色板颜色（基于快照内可见集合的均匀铺槽分配）。 */
    function colorOf(routeId, state) {
      const slots = hueSlotsFor(routeIdsOf(state));
      const slot = slots.get(routeId);
      return PALETTE[slot !== undefined ? slot : hash32(routeId) % PALETTE.length];
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
      const text = deriveLetters(displayName, routeId);
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
      color: "#fff",
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

      useEffect(() => {
        if (typeof face.load === "function") face.load();
      }, [face.load]);

      const badge = badgeOf(state);
      if (badge === null) return null;
      const style = { ...BADGE_BASE_STYLE, background: colorOf(badge.routeId, state) };
      return h("span", { style, title: badge.title }, badge.text);
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
    const __test = { fourLetters, deriveLetters, hash32, PALETTE, wheelDist, hueSlotsFor, routeIdsOf, colorOf, badgeOf, faceOf, UNAVAILABLE };

    exports.apply = apply;
    exports.inject = inject;
    exports.__test = __test;
    return module.exports;
  },
});
