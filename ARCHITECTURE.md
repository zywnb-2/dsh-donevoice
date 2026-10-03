# dsh-donevoice — 架构与接缝（契约文档）

> 本文件是插件的**契约**：宿主接口、不变量、踩坑记录。
> 与代码冲突时**以代码为准**，并同时修两处。
> 用户视角的安装、使用与限制见 [README.md](./README.md)。
> **原生通知子系统的完整说明（为什么能弹到 DSH 外面、真机数字、自证方法）见 [NATIVE.md](./NATIVE.md)。**

---

## 0. 用户可见行为

> 2026-10-01 改造后，**四类提醒的检测与投递主通道都在宿主进程**（见 §0.5）。页面只是辅助通道。

| 场景 | 行为 |
|---|---|
| 某个会话从「运行中」变为空闲 | **宿主进程**弹 Windows 原生通知「任务完成」：会话名 + 本次耗时，并响一声（**默认档"走开才弹"：你正看着 DSH 时静默跳过**） |
| 有操作等待许可（`approval/request`） | 宿主弹「等待你的许可」：工具名 + 理由；页面卡片（若开启）用 `role="alert"` |
| 问 Agent 提问（`user-questions/request`） | 宿主弹「需要你的回答」：第一个问题 + 问题数 |
| 会话级错误（`api-session/error`） | 宿主弹「执行失败」：错误摘要；**下行**音效 |
| 点击系统通知 / 点击页内卡片 | 页内卡片：聚焦窗口 + `uiWorkspace.openSession(sessionId)`，卡片消散 |
| 点「忽略」按钮 / 按 Esc | 关掉该卡片 / 关掉最新卡片；不打开会话 |
| 鼠标悬停在页内卡片上 | 消散倒计时暂停，进度条停住；移开继续 |
| `noticeStyle = topCard` | 页内卡片换成**顶部提醒卡片**（屏幕上方中间果冻弹出，带 DSH 鲸鱼徽标）。投递语义、点击行为、悬停暂停、关闭方式**与页内卡片完全一致**，只是换了层皮；停留时间取 `cardDurationSec` |
| 顶部卡片 + `edgeGlow` 打开 | 卡片出现时**屏幕四周亮起彩色边框**。边框时长 = 通知音效时长（死逻辑，见 §4.3） |
| `pageSound` 打开（默认关） | 你在 DSH 页面上时**也**响一次提示音（走宿主的"只播音效"路由）。默认关 = 保持安静 |
| 页面打开的那一刻已存在的会话 | **只进基线，不弹任何东西**（避免历史刷屏） |
| 断线重连（`connection/reset`） | 重新建立基线：断线期间错过的完成**不补弹**，断线之后真正的下一次完成照弹 |
| 页面根本没开 / 被冻结 / 在别的页面 | **照常弹**（宿主通道不依赖页面）；页面那条中继通道不参与 |
| 宿主原生通道不可用（无 powershell / 超时） | 页面在收到失败回执后**自动降级**：页内卡片 + 本地音 + `[donevoice]` 出声 |
| 宿主半区缺失 / 配置路由不可达 / 会话标题取不到 | 功能降级到能用的最小集，并在控制台留下 `[donevoice]` 前缀的原因，**绝不静默** |
| 插件卸载 | 样式、订阅、定时器、常驻 PowerShell worker 全部随 Cordis 效应回收 |

## 0.5 宿主侧四类触发与原生通道（本次改造的核心）

| 事实 | 出处 / 验证 |
|---|---|
| 四类触发源：完成 = `session/event` 的 `turn/end`（兜底 `api-session/status` 的 true→false 边沿）；失败 = `api-session/error`；审批 = `approval/request` waterfall；提问 = `user-questions/request` waterfall | `host-sensors.js` |
| 根上下文的插件**收得到**这些事件（含两条 waterfall） | cordis `dispatch()` 只在首个参数是 scope carrier 时过滤（`cordis/lib/index.js:258-264`）；`scopeTarget` 放行未打标签的监听器（`dsh-scope/lib/index.js`）；**真机探针实测**（见 NATIVE.md §2） |
| 宿主两条 waterfall 的监听器**只观测 + 无条件 `next()`**，观测代码在 `try` 内、`next()` 在 `catch` 外 | `host-sensors.js`；专项测试用敌意 Proxy + 抛异常的 onEvent/log 施压 |
| ⚠️ **两条 waterfall 必须 `{ prepend: true }` 注册**：官方把它们转发给浏览器的转发器先注册、拿到答案后不调 `next()`，不插队就永远轮不到我们（真机症状：`sensors.question=0` 而 `source:"client"`） | `cordis/lib/index.js:317-325`；`dsh-api-remotes/lib/index.js:140-158, 214-232`；修复前后真机计数见 NATIVE.md §2 |
| 原生通知 = `powershell.exe`(5.1) + WinRT `ToastNotificationManager` + 常驻 worker + 合成 WAV 音效 | `win-native.js`；实测冷启动 ~1.7–2.0s、热路径 ~180–240ms（含 160ms 卡片入场等待） |
| 跨通道去重：精确键 + `kind\|sessionId` 2.5 秒时间窗 | `index.js` 的 `findDuplicate` / `DEDUP_WINDOW_MS`；单测 + 真机 `deduped:1` |
| 宿主路由（五条）：`POST /notify`（页面中继，唯一的投递入口）、`POST /preview`（设置页试听，只播音效）、`GET|POST|DELETE /sounds.json`（音效清单 / 导入 / 删除）、`GET /health.json`（原生通道状态 + 投递账本 + 传感器计数 + `?probe=presence/click`）、`GET|PUT /config.json` | `index.js` |
| 宿主源码热重载：`dsh-hmr` 默认 `root: []`（只监听配置），在 profile 的 `cordis.patch.yml` 里加 `root: [<插件目录>]` 后**改源码即热重载** | 真机实测（改完 8 秒内 health 反映新代码）；见 NATIVE.md §8 |

---

## 1. 宿主事实（已核实，勿再猜）

