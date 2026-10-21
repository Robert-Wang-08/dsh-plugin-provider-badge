# dsh-plugin-provider-badge 说明

DSH Web GUI（`dsh web`，默认 `http://127.0.0.1:3080`）增强插件：在会话输入区的「模型及推理等级」选择器正前方渲染一个 **provider 徽标**，并在点开的 provider 级联菜单里为支持的路由显示 **可用额度**（当前为 OpenAI Codex、Kimi、OpenCode Go 三家的窗口用量）。本轮实现与探针基于宿主 `0.2.0-rc.2`。

实际渲染（composer 右下角，绿色 `opengo` 徽标 + 模型选择器）：

![badge-composer](docs/screenshots/badge-composer.png)

```
[AGLM] my-model ▾   ···   [发送]
  ↑
  provider 徽标（4 字母，黑体；白字优先浅底改深墨；点徽标开级联菜单）

级联菜单一级（provider 列，宽 260px）：
  gpt（official）            5h 4% · 7d 35%            >
  Kimi (official)           5h 0% · 7d 100%           >
  OpenCode Go               5h 6% · 7d 36% · 30d 59%  >
                                    ↑
                                    可用额度（仅宿主报告了额度的路由才有；悬停看重置倒计时与套餐）
```

## 行为

| 维度 | 语义 |
| --- | --- |
| 位置 | `conversation.input.right` 席位（官方零占用的 list 席位），渲染在模型席位正前方，间距走 `.trailing` 既有 `gap:12px` |
| 文本 | 缩写覆盖表优先（`client.js` 顶部 `ROUTE_LABELS`）：`deepseek-official`→`ds官`、`codex-relay`→`a1gpt`、`openai-codex`→`gpt官`、`anthropic-relay`→`claude`、`opencode-go`→`opengo`、`kimi-coding`→`kimi官`（覆盖可超 4 字符）；未入表路由（含 `ais-2dsglm`）仍自动推导 4 字母：优选 Host 目录 `groups[].name`（provider 显示名），按非字母数字 + 汉字/拉丁交界切词后取各词首字母，不足补尾字母（如 `Alpha One`→`AOne`、`providerlongname`→`prov`、`智谱GLM`→`智GLM`）；显示名缺失回退路由 id 同规则（`provider-alpha`→`palp`）；仅字母数字，无符号/括号/减号；字色白字优先，白字对比度不足（<3）时改用深墨 `#14212B` |
| 颜色 | 优先级：用户点选（localStorage）> `ROUTE_COLORS` 默认表 > 12 槽自动调色板；默认六色：`anthropic-relay`→`#E0501E`（橙红）、`codex-relay`→`#2F6FEB`（蓝）、`ais-2dsglm`→`#8ECDF7`（浅蓝）、`openai-codex`→`#2E9E5B`（绿）、`kimi-coding`→`#A7E0A9`（浅绿）、`opencode-go`→`#7CB342`（草绿）；未点选且未入表的仍走 12 槽自动调色板（刻意只留 2 个蓝段）+ 按可见 provider 集合均匀铺槽（排序第 i 落 `floor(i×12/n)`），集合内两两色距 ≥60°（n≤6）；改默认只改 `client.js` 顶部 `ROUTE_COLORS` |
| 交互 | 点徽标（或 `Enter`/`Space`/`ArrowDown`/`ArrowUp`）打开两级级联菜单：一级列 provider（成功行 + 失败 disabled 行），鼠标悬停或首字母选中 provider 后，二级列该 provider 的模型；点徽标再次关闭，点外部 / `Escape` / 窗口 `resize` / **页面** `scroll` 关闭（弹层内部滚动列表不关闭，见下）。模型列默认位于 provider 右侧：徽标贴近右缘、右侧放不下完整两列而左侧放得下时**翻转到 provider 左侧**（容器 `row-reverse`，右缘对齐徽标右缘；`ArrowRight`/`ArrowLeft` 进出模型列的方向随翻转取反）；两侧都放不下时整体左移并收窄（provider 最窄约 132px），水平夹取用 `clientWidth`（排除滚动条宽度）在视口 8px 边距内。弹层经 `createPortal` 挂 `document.body`（脱离 composer 子树，规避祖先 transform/overflow 劫持 `position:fixed` 包含块；宿主缺 react-dom 时内联渲染降级）。**定位只在打开时计算一次**（垂直按面板 340px 上限预留、水平按两列总宽 + `clientWidth`，纯函数见 `cascadePlacementFor`），打开后**不再重排**——悬停切换 provider 引起的列表高度变化不搬动弹层，否则弹层跳动会让行在静止光标下移动、浏览器补发 `mouseenter` 形成「高度变化 → 跳动 → 再 hover」的抖动回路 |
| 选色 | 级联一级面板底部「徽标颜色…」动作（旁边显示当前色 swatch）切换到原有色板视图（六默认色 + 12 槽色块 + `恢复自动配色`），`‹ 返回` 回 provider 列表；选色写入浏览器 localStorage（键 `dsh-plugin-provider-badge:colors`），刷新后保持；`恢复自动配色` 清除该路由覆盖 |
| 键盘 | provider 级：`ArrowUp`/`ArrowDown` 循环、`Home`/`End`、`ArrowRight`/`Enter` 进入模型级、`Escape` 关闭、字母数字按 `name`/`id` 前缀循环选中（700ms 输入缓冲）；模型级：`ArrowUp`/`ArrowDown`、`Home`/`End`、`ArrowLeft`/`Escape` 返回并聚焦 active provider、`Enter` 选择 |
| 失败 | 选择失败时面板**保持打开**并在一级面板内显示错误（`session/writer-held` → `会话正被其他 DSH 占用`；否则 `result.error.message` / `state.error` / `模型切换失败`）；选择成功关闭级联并把焦点交回徽标；选择进行中不允许重复提交，但 `Escape` 仍可关闭 |
| 悬停 | title 显示 `显示名 (路由id)`（无显示名时仅路由 id） |
| 跟随 | 数据来自官方共享目录 store（`ctx.modelDirectories`，与模型席位/`/model` 弹层同源），会话内切换模型/路由即时跟随 |
| 额度 | 宿主半的 `GET /provider-badge/quota` 报告可用额度时，在该 provider 行右侧渲染 `5h 4% · 7d 35% · 重置 3h29m`（**已用**百分比 + 最紧窗口剩余重置时间，10px、tabular-nums、不收缩），悬停显示每个窗口的完整倒计时：`5h 已用 4%，3h29m后重置 · 7d 已用 35%，5d6h后重置 · 套餐 plus`（有额外余额时追加余额）。窗口标签按窗口**时长**判定（18000→`5h`、604800→`7d`、2592000→`30d`），不按上游 primary/secondary 角色，也**不限窗口个数**；数值 ≥70% 转琥珀、≥90% 或已达上限转红（按最紧的窗口定级）。取数在**打开级联时**触发（客户端缓存 25s、宿主上游缓存 60s）；认证失效显示 `额度需登录`，未配置显示 `额度未配置`，其它上游失败显示 `额度不可用`，均不影响模型选择。已接入数据源：`openai-codex`（5h/7d，含套餐名）、`kimi-coding`（5h/7d + 账单段）、`opencode-go`（5h/7d/30d 三窗口）；浏览器半按行 id 命中整表条目 |
| 账单段 | 条目带 `extraUsage`（当前只有 Kimi）时，悬停说明**末尾**追加 `本月已用 ¥0.00 · 月度上限 Unlimited · 加购余额 ¥32.77`；钱包状态非 `STATUS_ACTIVE` 时余额后标注（如 `（钱包已停用 STATUS_DISABLED）`）。**只进悬停说明**，行内文本与列宽零影响；`extraUsage` 缺失或字段不全时该段整体不出现 |
| 降级 | subagent 转址会话、`modelDirectories` 未装载、目录解析抛错、无当前选择 → 渲染为空，不报错不占位；额度端点不可达时不渲染，端点返回路由级 `ok:false` 时显示脱敏短状态（需登录 / 未配置 / 不可用），其余行为零变化 |

