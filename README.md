# dsh-donevoice 🔔

**DSH 的完成提醒官**——你切到别的窗口忙时，任务**完成 / 等你审批 / 等你回答 / 执行失败**，
它**在 DSH 外面**（Windows 通知中心，屏幕右下角）弹原生通知 + 响一声，点击直接回到那个会话。

> **⚠️ 2026-10-01 重大改造：通知不再由页面发，改由 DSH 宿主进程发。**
> 起因：页内卡片切走窗口就看不见——**要提醒就提醒到 DSH 外面**，在哪个窗口都能看见、听见。
> 于是四类提醒的**检测与投递全部搬进宿主进程**：页面开不开、在哪个页面、标签冻不冻，都不影响提醒。
> 页面只保留"中继 + 中继失败时页内降级"的辅助通道。
> **投递策略是固定行为，不是可选项（用户定稿）**：**不在 DSH 页面上** ⇒ 系统通知 + 音效（强制，没有关掉它的开关）；
> **在 DSH 页面上** ⇒ 永不弹系统通知（"我在工作状态，能看到任务，提醒多余"），默认连卡片和声音都没有；
> 设置页只有**两个开关**：总开关 + 页内卡片（`pageCard`，默认关）。页内音效没有开关——你在页面上时保持安静，切走之后的系统通知 + 音效是强制的。
> 完整架构、真机数字与自证方法见 **[NATIVE.md](./NATIVE.md)**；手动自证步骤见文末「怎么自己验证」。

系统级卡片 + 柔和双音提示音（可自行上传音效），点击直接回到那个会话。

> 这不是 `dsh-reminder` 的补丁，而是**独立重写**：目标一致（DSH 的完成提醒），实现路径不同。
> 原版无法加载的具体原因逐条查清后才动手，下表是两者的工程对照。

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

## 🖥️ 平台要求（装之前先看这一条）

| 要求 | 说明 |
|---|---|
| **仅 Windows** | 系统通知走 **Windows 通知中心**，音效走 WPF `MediaPlayer`，点击回跳走 **AUMID 快捷方式 + `donevoice://` 协议处理程序**。这三样都是 Windows 专有。**macOS / Linux 上装了不会有任何反应**（宿主半区能加载，但弹不出通知）。 |
| DSH 桌面版（Electron） | 通知由 **DSH 宿主进程**发，不依赖页面；只要 DSH 在跑，你切到任何窗口都能收到。 |
| DSH 版本 **0.2.0-rc.2** | 开发与验证都在这个版本上做，用到的槽位/服务（`slots` / `uiSession` / `uiWorkspace` / `sessions`）都按该版本源码逐条核对过。换别的 DSH 版本可能因接口变化而失效——届时先看 `health.json` 与设置页是否出现。 |
| Node ≥ 20（只为跑安装脚本） | 没装 Node 也能装：用 DSH 自带的运行时即可 —— `"<DSH 安装目录>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" install.mjs`，或 `ELECTRON_RUN_AS_NODE=1 "<DSH 安装目录>\DeepSeek Harness.exe" install.mjs`（两条都实测可用）。 |
| 无需管理员权限 | 装/卸载都只动你自己的 profile 目录和一条 junction。 |

---

## ✨ 功能