> 基准：DSH `0.2.0-rc.2`。源码路径相对 `app.asar` 提取目录
> DSH 安装目录下的 `resources\app.asar\dsh\node_modules\@deepseek-ai\`。

| 事实 | 出处 |
|---|---|
| 客户端 `require` 的**基线种子表共 9 个**：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit` | `dsh-web-frontend/dist/assets/index-*.js` 的 `staticModules` 表（`"react-dom/client":` 全文件仅 1 次，唯一性已证）；消费侧 `dsh-client-modules/lib/client.js:548` |
| 越出种子表的 `require` 会抛错并让整个条目失败 | `dsh-client-modules/lib/client.js:705` |
| ⚠️ **插件的服务可见范围由 `exports.inject` 决定：没声明的服务 `ctx.xxx` 取不到，运行时 `ctx.inject(['xxx'], cb)` 也永远不就绪**（回调根本不会被调用） | 官方 `dsh-client-ui-approval/lib/client.js:275-281` 与 `dsh-client-ui-user-questions/lib/client.js:1630-1637` 的 `inject` 数组里**都显式含 `uiSession`**；本插件第一版漏声明 ⇒ 审批/提问两类提醒**从装上到修复前一次都没响过**（真机磁盘诊断：pending 通道从未绑定、引擎计数恒为 0），而完成/失败提醒正常（`remote` 声明过）、设置页正常（`slots` 声明过） |
| ⚠️ **`inject` 是"全有或全无"的硬门槛**：声明表里只要有一个服务在当前组合里不存在，插件就是 INACTIVE——`apply` 整个不跑，连带"降级必须出声"与看门狗一起变成**死代码**（独立审计 H-1） | `@deepseek-ai/cordis/lib/index.js:1317-1326`。⇒ 本插件只声明**核心插件提供、且本机已实测存在**的 6 个服务；声明表任何变更都必须是刻意的（改错一个服务名，插件就整体 INACTIVE） |
| `dsh.client.inject` 里**未知包名会被静默跳过**（所以它**不是**致命伤） | `dsh-client-modules/lib/client.js:656-659` |
| `window.__ModuleLoader__.load({ id, factory })` 的 `id` 必须等于 `package.json` 的 `name` | `dsh-client-modules`（客户端包注册表与 require 解析，见 `lib/index.js` 中 `decl.platform !== "web"` 一带） |
| ⚠️ **官方 `approval/request` / `user-questions/request` 监听器在能显示 UI 的路径上不调用 `next()`**——它 `await` 用户作答并把答案当作 waterfall 的返回值。**限定（独立复核后加）**：仍有 3 处会调 `next()`，但全部落在"域被拆除"的兜底窗口（插件卸载 / HMR / fiber dispose：`approval:303`、`user-questions:1797`）或前台 claim 已完成时（`user-questions:1781`）；"用户选拒绝"**不**走 `next()`（`approval:79/124 → #resolve`） | 独立复核；`dsh-client-ui-approval/lib/client.js:152-303`；`dsh-client-ui-user-questions/lib/client.js:1741-1797` |
| ⚠️ 因此**注册在它下游的第三方监听器在正常路径上一次都不会被调用**（只可能在上述卸载兜底窗口被唤醒，那对"提醒"毫无价值）；且 `ctx.remote.$on` **不透传 options，无法 prepend** | 派发链路已用真实 cordis 复现；`dsh-api-gateway/lib/types/client/remote-events.js` 的 `subscribe` 签名不带 options |
| ✅ 替代方案：`ctx.uiSession.sessionStatus` = `Map<sessionId, { running, pendingInteraction, completionUnread }>`，公开字段 + `{getSnapshot, subscribe}` 快照源。**注意**：「只读」只是行为事实（发行版内无写入者），**不是契约**；真正的遮蔽在**值层**——同一会话的 `pendingInteraction` 按域优先级做单值投影（`:304` 用 `>=`，同优先级后者胜），高优先级域可以顶掉它 | `dsh-client-ui-session/lib/client.js:148-156`、`:304`、`:342-358`；独立复核 §B |
| `pendingInteraction` 是领域对象，自带唯一 `key` 与详情：`PendingApproval{sessionId,kind:'approval',key,toolName,callId,reason,displayReason}`；`PendingQuestion{sessionId,questions,kind:'question'\|'plan-review',key,callId?,review?,dismissal:'hide'\|'cancel'}`（`key` 由 `sessionId`+`callId` 构成） | `dsh-client-ui-approval/lib/client.js:152-165`；`dsh-client-ui-user-questions/lib/client.js:135-159,185,202-204` |
| `LocaleSnapshot = Object.freeze({ active, locales, revision })`——**字段是 `active`**，不是 `locale` | `dsh-client-locale/lib/client.js:1216-1220`；使用处 `:1531` |
| **`ctx.remote.$on` 的合法键集 = 官方转发白名单** `API_REMOTE_FORWARDED_EVENTS` | `dsh-api-remotes/lib/types/remote-events.js:12-40`；宿主转发循环 `dsh-api-remotes/lib/index.js:140-150` |
| 白名单里与本插件相关的 **3 个 emit 事件**（本插件只订这三个，全部走 `parallel` 广播、顺序无关）：`api-session/status`(sessionId, running)、`api-session/error`(sessionId, message)、`api-session/added`(SessionSummary) | 同上 |
| 白名单里另外两个 `approval/request` / `user-questions/request` 是 waterfall：**本插件有意不订阅**，理由见 §6.1 与下面那行 | 同上 |
| **emit 型**走 `parallel`，返回值被忽略；**waterfall 型**不调用 `next()` 会**截断瀑布**；返回值必须是无损 JSON | `dsh-api-gateway/lib/types/client/remote-events.js`；用法参考 `dsh-client-ui-approval/lib/client.js:355` |
| `ctx.sessions` 公开面：`retain / using / retainInfo / refreshProjections / search / fork / scope / binding`——**没有 `list`、没有 `open`** | `cordis_inspect` client Service `sessions`（本机实查） |
| 但 `ctx.sessions.list` 在运行时**真实存在**，且被官方包直接使用 | `dsh-client-ui-session/lib/client.js:471`（`provideRoot({hooks:{sessions: ctx.sessions.list}})`）；`dsh-client-ui-workspace/lib/client.js:4210` |
| `sessions.list` 快照形状 `{ ids, byId, phase, projectionsBySession }`；行 = `{ id, displayTitle, running, retainedBy, blank, updatedAt, projectionValues?, title?, cwd?, parentId?, origin? }`（是 **`id`**，**没有** `pendingInteraction` / `completed`） | `dsh-api-session-controller/lib/types/client/sessions/service.js:491-512` |
| `ctx.sessions.scopeOf(owner)` 是官方把 waterfall 的 `this` 映射成会话 id 的方式 | `dsh-client-ui-approval/lib/client.js:285` |
| `SessionSnapshot` 字段：`sessionId / pendingSubmissions / running / subagent / removed / openState / openError / hasMore / loadingOlder / promptError / blank / lastAgentError / promptAttempted / awaitingFirstTurn`——**没有 `turnEnds` / `turnTimings` / `pending`** | `dsh-api-session-controller/lib/types/client/sessions/session.js` |
| `ApprovalRequestEvent = { agent, toolName, callId?, reason?, displayReason?, signal? }` | `dsh-tool-cordis/lib/types/api-catalog.js:4476` |
| `SessionSummary = { agentAvailable, sessionId, updatedAt, running, blank, parentSessionId?, origin?, cwd?, projections? }`——**没有 title**（标题只能从 `sessions.list` 取） | 同上 `:6800` |
| `AskUserQuestionRequestEvent = { questions, agent?, signal?, wait? }` | 同上 `:4508` |
| 官方打开会话的入口是 `ctx.uiWorkspace.openSession(target)` | `cordis_inspect` client Service `uiWorkspace` |
| 官方持久化设置入口是 `ctx.configForms.get(entryId)`（快照含 `status` / `value` / `revision` / `writable`，命名空间 = **Loader 条目 id**）。**但第三方插件走不通**：客户端要拿到 `value`，宿主必须先声明 `Config`，而声明 `Config` 就要 `import '@deepseek-ai/schemastery'` | `dsh-client-ui-settings/lib/client.js:1086-1350`；`dsh-settings/lib/index.js:432` |
| ⚠️ **第三方插件的宿主半区不能 import 裸包名**：插件经 `link:` 装进 profile，而 profile 的 `node_modules` 里**没有 `@deepseek-ai` 作用域**；Node 的 ESM 解析从插件目录往上找 → `ERR_MODULE_NOT_FOUND`。静态 import 属**链接期**错误 ⇒ 整个宿主条目加载失败（与旧版 dsh-reminder 同一种死法） | 真机实测：在 profile 的插件目录里跑 `node -e "import('@deepseek-ai/schemastery')"` → `ERR_MODULE_NOT_FOUND` |
| ✅ 本机**已验证可行**的组合（`dsh-status-rotator@0.29.0`、`dsh-prompt-studio` 都这么做）：宿主半区**只 import `node:*`**，配置落 `$DSH_HOME/<id>/config.json`，由自带的 `webServer` 路由读写 | `dsh-status-rotator/lib/index.js` 的 import 段只有 `node:*`；其 `package.json` 的 peerDependencies 只有 `@deepseek-ai/cordis` |
| schemastery 有 `.volatile()`；**本插件用不上**（列在这里只为说明它为什么不能用于第三方插件） | `schemastery/src/index.ts:480`、`:493` |
| 抑制自动生成设置页：`ctx.settings.configure({ auto: false }, ctx.fiber)` | `dsh-settings/lib/index.js:364-381` |
| 宿主路由：`ctx.webServer.register({ kind: 'exact'\|'prefix', path, handler })` 返回 disposer；同 (kind,path) 重复会抛 | `dsh-host-webserver` README；`cordis_inspect` host Service `webServer` |
| DSH 原生通知面 token：`--dsw-alias-toast-bg`（两套主题下都是深色）、`--dsw-alias-toast-label`、`--dsw-radius-lg`、`--dsw-shadow-lv3`，原生 Toast `z-index:1100`、进入 160ms ease-out | `dsh-client-ui-primitives/lib/Toast.module.css` |
| 官方 `Toast` 原语存在且在种子表里，但它是**顶部居中、点击穿透、无关闭按钮** | 同上；`dsh-client-ui-primitives/lib/index.js:6792-6900, 12381` |