## 跨插件只读桥（侧栏运行行取模型配色）

`apply()` 在 `window.__DSH_PROVIDER_BADGE__` 安装一个版本化只读桥（当前 `version: 1`），供
`dsh-plugin-sidebar-visibility` 的运行中标识取「该会话所选 provider 的颜色 / 字色 / 徽标文字 / 模型名」：

| 成员 | 语义 |
| --- | --- |
| `version` | 协议版本；任一侧改动必须同步升版本，版本不符时消费方中性降级 |
| `presentationFor(sessionId)` | 返回 `{ getSnapshot, subscribe, load }` 句柄；目录未装载 / subagent 转址会话 / 解析抛错 → `null` |
| `getSnapshot()` | `{ color, ink, text, providerId, providerName, modelId, modelName }`；状态未变时返回同一对象（`useSyncExternalStore` 安全），无当前选择时 `null` |

- 安装后广播一次 `dsh-provider-badge:bridge` 事件，桥晚于消费方渲染时也能立即接上；ctx 释放时摘除桥。
- 颜色走 `resolveColor`（用户自选色 > `ROUTE_COLORS` > 自动调色板），字色走 `inkFor`，模型名取自同一份
  `ModelDirectoryState` —— 侧栏**不复制色表**，两处永远同源。
- 只暴露展示事实：不暴露 `select`、不读凭据、不写 settings。
- 语义与徽标一致：反映**会话选择**的 provider/模型，不反映运行期故障转移后的实际执行模型。

