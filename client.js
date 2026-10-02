/**
 * dsh-donevoice 浏览器半区（Client half）——手写单文件包，**无构建步骤**。
 *
 * ## 为什么是手写包
 * 上一版（dsh-reminder）的致命伤是"源码即源码，产物即产物"：仓库里没有 lib/，构建脚本
 * 依赖一个不存在的 esbuild 二进制，装上去什么都没有。本插件反过来做：**源码就是产物**。
 * 下面这个文件被浏览器端模块加载器直接执行，不需要 tsc、esbuild、node_modules。
 *
 * ## 运行时契约（全部来自对 DSH 0.2.0-rc.2 实现源码的核对，非猜测）
 *  - 入口必须包在 `window.__ModuleLoader__.load({ id, factory })` 里；`id` = package.json
 *    的 name（`dsh-donevoice`）。factory 返回带 `apply` / `inject` 的 exports。
 *  - `require()` 只解析**平台种子词**（react / react/jsx-runtime / react-dom / …）与已装载
 *    插件的 factory，其它一律抛 `missed the module table`。因此本文件**只 require('react')**，
 *    连 react/jsx-runtime 都不用（直接用 React.createElement），把模块表风险压到零。
 *  - 事件检测**不碰任何官方 UI 包的内部 store**，只用两类**公开且顺序无关**的数据源：
 *
 *      A. 官方转发到浏览器的宿主事件白名单
 *         （`@deepseek-ai/dsh-api-remotes/lib/types/remote-events.js` 的 API_REMOTE_FORWARDED_EVENTS）：
 *           api-session/status(sessionId, running)  → 完成（running 由 true 变 false 的边沿）
 *           api-session/error(sessionId, message)   → 失败
 *           api-session/added(summary)              → 基线与会话信息
 *         这三个都是 **emit 型**（走 parallel 广播），无论注册顺序如何都会被调用。
 *
 *      B. 官方聚合好的 `ctx.uiSession.sessionStatus`
 *         → `Map<sessionId, { running, pendingInteraction, completionUnread }>`，
 *           用于「等待审批 / 等待回答」。`pendingInteraction` 是 ui-approval / ui-user-questions
 *           登记进来的领域对象，自带唯一 `key` 与 `toolName` / `questions` 等详情。
 *
 *    ⚠️ 有意**不订阅** `approval/request` 与 `user-questions/request`——它们是 waterfall，
 *    官方审批 UI 在能显示时**不调用 next()**，而第三方条目注册在它下游 ⇒ 监听器永远不会被调用。
 *    详见 §"为什么这里没有 approval/request" 那一段注释。附带好处：本插件**完全不碰 waterfall**，
 *    结构上不可能让审批卡住。
 *  - 会话标题走 `ctx.sessions.list`（`{ids, byId:{id,displayTitle,running,...}, phase}`）。
 *    该属性未写进公开服务目录，但被 ui-session / ui-workspace 等官方包直接使用
 *    （dsh-client-ui-session/lib/client.js:471），是事实上的共享面；取不到就降级为短 id。
 *  - **弹到 DSH 外面去**：页内卡片只是 DSH 窗口里的一小块 DOM，用户切到别的窗口干活时它等于没有。
 *    所以真正的主信号是 `POST /plugins/dsh-donevoice/notify` —— **宿主进程**收到中继后弹
 *    Windows 原生通知（通知中心卡片 + 音效），与页面在不在、在看哪个窗口都无关。
 *    回执 `delivered` 非空 = 外面已经响过了 ⇒ 页内卡片与本地 Web Audio **都不再发**（避免双响）；
 *    非 2xx / 网络错误 / 3 秒超时 / `delivered` 为空 = 宿主通道不可用 ⇒ 降级成页内卡片 + 本地音，
 *    并 `console.warn('[donevoice] …')` 出声说明原因（降级必须可见）。
 *    因此投递策略是**固定行为**（不是可选项）：**你人在 DSH 页面上就不弹系统通知，走开了才弹**。
 *    页面内是否额外补卡片，看唯一可选开关 `pageCard`（默认关）。
 *    （这条判断由宿主做——它直接问 Windows 前台窗口是谁，页面这侧判不准，见 relayPayload 上方的说明。）
 *  - 点通知回会话用官方 `ctx.uiWorkspace.openSession(sessionId)`。
 *  - 持久化设置走宿主自带的**同源 JSON 路由** `/plugins/dsh-donevoice/config.json`
 *    （读写都用 `window.fetch`）。**不**用官方 `Config` + `configForms`：那要求宿主半区
 *    `import '@deepseek-ai/schemastery'`，而 profile 里没有 `@deepseek-ai` 作用域，
 *    静态 import 会链接期失败——这条已在真机上用 `ERR_MODULE_NOT_FOUND` 验证过。
 *
 * ## 三条硬规矩
 *  1. **绝不妨碍宿主**：本插件不注册任何 waterfall 监听器，也不改写任何宿主状态。
 *     审批/提问只**读** `uiSession.sessionStatus` 这个只读快照——读一个 Map 不可能让审批卡住。
 *  2. **降级必须出声**：每一条"安静地不生效"的分支都 console.error 带 [donevoice] 前缀，
 *     连"能力始终没出现"这种异步缺席也用看门狗（`degradationReport` + `WATCHDOG_MS`）兜住，
 *     否则无法区分"没装"和"装了但降级了"。
 *  3. **单一真相**：配置的字段/默认值/归一化规则与宿主 host-config.js 是同一套，纯逻辑集中在
 *     下面的"纯逻辑区"，客户端持内联副本、宿主持独立模块，两边由同一份契约约束。
 */