**结论性判断**：本插件**只**用上表这些接口；不用任何官方 UI 包的内部 store，不 require 任何非种子词模块。
唯一"未写进公开目录"的依赖是 `ctx.sessions.list`——它有官方包内部的三处使用证据，且**失败时只损失标题**（降级为短 id），不影响提醒本身。

---

## 2. 数据流

```
  —— 宿主进程（主通道：不依赖任何页面，四类提醒在这里闭环）——
  api-session/status · session/event · api-session/error
  approval/request · user-questions/request        ← 只观测 + 无条件 next()
        │
        ▼
  host-sensors.js  （边沿 / 周期去重 / 耗时 / 标题 / origin 标记）
        │  { kind, sessionId, title?, durationMs?, toolName?, … , key, source:'host' }
        ▼
  index.js  describeSensorEvent()  →  deliver()
        │  门禁：总开关 / 分类开关 / 子代理开关 / 投递策略 / 跨通道去重(2.5s) / presence 前台判断
        ▼
  win-native.js  →  常驻 PowerShell worker  →  Windows 通知中心 + 自带 MP3 提示音
        ▲
        │  POST /plugins/dsh-donevoice/notify（页面中继；同一出口，同一去重表）
        │
  —— 浏览器侧（辅助通道：页面开着时把事件也递过来，保证双通道不双响）——
  官方转发 emit×3  +  ctx.sessions.list  +  ctx.uiSession.sessionStatus
        │
        ▼
  createReminderEngine()（纯逻辑，可单测：基线吸收 / 周期号去重 / callId 去重 / 自测耗时）
        │  deliver(event)
        ▼
  createRelay()  —— 中继成功（delivered 非空 **或** deduped:true）→ 页内不弹卡片、本地不响
                   中继失败/超时 → 降级：createToastLayer() 页内卡片 + createChime() 本地蜂鸣 + 出声
        └────────► 点击 → window.focus() + uiWorkspace.openSession(sessionId)

  宿主侧另有两件事 ——
  $DSH_HOME/donevoice/config.json ──► readConfig/writeConfig（*.tmp + rename 原子写，2s 缓存）
        ▲                                    │
        │ PUT/GET（同源栅栏）                  │
        └── GET/PUT /plugins/dsh-donevoice/config.json  ◄── window.fetch（客户端读/写设置）
  ctx.settings.configure({auto:false})   抑制自动生成页
  GET /plugins/dsh-donevoice/health.json 只读探针（宿主 / 原生通道 / 传感器 / 最近投递）
  ```

**单一真相**：
- 配置的唯一权威是 `$DSH_HOME/donevoice/config.json`（经同源路由下发/回收）；客户端只在内存里保留归一化副本，写入是"乐观更新 + 宿主回显覆盖"
- 提醒状态的唯一权威是 `createReminderEngine`（页面侧）与 `host-sensors`（宿主侧），各自去重，宿主再用 2.5 秒时间窗把两条通道合并
- 原生通道可用与否的唯一权威是 `win-native.js` 的回执（`delivered` / `degraded`），并原样暴露到 `health.json`

---

## 3. 提醒引擎契约（`createReminderEngine`）

纯逻辑，零依赖，注入时钟（`{ now }`），因此可以确定性地单测。状态：

```
baselined   : Set<sessionId>              已建立基线的会话
running     : Map<sessionId, boolean>      最近一次观测到的运行状态
startedAt   : Map<sessionId, number>       观测到"开始跑"的时刻（自测耗时的起点）
cycle       : Map<sessionId, number>       单调递增的运行周期号（只增不减）
notifiedCycle: Map<sessionId, number>      已提醒过的周期号
seenApprovals / seenQuestions : Set<key>   去重键
lastError   : Map<sessionId, {message, at}>
meta        : Map<sessionId, {displayTitle?, origin?}>
```

### 3.1 不变量（每条都有对应测试）

| # | 不变量 | 为什么 |
|---|---|---|
| I1 | **首次观测某会话只建基线，返回 `null`** | 否则页面一打开就被"当前所有空闲会话"刷屏 |
| I2 | 同一个 `(sessionId, running)` 重复观测不产生事件 | 双通道（远端事件 + 列表兜底）必然重复 |
| I3 | `running: true → false` **且该周期未提醒过**时才产出 `completion` | 周期号把"两个通道同时到达"与"真的又跑了一轮"区分开 |
| I4 | `cycle` **只增不减**，即使 `rebaseline()` 也不清零 | 重连后新的完成必须还能弹（若清零会与 `notifiedCycle` 撞车而永久漏报） |
| I5 | `rebaseline(rows)` 清空 `baselined/running/startedAt`，**保留** `notifiedCycle` 与去重集 | 断线期间的历史不补弹；断线后的真实完成照弹 |
| I6 | 失败提醒：同会话同消息 **5 秒内**不重复 | 一次错误常伴随多条同类事件 |
| I7 | 审批去重键 = `sessionId \| callId`；缺 `callId` 时 = `sessionId \| toolName \| hash(reason)` | 官方事件不保证 `callId` 一定存在 |
| I8 | 提问去重键 = `sessionId \|q\| wait.callId`；缺 `callId` 时 = `sessionId \|q\| hash(首问文本) \| 问题数` | 同上 |
| I9 | 耗时 = `now - startedAt`，缺 `startedAt` 时为 `undefined`（正文不显示耗时），永不为负 | 诚实标注自测值 |
| I10 | 子代理（`origin === 'subagent'`）只**打标记**，不在这里过滤 | 过滤是"投递策略"的事，引擎保持纯粹 |

通道层还有一条（不属于引擎，但同样是硬约束）：

| # | 不变量 | 为什么 |
|---|---|---|
| I11 | `sessionStatus` 通道按 `pendingInteraction.key` 做**身份边沿**：同一身份重复快照只提醒一次；互动消失后从记忆里清掉 | 该快照源会在运行状态变化时反复发布，不去重就会反复弹；而"撤回后同一身份再来"必须能再提醒（由引擎的 `callId` 去重兜第二层） |

### 3.2 `connection/reset` 的处理

```js
ctx.on('connection/reset', () => { engine.rebaseline(readRows()) })
```

重连后 binding 与快照都会换代，如果不清基线，会把"断线期间已经结束的会话"当成新完成补弹一批。
`rebaseline` 用当前列表重建基线，同时保留去重历史——这是 I4/I5 的落地。

---

## 4. 投递与音效规则

### 4.1 投递规则（**固定行为，没有档位可选**；"系统通知 = 宿主原生通道"，不是浏览器 Notification）

**关键：`auto` 档的"你在不在"由宿主判断，不由页面判断。**
判据是 **Windows 的前台窗口属于哪个进程**（`win-native.js` 的 `presence()`，
worker 里 P/Invoke `GetForegroundWindow` + `GetWindowThreadProcessId`，拿进程名与 `process.execPath` 的 basename 比）。
为什么不能靠页面：宿主传感器不依赖页面 —— 页面没开、被冻结、被限流时事件照样从宿主侧来，
那些情况下页面根本没法汇报焦点，同一个事件就会得到两套结论。

| 你的状态 | `noticeStyle = card`（右下角） | `noticeStyle = topCard`（顶部提醒） |
|---|---|---|
| **正看着 DSH** | 🔇 不弹系统通知、不响音效；`pageCard` 开着才出页内卡片 | 🔇 不弹系统通知；`pageCard` 开着就**画原生覆盖层**（卡片 + 边框） |
| **切走 / 最小化** | ✅ **强制**弹系统通知 + 音效 | **只画原生覆盖层 + 音效**，**不弹系统通知** |

> ★ **两种形态是替代关系，不是叠加**（用户定稿："只能有一方出现，另一方必须是不发生"）。
> 所以 `topCard` 模式下覆盖层一旦画成，系统通知就**不发** —— 回会话靠**点覆盖层卡片**
> （那条已接通：`WM_LBUTTONUP` → 落标记 → 抢前台）。
> 覆盖层没画成时会**补发**一条系统通知，所以不会漏提醒；中继不通时回落成右下角卡片。