## 明确非目标

- **不反映运行期故障转移重路由**：分档切换对 UI 透明是既有设计；徽标与官方模型席位同口径，反映**会话选择**的 provider。
- 不写 settings、不持凭据、不发起任何变更类请求；唯一本地写入是 `localStorage` 选色（每路由可恢复自动配色）。
- **额度只读，且不代管凭据**：宿主半读 `llm-pi-ai` 拥有的凭据记录或该路由生效的 `apiKeyEnv` 引用，只做一次只读 GET，**不刷新、不写回、不落盘、不写日志**；令牌临期/过期时直接放弃本次查询（`token-expired`），把刷新留给 pi-ai —— 两处并发刷新会互相作废对方的 refresh token（凭据服务的 `modifyRecord` 就是为此串行化）。额度失败只显示固定的脱敏短状态，不显示上游响应体、账号或凭据。同理**不读 Kimi CLI 的 `~/.kimi-code/credentials/kimi-code.json`**：那份 OAuth 令牌实测 401，且刷新它会与 Kimi CLI 抢同一份 refresh token。
- 额度**不改变预算/计费口径**：窗口显示的是上游报告的**已用百分比**，不是本机 token 计费估算；两者不可互相换算。Kimi 悬停里的账单段（本月已用 / 月度上限 / 加购余额）确实是**钱**，但它同样是上游直接给的字段（本插件不折算、不估算）；若钱包未启用，它显示 `Unlimited` 而不是编一个上限。OpenCode Go 尤其要注意：官方是按**模型**给月度美元上限（$15/$30/$60/$80 不等），而 `/usage` 只回**订阅级**三个窗口的百分比 —— 本插件显示的是后者，**不做按模型的美元换算**，也不显示「哪个模型还剩多少」。
- 不遮蔽任何官方席位；官方模型选择器行为零改变。级联的模型读取与提交复用官方共享目录**同一个 `ctx.modelDirectories.directoryFor(sessionId)`**（`store`/`load`/`select` 同源，官方同口径 `selectionOf`），不新增 RPC、不写 settings，官方 `/model` 弹窗与 composer 模型席位零改变。
- 级联打开期间**页面**滚动与窗口 `resize` **直接关闭**（不重算锚点，避免 fixed 定位漂移），重新点击徽标即可再次打开。**弹层（provider/模型列表）内部滚动不再关闭弹层**：`scroll` 事件虽不冒泡但会在捕获阶段自 `window` 下传，监听器经 `shouldCloseOnScroll(event.target)` 判定，目标命中 `[data-provider-badge-cascade]`/`[data-provider-badge-root]` 时跳过关闭。
- 模型列表很长时可**用鼠标滚轮或拖动滚动条**上下滚动：面板保留 `maxHeight: 340px` + `overflowY: auto`（列表自身出现滚动条），并设 `overscrollBehavior: contain`，滚到列表末端不串联滚动页面（否则页面一滚又会关闭弹层）。视口过矮（高度 <356px）时打开会按视口高度收缩面板 `maxHeight`（下限 120px，`cascadePlacementFor` 返回的 `panelMaxHeight`），保证列表尾部与滚动条始终落在视口内。

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

插件自带 `cordis.patch.yml`（经 `dsh.bundle.patch` 插入 host 载体行 `provider-badge`），无需手改 profile 的 cordis.patch.yml。新增级联选择器与额度为同一插件内的改动，**安装步骤与依赖零变化**，无需改动 profile。

