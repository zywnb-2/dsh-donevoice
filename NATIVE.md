# 原生通知子系统 —— "弹到 DSH 外面去"

> 这份文档解释 **dsh-donevoice 为什么能在 DSH 窗口之外弹通知**、它是怎么做到的、以及**你怎么在 30 秒内自己证明它**。
> 验收标准（本次改造的口径）：
>
> > **工作完成、等你审阅、出现问题、向你提问**这四种情况一个不落，都要有卡片提醒 + 音效；
> > 不管当前停在哪个页面都要能弹到；**不在 DSH 内部弹卡片，一律弹到系统通知中心。**
>
> 结论：**四类触发全部在 DSH 宿主进程里检测，由宿主进程直接调 Windows 通知中心弹原生通知 + 播放提示音。**
> 页面开不开、在哪个页面、标签冻不冻，都不影响。DSH 页面只保留一条"中继 + 降级"的辅助通道。

---

## 1. 一句话架构

```
        ┌───────────────────────── DSH 宿主进程（Node，无页面）─────────────────────────┐
        │                                                                              │
  api-session/status ─┐                                                                 │
  session/event ──────┤                                                                 │
  api-session/error ──┼──► host-sensors.js ──► index.js deliver() ──► win-native.js ──► Windows 通知中心
  approval/request ───┤    （四类边沿/去重）      （门禁 + 跨通道去重     （常驻 PS worker）     └─ 右下角卡片
  user-questions/req ─┘                          + presence 前台判断）   ├─ toast + 音效      └─ 提示音（合成 WAV）
                                                                        └─ presence()：前台是不是 DSH？
        │                              ▲                                  ▲
        │                              │ POST /plugins/dsh-donevoice/notify │
        │                       ┌──────┴───────┐                           │
        └── HTTP 路由 ──────────┤  DSH 页面     │  client.js：**永远中继**（走开必弹），失败才在页内弹卡片兜底
                                └──────────────┘  拿到 suppressed 回执后按唯一的可选开关 pageCard 决定页面内动作
```

**deliver() 的顺序**（固定行为，没有档位）：门禁 → 跨通道去重 → **presence 前台判断**
→ `present:true` ⇒ 记一条 `suppressed:'present'` 收工：系统通知不弹、音效不响（页面内只按 `pageCard` 决定要不要出卡片）
（`soundPlayed:true`），页内卡片由页面拿到回执后自己渲染。
→ `present:false`（你走开了）⇒ **原生通知 + 音效，强制**。

**两条通道，一个出口**：页面只是"顺便也能看见"的辅助通道；**主通道是宿主自己**。

---

## 2. 四类触发在宿主侧的来源（全部真机验证过）

| 类别 | 触发源（宿主事件） | 备注 |
|---|---|---|
| 🟢 完成 | `session/event` 的 `turn/end`（首选，带耗时）→ 兜底 `api-session/status(sid,false)` 的 `true→false` 边沿 | 耗时 = `turn/start` 与 `turn/end` 的 `event.time` 差；无则省略，不编 |
| 🟡 审批（审阅） | `approval/request` waterfall 的 `req`（`toolName` / `reason` / `callId`） | **只读 + 无条件 `next()`**，结构上不可能卡住审批（见 §5） |
| 🔵 提问 | `user-questions/request` waterfall 的 `request.questions` | 同上 |
| 🔴 失败 | `api-session/error(sid, message)`，兜底 `session/event` 的 `turn/end` reason | 下行音效 |

权威事件签名用 `cordis_inspect`（host / Event）取。

**关键事实**：这些事件在**根上下文的插件里都收得到**。原因是 cordis 的 `dispatch()`（`cordis/lib/index.js:258-264`）只有在第一个参数是 scope carrier 时才做过滤，而 `dsh-scope` 的 `scopeTarget` 过滤放行**未打 scope 标签**的监听器（`dsh-scope/lib/index.js`）。
这条不是推断：Lead 在运行中的宿主里挂过临时探针，实测一个 subagent 的完整生命周期给出恰好 2 次 `api-session/status`、`session/event` 里能看到 `turn/start` / `turn/end`。

