/**
 * dsh-donevoice 宿主半区（Host half）。
 *
 * ## 这个宿主进程到底负责什么（2026-10-01 之后的版本）
 *
 * 用户的原始诉求只有一句：**提醒必须弹到 DSH 外面去**。
 * "在 DSH 页面里弹一张卡片" 被点名是脱裤子放屁 —— 因为那只在你恰好看着那个页面时才有意义，
 * 而且还要浏览器通知权限、页面被冻结还会停。所以真正的投递必须由**宿主进程**完成：
 *
 *  1. **Windows 原生通知**（`win-native.js`）：直接调系统通知中心，DSH 窗口在不在前台、
 *     页面开不开、标签冻不冻，都不影响它；
 *  2. **宿主侧事件传感器**（`host-sensors.js`）：完成 / 审批 / 提问 / 失败四类触发**在宿主里检测**，
 *     不依赖任何页面存在（页面只是"顺便也能收到"的第二条通道）；
 *  3. **客户端中继**（`client.js` → `POST /notify`）：页面开着时，页面自己检测到的事件也交给宿主来弹，
 *     跨通道去重保证同一件事只响一次；
 *  4. **配置持久化**（`$DSH_HOME/donevoice/config.json`，`*.tmp` + `rename` 原子写）；
 *  5. **只读探针**（`GET /health.json`）：一眼看清"宿主活着没、原生通道可用没、传感器收了多少事件"。
 *
 * ## 一条用真机换来的硬约束：**宿主半区不许 import 任何裸包名**
 *
 * 本插件第一版这里写的是 `import z from '@deepseek-ai/schemastery'`（照 DSH 源码里
 * `Config` + `.volatile()` 的官方写法来的）。装进 profile 之后当场验证：
 *
 *   node -e "import('@deepseek-ai/schemastery')"      # 在插件目录里跑
 *   → ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'
 *
 * 原因很朴素：Node 的 ESM 解析从**本文件所在目录**往上找 `node_modules`，而
 * profile 的 `node_modules` 里根本没有 `@deepseek-ai` 作用域（只有 .pnpm 与几个插件）。
 * 静态 import 一旦解析失败就是**链接期错误**——整个宿主条目加载失败，
 * 也就是旧版 dsh-reminder「装上去像没装」的同一种死法，只是换了个位置。
 *
 * 旁证：本机已经跑起来的第三方插件（`dsh-status-rotator@0.29.0`、`dsh-prompt-studio`）
 * 的宿主半区**只 import `node:*` 内置模块**，配置各自落在 `$DSH_HOME/<id>/config.json`。
 * 本项目照这个已被验证可行的组合来做，并用 `test/validate.mjs` 静态钉死。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { DEFAULT_CONFIG, isSoundId, normalizeConfig } from './host-config.js'
import { createHostSensors } from './host-sensors.js'
import { MAX_SOUND_BYTES, SOUND_EXTS, SOUND_FILES, clickMarkerFile, clampVolume, createNativeNotifier, listSounds, soundDir, soundFileFor, soundIdFrom, userSoundDir } from './win-native.js'

/** Cordis 插件名（同时也是 Loader 条目 name 与客户端 bundle 握手 id）。 */
export const name = 'donevoice'

/** 版本（与 package.json / client.js 对齐，由 test/validate.mjs 钉住）。 */
export const version = '1.1.0'

/** 配置读写路由。 */
export const CONFIG_PATH = '/plugins/dsh-donevoice/config.json'

/** 只读探针路由。 */
export const HEALTH_PATH = '/plugins/dsh-donevoice/health.json'

/**
 * 客户端事件中继路由。
 *
 * 语义：**"页面看到了这件事，请你在外面弹一下"**。宿主只做投递与去重，不信任正文之外的任何东西。
 */
export const NOTIFY_PATH = '/plugins/dsh-donevoice/notify'

/**
 * 设置页「试听」路由。
 *
 * 存在理由：提示音是**插件自带的文件**（`sounds/*.mp3`），只有宿主的常驻 worker 播得了
 * （WPF MediaPlayer）。页面既拿不到那些文件也没有可用的本地文件 URL，所以试听必须请宿主代播。
 * 语义上它是"只播音效、不弹通知"，与 `notify` 的 `soundOnly` 完全同路，因此不重复实现播放逻辑。
 */
export const PREVIEW_PATH = '/plugins/dsh-donevoice/preview'

/**
 * 音效管理路由（`/plugins/dsh-donevoice/sounds.json`）：
 *   · `GET`    → 列出实际可用的音效（自带 + 用户导入）
 *   · `POST`   → 导入一个音效（`{ name, data: <base64> }`），落到用户目录
 *   · `DELETE` → 删除一个音效（`?id=<id>`）
 *
 * 为什么要有它：用户要能自由收录自己的音效、也能删掉不要的。
 * 音效文件在磁盘上，页面碰不到，所以导入/删除都必须由宿主代做。
 * 落盘位置分两类：**自带的属于插件包**（更新会覆盖），**导入的属于用户数据**（放在 `$DSH_HOME`，升级不动）。
 */
export const SOUNDS_PATH = '/plugins/dsh-donevoice/sounds.json'

/**
 * 配置写入体上限（64 KiB）：配置文档不该比这更大。 */
export const MAX_BODY_BYTES = 64 * 1024

/**
 * 中继/测试请求体上限（8 KiB）。
 * 一条通知的正文就是几百字节，给 8 KiB 已经很宽松；上限存在的意义是别让人拿它当上传口。
 */
export const MAX_NOTIFY_BYTES = 8 * 1024

/** 读取缓存时长：避免每次 GET 都碰磁盘，又保证外部改动能较快被看到。 */
export const CACHE_MS = 2000

/**
 * 离开宽限期（毫秒）：被"你在页面上"静默后，隔这么久复核一次，其间切走就补发。
 * 取值理由见 `scheduleLeaveRecheck`。
 */
export const LEAVE_GRACE_MS = 1800

/**
 * 跨通道去重窗口（毫秒）。
 *
 * 为什么需要它：同一件"完成"会有两条独立通道同时到达宿主 ——
 *  ① 宿主传感器读 `api-session/status` / `session/event`；
 *  ② 页面自己的引擎读到同样的信号后中继过来。
 * 两条通道的**去重键不一样**（一个是 turn 号，一个是周期号），只比键会漏，于是会响两次。
 * 所以除了精确键，还按 `kind|sessionId` 做时间窗去重：2.5 秒内同一会话同一类事件只投递一次。
 */
export const DEDUP_WINDOW_MS = 2500

/** 归档日志保留条数（探针里能看到的最近投递记录）。 */
export const DELIVERY_LOG_SIZE = 20