- 探测失败（worker 起不来 / 拿不到自身进程名）一律按**"你不在"**处理：宁可多弹一条，也不让你漏提醒；原因写进 `degraded`/探针并在控制台点名。
- 「中继成功」的判据是宿主回执 `ok:true` —— 三种都算：`delivered` 非空（真弹了）、`deduped:true`（宿主传感器已弹过）、
  **`suppressed:'present'`（你在页面上，有意跳过）**。
- 中继成功 ⇒ **页内不补卡片、本地音效不响**；中继失败/超时 ⇒ 降级：页内卡片 + 本地 Web Audio + `console.warn` 出声
  （这是**失败兜底**，不是"默认也弹卡片"）。
- 宿主原生通知**不需要任何浏览器权限**。**浏览器 `Notification` 兜底已按用户要求整体删除**。
- 宿主自己产生通知时的音效由 `win-native.js` 合成的 WAV 播放（`soundPreset` / `volume` 取宿主配置），失败用下行音。
- 配置里遗留的 `delivery` 字段（旧的四档枚举，已按用户要求整体删除）会被 `normalizeConfig` 直接丢弃——它只处理自己认识的字段。

### 4.2 `shouldChime(input)`

> 这个函数只管**降级路径上的本地 Web Audio 蜂鸣**（宿主通道挂了时"至少听得见"）。
> 正常路径的音效由宿主的 worker 播，不经过它。

```
preset === 'none'            → false
volume <= 0                  → false
sinceLastMs < 2000           → false  （限流：多会话同时收尾不连珠炮）
background !== true          → false  （你在页面上就别"叮"了）
否则                          → true
```

设计依据：对齐 Codex 的 `notification_condition = unfocused` 语义 —— **走开才响**。

> 历史：曾经还有一条 `kind` 分支，让阻塞性事件（审批/提问/失败）在前台也叫一声。
> 后来用户把"页面上保持安静"定为硬规则，那条分支被删掉了（调用点干脆写成
> `onPage === true ? false : playChime(...)`），函数体因此收缩成上面这四行。
> **文档曾长期停留在旧版本**，与代码对不上 —— 这次一并改正。
>
> 1.2.0 重新引入了"页内也响"的能力，但它是**可选的 `pageSound`**、且走宿主的
> "只播音效"路由（`/preview`），**不经过 `shouldChime`** —— 所以这个函数仍然只有四行。

### 4.3 边框光效的时长 = 通知音效的时长（**死逻辑**）

用户定稿：*"边框定一个死逻辑，就是必须跟随通知音效消失而消失。"*

- **没有** `glowDurationSec` 之类的字段，设置页也**没有**边框时长滑条。想改就换音效。
- 音效时长由宿主量出来（`win-native.js` 的 `audioDurationMs`，纯读 MP3/WAV 文件头、零依赖），
  随 `GET /sounds.json` 的 `durationMs` 交给页面；页面缓存进 `catalogStore`。
- 拿到中继回执时，宿主**已经起播了** `result.latencyMs` 那么久 ⇒
  `边框时长 = 音效时长 − latencyMs`（下限 400ms）。所以边框是**接上音效的剩余那截**，
  而不是从头再亮一遍。
- 淡入淡出各占时长的 35%（上限 450ms），因此**完全消失**的那一刻正好落在音效结束上。
  固定 450ms 的淡出对 0.5s 的短音效会变成"刚亮就灭"，所以按比例取。
- 量不出来（非 MP3/WAV）或选了静音 ⇒ 退回 `GLOW_FALLBACK_MS = 1600`。
  这是**兜底**，不是可调项，不出现在设置页。

---

## 5. 配置契约与防漂移

**唯一真相是 `host-config.js`**：字段清单、默认值、边界、归一化规则。
`client.js` 持有一份**内联副本**（它无法 `require` 本地文件——`client.js` 不在模块表里），
两者必须**逐字节一致**：

- `DEFAULT_CONFIG` 深度相等
- `BOOLEAN_FIELDS` / `ENUM_FIELDS` / `ENUM_FALLBACK` / `NUMBER_FIELDS` 结构与边界相等
- 一批刁钻输入（`undefined` / `null` / 字符串 / 数组 / `NaN` / `Infinity` / 越界数值 / 大小写枚举 / 未知字段）逐条对拍输出

> 这套机制是被现实逼出来的：写这份代码的过程中，我给客户端加了"枚举大小写不敏感"，忘了同步宿主——
> 对拍测试**立刻报红**并指出是哪个输入哪一边不同。这就是它存在的意义。

**执行者是 `scripts/check-config-contract.mjs`**（1.2.0 补上；此前 §5 只是一句承诺，
仓库里**没有对应脚本**，只有 `check-package.mjs` 管打包）。它从 `client.js` 里按括号配平
（跳过字符串与注释）抠出内联副本，跟 `host-config.js` 逐字段比对，再跑三组检查：

1. 字段清单 / 边界 / 默认值是否相等，`DEFAULT_CONFIG` 是否覆盖全部声明字段；
2. 一批刁钻输入（`undefined`/`null`/字符串/数组/`NaN`/`Infinity`/越界/小数/大小写枚举/
   未知字段/`__proto__`）在两边 `normalizeConfig` 上的输出**逐字段相同**，且**键顺序也相同**
   （顺序不同会让落盘的 `config.json` 长得不一样）；
3. **每个字段都真的可写** —— 从默认值出发逐个喂非默认值，输出必须跟着变。

第 3 条第一次跑就抓出一个真 bug：`noticeStyle` 的枚举值是 camelCase 的 `topCard`，
而归一化只把**输入**小写、却拿 `topcard` 去比 `topCard`，永远比不中 ⇒
该字段"怎么设都回落默认值"。修法是**两边都小写比对、回写清单里的那个写法**。

归一化的硬规则（与 dsh-settings 同口径）：**任何输入都必须返回完整合法配置，永不抛异常**。
未知字段丢弃、类型不符回落默认、数值夹到闭区间并取整、字符串 trim 后比对枚举（大小写不敏感）。

`unwrapConfig()` 额外处理一个真实细节：schemastery 的 `.volatile()` 会把字段解析成"稳定引用"（取值要 `.get()`），
而普通对象就是普通值。两种形状都要能吃下，且任何一次 `.get()` 抛异常都不能影响其它字段。

---

## 6. 模块系统约束（已核实，别踩）

- 客户端 `require` 的解析顺序：**基线种子表（9 个）→ 已物化模块 → 已注册的插件 factory**；都没有就抛
  `require("…") missed the module table`。**本插件只 `require('react')`**，连 `react/jsx-runtime` 都不用
  （直接用 `React.createElement`），把模块表风险压到零。
- `dsh.client.inject: []` 是**有意为空**：它只对 `dsh.client.external` 建图边，本插件没有 external 依赖。
  **服务可用性与 `apply` 时机由插件对象上的 `exports.inject` 决定**，所以那个必须写全：
  `['sessions', 'remote', 'slots', 'locale']`。
- 可选服务一律用 `ctx.inject([...], scope => …)` 惰性获取，让 Cordis 等它们就绪，缺了也能加载：
  `uiSession`（待审批/待回答）、`uiWorkspace`（打开会话）。设置不走服务，走宿主自带的同源路由。
- **卡片层手写 DOM，不用 React**：需要精确控制消散计时/悬停暂停/进度条/堆栈，React 树反而碍事。
  React 只用于设置页（它必须是槽位组件）。这样也避免了 `react-dom/client` 依赖（虽然它在种子表里）。
- **不使用官方 `Toast` 原语**：它受控、顶部居中、点击穿透、无关闭按钮，与"右下角 + 可点击回会话 + 可忽略"五点冲突，改完等于自建。见 §8。

### 6.1 为什么**客户端**不订阅 approval/request（本项目最重要的一条血泪结论）

