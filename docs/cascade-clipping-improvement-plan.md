# 级联右侧遮挡改进方案（cascade-clipping improvement plan）

> 状态：**已实施**（2026-10-19，C-3 拍板为「翻转模型列」并落地；实施记录见文末 §10）
> 基线：宿主 `0.2.0-rc.2`；本仓库 `dsh-plugin-provider-badge`（web profile `link:` 登记）
> 证据行号以实施前工作区状态（HEAD `e00acd9` + 额度失败提示未提交改动）为准。

## 1. 问题现象

点徽标打开的两级级联（provider 列 260px + 模型列 236px，向右展开，总宽 502px）
在徽标位于屏幕右侧时打开，弹出层被遮挡/裁剪。徽标挂在
`conversation.input.right` 席位、处于 composer 尾行右端，所以**每次打开天然都在
屏幕右侧区域**，问题稳定复现。

## 2. 现状实现（证据）

| 位置 | 现状 |
| --- | --- |
| `client.js:604-653` `cascadePositionFor` | **打开前**按常量预算定位：宽 `260+6+236=502`、高 `340`；水平策略「模型列恒在右 → 整体左移 → 收窄（provider 下限 132px）→ clamp 视口 8px」，**不翻左**；垂直「上 → 下 → clamp」 |
| `client.js:1085-1106` `openCascade` | 用 `event.currentTarget.getBoundingClientRect()` + `window.innerWidth/innerHeight` 一次性算死，此后不重算 |
| `client.js:1503-1519` cascadeEl | `position:fixed; left/top; z-index:1200`，作为 **slot 子树内元素**渲染（非 portal） |
| `client.js:1015-1024` | 页面 scroll / 窗口 resize **直接关闭**（README 既有设计，避免 fixed 锚点漂移） |
| `client.js:1002-1013` | 外点关闭：`event.target.closest("[data-provider-badge-cascade],[data-provider-badge-root]")` —— **data 属性判定，不依赖 DOM 父子关系** |
| `client.js:1246 / 1508` | keydown 同时挂徽标与级联；焦点模型 = 徽标持焦 |
| `client.js:41-53` | 交付形状：CJS + `window.__ModuleLoader__.load`，`require("react")` 取 hooks，**无模块级 import** |

官方侧参照（宿主 0.2.0-rc.2）：

- 同一尾行的官方 ContextMeter（`dsh-client-ui-conversation/lib/client.js:16997`）
  **不手算坐标**：用 `useAnchoredPosition({side:"top",gap:8,margin:12})`——
  打开后实测 `panel.offsetWidth/offsetHeight` → clamp → `scroll`(capture)/`resize`
  重算 → `ResizeObserver` 观察面板尺寸变化再重算。面板 `position:fixed; z-index:1100`。
- 官方外点关闭 `useDismissOnOutsidePointer(root, open, setOpen, portal)` 原生支持
  portal 到 body 的面板。
- app shell（`dsh-web-frontend/dist/assets/index-*.css`）存在
  `transform: translate(±100%)`、`translateY(-50%)`、`translate(calc(var(--dsh-segment-index)*...))`
  等规则；composer 周边 dock 面板（`_7yHdaG_panel`、`lXshSW_root`）大量使用
  `overflow:hidden` + `backdrop-filter`。

## 3. 根因分析（按可能性排序）

### A. `position:fixed` 包含块被祖先劫持（最可能）

级联是 `position:fixed`，但渲染在 composer slot 子树**内部**。CSS 规定：任一祖先出现
`transform` / `filter` / `backdrop-filter` / `will-change` / `contain` / `zoom≠1`
之一，fixed 元素的包含块就从视口变成该祖先。此时打开前按**视口坐标**算出的
`left/top` 被按**祖先坐标**解释 → 面板整体错位；再叠加祖先 `overflow:hidden` →
右缘被裁掉。这与「向右展开在右侧被遮挡」的现象吻合。