/** 四类提醒（顺序即设置页与测试按钮的顺序）。 */
export const KINDS = Object.freeze(['completion', 'approval', 'question', 'failure'])

/** 宿主半区没有硬性服务依赖：webServer / settings 都走可选注入，缺了也要能加载。 */
export const inject = []

/**
 * 统一日志出口：所有宿主侧消息都带 `[donevoice]` 前缀，方便在 DSH 日志里一眼捞出来。
 * @param message - 要打印的内容。
 */
function log(message) {
  console.info('[donevoice] ' + String(message))
}

/**
 * DSH 的 home 目录。
 * @returns 绝对路径。`DSH_HOME` 环境变量优先，便于测试与多实例。
 */
function homeDir() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/**
 * 配置文件路径。
 * @returns `$DSH_HOME/donevoice/config.json`。
 */
export function configFile() {
  return join(homeDir(), name, 'config.json')
}

/** 读取缓存：按**文件路径**作键，`DSH_HOME` 变化时不会读到旧值。 */
let cache = { key: '', at: 0, value: null }

/**
 * 读取生效配置（带 2 秒缓存）。文件缺失或损坏一律回落默认值，**绝不抛异常**。
 * @returns 归一化后的完整配置。
 */
export function readConfig() {
  const file = configFile()
  const now = Date.now()
  if (cache.value !== null && cache.key === file && now - cache.at < CACHE_MS) return cache.value
  let raw = {}
  try {
    const text = readFileSync(file, 'utf8')
    const parsed = JSON.parse(text)
    raw = parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    // ENOENT 是首次运行的正常情况；其它错误要说出来，但仍然回落默认值。
    if (error === null || typeof error !== 'object' || error.code !== 'ENOENT') {
      console.warn('[donevoice] 配置文件读取失败，回落默认值 — ' + String(error))
    }
  }
  const value = normalizeConfig(raw)
  cache = { key: file, at: now, value }
  return value
}

/**
 * 原子写入配置（`*.tmp` + `rename`），并刷新缓存。
 * @param input 任意来源的候选配置（会被归一化，非法字段丢弃）。
 * @returns 落盘后的完整配置。
 */
export function writeConfig(input) {
  const next = normalizeConfig(input)
  const file = configFile()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
  cache = { key: file, at: Date.now(), value: next }
  return next
}

// ─────────────────────────────────────────────────────────────────────────────
// 文案（宿主自己产生通知时用；客户端中继过来的正文已经是本地化过的，直接用）
// ─────────────────────────────────────────────────────────────────────────────

/** 最近一次从页面看到的语言。宿主不认识 DSH 的语言服务，就靠客户端中继时顺带告诉它。 */
let observedLocale = 'zh'

const TEXT_ZH = Object.freeze({
  completion: '任务完成',
  approval: '等待你的许可',
  question: '需要你的回答',
  failure: '执行失败',
  duration: '用时 ',
  questionMore: ' 等 ',
  questionMoreTail: ' 个问题',
})

const TEXT_EN = Object.freeze({
  completion: 'Task complete',
  approval: 'Approval needed',
  question: 'Answer needed',
  failure: 'Task failed',
  duration: 'took ',
  questionMore: ' and ',
  questionMoreTail: ' more question(s)',
})

/**
 * 取当前语言的文案表。
 * @param locale - `'zh' | 'en'`（其它值按 zh 处理）。
 * @returns 冻结的文案表。
 */
function textFor(locale) {
  return locale === 'en' ? TEXT_EN : TEXT_ZH
}

/**
 * 把毫秒格式化成人类可读的短文本。
 * @param ms - 耗时（毫秒），非有限数时返回空串。
 * @returns 形如 `1m 20s` / `9s` / `<1s`。
 */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || Number.isFinite(ms) !== true || ms < 0) return ''
  if (ms < 1000) return '<1s'
  const total = Math.round(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes === 0) return seconds + 's'
  return minutes + 'm ' + seconds + 's'
}

/**
 * 清洗一段外部文本：丢掉控制字符、折叠换行、截断。
 *
 * 为什么必须做：正文会进 XML（Toast 的 XML 载荷会做转义）与系统通知历史，
 * 一个换行或不可见控制字符就能让排版错乱；长度不管也会撑爆通知。
 * @param value - 任意输入。
 * @param max - 截断上限（字符数）。
 * @returns 干净的字符串（非字符串输入返回空串）。
 */
export function cleanText(value, max) {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  const limit = typeof max === 'number' && max > 0 ? max : 200
  return stripped.length > limit ? stripped.slice(0, limit - 1) + '…' : stripped
}

/**
 * 把宿主传感器事件翻译成一条"待投递通知"。
 * @param event - `host-sensors.js` 产出的事件。
 * @param locale - 当前语言。
 * @returns `{ kind, sessionId, title, body, dedupKey, origin, source }`。
 */