## 额度（官方 provider）

宿主半注册只读端点 `GET /provider-badge/quota`，浏览器半在打开级联时整表取回。数据源在 `index.js` 顶部的 `QUOTA_SOURCES`（路由 id → 数据源）里登记；新增一条只需在此加一项（鉴权类型 + URL + 附加请求头 + 响应解析），浏览器半无需知道路由名。

### 数据源

| 路由 | 上游 | 凭据来源（一律**只读**） | 附加请求头 |
| --- | --- | --- | --- |
| `openai-codex` | `https://chatgpt.com/backend-api/wham/usage` | 宿主凭据记录 `llm-pi-ai/openai-codex`（`kind: grant`，payload `{type:'oauth',access,refresh,expires,accountId}`） | `chatgpt-account-id: <accountId>`、`originator: pi`（与 pi-ai 的 Codex 适配器同口径） |
| `kimi-coding` | `https://api.kimi.com/coding/v1/usages` | settings `llm-pi-ai.providers['kimi-coding'].apiKeyEnv` 指向的凭据引用（本机在 profile 的 `cordis.patch.yml` 里声明为 `LLMKEY_KIMI`，runtime 由 `settings.describe()` 暴露），取不到时回退 `KIMI_API_KEY` | 无（只发 `authorization` / `accept`） |
| `opencode-go` | `https://opencode.ai/zen/go/v1/usage`（当前 OpenCode CLI 从模型 API URL 推导出的 usage 路径） | settings `llm-pi-ai.providers['opencode-go'].apiKeyEnv` 指向的凭据引用（本机为 `OPENCODE_API_KEY`），取不到时回退 `OPENCODE_API_KEY` | 无（只发 `authorization` / `accept`） |

### 端点契约

| 项 | 值 |
| --- | --- |
| 响应 | `{ ok, updatedAt, routes: { <routeId>: <entry> } }`；`<entry>` 形如 `{ok, plan, limitReached, windows:[{windowSeconds,usedPercent,resetsAt,resetAfterSeconds}], credits, fetchedAt}`，失败为 `{ok:false, reason}`，`reason ∈ {unsupported, credentials-unavailable, credentials-error, not-configured, token-expired, network, http-<code>, bad-json, no-windows, unexpected}` |
| 可选字段 | Kimi 条目另带 `extraUsage: {totalCents, balanceCents, monthlyUsedCents, monthlyChargeLimitCents, monthlyChargeLimitEnabled, currency, status}`（账单口径，只进悬停说明）或 `null`；其它数据源不带该字段。账单对象**刻意不含钱包 id / userId** |
| 缓存 | 宿主侧 60s（并单飞合并并发请求）、客户端侧 25s；收到 `credentials/record-updated` 时立刻失效对应路由缓存 |
| 安全 | 端点只应答回环请求（非回环 403、非 GET 405）；上游非 200 只回状态码不回响应体；任何响应都不含令牌、邮箱、账号 id |

### 各数据源的口径

**Codex**：`rate_limit.primary_window` / `secondary_window` 的 `used_percent` + `limit_window_seconds` + `reset_at`/`reset_after_seconds`；窗口按**时长**排（上游把 5h 放 primary 还是 secondary 都识别）；`plan_type` 作套餐名；`limit_reached` 透传；`credits` 抽 `has_credits`/`unlimited`/`balance`。同一 token 打 `/backend-api/codex/usage` 实测回 403（HTML 错误页），`/wham/usage` 回 200 JSON。

**Kimi**：用量窗口只有 **5h 与 7d 两个维度**，首选 `usages.limit_5h` / `limit_7d`（键自带窗口时长，`used_ratio` 是 0..1 比例 → ×100，`reset_time` 是 ISO 时刻）；`usages` 缺席时回退 `limits[]`（`limit`/`remaining`/`used` 计数 + `window.duration` × `window.timeUnit`），再兜底裸 `usage`（无窗口信息，按 7 天）。**实测该端点没有 30 天用量窗口**（`usages` 只有 `limit_5h`/`limit_7d`，`limits[]` 只有一条 300 分钟；Kimi CLI 的窗口来源同样只有顶层 `usage`（它标为 `Weekly limit`）与 `limits[]`），所以徽标行不会出现 `30d`。Kimi 不提供套餐名与「已达上限」标志，故 `plan` 恒为 `null`、`limitReached` 由「有窗口已用满」推导。