> ⚠️ **但"收得到"还有个更隐蔽的前提：链条顺序。** 两条 waterfall 是**按注册顺序串链**的（`cordis/lib/index.js:317-325`，不调用 `next()` 就截断），而官方把这两条转发给浏览器的转发器（`dsh-api-remotes/lib/index.js:140-158`）注册得比本插件**早**，它在拿到用户答案后**直接 resolve、不调用 `next()`**（同文件 `214-232`）。
> ⇒ 不插队的话，我们的监听器排在链尾，**正常路径上一次都不会被调用**。
> 这是**真机抓到的**：用户触发一次真实提问后，投递账本显示 `source:"client"`（通知是页面中继弹的），而 `sensors.question` 是 **0**。
> 修法：两条 waterfall 用 `ctx.on(name, listener, { prepend: true })` 注册成**最外层包装**（官方自己也用这招插队：`cordis/lib/index.js:246-249`）。我们仍然无条件 `return next()`，所以链的行为不变——只是这次我们看得见了。
> 修复后同一实验：`sensors.question = 1`、`deduped = 1`、`source:"client"`（页面先到）⇒ 用户只收到一张。

---

## 3. 原生通知通道（`win-native.js`）

| 维度 | 实现 |
|---|---|
| 投递 | `powershell.exe`（**Windows PowerShell 5.1**，WinRT 投影只在 5.1 里现成可用）→ `ToastNotificationManager.CreateToastNotifier(aumid)` |
| 视觉 | `ToastGeneric` + `appLogoOverride`：左侧**就是 DSH 自己的应用图标（DeepSeek 标志）本身，不加圆环、不裁圆**（用户逐次点名定稿：彩色圆 → 带类别色外环 → **只有图标**）。拿不到应用图标才退回"实心彩色圆 + 白色字形"（那时圆是图标本身，不是装饰）。图标由 worker 用 **GDI+ 现画**并缓存（宿主机上没有 canvas，也不该为一个图标引图形库）。**必须落在纯 ASCII 路径**（`%PUBLIC%\DoneVoice\icons`）——中文路径的 `file:///` URI 会被百分号编码、Windows 加载不出图片（真机截屏对照实验定的案，见 §10） |
| **不用 `scenario="reminder"`** | 常驻提醒横幅不会自动消失，多条并发时 Windows 会把它们**排成一队慢慢放** —— 于是人听到的是"音效全响完了，卡片才一张张冒出来"。改成普通 toast 后，每一条弹出即伴随自己的音效 |
| AUMID / 应用名 | AUMID `DeepSeek.Harness.DoneVoice`；**通知上显示的应用名与图标由该 AUMID 对应的开始菜单快捷方式决定**（Windows 对未打包桌面应用只认这里）：快捷方式文件名 = `DeepSeek Harness.lnk` ⇒ 通知写「DeepSeek Harness」；`IconLocation` 指向 **DSH 自己的 exe**（`<appRoot>\DeepSeek Harness.exe,0`，应用根目录从宿主入口参数里的 `resources\app.asar` 反推出来，**不写死路径**）⇒ 通知上是 **DeepSeek 的图标**。注册失败回退 PowerShell 自带 AUMID 并出声 |
| **点击通知回桌面** | 通知 XML 带 `activationType="protocol" launch="donevoice://focus"`，启动时在 `HKCU\Software\Classes\donevoice\shell\open\command` 注册同名协议 ⇒ 点击 = `ShellExecute(donevoice://focus)` ⇒ **`wscript.exe //B activate.vbs`**（GUI 宿主，**不产生控制台窗口**）⇒ 隐藏拉起 ``activate.ps1``：**先落点击标记、再**恢复并置前 DSH 主窗口（最小化会先 SW_RESTORE），DSH 没在跑就直接启动它。**为什么这样能抢到焦点**：Windows 只允许"当前前台进程"抢焦点，而这个脚本正是被用户点击通知拉起的，此刻它就是前台。**顺序是硬要求**——真机踩过的竞态：先抢焦点的话，页面在拿到焦点那一瞬读到的标记还是空的，它又不会读第二次 ⇒ "窗口回来了但没跳到会话"。页面读到标记后调 `uiWorkspace.openSession` 跳会话；宿主探针 `?probe=click` 的 `clickProbes`/`clickHits` 是这条链路的可观测证据。**另一个坑**：最初 arguments 写成 `-NoProfile -WindowStyle Hidden -Command "exit"`（只为注册 AUMID），点通知只会拉起一个立刻退出的隐藏 PowerShell —— 用户看到的就是"点了没反应" |
| 品牌升级 / 迁移 | 快捷方式旁边写一个 `.donevoice-branding` 标记（`名字\|AUMID\|图标`）。只查"快捷方式里有没有我们的 AUMID"**看不出图标/名字是否过期**，靠标记触发重建；旧版 `DoneVoice.lnk` 会被自动删除（同一个 AUMID 留两份注册会让名字二义） |
| **协议处理程序别写 powershell.exe** | 它是控制台子系统程序：窗口在解析 `-WindowStyle Hidden` **之前**就建好了，所以点通知会**闪一个黑色控制台窗口**（真机用窗口类轮询抓到 `PseudoConsoleWindow`）。改成 `wscript.exe //B activate.vbs`（GUI 宿主、无控制台），VBS 用 `shell.Run cmd, 0, False` 隐藏拉起 PowerShell。⚠️ VBS 里带中文路径 ⇒ 必须写 **UTF-16LE + BOM**，否则 WSH 按 ANSI 读会把路径读成乱码 |
| **前台锁：临时置顶比抖 Alt 更稳** | 后台进程直接 `SetForegroundWindow` 常常只让任务栏闪一下。参考实现（Electron 版）用的是"临时置顶"：`SetWindowPos(HWND_TOPMOST)` → focus → 120ms 后 `HWND_NOTOPMOST` 复位。现在三级兜底：直接 focus → 临时置顶 → 抖 Alt 键 |
| **冷启动要补读一次点击标记** | 点通知时 DSH 可能没在跑，脚本会把它启动起来；此时页面"出生就带焦点"，**不会触发 focus 事件** ⇒ 只监听 focus 的话永远不跳会话。页面装载 1.2 秒后主动补读一次（对应参考实现的 early-open-url-capture） |
| **设置"改了但重开又变回去"** | 三个原因叠在一起：① 页面装载时宿主路由可能还没就绪，那一次 GET 失败后**只有窗口重新聚焦才会重读**——冷启动时窗口本来就聚焦，不会产生 focus 事件，于是永久停在默认值；② 拖动滑条连发几十个 PUT，并发到达顺序不保证；③ 最要命的：**配置还没读到时 `settings` 就是默认值**，此刻把"默认值 + 你改的那一项"整份 PUT 回去，会把磁盘上其它字段全抹成默认。现在：读取**退避重试**（400ms→800ms→1.6s→3.2s→5s，前几次不出声）、写入**防抖 250ms + 串行排队**、并且**没读到真实配置就拒绝写盘**（先读一次，读不到就不写并出声告知）；关页/隐藏前用 `keepalive` 尽力把最后一笔写出去 |
| **客户端拿静态清单校验 soundPreset** | 宿主早就改成"按 id 语法"（用户能自由导入音效），客户端却还拿 `SOUND_IDS` 当白名单 ⇒ **导入的音效一旦被选中会被判非法、回落成 bell，下一次 PUT 就把 bell 写进磁盘**——用户的设置被静默抹掉。两侧现在同口径（`SOUND_ID_PATTERN` + `isSoundId`），并有对拍断言盯着 |
| **设置页滚动条导致页面抖动（三次迭代，前两次都翻车）** | 展开音效库后页面变高 ⇒ 宿主设置面板出现纵向滚动条 ⇒ 内容整体左移（点一下抖一下）。① 把展开体改成 `position:absolute` 浮层——**没用**，绝对定位不占布局高度，但**仍会扩张滚动容器的可滚动区域**（实测 `scrollHeight` 560→619）。② 用 `:has(.dv-section){scrollbar-gutter:stable}` 给可滚动祖先预留装订线——**更糟**：`:has(.dv-section)` 命中**所有祖先**（含应用外壳），结果**整个 DSH 页面被挤窄左移**。③ **定稿**：全部回退，改成让滚动条**常驻**——`.dv-section{min-height:calc(100vh - 80px)}` 用一块看不见的留白把自己撑高，面板始终可滚 ⇒ 滚动条不再忽隐忽现，抖动从根上消失。**只动自己的元素，绝不碰宿主面板的样式**。实测三种窗口尺寸、收起/展开/再收起三态：滚动条始终存在，内容宽度恒为 697、左边距恒为 40 |
| **失败也会占掉去重名额** | 曾经在拿到投递结果**之前**就 `rememberDelivery`：弹失败的那条把名额占了，紧接着重试/另一条通道来的同一件事被判成重复而丢掉。现在**只有 `delivered.length > 0` 才记账**（对应参考实现的坑：投递之前就 ack 成"已展示"） |
| **前台判断是二值 + 判在事件时刻** | 你在任务收尾的同一秒切走窗口 ⇒ 判定时"还在页面上"⇒ 不提醒，而那条提醒就此永远错过。现在加了**离开宽限期**：被静默后 1.8 秒复核一次，其间切走就补发（去重键保证不会重复弹，复核那次不再排复核，定时器 `unref()` 不挡宿主退出） |
| **同一音效连发会把上一声切碎** | MediaPlayer 一个文件一个实例，同一文件再 `Play` 会先把上一声掐掉（`Position` 归零）⇒ 两个会话几乎同时收尾时人耳听到半截音。现在按**文件**做最短重播间隔（900ms），被挡下时回执是 `skippedMinGap`（如实标注，不谎报 failed；页面也不会再补一声） |
| **"没看到横幅"最常见的答案** | 系统通知总开关（`PushNotifications\ToastEnabled` / `NOC_GLOBAL_SETTING_TOASTS_ENABLED`）被关掉时，`Show()` 依然"成功"，但屏幕上什么都不会出现。worker 在 READY 里回报 `toastEnabled` / `toastGate`，关着就在宿主日志里当场出声，探针里也能看到，验收会断言"已探明"。（专注助手是 CloudStore 里的二进制 blob，解析不可靠 ⇒ **不猜**，标 `unknown`） |
| **MediaPlayer 会占住音效文件** | `MediaPlayer.Open()` 之后文件句柄一直被拿着 ⇒ 宿主删不掉那个音效（`EPERM`），而且 `rmSync` 可能**先报成功、文件还在**。所以「删除音效」必须先让 worker 执行 `release`（把所有缓存的播放器 `Close()`）再删，删完还要复核 `existsSync`，还占着就如实回 409 |
| **点击通知需要协议激活** | 只注册 AUMID 快捷方式时，真机点击横幅**什么都不会发生**（探针 `clickProbes` 一直涨、`clickHits` 始终 0 = 激活脚本从未执行）。正确做法是通知里声明 `activationType="protocol"` + `launch="donevoice://focus"`，并在 HKCU 注册该协议 |
| **一次失败会派两个事件** | 客户端引擎里 `api-session/error` 报失败，紧接着 running→false 又报「完成」，用户会收到两条提醒；宿主传感器遇到 error 是直接 return 的 ⇒ 客户端补齐同一口径：失败后 10 秒内不再报该会话的完成 |
| 启动方式 | worker 脚本**落盘 + `-File`**（`$DSH_HOME/donevoice/worker.ps1`，**带 UTF-8 BOM**）。两个真机踩过的坑：① `-EncodedCommand` 会撞 Windows 命令行上限（32767）→ `spawn ENAMETOOLONG`；② PowerShell 5.1 读无 BOM 的 .ps1 会按系统 ANSI（GBK）解，中文注释变乱码直接语法崩溃——而 **pwsh 7 默认按 UTF-8 读，所以"pwsh 里解析 0 错误"会骗人**。现在有一条用例专门请真 5.1 当裁判。落盘失败且编码后超限时**明确降级 `script-too-long`**，绝不装作能跑 |
| 常驻 worker | 惰性拉起一个常驻 PowerShell 进程，按行收 JSON 指令；空闲 60 秒自退；`child.unref()` **绝不拖住宿主进程退出**（有通知在飞时临时 pin，送完立刻 unpin）；`dispose()` 干净杀掉 |
| 音效 | 插件自带的 15 个 MP3（`sounds/`），由常驻 worker 用 WPF `MediaPlayer` 播放（`Volume` 直接控音量）。**为什么不是 SoundPlayer**：它只吃 WAV。落到 `$DSH_HOME/donevoice/sounds/`（文件名带合成版本 `-r2`，换波形后旧文件会被自动清掉），用 `[System.Media.SoundPlayer]` 播放。**8 套预设 × 主/下行**，五类音色：`pure` 纯正弦 / `bell` 非整数泛音 2.76× / `wood` 4× 快衰减 / `glass` 6.5× 脆泛音 / `warm` 整数泛音近似三角波。`volume` 真实作用于振幅（v100 峰值 0.55–0.82，与旧版 0.85 同档、不削顶） |
| **卡片与音效同步** | 命门是：**同一个应用的横幅在 Windows 里排队**（前一张不消失，后一张不上屏），而音效在 `Show` 之后立刻响 ⇒ 多提醒时"音效先响完、卡片几秒后排队出来"。三步修好：① 新横幅**先 Show**、旧横幅**再 Hide**（收/放两段动画重叠，实测 200ms 内完成切换；反过来先 Hide 会留 400ms+ 空窗）；② 音效**等 `CARD_DRAW_MS=160ms`** 再起音（实测卡片入场 100–200ms）——让卡片出现与音效起音落在同一瞬；③ 收旧卡只在 `HIDE_WINDOW_MS=8000` 时间窗内做（见"已知限制"里的取舍） |
| 不闪黑框 | `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File <worker.ps1>` |
| 实时性 | **冷启动 ~1.7–2.0 秒**（首次，要拉起 worker）；**热路径 ~180–240 ms**（含 160ms 卡片入场等待；不设 `cardDrawMs` 的旧行为是 9–20ms） |
| 失败模式 | powershell 缺失 / WinRT 抛错 / 4 秒超时 → **不抛异常**，返回 `{delivered:[], degraded:['no-powershell'\|'toast-failed'\|'timeout']}` 并 `[donevoice]` 出声 |