| | 能力 | 说明 |
|---|---|---|
| 🟢 | **完成提醒** | 会话从「运行中」变为空闲 → 右下角「任务完成」+ 会话名 + **本次耗时**（引擎自测，见下） |
| 🟡 | **审批提醒** | 有操作在等你许可 → 「等待你的许可」+ 工具名 + 理由（`displayReason` 跟随语言） |
| 🔵 | **提问提醒** | Agent 用提问工具等你回答 → 「需要你的回答」+ 第一个问题 + 问题数 |
| 🔴 | **失败提醒** | `api-session/error` → 「执行失败」+ 错误摘要，配**下行**提示音 |
| 🪟 | **走开才弹，在页面上就不打扰** | **不在 DSH 窗口上**（切走 / 最小化，前台是别的进程）⇒ **一定**弹 Windows 系统通知 + 音效，**没有开关能关掉它**。**正看着 DSH** ⇒ 永不弹系统通知，默认连卡片和声音都没有；想要就单独打开「在 DSH 页面时也弹页内卡片」/「在 DSH 页面时也响音效」。判据是**系统前台窗口属于哪个进程**——宿主直接问 Windows，所以页面卡住、被冻结、压根没开都照样准 |
| 🖱️ | **点通知直接回到 DSH** | 通知带 `activationType="protocol"` + `launch="donevoice://focus"`；点击 → 系统调协议处理程序（**`wscript` + VBS，全程无窗口**）→ 脚本**先落标记再**把 DSH 窗口还原并置前，页面读到标记后跳到那张通知对应的会话；DSH 没在跑就直接启动它，页面装载时也会补读一次标记（冷启动不丢链接）。**两个真机坑**：只靠 AUMID 快捷方式时点击横幅毫无反应（探针 `clickHits` 长期为 0）；处理程序写 `powershell.exe` 会**闪一个黑色控制台窗口**（截图抓到 `PseudoConsoleWindow`）。最初点通知没反应，是因为 AUMID 快捷方式的参数只写了 `-Command "exit"`（只为注册，不为点击） |
| 🎨 | **卡片式原生通知** | 通知左侧是 **DeepSeek 图标本身**（不加圆环、不裁圆），标题与正文就是卡片那套文案；图标由宿主用 GDI+ 现画并缓存 |
| ⏱️ | **卡片与音效同瞬出现** | 三步做到：① 新横幅**先上屏、旧横幅立刻收掉**（同应用的横幅在 Windows 里排队，不收旧的新卡上不来——那正是"音效先响完、卡片才排队出来"的病根；先放后收让两段动画重叠，实测 200ms 内完成切换）；② 音效**等卡片画完那 160ms** 再起音，两者落在同一瞬；③ 收旧卡只在 8 秒窗口内做，隔得久的提醒不动它（保住通知中心的历史）。「四种通知全部测试」串行触发、每张间隔 1.6 秒 |
| 🖱️ | **点击回会话** | 点卡片或点通知 → 聚焦窗口 + 官方 `uiWorkspace.openSession()` 打开对应会话 |
| 🪟 | **离开宽限期** | 提醒事件发生的那一瞬间你还在 DSH 页面上、但 1.8 秒内就切走了 ⇒ 复核后**补发**系统通知，不会因为"判定时刻你恰好还在"而丢掉一整条提醒 |
| ⏱️ | **自动消散** | 默认 6 秒（可调 3–30 秒），带进度条；**鼠标悬停暂停计时**；可手动忽略；Esc 关掉最新的 |
| 🎵 | **15 个自带提示音 + 自由增删（收在一个模块里）** | 真实音效 MP3 **收录在插件里**（`sounds/*.mp3`），跟着插件走、不依赖任何外部目录。设置页可**试听**、可**导入自己的音效**（MP3/WAV/M4A/WMA/AAC，单个 ≤ 4 MB）、可**删除**；音量可调、可静音 |
| 🔁 | **双通道去重** | 远端事件与列表兜底同时到达只弹一次（单调周期号），同一审批 `callId` 只弹一次 |
| 🛡️ | **绝不妨碍你** | 页面半区**完全不订阅审批/提问的 waterfall 事件**（只读官方聚合状态），结构上不可能让审批卡住；宿主半区订阅了，但只观测 + 无条件 `next()`，并用 `{prepend:true}` 插到链首保证真的收得到；三处都有专项测试盯住 |
| 🈶 | **中英双语** | 设置页与卡片文案双语；字典键集由校验器保证一致 |
| 🔍 | **可观测** | `window.__dshDoneVoice`（实时配置/事件流/降级日志/测试触发器）+ 宿主只读探针 `GET /plugins/dsh-donevoice/health.json` |

---

## 🚀 安装

**默认只预演，不写盘**——先看清楚要动哪几个文件：

```powershell
cd <你放这个插件的目录>\dsh-donevoice
node install.mjs            # 预演：打印计划，不写任何文件
node install.mjs --apply    # 确认后执行（自动备份 profile 的 package.json）
```

脚本做**三件可逆的事 + 每次留一份备份**，**不动 profile 自己的 `cordis.patch.yml`**：

1. profile 的 `package.json` 加 `"dsh-donevoice": "link:<本插件绝对路径>"`
2. `dsh.profile.bundles` 追加 `"dsh-donevoice"`
3. `node_modules/` 下建一个指向本插件目录的 junction