> ⚠️ 先划清边界：这一节的结论**只适用于浏览器半区**。
> 宿主半区**是**订阅这两条 waterfall 的（那是四类提醒搬进宿主后的必然选择），
> 安全性由"只观测 + 无条件 `next()` + 观测异常不影响返回值"的结构保证，
> 并有敌意 Proxy 专项测试 + 真机闭环。见 [NATIVE.md](./NATIVE.md) §5 与 §0.5。
> 两边结论不冲突：**页面**收不到（链条最内层，且 `$on` 不能 prepend），**宿主**收得到（根上下文未打 scope 标签）。

直觉写法是订阅 `approval/request` / `user-questions/request` 的 waterfall 事件——它们确实被官方
转发到浏览器，看起来天经地义。**这是死路**：

1. cordis 的 waterfall 按**注册顺序**串成一条链，只有调用 `next()` 才把控制权交给**下一个**监听器；
2. 官方 `dsh-client-ui-approval` 在能显示审批 UI 的路径上**不调用 `next()`**——它 `await` 用户作答，
   并把答案直接作为 waterfall 的返回值（`dsh-client-ui-user-questions` 同形）。
   **限定**：仍有 3 处例外会调 `next()`（卸载/HMR 兜底、前台 claim 已完成），但它们对"做提醒"毫无价值，
   见 §1 那一行；
3. 第三方插件是 profile 里 `insert` 追加的条目，注册顺序排在 `dsh-web-app` **之后** = 链条**最内层**；
4. `ctx.remote.$on` **不透传 options**，插件没有办法把自己插到前面。

⇒ 那个监听器**在正常路径上一次都不会被调用**（只在插件卸载/HMR 的兜底窗口里可能被唤醒），现象与"插件没装"完全一样。
（这条是独立验证员用**真实 cordis** 复现出来的，时间线里根本没有本插件那一行；
已用真实 cordis 复现。）

**本插件的做法**：完全不碰 waterfall，改读官方聚合好的只读快照——

```js
ctx.inject(['uiSession'], (scope) => {
  const status = scope.uiSession.sessionStatus            // { getSnapshot, subscribe }
  scope.effect(() => {
    const off = status.subscribe(() => { ownPendingStatus(status.getSnapshot()) })
    ownPendingStatus(status.getSnapshot())                // Map<sessionId, { pendingInteraction }>
    return off
  }, 'donevoice: pending interaction status')
})
```

`ownPendingStatus` 只做两件事：拿 `pendingInteraction.key` 做**身份边沿检测**（同一身份只提醒一次，
撤回后清记忆），再把领域对象翻译成引擎事件。**读一个 Map 不可能让审批卡住** —— 这比"记得调用 `next()`"
强得多：后者靠纪律，前者靠结构。

有一条**硬不变量**：`remoteHandlers` 里**不存在**
`approval/request` 与 `user-questions/request`，防止将来有人"好心"把它加回来。

---

## 7. 装配顺序与降级矩阵

`apply(ctx)` 的顺序（顺序本身是契约）：

1. `adoptStyles()` —— 注入样式（按 id 幂等）
2. `ctx.locale.register(NS, { zh, en })` —— 挂在 `ctx.effect` 上
3. 建立配置 store（先落默认值）；异步 `window.fetch` 一次宿主配置路由（`void loadSettings()`）
4. `ctx.inject(['uiWorkspace'])` 里取 `openSession`
5. 造 `chime` / `toasts` / **`relay`（宿主中继，主信号）** 三个通道
6. **先**用 `sessions.list` 建基线（必须在订阅任何事件之前，否则会被当成新完成）
7. 订阅 `sessions.list`（兜底边沿 + 标题刷新）
8. 订阅 3 个官方转发的 **emit** 事件（**不含** waterfall 的那两个，理由见 §6.1）
9. `ctx.inject(['uiSession'])` → 订阅 `sessionStatus`（待审批 / 待回答）
10. `ctx.on('connection/reset')` → rebaseline
11. 首次用户手势 → 解锁音频（仅降级路径会用到）
12. `ctx.slots.inject('settings.section')` → 注册设置页（总开关单独一块 + 功能开关列表 + 声音）
13. **能力看门狗**：`WATCHDOG_MS` 到点用 `degradationReport()` 检查静默失效路径并出声（新增第 5 条：中继路由试过但一次都没成功）
14. 发布 `window.__dshDoneVoice` 调试面（`config` / `engine` / `relay` 用取值器，永远读当前值）

**宿主半区 `apply(ctx)` 的顺序**（`index.js`）：

1. 读配置 + 出声（投递策略不是 `system`/`always` 时点名提醒）
2. `ctx.effect` 挂原生通道生命周期（卸载 / HMR 时 dispose，杀掉常驻 PowerShell worker）
3. **装配宿主传感器** `createHostSensors({ ctx, onEvent: handleSensorEvent })` + 挂 `ctx.effect`（失败必须 `console.error` 出声）
4. `ctx.inject(['settings'])` → 抑制自动生成页
5. `ctx.inject(['webServer'])` → 注册五条路由：配置 / 探针 / 中继 `/notify` / 试听 `/preview` / 音效管理 `/sounds.json`

| 缺失的东西 | 后果 | 处理 |
|---|---|---|
| **宿主 `webServer` 缺席**（连中继路由都注册不上） | 页面中继全部失败 | 页面自动降级成页内卡片 + 本地音并出声；宿主侧看门狗 5 秒后点名 |
| **宿主原生通道不可用**（无 powershell / WinRT 抛错 / 4 秒超时） | 外面弹不出来 | `notify()` **不抛异常**，返回 `degraded` 原因码；页面据此降级；`health.json` 的 `native` 与投递账本可查 |
| **宿主传感器装配失败**（`ctx.on` 不可用等） | 四类提醒只剩页面中继通道 | `console.error` 点名 + `health.json` 的 `sensors.reason` |
| `ctx.sessions.list` | 没有标题（降级为 8 位短 id）、没有兜底边沿通道 | **立即** `console.error` + 只靠远端事件通道照常工作 |
| `uiSession.sessionStatus` 服务始终不出现 | 审批/提问两类提醒不响（完成/失败照常） | 看门狗到点 `console.error` 点名 |
| `uiSession.sessionStatus` 形状不符 | 同上 | **立即** `console.error`（不等看门狗） |
| 配置路由始终没通 | 设置页改动只在本次页面有效 | 看门狗到点 `console.error` + 内存态生效 |
| 配置路由返回非 2xx / `window.fetch` 抛异常 | 同上 | **立即** `console.error` 点名"设置读取失败 / 设置保存失败" |
| `settings.section` 槽位始终没被声明 | 「设置 → 提醒」不会出现 | 看门狗到点 `console.error` |
| `uiWorkspace` 始终没就绪 | 点卡片只聚焦窗口，不打开会话 | 看门狗到点 `console.error` |
| 前台探测失败（worker 不在 / 拿不到自身进程名） | 按"你不在"处理：照弹系统通知 | 宁可多弹一条，也不漏提醒；原因进 `degraded` 与控制台 |
| `AudioContext` 不可用 | 无声 | 静默跳过（浏览器自动播放策略，非缺陷） |
| 宿主 `webServer` / `settings` 缺席 | 探针路由 / 自动页抑制不注册 | `console.warn` 带 `[donevoice]` 前缀（`optionalCapability`） |

> 前七条都是"看起来像没装"的路径，因此**每一条都必须出声**。其中"立即"与"看门狗"的区别是：
> 能当场判断的（形状不符、get 抛异常）立刻报；只能靠"等一段时间还不来"判断的（服务始终缺席）
> 交给 `degradationReport()` + `WATCHDOG_MS`。判断体是**纯函数**，所以这条硬规矩有单测钉住。

---

## 8. 视觉契约

数值来源：DSH 原生通知面（`Toast.module.css` 实测值）。