export function describeSensorEvent(event, locale) {
  const text = textFor(locale)
  const title = text[event.kind] ?? 'DoneVoice'
  const parts = []
  const sessionTitle = cleanText(event.title, 80)
  if (event.kind === 'completion') {
    if (sessionTitle !== '') parts.push(sessionTitle)
    const duration = formatDuration(event.durationMs)
    if (duration !== '') parts.push(text.duration + duration)
  } else if (event.kind === 'approval') {
    if (sessionTitle !== '') parts.push(sessionTitle)
    const toolName = cleanText(event.toolName, 60)
    if (toolName !== '') parts.push(toolName)
    const reason = cleanText(event.reason, 160)
    if (reason !== '') parts.push(reason)
  } else if (event.kind === 'question') {
    const question = cleanText(event.question, 160)
    if (question !== '') parts.push(question)
    const count = typeof event.questionCount === 'number' && Number.isFinite(event.questionCount) ? event.questionCount : 1
    if (count > 1) parts.push(text.questionMore + count + text.questionMoreTail)
    if (parts.length === 0 && sessionTitle !== '') parts.push(sessionTitle)
  } else if (event.kind === 'failure') {
    if (sessionTitle !== '') parts.push(sessionTitle)
    const message = cleanText(event.message, 200)
    if (message !== '') parts.push(message)
  }
  return {
    kind: event.kind,
    sessionId: cleanText(event.sessionId, 120),
    title: cleanText(title, 120),
    body: cleanText(parts.join(' · '), 320),
    dedupKey: cleanText(event.key, 300),
    origin: event.origin === 'subagent' ? 'subagent' : undefined,
    source: 'host',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 投递：去重 → 原生通道
// ─────────────────────────────────────────────────────────────────────────────

/** 投递去重表：key → 时间戳。 */
const recentKeys = new Map()
const pendingDeliveries = new Map()
const leaveRechecks = new Map()

/** 最近投递记录（探针用，环形截断）。 */
const deliveryLog = []

/** 最近一次投递结果（探针用）。 */
let lastDelivery = null
let lastSystemDelivery = null

/** 点击链路计数：页面来问过几次（probes）／真读到点击几次（hits）。探针里可见。 */
let clickProbes = 0
let clickHits = 0
let lastClick = null

/**
 * 判定一次投递是否该被去重掉。
 *
 * 两层：精确键（同一通道重复），以及 `kind|sessionId` 时间窗（两条通道同时到达）。
 * @param event - 待投递事件。
 * @param now - 当前时间戳。
 * @returns 命中的键，或 null。
 */
export function findDuplicate(event, now) {
  const window = DEDUP_WINDOW_MS
  for (const [key, at] of recentKeys) {
    if (now - at > window) recentKeys.delete(key)
  }
  const exact = typeof event.dedupKey === 'string' && event.dedupKey !== '' ? event.dedupKey : ''
  const coarse = event.kind + '|' + event.sessionId
  const hit = (exact !== '' && recentKeys.has(exact)) || recentKeys.has(coarse)
  return hit ? (recentKeys.has(exact) && exact !== '' ? exact : coarse) : null
}

/**
 * 记下一次投递的去重键。
 * @param event - 已投递事件。
 * @param now - 当前时间戳。
 */
function rememberDelivery(event, now) {
  const exact = typeof event.dedupKey === 'string' && event.dedupKey !== '' ? event.dedupKey : ''
  if (exact !== '') recentKeys.set(exact, now)
  recentKeys.set(event.kind + '|' + event.sessionId, now)
  // 防御：极端情况下（长跑进程 + 大量会话）别让这张表无限长。
  if (recentKeys.size > 512) {
    const oldest = [...recentKeys.entries()].sort((left, right) => left[1] - right[1]).slice(0, recentKeys.size - 256)
    for (const [key] of oldest) recentKeys.delete(key)
  }
}

/** 原生通知通道单例（惰性创建：只有真的要弹的时候才去探测 powershell）。 */
let nativeNotifier = null

/** 宿主侧事件传感器单例（在 apply 里装配，随插件生命周期回收）。 */
let hostSensors = null

/**
 * 取原生通知通道（幂等）。
 * @returns `win-native.js` 的 notifier。
 */
function getNotifier() {
  if (nativeNotifier === null) {
    nativeNotifier = createNativeNotifier({ log: (message) => log(message), homeDir: homeDir() })
  }
  return nativeNotifier
}

/** 拆掉原生通道（插件卸载 / HMR 重载时调用，负责杀掉常驻 worker）。 */
function shutdownNative() {
  for (const timer of leaveRechecks.values()) clearTimeout(timer)
  leaveRechecks.clear()
  if (nativeNotifier !== null) {
    try {
      nativeNotifier.dispose()
    } catch (error) {
      console.warn('[donevoice] 原生通道 dispose 抛异常 — ' + String(error))
    }
    nativeNotifier = null
  }
}

/**
 * 由宿主产生通知时的音效参数（音高预设与音量以宿主配置为唯一权威）。
 * @param config - 生效配置。
 * @returns `{ preset, volume }`。
 */
function soundFor(config) {
  return { preset: config.soundPreset, volume: config.volume }
}

/**
 * 投递一条提醒。
 *
 * 门禁顺序（每一道都返回**原因码**，绝不静默）：
 *   总开关 → 分类开关 → 子代理开关 → 跨通道去重 → 前台判断 → 原生通道。
 * @param event - 已描述好的事件（见 describeSensorEvent / notifyHandler）。
 * @param config - 生效配置。
 * @param opts - `{ skipRecheck?: boolean }`：内部用。宽限期复核会再进来一次，那一次不再排复核。
 * @returns `{ delivered, degraded, deduped, suppressed?, soundPlayed?, latencyMs }`。
 */
export async function deliver(event, config, opts) {
  if (!config.enabled || event.origin === 'subagent') return deliverOnce(event, config, opts)
  const key = event.kind + '|' + event.sessionId
  const pending = pendingDeliveries.get(key)
  if (pending) {
    const result = await pending
    // 前台静默需原样转交页面，失败则留给后续重试。
    if (!result.delivered.includes('toast')) return result
    return { ...result, delivered: [], deduped: true }
  }
  const task = deliverOnce(event, config, opts)
  pendingDeliveries.set(key, task)
  try { return await task } finally {
    if (pendingDeliveries.get(key) === task) pendingDeliveries.delete(key)
  }
}

async function deliverOnce(event, config, opts) {
  const now = Date.now()
  const options = opts !== null && typeof opts === 'object' ? opts : {}

  if (config.enabled !== true) return { delivered: [], degraded: ['disabled'], deduped: false, latencyMs: 0 }
  // 子智能体**一律不提醒**（用户定稿："这个完全不需要提醒"）。
  // 它不是开关而是硬规则 —— 设置页里连这一项都没有，所以这里也不看任何配置。
  if (event.origin === 'subagent') return { delivered: [], degraded: ['subagent-skip'], deduped: false, latencyMs: 0 }
  const duplicate = findDuplicate(event, now)
  if (duplicate !== null) {
    recordDelivery({ kind: event.kind, sessionId: event.sessionId, source: event.source, delivered: [], degraded: [], deduped: true, latencyMs: 0, at: now, duplicate })
    return { delivered: [], degraded: [], deduped: true, latencyMs: 0 }
  }

  // ★ 投递策略是**固定行为**，不是可选项（用户定稿）：
  //   · 你在 DSH 页面上 ⇒ 永不弹系统通知（"我在工作状态，能看到任务，提醒多余"）；
  //     页面内是否额外弹卡片，由唯一的可选开关 `pageCard` 决定（页内音效没有开关，页面上保持安静）。
  //   · 你走开了       ⇒ 系统通知 + 音效，**强制**。
  //   判据是 Windows 前台窗口属于哪个进程（见 win-native.js 的 presence()）——必须由宿主判断：
  //   宿主传感器不依赖页面，页面没开/被冻结时也照跑，靠页面报告焦点在那些情况下会失效。
  //   探测失败一律按"不在"处理（宁可多弹一条，也不漏提醒）。
  {
    const probe = await getNotifier().presence()
    if (probe.present === true) {
      const quietStarted = Date.now()
      // 你在页面上：**什么都不做**（用户定稿："我在工作状态，能看到任务，提醒多余"）。
      // 页内卡片由 JS 半区自己渲染（它拿到 suppressed 回执后按 `pageCard` 决定）。
      // 页内音效没有开关了 ⇒ 页面上保持安静；要声音就切走，那条是强制的。
      const result = { delivered: [], degraded: [], suppressed: 'present', soundPlayed: false, deduped: false, latencyMs: Date.now() - quietStarted }
      // ⚠️ 这里**故意不 rememberDelivery**：什么都没投递，不该占用"已处理"名额。
      //    否则页面随后的中继会被判成 deduped，页内卡片就没机会渲染（`pageCard` 会失效）。
      recordDelivery({
        kind: event.kind,
        sessionId: event.sessionId,
        source: event.source,
        delivered: [],
        degraded: [],
        deduped: false,
        suppressed: 'present',
        soundPlayed: false,
        foreground: probe.foreground,
        latencyMs: result.latencyMs,
        at: now,
      })
      // ★ 离开宽限期（见 scheduleLeaveRecheck 的说明）：这一次因为你"在页面上"被静默，
      //   但你完全可能正在切走 —— 复核一次，别让提醒在你切走的瞬间丢掉。
      if (options.skipRecheck !== true) scheduleLeaveRecheck(event)
      return result
    }
    if (probe.error !== undefined && probe.error !== null) {
      console.warn('[donevoice] 前台探测不可用（' + String(probe.error) + '）— 按"你不在"处理，照常弹通知')
    }
  }

  const started = Date.now()
  let outcome
  try {
    outcome = await getNotifier().notify({
      kind: event.kind,
      title: event.title,
      body: event.body,
      sound: soundFor(config),
    })
  } catch (error) {
    console.error('[donevoice] 原生通知通道抛异常 — ' + String(error))
    outcome = { delivered: [], degraded: ['notifier-threw'] }
  }
  const delivered = Array.isArray(outcome?.delivered) ? outcome.delivered.filter((item) => typeof item === 'string') : []
  const degraded = Array.isArray(outcome?.degraded) ? outcome.degraded.filter((item) => typeof item === 'string') : []
  const result = { delivered, degraded, deduped: false, latencyMs: Date.now() - started }
  // ⚠️ **只有真的投递成功才占用去重名额**。
  //    曾经无条件记账，导致"弹失败的那条"把名额占了：紧接着重试/另一条通道来的同一件事
  //    会被判成重复而丢掉 —— 表现就是"提醒该响的时候没响，而且日志还说已处理"。
  //    （参考实现里对应的坑是"在投递之前就把消息 ack 成已展示"，同一个病。）
  if (delivered.length > 0) rememberDelivery(event, now)
  recordDelivery({
    kind: event.kind,
    sessionId: event.sessionId,
    source: event.source,
    delivered,
    degraded,
    deduped: false,
    latencyMs: result.latencyMs,
    at: now,
  })
  if (delivered.length === 0) {
    console.warn('[donevoice] 原生通知未送达 kind=' + event.kind + ' degraded=' + JSON.stringify(degraded))
  }
  return result
}

/**
 * 记录一条投递到探针日志。
 * @param entry - 投递记录。
 */
function recordDelivery(entry) {
  lastDelivery = entry
  if (entry.delivered?.includes('toast')) lastSystemDelivery = entry
  deliveryLog.push(entry)
  if (deliveryLog.length > DELIVERY_LOG_SIZE) deliveryLog.splice(0, deliveryLog.length - DELIVERY_LOG_SIZE)
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP：栅栏与解析（与配置路由共用同一套规矩）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 判断请求是否来自跨站上下文。
 * @param req Node 请求对象。
 * @returns 是否跨站。
 */
function isCrossSite(req) {
  const site = req?.headers?.['sec-fetch-site']
  return typeof site === 'string' && site.toLowerCase() === 'cross-site'
}

/**
 * 判断写请求的 Origin 是否与 Host 同源（无 Origin 时视为同源，兼容非浏览器客户端）。
 * @param req Node 请求对象。
 * @returns 是否允许写入。
 */
function sameOrigin(req) {
  const origin = req?.headers?.origin
  if (typeof origin !== 'string' || origin === '') return true
  const host = req?.headers?.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

/**
 * 读请求体并解析 JSON，带体积上限。
 *
 * ⚠️ 超限时**绝不能** `req.destroy()`：销毁 socket 会让已经写好的 413 响应永远发不出去，
 * 客户端只看到一个断开的连接（curl 报 `000`）。这个 bug 是**真机联调**抓到的——
 * 单元测试里的假请求不会真的断连接，所以它漏过了。
 * 正确做法：标记"已拒绝"、清掉已缓冲的数据、继续把流读干（不再缓冲），让响应正常送达。
 * @param req Node 请求对象。
 * @param limit 字节上限。
 * @returns 解析结果。
 * @throws `{ code: 'too-large' | 'bad-json' }`
 */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let refused = false
    req.on('data', (chunk) => {
      if (refused) return
      size += chunk.length
      if (size > limit) {
        refused = true
        chunks.length = 0
        reject(Object.assign(new Error('body too large'), { code: 'too-large' }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (refused) return
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('invalid json'), { code: 'bad-json' }))
      }
    })
    req.on('error', (error) => {
      if (refused) return
      reject(error)
    })
  })
}

/**
 * 统一回响应。
 * @param res Node 响应对象。
 * @param status 状态码。
 * @param body 正文（可空）。
 * @param headOnly 是否只回头不回体。
 */
function respond(res, status, body, headOnly) {
  res.statusCode = status
  res.setHeader('cache-control', 'no-store')
  if (body !== undefined) res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(headOnly === true ? undefined : body)
}

/**
 * `/plugins/dsh-donevoice/config.json`：GET/HEAD 读取，PUT/POST 写入。
 * @param req Node 请求对象。
 * @param res Node 响应对象。
 */
async function configHandler(req, res) {
  const method = String(req?.method ?? 'GET').toUpperCase()
  try {
    if (method === 'GET' || method === 'HEAD') {
      if (isCrossSite(req)) {
        respond(res, 403)
        return
      }
      respond(res, 200, JSON.stringify(readConfig(), null, 2), method === 'HEAD')
      return
    }
    if (method === 'PUT' || method === 'POST') {
      if (isCrossSite(req) || sameOrigin(req) !== true) {
        respond(res, 403)
        return
      }
      const type = String(req?.headers?.['content-type'] ?? '')
      if (type.toLowerCase().indexOf('application/json') !== 0) {
        respond(res, 415)
        return
      }
      const parsed = await readJsonBody(req, MAX_BODY_BYTES)
      // 允许 `{ document: {...} }` 信封，也允许直接给文档本身。
      const document = parsed !== null && typeof parsed === 'object' && parsed.document !== undefined
        ? parsed.document
        : parsed
      respond(res, 200, JSON.stringify(writeConfig(document), null, 2))
      return
    }
    res.statusCode = 405
    res.setHeader('allow', 'GET, HEAD, PUT, POST')
    res.setHeader('cache-control', 'no-store')
    res.end()
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? error.code : undefined
    if (code === 'too-large') {
      respond(res, 413)
      return
    }
    if (code === 'bad-json') {
      respond(res, 400)
      return
    }
    console.error('[donevoice] config.json 处理失败 — ' + String(error))
    respond(res, 500)
  }
}

/**
 * 校验并读出一个 JSON 写请求（同源 + JSON + 体积上限），失败时已回好响应。
 * @param req - Node 请求对象。
 * @param res - Node 响应对象。
 * @param limit - 请求体上限（字节）；默认按通知体算。导入音效时要放大到能装下 base64。
 * @returns 解析出的对象，或 null（表示已回错）。
 */
async function readJsonWrite(req, res, limit) {
  if (isCrossSite(req) || sameOrigin(req) !== true) {
    respond(res, 403)
    return null
  }
  const type = String(req?.headers?.['content-type'] ?? '')
  if (type.toLowerCase().indexOf('application/json') !== 0) {
    respond(res, 415)
    return null
  }
  try {
    const parsed = await readJsonBody(req, typeof limit === 'number' && limit > 0 ? limit : MAX_NOTIFY_BYTES)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      respond(res, 400)
      return null
    }
    return parsed
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? error.code : undefined
    if (code === 'too-large') {
      respond(res, 413)
      return null
    }
    if (code === 'bad-json') {
      respond(res, 400)
      return null
    }
    console.error('[donevoice] 通知路由读体失败 — ' + String(error))
    respond(res, 500)
    return null
  }
}