> **备份**：每次 `--apply` 前会把 profile 的 `package.json` 备份成
> `package.json.donevoice-backup-<ISO 时间戳>.json`（同目录）。备份**不会自动清理**，多次安装会累积，可以手动删。
> 卸载（`node install.mjs --uninstall --apply`）是**外科式删除**本插件那一行 + 那条 junction，**再另存一份**备份，
> 而不是从备份整体还原——这样不会误伤你后来装的别的插件。
>
> 其它参数：`--profile <路径>` 指定目标 profile（默认自动定位当前 profile），`-h` / `--help` 看用法。

**profile 是自动找的**，不写死机器名：先看 `DSH_HOME`（没设就用 `~/.dsh`），再到 `<home>/profiles/*` 里找
「**含 `package.json` 且带 `dsh.profile.bundles`**」的目录；正好一个就用它，多个优先叫 `desktop` 的、
否则取最近改动的那个并出声说明；**一个都没有就直接报错退出**（exit 2）并告诉你怎么用 `--profile` 指定，
绝不静默往一个不存在的目录里装。

### 换一台电脑怎么装（打包给别人用）

包是**自足**的：没有任何第三方依赖、没有构建步骤、没有机器相关的绝对路径。三种方式随你挑：

```powershell
# 方式 A（推荐）：整个目录拷过去，直接在那边装
#   把这一个目录复制到对方机器任意位置（U 盘 / 网盘 / git clone 都行），然后在那个目录里跑：
node install.mjs            # 先预演，看清楚要动哪几个文件（不写盘）
node install.mjs --apply    # 确认后执行；profile 自动定位，--profile 可显式指定
#   重启 DSH 桌面进程 → 按上面「开发与验收」的三步验证

# 方式 B：打成 npm 包再拷（只带走 15 个文件、约 130 KB）
npm pack                          # 生成 dsh-donevoice-1.1.0.tgz
#   对方机器：解压 → cd package → node install.mjs --apply

# 方式 C：装到自定义 DSH home（多实例 / 非默认安装位置）
$env:DSH_HOME = 'D:\somewhere\.dsh'
node install.mjs --apply
```

**对方机器需要什么**：Windows 10/11、装了 DSH 桌面版、有 Node（DSH 自带 runtime 即可）。
**不需要**：管理员权限（开始菜单快捷方式与 junction 都是用户级的）、联网、任何 npm 依赖。
**第一次会自己准备什么**：`$DSH_HOME/donevoice/` 下生成 `config.json`、worker 脚本 `worker.ps1`、
点击激活脚本 `activate.ps1`、通知图标 `icons/*.png`，以及一个开始菜单快捷方式
`DoneVoice\DeepSeek Harness.lnk`——它注册通知的 AUMID，**同时决定通知上显示的名字与图标**
（Windows 对未打包桌面应用只认这里），所以通知上看到的是「**DeepSeek Harness**」+ DeepSeek 的图标。
全都在用户目录里，删插件目录不会留垃圾。

宿主条目 `donevoice` 由本插件自带的 `cordis.patch.yml`（`dsh.bundle.patch`）插入。

然后：

```powershell
# 4. 重启 DSH 桌面进程（新的 JS 代际必须重启才会被加载）
#    —— 例外：宿主源码热重载已在 profile 的 cordis.patch.yml 里打开（见 NATIVE.md §8），
#       这种情况下改插件源码不重启也会生效（实测改完 8 秒内 health 反映新代码）。
# 5. 一键真机验收（推荐）：探针 → 打四种通知 → 回读 Windows 通知历史 → 打印投递账本
# 验证：见「开发与验收」的三步（探针 → 四条提醒 → 历史回读）
#    期望：右下角依次弹出 4 张通知 + 4 种音效，末尾打印 TOTAL=4 与"全部通过"
# 6. 只看宿主活没活 / 原生通道可用没
curl http://127.0.0.1:19387/plugins/dsh-donevoice/health.json
#    期望 200，body 含 "host":"alive"、"native":{"available":true,...}、"sensors":{"attached":true,...}
# 7. 浏览器 devtools 确认客户端 bundle 进了启动图
__DSH_BOOT__.entries.map(e => e.id)   // 应含 "dsh-donevoice"
# 8. 打开「设置 → 提醒」→ 打开总开关 → 再打开你要的四类提醒（默认全是关的）
```