**Kimi 的「月度」维度是账单（Extra Usage），不是用量窗口**：`booster_wallet` 的 `balance` / `monthlyUsed` / `monthlyChargeLimit` 是**钱**（`1e6` 定点，`priceInCents` 为分），Kimi CLI 把它渲染成 `Used this month` / `Monthly limit` / `Balance` 三行。本插件按其口径在**悬停说明**里追加同样三段（本机实测：`本月已用 ¥0.00 · 月度上限 Unlimited · 加购余额 ¥32.77`），**不伪装成第三个百分比窗口**。字段语义与换算全部取自 Kimi CLI 自己的实现（`1e6` 定点 → 分、不足 1 分算 1 分；`type === 'BOOSTER'` 且 `amount > 0` 才显示；`monthlyChargeLimitEnabled === true` 且上限 > 0 才显示上限，否则 `Unlimited`）。**刻意比 CLI 多一步**：`status` 非 `STATUS_ACTIVE` 时在余额后标注（CLI 忽略 status，会把本机 `STATUS_DISABLED` 的余额当成可用余额显示）。

实测：DSH 的 `LLMKEY_KIMI` 回 200（5h 0% · 7d 100%），而 Kimi CLI 自己的 `~/.kimi-code/credentials/kimi-code.json` 令牌回 401 —— 且刷新它会与 Kimi CLI 抢同一份 refresh token，故**不采用**该文件。

**OpenCode Go**：解析同时兼容旧 `{usage:{rolling,weekly,monthly}}`（窗口字段 `{status,percent,resetsAt}`）与当前 `{plan,windows:[...]}`（窗口字段 `{name,status,usagePercent,resetInSec}`）。两种结构都映射为 5 小时、7 天、30 天三个订阅级窗口，按 `5h` / `7d` / `30d` 显示，不按模型拆；当前结构的 `plan`（如 `lite`）会保留。非 `ok` 状态与百分比满 100 均判为已达上限。凭据无效时上游返回 401，界面显示 `额度需登录`；重新执行 OpenCode 登录并更新 DSH 使用的 `OPENCODE_API_KEY` 后，下一缓存周期恢复三窗口。

### 耦合风险（已知且刻意）

- `llm-pi-ai/openai-codex` 是 pi-ai 拥有的记录，payload 是它的私有格式；pi-ai 若改字段名，额度会显示 `额度不可用`（不影响选择），届时更新 `entryFromPayload` 取值即可。
- Kimi 的 `usages`/`limits` 形状是 Kimi 服务的私有格式，同样只读、同样降级为固定短状态。
- 用户在 settings 里改 `apiKeyEnv`（换引用）后，本插件在一个缓存窗口内（≤60s）可能仍显示旧引用的额度，之后自然纠正；记录型凭据（Codex）则由 `credentials/record-updated` 立即失效。
- OpenCode Go 的 usage 接口曾从 `/inference/go/v1/usage` 迁移到当前 CLI 使用的 `/zen/go/v1/usage`，响应也新增了 `plan + windows[]` 结构；插件现已固定使用当前路径并兼容新旧响应。若后续再次改名或改鉴权，行内会保留 `额度需登录` / `额度不可用`，不会再无提示消失。窗口标准秒数仍是本地映射；若上游调整窗口定义，需同步更新 `OPENCODE_WINDOW_SECONDS`。


## 卸载

从 profile `package.json` 移除依赖与 bundle 清单条目，重启 `dsh web` 即可；如需一并清理本地选色，在浏览器开发者工具 Application → Local Storage 删除键 `dsh-plugin-provider-badge:colors`。

## 验证

```powershell
node probe/smoke-client.mjs   # 交付形状 + 推导/颜色 + face 降级 + 级联/额度纯函数与渲染（期望 ALL PASSED）
node probe/smoke-host.mjs     # 宿主半：窗口校验 + 三条数据源口径 + 凭据只读/降级（grant & ref）+ 缓存单飞 + 端点行为（期望 ALL PASSED）
node --check client.js; node --check index.js
```

> `smoke-client.mjs` 里的 `node --check` 用 `stdio: 'ignore'` 调子进程：受限环境（如文件沙箱）禁止子进程建管道，`stdio: 'pipe'` 会在启动阶段就以 `EPERM` 失败，与文件是否合法无关。