```
层级        #dsh-donevoice-layer  position:fixed; right/bottom:20px; z-index:1100
容器宽      min(360px, 100vw - 40px)；column-reverse（新卡片在下，向上生长）
卡片底      var(--dsw-alias-toast-bg, #353638)     ← 两套主题下都是深色面
卡片字      var(--dsw-alias-toast-label, #fff)
圆角/阴影   var(--dsw-radius-lg, 16px) / var(--dsw-shadow-lv3, …)
内边距      12px 12px 14px；grid: 图标 | 正文 | 关闭
图标        22×22，深底圆角 + 彩色描边字形（内联 SVG 字符串）
进度条      2px 高，贴卡片底，transform: scaleX 1→0，linear
进入        160ms ease-out + translateY(8px)
消散        200ms ease（比原生的 1000ms 淡出短——堆叠场景下 1 秒尾巴太拖沓，这是**有意偏离**）
强调色      完成 --dsw-alias-state-success-primary / 审批 --dsw-alias-state-warn-secondary
            / 提问·测试 --dsw-static-deepseek-400 / 失败 --dsw-alias-state-error-secondary
减弱动效    prefers-reduced-motion: reduce → 动画缩到 1ms、隐藏进度条
```

无障碍：

| 元素 | 属性 | 理由 |
|---|---|---|
| 容器 | `role="log"` `aria-live="polite"` `aria-relevant="additions"` | 多张卡片是"日志流"，不该互相打断 |
| 完成/提问卡 | `role="status"` | 礼貌播报 |
| **审批/失败卡** | `role="alert"` | 阻塞性/破坏性事件，断言式播报 |
| 卡片 | `tabIndex=0`，Enter/Space 打开会话 | 键盘可达 |
| 关闭按钮 | `aria-label` | 无障碍名 |
| 焦点 | `:focus-visible` 用 `--dsw-focus-ring-*` | 与原生一致 |

**刻意偏离原生 Toast 的 5 处**：位置（顶部居中→右下角）、可点击回会话（原生 `pointer-events:none`）、
忽略按钮与 Esc、堆叠、进度条 + 悬停暂停。这 5 处都是用户点名的 Codex / WorkBuddy 形态，**不是疏漏**。

### 8.1 顶部提醒（`noticeStyle = topCard`）：**由宿主原生窗口画**

顶部卡片与整屏边框**不在页面里**，而是宿主 worker 里一个 Win32 分层窗口画的
（`win-overlay.cs`，运行时由 `Add-Type` 现场编译）。

**为什么必须是宿主**：这个效果的意义恰恰是"我人不在页面上时，整块屏幕也要提醒我"。
页面 DOM 只在 DSH 窗口可见 —— 那正是要解决的问题本身。

```
窗口样式   WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW   （WS_POPUP）
          ⚠️ 刻意**不带** WS_EX_TRANSPARENT —— 带了就完全收不到鼠标消息，卡片点不动
尺寸      整块虚拟屏（GetSystemMetrics 76..79，覆盖多显示器）
绘制      每帧自己合成 32bpp 预乘 ARGB 位图 → UpdateLayeredWindow（约 30fps）
卡片      440 × 78 逻辑像素（按 DPI 折算），圆角 16，顶边距 52
          深色实底 + 1px 描边 + 左侧 3px 强调色竖条 + **左侧 DSH 标识**；**文字水平居中**
          版式（逻辑 px）：竖条 `cx+7`；标识 `cx+16` 见方 **32**、垂直居中；
          文字起点 `cx+59`（= 16+32+11）、右边距 12 ⇒ 宽度 369，在**这一块里**居中
          标识 = DSH 官方图标（白底圆角方块 + 深色鲸鱼），与系统通知里那个是同一个；
          base64 硬嵌在源码里（`MarkLeft/MarkSize/MarkGap/TEXT_PAD_R` 四个常量 + `DshMark()`），
          ⚠️ 为什么嵌 base64：`worker.ps1` 是把这份源码**文本**拼进去交给 `Add-Type` 编译的，
          C# 侧运行时拿不到插件目录，读外部文件这条路走不通
          ⚠️ **刻意不画投影**：GDI+ 没有廉价模糊，"三层逐级放大的实心块"叠出来
          必然是一圈圈硬边，真机上看着就是卡片底下压着一张重影。宁可平，不要脏。
出场      220ms：alpha 0→1，scale 0.94 → 1.02 → 1.00（过冲后回弹）
消散      cardMs 后 260ms 淡出
边框      只遍历四条条带、不扫全屏；羽化 `1 - d/fade` 平方衰减；色相查表 256 档；
          **周长上绕 2 圈彩虹**；角上走**平滑最小值** `SMin`（`k = 0.5 × 羽化`）
          ⇒ 直边一个像素不动，角上只磨出约 `k/4 ≈ 5.8px` 的小弧度。
          ⚠️ 四处判据必须**同源**（都走 `BandDistance`）：建表跳过、绘制跳过、条带范围、清除范围。
          历史上三次翻车都是它们不同源：① 只看一轴（`dx >= fade`）把**整条边的中段**误删
          ⇒ 边框成一块纯色；② 条带没跟着角弧放大 ⇒ 角上留下直角台阶；
          ③ 角上改用"到圆弧的距离" ⇒ 屏幕角那块 `d > 0`、暗掉一块（用户报"45° 位置有一点间隙"）。
          见 §8.2 与 `.workbuddy-ai/verify-corner-join.mjs`。
边框时长  **= 音效时长**（死逻辑，见 §4.3）
```

**点击回到 DSH（`R3`）**：

1. 窗口注册**自己的窗口类**（`RegisterClassEx`，而不是 subclass 一个 STATIC）——
   这样 `WndProc` 从创建那一刻就是我们的，不需要 `SetWindowLongPtr`，也没有 32/64 位之分。
   ⚠️ `WndProc` 委托**必须由静态字段持有**，否则被 GC 回收后窗口过程变野指针（"点几次突然崩"）。
2. `WM_NCHITTEST`：卡片矩形内 → `HTCLIENT`（可点）；矩形外 → `HTTRANSPARENT`（照旧穿透）。
   卡片淡出后 `hitAlpha` 归零 ⇒ 全屏恢复穿透。
3. 渲染循环里 `PeekMessage` 抽消息（非阻塞，不拖慢 30fps）。
4. `WM_LBUTTONUP` → **先写点击标记文件**（与 `activate.ps1` 同一条竞态约束：先落标记再抢焦点）
   → `SetForegroundWindow(DSH 主窗口)`（失败则 TOPMOST / 抖 Alt 两级兜底，与 `activate.ps1` 同款）
   → 置 `clickRequested`，渲染循环下一轮即收工（卡片立刻消失）。

> 为什么这里的 `SetForegroundWindow` 能成：Windows 的前台锁对"**刚刚收到用户输入的进程**"
> 是放开的，而这次点击正好落在我们的窗口上。

**降级**：`Add-Type` 编译失败 ⇒ worker 报 `overlay-error`，JS 侧打
`[donevoice] 覆盖层不可用 — compile: …`（**编译器的原话**），
并**兜底弹系统通知**（可点、能回会话），而不是一片空白。

### 8.2 边框光效（`edgeGlow`）

同属上面那个原生窗口，**不是** CSS 遮罩。

```
结构      单层：四条条带各自算 alpha，色相从 256 档查表取（避免每像素浮点 HSV）
距离      `d = BandDistance(x, y) = max(0, SMin(dx, dy, k))`
          · **直边**上 `|dx-dy| >= k` ⇒ `SMin` **恒等于** `min(dx, dy)`（与旧版逐点相同）
          · **角上**被磨成一小段圆弧：45° 处比直角**外扩 `k/4`**，等值线弧半径 ≈ `k/2`
          ⇒ 角上只会比直角版**更亮一点点**，绝不会出现"越靠角越暗"的缝
倒圆宽度  `k = CornerRound(fade) = CornerFadeScale × 羽化`（当前 `CornerFadeScale = 0.5`）
          `SMin` 的混合宽度，**不是**圆角半径；调"弧度大小"就动这一个常量
羽化      `alpha = intensity × (1 - d/fade)²`
条带      **四条条带的宽度都是 `span`**（`BandSpan = fade + ceil(k/4) + 1`）。
          因为 `d >= min(dx,dy) - k/4`，"可画"必然落在 `min(dx,dy) < fade + k/4 < span` 内
          —— 正好是"四条各 `span` 宽的条带"的并集。只扫 `fade` 宽会在角上漏掉一小条
          （`(x=fade, y=span)` 这类点：既不在左条带、也不在上条带，可 `d` 确实 `< fade`）
清除      `ClearStrips` 的范围**必须与上面画过的范围逐像素一致**（同样四条 `span` 宽）——
          只清 `fade` 宽的话，光效收尾时角上会留下一圈残影
相位路径  相位 = **四角按 `R` 倒圆后的周长参数**，`R = PathRadius = BandSpan + 2`。
          `R` **只**用于参数化颜色、不参与 alpha；取 `R >= span` 才能把 45° 参数接缝
          挡在羽化带外（四条边的参数在 45° 对角线上天生对不上，差一个 `arc`）
流动      一圈 7.5s / (speed/100)；亮度过呼吸
可调量    glowFade（16–110 逻辑 px，按 DPI 折成物理 px）/ glowIntensity（30–100%）/ glowSpeed（30–220%）
时长      死逻辑 = 音效时长（§4.3）；淡出占 35%（上限 450ms、下限 120ms）
```