**回滚**：`node install.mjs --uninstall --apply`（只删自己加的那一条依赖、那一个 bundles 项、那一个链接）。

---

## ⚙️ 设置页（设置 → 提醒）

| 设置项 | 默认 | 说明 |
|---|---|---|
| **总开关** | **关** | 单独一块放最前，优先级最高。**关着时下面全部变灰、不可点**。开着 ⇒ 完成/审批/提问/失败四类提醒全都提醒 |
| 页内卡片 | **关** | **唯一的可选开关**：打开后你正看着 DSH 时也在右下角出卡片 |
| 提示音 | 铃声 | 15 个自带音效 + 静音；可试听 |
| 音量 | 70% | 0–100 |
| 音效库（N） | — | 展开后可**导入**（MP3/WAV/M4A/WMA/AAC，单个 ≤ 4 MB）与**逐条删除**；自带/导入有标签区分 |

> 页面上**一行解释文字都没有**（副标题、分组标题、每行的说明、"0 为静音"这类提示全部删除）。
> 四类提醒、页内音效、子代理**都没有开关**——它们的语义是硬行为（见下）。

> 设置页**只有"功能 + 开关"**：没有解释段落、没有测试按钮、没有诊断面板。
> 总开关单独一块放最前（优先级最高），**关着时下面全部变灰且不可点**；
> 「页内卡片」关着时，只服务于卡片的两个滑条（卡片停留 / 最多同时显示）同样变灰。
> 诊断仍然落盘到 `localStorage`（键 `dsh-donevoice:status`），排障时用 DevTools（F12 → Application → Local Storage）直接看。

设置**持久化在宿主的文件里**：`$DSH_HOME/donevoice/config.json`（写入走 `*.tmp` + `rename` 原子替换，
读取带 2 秒缓存），所以重启后还在，也可以用编辑器直接改。读写通道是本插件自带的同源路由
`GET/PUT /plugins/dsh-donevoice/config.json`（带跨站栅栏、64 KiB 上限、405）。若路由不可达，
会自动降级为"本次页面有效"并在控制台点名出声。

---

## 🎨 还原 Codex / WorkBuddy 到了什么程度

调研结论（综合 17 个来源 URL）：

**Codex 的真实行为**（出自其 `config.schema.json`）：
- `tui.notifications` = `bool | 事件白名单数组`，事件只有 **`agent-turn-complete`** 与 **`approval-requested`**，**默认 false**
- 走**终端转义码**（OSC9 / BEL），`notification_method = auto|osc9|bel`；`notification_condition = unfocused|always`
- **没有自定义音效文件** —— 它不会"叮"一声好听的

**我们的取舍（有意超越，且都有理由）**：

| 维度 | Codex | 本插件 | 理由 |
|---|---|---|---|
| 触发事件 | 2 个 | **4 个**（完成/审批/提问/失败） | DSH 的官方转发白名单里就有这四类信号，白拿 |
| 提示音 | 无（终端响铃） | **15 个自带真实音效（MP3）** | 终端响铃音色不可控；收录真实音效比合成更耐听，且跟着插件走、不依赖外部目录 |
| 前台行为 | `unfocused` 才提示 | **完成不响、阻塞事件照响** | 你盯着屏幕时"叮"一下纯属噪音；但审批/失败是会卡住或已经坏掉的事，必须叫 |
| 点击行为 | 无 | **点卡片/通知回对应会话** | DSH 有 `uiWorkspace.openSession()`，不点白不点 |
| 视觉 | 终端转义码，样式由终端决定 | **右下角卡片，沿用 DSH 原生通知面 token** | 详情见下 |

**WorkBuddy**：本机 `workbuddy2api-panel` 是一个 Go 写的 API 网关（`wb2api.exe`），**全目录零前端源文件**，
联网也搜不到可靠的产品 UI 来源。所以"WorkBuddy 风格"我们按它自述的目标理解（原文 "Codex / WorkBuddy style"），
**没有编造任何 WorkBuddy 的行为**。

### 视觉规范（照抄 DSH 原生通知面）

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

## 🎵 提示音规范