/**
 * `POST /plugins/dsh-donevoice/notify`：客户端中继入口。
 *
 * 请求体：`{ kind, sessionId, title, body, dedupKey?, origin?, locale?, source? }`
 * 响应：`{ ok, delivered, degraded, deduped, latencyMs }`
 *   - `delivered` 非空 = 外面已经弹了（页面不必再弹卡片、也不必自己响）
 *   - `deduped: true` = 宿主传感器已经弹过了（同样视为"已经响过"）
 *   - 两者都空 = 原生通道不可用，页面应当降级
 * @param req Node 请求对象。
 * @param res Node 响应对象。
 */
async function notifyHandler(req, res) {
  const method = String(req?.method ?? 'GET').toUpperCase()
  if (method !== 'POST') {
    res.statusCode = 405
    res.setHeader('allow', 'POST')
    res.setHeader('cache-control', 'no-store')
    res.end()
    return
  }
  const body = await readJsonWrite(req, res)
  if (body === null) return
  const kind = typeof body.kind === 'string' ? body.kind.trim().toLowerCase() : ''
  if (KINDS.includes(kind) !== true) {
    respond(res, 400, JSON.stringify({ ok: false, error: 'bad-kind', allowed: [...KINDS] }))
    return
  }
  if (typeof body.locale === 'string') {
    const locale = body.locale.trim().toLowerCase()
    if (locale === 'zh' || locale === 'en') observedLocale = locale
  }
  const event = {
    kind,
    sessionId: cleanText(body.sessionId, 120),
    title: cleanText(body.title, 120),
    body: cleanText(body.body, 320),
    dedupKey: cleanText(body.dedupKey, 300),
    origin: body.origin === 'subagent' ? 'subagent' : undefined,
    source: 'client',
  }
  // 标题为空时用宿主自己的文案兜底，免得弹出一张没有标题的通知。
  if (event.title === '') event.title = textFor(observedLocale)[kind]
  try {
    const result = await deliver(event, readConfig())
    respond(res, 200, JSON.stringify({ ok: true, ...result }))
  } catch (error) {
    console.error('[donevoice] notify 处理失败 — ' + String(error))
    respond(res, 500, JSON.stringify({ ok: false, error: 'internal' }))
  }
}