实测证据（命令、原始输出、延迟、通知历史回读）见本文件上文各表。

---

## 4. 全局性：什么情况下会发生什么

**固定行为 = 走开才弹**（不是可选项）：判据是"前台窗口是不是 DSH 自己"，由宿主问 Windows（`presence()`）。
在 DSH 页面上时，页面内要不要卡片 / 要不要声音，各由一个开关控制（`pageCard`，默认都关）。

| 你的状态 | 前台探测 | 结果 |
|---|---|---|
| **正看着 DSH 窗口**（前台窗口 = DeepSeek Harness） | `present: true` | 🔇 不弹系统通知、不响音效；只有 `pageCard` 开着才出页内卡片。开关 `pageSound` 打开 ⇒ **只响音效**（`soundPlayed:true`，依然没有系统通知）；`pageCard` 打开 ⇒ 页面右下角出卡片 |
| 切到别的窗口 / 最小化（前台 = 别的进程） | `present: false` | ✅ 弹 Windows 系统通知 + 音效 |
| 页面被冻结 / 根本没开页面 | 与页面无关，照常探测 | ✅ 同上（宿主不依赖页面） |
| 探测失败（worker 起不来 / 拿不到自身进程名） | `present: false` + `error` | ✅ **按"你不在"处理**：宁可多弹一条，也不让你漏提醒，并在控制台点名原因 |
| 宿主进程整个退出了（DSH 关掉） | — | ❌ 不弹（任何本机方案的天花板） |
| 页面活着但宿主原生通道坏了（`auto` 档） | — | **自动降级**：页内卡片 + 本地音 + `console.warn`（否则你什么都收不到） |