15 个**插件自带**的真实音效（`sounds/*.mp3`，共 833 KB）+ `none` 静音。
它们**跟着插件一起走**：移动目录、打包给别人、换台电脑，音效都在——运行时不读任何外部路径。

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
| `none` | 静音 | — |

- **播放**：宿主常驻 worker 用 WPF `System.Windows.Media.MediaPlayer` 播（`Volume` 0..1 直接控音量）。
  选它而不是 `System.Media.SoundPlayer`，是因为 **SoundPlayer 只吃 WAV**，而这些素材是 MP3。
  每个文件只 `Open` 一次并缓存：首播约 290ms 准备时间，重播几乎瞬时。
  （无消息泵的隐藏进程里 `MediaOpened` 事件不触发——不需要等它，`Play()` 会自己排队。）
- **试听**走宿主路由 `POST /preview`：文件在插件目录里，**只有宿主播得了**；页面点了没反应不算试听，
  所以宿主通道不可用时它会退化成页内蜂鸣，绝不当哑按钮。
- **降级音**是极简蜂鸣（上行 A5→C#6 / 失败 A5→F5），不是那 15 个音效：
  宿主通道挂了就拿不到插件目录里的文件，但"降级必须听得见"是硬不变量。
- **合法值不手抄**：客户端的 `soundPreset` 枚举由 `SOUND_IDS` 派生；宿主启动时自检
  `ENUM_FIELDS.soundPreset` 与 `SOUND_FILES` 是否一一对应，结论写进 `/health.json` 的 `contract`，
  `health.json` 的 `contract` 字段自检它。立的由来见下。
- **何时响**：四类提醒都在你**已经切走窗口**时响（系统通知 + 音效，强制）；你在 DSH 页面上时保持安静（只有开了 `pageCard` 才出卡片）；
  任何情况下 **2 秒内最多响一次**。

> **踩坑记录（2026-10-02）**：加了 5 套新音效，却漏改客户端那份**内联**的 `ENUM_FIELDS.soundPreset`
> —— 新值全被判非法、`normalizeConfig` 静默回落成 `soft`，用户听到的是"前 6 个声音一模一样"。
> 现在两道防线：① 客户端枚举**从清单派生**，结构上不会再漏；② 宿主启动时自检并把结论
> 写进 `/health.json` 的 `contract` —— 不一致时探针里一眼看到，而不是等你听出来。

- 设置页**试听按钮**可即时验证（试听走宿主路由 `/preview`，绕过限流与前台规则）

---

## 🧨 一个必须知道的坑（写给也想写这类插件的人）

**别用 `ctx.remote.$on('approval/request', …)` 做审批提醒。** 它看起来天经地义，实际是死路：

1. cordis 的 waterfall 按注册顺序串成一条链，只有调用 `next()` 才会把控制权交给**下一个**监听器；
2. 官方 `dsh-client-ui-approval` 在能显示审批 UI 的路径上**不调用 `next()`** —— 它 `await` 用户作答并把答案直接当作 waterfall 的返回值（`dsh-client-ui-user-questions` 同形）；
3. 第三方插件是 profile 里 `insert` 追加进来的条目，注册顺序排在 `dsh-web-app` **之后** = 链条**最内层**；
4. 而 `ctx.remote.$on` **不透传任何 options**，插件没有办法把自己插到前面。

结果：**在正常路径上**那个监听器一次都不会被调用，现象与"插件没装"一模一样。
（严格说：插件卸载 / HMR / fiber dispose 的兜底窗口里，官方仍会调 3 次 `next()`——独立复核抓到了这一点，
那三个窗口对"做提醒"毫无价值，
所以结论不变，但"绝对不调用"这种断言该收一收。）
（这个问题是用真实 cordis 复现出来的。）

正确做法是读官方已经聚合好的状态：**`ctx.uiSession.sessionStatus`**
= `Map<sessionId, { running, pendingInteraction, completionUnread }>`，其中 `pendingInteraction`
就是审批/提问登记进来的领域对象，自带唯一 `key` 与 `toolName` / `questions` 详情。
**只读一个 Map、不参与任何决策** —— 既拿得到数据，又结构上不可能让审批卡住。

> 本插件因此**不注册任何 waterfall 监听器**，并有一条测试专门盯住这一点，防止将来"好心"加回来。