真机清单（重启 + 硬刷新后）：

1. 模型席位左侧出现 4 字母徽标，路由不同颜色不同且区分度大；
2. 确认六条路由色表底色：`anthropic-relay` 橙红、`codex-relay` 蓝、`ais-2dsglm` 浅蓝、`openai-codex` 绿、`kimi-coding` 浅绿、`opencode-go` 草绿；浅色底上字色为深墨、深色底上为白；
3. 点击徽标打开级联：一级列 provider，悬停/方向键切换 provider，右侧二级模型列随之变化，**模型列始终在 provider 右侧**（右侧不足时菜单整体左移/收窄，不翻左）；
4. `ArrowRight`/`Enter`/点击进入模型级，`Enter` 或点击选择模型：成功后面板关闭、徽标跟随新路由；键盘全流程（`ArrowUp/Down`、`Home/End`、`ArrowLeft`、字母数字前缀、`Escape`）可用；
5. 一级底部「徽标颜色…」进入色板：选色即时生效并返回列表，刷新页面后颜色保持，`恢复自动配色` 回默认表/自动调色板；
6. 选择失败（会话被占用等）面板保持打开并显示错误；点外部 / `resize` / 页面 `scroll` 关闭级联，但**在弹层内滚动模型列表不关闭**（滚轮与拖动滚动条均可滚动长列表）；
7. 悬停 title 显示 `显示名 (路由id)`；会话内切换模型/路由，徽标即时跟随；
8. subagent 会话无徽标；空白会话（hero 态）无徽标；官方 `/model` 弹窗行为不变；
9. 手动触发一次故障转移后徽标仍显示会话选择的路由（非目标确认）；
10. **额度（Codex）**：当前会话路由为 `openai-codex` 时打开级联，该行右侧出现 `5h x% · 7d y%`，数值与 Codex 自身 `/status` 一致；悬停 title 含重置倒计时与套餐名；
11. **额度（Kimi）**：`kimi-coding` 行右侧出现 `5h x% · 7d y%`（**不会**有三个窗口），悬停 title 除窗口外还有账单段 `本月已用 ¥0.00 · 月度上限 Unlimited · 加购余额 ¥32.77（钱包已停用 STATUS_DISABLED）`（数值随账号变化；`月度上限` 在未启用时是 `Unlimited`）；把该路由的 `apiKeyEnv` 临时指向一个不存在的引用后重开菜单，额度消失且无任何错误提示；
12. **额度（OpenCode Go）**：`opencode-go` 行右侧出现 `5h x% · 7d y% · 30d z%` 三个窗口（比另两行宽），且 provider 列宽已放到 260px、显示名没被挤没；悬停 title 三个窗口各自带倒计时、无「套餐」段；数值与 [console](https://opencode.ai/console) 的用量一致；
13. **额度降级**：未配置凭据（或令牌已过期）时不显示额度且**不出现任何错误提示**；打开一次浏览器 DevTools Network 面板，确认 `GET /provider-badge/quota` 在 25s 内重复开菜单时不再发第二次请求，且响应体里搜不到任何令牌片段。


## 实现备注

- **cordis 注入权限模型（踩过一次的坑）**：插件 `exports.inject` 决定 apply 作用域能访问的服务树；本插件需 `["slots", "sessions", "modelDirectories", "remote", "remote.session"]` —— 缺 `remote`/`remote.session` 时 `modelDirectories.directoryFor()` 内部访问 `this.ctx.remote.session` 会抛 `cannot get property "remote.session" without inject`，且被降级路径吞掉表现为「无报错 + 无徽标」。先例：官方 model-selection 的 inject 同样声明 `remote`/`remote.session`。宿主半不声明 `inject` 导出，改用 `ctx.inject(['webServer'], …)` 动态挂载（无 `webServer` 的 profile 自动跳过额度端点，其余能力不受影响）。
- **provider 列宽 176 → 200 → 260**：额度文案常驻该行右侧，176px 下显示名只剩 60 余像素；接 OpenCode Go 的三窗口文案（`5h 6% · 7d 36% · 30d 59%`，约 25 字符）后 200px 也不够，故放到 260px。列宽在 `CASCADE_PROVIDER_WIDTH` 与 `cascadePlacementFor` 的默认参数两处同值（探针 `smoke-client.mjs` 的 `PROVIDER_WIDTH` 是第三处，改一处要三处同改）；极窄视口仍走收窄分支（provider 最窄 132px）。行内 `name` span 同时补了 `minWidth: 0` + `flex: 1 1 auto`，长显示名会省略号让位而不是把额度挤出列宽。
- **额度数据源表驱动（三家共用同一条路径）**：`QUOTA_SOURCES` 每项只声明 `auth`（`grant` 读凭据记录 / `ref` 读 settings 里该路由生效的 `apiKeyEnv`，可带回退引用名）、`url`、`headers(auth)`、`parse(payload, now)`；服务层只剩「解析凭据 → 一次 GET → 解析响应」三步，缓存 / 单飞 / 降级 / 端点全部与数据源无关，浏览器半按 `row.id` 命中整表且**不限窗口个数**。OpenCode Go 是这套设计的第一次「零客户端改动」验证：只加了表里一条 + 一个 `parse` 函数，`client.js` 唯一的改动是把列宽从 200 调到 260。
- **额度渲染对用户不可见地降级**：`ok:false` 的条目一律不渲染（与「不报错不占位」同口径）；探针 `smoke-client.mjs` 用「按 `useState` 调用序号播种」的假 react 钩子（`renderComponent` + `stateSeeds`）把「级联已打开」这一交互态直接摆到渲染函数前面，因此级联渲染路径有真实断言而非只看源码形状；播种序号即组件内 `useState` 顺序，顺序一变该断言立即失败。
- **Kimi 账单口径的证据来源**：`kimi.exe` 是 Node SEA，内嵌明文 JS。用 `rg -a` 抽出 `parseBoosterWallet` / `fixedPointToCents` / `buildExtraUsageSection` / `formatCurrencyParts` 后按它的换算与判据实现（`1e6` 定点、不足 1 分算 1 分、`type === 'BOOSTER'` 且 `amount > 0`、`enabled && 上限 > 0` 才算有上限）。这是本插件第一次「照抄上游客户端语义」，所以两处刻意不同都写进了注释与本文档：**（1）** 多带 `status` 供客户端标注停用；**（2）** 不把账单当窗口，只进悬停说明。
- 交付为手写 CJS + `window.__ModuleLoader__.load({id, factory})` 包装的 classic script（先例：`dsh-deepseek-keypool/client.js`）；**任何模块级 import/export 会炸掉整个 `/plugins` combo**，改动后必须跑 `node probe/smoke-client.mjs`。宿主半是普通 ESM（`type: module`），可由 `probe/smoke-host.mjs` 直接 `import`。
- 零 npm 依赖、零构建步骤；`require` 白名单仅 `react`。宿主半只用 Node 内建能力（`fetch` + `AbortSignal.timeout`）。
- 当前席位/API 契约证据（宿主 0.2.0-rc.2）：`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts`（席位）、`dsh-client-ui-model-selection/lib/types/client/directory.d.ts`（共享目录）、`dsh-client-ui-model-selection/lib/client.js:1174-1183`（官方 selection payload）。
- 过程与 OpenSpec 文档（`openspec/`、`build_output_index.md`）保留在本地工作区，不入库（见 `.gitignore`）。

## 历史宿主兼容性（2026-09-23：dsh 0.1.5-rc.3）

宿主升级 `0.1.5-rc.2 → rc.3`（npm latest）并打上全局 `dsh-permission-compat` 沙箱补丁（改 `dsh-sandbox` + 三个工具守卫）后复查，**本插件零改动可用**：

- 与补丁无关：源码与构建产物不引用 `sandbox_permissions` / `justification` / `approveEscalation` 等提权 API（grep 零命中）；宿主半只有一行日志。
- 与 rc.3 无关：挂接插槽 `conversation.input.right` 在 rc.3 内核原样存在（`dsh-client-ui-conversation/lib/client.js`）；对 13 个宿主包做 rc.2↔rc.3 发布包逐文件 MD5 对比，仅 `dsh-client-ui-sidebar` 有一行版本号显示串差异，其余只有 package.json 版本号，插槽契约无变化。
- 复查记录见 vault `70-WorkSpace/dsh工具维护日志.md` 2026-09-23 条目；复装说明见 `70-WorkSpace/dsh复装说明.md`。