/**
 * `POST /plugins/dsh-donevoice/preview`：设置页「试听」。
 *
 * 只播音效、不弹通知（走 `notify` 的 `soundOnly` 分支）。**有意不看开关**：
 * 用户点试听就是想听这个音效本身，被总开关挡住只会让人以为音效坏了。
 * 音量仍然尊重配置（0 时直接什么都不做，与"静音"一致）。
 * @param req Node 请求对象。
 * @param res Node 响应对象。
 */
async function previewHandler(req, res) {
  const method = String(req?.method ?? 'GET').toUpperCase()
  if (method !== 'POST') {
    res.statusCode = 405
    res.setHeader('allow', 'POST')
    res.setHeader('cache-control', 'no-store')
    res.end()
    return
  }
  const body = await readJsonWrite(req, res)
  if (body === null) return
  const preset = typeof body.preset === 'string' ? body.preset.trim().toLowerCase() : ''
  // 合法值按 id 语法 + **磁盘上真的存在**判定：用户可以自由导入音效，
  // 静态枚举（ENUM_FIELDS.soundPreset）只是自带的默认集合，不能拿它当白名单。
  if (isSoundId(preset) !== true) {
    respond(res, 400, JSON.stringify({ ok: false, error: 'bad-preset' }))
    return
  }
  if (preset !== 'none' && soundFileFor(null, preset) === null) {
    respond(res, 404, JSON.stringify({ ok: false, error: 'sound-not-found', preset }))
    return
  }
  if (preset === 'none') {
    respond(res, 200, JSON.stringify({ ok: true, preset, sound: false, reason: 'silent' }))
    return
  }
  const volume = clampVolume(body.volume === undefined ? readConfig().volume : body.volume)
  if (volume === 0) {
    respond(res, 200, JSON.stringify({ ok: true, preset, sound: false, reason: 'volume-0' }))
    return
  }
  try {
    const outcome = await getNotifier().notify({ kind: 'test', title: '', body: '', sound: { preset, volume }, soundOnly: true })
    const played = Array.isArray(outcome?.delivered) && outcome.delivered.includes('sound')
    respond(res, 200, JSON.stringify({ ok: true, preset, sound: played, degraded: outcome?.degraded ?? [] }))
  } catch (error) {
    console.error('[donevoice] 试听播放失败 — ' + String(error))
    respond(res, 500, JSON.stringify({ ok: false, error: 'internal' }))
  }
}

/**
 * `/plugins/dsh-donevoice/sounds.json`：音效清单 / 导入 / 删除。
 * @param req Node 请求对象。
 * @param res Node 响应对象。
 */