### 第二个坑：插件宿主半区**不能 import 裸包名**

`Config` + `.volatile()` 是 DSH 源码里插件声明设置的官方写法，照抄很自然。但**第三方插件用不了**：
宿主要 `import z from '@deepseek-ai/schemastery'`，而插件是靠 `link:` 装进 profile 的，
profile 的 `node_modules` 里**没有 `@deepseek-ai` 作用域**，Node 从插件目录往上找**找不到** ——
静态 import 是**链接期错误**，整个宿主条目加载失败。本插件装上后在真机实测：

```
node -e "import('@deepseek-ai/schemastery')"     # 在 profile 的插件目录里跑
→ ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'
```

旁证：本机**已经跑起来**的两个第三方插件（`dsh-status-rotator@0.29.0`、`dsh-prompt-studio`）
宿主半区**只 import `node:*` 内置模块**，配置各自落在 `$DSH_HOME/<插件>/config.json`。

所以本插件：宿主半区**零外部依赖**，设置落 `$DSH_HOME/donevoice/config.json`（`*.tmp` + `rename` 原子写），
由同源路由 `GET/PUT /plugins/dsh-donevoice/config.json` 读写，客户端用 `window.fetch`。
`validate.mjs` 里有一条专门守卫：**宿主半区出现任何裸包名 import 就报红**。

### 第三个坑：服务必须先写进 `exports.inject` 声明表（这个坑害我丢了整整两类提醒）

想用 `ctx.uiSession` 读官方聚合状态？**光在代码里 `ctx.inject(['uiSession'], cb)` 是不够的**
—— 插件的服务可见范围由 `exports.inject` 决定，**没声明的服务既不能直接取，运行时注入也永远不会就绪**，
回调连一次都不会被调用。

本插件第一版就是这样（声明表只有 `sessions/remote/slots/locale`），于是：

- ✅ 完成 / 失败提醒正常 —— `remote` 声明过
- ✅ 设置页正常 —— `slots` 声明过
- ❌ **审批 / 提问两类提醒从装上到修复前一次都没响过** —— `uiSession` 没声明

而**117 项测试全绿**：测试里的假 ctx 无条件把服务塞进子上下文，**比真机宽松**。

抓出它的不是测试，是**磁盘诊断**：客户端把每一步判定写进 `localStorage`，我从 Chromium 的 leveldb
里读出来（DevTools → Application → Local Storage，键 `dsh-donevoice:status`），看到 pending 通道从未绑定、引擎计数恒为 0。

旁证：官方 `approval` 与 `user-questions` 的 `inject` 数组里**都显式含 `uiSession`**。
修复后加了一条专项测试：**假环境严格模拟"未声明 = 取不到"**，并要求 `deferredInjects` 必须为空。

> **反面风险（独立审计 H-1）**：`inject` 是**全有或全无**的硬门槛——声明表里只要有一个服务在当前组合不存在，
> 插件就 INACTIVE，`apply` 整个不跑，**连"降级必须出声"都变成死代码**。所以这里只声明核心插件提供、
> 且本机已实测存在的 6 个服务，并用 `validate.mjs` 两条静态守卫钉住（删任何一个都会报红）。

> 这四个坑全都是**装上真机才暴露**的：静态读源码、写测试、刷覆盖率，一个都挡不住，
> 甚至测试本身会因为"假环境比真机宽松"而给出虚假的安全感。这就是"能不能用必须实测"的分量。

---

## ⚠️ 已知限制（诚实清单）

| 限制 | 原因 | 影响 |
|---|---|---|
| **DSH 桌面进程整个退出后收不到提醒** | 通知由宿主进程发出，进程没了就没得发 | 任何本机方案的天花板；DSH 一开就恢复 |
| **首次提醒慢约 2 秒** | 要拉起常驻 PowerShell worker（之后 9–20ms） | 只影响进程起来后的第一条 |
| **系统通知不能带按钮** | Chrome/WinRT 页面上下文通知不支持 `actions` | 关闭靠自动消散 / 悬停系统 ✕；页内卡片**有**忽略按钮 |
| **专注助手/系统通知总开关会压掉通知** | Windows 行为 | 通知历史里仍有记录；`health.json` 的投递账本可作旁证 |
| **完成耗时长是"自测值"** | DSH 浏览器侧不提供 turn 计时 | 引擎自己记录"看到开始跑"的时刻，诚实标注为实测 |
| **失败提醒只覆盖会话级错误** | 只有 `api-session/error` 被官方转发到浏览器（`agent/error` 不在白名单） | 模型调用级错误可能不触发；已在代码注释中标注 |
| **子代理不提醒（硬规则，没有开关）** | 子代理会话会刷屏 | 只由主管会话提醒一次；这是写死的规则，设置页里**没有**对应开关 |
| **标题依赖会话标题源** | 取不到标题时降级为短 id / 省略 | **不会不弹**；已在探针与证据里标注 |