> 测试路由已按用户要求**整体删除**（连代码一起删）：现在只有真实提醒这一条路。
> 想验证"外面真的会响"：先切到别的窗口（或开个记事本抢走焦点），再按 README「开发与验收」的三步打四条真实提醒。

---

## 5. 为什么"宿主订阅审批 waterfall"这次是安全的（与页面半区的结论不冲突）

老版本（以及 `dsh-reminder`）的致命坑是：**在浏览器里**订阅 `approval/request` waterfall，因为插件排在链条最内层、官方监听器不调用 `next()`，那个监听器永远收不到——甚至写错会**卡死审批**。

宿主侧不一样，而且这次是**刻意**订阅的，安全性靠结构而不是自觉：

1. 宿主侧 `ApprovalService.decide()` 是 `ctx.waterfall(scopeTarget(agent, agent), 'approval/request', req, () => 'unavailable')`，链条上我们的监听器**在**其中；
2. 我们的监听器**只做观测，且无条件 `return next()`**；观测代码整体在 `try` 里，`next()` 在 `catch` 之外无条件透传；
3. 观测逻辑即使抛异常，也**绝不改变返回值**（`dsh-user-approval/lib/index.js:176` 的 `.then(..., () => 'unavailable')` 说明：异常/截断会让审批 fail-closed，等于替用户拒绝——这是最严重的事故形态）。