async function soundsHandler(req, res) {
  const method = String(req?.method ?? 'GET').toUpperCase()
  const url = new URL(String(req?.url ?? '/'), 'http://127.0.0.1')

  if (method === 'GET' || method === 'HEAD') {
    const list = listSounds()
    respond(res, 200, JSON.stringify({
      ok: true,
      dir: userSoundDir(),
      builtinDir: soundDir(),
      sounds: list.map((item) => ({ id: item.id, builtin: item.builtin, size: item.size })),
    }), method === 'HEAD')
    return
  }

  if (method === 'POST') {
    // 音效是二进制，base64 后约 ×1.37 ⇒ 上限按最大音效的 1.5 倍给。
    const body = await readJsonWrite(req, res, Math.ceil(MAX_SOUND_BYTES * 1.5))
    if (body === null) return
    const rawName = typeof body.name === 'string' ? body.name : ''
    const data = typeof body.data === 'string' ? body.data : ''
    if (data === '') {
      respond(res, 400, JSON.stringify({ ok: false, error: 'empty-data' }))
      return
    }
    let bytes = null
    try {
      bytes = Buffer.from(data, 'base64')
    } catch {
      bytes = null
    }
    if (bytes === null || bytes.length === 0) {
      respond(res, 400, JSON.stringify({ ok: false, error: 'bad-base64' }))
      return
    }
    if (bytes.length > MAX_SOUND_BYTES) {
      respond(res, 413, JSON.stringify({ ok: false, error: 'too-large', limit: MAX_SOUND_BYTES, size: bytes.length }))
      return
    }
    const ext = extname(rawName).toLowerCase()
    if (SOUND_EXTS.includes(ext) !== true) {
      respond(res, 400, JSON.stringify({ ok: false, error: 'bad-ext', allowed: [...SOUND_EXTS] }))
      return
    }
    // id 从文件名派生；中文/纯符号的名字派生不出合法 id ⇒ 用时间戳兜底，绝不写空名。
    let id = soundIdFrom(rawName)
    if (id === '') id = 'sound-' + Date.now().toString(36)
    // 重名不覆盖，自动加序号（用户可能故意导入两个版本对比）。
    const taken = new Set(listSounds().map((item) => item.id))
    if (id === 'none') id = 'sound-none'
    let unique = id
    for (let n = 2; taken.has(unique); n += 1) {
      const suffix = '-' + String(n)
      unique = id.slice(0, 40 - suffix.length) + suffix
    }
    const file = join(userSoundDir(), unique + ext)
    try {
      mkdirSync(userSoundDir(), { recursive: true })
      writeFileSync(file, bytes)
    } catch (error) {
      respond(res, 500, JSON.stringify({ ok: false, error: 'write-failed', detail: String(error?.message ?? error) }))
      return
    }
    console.log('[donevoice] 已导入音效 ' + unique + '（' + String(bytes.length) + ' 字节）')
    respond(res, 200, JSON.stringify({ ok: true, id: unique, size: bytes.length }))
    return
  }

  if (method === 'DELETE') {
    if (isCrossSite(req) || !sameOrigin(req)) { respond(res, 403); return }
    const id = String(url.searchParams.get('id') ?? '').trim()
    if (isSoundId(id) !== true || id === 'none') {
      respond(res, 400, JSON.stringify({ ok: false, error: 'bad-id' }))
      return
    }
    const found = listSounds().find((item) => item.id === id)
    if (found === undefined) {
      respond(res, 404, JSON.stringify({ ok: false, error: 'not-found', id }))
      return
    }
    // ⚠️ 删之前必须让 worker 关掉播放器：MediaPlayer 一 Open 就占住文件句柄，
    //    直接 rmSync 会 EPERM（真机实测："删除成功"但文件还在，第二次删才报 500）。
    let released = 0
    try {
      const done = await getNotifier().release()
      released = typeof done?.released === 'number' ? done.released : 0
    } catch (error) {
      console.warn('[donevoice] 释放播放器失败（继续尝试删除）— ' + String(error))
    }
    try {
      rmSync(found.file, { force: true })
    } catch (error) {
      // 还占着（可能被别的进程播着）：如实告诉页面，别假装删掉了。
      respond(res, 409, JSON.stringify({
        ok: false,
        error: 'file-locked',
        detail: String(error?.message ?? error),
        released,
      }))
      return
    }
    if (existsSync(found.file)) {
      respond(res, 409, JSON.stringify({ ok: false, error: 'file-locked', released }))
      return
    }
    console.log('[donevoice] 已删除音效 ' + id + (found.builtin ? '（自带）' : '（导入）'))
    // 删掉的正好是当前选用的那一个 ⇒ 顺手回落到默认音，免得配置悬空。
    const current = readConfig()
    if (current.soundPreset === id) {
      const available = listSounds().map((item) => item.id)
      const fallback = available.includes(id) ? id
        : (available.includes(DEFAULT_CONFIG.soundPreset) ? DEFAULT_CONFIG.soundPreset : (available[0] ?? 'none'))
      writeConfig({ ...current, soundPreset: fallback })
      console.log('[donevoice] 删除后当前提示音更新为 ' + fallback)
    }
    respond(res, 200, JSON.stringify({ ok: true, id, builtin: found.builtin }))
    return
  }

  res.statusCode = 405
  res.setHeader('allow', 'GET, HEAD, POST, DELETE')
  res.setHeader('cache-control', 'no-store')
  res.end()
}


/**
 * 前台判断：你现在算不算"在 DSH 页面上"（按 Windows 前台窗口所属进程算）。
 * @returns `{ present, foreground }`；探测不可用时 `present:false`（宁可多弹，不漏提醒）。
 */
async function isPresent() {
  try {
    const probe = await getNotifier().presence()
    return { present: probe?.present === true, foreground: probe?.foreground }
  } catch {
    return { present: false }
  }
}

/**
 * 离开宽限期：被"你在页面上"静默之后，隔一小会儿**复核一次**。
 *
 * 为什么需要（照参考实现的教训补的）：前台判断是**二值**的，而且判在**事件发生的那一刻**。
 * 你在任务收尾的同一秒切走窗口 —— 判定时你还"在页面上"，于是不提醒；等你切走了，
 * 那条提醒已经永远错过了。这不是罕见情况：收尾往往正好发生在你起身/切窗口的瞬间。
 *
 * 复核窗口取 1800ms：足够覆盖"切窗口"这个动作（通常 0.3–1s），又短到补发的提醒
 * 仍然像"刚发生"（不会让人以为是旧消息）。
 *
 * 安全边界：
 *   · 复核那次**不再排复核**（`skipRecheck`），不会自我循环；
 *   · 复核后若你还在页面上 ⇒ 什么都不做（尊重"在页面上就安静"的定稿）；
 *   · 期间页面自己中继过同一条 ⇒ 去重键命中，不会重复弹；
 *   · 定时器 `unref()`，绝不阻止宿主退出。
 * @param event - 被静默的那条事件。
 * @param config - 当次生效配置（复核时按**当时的**配置重新过门禁）。
 */