静态检查 composer 直系链（`.uV2eYG_root/.uV2eYG_dock/.uV2eYG_card/.uV2eYG_trailing`）
当前无这些属性，但 shell 层的滑入动画（`translate(±100%)`）、字体缩放（zoom）、
主题切换等运行时状态无法静态排除——宿主样式一变即触发，插件不该赌这条链永远干净。

### B. 滚动条宽度口径误差（次要）

`window.innerWidth` **含**竖向滚动条（约 15–17px），而 fixed 定位坐标系**不含**。
`left = innerWidth - 8 - 502` 会把面板右缘推进滚动条带，造成小规模裁剪。

### C. 窄/矮窗口几何退化（边缘情况）

数字验证：视口宽 ≥ 390px 时收窄逻辑保证 `totalWidth ≤ width-16`，不溢出；
< 390px 时模型列被压到不可用；视口高 < 356px 时面板底部伸出视口不可达。
常规窗口下纯几何不会裁剪——**反证主因不是 C，而是 A**（B 贡献约 17px）。

## 4. 实施前 5 分钟二分验证（确认根因编号）

打开级联处于被遮挡状态时，DevTools：

1. 选中 `[data-provider-badge-cascade]`，沿祖先逐级查 Computed 面板的
   `transform / filter / backdrop-filter / will-change / contain / zoom`——
   命中非 initial 值 ⇒ 坐实 **A**。
2. 对比 Elements 里 `style.left` 数值与实际渲染 x 坐标——不一致 ⇒ **A**。
3. 若一致且右缘只差 ~17px ⇒ **B**。

## 5. 改进方案

### 推荐：方案 C = Portal + 实测定位 +（可选）右缘翻转

#### C-1 级联 portal 到 `document.body`（根治 A）

- `cascadeEl` 用 `createPortal(...)` 挂到 `document.body`，脱离 composer 子树。
- `require("react-dom")` 取 `createPortal`——**实现第一步先验证** ModuleLoader 的
  require 表是否提供 `react-dom`；不可用则降级为受控 DOM move（open 时
  `body.appendChild(cascadeRef.current)`、close 时摘除）。
- 两个 data 属性原样保留 ⇒ 外点关闭（`:1002-1013` closest 判定）与
  「弹层内滚动不关闭」（`shouldCloseOnScroll` 判定 data 属性）**零改动**。
- z-index 维持 1200（> 官方 ContextMeter 的 1100），portal 后才真正成为全局层序。

#### C-2 打开后实测定位（根治 B + 一切尺寸估计误差，官方同口径）

- 内联一个小 hook `useAnchoredCascadePosition(open, anchorRef, cascadeRef)`
  （仿官方 `useAnchoredPosition`，因插件是 classic script 不能 import）：
  - `useLayoutEffect` 中读 `cascadeRef.current.offsetWidth/offsetHeight`
    **实测**两列总宽/总高，覆盖首帧预算（`cascadePositionFor` 保留为首帧预估，
    避免首帧闪跳）；
  - 水平 clamp 改用 `document.documentElement.clientWidth`（**排除滚动条**，修 B）；
  - `ResizeObserver` 观察面板：额度文本异步到达、色板视图切换导致面板变宽时自动重排；
  - 页面 scroll / 窗口 resize **维持现有「直接关闭」策略**（README 既有设计，
    不引入重排漂移问题）。
- 新增纯函数 `cascadePlacementFor(anchorRect, viewport, panelW, panelH)` 承载
  实测后的 clamp + flip 判定，导出进 `__test` 供 probe 断言。

#### C-3 右缘翻转（**设计决策点，需拍板**）

README 行为表现条款「模型列**始终在右侧**…不翻左」是既有设计。右侧放不下完整两列时：

- **推荐改为翻转**：模型列翻到 provider 列左侧（`flexDirection:row-reverse`），
  provider 列仍锚在徽标旁——标准级联菜单行为；键盘 `ArrowRight/ArrowLeft`
  进出模型列的方向映射随 `isFlipped` 状态取反。
- 若坚持「不翻左」：退守为「整体左移 + 实测收缩」，但把 provider 下限 132 → 180、
  模型列下限 160，避免压扁不可读；极窄窗口接受 clamp（现状行为）。