---

## 🔧 开发与验收

**没有任何构建步骤**——改完 `client.js` 走客户端热重载；**宿主源码现在也支持热重载**（见 [NATIVE.md](./NATIVE.md) §8），否则需要重启桌面进程。

```powershell
# ① 探针：宿主活着吗 / 五条路由齐吗 / 音效与总开关什么状态
curl.exe -s http://127.0.0.1:19387/plugins/dsh-donevoice/health.json

# ② 打四条真实提醒（每秒一条，四类各一），回执里看 delivered 与 degraded
foreach ($k in 'completion','approval','question','failure') {
  curl.exe -s -X POST http://127.0.0.1:19387/plugins/dsh-donevoice/notify ^
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

---

## 📁 目录结构

```
dsh-donevoice/
├─ client.js            浏览器半区（手写单文件，只 require('react')）—— 中继宿主 + 失败时页内降级
├─ index.js             宿主半区：五条路由（配置/探针/中继/试听/音效管理）+ 门禁 + 跨通道去重 + 前台判断 + 装配传感器
├─ host-sensors.js      宿主侧四类触发检测（零 import，不依赖任何页面）
├─ win-native.js        Windows 原生通知通道：常驻 PS worker + WinRT toast（DeepSeek 图标）+ 自带 MP3 提示音
├─ sounds/              15 个自带提示音（MP3）+ SOURCES.md（来源与署名）
├─ host-config.js       配置契约（零依赖纯模块，宿主用；客户端持内联副本）
├─ cordis.patch.yml     把宿主条目 donevoice 插入 profile
├─ package.json         dsh.bundle.patch + dsh.client.platform=web
├─ install.mjs          安装/卸载（默认预演、可逆、profile 自动定位）
├─ locale/{zh,en}.json  插件文案
├─ icon.svg
├─ LICENSE              MIT
├─ NATIVE.md            原生通知子系统：为什么能弹到 DSH 外面、真机数字、自证方法
└─ ARCHITECTURE.md      契约文档：宿主事实 / 数据流 / 不变量 / 踩坑
```

> 目录里**只有运行时文件与文档**：出问题的排查过程、审计报告、离线测试套件、验收/诊断脚本都已按要求清掉
> （先后删掉 `test/` 249 KB、`evidence/` 1047 KB、旧插件源码 103 KB、`tools/` 29 KB，以及 `win-native.js` 里
> 120 行的自检 CLI）。`npm pack --dry-run` 可核对随包发布的文件。

---

## ✅ 验收清单

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
- [x] 安装脚本预演模式确认**零写盘**；打包产物 `npm pack` 17 个文件、解压到临时目录后宿主半区可直接加载

**尚需人工确认（我看不到 DOM / 听不到声音）**

- [ ] 你眼前那一瞬间**有没有真的看到 4 张通知 + 听到 4 种音效**（脚本只能证明它们进了系统通知历史；屏幕表现取决于专注助手/音量/通知开关）
- [ ] 音效与卡片是否**同瞬**（同步逻辑等卡片入场 160ms 再起音；偏早/偏晚都只需改这一个常数）
- [ ] 「设置 → 提醒」页面目视检查：总开关关着时下面全部变灰不可点；打开后各项可写、改动能保持

> 说明：宿主源码热重载已打开（见 [NATIVE.md](./NATIVE.md) §8），所以上面的真机结论**不是"重启后应该会好"，而是"运行中的进程里已经好"**。

---

## 📄 许可与出处

MIT。所有 DSH 接口用法均取自发行版源码（`0.2.0-rc.2`，逐条标注 `path:line`），
未复制任何第三方插件源码；竞品行为结论均带来源 URL。
