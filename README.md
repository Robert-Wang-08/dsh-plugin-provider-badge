# dsh-plugin-provider-badge 说明

DSH Web GUI（`dsh web`，默认 `http://127.0.0.1:3080`）增强插件：在会话输入框下方的「模型及推理等级」选择器正前方渲染一个 **provider 徽标**。

```
[AGLM] my-model ▾   ···   [发送]
  ↑
  provider 徽标（4 字母，黑体；白字优先浅底改深墨；点徽标可选色）
```

## 行为

| 维度 | 语义 |
| --- | --- |
| 位置 | `conversation.input.right` 席位（官方零占用的 list 席位），渲染在模型席位正前方，间距走 `.trailing` 既有 `gap:12px` |
| 文本 | 缩写覆盖表优先（`client.js` 顶部 `ROUTE_LABELS`）：`deepseek-official`→`ds官`、`codex-relay`→`a1gpt`、`openai-codex`→`gpt官`、`anthropic-relay`→`claude`、`opencode-go`→`opengo`、`kimi-coding`→`kimi官`（覆盖可超 4 字符）；未入表路由（含 `ais-2dsglm`）仍自动推导 4 字母：优选 Host 目录 `groups[].name`（provider 显示名），按非字母数字 + 汉字/拉丁交界切词后取各词首字母，不足补尾字母（如 `Alpha One`→`AOne`、`providerlongname`→`prov`、`智谱GLM`→`智GLM`）；显示名缺失回退路由 id 同规则（`provider-alpha`→`palp`）；仅字母数字，无符号/括号/减号；字色白字优先，白字对比度不足（<3）时改用深墨 `#14212B` |
| 颜色 | 优先级：用户点选（localStorage）> `ROUTE_COLORS` 默认表 > 12 槽自动调色板；默认六色：`anthropic-relay`→`#E0501E`（橙红）、`codex-relay`→`#2F6FEB`（蓝）、`ais-2dsglm`→`#8ECDF7`（浅蓝）、`openai-codex`→`#2E9E5B`（绿）、`kimi-coding`→`#A7E0A9`（浅绿）、`opencode-go`→`#7CB342`（草绿）；未点选且未入表的仍走 12 槽自动调色板（刻意只留 2 个蓝段）+ 按可见 provider 集合均匀铺槽（排序第 i 落 `floor(i×12/n)`），集合内两两色距 ≥60°（n≤6）；改默认只改 `client.js` 顶部 `ROUTE_COLORS` |
| 交互 | 点徽标弹出选色面板（六默认色 + 12 槽色块 + `恢复自动配色`），fixed 定位、点外部关闭；面板自适应位置：优先按钮下方，下方空间不足自动翻到上方，水平/垂直均夹取在视口内（`panelPositionFor`）；选色写入浏览器 localStorage（键 `dsh-plugin-provider-badge:colors`），重开/刷新后保持；`恢复自动配色` 清除该路由覆盖 |
| 悬停 | title 显示 `显示名 (路由id)`（无显示名时仅路由 id） |
| 跟随 | 数据来自官方共享目录 store（`ctx.modelDirectories`，与模型席位/`/model` 弹层同源），会话内切换模型/路由即时跟随 |
| 降级 | subagent 转址会话、`modelDirectories` 未装载、目录解析抛错、无当前选择 → 渲染为空，不报错不占位 |

## 明确非目标

- **不反映运行期故障转移重路由**：分档切换对 UI 透明是既有设计；徽标与官方模型席位同口径，反映**会话选择**的 provider。
- 不写 settings、不持凭据、不发起任何变更类请求；唯一本地写入是 `localStorage` 选色（每路由可恢复自动配色）。
- 不遮蔽任何官方席位；官方模型选择器行为零改变。

## 安装（挂载到 profile）

```powershell
# 1. profile 依赖（%USERPROFILE%\.dsh\profiles\web\package.json）
#    dependencies 增加：
"dependencies": {
  "dsh-plugin-provider-badge": "link:<本仓库绝对路径>",
  "...": "..."
}
# 2. dsh.profile.bundles 数组增加 "dsh-plugin-provider-badge"
# 3. pnpm install（或重启时让 dsh 解析 link 依赖）
# 4. 重启 dsh web + 浏览器硬刷新
```