> ⚠️ **角的教训（三次真机反馈："边角处没有衔接" → "角上这么厚实" → "45° 位置有一点间隙"）**
>
> 四种写法，逐个排除：
>
> 1. **`d = min(dx, dy)`（纯直角）**：角上等值线是**方**的，与绕 `(r,r)` 取角度的相位
>    不同心 ⇒ 内边界是一道直角折角。
> 2. **`d = ρ - |P - (ρ,ρ)|`（倒大圆角，`ρ = 2×羽化`，钳到 0）**：弧与屏幕角之间那块三角区
>    的 `d` 是**负**的、被钳成 0 ⇒ **整块满亮**，角上鼓出一大团。用户："角上这么厚实？"
> 3. **`d = |P - (ρ,ρ)| - ρ`（标准圆角矩形距离，不钳负）**：同一块三角区的 `d` 变成**正**的
>    ⇒ 屏幕角没被点亮 ⇒ **暗出一个小缺口**。用户："45° 位置有一点间隙"。
>    2 与 3 其实是同一个式子的两面 —— **"到弧的距离"和"直角距离"根本不是同一个等值线族**，
>    换成弧就必然在某处偏心（要么鼓、要么凹）。
> 4. ✅ **`d = max(0, SMin(dx, dy, k))`（平滑最小值）**：`SMin <= min`，天生只往"亮"的方向
>    偏 `k/4` ⇒ **既不会鼓包、也不会有缝**；而 `|dx-dy| >= k` 时它**恒等于 `min`**
>    ⇒ 直边一个像素都没动（"不改变显示逻辑"是硬保证，不是感觉）。
>
> 长度尺度与调参：`k = CornerFadeScale × 羽化`，**只动 `CornerFadeScale` 一个常量**。
> 当前 **0.5**（46px 羽化 ⇒ `k = 23px`）⇒ 45° 处外扩 `k/4 ≈ 5.8px`、等值线弧半径 ≈ `k/2 ≈ 11.5px`
> —— 相对 46px 宽的亮带，这就是"微微弧度"。
> 调参记录：`1.0×`（外扩 11.5px / 弧半径 23px）用户反馈"弧度再小一点" ⇒ 收到 `0.5×`。
> `0` 退回纯直角。预览器上的「角上倒圆」滑条就是这个倍数。
>
> 覆盖口径也是在这里定死的：`d >= min(dx,dy) - k/4` ⇒ 可画 ⊆ `{min < fade + k/4}`，
> 所以四条条带各要 `span = fade + ceil(k/4) + 1` 宽。**凡是"扫哪儿 / 算哪儿 / 清哪儿"，
> 都必须同源** —— 这一份几何被抄过四处（建表跳过、绘制跳过、条带范围、清除范围），
> 每处各错过一次，三次用户反馈分别对着其中一处。
>
> 校验：`.workbuddy-ai/verify-corner-join.mjs` 把 **C# 那一份**与**预览器那一份**
> 逐点对拍（同一个公式两边各写一遍，含 C# 的整数除法语义），外加四条性质判据：
> 直边恒等于 `min`、角上 `d <= min`、屏幕四角 `d = 0`、四角镜像对称；再验条带覆盖不漏。
> 它当场抓到过一个真 bug：**左右条带只扫 `fade` 宽** ⇒ `(x=fade, y=span)` 这类像素
> 既不在左条带也不在上条带，而 `SMin(fade, span, k) < fade` ⇒ 角上会缺一小条。
>
> `.workbuddy-ai/render-corner-ab.mjs` 把"有缝 / 纯直角 / 半倒圆 / 当前"四档各渲一帧、
> 四角 5 倍放大并排。量化口径用**屏幕角那一点的亮度**（判有没有缝）与**直边归零距离**
> （判直边动没动）：有缝那档屏幕角仅 6/255（3%），当前 207/255（满亮）；
> 四档的"直边归零"**完全相同**（44px）。
> （口径换过一次：起初用"相邻 alpha 跳变"，结果两版都是 9 阶 —— 因为 `alpha = f(d)` 且 `d`
> 逐像素只变 1，两版的 alpha 本来就都平滑。**指标返回"两版都是 0"时先怀疑指标本身。**）
>
> 角的弧度是**纯审美量**，预览器上留了「角上倒圆」滑条（`#rCorner`，0 ～ 2× 羽化，
> 默认 0.5×、0 = 纯直角）；C# 侧固定 = `CornerFadeScale`。`verify-border-preview.mjs`
> 专门查"滑条链路五环都通"——**假控件（拖了没反应）比没有控件更坑**。
> 滑条默认值 / 文档里的倍数 / C# 的 `CornerFadeScale` 三处必须一起改，
> `verify-border-preview.mjs` 与 `verify-corner-join.mjs` 都按 `CORNER_SCALE` 对拍，改漏会被抓。

**相位的三种算法，以及为什么选第三种**（`.workbuddy-ai/verify-phase-seam.mjs` 可复跑）：

| 算法 | 可见区最大相邻跳变 | 长短边速率比 | 同边内快慢比 |
|---|---|---|---|
| 按"最近边"取周长参数 | **115.3°** ← 就是那条 45° 硬边 | 1.00× | 1.00× |
| 从屏幕中心看的角度 | 0.12° | 1.19× | **3.01×**（彩虹在中段挤成一团） |
| **倒圆角周长参数（采用）** | **0.16°** | **1.000×** | **1.000×** |

> ⚠️ **接缝的成因**：最近边的分界线**正好是 45° 对角线**，而两条边的周长参数在角上
> 相差约一个屏宽 ⇒ 每个角都有一条硬边。这不是"参数没调好"，是**投影本身不连续**
> （角上的点到两条边距离相等，最近边不唯一）。倒圆角让最近点唯一，问题从根上消失。
>
> ⚠️ **度量的口径很重要**：第一版验证脚本没按可见度加权，报出 6.79° 的"残留跳变"——
> 追下去发现那个跳变发生在 feather ≈ 0（几乎全透明）的地方，肉眼根本看不见。
> **量"看不看得见"必须乘上 alpha**，否则会去修一个不存在的问题。

**三条仍然成立的历史结论**（它们解释了为什么不用页面那套）：

1. **要"连续渐变"就必须让遮罩/渐变本身连续** —— 别用"多条不同宽度的环叠加"去逼近羽化，
   宽度是离散的，逼近出来必然有台阶（用户原话："还是一层叠着一层"）。
2. **绝不在 `filter: blur()` 的元素内部做动画**（Chromium 会退回主线程逐帧重绘整屏模糊）。
3. 页面侧那套 CSS 实现（单层 + 连续羽化遮罩 + conic 彩虹）**已随方案 A 整体删除** ——
   保留它就意味着两套绘制要长期同步，而它们已经在果冻曲线/尺寸/圆角/配色上各自漂移了。

## 9. 安装与生命周期

- 安装三件事（`install.mjs`，默认预演、可逆）：profile `dependencies` 加 `link:`、`dsh.profile.bundles` 加一行、`node_modules` 建 junction
- 宿主条目 `donevoice` 由本插件自带的 `cordis.patch.yml` 插入；**profile 自己的 patch 不改**
- **`id: donevoice` 是契约**：它同时是 Loader 条目 id、settings.section 的槽位 id，配置路由名也取自它。
  三处必须一致（`client.js` 的 `HOST_ENTRY_ID` ↔ patch 的 `id`）