window.__ModuleLoader__.load({
  id: 'dsh-donevoice',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    /** 统一用 createElement，避免再依赖 react/jsx-runtime。 */
    const h = React.createElement

    // ════════════════════════════════════════════════════════════════════════
    // 常量
    // ════════════════════════════════════════════════════════════════════════

    /** 语言字典命名空间。 */
    const NS = 'donevoice'
    /** 宿主 Loader 条目 id：同时是设置页槽位 id 与配置路由的归属名。必须与 cordis.patch.yml 一致。 */
    const HOST_ENTRY_ID = 'donevoice'
    /** 版本（与 package.json / 宿主半区对齐，由 test/validate.mjs 钉住）。 */
    const VERSION = '1.1.3'
    /**
     * 客户端构建标记：**每改一次 client.js 就加一**，并显示在设置页「诊断」第一行。
     *
     * 立它的原因：真机排查时反复搞不清"我这次改的到底有没有生效"（用户刷新的时机与改代码的
     * 时机交错，只能靠猜）。有了这个标记，截图第一行就能确定页面在跑哪一版。
     *   r10 = 主信号改为**中继给宿主进程**（Windows 原生通知 + 音效），页内卡片降级为可选、
     *         失败时才自动降级；页内卡片由 pageCard 开关控制（页内音效没有开关，页面上保持安静）
     *   r9 = 桌面通知按最小间隔排队（防平台频率限制丢弃）
     *   r8 = 通知 tag 唯一化（修掉主会话每轮撞同 tag、被 Windows 静默替换而不弹横幅）
     *   r7 = 桌面通知提到最前 + 卡片/通知/声音三步互相隔离 + sessionStatus 的 running 边沿
     */
    const REVISION = 'r11'
    /** 日志前缀。 */
    const TAG = '[donevoice]'
    /** 样式元素 id（HMR 幂等）。 */
    const STYLE_ID = 'dsh-donevoice-style'
    /** 卡片层容器 id。 */
    const LAYER_ID = 'dsh-donevoice-layer'
    /** 宿主原生通知的中继路由（冻结契约：宿主进程收到后弹 Windows 通知 + 音效）。 */
    const NOTIFY_ROUTE = '/plugins/dsh-donevoice/notify'
    /**
     * 中继超时（毫秒）：到点即视为"宿主原生通道不可用"并走降级。
     * 为什么必须有它：宿主路由挂在同一个 webServer 上，正常是同源本地回环、毫秒级；
     * 一旦宿主半区没起来，`window.fetch` 可能既不 resolve 也不 reject —— 没有超时，
     * 用户就永远等不到任何信号（既不弹卡片也不响），这比"降级"更糟。
     */
    const RELAY_TIMEOUT_MS = 3000
    /** 调试面 `window.__dshDoneVoice.relay()` 保留的最近中继结果条数。 */
    const RELAY_LOG_LIMIT = 20

    // ════════════════════════════════════════════════════════════════════════
    // 纯逻辑区 —— 与宿主 host-config.js 同源的配置契约
    // ⚠️ 这里是**内联副本**：改字段/枚举/默认值/边界时必须同时改 host-config.js 同名常量，
    //    漏改不会报错，只会静默走 fallback（"加了新音效却听起来全一样"就是这么来的）。
    // ════════════════════════════════════════════════════════════════════════

    const BOOLEAN_FIELDS = ['enabled', 'pageCard']
    const ENUM_FIELDS = {
      // ⚠️ `soundPreset` 的合法值**不在这里写**：它由 SOUND_IDS 派生（见该清单下方的赋值），
      // 免得"加了音效却忘了改枚举"这种静默回落再发生一次。
      // 投递策略**不是可选项，而是固定行为**（见 host-config.js 的说明）：
      // 不在 DSH 页面 ⇒ 系统通知 + 音效（强制）；在 DSH 页面 ⇒ 只有 `pageCard` 一个可选开关。
    }
    const ENUM_FALLBACK = { soundPreset: 'bell' }
    const NUMBER_FIELDS = {
      durationSec: { min: 3, max: 30, fallback: 6 },
      volume: { min: 0, max: 100, fallback: 70 },
      maxStack: { min: 1, max: 10, fallback: 4 },
    }
    const DEFAULT_CONFIG = {
      // ⚠️ 必须与 host-config.js 的 DEFAULT_CONFIG 逐字一致（漏改只会静默走 fallback）。
      //    总开关关着；`pageCard` 是唯一的可选开关；后三个字段不在设置页显示（取值仍会被夹紧）。
      enabled: false,
      pageCard: false,
      durationSec: 6,
      volume: 70,
      maxStack: 4,
      soundPreset: 'bell',
    }

    /**
     * 把任意数值夹到闭区间并取整。
     * @param value 候选值。
     * @param min 下界（含）。
     * @param max 上界（含）。
     * @param fallback 非法输入时的回落值。
     * @returns 合法整数。
     */
    function clampInt(value, min, max, fallback) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
      return Math.min(max, Math.max(min, Math.round(value)))
    }

    /**
     * 把任意输入归一化成完整配置；永不抛异常，未知字段丢弃，类型不符回落默认。
     * @param raw 任意候选配置。
     * @returns 完整合法的配置对象。
     */
    /** 提示音 id 的合法语法：与 host-config.js 的 SOUND_ID_PATTERN 必须逐字一致。 */
    const SOUND_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/

    /**
     * 提示音 id 是否合法（`none` 也算）。
     *
     * ⚠️ 为什么不能拿 `ENUM_FIELDS.soundPreset`（静态清单）当白名单：
     * 用户可以**自己导入音效**，那些 id 在静态清单里根本不存在。
     * 用清单校验的后果是"导入的音效一旦被选中，客户端判它非法 → 回落成 bell →
     * 下一次 PUT 把 bell 写进磁盘"——用户的设置被静默抹掉（就是"我明明选了，重开又变回去"）。
     * 所以这里与宿主同口径：**只校验语法**，"到底存不存在"由宿主扫盘决定。
     * @param value 候选 id。
     * @returns 合法返回 true。
     */
    function isSoundId(value) {
      if (typeof value !== 'string') return false
      const id = value.trim().toLowerCase()
      return id === 'none' || SOUND_ID_PATTERN.test(id)
    }

    function normalizeConfig(raw) {
      const source = raw !== null && typeof raw === 'object' ? raw : {}
      const out = {}
      for (const field of BOOLEAN_FIELDS) {
        out[field] = typeof source[field] === 'boolean' ? source[field] : DEFAULT_CONFIG[field]
      }
      for (const field of Object.keys(ENUM_FIELDS)) {
        const allowed = ENUM_FIELDS[field]
        // 大小写不敏感：手改配置文件时写成 "BELL" 也该认账。
        const candidate = typeof source[field] === 'string' ? source[field].trim().toLowerCase() : ''
        // `soundPreset` 是**开放式**字段（见 isSoundId 的说明），其余枚举仍按清单校验。
        out[field] = field === 'soundPreset'
          ? (isSoundId(candidate) ? candidate : ENUM_FALLBACK[field])
          : (allowed.indexOf(candidate) >= 0 ? candidate : ENUM_FALLBACK[field])
      }
      for (const field of Object.keys(NUMBER_FIELDS)) {
        const spec = NUMBER_FIELDS[field]
        out[field] = clampInt(source[field], spec.min, spec.max, spec.fallback)
      }
      return out
    }

    // ════════════════════════════════════════════════════════════════════════
    // 纯逻辑区 —— 文案与格式化
    // ════════════════════════════════════════════════════════════════════════

    /**
     * 把毫秒格式化成 "Xm Ys" / "Ys" / "<1s"。
     * @param ms 时长（毫秒）。
     * @returns 人类可读时长。
     */
    function formatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '<1s'
      if (ms < 1000) return '<1s'
      const total = Math.round(ms / 1000)
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      if (minutes === 0) return seconds + 's'
      return minutes + 'm ' + seconds + 's'
    }

    /**
     * 会话 id 的短表示（取不到标题时的兜底）。
     * @param id 会话 id。
     * @returns 最多 8 个字符的短 id。
     */
    function shortId(id) {
      if (typeof id !== 'string' || id === '') return ''
      return id.length <= 8 ? id : id.slice(0, 8)
    }

    /**
     * 稳定的字符串散列（djb2 → base36），用于给没有显式 id 的请求做去重键。
     * @param text 输入文本。
     * @returns 短散列串。
     */
    function hashText(text) {
      const input = typeof text === 'string' ? text : ''
      let hash = 5381
      for (let i = 0; i < input.length; i += 1) {
        hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
      }
      return (hash >>> 0).toString(36)
    }

    /** 简体中文文案（键集为唯一真相）。 */
    const zh = {
      nav: '提醒',
      'settings.title': '提醒',
      'settings.enabled': '总开关',
      'settings.pageCard': '页内卡片',
      'settings.sound': '提示音',
      'settings.sound.bell': '铃声',
      'settings.sound.ping': '叮·高',
      'settings.sound.ping2': '叮·低',
      'settings.sound.notify1': '通知 1',
      'settings.sound.notify2': '通知 2',
      'settings.sound.notify3': '通知 3',
      'settings.sound.type20': '音效 20',
      'settings.sound.msgping': '消息提示',
      'settings.sound.new017': '新通知 017',
      'settings.sound.new018': '新通知 018',
      'settings.sound.new02': '新通知 02',
      'settings.sound.new027': '新通知 027',
      'settings.sound.new03': '新通知 03',
      'settings.sound.positive': '轻快提示',
      'settings.sound.system02': '系统提示',
      'settings.sound.none': '静音',
      'settings.soundPreview': '试听',
      'settings.soundLibrary': '音效库',
      'settings.soundAddPick': '选择文件…',
      'settings.soundBuiltin': '自带',
      'settings.soundUser': '导入',
      'settings.soundDelete': '删除',
      'settings.volume': '音量',
      'settings.unavailable': '宿主配置路由不可用，本次修改只对当前页面有效。',
      'card.completion.title': '任务完成',
      'card.approval.title': '等待你的许可',
      'card.question.title': '需要你的回答',
      'card.failure.title': '执行失败',
      'card.openHint': '点击回到会话',
      'card.questions': '个问题',
      'card.fallbackSession': '会话',
      'notify.failure.body': '执行出错，点击查看。',
    }

    /** English copy, checked complete against the zh key set. */
    const en = {
      nav: 'Reminders',
      'settings.title': 'Reminders',
      'settings.enabled': 'Master switch',
      'settings.pageCard': 'In-page card',
      'settings.sound': 'Chime',
      'settings.sound.bell': 'Bell',
      'settings.sound.ping': 'Ping (high)',
      'settings.sound.ping2': 'Ping (low)',
      'settings.sound.notify1': 'Notify 1',
      'settings.sound.notify2': 'Notify 2',
      'settings.sound.notify3': 'Notify 3',
      'settings.sound.type20': 'Type 20',
      'settings.sound.msgping': 'Message ping',
      'settings.sound.new017': 'New 017',
      'settings.sound.new018': 'New 018',
      'settings.sound.new02': 'New 02',
      'settings.sound.new027': 'New 027',
      'settings.sound.new03': 'New 03',
      'settings.sound.positive': 'Positive',
      'settings.sound.system02': 'System 02',
      'settings.sound.none': 'Silent',
      'settings.soundPreview': 'Preview',
      'settings.soundLibrary': 'Sound library',
      'settings.soundAddPick': 'Choose files…',
      'settings.soundBuiltin': 'Built-in',
      'settings.soundUser': 'Imported',
      'settings.soundDelete': 'Delete',
      'settings.volume': 'Volume',
      'settings.unavailable': 'The host settings route is unavailable; these edits only affect this page.',
      'card.completion.title': 'Task complete',
      'card.approval.title': 'Waiting for your approval',
      'card.question.title': 'Your answer is needed',
      'card.failure.title': 'Task failed',
      'card.openHint': 'Click to open the session',
      'card.questions': 'questions',
      'card.fallbackSession': 'Session',
      'notify.failure.body': 'Something went wrong; click to inspect.',
    }

    /** 按当前语言取文案；未知语言回落中文。 */
    function dictionaryFor(localeId) {
      return typeof localeId === 'string' && localeId.toLowerCase().indexOf('en') === 0 ? en : zh
    }

    /**
     * 组装一条卡片/通知的标题与正文。
     * @param event 引擎产出的事件。
     * @param localeId 当前语言 id。
     * @returns { title, body, accent, icon }。
     */
    function describeEvent(event, localeId) {
      const dict = dictionaryFor(localeId)
      const kind = event !== null && typeof event === 'object' ? event.kind : 'completion'
      const title = typeof event?.displayTitle === 'string' && event.displayTitle !== ''
        ? event.displayTitle
        : (shortId(event?.sessionId) || dict['card.fallbackSession'])
      if (kind === 'approval') {
        const tool = typeof event.toolName === 'string' && event.toolName !== '' ? event.toolName : title
        const reason = pickReason(event, localeId)
        return {
          title: dict['card.approval.title'],
          body: reason === '' ? tool : tool + ' · ' + reason,
          kind,
          icon: ICON_SVG.approval,
        }
      }
      if (kind === 'question') {
        const text = typeof event.question === 'string' && event.question !== '' ? event.question : ''
        const count = typeof event.count === 'number' && event.count > 0 ? event.count : 0
        const suffix = count > 1 ? ' · ' + count + ' ' + dict['card.questions'] : ''
        return {
          title: dict['card.question.title'],
          body: text === '' ? title + suffix : text + suffix,
          kind,
          icon: ICON_SVG.question,
        }
      }
      if (kind === 'failure') {
        const message = typeof event.message === 'string' && event.message !== '' ? event.message : dict['notify.failure.body']
        return {
          title: dict['card.failure.title'],
          body: title + ' · ' + message,
          kind,
          icon: ICON_SVG.failure,
        }
      }
      const duration = typeof event.durationMs === 'number' ? formatDuration(event.durationMs) : ''
      return {
        title: dict['card.completion.title'],
        body: duration === '' ? title : title + ' · ' + duration,
        kind: 'completion',
        icon: ICON_SVG.completion,
      }
    }

    /**
     * 从 approval 请求里挑一条可读的理由（displayReason 是多语言对象）。
     * @param event 引擎事件（原样带出 displayReason）。
     * @param localeId 当前语言 id。
     * @returns 理由字符串，取不到时空串。
     */
    function pickReason(event, localeId) {
      const source = event?.displayReason
      if (source !== null && typeof source === 'object') {
        const key = typeof localeId === 'string' && localeId !== '' ? localeId : 'zh'
        const exact = source[key]
        if (typeof exact === 'string' && exact !== '') return exact
        const short = key.slice(0, 2)
        const loose = source[short]
        if (typeof loose === 'string' && loose !== '') return loose
        if (typeof source.en === 'string' && source.en !== '') return source.en
      }
      return typeof event?.reason === 'string' ? event.reason : ''
    }

    // ════════════════════════════════════════════════════════════════════════
    // 纯逻辑区 —— 提醒引擎（边沿检测 + 去重 + 基线吸收）
    // ════════════════════════════════════════════════════════════════════════

    /**
     * 造一个提醒引擎。引擎只做"什么时候该提醒"的判断，**不管怎么提醒**（投递策略、开关、
     * 渲染都在外面），因此可以纯函数式地单测。
     *
     * 关键设计：
     *  - **基线吸收**：第一次见到某会话时只记录状态、绝不提醒。否则页面一打开就会被历史会话刷屏。
     *  - **周期号去重**：每次观测到 running 由假变真就把该会话的周期号 +1，提醒时记下"这一周期
     *    已提醒"。这样"远端事件通道"与"会话列表兜底通道"同时到达也只会提醒一次，而且重连
     *    （rebaseline）之后仍能对下一次真实完成正常提醒。
     *  - **耗时自测**：DSH 浏览器侧不提供 turn 计时，所以由引擎自己记录"看到开始跑"的时刻。
     *    诚实标注为实测值，不假装是平台的权威耗时。
     *
     * @param options 可选 `{ now }` 注入时钟（测试用）。
     * @returns 引擎实例。
     */
    function createReminderEngine(options) {
      const opts = options !== null && typeof options === 'object' ? options : {}
      const clock = typeof opts.now === 'function' ? opts.now : () => Date.now()

      const baselined = new Set()
      const running = new Map()
      const startedAt = new Map()
      const cycle = new Map()
      const notifiedCycle = new Map()
      const seenApprovals = new Set()
      const seenQuestions = new Set()
      const lastError = new Map()
      /**
       * 会话最近一次失败的时间戳。
       *
       * 为什么需要它（用户报的"任务失败后跳出两个提醒"）：一次失败会**派生两个事件**——
       * `api-session/error` 报失败，紧接着 running 转 false 又报"完成"。两条都中继给宿主，
       * 用户就收到两条提醒（"执行失败" + "任务完成"），而宿主传感器那边遇到 error 是
       * **直接 return 的**（见 host-sensors.js 的 turn/end 分支）。这里补齐同一口径：
       * 刚失败过的会话，在下面的时间窗内不再报"完成"。
       */
      const failedAt = new Map()
      const meta = new Map()

      /** 记下会话的展示信息（标题 / 来源）。 */
      function remember(id, patch) {
        if (typeof id !== 'string' || id === '') return
        const previous = meta.get(id) ?? {}
        const next = {}
        for (const key of Object.keys(previous)) next[key] = previous[key]
        for (const key of Object.keys(patch)) {
          if (patch[key] !== undefined) next[key] = patch[key]
        }
        meta.set(id, next)
      }

      /** 建立基线：只记录，不提醒。 */
      function baselineOf(id, isRunning) {
        baselined.add(id)
        running.set(id, isRunning)
        if (isRunning) {
          cycle.set(id, (cycle.get(id) ?? 0) + 1)
          startedAt.set(id, clock())
        }
      }

      function titleOf(id) {
        const info = meta.get(id)
        const title = info !== undefined && typeof info.displayTitle === 'string' ? info.displayTitle : ''
        return title !== '' ? title : shortId(id)
      }

      function isSubagent(id) {
        const info = meta.get(id)
        return info !== undefined && info.origin === 'subagent'
      }

      /**
       * 用一批会话行建立/刷新基线。
       * @param rows `[{ id, running, displayTitle, origin }]`。
       */
      function seed(rows) {
        if (!Array.isArray(rows)) return
        for (const row of rows) {
          if (row === null || typeof row !== 'object') continue
          const id = typeof row.id === 'string' ? row.id : ''
          if (id === '') continue
          remember(id, {
            displayTitle: typeof row.displayTitle === 'string' ? row.displayTitle : undefined,
            origin: typeof row.origin === 'string' ? row.origin : undefined,
          })
          if (!baselined.has(id)) baselineOf(id, row.running === true)
        }
      }

      /** 只更新展示信息，不碰状态机。 */
      function observeRow(row) {
        if (row === null || typeof row !== 'object') return
        const id = typeof row.id === 'string' ? row.id : ''
        if (id === '') return
        remember(id, {
          displayTitle: typeof row.displayTitle === 'string' ? row.displayTitle : undefined,
          origin: typeof row.origin === 'string' ? row.origin : undefined,
        })
      }

      /**
       * 运行状态边沿。完成提醒的唯一出口。
       * @param sessionId 会话 id。
       * @param isRunning 观测到的运行状态。
       * @returns 事件或 null。
       */
      function status(sessionId, isRunning) {
        if (typeof sessionId !== 'string' || sessionId === '') return null
        const next = isRunning === true
        if (!baselined.has(sessionId)) {
          baselineOf(sessionId, next)
          return null
        }
        const previous = running.get(sessionId)
        if (previous === next) return null
        running.set(sessionId, next)
        if (next) {
          cycle.set(sessionId, (cycle.get(sessionId) ?? 0) + 1)
          startedAt.set(sessionId, clock())
          return null
        }
        const current = cycle.get(sessionId) ?? 0
        if (notifiedCycle.get(sessionId) === current) return null
        notifiedCycle.set(sessionId, current)
        const began = startedAt.get(sessionId)
        startedAt.delete(sessionId)
        // 刚刚失败过的会话不再报"完成"：一次失败只该有一条提醒（与宿主传感器同口径）。
        // 时间窗取 10 秒 —— 失败到"停止运行"通常在同一秒内，10 秒足够宽又不会吞掉真的下一轮完成。
        const failedRecently = failedAt.get(sessionId)
        if (typeof failedRecently === 'number' && clock() - failedRecently < FAILED_QUIET_MS) return null
        // `dedupKey` = 这一轮的身份（会话 + 周期号）。中继给宿主时原样带上，宿主才认得出
        // "同一件事"（远端事件通道与列表兜底通道可能各来一次），不会各弹一次。
        const identity = 'completion|' + sessionId + '|' + String(current)
        return {
          kind: 'completion',
          sessionId,
          key: identity,
          dedupKey: identity,
          durationMs: typeof began === 'number' ? Math.max(0, clock() - began) : undefined,
          displayTitle: titleOf(sessionId),
          subagent: isSubagent(sessionId),
        }
      }

      /**
       * `api-session/added`：新会话只建基线；已存在的会话按同一套边沿逻辑处理。
       * @param summary SessionSummary（含 sessionId / running / origin）。
       * @returns 事件或 null。
       */
      function added(summary) {
        if (summary === null || typeof summary !== 'object') return null
        const id = typeof summary.sessionId === 'string' ? summary.sessionId : ''
        if (id === '') return null
        remember(id, { origin: typeof summary.origin === 'string' ? summary.origin : undefined })
        if (!baselined.has(id)) {
          baselineOf(id, summary.running === true)
          return null
        }
        return status(id, summary.running === true)
      }

      /**
       * `api-session/error`：失败提醒。同一条消息 5 秒内不重复。
       * @param sessionId 会话 id。
       * @param message 错误消息。
       * @returns 事件或 null。
       */
      function failure(sessionId, message) {
        if (typeof sessionId !== 'string' || sessionId === '') return null
        const text = typeof message === 'string' && message.trim() !== '' ? message.trim() : ''
        const previous = lastError.get(sessionId)
        // 失败时间戳**先记**：紧接着那次 running→false 的"完成"要靠它让路（见 status()）。
        failedAt.set(sessionId, clock())
        if (previous !== undefined && previous.message === text && clock() - previous.at < 5000) return null
        lastError.set(sessionId, { message: text, at: clock() })
        // 与上面那条 5 秒窗口**同口径**的身份：同一会话 + 同一条消息 + 同一个 5 秒桶。
        // 桶让"真的又错了一次"（超过 5 秒）拿到新的身份，而不是被宿主当成重复请求吞掉。
        const identity = 'failure|' + sessionId + '|' + hashText(text) + '|' + String(Math.floor(clock() / 5000))
        return {
          kind: 'failure',
          sessionId,
          message: text,
          key: identity,
          dedupKey: identity,
          displayTitle: titleOf(sessionId),
          subagent: isSubagent(sessionId),
        }
      }

      /**
       * `approval/request`：按 callId（缺失时按 工具名+理由散列）去重。
       * @param request ApprovalRequestEvent。
       * @param sessionId 解析出来的会话 id（可能为空）。
       * @returns 事件或 null。
       */
      function approval(request, sessionId) {
        const req = request !== null && typeof request === 'object' ? request : {}
        const toolName = typeof req.toolName === 'string' ? req.toolName : ''
        const callId = typeof req.callId === 'string' ? req.callId : ''
        const reason = typeof req.reason === 'string' ? req.reason : ''
        const id = typeof sessionId === 'string' ? sessionId : ''
        const key = id + '|' + (callId !== '' ? callId : toolName + '|' + hashText(reason))
        if (seenApprovals.has(key)) return null
        seenApprovals.add(key)
        return {
          kind: 'approval',
          sessionId: id,
          toolName,
          reason,
          displayReason: req.displayReason,
          key,
          dedupKey: key,
          displayTitle: titleOf(id),
          subagent: isSubagent(id),
        }
      }

      /**
       * `user-questions/request`：按 wait.callId 或问题内容散列去重。
       * @param request AskUserQuestionRequestEvent。
       * @param sessionId 解析出来的会话 id（可能为空）。
       * @returns 事件或 null。
       */
      function question(request, sessionId) {
        const req = request !== null && typeof request === 'object' ? request : {}
        const wait = req.wait !== null && typeof req.wait === 'object' ? req.wait : {}
        const callId = typeof wait.callId === 'string' ? wait.callId : ''
        const questions = Array.isArray(req.questions) ? req.questions : []
        const first = questions.length > 0 && questions[0] !== null && typeof questions[0] === 'object' ? questions[0] : {}
        const text = typeof first.question === 'string' && first.question !== ''
          ? first.question
          : (typeof first.header === 'string' ? first.header : '')
        const id = typeof sessionId === 'string' ? sessionId : ''
        const key = id + '|q|' + (callId !== '' ? callId : hashText(text) + '|' + String(questions.length))
        if (seenQuestions.has(key)) return null
        seenQuestions.add(key)
        return {
          kind: 'question',
          sessionId: id,
          question: text,
          count: questions.length,
          key,
          dedupKey: key,
          displayTitle: titleOf(id),
          subagent: isSubagent(id),
        }
      }

      /**
       * 重连后重新建立基线：保留去重历史，但把"当前是否在跑"重新观测一遍。
       * 这样断线期间错过的完成不会补弹，而断线后真正的下一次完成一定弹。
       * @param rows 可选的当前会话行。
       */
      function rebaseline(rows) {
        baselined.clear()
        running.clear()
        startedAt.clear()
        if (Array.isArray(rows)) seed(rows)
      }

      /** 调试快照。 */
      function stats() {
        return {
          sessions: baselined.size,
          running: [...running.entries()].filter(([, value]) => value === true).length,
          approvalsSeen: seenApprovals.size,
          questionsSeen: seenQuestions.size,
        }
      }

      return { seed, observeRow, status, added, failure, approval, question, rebaseline, stats }
    }

    // ════════════════════════════════════════════════════════════════════════
    // 纯逻辑区 —— 提示音预设（数据；播放器在下面）
    // ════════════════════════════════════════════════════════════════════════

    /**
     * 提示音 id 清单 —— **插件自带的 15 个真实音效**（`sounds/*.mp3`）+ `none` 静音。
     *
     * ⚠️ 必须与宿主的两份清单一致：`win-native.js` 的 `SOUND_FILES` 与
     *    `host-config.js` 的 `ENUM_FIELDS.soundPreset`。宿主启动时会自检并把结论写进探针。
     *
     * 历史：以前这里是一整套"音符表 + 泛音音色"的合成器（8 套运行时合成的音效），
     * 改成收录真实音效后整体删除 —— 页面只负责发 id，声音由宿主播它自带的文件。
     */
    const SOUND_IDS = Object.freeze([
      'bell', 'ping', 'ping2', 'notify1', 'notify2', 'notify3', 'type20', 'msgping',
      'new017', 'new018', 'new02', 'new027', 'new03', 'positive', 'system02', 'none',
    ])

    // 合法值从清单派生：加了音效忘了改枚举这种静默回落，从结构上不会再发生。
    ENUM_FIELDS.soundPreset = SOUND_IDS
    /** 能力看门狗的等待时长：到点仍缺席就出声，绝不静默失效。 */
    const WATCHDOG_MS = 5000


    /**
     * 纯逻辑：给定"哪些能力缺席"，产出该报出来的降级清单。
     *
     * 抽成纯函数是为了让"降级必须出声"这条硬规矩**可以被单测钉住**——否则它只是一句口号。
     * 五条会"安静地不生效"的路径：设置页槽位始终没被声明、uiWorkspace 没就绪、
     * 配置路由没通上、uiSession 没就绪、**宿主中继通道试过但从未成功**（这条最要命：
     * 它正是"弹到 DSH 外面去"这条主信号，坏了就只剩页内卡片，用户以为自己切走了还能被提醒）。
     * 它们都不是崩溃，但看起来都像"插件没装"。
     * @param state `{ section, openSession, form, pending, relay }`，true 表示该能力可用。
     * @returns `[{ what, why }]`，空数组表示一切正常。
     */
    function degradationReport(state) {
      const input = state !== null && typeof state === 'object' ? state : {}
      const lines = []
      if (input.section !== true) {
        lines.push({
          what: '设置页未注册',
          why: 'settings.section 槽位始终没被声明（ui-settings-general 未装载？）——「设置 → 提醒」不会出现',
        })
      }
      if (input.openSession !== true) {
        lines.push({
          what: '打开会话能力不可用',
          why: 'uiWorkspace 未就绪——点卡片只会聚焦窗口，不会跳到对应会话',
        })
      }
      if (input.form !== true) {
        lines.push({
          what: '设置通道未就绪',
          why: '宿主配置路由 /plugins/dsh-donevoice/config.json 始终没通上——设置改动只对当前页面有效',
        })
      }
      if (input.pending !== true) {
        lines.push({
          what: '等待审批/回答的提醒不可用',
          why: 'uiSession.sessionStatus 始终没就绪——审批与提问两类提醒不会响（完成与失败不受影响）',
        })
      }
      if (input.relay !== true) {
        lines.push({
          what: '宿主原生通知不可用',
          why: '中继路由 /plugins/dsh-donevoice/notify 已经试过但一次都没成功——提醒只能降级成 DSH 页内卡片 + 本地音效，'
            + '"弹到 DSH 外面去"这条主信号没有生效（宿主半区没起来？路由被挡？）',
        })
      }
      return lines
    }

    /** 提示音最短间隔（毫秒）：多会话同时收尾时避免连珠炮。 */
    const CHIME_MIN_GAP_MS = 2000

    /**
     * 失败后多久之内不再报"完成"（毫秒）。
     * 同一次失败会派生出 failure + completion 两个事件，用户会收到两条提醒；
     * 宿主传感器遇到 error 是直接 return 的，这里用时间窗补齐同一口径。
     */
    const FAILED_QUIET_MS = 10000

    /** 窗口重新聚焦时重读配置的最小间隔（毫秒）：避免频繁切窗口造成无谓请求。 */
    const RESYNC_MIN_GAP_MS = 2000

    /** 本地降级音：仅后台、非静音且距离上次播放至少两秒时播放。 */
    function shouldChime(input) {
      const value = input !== null && typeof input === 'object' ? input : {}
      if (value.preset === 'none') return false
      if (typeof value.volume !== 'number' || !(value.volume > 0)) return false
      if (typeof value.sinceLastMs === 'number' && value.sinceLastMs < CHIME_MIN_GAP_MS) return false
      if (value.background !== true) return false
      return true
    }

    // ════════════════════════════════════════════════════════════════════════
    // 纯逻辑区 —— 图标（SVG 字符串，静态，可直接 innerHTML）
    // ════════════════════════════════════════════════════════════════════════

    /** 深底圆角 + 彩色描边字形，与桌面通知的 data URL 图标同一套。 */
    function svgIcon(color, glyph) {
      return '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 64 64" aria-hidden="true">' +
        '<rect width="64" height="64" rx="16" fill="#101216"/>' +
        '<circle cx="32" cy="32" r="21" fill="none" stroke="' + color + '" stroke-width="4"/>' +
        glyph +
        '</svg>'
    }

    const ICON_SVG = Object.freeze({
      completion: svgIcon('#34c77b', '<path d="M22 33l7 7 13-15" fill="none" stroke="#34c77b" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>'),
      approval: svgIcon('#f0a020', '<path d="M32 19v14" stroke="#f0a020" stroke-width="4.5" stroke-linecap="round"/><circle cx="32" cy="43" r="2.8" fill="#f0a020"/>'),
      question: svgIcon('#4d7ff5', '<path d="M26 25a6 6 0 1 1 8 5.6c-1.6.7-2 1.6-2 3.4" fill="none" stroke="#4d7ff5" stroke-width="4" stroke-linecap="round"/><circle cx="32" cy="43" r="2.8" fill="#4d7ff5"/>'),
      failure: svgIcon('#e5484d', '<path d="M24 24l16 16M40 24L24 40" stroke="#e5484d" stroke-width="4.5" stroke-linecap="round"/>'),
      test: svgIcon('#4da3ff', '<path d="M32 16a9 9 0 0 0-9 9v7l-3.5 5.5h25L41 32v-7a9 9 0 0 0-9-9z" fill="none" stroke="#4da3ff" stroke-width="4" stroke-linejoin="round"/><path d="M28.5 42a3.5 3.5 0 0 0 7 0" fill="none" stroke="#4da3ff" stroke-width="4" stroke-linecap="round"/>'),
    })

    // ════════════════════════════════════════════════════════════════════════
    // 纯逻辑区 —— 宿主中继的请求体与去重身份
    // ════════════════════════════════════════════════════════════════════════

    /**
     * 取出这次提醒的**去重身份**，原样交给宿主。
     *
     * 为什么必须发：客户端这条线已经有一套去重（周期号 / 官方 key），宿主那条线是另一套。
     * 同一件事两条线各弹一次，用户就是两声、两张。把身份透传过去，宿主才能回 `deduped:true`
     * 而不是再弹一次。
     * @param event 引擎事件。
     * @returns 非空字符串身份（极端输入回落成 `kind|sessionId`，绝不返回空串）。
     */
    function dedupKeyFor(event) {
      if (event === null || typeof event !== 'object') return ''
      if (typeof event.dedupKey === 'string' && event.dedupKey !== '') return event.dedupKey
      if (typeof event.key === 'string' && event.key !== '') return event.key
      const kind = typeof event.kind === 'string' && event.kind !== '' ? event.kind : 'event'
      return kind + '|' + String(event.sessionId ?? '')
    }

    /**
     * 组装中继请求体。字段集是**冻结契约**（多一个少一个都算违约），所以单独成纯函数并单测。
     * @param event 引擎事件。
     * @param spec `describeEvent` 的产物（title / body / icon）。
     * @param config 当前配置（提供 preset / volume）。
     * @param localeId 当前生效语言 id（宿主侧要用它生成通知文案，所以只送 `zh` / `en` 两值）。
     * @returns 请求体对象。
     */
    function relayPayload(event, spec, config, localeId) {
      const source = event !== null && typeof event === 'object' ? event : {}
      const kind = typeof source.kind === 'string' && source.kind !== '' ? source.kind : 'completion'
      const current = config !== null && typeof config === 'object' ? config : DEFAULT_CONFIG
      return {
        kind,
        sessionId: typeof source.sessionId === 'string' ? source.sessionId : '',
        title: String(spec?.title ?? ''),
        body: String(spec?.body ?? ''),
        // 失败走**下行**音（听感"不对味"），其余走上行——与本地提示音同一套规则。
        sound: {
          preset: typeof current.soundPreset === 'string' ? current.soundPreset : 'bell',
          volume: typeof current.volume === 'number' ? current.volume : 70,
        },
        dedupKey: dedupKeyFor(source),
        // 宿主只把它记为"最近一次见到的语言"，不参与去重；给两值是为了让宿主不用猜 `zh-CN`。
        locale: typeof localeId === 'string' && localeId.toLowerCase().indexOf('en') === 0 ? 'en' : 'zh',
        source: 'client',
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // 提示音播放器
    // ════════════════════════════════════════════════════════════════════════

    /**
     * 造一个 Web Audio 播放器。Chrome 的自动播放策略要求音频上下文在用户手势里创建/恢复，
     * 所以 unlock() 由 apply 挂在首次 pointerdown/keydown 上；没解锁时静默跳过（不报错）。
     * @param getConfig 读取当前配置的函数。
     * @returns `{ unlock, play, state }`。
     */
    function createChime(getConfig) {
      let audio = null
      let failed = false

      function audioContextCtor() {
        if (typeof window === 'undefined') return undefined
        return window.AudioContext ?? window.webkitAudioContext
      }

      function unlock() {
        if (failed) return
        const Ctor = audioContextCtor()
        if (typeof Ctor !== 'function') return
        try {
          if (audio === null) audio = new Ctor()
          if (audio.state === 'suspended' && typeof audio.resume === 'function') {
            const resumed = audio.resume()
            if (resumed !== null && typeof resumed === 'object' && typeof resumed.catch === 'function') resumed.catch(() => {})
          }
        } catch {
          failed = true
        }
      }

      /**
       * 播放一次提示音 —— **只在降级路径上响**（宿主通道挂了、页面自己兜底）。
       *
       * 这里响的是**极简蜂鸣**，不是那 15 个真实音效：音效文件在插件目录里、
       * 由宿主进程播放，宿主通道既然挂了就拿不到它们。用一个短促双音保证"至少听得见"，
       * 别让降级变成静默（"降级必须可见可听"是硬不变量）。
       * @param kind 事件类型（failure 走下行音）。
       */
      function play(kind) {
        const config = getConfig()
        if (config.soundPreset === 'none') return
        if (config.volume <= 0) return
        if (audio === null) unlock()
        if (audio === null) return
        const scale = config.volume / 100
        const schedule = () => {
          // 上行：A5 → C#6；失败：A5 → F5（下行，听感"不对味"）。
          const down = kind === 'failure'
          const notes = down
            ? [{ f: 880.0, t: 0, d: 0.18, g: 0.16 }, { f: 698.46, t: 0.14, d: 0.28, g: 0.16 }]
            : [{ f: 880.0, t: 0, d: 0.18, g: 0.16 }, { f: 1108.73, t: 0.14, d: 0.28, g: 0.16 }]
          const now = audio.currentTime
          for (const note of notes) {
            const osc = audio.createOscillator()
            const gain = audio.createGain()
            osc.type = 'sine'
            osc.frequency.value = note.f
            const peak = Math.max(0.0001, note.g * scale)
            gain.gain.setValueAtTime(0, now + note.t)
            gain.gain.linearRampToValueAtTime(peak, now + note.t + 0.02)
            gain.gain.exponentialRampToValueAtTime(0.0005, now + note.t + note.d)
            osc.connect(gain)
            gain.connect(audio.destination)
            osc.start(now + note.t)
            osc.stop(now + note.t + note.d + 0.05)
          }
        }
        try {
          if (audio.state === 'running') {
            schedule()
          } else if (typeof audio.resume === 'function') {
            const resumed = audio.resume()
            if (resumed !== null && typeof resumed === 'object' && typeof resumed.then === 'function') {
              resumed.then(() => { if (audio.state === 'running') schedule() }).catch(() => {})
            }
          }
        } catch {
          failed = true
        }
      }

      return { unlock, play, state: () => (audio === null ? 'cold' : audio.state) }
    }

    // ════════════════════════════════════════════════════════════════════════
    // 样式
    // ════════════════════════════════════════════════════════════════════════

    /**
     * 卡片层与设置页的样式表。
     *
     * 视觉数值**照抄 DSH 原生通知面**（evidence/ux-reference.md §4 的实测值）：
     *  - 背景用 `--dsw-alias-toast-bg`：设计平台把"通知面"定义为**两套主题下都是深色**
     *    （浅色 #353638 / 深色 #43454a），所以卡片是深底白字，而不是跟随页面底色。
     *  - 层级 1100：原生 Toast 用的就是这一层（它的注释点名"高于图片灯箱 1000"）。
     *  - 圆角 --dsw-radius-lg、阴影 --dsw-shadow-lv3、进入动效 160ms ease-out + 位移 8px。
     * 有意偏离原生 Toast 的**五处**（README / ARCHITECTURE §8 有完整对照）：原生是**顶部居中、
     * 点击穿透、无关闭按钮、不堆叠、不可回会话**；本插件要的是**右下角、可点击回会话、可手动忽略、
     * 可堆叠、带进度条**——这正是用户点名的 Codex / WorkBuddy 形态。
     */
    const cssText = [
      '#dsh-donevoice-layer{position:fixed;right:20px;bottom:20px;z-index:1100;display:flex;flex-direction:column-reverse;gap:10px;width:min(360px,calc(100vw - 40px));pointer-events:none}',
      '.dv-card{pointer-events:auto;position:relative;overflow:hidden;display:grid;grid-template-columns:auto 1fr auto;align-items:start;gap:10px;padding:12px 12px 14px;border-radius:var(--dsw-radius-lg,16px);border:1px solid var(--dsw-elevation-stroke,var(--dsw-elevation-stroke-color,rgba(255,255,255,.14)));background:var(--dsw-alias-toast-bg,#353638);box-shadow:var(--dsw-shadow-lv3,0 12px 32px rgba(0,0,0,.28));color:var(--dsw-alias-toast-label,#ffffff);font-family:inherit;font-size:14px;line-height:22px;cursor:pointer;text-align:left;animation:dv-in 160ms ease-out both}',
      '.dv-card:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#7aaaff);outline-offset:2px}',
      '.dv-card.dv-out{animation:dv-out 200ms ease both;pointer-events:none}',
      '.dv-card[data-dv-kind=completion]{--dv-accent:var(--dsw-alias-state-success-primary,#22c55e)}',
      '.dv-card[data-dv-kind=approval]{--dv-accent:var(--dsw-alias-state-warn-secondary,#f7ad31)}',
      '.dv-card[data-dv-kind=question]{--dv-accent:var(--dsw-static-deepseek-400,#7aaaff)}',
      '.dv-card[data-dv-kind=failure]{--dv-accent:var(--dsw-alias-state-error-secondary,#f25a5a)}',
      '.dv-card[data-dv-kind=test]{--dv-accent:var(--dsw-static-deepseek-400,#7aaaff)}',
      '.dv-icon{flex:none;width:22px;height:22px;margin-top:1px;display:block}',
      '.dv-main{min-width:0}',
      '.dv-title{display:flex;align-items:center;gap:6px;font-weight:600;color:var(--dsw-alias-toast-label,#ffffff)}',
      '.dv-dot{width:6px;height:6px;border-radius:50%;background:var(--dv-accent);flex:none}',
      '.dv-body{margin-top:2px;color:var(--dsw-alias-toast-label,#ffffff);opacity:.72;overflow-wrap:anywhere}',
      '.dv-hint{margin-top:6px;color:var(--dsw-alias-toast-label,#ffffff);opacity:.45;font-size:12px;line-height:18px}',
      '.dv-close{flex:none;width:22px;height:22px;display:flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-toast-label,#ffffff);opacity:.5;font-size:15px;line-height:1;cursor:pointer;padding:0}',
      '.dv-close:hover{background:rgba(255,255,255,.14);opacity:.9}',
      '.dv-progress{position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--dv-accent);opacity:.6;transform-origin:left center;animation-name:dv-shrink;animation-timing-function:linear;animation-fill-mode:forwards}',
      '@keyframes dv-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
      '@keyframes dv-out{from{opacity:1}to{opacity:0}}',
      '@keyframes dv-shrink{from{transform:scaleX(1)}to{transform:scaleX(0)}}',
      '@media (prefers-reduced-motion: reduce){.dv-card{animation-duration:1ms}.dv-card.dv-out{animation-duration:1ms}.dv-progress{display:none}}',
      // 设置页**始终**比面板高一截 ⇒ 宿主面板的滚动条**常驻显示**，不再随音效库展开/收起
      // 忽隐忽现 —— 抖动就是它忽隐忽现造成的（用户定稿："这根滚动条常驻显示，跟其他设置框一样"）。
      // ⚠️ 上一版用 `:has(.dv-section){scrollbar-gutter:stable}` 给**所有祖先**预留装订线，
      // 结果连应用外壳一起挤窄，整个 DSH 页面向左移了 —— 所以这里只动自己：
      // 用一块看不见的留白把自己撑高，绝不碰宿主面板的样式。
      '.dv-section{display:flex;flex-direction:column;gap:10px;min-width:0;min-height:calc(100vh - 60px)}',
      '.dv-h2{margin:0;color:var(--dsw-alias-label-primary,#1a1a1a);font-size:16px;line-height:24px;font-weight:600}',
      '.dv-warn{margin:0;padding:9px 11px;border-radius:9px;border:1px solid var(--dsw-alias-state-warning-primary,rgba(240,160,32,.5));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);font-size:12px;line-height:19px}',
      '.dv-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:11px 13px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff)}',
      '.dv-rowText{display:flex;flex:1 1 200px;flex-direction:column;gap:2px;min-width:0}',
      '.dv-rowTitle{color:var(--dsw-alias-label-primary,#1a1a1a);font-size:13px;line-height:20px;font-weight:500}',
      // ── 开关：**带"关/开"文字的滑块按钮**（用户点名：左边关、右边开，点击后旋钮左右移动）。
      //    仍然是**真的 <input type=checkbox>**（键盘可聚焦、可切换、读屏认），
      //    只是视觉上被隐藏、由紧随其后的 .dv-switch 呈现 —— 所以用 `~` 兄弟选择器驱动滑块状态。
      '.dv-check{position:absolute;width:1px;height:1px;margin:0;opacity:0;pointer-events:none}',
      '.dv-switch{position:relative;display:inline-flex;align-items:center;flex:none;width:76px;height:26px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.35));font-size:11px;line-height:1;user-select:none;transition:background .18s ease}',
      '.dv-switchOff,.dv-switchOn{position:relative;z-index:1;flex:1 1 50%;text-align:center;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.6));transition:color .18s ease}',
      // 旋钮：白底圆角，绝对定位在条框内左右滑动（0 → 38px）。
      ".dv-switchKnob{position:absolute;z-index:0;top:2px;left:2px;width:34px;height:22px;border-radius:999px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.35);transition:transform .18s ease}",
      // 文字颜色跟着"谁被旋钮盖住"走：盖住的那个写在白旋钮上（深色），另一个写在药丸上。
      '.dv-check:not(:checked) ~ .dv-switch .dv-switchOff{color:#1c1c1e}',
      '.dv-check:not(:checked) ~ .dv-switch .dv-switchOn{color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.6))}',
      '.dv-check:checked ~ .dv-switch{background:var(--dsw-alias-brand-primary,#4d7ff5)}',
      '.dv-check:checked ~ .dv-switch .dv-switchKnob{transform:translateX(38px)}',
      '.dv-check:checked ~ .dv-switch .dv-switchOn{color:#1c1c1e;font-weight:600}',
      '.dv-check:checked ~ .dv-switch .dv-switchOff{color:rgba(255,255,255,.9)}',
      '.dv-check:focus-visible ~ .dv-switch{outline:2px solid var(--dsw-alias-brand-primary,#4d7ff5);outline-offset:2px}',
      '.dv-check:disabled ~ .dv-switch{opacity:.6}',
      '.dv-value{flex:none;min-width:46px;text-align:right;color:var(--dsw-alias-label-primary,#1a1a1a);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
      '.dv-range{flex:1 1 100%;width:100%;min-width:0;height:18px;margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary,#4d7ff5);cursor:pointer}',
      '.dv-btn{flex:none;height:30px;padding:0 13px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary,#1a1a1a);font:inherit;font-size:12px;cursor:pointer}',
      '.dv-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
      '.dv-btn:disabled{opacity:.5;cursor:default}',
      '.dv-select{flex:none;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);font:inherit;font-size:12px}',
      // 总开关单独一块：更重的边框 + 略强底色，视觉上明确"它是所有开关的上位"。
      '.dv-master{border-color:var(--dsw-alias-brand-primary,#4d7ff5);background:var(--dsw-alias-bg-layer-2,rgba(77,127,245,.06));box-shadow:0 1px 2px rgba(0,0,0,.04)}',
      // 失效态：整行变灰 + 不可点（用户要求"灰色显示，表示无法点击"）。
      '.dv-off{opacity:.45}',
      '.dv-off *{cursor:not-allowed!important}',
      '.dv-off .dv-switch,.dv-off .dv-range,.dv-off .dv-select,.dv-off .dv-btn{cursor:not-allowed}',
      '.dv-range:disabled,.dv-select:disabled{opacity:.6;cursor:not-allowed}',
      // 音效库：圆角方框 + 点击展开；展开体在正常文档流里，清单自身限高可滚。
      '.dv-manage{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);overflow:hidden}',
      '.dv-manageSum{display:flex;align-items:center;gap:10px;padding:13px 14px;color:var(--dsw-alias-label-primary,#1a1a1a);font-size:13px;line-height:20px;font-weight:500;cursor:pointer;list-style:none;user-select:none}',
      '.dv-manageSum::-webkit-details-marker{display:none}',
      '.dv-manageSum::after{content:"▸";margin-left:auto;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.5));font-size:12px;transition:transform .18s ease}',
      '.dv-manage[open] .dv-manageSum{border-bottom:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.16))}',
      '.dv-manage[open] .dv-manageSum::after{transform:rotate(90deg)}',
      '.dv-manageCount{flex:none;min-width:22px;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.6));font-size:11px;font-weight:400;text-align:center}',
      '.dv-manageBody{padding:12px 14px 14px}',
      '.dv-addRow{display:flex;align-items:center;justify-content:center;gap:6px;height:38px;margin:0 0 10px;border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.45));border-radius:11px;color:var(--dsw-alias-label-secondary,rgba(0,0,0,.7));font-size:12px;cursor:pointer}',
      '.dv-addRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));color:var(--dsw-alias-label-primary,#1a1a1a)}',
      '.dv-soundList{max-height:236px;margin:0 -14px;padding:0 14px;overflow:auto}',
      '.dv-soundItem{display:flex;align-items:center;gap:10px;min-height:40px;padding:6px 0;border-top:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.16))}',
      '.dv-soundItem:first-child{border-top:0}',
      '.dv-soundName{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#1a1a1a);font-size:13px}',
      '.dv-soundTag{flex:none;padding:2px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.6));font-size:11px}',
      '.dv-soundItem .dv-btn{height:26px;padding:0 10px;font-size:11px}',
      // 删除按钮：**常态保持中性**，只有悬停才显红。
      // 15 行清一色红框会把整个清单变成一堵红墙（用户嫌"拥挤/乱"），危险色留在交互瞬间就够。
      '.dv-danger{color:var(--dsw-alias-label-secondary,rgba(0,0,0,.7))}',
      '.dv-danger:hover{color:var(--dsw-alias-state-error-secondary,#f25a5a);border-color:var(--dsw-alias-state-error-secondary,rgba(242,90,90,.55))}',
    ].join('\n')

    /**
     * 注入样式表（幂等，但**内容感知**）。
     *
     * ⚠️ 真机事故（用户截图：开关还是原生勾选框、`<details>` 露出系统小三角）：
     * 原来只判 `getElementById(STYLE_ID) !== null` 就 return —— 客户端**热重载**时
     * JS 换了、页面却没刷新，旧 `<style>` 还挂在 `<head>` 上，于是**新标记配旧样式**，
     * 看起来就是"你改了但我这儿没变"。现在内容不一致就**就地更新**，热重载也能立刻生效。
     */
    function adoptStyles() {
      if (typeof document === 'undefined') return
      const existing = document.getElementById(STYLE_ID)
      if (existing !== null) {
        if (existing.textContent !== cssText) {
          existing.textContent = cssText
          console.info('[donevoice] 样式已更新（页面未刷新也会生效）')
        }
        return
      }
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = cssText
      document.head.appendChild(style)
    }

    // ════════════════════════════════════════════════════════════════════════
    // 页内卡片层（手写 DOM：需要精确控制计时/悬停暂停，不需要 React 树）
    // ════════════════════════════════════════════════════════════════════════

    /**
     * 造右下角卡片层。
     * @param options `{ getConfig, onOpen, onDismiss, prefersReducedMotion }`。
     * @returns `{ push, dismissAll, count }`。
     */
    function createToastLayer(options) {
      const opts = options !== null && typeof options === 'object' ? options : {}
      const getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : () => DEFAULT_CONFIG
      const onOpen = typeof opts.onOpen === 'function' ? opts.onOpen : () => {}
      const onDismiss = typeof opts.onDismiss === 'function' ? opts.onDismiss : () => {}
      const reduced = typeof opts.prefersReducedMotion === 'function' ? opts.prefersReducedMotion : () => false

      let layer = null
      /** 活动卡片：`{ el, event, timer, remaining, deadline }`。 */
      const live = []

      function ensureLayer() {
        if (typeof document === 'undefined') return null
        if (layer !== null && layer.isConnected === true) return layer
        layer = document.createElement('div')
        layer.id = LAYER_ID
        layer.setAttribute('role', 'log')
        layer.setAttribute('aria-live', 'polite')
        layer.setAttribute('aria-relevant', 'additions')
        document.body.appendChild(layer)
        return layer
      }

      function removeCard(entry, immediate) {
        const index = live.indexOf(entry)
        if (index >= 0) live.splice(index, 1)
        if (entry.timer !== null) {
          window.clearTimeout(entry.timer)
          entry.timer = null
        }
        if (entry.el === null || entry.el.parentNode === null) return
        if (immediate === true || reduced()) {
          entry.el.parentNode.removeChild(entry.el)
          return
        }
        entry.el.classList.add('dv-out')
        window.setTimeout(() => {
          if (entry.el !== null && entry.el.parentNode !== null) entry.el.parentNode.removeChild(entry.el)
        }, 190)
      }

      function dismiss(entry) {
        onDismiss(entry.event)
        removeCard(entry, false)
      }

      function arm(entry, ms) {
        entry.deadline = Date.now() + ms
        entry.timer = window.setTimeout(() => { dismiss(entry) }, ms)
        if (entry.progress !== null && !reduced()) {
          entry.progress.style.animationDuration = ms + 'ms'
          entry.progress.style.animationPlayState = 'running'
        }
      }

      function pause(entry) {
        if (entry.timer === null) return
        window.clearTimeout(entry.timer)
        entry.timer = null
        entry.remaining = Math.max(200, entry.deadline - Date.now())
        if (entry.progress !== null) entry.progress.style.animationPlayState = 'paused'
      }

      function resume(entry) {
        if (entry.timer !== null) return
        if (entry.remaining === undefined) return
        if (entry.progress !== null) entry.progress.style.animationPlayState = 'running'
        arm(entry, entry.remaining)
      }

      /**
       * 推一张卡片。
       * @param event 引擎事件（或测试事件）。
       * @param spec `{ title, body, icon }`。
       * @returns 卡片条目。
       */
      function push(event, spec) {
        const host = ensureLayer()
        if (host === null) return null
        const config = getConfig()

        const card = document.createElement('article')
        card.className = 'dv-card'
        card.dataset.dvKind = typeof event.kind === 'string' ? event.kind : 'completion'
        // 阻塞性提醒用 alert（断言式播报），普通完成用 status（礼貌式）；
        // 容器层 aria-live="polite" 保证多卡片不会互相打断。
        card.setAttribute('role', event.kind === 'approval' || event.kind === 'failure' ? 'alert' : 'status')
        card.tabIndex = 0

        const icon = document.createElement('span')
        icon.className = 'dv-icon'
        icon.innerHTML = typeof spec.icon === 'string' ? spec.icon : ICON_SVG.completion
        card.appendChild(icon)

        const main = document.createElement('div')
        main.className = 'dv-main'
        const titleRow = document.createElement('div')
        titleRow.className = 'dv-title'
        const dot = document.createElement('span')
        dot.className = 'dv-dot'
        titleRow.appendChild(dot)
        const titleText = document.createElement('span')
        titleText.textContent = String(spec.title ?? '')
        titleRow.appendChild(titleText)
        main.appendChild(titleRow)
        const body = document.createElement('div')
        body.className = 'dv-body'
        body.textContent = String(spec.body ?? '')
        main.appendChild(body)
        const hint = document.createElement('div')
        hint.className = 'dv-hint'
        hint.textContent = String(spec.hint ?? '')
        if (hint.textContent !== '') main.appendChild(hint)
        card.appendChild(main)

        const close = document.createElement('button')
        close.type = 'button'
        close.className = 'dv-close'
        close.textContent = '\u00d7'
        close.setAttribute('aria-label', 'dismiss')
        card.appendChild(close)

        const progress = reduced() ? null : document.createElement('div')
        if (progress !== null) {
          progress.className = 'dv-progress'
          card.appendChild(progress)
        }

        const entry = { el: card, event, timer: null, progress, deadline: 0, remaining: undefined }
        card.addEventListener('click', (nativeEvent) => {
          if (nativeEvent.target === close) return
          openEvent(event)
          removeCard(entry, false)
        })
        close.addEventListener('click', (nativeEvent) => {
          nativeEvent.stopPropagation()
          dismiss(entry)
        })
        card.addEventListener('mouseenter', () => { pause(entry) })
        card.addEventListener('mouseleave', () => { resume(entry) })
        card.addEventListener('keydown', (nativeEvent) => {
          if (nativeEvent.key === 'Enter' || nativeEvent.key === ' ') {
            nativeEvent.preventDefault()
            openEvent(event)
            removeCard(entry, false)
          }
        })

        host.appendChild(card)
        live.push(entry)
        arm(entry, clampInt(config.durationSec, 3, 30, 6) * 1000)

        const cap = clampInt(config.maxStack, 1, 10, 4)
        while (live.length > cap) removeCard(live[0], false)
        return entry
      }

      function openEvent(event) {
        try {
          onOpen(event)
        } catch {
          // 打开失败不能影响卡片清理
        }
      }

      function dismissAll() {
        while (live.length > 0) removeCard(live[live.length - 1], true)
      }

      return { push, dismissAll, count: () => live.length }
    }

    // ════════════════════════════════════════════════════════════════════════
    // 宿主中继通道（把提醒交给宿主进程去弹 Windows 原生通知）
    // ════════════════════════════════════════════════════════════════════════

    /**
     * 造一个"把提醒中继给宿主进程"的通道。
     *
     * 为什么要有它：页内卡片只是 DSH 窗口里的一小块 DOM。用户切到别的窗口干活时，
     * 那块 DOM 他根本看不见 —— 提醒等于没发生。真正的主信号必须是**宿主进程弹的系统通知**，
     * 它与页面在不在、在看哪个窗口、标签有没有被冻结都无关。
     *
     * 三条硬规矩（每条都有测试盯着）：
     *  1. `keepalive: true` —— 页面正在卸载 / 用户已经切走时，这次中继也要送达宿主；
     *  2. 3 秒超时 + 永不抛出 —— 宿主半区没起来时 `window.fetch` 可能悬着不返回，
     *     没有超时用户就永远等不到任何信号。任何失败一律以 `{ ok:false, reason }` 收场，
     *     调用方只做"成功 / 降级"两分支，不用再套一层 try/catch；
     *  3. 每次结果都留痕（时间 / kind / dedupKey / ok / 失败原因 / latencyMs / 是否降级），
     *     挂在调试面 `window.__dshDoneVoice.relay`（最近 N 条）与磁盘诊断上 —— "降级必须可见"。
     * @param options `{ onResult, timeoutMs, now }`（timeoutMs 供测试注入，默认 3 秒）。
     * @returns `{ send, history, stats }`。
     */
    function createRelay(options) {
      const opts = options !== null && typeof options === 'object' ? options : {}
      const onResult = typeof opts.onResult === 'function' ? opts.onResult : () => {}
      const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : RELAY_TIMEOUT_MS
      const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
      /** 最近的中继结果（环形，超出上限丢最旧的）。 */
      const history = []
      const counters = { attempts: 0, ok: 0, failed: 0, deduped: 0, degraded: 0 }

      /**
       * 发一次 POST 并解析回执。**永不 reject、永不抛出到调用方**。
       *
       * 成功的判据（冻结契约，宿主侧同口径）：
       *   `2xx` 且（`delivered` 非空 **或** `deduped === true`）。
       * 后者是"宿主侧的传感器已经为同一件事弹过了，这次请求被去重" —— 外面**已经响过了**，
       * 所以同样算成功，绝不能因此再降级弹一张页内卡片、再响一声（那才是双响）。
       * @param route 路由。
       * @param body 请求体。
       * @param meta `{ kind, dedupKey }`，只用于留痕。
       * @returns Promise<中继结果记录>。
       */
      function post(route, body, meta) {
        const startedAt = now()
        const record = {
          at: new Date().toISOString(),
          route,
          kind: typeof meta?.kind === 'string' ? meta.kind : '',
          dedupKey: typeof meta?.dedupKey === 'string' ? meta.dedupKey : '',
          ok: false,
          reason: '未完成',
          latencyMs: 0,
          delivered: [],
          deduped: false,
          degraded: true,
        }
        let settled = false
        let timer = null
        return new Promise((resolve) => {
          const finish = (patch) => {
            if (settled !== true) {
              settled = true
              if (timer !== null) {
                try { window.clearTimeout(timer) } catch { /* 清理失败不影响结果 */ }
              }
              for (const key of Object.keys(patch)) record[key] = patch[key]
              record.ok = record.ok === true
              record.degraded = record.ok !== true
              record.latencyMs = Math.max(0, now() - startedAt)
              counters.attempts += 1
              if (record.ok) counters.ok += 1
              else counters.failed += 1
              if (record.deduped) counters.deduped += 1
              if (record.degraded) counters.degraded += 1
              history.push(record)
              if (history.length > RELAY_LOG_LIMIT) history.shift()
              try { onResult(record) } catch { /* 留痕失败不能影响主流程 */ }
            }
            resolve(record)
          }
          try {
            if (typeof window === 'undefined' || typeof window.fetch !== 'function') {
              finish({ ok: false, reason: 'window.fetch 不可用，无法中继宿主的原生通知' })
              return
            }
            const controller = typeof window.AbortController === 'function' ? new window.AbortController() : null
            timer = window.setTimeout(() => {
              // 超时即"宿主通道不可用"：真的 abort 掉，避免"3 秒后已降级弹了卡片、
              // 4 秒时宿主又补弹一张"的双份提醒。宁可这一次没送出去，也不要双响。
              try { if (controller !== null) controller.abort() } catch { /* abort 失败也要走降级 */ }
              finish({ ok: false, reason: 'timeout(' + timeoutMs + 'ms) 宿主通道没有响应' })
            }, timeoutMs)
            const request = window.fetch(route, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
              // keepalive：页面即将卸载 / 用户已经切走时也要送达（这是"弹到外面去"的关键）。
              keepalive: true,
              cache: 'no-store',
              signal: controller === null ? undefined : controller.signal,
            })
            Promise.resolve(request).then((response) => {
              if (response === null || typeof response !== 'object' || response.ok !== true) {
                finish({ ok: false, reason: 'HTTP ' + String(response !== null && typeof response === 'object' ? response.status : '异常响应') })
                return undefined
              }
              return Promise.resolve(response.json()).then((parsed) => {
                const delivered = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.delivered) ? parsed.delivered : []
                const deduped = parsed !== null && typeof parsed === 'object' && parsed.deduped === true
                const suppressed = parsed?.suppressed === 'present' ? 'present' : null
                const ok = delivered.length > 0 || deduped || suppressed === 'present'
                finish({
                  ok,
                  delivered,
                  deduped,
                  suppressed,
                  soundPlayed: parsed?.soundPlayed === true,
                  reason: ok ? null : '宿主未送达通知，也未返回去重或前台静默结果',
                })
              }).catch((error) => {
                finish({ ok: false, reason: '回执不是 JSON：' + String(error) })
              })
            }).catch((error) => {
              finish({ ok: false, reason: '网络/请求失败：' + String(error) })
            })
          } catch (error) {
            finish({ ok: false, reason: '发起中继时抛异常：' + String(error) })
          }
        })
      }

      /** 中继一条真实提醒。 */
      function send(payload) {
        const source = payload !== null && typeof payload === 'object' ? payload : {}
        return post(NOTIFY_ROUTE, source, { kind: source.kind, dedupKey: source.dedupKey })
      }

      return {
        send,
        history: () => history.slice(),
        stats: () => Object.assign({}, counters, {
          lastReason: history.length === 0 ? null : history[history.length - 1].reason,
        }),
      }
    }

    /** 判定 DSH 窗口是否不在前台（决定是否发系统通知）。 */
    function isWindowBackground() {
      if (typeof document === 'undefined') return false
      try {
        if (document.visibilityState !== undefined && document.visibilityState !== 'visible') return true
        if (typeof document.hasFocus === 'function') return document.hasFocus() !== true
      } catch {
        return false
      }
      return false
    }

    /**
     * 一次性看门狗：到点执行 check，返回可清理的 disposer。
     *
     * 必须写成 window.setTimeout——动态包的闭包里裸 `setTimeout` 是 runner 的教学陷阱
     * （调用即抛），这条已经在旧插件的踩坑记录里被点名过。
     * @param ms 等待毫秒数。
     * @param check 到点执行的回调。
     * @returns 清理函数。
     */
    function watchdog(ms, check) {
      if (typeof window === 'undefined' || typeof window.setTimeout !== 'function') return () => {}
      const handle = window.setTimeout(() => {
        try {
          check()
        } catch {
          // 看门狗自身不得成为新的故障源
        }
      }, ms)
      return () => {
        try {
          window.clearTimeout(handle)
        } catch {
          // 忽略
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // 极简快照 store（不 require dsh-client-store，把模块表风险降到零）
    // ════════════════════════════════════════════════════════════════════════

    /**
     * 造一个 `{ getSnapshot, subscribe, set }` 快照源，形状与平台 createSnapshotStore 一致，
     * 因此可以直接作为槽位 inject 的 `hooks` 值（框架会包成 useXxx 钩子）。
     * @param initial 初始快照。
     * @returns 快照源。
     */
    function createStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set: (next) => {
          snapshot = next
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch {
              // 订阅者异常不影响其它订阅者
            }
          }
        },
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // 设置页（React，注册进 settings.section 槽位）
    // ════════════════════════════════════════════════════════════════════════

    /**
     * 一行开关 —— 右侧是**带"关/开"文字的滑块按钮**（用户点名要的形态）。
     *
     * 结构：真 `<input type=checkbox>`（视觉隐藏，键盘/读屏都认）+ 紧随其后的 `.dv-switch`，
     * 滑块状态由 `.dv-check:checked ~ .dv-switch` 驱动（**顺序不能换**）。
     * 开关放右侧，和「提示音」下拉、滑条数值一样排成一条右对齐的控制列。
     */
    function ToggleRow(props) {
      const off = props.disabled === true
      return h('label', { className: off ? 'dv-row dv-off' : 'dv-row' },
        h('span', { className: 'dv-rowText' },
          h('span', { className: 'dv-rowTitle' }, props.label),
        ),
        h('input', {
          type: 'checkbox',
          className: 'dv-check',
          checked: props.checked === true,
          disabled: off,
          'aria-label': props.label,
          onChange: (nativeEvent) => { props.onChange(nativeEvent.target.checked) },
        }),
        h('span', { className: 'dv-switch', 'aria-hidden': 'true' },
          h('span', { className: 'dv-switchKnob' }),
          h('span', { className: 'dv-switchOff' }, props.offLabel ?? '关'),
          h('span', { className: 'dv-switchOn' }, props.onLabel ?? '开'),
        ),
      )
    }

    /** 一行滑条（同样没有说明文字，只有标题 + 数值 + 滑条）。`disabled` 同上。 */
    function RangeRow(props) {
      const off = props.disabled === true
      return h('div', { className: off ? 'dv-row dv-off' : 'dv-row' },
        h('span', { className: 'dv-rowText' },
          h('span', { className: 'dv-rowTitle' }, props.label),
        ),
        h('span', { className: 'dv-value' }, String(props.value) + props.unit),
        h('input', {
          type: 'range',
          className: 'dv-range',
          min: props.min,
          max: props.max,
          step: 1,
          value: props.value,
          disabled: off,
          'aria-label': props.label,
          onChange: (nativeEvent) => { props.onChange(Number(nativeEvent.target.value)) },
        }),
      )
    }

    /**
     * 音效 id → 显示名。
     *
     * 自带的 15 个有中英文学名（`settings.sound.<id>`）；用户自己导入的没有词条，
     * 就直接显示 id（那就是他自己的文件名派生出来的，认得出来）。
     * @param id 音效 id。
     * @param t 槽位给的翻译函数。
     * @returns 显示名。
     */
    function soundLabel(id, t) {
      if (id === 'none' || SOUND_IDS.includes(id)) return t('settings.sound.' + id)
      return id
    }

    /**
     * 设置页组件。props = 槽位标准件（t）+ inject 面（`useSettings`/`useCatalog` 快照钩子、
     * `update`、`preview`、`addSounds`、`removeSound`、`channelLost`）。
     *
     * 布局口径（用户定稿，两轮精简后）：
     *   · **只有两个开关**：总开关 + 页内卡片。四类提醒 / 页内音效 / 子代理都**没有开关**
     *     ——它们的语义变成了硬行为（见 host-config.js 的说明）。
     *   · **一行解释文字都不写**：没有副标题、没有分组小标题、没有 desc、没有"0 为静音"这类提示。
     *   · 总开关单独一块放最前（优先级最高）；它关着时下面**全部变灰且不可点**。
     *   · 音效相关收进**一个模块**：下拉试听 + 音量 + 可展开的「音效库」（添加与删除同处）。
     */
    function DoneVoiceSection(props) {
      const settings = props.useSettings((snapshot) => snapshot.value) ?? DEFAULT_CONFIG
      const unavailable = props.channelLost === true

      const t = props.t
      const set = (field) => (value) => { props.update(field, value) }

      // 下拉选项 = 宿主扫盘得到的清单（自带 + 用户导入），`none` 永远在最后。
      // 宿主通道不通时回落到静态清单，至少能选自带的那些。
      const catalogValue = props.useCatalog((snapshot) => snapshot.value)
      const catalog = catalogValue !== null && catalogValue !== undefined && Array.isArray(catalogValue.sounds)
        ? catalogValue.sounds
        : []
      const soundOptions = catalogValue?.loaded === true
        ? catalog.map((item) => item.id).filter((id) => id !== 'none').concat(['none'])
        : SOUND_IDS.slice()
      // 总开关关 ⇒ 下面全部失效（灰 + 不可点）。
      const masterOff = settings.enabled !== true
      const soundOff = masterOff || settings.soundPreset === 'none' || !(settings.volume > 0)

      return h('section', { className: 'dv-section' },
        h('h2', { className: 'dv-h2' }, t('settings.title')),
        unavailable ? h('p', { className: 'dv-warn' }, t('settings.unavailable')) : null,

        // ── 总开关：单独一块，优先级最高 ──────────────────────────────────
        h('div', { className: 'dv-master' },
          h(ToggleRow, {
            label: t('settings.enabled'),
            checked: settings.enabled === true,
            onChange: set('enabled'),
          }),
        ),
        // ── 唯一的可选开关 ──────────────────────────────────────────────
        h(ToggleRow, {
          label: t('settings.pageCard'),
          checked: settings.pageCard === true,
          disabled: masterOff,
          onChange: set('pageCard'),
        }),

        // ── 音效（一个模块装下：选 / 试听 / 音量 / 音效库）──────────────────
        h('div', { className: masterOff ? 'dv-row dv-off' : 'dv-row' },
          h('span', { className: 'dv-rowText' },
            h('span', { className: 'dv-rowTitle' }, t('settings.sound')),
          ),
          h('select', {
            className: 'dv-select',
            value: settings.soundPreset,
            disabled: masterOff,
            'aria-label': t('settings.sound'),
            onChange: (nativeEvent) => {
              set('soundPreset')(nativeEvent.target.value)
              if (nativeEvent.target.value !== 'none') props.preview(nativeEvent.target.value)
            },
          }, soundOptions.map((option) => h('option', { key: option, value: option }, soundLabel(option, t)))),
          h('button', {
            type: 'button',
            className: 'dv-btn',
            disabled: soundOff,
            onClick: () => { props.preview(settings.soundPreset) },
          }, t('settings.soundPreview')),
        ),
        h(RangeRow, { label: t('settings.volume'), value: settings.volume, min: 0, max: 100, unit: '%', disabled: masterOff, onChange: set('volume') }),

      // 「音效库」：**圆角方框 + 点击展开**（用户点名）。收起时一行；展开后
      // 先是一条虚线"添加"行，再是清单（名称单行截断、右侧试听/删除，自身限高可滚）。
      // 标签包住隐藏的 file input：点标签就等于点按钮，不需要 ref。
      h('details', { className: masterOff ? 'dv-manage dv-off' : 'dv-manage' },
          h('summary', { className: 'dv-manageSum' },
            h('span', null, t('settings.soundLibrary')),
            h('span', { className: 'dv-manageCount' }, String(catalog.length)),
          ),
          h('div', { className: 'dv-manageBody' },
            h('label', { className: 'dv-addRow' },
              t('settings.soundAddPick'),
              h('input', {
                type: 'file',
                accept: 'audio/*,.mp3,.wav,.m4a,.wma,.aac',
                multiple: true,
                style: { display: 'none' },
                disabled: masterOff,
                onChange: (nativeEvent) => {
                  const files = nativeEvent.target.files
                  void props.addSounds(files)
                  // 清掉选择，方便连续导入同一个文件。
                  try { nativeEvent.target.value = '' } catch { /* 无伤 */ }
                },
              }),
            ),
            h('div', { className: 'dv-soundList' }, catalog.map((item) => h('div', { key: item.id, className: 'dv-soundItem' },
              h('span', { className: 'dv-soundName', title: item.id }, soundLabel(item.id, t)),
              h('span', { className: 'dv-soundTag' }, item.builtin ? t('settings.soundBuiltin') : t('settings.soundUser')),
              h('button', { type: 'button', className: 'dv-btn', disabled: masterOff, onClick: () => { props.preview(item.id) } }, t('settings.soundPreview')),
              h('button', {
                type: 'button',
                className: 'dv-btn dv-danger',
                disabled: masterOff,
                onClick: () => { void props.removeSound(item.id) },
              }, t('settings.soundDelete')),
            ))),
          ),
        ),
      )
    }


    // ════════════════════════════════════════════════════════════════════════
    // 插件主体
    // ════════════════════════════════════════════════════════════════════════

    /** 需要的服务。sessions/remote/slots/locale 在桌面 Web 组合里必然存在。 */
    // ⚠️ 服务可见范围由这份声明决定：**没声明的服务在 apply 里根本取不到**，
    // 运行时 `ctx.inject([...])` 也永远不会就绪（真机踩过，详见 bindPendingChannel 的注释）。
    //   · `uiSession`   → 等待审批 / 等待回答的聚合状态（这两类提醒的命脉）
    //   · `uiWorkspace` → 点击卡片回到对应会话
    // 官方 approval / user-questions 的声明表里同样有 `uiSession`，这里与之同构。
    const inject = ['sessions', 'remote', 'slots', 'locale', 'uiSession', 'uiWorkspace']

    /**
     * 装载浏览器半区。
     * @param ctx 客户端 Cordis 上下文。
     */
    function apply(ctx) {
      adoptStyles()

      // ── 诊断面：全部挂到 window.__dshDoneVoice，排查时不靠猜 ──────────────
      const debug = { version: VERSION, events: [], notes: [], config: null }
      const log = (...args) => { console.info(TAG, ...args) }
      /**
       * 记一笔"降级/中继失败"的可见痕迹。**必须封顶**：宿主通道长期挂掉时每一条提醒都会记一次，
       * 不封顶就是一条慢速内存泄漏，而且会把最早那条"为什么降级"的证据淹掉。
       */
      const pushNote = (line) => {
        debug.notes.push(line)
        if (debug.notes.length > 50) debug.notes.shift()
      }
      const degrade = (what, why) => {
        const line = what + ' — ' + why
        pushNote(line)
        console.error(TAG, line)
      }
      const record = (text) => {
        debug.events.push(Date.now() + ' ' + text)
        if (debug.events.length > 200) debug.events.shift()
      }
      const publishDebug = (extra) => {
        if (typeof window === 'undefined') return
        const surface = Object.assign({
          version: VERSION,
          events: debug.events,
          notes: debug.notes,
        }, extra ?? {})
        // config / engine 用取值器：设置改了、会话增删了，调试面读到的永远是当前值，
        // 而不是 apply 那一刻的快照（排查"设置没生效"时最容易踩的坑）。
        Object.defineProperty(surface, 'config', { get: () => settings, enumerable: true })
        Object.defineProperty(surface, 'engine', { get: () => engine.stats(), enumerable: true })
        // 最近 N 条中继结果（时间 / kind / dedupKey / ok / 失败原因 / latencyMs / 是否降级）——
        // "降级必须可见"的第二个落点：用户在 devtools 里一眼就能看到外面到底响了没有。
        Object.defineProperty(surface, 'relay', { get: () => relay.history(), enumerable: true })
        Object.defineProperty(surface, 'relayStats', { get: () => relay.stats(), enumerable: true })
        window.__dshDoneVoice = surface
      }

      // ── 文案 ────────────────────────────────────────────────────────────
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'donevoice: dictionaries')
      const t = ctx.locale.bind(NS)
      const currentLocale = () => {
        try {
          const snapshot = ctx.locale.getSnapshot()
          if (snapshot !== null && typeof snapshot === 'object') {
            // LocaleSnapshot 的真实字段是 `active`（见 dsh-client-locale/lib/client.js:1217
            // 与 :1531 的 getSnapshot().active）。`locale` 只是防御性兜底，别指望它。
            if (typeof snapshot.active === 'string' && snapshot.active !== '') return snapshot.active
            if (typeof snapshot.locale === 'string' && snapshot.locale !== '') return snapshot.locale
          }
        } catch {
          // 取不到就回落中文
        }
        return 'zh'
      }

      // ── 配置：走宿主自带的同源 JSON 路由 ─────────────────────────────────
      //
      // 为什么不用官方的 Config + ctx.configForms：宿主半区要声明 Config 就得
      // `import '@deepseek-ai/schemastery'`，而 profile 的 node_modules 里**没有**
      // @deepseek-ai 作用域 ⇒ 静态 import 链接期失败 ⇒ 整个宿主条目死掉
      // （实机 `ERR_MODULE_NOT_FOUND` 已验证，详见 index.js 头注释）。
      // 所以设置走本插件自己的同源路由——与 dsh-status-rotator / reasoning-slider
      // 在本机已经跑通的组合一致。
      const CONFIG_ROUTE = '/plugins/dsh-donevoice/config.json'
      /** 点击标记探针（读一次就删）：见 checkClickedNotification 的说明。 */
      const CLICK_ROUTE = '/plugins/dsh-donevoice/health.json?probe=click'
      /** 试听路由：声音文件在插件目录里，**只有宿主进程能播**，页面只能请它代播。 */
      const PREVIEW_ROUTE = '/plugins/dsh-donevoice/preview'
      /** 音效清单 / 导入 / 删除（宿主代做：文件在磁盘上，页面碰不到）。 */
      const SOUNDS_ROUTE = '/plugins/dsh-donevoice/sounds.json'
      const settingsStore = createStore({ value: DEFAULT_CONFIG })
      /** 配置读取失败的退避重试间隔（毫秒）；用尽后降级报警。 */
      const CONFIG_RETRY_MS = [400, 800, 1600, 3200, 5000]
      /** 自动保存的防抖窗口（毫秒）：滑条拖动期间只发最后一次。 */
      const PERSIST_DEBOUNCE_MS = 250
      /** 攒着还没写出去的字段（自动保存的"脏页"）。 */
      let pendingPatch = {}
      /** 待触发的防抖定时器。 */
      let writeTimer = null
      /** 单一在途写入；未确认字段始终保留在 pendingPatch。 */
      let writeTask = null
      let settingsRevision = 0
      let settingsDisposed = false
      /** 读取重试的定时器（HMR/卸载时要清掉）。 */
      let retryTimer = null
      /** 最近一次成功落盘的时间（诊断用）。 */
      let lastSavedAt = null
      /** 配置是否已经真的从宿主读到过（区分"默认值"与"真实值"）。 */
      let settingsLoaded = false
      /**
       * 音效清单（宿主扫盘的结果）。
       *
       * 为什么要有它：用户可以自由导入/删除音效，"有哪些音效"只能问宿主——
       * 静态清单（SOUND_IDS）现在只是**离线回落**（宿主通道不通时至少能列出自带的那些）。
       */
      const catalogStore = createStore({ value: { sounds: [], loaded: false } })
      let settings = DEFAULT_CONFIG
      /**
       * 诊断通道自身的故障只出声一次。
       * ⚠️ 必须声明在这里（早于第一次 `applySettings`）：`flushDiag` 会在配置首次落值时被调用，
       * 而它在 catch 分支里要读这个标志——声明太晚会变成 TDZ ReferenceError 并把 apply 带崩。
       */
      let diagStorageWarned = false
      /**
       * 诊断对象是否已经初始化完毕。
       * `applySettings` 会在 apply 的前半段就落值（早于 diag 声明），此时 flush 必须**安静跳过**，
       * 否则会抛 TDZ 错误、并被上面那条警告误报成"存储失败"。
       */
      let diagReady = false
      /** 配置通道状态：'absent' 尚未通信 / 'ready' 已通 / 'lost' 已出声。 */
      let settingsChannel = 'absent'
      /** settings.section 槽位是否真的被声明过（决定"设置页未注册"这条降级要不要报）。 */
      let sectionRegistered = false

      const applySettings = (raw) => {
        settings = normalizeConfig(raw)
        debug.config = settings
        settingsStore.set({ value: settings })
        // 诊断落盘必须跟着"真正生效的配置"走，否则外部看到的是陈旧的开关状态。
        // （首次调用早于 diag 初始化，flushDiag 内部的 try/catch 会静默跳过，无副作用。）
        flushDiag()
      }
      applySettings(undefined)

      /**
       * 查一次"系统通知刚被点过吗"。
       *
       * 背景：点击 Windows 通知执行的是 AUMID 快捷方式 → 一个隐藏 PowerShell 把 DSH 窗口拿到前台
       * （见 win-native.js 的 activateScript）。**但那条路在宿主进程之外，拿不到"是哪条通知"**：
       * 未打包应用的通知点击不会回调到我们的进程（要回调得注册 COM 激活器，代价不成比例）。
       * 所以用最朴素的办法对接：激活脚本落一个点击标记，宿主探针读一次就删，
       * 页面拿到焦点后查这个标记，再跳到宿主记录的那条最近通知的会话。
       * @returns 完成后的 Promise（永不 reject）。
       */
      async function checkClickedNotification() {
        try {
          const response = await window.fetch(CLICK_ROUTE, { cache: 'no-store' })
          if (response === null || typeof response !== 'object' || response.ok !== true) return
          const payload = await response.json()
          if (payload === null || typeof payload !== 'object' || payload.clicked !== true) return
          const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
          if (sessionId === '' || openSession === null) {
            if (sessionId !== '' && openSession === null) record('通知被点击：但 openSession 不可用，只聚焦了窗口')
            return
          }
          openSession(sessionId)
          record('通知被点击 → 跳到会话 ' + shortId(sessionId) + (payload.kind === undefined ? '' : '（' + String(payload.kind) + '）'))
        } catch {
          // 点击标记是锦上添花，任何失败都不影响提醒主流程
        }
      }

      /**
       * 试听：请宿主播一次指定音效（不弹通知）。
       *
       * 为什么必须绕宿主：那 15 个音效是插件自带的文件，**由宿主的常驻 worker 播放**
       * （WPF MediaPlayer）。页面这边没有它们、也播不了（未打包应用里没有可用的本地文件 URL）。
       * 宿主通道不可用时退化成页内蜂鸣——试听必须"点了有反应"，不能当哑按钮。
       * @param preset 音效 id。
       * @param volume 0..100。
       * @returns 完成后的 Promise（永不 reject）。
       */
      async function previewSound(preset, volume) {
        if (preset === 'none' || !(volume > 0)) return
        try {
          const response = await window.fetch(PREVIEW_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ preset, volume }),
          })
          if (response !== null && typeof response === 'object' && response.ok === true) {
            const payload = await response.json()
            if (payload?.sound === true || payload?.degraded?.includes('sound-skipped')) return
          }
        } catch {
          // 落到下面的本地兜底
        }
        chime.unlock()
        chime.play('completion')
        record('试听：宿主通道不可用，改用页内蜂鸣')
      }

      /**
       * 从宿主读音效清单（自带 + 用户导入）。
       * 失败时**保留上一次的清单**（不清空），避免网络抖动让下拉框突然空掉。
       * @returns 完成后的 Promise（永不 reject）。
       */
      async function loadSounds() {
        try {
          const response = await window.fetch(SOUNDS_ROUTE, { cache: 'no-store' })
          if (response === null || typeof response !== 'object' || response.ok !== true) return
          const payload = await response.json()
          const rows = payload !== null && typeof payload === 'object' && Array.isArray(payload.sounds) ? payload.sounds : []
          const sounds = rows
            .filter((row) => row !== null && typeof row === 'object' && typeof row.id === 'string' && row.id !== '')
            .map((row) => ({
              id: row.id,
              builtin: row.builtin === true,
              size: typeof row.size === 'number' ? row.size : 0,
            }))
          catalogStore.set({ value: { sounds, loaded: true } })
        } catch {
          // 清单是锦上添花：拿不到就用静态回落清单
        }
      }

      /**
       * 导入音效：把用户选的文件读成 base64 交给宿主落盘（页面碰不到磁盘）。
       * @param fileList 文件选择框给的 FileList。
       * @returns 完成后的 Promise（永不 reject），结果是 `{ added, failed }`。
       */
      async function importSounds(fileList) {
        const files = []
        try {
          const count = typeof fileList?.length === 'number' ? fileList.length : 0
          for (let index = 0; index < count; index += 1) {
            const file = fileList[index] ?? fileList.item?.(index)
            if (file !== null && file !== undefined && typeof file.name === 'string') files.push(file)
          }
        } catch {
          return { added: 0, failed: 0 }
        }
        let added = 0
        let failed = 0
        for (const file of files) {
          try {
            const data = await readFileAsBase64(file)
            if (data === null) { failed += 1; continue }
            const response = await window.fetch(SOUNDS_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: file.name, data }),
            })
            if (response !== null && typeof response === 'object' && response.ok === true) added += 1
            else failed += 1
          } catch {
            failed += 1
          }
        }
        await loadSounds()
        record('导入音效：成功 ' + added + ' 个，失败 ' + failed + ' 个')
        return { added, failed }
      }

      /**
       * 把 File 读成纯 base64（去掉 dataURL 前缀）。
       * @param file File 对象。
       * @returns base64 字符串，失败为 null。
       */
      function readFileAsBase64(file) {
        return new Promise((resolve) => {
          try {
            const reader = new window.FileReader()
            reader.onload = () => {
              const text = typeof reader.result === 'string' ? reader.result : ''
              const comma = text.indexOf(',')
              resolve(comma >= 0 ? text.slice(comma + 1) : null)
            }
            reader.onerror = () => resolve(null)
            reader.readAsDataURL(file)
          } catch {
            resolve(null)
          }
        })
      }

      /**
       * 删除一个音效（宿主代删；它会先让 worker 松开文件句柄）。
       * @param id 音效 id。
       * @returns 完成后的 Promise（永不 reject），`true` 表示删掉了。
       */
      async function removeSound(id) {
        try {
          const response = await window.fetch(SOUNDS_ROUTE + '?id=' + encodeURIComponent(id), { method: 'DELETE' })
          const ok = response !== null && typeof response === 'object' && response.ok === true
          if (ok) {
            await loadSounds()
            await loadSettings()
            record('删除音效 ' + id + ' 成功')
          } else {
            const detail = response !== null && typeof response === 'object' ? String(response.status) : '异常响应'
            warnRelay('删除音效失败（HTTP ' + detail + '）')
          }
          return ok
        } catch (error) {
          warnRelay('删除音效失败：' + String(error))
          return false
        }
      }

      /**
       * 读一次宿主配置（不重试），成功即应用。
       * @returns 是否读到。
       */
      async function fetchConfig() {
        const revision = settingsRevision
        try {
          const response = await window.fetch(CONFIG_ROUTE, { cache: 'no-store' })
          if (!response?.ok) return false
          const saved = await response.json()
          if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return false
          if (settingsDisposed) return false
          settingsChannel = 'ready'
          settingsLoaded = true
          // GET 可能早于一次已完成的 PUT；旧读取不得覆盖新保存。
          if (revision === settingsRevision) applySettings({ ...saved, ...pendingPatch })
          if (retryTimer !== null) { window.clearTimeout(retryTimer); retryTimer = null }
          return true
        } catch {
          return false
        }
      }

      /** 冷启动路由可能晚于页面就绪：按 CONFIG_RETRY_MS 退避读取，仅保留一个重试计时器。 */
      async function loadSettings(attempt = 0) {
        if (settingsDisposed) return
        if (retryTimer !== null) { window.clearTimeout(retryTimer); retryTimer = null }
        const ok = await fetchConfig()
        if (ok === true) {
          if (attempt > 0) record('配置读取成功（第 ' + String(attempt + 1) + ' 次尝试，宿主路由就绪了）')
          if (Object.keys(pendingPatch).length > 0) void flushSettings()
          return
        }
        if (settingsDisposed) return
        if (retryTimer !== null) window.clearTimeout(retryTimer)
        if (attempt >= CONFIG_RETRY_MS.length) {
          settingsChannel = 'lost'
          degrade('设置读取失败', '连续 ' + String(attempt + 1) + ' 次都拿不到宿主配置（GET ' + CONFIG_ROUTE
            + '）——本次先用默认配置；**在你读到真实配置之前，改动不会被写回**（免得拿默认值覆盖磁盘）')
          return
        }
        retryTimer = window.setTimeout(() => { void loadSettings(attempt + 1) }, CONFIG_RETRY_MS[attempt])
      }

      /** 即时更新界面，250ms 防抖后串行保存；未确认的字段保留到服务端确认。 */
      function persistSettings(field, value) {
        if (settingsDisposed || !(field in DEFAULT_CONFIG)) return Promise.resolve(false)
        settingsRevision += 1
        pendingPatch[field] = value
        // 内存态立刻更新：设置页要即时响应，不能等落盘。
        applySettings(normalizeConfig(Object.assign({}, settings, pendingPatch)))
        if (writeTimer !== null) window.clearTimeout(writeTimer)
        writeTimer = window.setTimeout(() => { void flushSettings() }, PERSIST_DEBOUNCE_MS)
        return Promise.resolve(true)
      }

      /**
       * 把攒下的改动写回宿主（串行链上排队，永不 reject）。
       * @param keepalive 关闭/隐藏页面时的最后一次写入，用 keepalive 让它有机会发出去。
       * @returns 完成后的 Promise。
       */
      function flushSettings(keepalive = false) {
        if (writeTimer !== null) { window.clearTimeout(writeTimer); writeTimer = null }
        if (writeTask !== null) return writeTask
        if (Object.keys(pendingPatch).length === 0) return Promise.resolve()
        writeTask = (async () => {
          try {
            if (!settingsLoaded && !(await fetchConfig())) throw new Error('宿主配置尚未就绪')
            while (Object.keys(pendingPatch).length > 0) {
              const patch = { ...pendingPatch }
              const next = normalizeConfig({ ...settings, ...patch })
              const response = await window.fetch(CONFIG_ROUTE, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(next),
                keepalive,
              })
              if (!response?.ok) throw new Error('HTTP ' + String(response?.status ?? '无响应'))
              const saved = await response.json()
              if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('无效配置回执')
              // 只清除已确认、期间没有再次变化的字段；旧回执不覆盖最新操作。
              for (const field of Object.keys(patch)) {
                if (pendingPatch[field] === patch[field]) delete pendingPatch[field]
              }
              settingsRevision += 1
              lastSavedAt = Date.now()
              settingsChannel = 'ready'
              applySettings({ ...saved, ...pendingPatch })
            }
          } catch (error) {
            settingsChannel = 'lost'
            // 失败不丢弃脏字段；后续重新聚焦/宿主就绪后可以继续保存。
            degrade('设置未保存', String(error) + '；改动已保留，连接恢复后重试')
          } finally {
            writeTask = null
            flushDiag()
          }
        })()
        return writeTask
      }

      void loadSettings()
      // 音效清单也要在装载时拉一次：设置页的下拉框与「管理音效」都靠它。
      void loadSounds()
      /**
       * 冷启动兜底：装载时也读一次点击标记。
       *
       * 为什么（对应参考实现里的 early-open-url-capture）：点通知时 DSH 可能**根本没在跑**，
       * 激活脚本会把它启动起来；此时页面是"出生就带焦点"，**不会收到 focus 事件**，
       * 只监听 focus 的话这一跳就永远不发生（表现是"冷启动只显示首页，没跳到那个会话"）。
       * 延后 1.2 秒是等宿主路由就绪 —— 太早请求会拿到连接失败。
       */
      if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
        window.setTimeout(() => { void checkClickedNotification() }, 1200)
      }

      // ── 打开会话：官方 uiWorkspace.openSession ───────────────────────────
      let openSession = null
      {
        // 直接取属性（不要用运行时 ctx.inject）：服务必须先在 exports.inject 里声明过。
        const workspace = ctx.uiWorkspace
        if (workspace !== null && typeof workspace === 'object' && typeof workspace.openSession === 'function') {
          openSession = (sessionId) => {
            if (typeof sessionId !== 'string' || sessionId === '') return
            try {
              workspace.openSession(sessionId)
            } catch (error) {
              degrade('打开会话失败', String(error))
            }
          }
        } else {
          degrade('点击卡片回会话不可用', 'ctx.uiWorkspace.openSession 取不到——点卡片仍会聚焦窗口，但不会跳到对应会话')
        }
      }

      const focusAndOpen = (event) => {
        try {
          window.focus()
        } catch {
          // 无焦点能力的环境忽略
        }
        if (openSession !== null && typeof event?.sessionId === 'string' && event.sessionId !== '') {
          openSession(event.sessionId)
        }
      }

      // ── 两个投递通道（浏览器通知兜底已按用户要求整体删除）─────────────────
      const chime = createChime(() => settings)
      const toasts = createToastLayer({
        getConfig: () => settings,
        onOpen: focusAndOpen,
        onDismiss: () => {},
        prefersReducedMotion: () => {
          try {
            return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
          } catch {
            return false
          }
        },
      })

      /**
       * 磁盘可读诊断（**不需要重启宿主进程**）。
       *
       * 渲染进程的 console 我从外部读不到，但 localStorage 会落进磁盘上的 leveldb，
       * 用 PowerShell 就能提取出来（本机 UI 的真实 origin 是 `dsh-app://app`）。
       * 这条通道专治"测试按钮能弹、真实事件不弹"这类悬案——把引擎每一步的判定写进磁盘，
       * 而不是靠猜。诊断自身出错一律吞掉，**绝不影响提醒主流程**。
       */
      const DIAG_KEY = 'dsh-donevoice:status'
      const diag = {
        at: null,
        version: VERSION,
        pageCard: null,
        enabled: null,
        background: null,
        counters: { snapshots: 0, pendings: 0, fired: 0, skippedSame: 0, gated: 0, delivered: 0, cards: 0, relays: 0, relayOk: 0, relayFailed: 0, relayDegraded: 0 },
        pendingChannel: null,
        pendingBoundAt: null,
        pendingReason: null,
        pendingSnapshots: 0,
        pendingLastCount: 0,
        pendingLastSize: 0,
        lastPending: null,
        lastDecision: null,
        /** 最近一次中继结果（宿主原生通知是主信号，它成没成必须一眼看得到）。 */
        lastRelay: null,
        errors: [],
      }
      /**
       * 上一会话留下的诊断快照。
       * F5 会重置内存计数，但"上一次到底怎么判的"必须活下来——否则每次刷新都会把刚刚那次的死因冲掉。
       * （外部读盘这条路不可靠：leveldb 会把记录压缩进 .ldb 块，明文扫不到。）
       */
      /**
       * 上一会话留下的诊断快照读取已随"设置页诊断文本"一起删除：
       * 那个面板是开发期排查用的，普通用户看不懂也占半屏。诊断本身仍然**落盘**到
       * localStorage（`dsh-donevoice:status`），排障时用 DevTools → Application → Local Storage 直接看，
       * 但它不再出现在界面上。
       */

      /** 诊断对象就绪：此后 flushDiag 才真正落盘。 */
      diagReady = true

      /** 把诊断快照写进 localStorage。 */
      function flushDiag() {
        if (diagReady !== true) return
        try {
          diag.at = new Date().toISOString()
          diag.pageCard = settings.pageCard === true
          diag.enabled = settings.enabled
          // 配置同步状态：排查"我改了但重开又变回去"时，先看这三项。
          //  `configLoaded=false` ⇒ 页面用的是默认值（宿主还没就绪），此时**不会**写盘。
          //  `lastSavedAt` ⇒ 最近一次真的落盘的时刻；一直是 null 就说明一次都没写成功。
          diag.configLoaded = settingsLoaded
          diag.lastSavedAt = lastSavedAt === null ? null : new Date(lastSavedAt).toISOString()
          diag.pendingFields = Object.keys(pendingPatch)
          diag.background = isWindowBackground()
          window.localStorage.setItem(DIAG_KEY, JSON.stringify(diag))
        } catch (error) {
          // localStorage 不可用（隐私模式等）就放弃诊断——它绝不能影响提醒。
          // 但"诊断自己坏了"必须留可见痕迹，否则排查时会把"读不到"误读成"没发生"。
          if (diagStorageWarned !== true) {
            diagStorageWarned = true
            console.warn(TAG, '诊断通道不可用（localStorage 写入失败）：' + String(error) + '——提醒不受影响，但外部无法再从磁盘排查')
          }
        }
      }
      /** 改诊断并**立刻落盘**（只用在"有意义的判定"上，避免高频写）。 */
      function noteDiag(mutate) {
        try {
          mutate()
          flushDiag()
        } catch {
          // 同上
        }
      }
      /** 只改计数、不立刻落盘（快照可能很密集）。 */
      function noteDiagQuiet(mutate) {
        try {
          mutate()
        } catch {
          // 同上
        }
      }
      /** 记一条诊断错误（最多留 6 条）。 */
      function noteDiagError(stage, error) {
        noteDiag(() => {
          diag.errors.push({
            at: new Date().toISOString(),
            stage,
            message: String(error !== null && typeof error === 'object' && 'message' in error ? error.message : error),
          })
          if (diag.errors.length > 6) diag.errors.shift()
        })
      }

      /** 上一次提示音的时刻，用于 2 秒最短间隔。 */
      let lastChimeAt = 0

      /**
       * 中继通道：把提醒交给宿主进程，由它弹 **Windows 原生通知**（+ 音效）。
       *
       * 这条通道是"弹到 DSH 外面去"的全部实现；页内卡片只是它的降级替补。
       * onResult 把每一次结果同时写进磁盘诊断（`diag.lastRelay` + 计数）——
       * 用户切走窗口时"到底响了没有"，只能靠这里回答。
       */
      const relay = createRelay({
        onResult: (result) => {
          noteDiag(() => {
            diag.counters.relays += 1
            if (result.ok === true) diag.counters.relayOk += 1
            else diag.counters.relayFailed += 1
            if (result.degraded === true) diag.counters.relayDegraded += 1
            diag.lastRelay = {
              at: result.at,
              route: result.route,
              kind: result.kind,
              dedupKey: result.dedupKey,
              ok: result.ok,
              reason: result.reason,
              latencyMs: result.latencyMs,
              delivered: result.delivered,
              deduped: result.deduped,
              degraded: result.degraded,
            }
          })
        },
      })

      /**
       * 中继失败必须**出声**。
       *
       * 用 console.warn 而不是 console.error：这不是崩溃，是"主通道不可用、已按设计降级"。
       * 但绝不能不吭声——否则用户只会觉得"这插件没动静"，分不清"没装"和"装了但降级了"。
       * @param reason 失败原因（原样来自中继回执）。
       */
      function warnRelay(reason) {
        const line = '宿主原生通知中继失败（' + String(reason) + '）——已降级为 DSH 页内卡片 + 本地音效'
        pushNote(line)
        console.warn(TAG, line)
      }

      /**
       * 推一张页内卡片。做成唯一入口是为了让"卡片层抛异常不能连坐其它通道"这条
       * 真机教训只在一个地方兜住。
       * @param event 引擎事件。
       * @param spec `describeEvent` 的产物。
       * @returns 'shown' | 'threw'。
       */
      function pushCard(event, spec) {
        try {
          toasts.push(event, { title: spec.title, body: spec.body, icon: spec.icon, hint: t('card.openHint') })
          return 'shown'
        } catch (error) {
          noteDiagError('toasts.push', error)
          degrade('页内卡片渲染失败', String(error))
          return 'threw'
        }
      }

      /**
       * 按规则响一声**本地** Web Audio。
       *
       * 只有"宿主没有替我们响"时才会走到这里。宿主已经响过还本地再响一次，就是双响——
       * 用户最直接的感受是"这插件很吵"，所以成功分支绝不允许调用它。
       * @param event 引擎事件。
       * @param background 窗口是否不在前台。
       * @returns 是否真的响了。
       */
      function playChime(event, background) {
        const at = Date.now()
        const sinceLastMs = lastChimeAt === 0 ? undefined : at - lastChimeAt
        if (shouldChime({
          preset: settings.soundPreset,
          volume: settings.volume,
          kind: event.kind,
          background,
          sinceLastMs,
        }) !== true) return false
        lastChimeAt = at
        chime.unlock()
        chime.play(event.kind)
        return true
      }

      /**
       * 投递一条提醒。两条通道的**顺序就是契约**：
       *
       *   1. **宿主原生通知**（`auto` 档的主信号）：`POST /notify`。宿主收到后会问一句
       *      "前台窗口是不是 DSH"——**是**就回 `suppressed:'present'`（你在页面上，静默跳过），
       *      **不是**就真弹系统通知 + 音效。
       *      回执成功（`ok:true`，无论 delivered 非空、`deduped:true` 还是被静默跳过）
       *      ⇒ 页内卡片不补、本地音效不响（避免重复打扰）。
       *   2. **页内卡片**（`toast` 档唯一信号 / 降级兜底）：默认档一张都不预先弹；
       *      只有中继真的失败、没别的信号了才补一张，否则用户什么都收不到。
       *   3. **本地 Web Audio**（降级时的可听信号）。
       *
       * ⚠️ 顺序 + 隔离（上一版真机血泪）：卡片层曾在追加完 DOM 之后抛异常，把整个 deliver
       * 掐断，后面的通知根本没机会执行（人眼却看得见卡片，于是诊断计数恒为 0）。所以每一步
       * 都单独兜住，且**主信号先行**。
       * @param event 引擎事件。
       */
      function deliver(event) {
        if (event === null || typeof event !== 'object') return
        {
          const blocked = settings.enabled !== true
            ? '总开关关闭'
            : (event.subagent === true ? '子智能体不提醒' : null)
          if (blocked !== null) {
            noteDiag(() => {
              diag.counters.gated += 1
              diag.lastDecision = { at: new Date().toISOString(), kind: event.kind, blocked }
            })
            return
          }
        }
        const localeId = currentLocale()
        const spec = describeEvent(event, localeId)
        const background = isWindowBackground()
        // ★ 投递策略是**固定行为**，没有档位可选（用户定稿）：
        //   · 你不在 DSH 页面上 ⇒ 系统通知 + 音效，强制；
        //   · 你在 DSH 页面上   ⇒ 永不弹系统通知；页面内是否补卡片，看唯一的可选开关 pageCard。
        //   "你在不在"**一律由宿主判断**（它问 Windows 前台窗口是谁）：
        //   宿主传感器不依赖页面（页面没开/被冻结时事件照样从宿主侧来），页面这侧判会导致同一事件两套结论。
        //   所以这里永远中继，拿回执里的 `suppressed:'present'` 再决定页面内的动作。
        // 页内卡片**不预先弹**：只有宿主回执说"你在页面上"（且 pageCard 开着）或中继失败降级时才弹。
        const dedupKey = dedupKeyFor(event)


        /**
         * 记录一次投递决策（含中继结果）。每次投递只写一次，
         * 避免"卡片那条路先写、中继回执后写"把计数翻倍。
         */
        const commitDecision = (patch) => {
          noteDiag(() => {
            diag.counters.delivered += 1
            if (patch.cardResult === 'shown') diag.counters.cards += 1
            diag.lastDecision = Object.assign({
              at: new Date().toISOString(),
              kind: event.kind,
              title: spec.title,
              background,
              pageCard: settings.pageCard === true,
              dedupKey,
            }, patch)
          })
        }

        const payload = relayPayload(event, spec, settings, localeId)

        /**
         * 中继回执到齐后：
         *   · `suppressed:'present'`（你在 DSH 页面上）⇒ 系统通知**有意不弹**。
         *     此时页面内只做一件事：`pageCard` 开着就弹卡片（音效没有开关，页面上保持安静）。
         *     **音效由宿主播**（回执里的 `soundPlayed` 告诉我们播没播），页面不重复响。
         *   · `ok` 且不 suppressed（你走开了）⇒ 宿主已经弹了系统通知 + 音效，页面什么都不做。
         *   · 失败 ⇒ 降级：页内卡片 + 本地音（否则你什么都收不到）。
         * 浏览器通知兜底已按用户要求整体删除。
         */
        const settle = (result) => {
          if (result !== null && typeof result === 'object' && result.ok === true) {
            const stayedQuiet = result.suppressed === 'present'
            if (stayedQuiet !== true) {
              // 你走开了：宿主已弹系统通知 + 音效，页面不补卡片、不响。
              commitDecision({
                relayWanted: true,
                relay: 'ok',
                relayReason: null,
                relayLatencyMs: result.latencyMs,
                relayDelivered: result.delivered,
                relayDeduped: result.deduped === true,
                cardResult: null,
                degraded: false,
                chimed: false,
              })
              record(event.kind + ' → ' + spec.title + ' | 你不在页面上 → 宿主系统通知 ok（' + String(result.latencyMs) + 'ms'
                + (result.deduped === true ? '，宿主侧已弹过' : '') + '）')
              return
            }
            // 你在页面上：系统通知按设计不弹；页面内按两个开关来。
            const inPageCard = settings.pageCard === true ? pushCard(event, spec) : null
            // 宿主已经播过就不重复响（回执里如实带回 soundPlayed）。
            // 页内音效没有开关了 ⇒ 你在页面上时保持安静（宿主也不再"只播音效"）。
            const chimed = false
            commitDecision({
              relayWanted: true,
              relay: 'suppressed',
              relayReason: 'present',
              relayLatencyMs: result.latencyMs,
              relayDelivered: [],
              relayDeduped: false,
              cardResult: inPageCard,
              degraded: false,
              chimed,
            })
            record(event.kind + ' → ' + spec.title + ' | 你在 DSH 页面上 → 不弹系统通知'
              + (inPageCard === 'shown' ? ' + 页内卡片' : '')
              + (result.soundPlayed === true ? ' + 宿主音效' : (chimed ? ' + 本地音' : '')))
            return
          }
          const reason = result !== null && typeof result === 'object' && result.reason !== null && result.reason !== undefined
            ? String(result.reason)
            : '未知原因'
          warnRelay(reason)
          /**
           * 降级路径：中继不通 ⇒ 页面自己兜底（否则你什么都收不到）。
           *
           * ⚠️ 但**在页面上**要守住用户定稿的那条规则："我在工作状态，能看到任务，提醒多余"——
           * 你正看着 DSH 且没开「页内卡片」时，降级也不许弹卡片。
           * 用户报的"任务失败后在 DSH 页面跳出两个提醒"就是这里漏了这一层：
           * 一次失败派生两条中继（失败 + 完成），两条都在宿主的冷启动上超时 ⇒ 两张降级卡片。
           */
          const onPage = isWindowBackground() !== true
          const allowCard = onPage !== true || settings.pageCard === true
          const degradedCard = allowCard ? pushCard(event, spec) : null
          // 同理：页面上没开「页内音效」时不补本地音（走开时宿主那条是强制的，不受此限）。
          const chimed = onPage === true ? false : playChime(event, background)
          commitDecision({
            relayWanted: true,
            relay: 'failed',
            relayReason: reason + (allowCard ? '' : '（你在页面上且未开页内卡片 ⇒ 不补卡片）'),
            relayLatencyMs: result !== null && typeof result === 'object' ? result.latencyMs : undefined,
            relayDelivered: [],
            relayDeduped: false,
            cardResult: degradedCard,
            degraded: true,
            chimed,
          })
          record(event.kind + ' → ' + spec.title + ' | 中继失败降级：页内卡片' + (chimed ? ' + 本地音' : '') + '（' + reason + '）')
        }

        try {
          // 绝不 await：提醒主流程不能被网络往返阻塞；回执到了再决定降级。
          void relay.send(payload).then(settle, (error) => {
            settle({ ok: false, reason: '中继 Promise 异常：' + String(error), latencyMs: 0, delivered: [], deduped: false })
          })
        } catch (error) {
          settle({ ok: false, reason: '中继调用抛异常：' + String(error), latencyMs: 0, delivered: [], deduped: false })
        }
      }

      // ── 引擎与事件接线 ───────────────────────────────────────────────────
      const engine = createReminderEngine()
      const handle = (event) => {
        if (event !== null) deliver(event)
      }

      /** 从会话列表快照里读出会话行（真实形状见文件头说明）。 */
      function listRows(snapshot) {
        const rows = []
        if (snapshot === null || typeof snapshot !== 'object') return rows
        const ids = Array.isArray(snapshot.ids) ? snapshot.ids : Object.keys(snapshot.byId ?? {})
        const byId = snapshot.byId !== null && typeof snapshot.byId === 'object' ? snapshot.byId : {}
        for (const id of ids) {
          const row = byId[id]
          if (row === null || typeof row !== 'object') continue
          rows.push({
            id: typeof row.id === 'string' ? row.id : String(id),
            running: row.running === true,
            displayTitle: typeof row.displayTitle === 'string' ? row.displayTitle : '',
            origin: typeof row.origin === 'string' ? row.origin : undefined,
          })
        }
        return rows
      }

      /** 会话列表来源（标题 + 兜底边沿通道）。 */
      let listSource = null
      try {
        const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
        const candidate = sessions !== null && typeof sessions === 'object' ? sessions.list : undefined
        if (candidate !== null && typeof candidate === 'object' && typeof candidate.getSnapshot === 'function') {
          listSource = candidate
        } else {
          degrade('会话列表不可用', 'ctx.sessions.list 缺失；完成提醒退化为只依赖 api-session/status 事件，标题退化为短 id')
        }
      } catch (error) {
        degrade('会话列表读取异常', String(error))
      }

      const readRows = () => {
        if (listSource === null) return []
        try {
          return listRows(listSource.getSnapshot())
        } catch (error) {
          degrade('会话列表快照读取失败', String(error))
          return []
        }
      }

      const reconcile = () => {
        const rows = readRows()
        for (const row of rows) engine.observeRow(row)
        for (const row of rows) handle(engine.status(row.id, row.running))
      }

      // 基线：先吸收"页面打开这一刻已经存在"的会话，避免历史刷屏。
      engine.seed(readRows())

      if (listSource !== null) {
        ctx.effect(() => {
          try {
            return listSource.subscribe(reconcile)
          } catch (error) {
            degrade('会话列表订阅失败', String(error))
            return () => {}
          }
        }, 'donevoice: session list reconcile')
      }

      // ── 官方转发的宿主事件（键集 = API_REMOTE_FORWARDED_EVENTS）─────────────
      ctx.effect(() => {
        const offs = []
        const on = (name, handler) => {
          try {
            const off = ctx.remote.$on(name, (a, b) => {
              // 远端通道到底有没有交货，必须能从诊断里看出来（真机上它从没交货过）。
              noteDiag(() => {
                diag.remoteCalls = (diag.remoteCalls === undefined ? 0 : diag.remoteCalls) + 1
                diag.lastRemote = { name, at: new Date().toISOString() }
              })
              return handler(a, b)
            })
            if (typeof off === 'function') offs.push(off)
          } catch (error) {
            degrade('订阅 ' + name + ' 失败', String(error))
          }
        }

        on('api-session/status', (sessionId, running) => {
          handle(engine.status(sessionId, running))
        })
        on('api-session/added', (summary) => {
          handle(engine.added(summary))
        })
        on('api-session/error', (sessionId, message) => {
          handle(engine.failure(sessionId, message))
        })
        on('api-session/removed', () => {
          // 会话离开注册表：不需要提醒，交给列表通道自行收敛。
        })

        // ── 为什么这里**没有** approval/request 与 user-questions/request ──────
        //
        // 这两个是 waterfall 事件，直觉上"订阅一下就能知道有人在等审批"。**这是个陷阱**：
        //
        //   1. cordis 的 waterfall 按注册顺序串起来，`next()` 才会把控制权交给下一个监听器；
        //   2. 官方 `dsh-client-ui-approval` 在能显示审批 UI 的路径上**不调用 next()**——它
        //      `await` 用户作答，并把答案直接当作 waterfall 的返回值（见
        //      `dsh-client-ui-approval/lib/client.js` 的 answerApproval 与 PendingApproval）；
        //      `dsh-client-ui-user-questions` 同形。严格说仍有 3 处例外会调 next()，但都在
        //      "域被拆除"的兜底窗口（卸载/HMR/dispose）或前台 claim 已完成时——对提醒毫无价值，
        //      详见 evidence/fact-recheck.md §D；
        //   3. 本插件是第三方 `insert` 条目，注册顺序排在 dsh-web-app 之后 = **最内层**；
        //   4. 而 `ctx.remote.$on` 不透传任何 options，插件**没有办法把自己插到前面**。
        //
        // 结论：把提醒挂在 approval/request 上，在真机组合里那个监听器**在正常路径上一次都不会被调用**——
        // 现象与"插件没装"一模一样。这正是旧版 dsh-reminder 的同一种死法，只是换了个位置。
        //
        // 正确做法在下面：读官方聚合好的 `ctx.uiSession.sessionStatus`。
        // 附带好处：本插件**完全不碰 waterfall**，结构上不可能让审批卡住。

        return () => {
          for (const off of offs) {
            try { off() } catch {}
          }
        }
      }, 'donevoice: forwarded host events')

      // ── 等待审批 / 等待回答：读官方聚合状态（顺序无关、零副作用）────────────
      //
      // `ctx.uiSession` 是 `dsh-client-ui-session` 用 `super(ctx, 'uiSession')` 注册的服务实例，
      // 它的 `sessionStatus` 是公开的根快照源：
      //     getSnapshot(): Map<sessionId, { running, pendingInteraction, completionUnread }>
      // 而 `pendingInteraction` 就是 ui-approval / ui-user-questions 通过
      // `uiSession.registerPendingInteraction()` 登记进来的领域对象：
      //     PendingApproval : { sessionId, kind:'approval', key, toolName, callId, reason, displayReason, answerable }
      //     PendingQuestion : { questions, kind:'question'|'plan-review', key }
      // 两者都自带稳定且唯一的 `key`——天然就是去重身份。
      //
      // 这条通道只读一个 Map，不参与任何决策，因此无论顺序如何都不会影响审批本身。
      const pendingSeen = new Map()
      /** 待交互通道的状态：'absent' 服务没来 / 'ready' 已订阅 / 'lost' 形状不符已出声。 */
      let pendingChannel = 'absent'
      /** 形状异常只报一次，避免每次快照都刷屏。 */
      let pendingShapeWarned = false

      /**
       * 快照形状不符合预期时出声一次。
       * 静默跳过是最危险的选择：官方一旦改了形状，审批提醒会**彻底消失且毫无提示**。
       * @param why 具体哪里不符。
       */
      function warnPendingShape(why) {
        if (pendingShapeWarned) return
        pendingShapeWarned = true
        degrade('等待审批/回答的提醒数据形状异常', why + '——审批/提问提醒可能不再生效（完成与失败不受影响）')
      }

      /**
       * 把一个待交互领域对象翻译成引擎事件。
       * @param sessionId 会话 id。
       * @param interaction PendingApproval / PendingQuestion 实例。
       * @returns 事件或 null。
       */
      function eventFromPending(sessionId, interaction) {
        const kind = typeof interaction.kind === 'string' ? interaction.kind : ''
        // key 是官方给的唯一身份；缺失时（防御）用 kind+工具名兜底。
        const identity = typeof interaction.key === 'string' && interaction.key !== ''
          ? interaction.key
          : kind + '|' + String(interaction.toolName ?? '')
        if (kind === 'approval') {
          return engine.approval({
            toolName: interaction.toolName,
            callId: typeof interaction.callId === 'string' && interaction.callId !== '' ? interaction.callId : identity,
            reason: interaction.reason,
            displayReason: interaction.displayReason,
          }, sessionId)
        }
        if (kind === 'question' || kind === 'plan-review') {
          return engine.question({
            questions: interaction.questions,
            wait: { callId: identity },
          }, sessionId)
        }
        return null
      }

      /** 每个会话上一次见到的运行状态。 */
      const runningSeen = new Map()

      /**
       * 从 sessionStatus 快照里检测 `running` 边沿 —— **完成提醒的第二条（也是主力）通道**。
       *
       * 为什么要这条：真机磁盘诊断显示，远端事件 `api-session/status` **从来没有交货过**
       * （`counters.delivered` 恒为 0、`gated` 恒为 0 —— 连"被开关拦下"都没发生过，
       * 说明事件根本没到引擎）。而测试按钮能弹桌面通知 ⇒ **投递层是好的，死在检测层**。
       *
       * 而 `sessionStatus` 是**已证实能交货**的通道（`pendingChannel: "ready"`、快照持续到达、
       * 里面有全部 38 个会话），它带 `running`，做完成/运行边沿检测足够了。
       *
       * 两条通道并存，靠引擎的周期号去重（单调递增），**不会双弹**。
       * @param statusMap `Map<sessionId, {running?, pendingInteraction?}>`。
       */
      function observeRunning(statusMap) {
        // 形状不对时交给 ownPendingStatus 统一出声，这里静默跳过（否则会抛在它前面，把警告盖掉）。
        if (typeof Map !== 'function' || (statusMap instanceof Map) !== true) return
        for (const entry of statusMap) {
          const sessionId = entry[0]
          const record = entry[1]
          const running = record !== null && typeof record === 'object' && record.running === true
          const previous = runningSeen.get(sessionId)
          runningSeen.set(sessionId, running)
          // 第一次见到：只把状态同步给引擎（**不提醒**），避免页面刚打开就为历史会话补弹。
          // 同步是必须的——否则引擎永远不知道这个会话"正在运行"，后面的收尾边沿就丢了。
          if (previous === undefined) {
            engine.status(sessionId, running)
            continue
          }
          if (previous === running) continue
          handle(engine.status(sessionId, running))
        }
      }

      /**
       * 记录快照观测：第一次、待交互数量变化、或距上次落盘超过 1.5 秒时写盘。
       * 这样即使"一个 pending 都没见过"，外部也能看出订阅到底有没有交货。
       * @param statusMap `Map<sessionId, record>`。
       */
      let snapshotFlushAt = 0
      function observeSnapshot(statusMap) {
        let pendingCount = 0
        try {
          for (const record of statusMap.values()) {
            if (record !== null && typeof record === 'object' && record.pendingInteraction !== undefined && record.pendingInteraction !== null) {
              pendingCount += 1
            }
          }
        } catch {
          // 形状异常交给 ownPendingStatus 的分支出声
        }
        const now = Date.now()
        const interesting = diag.pendingSnapshots === 0 || pendingCount !== diag.pendingLastCount || now - snapshotFlushAt > 1500
        if (interesting) snapshotFlushAt = now
        const mutate = () => {
          diag.pendingSnapshots += 1
          diag.pendingLastCount = pendingCount
          diag.pendingLastSize = statusMap.size
          diag.counters.snapshots += 1
        }
        if (interesting) noteDiag(mutate)
        else noteDiagQuiet(mutate)
      }

      /**
       * 对 sessionStatus 快照做边沿检测：只在某会话的待交互身份**发生变化**时提醒一次。
       * @param statusMap `Map<sessionId, {pendingInteraction?}>`。
       */
      function ownPendingStatus(statusMap) {
        if (typeof Map !== 'function' || (statusMap instanceof Map) !== true) {
          warnPendingShape('sessionStatus 的快照不是 Map')
          return
        }
        observeSnapshot(statusMap)
        for (const entry of statusMap) {
          const sessionId = entry[0]
          const record = entry[1]
          if (record === null || typeof record !== 'object') {
            warnPendingShape('sessionStatus 的记录不是对象')
            pendingSeen.delete(sessionId)
            continue
          }
          const interaction = record.pendingInteraction
          if (interaction === undefined || interaction === null) {
            pendingSeen.delete(sessionId)
            continue
          }
          const identity = typeof interaction.key === 'string' && interaction.key !== ''
            ? interaction.key
            : String(interaction.kind ?? 'pending') + '|' + String(interaction.toolName ?? '')
          if (pendingSeen.get(sessionId) === identity) {
            noteDiag(() => {
              diag.counters.skippedSame += 1
              diag.lastPending = {
                at: new Date().toISOString(),
                sessionId,
                identity,
                kind: String(interaction.kind),
                fired: false,
                reason: '同一身份已提醒过',
              }
            })
            continue
          }
          pendingSeen.set(sessionId, identity)
          noteDiag(() => {
            diag.counters.pendings += 1
            diag.counters.fired += 1
            diag.lastPending = {
              at: new Date().toISOString(),
              sessionId,
              identity,
              kind: String(interaction.kind),
              fired: true,
            }
          })
          try {
            handle(eventFromPending(sessionId, interaction))
          } catch (error) {
            degrade('待交互提醒处理失败', String(error))
            noteDiagError('handle(pending)', error)
          }
        }
        // 已被回答 / 撤回的会话从记忆里清掉，下一次新的请求才能再提醒。
        for (const sessionId of [...pendingSeen.keys()]) {
          if (statusMap.has(sessionId) !== true) pendingSeen.delete(sessionId)
        }
      }

      /**
       * 绑定「等待审批 / 等待回答」通道。
       *
       * ⚠️ 必须**直接取属性** `ctx.uiSession`，不能用运行时 `ctx.inject(['uiSession'], …)`：
       * 插件能看到哪些服务由 `exports.inject` 声明决定，**没声明的服务运行时注入永远不会就绪**。
       * 这正是本插件第一版的真实故障——完成/失败提醒正常（`remote` 声明过）、设置页正常
       * （`slots` 声明过），而审批/提问两类提醒**从装上到修复前一次都没响过**，
       * 引擎计数始终为 0（靠磁盘诊断才查出来）。
       */
      function bindPendingChannel(service) {
        try {
          const status = service !== null && typeof service === 'object' ? service.sessionStatus : undefined
          if (status === null || typeof status !== 'object' || typeof status.getSnapshot !== 'function' || typeof status.subscribe !== 'function') {
            pendingChannel = 'lost'
            noteDiag(() => {
              diag.pendingChannel = 'lost'
              diag.pendingReason = 'ctx.uiSession.sessionStatus 不存在或形状不符'
            })
            degrade('等待审批/回答的提醒不可用', 'ctx.uiSession.sessionStatus 不存在或形状不符——审批与提问两类提醒不会响（完成与失败不受影响）')
            return
          }
          ctx.effect(() => {
            const tick = () => {
              const snapshot = status.getSnapshot()
              observeRunning(snapshot)
              ownPendingStatus(snapshot)
            }
            const off = status.subscribe(tick)
            tick()
            return () => { try { off() } catch {} }
          }, 'donevoice: pending interaction status')
          pendingChannel = 'ready'
          noteDiag(() => {
            diag.pendingChannel = 'ready'
            diag.pendingBoundAt = new Date().toISOString()
          })
        } catch (error) {
          pendingChannel = 'lost'
          noteDiag(() => {
            diag.pendingChannel = 'lost'
            diag.pendingReason = String(error)
          })
          degrade('等待审批/回答的提醒装配失败', String(error))
        }
      }
      bindPendingChannel(ctx.uiSession)

      // 重连：重新建立基线（不补弹断线期间的历史），并重读配置。
      ctx.on('connection/reset', () => {
        engine.rebaseline(readRows())
        void loadSettings()
        record('connection/reset → 重新建立基线并重读配置')
      })

      // ── 音频解锁（Chrome 自动播放策略）+ 配置重同步 ──────────────────────
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        const gesture = () => {
          chime.unlock()
          window.removeEventListener('pointerdown', gesture)
          window.removeEventListener('keydown', gesture)
        }
        window.addEventListener('pointerdown', gesture)
        window.addEventListener('keydown', gesture)

        // 配置只在这里读一次；但"外部改动"（另一个窗口改的、或直接编辑
        // $DSH_HOME/donevoice/config.json）应当在你切回本窗口时生效。
        // 带节流，避免频繁切窗口造成无谓请求。
        let lastResync = 0
        const resync = () => {
          // ★ 点击检查**不受节流限制**，而且立刻 + 延迟各来一次：
          //   真机踩过的竞态——激活脚本"先抢焦点、后写标记"时，页面在拿到焦点那一刻读到的还是空；
          //   而脚本现在已经改成先写标记，这里再补一发延迟重试，两头都堵上。
          void checkClickedNotification()
          window.setTimeout(() => { void checkClickedNotification() }, 800)
          const now = Date.now()
          if (now - lastResync < RESYNC_MIN_GAP_MS) return
          lastResync = now
          void loadSettings()
          // 音效可能刚被导入/删除（甚至在别的窗口里改的）⇒ 清单跟着刷一次。
          void loadSounds()
        }
        window.addEventListener('focus', resync)
        /**
         * 关页/隐藏页前把攒着的改动尽力写出去（`keepalive` 让请求在页面卸载后仍可能送达）。
         * 为什么需要：拖动滑条后立刻关窗（250ms 防抖还没到点）时，
         * 那笔改动就丢了 —— 用户看到的就是"我明明调过，重开又变回去"。
         */
        const flushOnLeave = () => { void flushSettings(true) }
        window.addEventListener('pagehide', flushOnLeave)
        window.addEventListener('beforeunload', flushOnLeave)
        const onVisibilityChange = () => {
          if (document.visibilityState === 'hidden') flushOnLeave()
        }
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisibilityChange)
        }
        ctx.effect(() => () => {
          try {
            window.removeEventListener('focus', resync)
            window.removeEventListener('pagehide', flushOnLeave)
            window.removeEventListener('beforeunload', flushOnLeave)
            window.removeEventListener('pointerdown', gesture)
            window.removeEventListener('keydown', gesture)
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange)
            void flushSettings(true)
            settingsDisposed = true
            if (retryTimer !== null) window.clearTimeout(retryTimer)
            if (writeTimer !== null) window.clearTimeout(writeTimer)
          } catch {
            // 清理失败不影响插件
          }
        }, 'donevoice: settings focus resync')
      }

      // ── 设置页 ───────────────────────────────────────────────────────────
      const face = () => ({
        hooks: { settings: settingsStore, catalog: catalogStore },
        channelLost: settingsChannel === 'lost',
        update: (field, value) => { void persistSettings(field, value) },
        // 试听：声音文件在插件目录里、只有宿主播得了 ⇒ 请宿主播（见 previewSound）。
        preview: (preset) => { void previewSound(preset, settings.volume) },
        // 音效管理：导入 / 删除都由宿主代做（文件在磁盘上，页面碰不到）。
        addSounds: (fileList) => importSounds(fileList),
        removeSound: (id) => removeSound(id),
      })

      ctx.slots.inject('settings.section', () => {
        // 先注册成功再置位：register 抛异常时这个标记必须保持 false，看门狗才会如实报告。
        const dispose = ctx.slots.register({
          name: 'settings.section',
          id: HOST_ENTRY_ID,
          order: 60,
          label: () => t('nav'),
          locale: NS,
          inject: face,
        }, DoneVoiceSection)
        sectionRegistered = true
        return dispose
      })

      // ── 能力看门狗 ───────────────────────────────────────────────────────
      // 五条会"安静地不生效"的路径（设置页槽位没声明 / uiWorkspace 没来 / 配置路由没通 /
      // uiSession 没来 / **宿主中继通道一次都没成功过**）不是崩溃，但外观与"插件没装"完全一样。
      // 到点仍然缺席就出声，把差别说清楚。
      ctx.effect(() => watchdog(WATCHDOG_MS, () => {
        // 中继通道的判据要防"误报"：从没提醒过 = 还没被证伪，不能报降级；
        // 试过至少一次且成功过 = 好；试过但全失败 = 主信号没生效，必须报。
        const relayStats = relay.stats()
        for (const line of degradationReport({
          section: sectionRegistered,
          openSession: openSession !== null,
          // 'lost' 已经就"设置读写失败"出过声；只有 'absent'（始终没通上）才需要看门狗兜。
          form: settingsChannel !== 'absent',
          // 'lost' 表示已经就形状问题出过声；只有 'absent'（服务始终没出现）才需要看门狗兜。
          pending: pendingChannel !== 'absent',
          relay: relayStats.attempts === 0 || relayStats.ok > 0,
        })) {
          degrade(line.what, line.why)
        }
      }), 'donevoice: capability watchdog')

      publishDebug({
        toasts: () => toasts.count(),
        delivered: () => debug.events.length,
        diag: () => JSON.parse(JSON.stringify(diag)),
      })
      // 插件一装载就把诊断落盘一次：这样外部一眼就知道"新代码有没有跑起来"。
      noteDiag(() => { diag.loadedAt = new Date().toISOString() })
      log('loaded v' + VERSION + '; sessions.list=' + (listSource === null ? 'absent' : 'ok'))
    }

    exports.apply = apply
    exports.inject = inject
    exports.NS = NS
    exports.version = VERSION

    return module.exports
  },
})