### 备选（更小步）

| 方案 | 内容 | 适用 |
| --- | --- | --- |
| A′ | 仅 `clientWidth` 口径 + 打开后实测一次校正 | 最小改动；根因是 A 时**无效** |
| B′ | 仅 portal（C-1） | 根治 A；额度文本异步变宽时仍可能溢出（概率低） |

C 与 A′/B′ 工作量差异不大（预计 client.js 净增 ~120–180 行 + probe 用例），推荐直接 C。

## 6. 改动点清单

| 文件 | 位置 | 改动 |
| --- | --- | --- |
| `client.js` | `:47-53` require 区 | `+useLayoutEffect`（useRef 已有）、`require("react-dom")` 取 `createPortal`（验证失败走 DOM move 降级） |
| `client.js` | `:604-653` | `cascadePositionFor` 保留为首帧预估；新增纯函数 `cascadePlacementFor`（实测 clamp + flip） |
| `client.js` | ProviderBadge `:948-956` 附近 | `cascadeRef` + `useAnchoredCascadePosition` + `isFlipped` 状态 |
| `client.js` | `:1503-1519` cascadeEl | portal 包裹；`flexDirection` 随 flip 取反 |
| `client.js` | `:1551-1560` `__test` 面 | 导出 `cascadePlacementFor` |
| `probe/smoke-client.mjs` | 定位用例区 | 新增：翻转用例、`clientWidth` 口径用例、极窄/矮窗口 clamp 用例 |
| `README.md` | 行为表 `:25`、非目标节 | 更新「不翻左」条款、portal 与实测定位说明、scroll/resize 关闭语义复核 |

## 7. 兼容性与回归风险

- **交付形状硬契约**：client.js 保持 CJS + `window.__ModuleLoader__.load` 包装、
  无模块级 import；新增 `require` 必须在 load 函数体内（先例 `:47`）。
- **外点关闭 / 内滚不关闭**：已核实均为 data 属性 closest 判定（`:1002-1013`、
  `shouldCloseOnScroll`），portal 后零影响。
- **键盘与焦点**：徽标持焦模型不变；选型成功后焦点回徽标（`:1151-1155`）不变；
  flip 后方向键映射取反是唯一键盘行为变化。
- **额度 / 选色 / 模型选择逻辑**：零改动。
- **登记状态**：改动仅在本仓库内，`link:` 登记与 profile 配置零变化，
  无需 `dsh plugin add`。

## 8. 验收清单（改完必做）

1. 重启 DSH + **新开会话** + 浏览器硬刷新；启动日志无 `did not activate`。
2. 宽窗口（≥1600）：级联贴徽标完整可见；中窗口（~1200）：右缘不裁剪；
   窄窗口（~700）：模型列仍 ≥160px 可读；矮窗口（~500 高）：底部行可达。
3. 级联内滚动不关闭；页面滚动 / resize 关闭；`Esc` / 外点关闭。
4. 键盘全流程（含 flip 后 `ArrowRight/Left` 方向语义）。
5. 额度文本异步到达、色板视图切换：面板尺寸变化后位置自适应（ResizeObserver 生效）。
6. `probe/smoke-client.mjs` 全绿；`dsh plugin --profile web list` 登记不变。

## 9. 实施顺序

1. 备份：跑 `dsh-backup-restore` 的 backup（或至少对 `client.js` /
   `README.md` / `probe/smoke-client.mjs` 做 `.bak-before-cascade-<时间戳>` 副本，
   本机既有惯例）。
2. §4 二分验证，确认根因编号（决定 C-3 走推荐翻转还是退守收缩）。
3. C-1 → C-2 → C-3 实施，probe 同步补用例。
4. §8 验收通过后 git commit；README 行为表同步更新。

## 10. 实施记录（2026-10-19）