- 新的 JS 代际**必须重启桌面进程**才会被加载（`dsh-plugin-manager` README 原文）；客户端改动走 HMR
- 卸载：只删自己加的那一条依赖、那一个 bundles 项、那一个 junction

---

## 10. 验收策略（离线测试套件已按要求移除）

**现在的把关方式是端到端真机验收，而不是离线单测。**

```powershell
curl.exe -s http://127.0.0.1:<你的 DSH 端口>/plugins/dsh-donevoice/health.json   # 现在用手动三步验收，见 README
```

它按顺序验这几件事，任何一步不成立都会红：

| 步骤 | 验的是什么 |
|---|---|
| 探针 | 宿主半区活着；五条路由齐全；原生通道 `available`；宿主传感器已装配 |
| 四种提醒 | `POST /notify` × 4（**真实路由**，脚本自己抢走焦点保证"你不在"）→ 每发回执必须是 `delivered:["toast","sound"]`、`degraded:[]` |
| 通知历史两段 | 连发后最后一条在通知中心；隔 9 秒的两条都留在通知中心（证明同步机制没误删历史） |
| 投递账本 | 每条的 `source / delivered / degraded / latencyMs` 打出来给人看 |

**它证明不了什么（诚实边界）**：横幅有没有真的出现在你屏幕上、音效有没有真的响——
这两件事取决于专注助手/勿扰/音量/通知开关，脚本没有可靠的可编程观测手段，只有人眼人耳能定论。


**下面这些"看起来多余"的约束，每一条都对应一次真实事故或一类高危错误，改代码时别踩回去：**

| 约束 | 挡住的是什么 |
|---|---|
| `require` 必须在 9 个种子词内 | 旧版死于 `require` 一个不存在的包 → 条目 failed、`apply` 不执行 |
| 不得出现 `@deepseek-ai/dsh-client-runtime` | 该包在发行里不存在 |
| 不得存在 build 脚本 / `lib/` / `tsconfig.json` | 旧版交付的是"跑不起来的构建"；本插件的承诺是源码即产物 |
| 不得裸用 `fetch` / `setTimeout` | 动态包闭包里的教学陷阱；必须写 `window.setTimeout` |
| CSS 区域内不得出现反引号 | CSS 写在 JS 字符串里的经典自爆（会提前闭合模板串） |
| 版本号三处一致 / `HOST_ENTRY_ID` 两处一致 | 旧版四份时长数字互相打架的同类问题 |
| 中英文字典键集一致 | 缺键会在英文界面露出原始 key |
| 客户端的 `soundPreset` 枚举必须从 `SOUND_IDS` **派生**（宿主侧由 `/health.json` 的 `contract` 自检兜住） | 内联副本漏同步过一次：加了 5 套音效却漏改枚举 ⇒ 新值静默回落成 soft，用户听到"前 6 个声音一模一样"。这份契约在客户端是**内联副本**，改了宿主不会自动跟着变 |
| 无障碍属性齐备 | 通知类 UI 最容易被忽略的一环 |
| 视觉 token 存在 + `z-index:1100` | 防止"看起来像但其实是自创样式" |

---

## 11. 已知限制与未来

| 限制 | 性质 |
|---|---|
| 页面被冻结时**页面中继那条路**会停 | 平台限制；但宿主传感器不依赖页面，提醒照弹（这正是把检测放到宿主的原因） |
| 完成耗时是自测值 | DSH 浏览器侧不提供 turn 计时（`SessionSnapshot` 无 `turnTimings`） |
| 失败只覆盖会话级错误 | 只有 `api-session/error` 在白名单里；`agent/error` 未被转发 |
| `ctx.sessions.list` 未写进公开目录 | 有官方包内部使用证据；失败只损失标题，已降级 |
| **同一会话同时挂审批与提问时，官方只发布 precedence 胜者**（`ui-session:299-305`） | 本插件跟着官方口径走 ⇒ 那一刻只提醒一个；不是漏报，是官方聚合语义 |
| 降级卡片的本地音效需手势解锁 | 浏览器自动播放策略；只影响"宿主通道挂了"时的页内兜底 |
| **`win-overlay.cs` 没有在开发机上编译验证过** | 开发环境的 `csc.exe` / `Add-Type` 被安全策略拦住。已做的是括号配平自检 + 把 C# 的 `PhaseTable` 逐行镜像回 JS 与已验证实现**逐点对拍**；**首次真机运行必须看日志里的 `[donevoice] 覆盖层不可用 — compile: …`**（那是编译器的原话）。⚠️ **对拍本身也踩过一次坑**：采样循环当初复制了被测代码的同一条错判据，于是"边带中段没有相位"两边一起错、谁也没报（详见 CHANGELOG 1.2.0 末条）。现在的规矩是——**采样范围由独立判据决定，且必须正面断言现象本身**（`flatShare` 最大单色占比），不能只断言"跳变小" |
| 覆盖层点击的**端到端**效果（点一下是否真回到 DSH 并跳到会话）只能真机验 | 依赖 `SetForegroundWindow` 的前台锁放开，那一条没有离线复现手段 |
| **降级路径仍用页面自己的前台判断**（`isWindowBackground()`），与宿主的 `presence()` 可能给出不同结论 | 只影响"宿主通道全挂"时的兜底分支；改动收益低、风险高，暂时保留 |
| 覆盖层窗口是 `WS_EX_TOPMOST` 且铺满整块虚拟屏 | 卡片淡出后命中测试一律 `HTTRANSPARENT`（恢复全屏穿透），但它在那几秒里确实存在于 Z 序顶端 |
| 角度相位表按 `(w, h, fade)` 缓存，尺寸变化时重建 | 4K 下重建一次约 8 MB 内存 + 一次 `Atan2` 全扫；正常使用不会频繁触发 |

**未来候选**（按性价比排序）：会话名超长截断策略、按会话分组折叠、声音预设自定义音高、通知点击后高亮目标消息、
把 `sessionStatus.completionUnread` 接成第三条完成通道（官方判据，会**排除**用户正在看的会话；
当前刻意不用，因为产品口径是"前台也弹"）。

---

## 12. 与旧插件的对照

| 维度 | dsh-reminder | dsh-donevoice |
|---|---|---|
| 检测来源 | 客户端 `turnEnds` / `pendingInteraction` / `completed`（**全不存在**） | 3 个官方转发的 emit 事件 + `sessions.list` 兜底 + `uiSession.sessionStatus`（待交互） |
| 审批检测 | 读列表行的 `pendingInteraction`（该字段在列表行里**不存在**） | 读 `uiSession.sessionStatus` 的领域对象，按官方 `key` 做身份边沿 |
| 对审批的影响 | 订阅 waterfall 且不调用 `next()` 会**卡死审批** | **不订阅任何 waterfall**，结构上不可能干扰 |
| 去重 | `(会话,回合)` Set + 8 秒时间窗 | **单调周期号**（跨通道、跨重连都正确） |
| 宿主半区 | 自建 Typert Remote（158 行 + zod 依赖） | **零外部依赖**：`node:*` + `$DSH_HOME` JSON + 两条同源路由 |
| 设置持久化 | 自建 wire codec | `$DSH_HOME/donevoice/config.json`（`*.tmp` + `rename` 原子写、2 秒缓存）经同源 GET/PUT 读写 |
| 提示音 | 有（但文件头写"No sound, ever."） | 有，8 预设 × 主/下行，带限流与前台规则，注释与实现一致 |
| 前台行为 | 注释说只后台弹，代码没有焦点判断，PRD 说前台也弹（三方矛盾） | **固定行为**：宿主持有 Windows 前台窗口判据（`presence()`），在页面上不弹系统通知、走开必弹；有 `shouldChime` 明确规则 |
| 构建 | esbuild 三段 + tsc（跑不起来） | **无构建**，源码即产物 |
| 测试对象 | `lib-testing/` 的另一份构建产物 | `client.js` 原始字节 + 真实握手 |
| 交付物 | 无 `lib/`、无依赖、无 lockfile | 拷进 profile 重启即用 |
