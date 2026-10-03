# dsh-donevoice 开发文档

> 这份文档写给**想了解实现、想改、想照着写自己插件**的人。
> 只想安装使用的话看 [README.md](./README.md)；原生通知子系统的细节看 [NATIVE.md](./NATIVE.md)；
> 契约与数据流看 [ARCHITECTURE.md](./ARCHITECTURE.md)。

---

## 目录

- [与 dsh-reminder 的工程对照](#与-dsh-reminder-的工程对照)
- [还原 Codex / WorkBuddy 到了什么程度](#还原-codex--workbuddy-到了什么程度)
- [视觉规范（照抄 DSH 原生通知面）](#视觉规范照抄-dsh-原生通知面)
- [提示音规范](#提示音规范)
- [八个必须知道的坑](#八个必须知道的坑)
- [开发与验收](#开发与验收)
- [目录结构](#目录结构)
- [发版](#发版)
- [真机验收清单](#真机验收清单)
- [许可与出处](#许可与出处)

---

## 与 dsh-reminder 的工程对照

这不是 `dsh-reminder` 的补丁，而是**独立重写**：目标一致（DSH 的完成提醒），实现路径不同。
原版无法加载的具体原因逐条查清后才动手，下表是两者的工程对照。

| | dsh-reminder（旧） | **dsh-donevoice（本插件）** |
|---|---|---|
| 能不能装 | ❌ 无 `lib/`、无 `node_modules`、无 lockfile | ✅ **源码即产物**，拷贝进 profile 就能跑，没有构建命令 |
| 能不能加载 | ❌ `require("@deepseek-ai/dsh-client-runtime/client")` —— 该包在 DSH 里不存在 | ✅ 只 `require('react')`（平台基线种子词），模块表风险为零 |
| 检测对不对 | ❌ 读 `turnEnds` / `pendingInteraction` / `sessions.open()` —— 全都不存在 | ✅ 只用官方**顺序无关**的两类数据源：3 个转发的 emit 事件 + `uiSession.sessionStatus` |
| 会不会帮倒忙 | ⚠️ 若订阅审批 waterfall 且写错 `next()` 会**卡死审批** | ✅ **完全不订阅 waterfall**，只读一个 Map，结构上不可能干扰审批 |
| 设置怎么存 | ❌ 自建 Typert Remote（158 行 + zod 依赖），且导入不存在的导出 | ✅ 宿主零外部依赖：`$DSH_HOME/donevoice/config.json`（原子写）+ 同源路由 `GET/PUT` |
| 宿主半区依赖 | ❌ 导入不存在的 `settingsNamespace` | ✅ **只 `import 'node:*'`**（第三方插件 import 裸包名会链接期失败，实机验证过） |
| 文档一致性 | ❌ 注释/README/代码/测试至少 7 处互相矛盾 | ✅ 每处事实带 `path:line`，注释与实现对拍 |
| 测试测的是谁 | ⚠️ 测 `lib-testing/` 的另一份构建产物 | ✅ 用 `vm` 执行 `client.js` **原始字节** + 真实 ModuleLoader 握手，测的就是发布的那份 |

---

## 还原 Codex / WorkBuddy 到了什么程度

调研结论（综合 17 个来源 URL）：

**Codex 的真实行为**（出自其 `config.schema.json`）：

- `tui.notifications` = `bool | 事件白名单数组`，事件只有 **`agent-turn-complete`** 与 **`approval-requested`**，**默认 false**
- 走**终端转义码**（OSC9 / BEL），`notification_method = auto|osc9|bel`；`notification_condition = unfocused|always`
- **没有自定义音效文件** —— 它不会"叮"一声好听的

**我们的取舍（有意超越，且都有理由）**：

| 维度 | Codex | 本插件 | 理由 |
|---|---|---|---|
| 触发事件 | 2 个 | **4 个**（完成/审批/提问/失败） | DSH 的官方转发白名单里就有这四类信号，白拿 |
| 提示音 | 无（终端响铃） | **自带真实音效（MP3）** | 终端响铃音色不可控；收录真实音效比合成更耐听，且跟着插件走、不依赖外部目录 |
| 前台行为 | `unfocused` 才提示 | **完成不响、阻塞事件照响** | 你盯着屏幕时"叮"一下纯属噪音；但审批/失败是会卡住或已经坏掉的事，必须叫 |
| 点击行为 | 无 | **点卡片/通知回对应会话** | DSH 有 `uiWorkspace.openSession()`，不点白不点 |
| 视觉 | 终端转义码，样式由终端决定 | **右下角卡片，沿用 DSH 原生通知面 token** | 详情见下 |

**WorkBuddy**：本机 `workbuddy2api-panel` 是一个 Go 写的 API 网关（`wb2api.exe`），**全目录零前端源文件**，
联网也搜不到可靠的产品 UI 来源。所以"WorkBuddy 风格"我们按它自述的目标理解（原文 "Codex / WorkBuddy style"），
**没有编造任何 WorkBuddy 的行为**。

---

## 视觉规范（照抄 DSH 原生通知面）

| 元素 | 取值 | 出处 |
|---|---|---|
| 卡片底色 | `--dsw-alias-toast-bg`（浅色 `#353638` / 深色 `#43454a`，**两套主题下都是深色面**） | 原生 `Toast.module.css` |
| 文字 | `--dsw-alias-toast-label`（`#fff`） | 同上 |
| 圆角 / 阴影 | `--dsw-radius-lg`（16px） / `--dsw-shadow-lv3` | 同上 |
| 层级 | `z-index: 1100`（原生注释点名"高于图片灯箱 1000"） | 同上 |
| 进入动效 | 160ms ease-out + 位移 8px | 同上 |
| 强调色 | 完成 `--dsw-alias-state-success-primary`、审批 `--dsw-alias-state-warn-secondary`、提问/测试 `--dsw-static-deepseek-400`、失败 `--dsw-alias-state-error-secondary` | 主题 token 表 |
| 无障碍 | 容器 `aria-live="polite"`；完成卡 `role="status"`；**审批/失败卡 `role="alert"`**；关闭按钮有无障碍名；尊重 `prefers-reduced-motion` | 原生 `role="alert"` + 我们按"阻塞性"分级 |

**刻意偏离原生 Toast 的 5 处**（原生 Toast 是**顶部居中、点击穿透、无关闭按钮、不带堆叠、不可回会话**）：

1. 位置改**右下角**（用户点名的 Codex / WorkBuddy 形态）
2. 卡片**可点击**（回会话）——原生 `pointer-events: none`
3. 加**忽略按钮**与 **Esc** 关闭
4. 支持**堆叠**（上限可调，最旧的让位）
5. 加**消失进度条 + 悬停暂停**（原生是固定 `holdMs` 到点即走）

> 为什么不用官方 `@deepseek-ai/dsh-client-ui-primitives` 的 `Toast`（它就在种子表里、零依赖可 require）？
> 因为它是一个**受控的顶部 Toast**，上面 5 处全都要改，改完等于自己写一套，反而多背一个模块依赖。**决定：自建右下角卡片，数值照抄。**

---

## 提示音规范

**插件自带**的真实音效（`sounds/*.mp3` 15 个 + `sounds/*.wav` 33 个，共 **48** 个）+ `none` 静音。
它们**跟着插件一起走**：移动目录、打包给别人、换台电脑，音效都在——运行时不读任何外部路径。

完整的「id → 文件 → 生成时的文件名 / 来源」对照在 **`sounds/SOURCES.md`**
（33 个自制音效那张表由 `.workbuddy-ai/add-sounds.mjs` 生成，别手改）。

| id | 试听名 | 来源 |
|---|---|---|
| `bell` | 铃声 | dragon-studio（Pixabay） |
| `ping` / `ping2` | 叮·高 / 叮·低 | dragon-studio |
| `notify1` / `notify2` / `notify3` | 通知 1 / 2 / 3 | dragon-studio |
| `type20` | 音效 20 | ribhavagrawal |
| `msgping` | 消息提示 | universfield |
| `new017` / `new018` / `new02` / `new027` / `new03` | 新通知 0xx | universfield |
| `positive` | 轻快提示 | universfield |
| `system02` | 系统提示 | universfield |
| `ethereal_notify` / `notify_clean` / `dingdong` / `marimba` … | 空灵 / 干净通知 / 叮咚 / 马林巴 …（共 33 个） | **本项目自己生成**（WAV；完整清单见 `sounds/SOURCES.md`） |
| `none` | 静音 | — |

- **播放**：宿主常驻 worker 用 WPF `System.Windows.Media.MediaPlayer` 播（`Volume` 0..1 直接控音量）。
  选它而不是 `System.Media.SoundPlayer`，是因为 **SoundPlayer 只吃 WAV**，而这些素材是 MP3。
  每个文件只 `Open` 一次并缓存：首播约 290ms 准备时间，重播几乎瞬时。
  （无消息泵的隐藏进程里 `MediaOpened` 事件不触发——不需要等它，`Play()` 会自己排队。）
- **试听**走宿主路由 `POST /preview`：文件在插件目录里，**只有宿主播得了**；页面点了没反应不算试听，
  所以宿主通道不可用时它会退化成页内蜂鸣，绝不当哑按钮。
- **降级音**是极简蜂鸣（上行 A5→C#6 / 失败 A5→F5），不是自带音效：
  宿主通道挂了就拿不到插件目录里的文件，但"降级必须听得见"是硬不变量。
- **合法值不手抄**：客户端的 `soundPreset` 枚举由 `SOUND_IDS` 派生；宿主启动时自检
  `ENUM_FIELDS.soundPreset` 与 `SOUND_FILES` 是否一一对应，结论写进 `/health.json` 的 `contract` 字段。
- **何时响**：四类提醒都在你**已经切走窗口**时响（系统通知 + 音效，强制）；你在 DSH 页面上时保持安静（只有开了 `pageCard` 才出卡片）；
  任何情况下 **2 秒内最多响一次**。

> **踩坑记录（2026-10-02）**：加了 5 套新音效，却漏改客户端那份**内联**的 `ENUM_FIELDS.soundPreset`
> —— 新值全被判非法、`normalizeConfig` 静默回落成 `soft`，用户听到的是"前 6 个声音一模一样"。
> 现在两道防线：① 客户端枚举**从清单派生**，结构上不会再漏；② 宿主启动时自检并把结论
> 写进 `/health.json` 的 `contract` —— 不一致时探针里一眼看到，而不是等你听出来。

> 还有一个更阴的：客户端一度拿**静态清单**（`SOUND_IDS`）当白名单校验 `soundPreset`，而用户能自由导入音效 ——
> 结果"导入的音效一旦被选中会被判非法、回落成 `bell`，下一次保存就把 `bell` 写进磁盘"，用户的设置被静默抹掉。
> 现在两侧同口径：只校验 **id 语法**（`SOUND_ID_PATTERN`），"到底存不存在"由宿主扫盘决定。

> **同一个坑又踩了一次（2026-10-03，收录 33 个自制音效）**：这次要动的地方从 2 处涨到 **4 处** ——
> `SOUND_FILES` / `ENUM_FIELDS.soundPreset` / `SOUND_IDS` / `settings.sound.<id>` 的**中英各一条**标签；
> 而且新增那批是 **WAV**，而 `package.json` 的 `files` 只写了 `sounds/*.mp3` ——
> 症状是「源码目录里一切正常，从 GitHub 装的人下拉里有这个音效、点了没声」。
> 原来的产物自检只**数 `.mp3` 的个数**，15 个 mp3 还在 ⇒ 照样绿灯，属于**典型的盲区**。
> 现在两道新网：
> ① `scripts/check-package.mjs` **逐个**核对 `SOUND_FILES` 点名的文件在不在产物里
> （负控验过：去掉 `sounds/*.wav` 会精确点出全部 33 个缺失文件）；
> ② `.workbuddy-ai/verify-sounds.mjs` 把**四份清单 + 磁盘文件 + 中英标签 + files 白名单**钉在一起。

---

## 八个必须知道的坑

### 坑一：别用 `ctx.remote.$on('approval/request', …)` 做审批提醒

它看起来天经地义，实际是死路：

1. cordis 的 waterfall 按注册顺序串成一条链，只有调用 `next()` 才会把控制权交给**下一个**监听器；
2. 官方 `dsh-client-ui-approval` 在能显示审批 UI 的路径上**不调用 `next()`** —— 它 `await` 用户作答并把答案直接当作 waterfall 的返回值（`dsh-client-ui-user-questions` 同形）；
3. 第三方插件是 profile 里 `insert` 追加进来的条目，注册顺序排在 `dsh-web-app` **之后** = 链条**最内层**；
4. 而 `ctx.remote.$on` **不透传任何 options**，插件没有办法把自己插到前面。

结果：**在正常路径上**那个监听器一次都不会被调用，现象与"插件没装"一模一样。
（严格说：插件卸载 / HMR / fiber dispose 的兜底窗口里，官方仍会调 3 次 `next()` —— 独立复核抓到了这一点，
那三个窗口对"做提醒"毫无价值，所以结论不变，但"绝对不调用"这种断言该收一收。）
（这个问题是用真实 cordis 复现出来的。）

正确做法是读官方已经聚合好的状态：**`ctx.uiSession.sessionStatus`**
= `Map<sessionId, { running, pendingInteraction, completionUnread }>`，其中 `pendingInteraction`
就是审批/提问登记进来的领域对象，自带唯一 `key` 与 `toolName` / `questions` 详情。
**只读一个 Map、不参与任何决策** —— 既拿得到数据，又结构上不可能让审批卡住。

> 本插件因此**不注册任何 waterfall 监听器**，并有一条测试专门盯住这一点，防止将来"好心"加回来。

### 坑二：插件宿主半区**不能 import 裸包名**

`Config` + `.volatile()` 是 DSH 源码里插件声明设置的官方写法，照抄很自然。但**第三方插件用不了**：
宿主要 `import z from '@deepseek-ai/schemastery'`，而插件是靠 `link:` 装进 profile 的，
profile 的 `node_modules` 里**没有 `@deepseek-ai` 作用域**，Node 从插件目录往上找**找不到** ——
静态 import 是**链接期错误**，整个宿主条目加载失败。本插件装上后在真机实测：

```
node -e "import('@deepseek-ai/schemastery')"     # 在 profile 的插件目录里跑
→ ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'
```

旁证：本机**已经跑起来**的两个第三方插件（`dsh-status-rotator`、`dsh-prompt-studio`）
宿主半区**只 import `node:*` 内置模块**，配置各自落在 `$DSH_HOME/<插件>/config.json`。

所以本插件：宿主半区**零外部依赖**，设置落 `$DSH_HOME/donevoice/config.json`（`*.tmp` + `rename` 原子写），
由同源路由 `GET/PUT /plugins/dsh-donevoice/config.json` 读写，客户端用 `window.fetch`。

### 坑三：服务必须先写进 `exports.inject` 声明表（这个坑害我们丢了整整两类提醒）

想用 `ctx.uiSession` 读官方聚合状态？**光在代码里 `ctx.inject(['uiSession'], cb)` 是不够的**
—— 插件的服务可见范围由 `exports.inject` 决定，**没声明的服务既不能直接取，运行时注入也永远不会就绪**，
回调连一次都不会被调用。

本插件第一版就是这样（声明表只有 `sessions/remote/slots/locale`），于是：

- ✅ 完成 / 失败提醒正常 —— `remote` 声明过
- ✅ 设置页正常 —— `slots` 声明过
- ❌ **审批 / 提问两类提醒从装上到修复前一次都没响过** —— `uiSession` 没声明

而**当时 117 项测试全绿**：测试里的假 ctx 无条件把服务塞进子上下文，**比真机宽松**。

抓出它的不是测试，是**磁盘诊断**：客户端把每一步判定写进 `localStorage`，从 Chromium 的 leveldb
里读出来（DevTools → Application → Local Storage，键 `dsh-donevoice:status`），看到 pending 通道从未绑定、引擎计数恒为 0。

旁证：官方 `approval` 与 `user-questions` 的 `inject` 数组里**都显式含 `uiSession`**。

> **反面风险（独立审计 H-1）**：`inject` 是**全有或全无**的硬门槛——声明表里只要有一个服务在当前组合不存在，
> 插件就 INACTIVE，`apply` 整个不跑，**连"降级必须出声"都变成死代码**。所以这里只声明核心插件提供、
> 且本机已实测存在的服务，并用静态守卫钉住（删任何一个都会报红）。

> 这三个坑全都是**装上真机才暴露**的：静态读源码、写测试、刷覆盖率，一个都挡不住，
> 甚至测试本身会因为"假环境比真机宽松"而给出虚假的安全感。这就是"能不能用必须实测"的分量。

---

### 坑四：想给「边调边看」新写一套渲染（会与真机效果悄悄分叉）

边框那三个指标（羽化 / 浓度 / 流速）只能等到**提醒真的发生**时才看得见效果，而提醒是等来的。
用户要"调整时能实时看到"时，最直觉的做法是在页面里用 canvas / CSS 画一个"预览框"—— **千万别**。

理由：页面版和原生版是两套数学。`win-overlay.cs` 的几何用 `SMin` 平滑最小值把直角轻轻倒圆
（`k = 0.5 × 羽化`），`PathRadius` 又**只**用来参数化颜色而不参与 alpha —— 这些细节在页面里
重写一遍必然漂成另一个样子。用户看到"预览"和"真机"不一样时，会以为真机坏了，而你会在错的地方查。

**正确做法**：预览请宿主用**同一个** `RunOverlay` 画（`DvOverlay.ShowPreview`），并且让参数
**活**起来（渲染线程每帧读静态字段，`UpdatePreview` 只改字段、**不重启窗口**）——
于是"看到的"和"会发生的"是同一份代码。代价是三条容易漏的细节：

1. **相位要按时间累积**（`phaseAcc += dt / spinMs`），不能用 `el % spinMs`。后者在流速改变的
   那一刻相位会跳变（实测跳 0.11 圈），画面就是"闪一下"。（提醒路径仍用取模 —— 那条路
   `speedPct` 恒定，两者逐帧等价；改的只是预览分支。）
2. **羽化一变必须重建相位表**：`PathRadius` 依赖羽化，颜色参数化跟着它走。拿大羽化的表去画
   小羽化，彩虹的疏密就对不上保存后的效果 —— 那预览就失去意义了。
3. **预览每帧要清条带**：参数一变可画范围就变，上一帧画过、这一帧被 `d >= fade` 跳过的像素
   会留在缓冲区里（把羽化拖小 → 角上一圈残影）。按"两帧里更大的 `span`"清。
   提醒路径参数恒定，不做这件事、也不花这 ~1ms。

⚠️ 另外两条链路细节：**演示期间 worker 不能空闲自退**（默认 60s），否则用户停手看效果时
进程一退、屏幕上那圈边框就没了 —— 但标记要写成**截止时刻**而不是布尔量，放完自动恢复，
否则一轮演示就白换一个永不退休的常驻进程（见 `worker.ps1` 的 `$script:previewUntil`）。

**当前的交互不是"拖动时实时变"，而是「应用」→ 固定 10 秒演示**（用户定稿）：改滑条只动草稿，
点「应用」才写配置 + 请宿主放一段带 `durationMs` 的演示，到点由 C# 自己收。
上面那条活参数通道（`UpdatePreview`）仍在，将来想回到实时只需改设置页 —— 但那不只是"少点一次
按钮"：实时预览还要求 `stop` **绕过任何节流立刻发**，否则压着的 `update` 会在 `stop` 之后到达，
而 worker 对"没有在跑的预览"会**补开一个**，画面等于关不掉。

这些事由 `node .workbuddy-ai/verify-glow-preview.mjs`（113 项，§4 是数值仿真且带负控）与
`node .workbuddy-ai/render-section.mjs`（41 项，真渲染真点击）盯着。

---

### 坑五：让设置段组件去够 `apply(ctx)` 里的东西

**症状**：点「应用」后**配置存了、桌面什么都不放、按钮也不变**；更糟的是**离开设置页时
设置入口整个消失**。日志里只有一句 `ReferenceError: xxx is not defined`。

**根因**：`client.js` 里 `function DoneVoiceSection(props)` 与 `function apply(ctx)` 是**平级函数**
（都在工厂作用域下）。组件能看见的只有：工厂作用域的常量（`SOUND_IDS` / `GLOW_DEMO_MS` /
`DEFAULT_CONFIG` …）、同级的组件函数（`RangeRow` …）、以及 `props`。
**`apply` 里的任何东西它都够不着** —— 包括所有宿主桥（`sendGlowPreview`、`previewSound`…）。

为什么"入口会消失"：这个引用是在**点击回调**与**卸载清理**里断的。卸载清理抛出的错误发生在
React 的**提交阶段**，会把上面整片 UI 一起带走 —— 于是在用户眼里，插件表现成"把设置页弄坏了"。

**正确做法**：宿主能力一律经 `apply` 里的 `face()`（`ctx.slots.register` 的 `inject`）传进
`props` —— 与既有的 `update` / `preview` / `addSounds` 同一条路；组件侧拿不到就**降级**（提示
"宿主还是旧版插件"），绝不抛错。组件里要用的常量放**工厂作用域**。

**别指望文本判据**：当时 95 条判据全绿（它们只查"文件里有没有这个词"），而功能是死的。
要抓这类错误只有两条路，两条都做了：

- `.workbuddy-ai/render-section.mjs` —— 把真的组件抠到 Node 里，配无 DOM 垫片 + 最小 hooks，
  **真的去点**两颗按钮。抠出来的那段代码作用域里**只有它真的够得着的名字**，
  任何越界引用都会当场抛 `ReferenceError`。自带负控（把桥改回越界写法必须被抓到）。
- `verify-glow-preview.mjs` 里那条静态判据查的是**任何引用**（`\bsendGlowPreview\b`），
  不是"调用"（`sendGlowPreview(`）—— 第一版只认后者，于是 `const bridge = sendGlowPreview`
  这种裸引用照样溜过去，而它同样会抛错。

**顺带记一条**：演示计时器要用 `React.useRef` 持有，不能用闭包变量 —— 组件每轮渲染都会重新
执行函数体，闭包变量下一帧就被重置成 `null`（「演示中…」永不恢复，连点两次也清不掉旧计时器）。

---

### 坑六：把自检的临时目录放进工作区（它会攒成看不见的十几兆）

**症状**：工作区越来越大，而 `git status` 干干净净 —— 因为大件全在被 `.gitignore` 挡住的
目录里，谁都看不见。实测工作区 20 MB，`.workbuddy-ai/` 一个人占 13 MB，其中 3 个
`check-install-*` 目录各 4 MB。

**根因**：`scripts/check-package.mjs` 要在隔离的 DSH_HOME 里跑一遍 `install.mjs`，
那个 home 当时建在工作区内的 `.workbuddy-ai/` 下，**每一个里面都是一份完整的插件副本**。
自检正常跑完会自己删掉；可进程一旦被中断（Ctrl-C、超时被杀、CI 取消、被沙箱拦下），
`finally` 就不执行了。又因为它在 gitignore 里，没有任何一条常规检查会提醒你。

**正确做法**：机器的临时产物**别落在工作区里** —— 用 `os.tmpdir()`。
（原注释担心"installer 复制源码时会跳过它"，搬到工作区外之后这点自动成立。）
如果确实要在本地留一份，就必须同时配一条**能自己收尾**的清理，
而不是"下次开跑时顺手清" —— 后者在"再也没人开跑"时就等于永不清理。

**顺带记一条通用教训**：`.gitignore` 挡住的目录是**盲区**。`git status` 干净 ≠ 磁盘干净；
查体积要看 `du -sh .[!.]* *`，别只盯着被跟踪的那些文件。

### 坑七：拿 `--dsw-alias-bg-layer-2` 当"最底层的背景"

**症状**：某块面板在浅色主题下好好的，切到深色主题**文字整块消失**。

**根因**：DSH 的 `--dsw-alias-bg-layer-1/2` 不是"两个层级的颜色"，而是**两种材质**：

| 变量 | 性质 | 能当什么 |
|---|---|---|
| `--dsw-alias-bg-layer-1` | **实心**（浅色 `#fff`，深色 `#26272b`） | 可以当卡片底 |
| `--dsw-alias-bg-layer-2` | **半透明**（浅色 `rgba(127,127,127,.14)`，深色 `rgba(255,255,255,.08)`） | 只能叠在**实心底之上** |

layer-2 是"在已有底色上再压一层"用的。一旦它成了最底层（父元素没有实心背景），它就会去
和页面背景叠加 —— 深色主题下半透明白叠上去那块变成**浅色**，而文字用的是
`--dsw-alias-label-primary`（浅色）⇒ 对比度归零，字直接看不见。

**正确做法**：要"淡色底"就用**实心底 + 蒙层**，两层都安全：

```css
background:var(--dsw-alias-bg-layer-1,#fff);
background-image:linear-gradient(rgba(77,127,245,.09),rgba(77,127,245,.09));
```

**怎么发现**：这个是**截图看出来的**，不是推理出来的 —— 静态判据一条都抓不到它
（`color:var(--dsw-alias-label-primary)` 完全合法，没有任何"错"可查）。所以改完配色
一定要真截一张深色图看，手法见下方[「怎么亲眼看见设置页」](#怎么亲眼看见设置页)。

### 坑八：把"可折叠"写成条件渲染

**症状**：折叠功能看起来完全正常 —— 点一下收起、再点一下展开。但校验脚本开始**漏测**，
键盘 / 读屏也莫名够不到收起区域里的控件。

**根因**：`open ? children : null` 在收起时会把整棵子树**从虚拟树里摘掉**。
`render-section.mjs` 这类"把真组件抠到 Node 里遍历虚拟树"的校验脚本**看不见 CSS**，
只能看见"这个节点在不在" —— 于是"恰好处于收起态"的那次运行就少测了一片，
而且失败是**静默**的（判据数少了而已，脚本照样报全绿）。

**正确做法**：**永远渲染，收起只由 CSS 隐藏**：

```js
h('div', { className: 'dv-groupBody' }, props.children)   // 不判断 open：折叠只是视觉
```

```css
.dv-groupClosed .dv-groupBody{display:none}
```

折叠状态用 `aria-expanded` 表达（读屏照样知道现在是开是关），而不是靠"不渲染"。
`render-section.mjs` 里有一条判据钉死了这件事，并配了负控（注入条件渲染必须被抓到）。

---

## 开发与验收

**没有任何构建步骤**——改完 `client.js` 走客户端热重载；**宿主源码也支持热重载**（见 [NATIVE.md](./NATIVE.md) §8），否则需要重启桌面进程。

```powershell
# ① 探针：宿主活着吗 / 五条路由齐吗 / 音效与总开关什么状态
curl.exe -s http://127.0.0.1:<你的 DSH 端口>/plugins/dsh-donevoice/health.json

# ② 打四条真实提醒（每秒一条，四类各一），回执里看 delivered 与 degraded
foreach ($k in 'completion','approval','question','failure') {
  curl.exe -s -X POST http://127.0.0.1:<你的 DSH 端口>/plugins/dsh-donevoice/notify ^
    -H "content-type: application/json" -d "{\"kind\":\"$k\",\"sessionId\":\"manual-$k\"}"
  Start-Sleep -Seconds 1
}

# ③ 通知真的进了系统通知中心吗（回读历史，与探针里的 `deliveries` 账本互相印证）
powershell -NoProfile -Command "[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]; @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('DeepSeek.Harness.DoneVoice')).Count"
```

**注意**：第 ② 步只在你**没看着 DSH 页面**时才真的弹系统通知（走开才弹是定稿行为）；
你正坐在页面上时回执会是 `suppressed:"present"`，那属于设计。

**上面这些只能证明"进了系统通知中心"，不能证明"你屏幕上看见了"**——横幅可见性由专注助手/勿扰/系统通知总开关决定，
程序观测不到（真机用窗口类轮询试过），那一条只有人眼能定论（见文末验收清单）。

### 怎么亲眼看见设置页

设置页是纯 DOM + CSS，**不用启动 DSH** 就能看到真实观感 —— `verify-settings.mjs` 会把
**真的**组件渲染成一份独立 HTML：

```bash
node .workbuddy-ai/verify-settings.mjs      # → .workbuddy-ai/verify-settings.html
```

再用本机现成的 Chromium 内核截图（Windows 自带 Edge，**不需要装任何东西**）：

```bash
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=880,1300 \
  --screenshot="out.png" \
  "file:///<你的工作区>/.workbuddy-ai/verify-settings.html?theme=dark&glow=1"
```

- `?theme=dark` 换深色主题变量，`?glow=1` 替你展开「边框特效」。
  **深色那一张必须看** —— 坑七就是只看浅色图绝对发现不了的那种。
- 看不清细节就调大 `--force-device-scale-factor`（4 = 放大镜）并把 `--window-size` 只留顶部一条。
- 配色问题**静态判据查不出来**（合法写法，没有"错"可查），这张图是唯一能兜住它的。
- 截图产物放 `.workbuddy-ai/out/`（已被 gitignore，`install.mjs` 也会跳过），不要进仓库。

---

## 目录结构

```
dsh-donevoice/
├─ client.js            浏览器半区（手写单文件，只 require('react')）—— 中继宿主 + 失败时页内降级
├─ index.js             宿主半区：五条路由（配置/探针/中继/试听/音效管理）+ 门禁 + 跨通道去重 + 前台判断 + 装配传感器
├─ host-sensors.js      宿主侧四类触发检测（零 import，不依赖任何页面）
├─ win-native.js        Windows 原生通知通道：常驻 PS worker + WinRT toast（DeepSeek 图标）+ 自带 MP3 提示音
├─ sounds/              自带提示音（MP3）+ SOURCES.md（来源与署名）
├─ host-config.js       配置契约（零依赖纯模块，宿主用；客户端持内联副本）
├─ cordis.patch.yml     把宿主条目 donevoice 插入 profile
├─ package.json         dsh.bundle.patch + dsh.client.platform=web
├─ install.mjs          安装/卸载（默认**复制到 .dsh**、可逆、profile 自动定位；`--link` 开发直连）
├─ scripts/
│  ├─ check-package.mjs 发布自检：字段 / patch id / 版本号三处一致 / files 覆盖 / 无构建脚本（CI 也跑它）
│  └─ release.mjs       发版：三处版本号一起改 → 自检 → 提交 → 打 tag → 推送（默认预演）
├─ .github/workflows/   CI：ubuntu + windows × node 20/22 跑上面那个自检
├─ locale/{zh,en}.json  插件文案
├─ icon.svg
├─ LICENSE              MIT
├─ README.md            面向使用者：安装 / 使用 / 常见问题
├─ CHANGELOG.md         每版改了什么（用户视角）
├─ RELEASE.md           发版与上架：DSH 怎么装 GitHub 插件、仓库要满足什么、怎么打 tag
├─ DEVELOPMENT.md       本文件：开发视角
├─ NATIVE.md            原生通知子系统：为什么能弹到 DSH 外面、真机数字、自证方法
└─ ARCHITECTURE.md      契约文档：宿主事实 / 数据流 / 不变量 / 踩坑
```

> 目录里**只有运行时文件与文档**：出问题的排查过程、审计报告、离线测试套件、验收/诊断脚本都已清掉
> （先后删掉 `test/` 249 KB、`evidence/` 1047 KB、旧插件源码 103 KB、`tools/` 29 KB，以及 `win-native.js` 里
> 120 行的自检 CLI）。`npm pack --dry-run` 可核对随包发布的文件。

---

## 发版

改完代码、写完 `CHANGELOG.md` 里对应那一节之后：

```bash
node scripts/check-package.mjs              # 先自己过一遍自检
node scripts/release.mjs --bump patch       # 预演：1.1.0 -> 1.1.1，只打印要改什么
node scripts/release.mjs --bump patch --apply --push
```

发版脚本存在的唯一理由是：**版本号必须三处一致**——`package.json`、`index.js` 的
`export const version`、`client.js` 的 `const VERSION`。这是 `ARCHITECTURE.md` 里写死的契约，
手改三次一定会漏一次。脚本一起改，`check-package.mjs` 再验一遍。

完整的发版与上架流程（包括「DSH 到底怎么装一个 GitHub 插件」「仓库要满足哪些条件」）
见 [RELEASE.md](./RELEASE.md)。

---

## 真机验收清单

**已在真机实测（2026-10-01/02，运行中的 desktop 进程，走 HMR 热加载、未重启）**

- [x] 宿主半区活着：`GET /plugins/dsh-donevoice/health.json` → **200**，五条路由齐全、`native.available:true`、`sensors.attached:true`
- [x] **四种提醒全部由宿主进程弹到 DSH 外面**：走**真实**中继路由 `POST /notify` × 4 → 每发 `delivered:["toast","sound"]`（热路径 ~180–240ms 含卡片入场等待，冷启动 ~0.9–1.7s）
- [x] **Windows 通知历史回读**：`History.GetHistory("DeepSeek.Harness.DoneVoice")` 能读到（连发 4 条后留最后一条、隔 9 秒的两条都留 —— 两段都实测过；注意这个回读本身会间歇性返回空列表，见 NATIVE.md 的坑表）
- [x] **宿主传感器真机闭环**：跑一个真实 subagent → `sensors.completion=1`、`deduped=1`、`lastDelivery.source="host"`、`delivered:["toast","sound"]` —— **全程无任何页面参与**
- [x] **跨通道去重真机生效**：账本里同时出现 `completion src=host`（已送达）与紧随其后的 `completion src=client`（`delivered:[]`，被去重），用户只被响一次
- [x] **真实提问触发**：用户从 GUI 被提问时，宿主传感器收到该事件并计入去重；用户当场确认屏幕上弹出系统通知（页面中继先到、宿主观察后被去重 ⇒ 只有一张）
- [x] **真机抓到并修掉一条致命缺陷**：官方转发器先注册且不调 `next()` ⇒ 不 `prepend` 的 waterfall 监听器**永远收不到审批/提问**（症状：`sensors.question=0` 而 `source:"client"`）。修成 `{ prepend: true }` 后复验 `question=1`
- [x] **卡片与音效同步**：时间线连拍实测 —— 连发时新卡片 200ms 内占位（修前要等前一张消失，秒级）
- [x] **外观由截屏定案**：应用名 `DeepSeek Harness` + DeepSeek 图标；图标曾是"中文路径导致 Windows 加载不出图"（A/B 对照实验定的案）
- [x] 上面那三步手动验收全绿（探针 → 四种提醒 → 通知历史回读 → 与投递账本互相印证）
- [x] 常驻 worker 不泄漏：`Get-Process powershell` 计数为 1（就是它自己），无 `.tmp` 残留
- [x] 配置端到端：真 PUT → 真落盘 `~/.dsh/donevoice/config.json`（无 `.tmp` 残留）→ GET 回读一致
- [x] 安装脚本预演模式确认**零写盘**；打包产物解压到临时目录后宿主半区可直接加载
- [x] 从 GitHub 仓库用 pnpm 安装（`github:zywnb-2/dsh-donevoice`）实测成功，装出 31 个文件、关键文件齐全
- [x] 「陌生人首次安装」全流程实测：全新 profile + 自定义 `DSH_HOME`（不含 `.dsh`）→ 预演 → 安装 → 重复安装（幂等）→ 卸载，profile 完全还原

**尚需人工确认（程序看不到 DOM / 听不到声音）**

- [ ] 你眼前那一瞬间**有没有真的看到通知 + 听到音效**（脚本只能证明它们进了系统通知历史；屏幕表现取决于专注助手/音量/通知开关）
- [ ] 音效与卡片是否**同瞬**（同步逻辑等卡片入场 160ms 再起音；偏早/偏晚都只需改这一个常数）
- [ ] 「设置 → 提醒」页面目视检查：总开关关着时下面全部变灰不可点；打开后各项可写、改动能保持

> 说明：宿主源码热重载已打开（见 [NATIVE.md](./NATIVE.md) §8），所以上面的真机结论**不是"重启后应该会好"，而是"运行中的进程里已经好"**。

---

## 许可与出处

MIT。所有 DSH 接口用法均取自发行版源码（`0.2.0-rc.2`，逐条标注 `path:line`），
未复制任何第三方插件源码；竞品行为结论均带来源 URL。