这条性质当初是用**敌意 Proxy 请求 + 抛异常的 onEvent + 抛异常的 log** 三重施压验过的：下游 answerer 仍被调用、返回值**同一身份**透传。
页面半区则**依然**不订阅任何 waterfall（结构上不注册任何 waterfall），两边结论互不矛盾。

---

## 6. 跨通道去重（为什么不会响两次）

同一件"完成"会有两条独立通道到达宿主：宿主传感器、页面中继。两条通道的**去重键不一样**（turn 号 vs 周期号），所以宿主除了比精确键，还按 `kind|sessionId` 做 **2.5 秒时间窗**去重（`index.js` 的 `findDuplicate`）。

- 命中去重 → 响应 `{ ok:true, delivered:[], deduped:true }`；
- 页面把 `deduped:true` **也算成功**（外面已经响过了），因此不会再弹页内卡片、也不会播本地音。

真机证据：host-sensors 那一次闭环里 `sensors.completion=1` 且 `deduped=1`（两条来源只投递一次）。

---

## 7. 怎么自己证明（30 秒）

```powershell
# 一键真机验收：读探针 → 打四种通知 → 回读 Windows 通知历史 → 打印投递账本
# 打四条真实提醒（下面几条 curl 就是它的等价手动版）
```

期望：屏幕右下角依次弹出 4 张通知（完成 / 审批 / 提问 / 失败）+ 4 种音效，脚本末尾打印 `TOTAL=4` 和 `全部通过`。