- 拍板：C-3 走**翻转**（用户确认「c-3」）。
- 备份：`*.bak-before-cascade-20261019-1135`（client.js / README.md /
  probe/smoke-client.mjs；probe 目录当时缺「取得所有权」权限导致备份被拒，
  经 `diagnose-windows-sandbox-acl` 修复后补齐，恢复脚本在
  `D:\src\dsh\.acl-recovery\`）。
- `require("react-dom")` 可用性：已核实宿主加载器静态模块表
  （dsh-web-frontend `staticModules`）含 `react-dom`，createPortal 直接可用；
  client.js 仍保留 try/catch 降级（无 react-dom → 内联渲染）。
- 实际落地与 §5 的偏差：
  - `cascadePositionFor` **整体替换**为 `cascadePlacementFor`（估算与实测共用
    同一纯函数，含翻转判定与 clientWidth 口径），未保留旧函数；
  - 翻转锚定采用「容器右缘对齐徽标右缘」（未翻转是「左缘对齐徽标左缘」的镜像），
    而非 §5.3 初稿的「provider 列仍锚在徽标旁」；
  - 实测重排用 `useLayoutEffect` + `ResizeObserver`，重排输入为徽标实时 rect
    + 容器实测 `offsetHeight`；页面滚动/resize 关闭行为未改；
  - probe S8 定位用例按新函数重写（新增翻转 / clientWidth / 单列 /
    两侧不足用例），S9 require 白名单扩为 `react` + `react-dom`，
    新增 createPortal 交付形状断言。
- 验证：`node probe/smoke-client.mjs` → **ALL PASSED (207 checks)**。
- 待验收（需用户操作）：重启 DSH web + 浏览器硬刷新后按 §8 清单核对。

### 10.1 抖动修正（同日二次迭代）

用户实测：可选模型超过面板长度时，鼠标停在 provider 上整体抖动。

- 根因：§10 落地的「挂载后实测重排（`useLayoutEffect` + `ResizeObserver`）」
  引入反馈回路——悬停不同 provider 时模型列高度变化（超长列表被 maxHeight
  340 截断 ↔ 短列表几十像素）→ 容器实测高度变 → 重排搬动整个弹层 → 行在
  静止光标下移动 → 浏览器对静止光标补发 `mouseenter` → hover 到另一
  provider → 高度再变 → 循环。官方 ContextMeter 没有这个问题，因为它的面板
  尺寸不随悬停内容变化。
- 修正：**删除实测重排**（effect / RO / `cascadeRef` 全部移除），定位回到
  「只在打开时计算一次」：垂直按 `CASCADE_PANEL_HEIGHT(340)` 预留（面板
  maxHeight 上限，悬停切换不会超出，预留即最坏情况的精确预算），水平恒按
  两列满预算（260+6+236）+ `clientWidth`——即使打开时当前行无模型也预留，
  后续悬停弹出模型列时位置已就绪。portal（C-1）、翻转（C-3）、clientWidth
  口径三个根因修复全部保留。
- 教训：官方 `useAnchoredPosition` 的「实测 + 重排」适用于**尺寸稳定**的
  面板；内容随交互变化的弹层（级联菜单）重排会与 hover 系统形成回路，
  打开时一次定位 + 最坏情况预留才是稳定解。
- 验证：`node probe/smoke-client.mjs` 全绿（断言面未变，
  `cascadePlacementFor` 纯函数语义未动）。

### 10.2 超长列表的可达性补丁（同日三次迭代）

问：列表超过 340px 面板上限怎么办？答：**面板内部滚动**（`overflowY: auto`
+ 滚轮/滚动条，弹层内滚动不关闭）——既有行为，未变。排查时发现一个真实边角：
**视口高度 < 356px**（分屏小窗）时，垂直 clamp 会把面板下缘推出视口，内部
滚动条在屏幕外，**列表尾部不可达**。

- 修正：`cascadePlacementFor` 把预留高度收缩到视口内
  （`panelMaxHeight = max(120, min(340, innerHeight - 16))`）并返回，三处
  面板（色板 / provider 列表 / 模型列）样式用返回值覆盖 `maxHeight`。
  仍在打开时一次算完，无重排回路。
- probe 新增两条断言（矮视口收缩 / 正常视口保持 340），209 项全绿。