插件自带 `cordis.patch.yml`（经 `dsh.bundle.patch` 插入 host 载体行 `provider-badge`），无需手改 profile 的 cordis.patch.yml。

## 卸载

从 profile `package.json` 移除依赖与 bundle 清单条目，重启 `dsh web` 即可；如需一并清理本地选色，在浏览器开发者工具 Application → Local Storage 删除键 `dsh-plugin-provider-badge:colors`。

## 验证

```powershell
node probe/smoke-client.mjs   # 交付形状 + 推导纯函数 + face 降级（期望 ALL PASSED）
```

真机清单（重启 + 硬刷新后）：

1. 模型席位左侧出现 4 字母徽标，路由不同颜色不同且区分度大；
2. 确认六条路由色表底色：`anthropic-relay` 橙红、`codex-relay` 蓝、`ais-2dsglm` 浅蓝、`openai-codex` 绿、`kimi-coding` 浅绿、`opencode-go` 草绿；浅色底上字色为深墨、深色底上为白；
3. 点击徽标弹出选色面板：选色即时生效；刷新页面后颜色保持；点 `恢复自动配色` 回默认表/自动调色板；
4. 悬停 title 显示 `显示名 (路由id)`；
5. 会话内切换模型/路由，徽标即时跟随；
6. subagent 会话无徽标；空白会话（hero 态）无徽标；
7. 手动触发一次故障转移后徽标仍显示会话选择的路由（非目标确认）。

## 实现备注

- **cordis 注入权限模型（踩过一次的坑）**：插件 `exports.inject` 决定 apply 作用域能访问的服务树；本插件需 `["slots", "sessions", "modelDirectories", "remote", "remote.session"]` —— 缺 `remote`/`remote.session` 时 `modelDirectories.directoryFor()` 内部访问 `this.ctx.remote.session` 会抛 `cannot get property "remote.session" without inject`，且被降级路径吞掉表现为「无报错 + 无徽标」。先例：官方 model-selection 的 inject 同样声明 `remote`/`remote.session`。
- 交付为手写 CJS + `window.__ModuleLoader__.load({id, factory})` 包装的 classic script（先例：`dsh-deepseek-keypool/client.js`）；**任何模块级 import/export 会炸掉整个 `/plugins` combo**，改动后必须跑 `node probe/smoke-client.mjs`。
- 零 npm 依赖、零构建步骤；`require` 白名单仅 `react`。
- 席位契约证据（宿主 0.1.5-rc.2）：`dsh-client-ui-conversation/lib/client.js`（渲染顺序）、`dsh-cordis-client-runner/lib/client.js`（registerOptions 与零占用）、`dsh-client-ui-model-selection/lib/client.js`（数据接入先例）。
- 过程与 OpenSpec 文档（`openspec/`、`build_output_index.md`）保留在本地工作区，不入库（见 `.gitignore`）。

## 宿主兼容性（2026-09-23 复查：dsh 0.1.5-rc.3 + dsh-permission-compat）

宿主升级 `0.1.5-rc.2 → rc.3`（npm latest）并打上全局 `dsh-permission-compat` 沙箱补丁（改 `dsh-sandbox` + 三个工具守卫）后复查，**本插件零改动可用**：

- 与补丁无关：源码与构建产物不引用 `sandbox_permissions` / `justification` / `approveEscalation` 等提权 API（grep 零命中）；宿主半只有一行日志。
- 与 rc.3 无关：挂接插槽 `conversation.input.right` 在 rc.3 内核原样存在（`dsh-client-ui-conversation/lib/client.js`）；对 13 个宿主包做 rc.2↔rc.3 发布包逐文件 MD5 对比，仅 `dsh-client-ui-sidebar` 有一行版本号显示串差异，其余只有 package.json 版本号，插槽契约无变化。
- 复查记录见 vault `70-WorkSpace/dsh工具维护日志.md` 2026-09-23 条目；复装说明见 `70-WorkSpace/dsh复装说明.md`。