**不看屏幕也能验的两种方式**：

```powershell
# 1) 探针：宿主活着吗？原生通道可用吗？传感器收了多少事件？最近 5 条投递去哪了？
curl http://127.0.0.1:<你的 DSH 端口>/plugins/dsh-donevoice/health.json

# 2) 独立打一发（不需要页面）
curl -X POST http://127.0.0.1:<你的 DSH 端口>/plugins/dsh-donevoice/notify ^
     -H "content-type: application/json" -d "{\"kind\":\"completion\"}"
# → {"ok":true,"kind":"completion","delivered":["toast","sound"],"degraded":[],"deduped":false,"latencyMs":14}
```


---

## 8. 部署：不用重启桌面进程

DSH 宿主插件的模块热重载默认**是关的**（`dsh-hmr` 的 `root` 默认 `[]` = 只监听配置文件）。本次在 profile 的 `cordis.patch.yml` 里加了一条：

```yaml
- id: hmr
  config:
    root:
      - "D:/AppMaker/DSH-Creation/DoneVoice/dsh-donevoice"
```

于是**改宿主源码 → 插件自动热重载**（实测：改完 8 秒内 `GET /health.json` 就能看到新字段）。
删掉这三行即回退成"必须重启桌面进程"的原行为；profile 原文件已留一份备份 `cordis.patch.yml.donevoice-backup-<时间戳>`。

> 注意：热重载会重建模块状态（投递账本、传感器计数会清零、常驻 worker 会被 dispose 后重建）。这是开发期特性，不影响正常运行。

**浏览器半区**（`client.js`）走的是另一套热重载；如果设置页没看到新按钮/新文案，按一次 F5 刷新 DSH 窗口即可。

---

## 9. 已知限制与独立验证员抓到的坑（诚实清单）