function scheduleLeaveRecheck(event) {
  const key = event.kind + '|' + event.sessionId
  if (leaveRechecks.has(key)) return
  const timer = setTimeout(() => {
    leaveRechecks.delete(key)
    void (async () => {
      try {
        const state = await isPresent()
        if (state.present === true) return
        const reconfig = readConfig()
        if (reconfig.enabled !== true) return
        console.log('[donevoice] 宽限期复核：你已经离开 DSH ⇒ 补发 ' + String(event.kind)
          + '（前台=' + String(state.foreground) + '）')
        await deliver(event, reconfig, { skipRecheck: true })
      } catch (error) {
        console.warn('[donevoice] 宽限期复核失败 — ' + String(error))
      }
    })()
  }, LEAVE_GRACE_MS)
  leaveRechecks.set(key, timer)
  if (timer !== null && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
}

/**
 * `/plugins/dsh-donevoice/health.json`：只读探针，装完 GET 一下就知道宿主半区活没活。
 *
 * 它现在回答四个问题：宿主活着没 / 配置长什么样 / **原生通知通道可用没** / 传感器收了多少事件。
 * 最后两个是本插件"看起来像没装"时唯一的现场证据。
 * @param req Node 请求对象。
 * @param res Node 响应对象。
 */
async function healthHandler(req, res) {
  try {
    const method = String(req?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('allow', 'GET, HEAD')
      res.setHeader('cache-control', 'no-store')
      res.end()
      return
    }
    if (isCrossSite(req)) {
      respond(res, 403)
      return
    }
    // 只为 `?probe=presence` 解析一次查询串；不带参数时行为与以前完全一样。
    let url
    try {
      url = new URL(String(req?.url ?? '/'), 'http://127.0.0.1')
    } catch {
      url = new URL('http://127.0.0.1/')
    }
    const payload = {
      ok: true,
      plugin: 'dsh-donevoice',
      entry: name,
      version,
      host: 'alive',
      fields: Object.keys(DEFAULT_CONFIG).length,
      configPath: configFile(),
      config: readConfig(),
      routes: { config: CONFIG_PATH, health: HEALTH_PATH, notify: NOTIFY_PATH, preview: PREVIEW_PATH, sounds: SOUNDS_PATH },
      contract: configContractStatus(),
      native: nativeStatus(),
      sensors: sensorStatus(),
      lastDelivery,
      deliveries: deliveryLog.slice(-5),
      locale: observedLocale,
    }
    // 可选的前台探测（`?probe=presence`）：默认**不查**——探针不该为了看一眼状态就把常驻 worker 拉起来。
    // 手动验收时用它判断"此刻算不算你在页面上"。
    if (url.searchParams.get('probe') === 'presence') {
      payload.presence = await getNotifier().presence()
      payload.pageCard = readConfig().pageCard === true
    }
    // 点击标记（`?probe=click`）：**读一次就删**。
    // 由"点击系统通知"的处理器写下（见 win-native.js）；页面拿到焦点后查这里，跳到那条会话。
    if (url.searchParams.get('probe') === 'click') {
      payload.clicked = false
      const marker = clickMarkerFile()
      clickProbes += 1
      try {
        if (existsSync(marker)) {
          const stamp = readFileSync(marker, 'utf8').trim()
          rmSync(marker, { force: true })
          payload.clicked = true
          payload.clickedAt = stamp
          clickHits += 1
          lastClick = { at: stamp, sessionId: lastSystemDelivery?.sessionId ?? '', kind: lastSystemDelivery?.kind ?? null }
          // 会话 id 取宿主记录的那条最近投递 —— 点击发生时你收到的通知就是它。
          payload.sessionId = lastClick.sessionId
          payload.kind = lastClick.kind
        }
      } catch (error) {
        console.warn('[donevoice] 读取点击标记失败 — ' + String(error))
      }
      // 这两个计数是"点击→回桌面→跳会话"这条链路的**可观测证据**：
      // probes 增长说明页面确实来问过（客户端代码生效了），hits 增长说明它真读到了点击。
      payload.clickProbes = clickProbes
      payload.clickHits = clickHits
      payload.lastClick = lastClick
    }
    respond(res, 200, JSON.stringify(payload, null, 2), method === 'HEAD')
  } catch (error) {
    console.error('[donevoice] health.json 处理失败 — ' + String(error))
    respond(res, 500)
  }
}

/**
 * 宿主传感器产出一条事件 → 翻译 → 投递。
 *
 * 这条路径的**全部意义**是：页面开不开、在哪个页面、标签冻不冻，都不影响提醒。
 * 所以这里绝不允许抛异常打断宿主事件链（`deliver` 自己已经吞掉原生通道的异常，
 * 这里再包一层是为了兜住翻译/配置读取）。
 * @param event - `host-sensors.js` 产出的原始事件。
 */
function handleSensorEvent(event) {
  try {
    const described = describeSensorEvent(event, observedLocale)
    void deliver(described, readConfig()).catch((error) => {
      console.error('[donevoice] 宿主提醒投递失败 — ' + String(error))
    })
  } catch (error) {
    console.error('[donevoice] 宿主提醒翻译失败 — ' + String(error))
  }
}

/**
 * 取宿主传感器状态（装配失败时为 `{ attached: false, reason }`）。
 * @returns 状态对象。
 */
export function sensorStatus() {
  if (hostSensors === null) return { attached: false, reason: sensorFailure ?? '未装配' }
  try {
    return { attached: true, ...hostSensors.stats() }
  } catch (error) {
    return { attached: true, error: String(error) }
  }
}

/** 传感器装配失败的原因（探针里要看得见）。 */
let sensorFailure = null

/**
 * 音效目录自检（探针用）。
 *
 * 语义在用户要求"音效可自由导入/删除"之后变了：合法值不再由静态枚举决定，
 * 而是**磁盘扫描的结果**（`win-native.js` 的 `listSounds`）。所以这里检查的是：
 *   · 清单里每个 id 都真能解析到存在的文件（扫盘自洽，正常情况下不该失败）；
 *   · 用户导入了几个；
 *   · **当前选用的提示音能不能解析**（配置悬空时一眼可见，而不是等用户听出"怎么没声音"）。
 *
 * 历史仍值得记住：曾因"加了音效却漏改枚举"导致静默回落、用户听到"前 6 个声音一模一样"。
 * 那条教训的现代版本就是"配置里写的 id 在磁盘上不存在"——`presetOk` 为它而留。
 * @returns 自检结果。
 */
export function configContractStatus() {
  const list = listSounds()
  const ids = list.map((item) => item.id)
  const broken = list.filter((item) => existsSync(item.file) !== true).map((item) => item.id)
  const builtinMissing = Object.keys(SOUND_FILES).filter((id) => ids.includes(id) !== true)
  const preset = readConfig().soundPreset
  const presetOk = preset === 'none' || ids.includes(preset)
  return {
    ok: broken.length === 0,
    presets: ids.length,
    user: list.filter((item) => item.builtin !== true).length,
    preset,
    presetOk,
    broken,
    builtinMissing,
  }
}

/**
 * 原生通道状态（**不**为了看一眼状态就把 worker 拉起来）。
 * @returns 状态对象。
 */
export function nativeStatus() {
  const target = nativeNotifier
  if (target === null) return { created: false, backend: 'win-native', note: '尚未投递过，通道惰性创建' }
  try {
    const status = typeof target.status === 'function' ? target.status() : {}
    return { created: true, ...status }
  } catch (error) {
    return { created: true, error: String(error) }
  }
}

/**
 * 注册一项"可选能力"。
 *
 * 本插件的宿主半区没有任何硬依赖：Settings 与 WebServer 都可能不在当前组合里，
 * 也可能比本插件晚出现（此时 ctx.inject 会等它们就绪）。但有一条硬规矩：
 * **降级必须出声**——安静地什么都不做，会让人分不清"没装"和"装了但没生效"。
 *
 * 注意两种"缺席"要分开处理：`ctx.inject` 的**回调不被调用**时我们没有任何钩子可挂，
 * 所以这里配一个看门狗到点补报；`.unref()` 保证这个计时器不会拖住宿主进程退出。
 * @param ctx - 宿主上下文。
 * @param deps - 需要等待的服务名。
 * @param label - 出问题时报出来的能力名。
 * @param register - 服务就绪后的注册体。
 */
export const CAPABILITY_WAIT_MS = 5000

function optionalCapability(ctx, deps, label, register) {
  if (typeof ctx.inject !== 'function') {
    console.warn('[donevoice] ' + label + ' 未注册 — 运行上下文没有 ctx.inject（组合被裁剪？）')
    return
  }
  let settled = false
  const timer = setTimeout(() => {
    if (settled) return
    console.warn('[donevoice] ' + label + ' 未注册 — 等待 ' + deps.join('/') + ' 超过 ' + CAPABILITY_WAIT_MS + 'ms 仍未就绪（组合里没有它？）')
  }, CAPABILITY_WAIT_MS)
  // 不能因为这个看门狗让宿主进程多活 5 秒。
  if (typeof timer.unref === 'function') timer.unref()
  const done = () => {
    settled = true
    clearTimeout(timer)
  }
  try {
    ctx.inject(deps, (scope) => {
      done()
      try {
        register(scope)
      } catch (error) {
        console.error('[donevoice] ' + label + ' 注册失败 — ' + String(error))
      }
    })
  } catch (error) {
    done()
    console.error('[donevoice] ' + label + ' 注入失败 — ' + String(error))
  }
}

/**
 * 装载宿主半区。
 * @param ctx - 宿主 Cordis 上下文。
 */
export function apply(ctx) {
  const config = readConfig()
  console.info('[donevoice] host half loaded; config=' + JSON.stringify(config) + ' @ ' + configFile())
  console.info('[donevoice] 投递策略（固定行为）：不在 DSH 页面 ⇒ 系统通知 + 音效；在 DSH 页面 ⇒ 只按开关'
    + '（可选开关只有 pageCard=' + String(config.pageCard === true) + '）')
  // 音效目录自检：清单里的文件必须真的在盘上，且**当前选用的那个必须能解析**
  // （否则用户会遇到"提醒响了但没声音"，还得自己猜原因）。
  const contract = configContractStatus()
  if (contract.ok !== true) {
    console.error('[donevoice] 音效目录异常 —— 清单里有解析不到的文件：' + JSON.stringify(contract.broken))
  }
  if (contract.presetOk !== true) {
    console.error('[donevoice] 当前提示音 ' + JSON.stringify(contract.preset) + ' 在磁盘上不存在 —— '
      + '提醒会照弹但没声音。可选：' + JSON.stringify(listSounds().map((item) => item.id))
      + '（或删掉 config.json 里的 soundPreset 让它回落默认）')
  }

  // —— 0. 原生通道的生命周期：插件卸载 / HMR 重载时把常驻 worker 收干净。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => { shutdownNative() }, 'donevoice: native channel')
  }

  // —— 0.5 宿主侧事件传感器：四类触发的**主通道**（不依赖任何页面）。
  //     这是"不管我在哪个页面都能弹到"的答案：检测发生在宿主进程里，
  //     页面只是"顺便也能收到"的第二条通道（客户端中继）。
  try {
    const instance = createHostSensors({
      ctx,
      log: (message) => log(message),
      onEvent: handleSensorEvent,
    })
    hostSensors = instance
    sensorFailure = null
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        instance.dispose()
        if (hostSensors === instance) hostSensors = null
      }, 'donevoice: host sensors')
    }
    log('宿主传感器已装配：完成/审批/提问/失败四类事件都在宿主侧检测')
  } catch (error) {
    hostSensors = null
    sensorFailure = String(error)
    // 出声是硬规矩：传感器没了意味着"完成提醒只剩页面那条通道"，绝不能静默。
    console.error('[donevoice] 宿主传感器装配失败，四类提醒将只剩页面中继通道 — ' + String(error))
  }

  // —— 1. 自有设置页：抑制自动生成页（官方约定，dsh-settings README）。
  optionalCapability(ctx, ['settings'], '设置页策略', (scope) => {
    scope.effect(
      () => scope.settings.configure({ auto: false }, ctx.fiber),
      'donevoice: settings page policy',
    )
  })

  // —— 2. 路由：配置读写 + 只读探针 + 客户端中继 + 四种通知测试。
  optionalCapability(ctx, ['webServer'], '配置、探针与通知路由', (scope) => {
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: CONFIG_PATH, handler: configHandler }), 'donevoice: config route')
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: HEALTH_PATH, handler: healthHandler }), 'donevoice: health route')
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: NOTIFY_PATH, handler: notifyHandler }), 'donevoice: notify route')
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: PREVIEW_PATH, handler: previewHandler }), 'donevoice: preview route')
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: SOUNDS_PATH, handler: soundsHandler }), 'donevoice: sounds route')
  })
}