| 限制 | 性质 |
|---|---|
| DSH 桌面进程整个退出后不会再有任何提醒 | 本机方案的天花板：没有进程就没有通知 |
| 首次投递要 ~2 秒（拉起 PowerShell worker） | 之后 9–20ms；`win-native.js` 也有"不需要 worker"的一次性路径 |
| **屏幕横幅是否出现，无法用程序可靠观测** | 独立验证员用"通知区像素对比 + 顶层窗口计数"测三种 AUMID，都显示**无横幅**（结论是系统级横幅抑制，非插件缺陷）；但用户本人在同一台机器上**两次当场确认看到了通知**。⇒ 横幅可见性只有人眼能定论；程序侧的断言只到"进了通知中心" |
| **同一 tag 的通知会在通知中心里互相顶掉** | 实测 9 条完成通知只留 1 条历史。这是**有意**的：每种提醒一个 tag，避免通知中心被刷屏。代价是"历史条数"不能当作"投递条数"来数（回读历史前要先清空、并且打**不同 tag** 才数得准） |
| **同步机制会收掉旧横幅，而收掉会连带删掉那张在通知中心的历史** | 真机实验：`Hide` **连历史一起删**；"自然超时"不删历史；对**已超时**的通知调 `Hide` 照样删。⇒ 只在 `HIDE_WINDOW_MS=8000` 窗口内（旧卡大概率还在屏幕上、不收就会挡住新卡）才收；隔得久的绝不动它。可观测证据：连发 4 条后历史 `TOTAL=1`（只有最后一条），隔 9 秒的两条 `TOTAL=2`（历史保住）。**边界**：若把 Windows"通知显示时长"设成 15/30 秒，隔 10 秒的新提醒会排队——此时选择**历史优先**（不误删） |
| **专注助手 / 勿扰 / 系统关通知会静默吞掉** | `Show()` 不报错、回执仍是 `delivered:["toast"]`；模块检测不到。所以"通知历史回读"才是硬证据 |
| **`sound-failed` 可能盖掉 `no-powershell`** | 低危报告优先级瑕疵（独立验证员 D4）：两者同时发生时 `degraded` 只报前者 |
| 通知里不能带操作按钮 | Chrome/WinRT 从页面上下文发起的通知没有 `actions`；页内卡片有"忽略"按钮 |
| 系统通知的应用名/图标靠 AUMID 注册，且**尺寸由 Windows 决定** | 名与图标取自那个开始菜单快捷方式（我们已改成「DeepSeek Harness」+ DSH 的 exe 图标）；**头部那枚小图标的大小是系统固定的，插件改不了**——想要"更大的图标"只能走 `appLogoOverride`（我们已经用了：左侧那枚大圆图标）。注册失败会回退成 PowerShell 的 AUMID（通知照样弹，应用名不同，且会出声） |

---

## 10. 通知外观：一次"看得见"的验收（截屏对照实验）

关于外观的结论**不靠推理，靠截屏**。`System.Drawing` 抓屏 + `read_image` 看图，能把"用户到底看到什么"
变成可复核的像素证据。三个由此定案的坑：

| 现象 | 根因 | 定案方式 |
|---|---|---|
| 通知上写 "DoneVoice" 而不是 "DeepSeek Harness" | 应用名 = AUMID 对应快捷方式的**文件名** | `Get-StartApps` 里该 AUMID 的 Name 字段 |
| 头部那枚图标是系统默认图标 | 快捷方式的 `IconLocation` 指向 shell32 | 同上 + 快捷方式属性回读 |
| **左侧那枚图标根本不显示** | 图标落在 `C:\Users\<中文名>\.dsh\...`，`file:///` URI 里的中文被百分号编码，**Windows 的 toast 图片加载器读不出来** | A/B 对照：同一张 PNG，`C:\Users\Public\...` 正常显示、中文路径完全不显示 |
| **多提醒时"音效先响完、卡片几秒后才排队出来"** | 同应用横幅**排队**：不收旧的新卡上不来；而音效在 Show 后立刻响 | 时间线连拍：修好后 200ms 那帧已是新卡；修好前 ~5 秒才轮到 |

（当时那张截屏已随瘦身清理；要复现同样四条通知，把上面那四条 curl 各跑一遍即可。）

---
