/**
 * DoneVoice 的**宿主侧事件传感器**（Host-side sensors）。
 *
 * ## 为什么需要它
 *
 * 用户的原话是"不管我在哪个页面都必须能弹到"。只靠页面（client.js）检测做不到：
 * 标签页可能被浏览器冻结、用户可能压根没开这个页面。所以"完成 / 审批 / 提问 / 失败"
 * 四类触发必须搬到 **DSH 宿主进程**里检测——宿主进程只要在跑，事件就一定到。
 *
 * ## 零 import（硬约束，血泪换来的）
 *
 * 本文件**不 import 任何东西**，连 `node:*` 都不需要。原因见 index.js 头注释：
 * profile 的 `node_modules` 里没有 `@deepseek-ai` 作用域，宿主半区静态 import 裸包名
 * = 链接期错误 = 整个宿主条目加载失败（"装上去像没装"）。本文件只用语言内建能力。
 *
 * ## 四条接缝（全部在 evidence/host-events.md 里带行号复核过）
 *
 * | 类别 | 事件 | 模式 | 触发语义 |
 * | --- | --- | --- | --- |
 * | 完成 | `api-session/status(sessionId, running)` | emit（全局广播） | `true→false` 边沿 |
 * | 完成/失败（真值源） | `session/event(session, event)` | emit（scopeTarget 过滤） | `turn/start` / `turn/end` |
 * | 审批 | `approval/request(req, next)` | **waterfall** | 有人要按下同意/拒绝 |
 * | 提问 | `user-questions/request(request, next)` | **waterfall** | 有人要被问问题 |
 * | 失败 | `api-session/error(sessionId, message)` | emit（全局广播） | 一条用户可读的失败链 |
 *
 * ### 为什么根上下文一定收得到（含被 scopeTarget 过滤的那几条）
 *
 * `dsh-scope/lib/index.js:327-338` 的 `scopeTarget(base, key)` 造的 carrier 里，
 * 过滤函数第一件事就是 `const tag = scopeOf(ctx); if (tag === undefined) return true`
 * ——**没打 scope 标签的监听器一律放行**。而 `scopeOf(ctx)` 读的是
 * `ctx[Symbol("dsh.scope")]`（`dsh-scope/lib/index.js:229,312-314`），这个 Symbol
 * 是模块私有的，只有 `createScope()` 会写；普通 Loader 插件上下文没有它。
 * 旁证：`dsh-api-session-controller/lib/index.js:2884` 就是用普通 `ctx.on("agent/status")`
 * 收到被 scope 过滤的 agent 事件的。
 *
 * ### waterfall 的三个致命陷阱（本文件用结构而不是自觉来防）
 *
 * 1. **不调用 `next()` = 截断瀑布**。真机上就是审批永远等不到答案（卡死）。
 * 2. **抛异常 = 审批变 `unavailable`**。`dsh-user-approval/lib/index.js:176` 的
 *    `.then(..., () => "unavailable")` 会把任何异常吞成 fail-closed，
 *    等于插件替用户拒绝了这次工具调用。
 * 3. **排在链条末尾 = 永远轮不到你**（真机抓到的坑）。waterfall 按**注册顺序**串链，
 *    而官方的转发器 `dsh-api-remotes`（`dsh-api-remotes/lib/index.js:147-157`）在拿到浏览器答案的
 *    路径上直接 return、**从不调用 `next()`**（`forwardWaterfall`，同文件 `215-232`）。
 *    官方包加载早于本插件 ⇒ 不 prepend 的话我们排在它**后面**，一次都不会被调用：
 *    真机症状是"通知弹了，但 `sensors.question` 是 0"（通知走的是页面中继）。
 *    因此两条 waterfall 都必须 `{ prepend: true }` 注册（见下方注册区注释与 evidence §12）。
 *
 * 因此两个 waterfall 监听器的形状被**钉死**成：
 *   `try { 只做观测 } catch { 出声 }` 之后**无条件** `return next()`；
 * 并且**必须 prepend 到链首**。
 * 观测逻辑、`onEvent` 回调、`log` 回调、字段读取全部在 try 里；`next()` 在 catch 之外。
 * test/host-sensors.test.mjs 有一条专项用例（敌意 Proxy 请求 + 抛异常的 onEvent）
 * 断言下游 answerer 仍被调用且返回值原样透传，另有一条**顺序反例**用
 * "先注册一个不调 next 的官方式转发器"复现修复前的症状。
 *
 * ### 与页面侧检测的关系
 *
 * 页面侧（client.js）有"基线吸收"（首次见到某会话只记状态不提醒），因为它一打开就会
 * 扫到一堆历史会话。宿主侧**不需要**：`api-session/status` 只在状态**变化**时 emit
 * （`dsh-api-session-controller/lib/index.js:2884-2886`），我们收到的每条 `false`
 * 背后都真的有一次 `true`，所以不存在"历史刷屏"。也正因为只在变化时 emit，
 * 完成检测必须是边沿检测，不能指望周期性心跳。
 *
 * ### 去重键与页面侧对齐
 *
 * `key` 的拼法与 client.js 的引擎保持**逐字一致**（审批 / 提问），这样两条通道同时到达时
 * 上层可以用同一个键去重；完成 / 失败用宿主侧独有的"周期号 / turn 号"。
 */

/** 已产出事件的去重记忆时长：同一 (会话, 周期) 在这段时间内只产出一条。 */
export const DEDUPE_TTL_MS = 30 * 60 * 1000

/** 去重表容量上限；超了就按时间剔除最旧的一批，长跑进程不会无界增长。 */
export const DEDUPE_MAX = 512

/**
 * 视为"正常收尾"的 `turn/end` 原因。
 * 取值来自 `SessionEventMap['turn/end']` 的 `TurnEndReasonMap`
 * （`dsh-api-session-controller/lib/typert.host.js:2457`）：
 * completed / aborted / blocked / error / max-tokens / interrupted / forked。
 */
const COMPLETION_REASONS = Object.freeze(['completed', 'max-tokens'])

/**
 * 明确**不产出**提醒的 `turn/end` 原因：
 *  - `aborted`：用户自己按的停止 / 父代理收回 / 钩子中止——是"有人叫停"，不是任务状态变化；
 *  - `blocked`：turn 被挡在起步前就结束（归档会话，`dsh-api-session-controller/lib/index.js:2430`；
 *    或钩子 deny，`dsh-hooks-codex/lib/index.js:223`）——主动拦截，且**没有任何可展示的信息**
 *    （`{ kind: 'blocked' }` 不带 message），报出来只会是一张空卡片；
 *  - `interrupted`：崩溃尾巴的修复事件（`dsh-session/lib/types/repair.js:76`），不是真实收尾；
 *  - `forked`：分叉边界，不是收尾。
 */
const SILENT_REASONS = Object.freeze(['aborted', 'blocked', 'interrupted', 'forked'])

/**
 * 稳定散列（djb2 → base36），与 client.js 的 `hashText` 逐字同构，
 * 保证没有显式 callId 时两侧算出同一个去重键。
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

/**
 * 造一个宿主侧传感器。
 *
 * @param options 选项。
 * @param options.ctx 宿主 Cordis 上下文（需要 `ctx.on`）。
 * @param options.onEvent 每产出一条提醒事件就回调一次。
 * @param options.log 降级出声用的日志回调；默认 `console.warn`。**绝不静默降级**。
 * @param options.now 取当前时间的函数；默认 `Date.now`。便于测试与宿主侧耗时兜底。
 * @returns `{ stats(), dispose() }`。
 */
export function createHostSensors(options) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  const ctx = opts.ctx
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null
  const log = typeof opts.log === 'function' ? opts.log : defaultLog
  const now = typeof opts.now === 'function' ? opts.now : Date.now

  /** 计数（冻结接口里 stats() 的形状）。 */
  const counters = { completion: 0, approval: 0, question: 0, failure: 0, deduped: 0 }
  /** 最近一次降级原因；没有降级时**不设**这个键（接口里是可选字段）。 */
  let lastError
  /** 已经出过声的降级，按 key 去重，避免每次都刷屏。 */
  const warned = new Set()

  /** sessionId → 最近一次 `api-session/status` 的 running 值。 */
  const running = new Map()
  /** sessionId → 周期号；每次观测到 running 由假变真就 +1。 */
  const cycles = new Map()
  /** sessionId → 最近一次 `turn/start` 的 turn 号（完成/失败去重键的首选身份）。 */
  const lastTurn = new Map()
  /** sessionId → 当前打开的 turn 的起点 `{ turn, time }`，用于算耗时。 */
  const openTurn = new Map()
  /** sessionId → 本周期收敛状态兜底还是"完成"时用的最近 turn/end 原因。 */
  const lastReason = new Map()
  /** 周期起点（`now()` 口径），turn/start 缺失时的耗时兜底。 */
  const startedAt = new Map()
  /** 去重键 → 首次产出的时间。 */
  const seen = new Map()

  /** 已注册监听器的注销函数。 */
  const disposers = []
  /** 幂等开关。 */
  let disposed = false

  // ── 降级出声 ────────────────────────────────────────────────────────────────

  /** 默认日志通道：与 index.js 的降级路径一致，走 console.warn。 */
  function defaultLog(message) {
    console.warn(message)
  }

  /**
   * 报一次降级。**永不抛异常**——它自己就在观测路径上，抛了会污染宿主链路。
   * @param message 人类可读的原因（不含 `[donevoice]` 前缀，这里补）。
   */
  function degrade(message) {
    const text = '[donevoice] ' + message
    lastError = text
    try {
      log(text)
    } catch {
      /* 日志回调自己炸了也不能把观测路径带塌 */
    }
  }

  /**
   * 同一类降级只说一次。
   * @param key 去重键。
   * @param message 原因。
   */
  function degradeOnce(key, message) {
    if (warned.has(key)) return
    warned.add(key)
    degrade(message)
  }

  /**
   * 出一声**非降级**的说明（不写进 `stats().lastError`）。
   * 用于"调用方给了一个我们不打算执行的偏好"这类需要讲清楚、但不是故障的情况。
   * @param message 说明文本（不含 `[donevoice]` 前缀）。
   */
  function note(message) {
    try {
      log('[donevoice] ' + message)
    } catch {
      /* 同 degrade：日志炸了也不能影响链路 */
    }
  }

  /** 把任意异常渲染成一行短文本。 */
  function describe(error) {
    if (error === null || error === undefined) return '未知错误'
    if (typeof error === 'string') return error
    try {
      const message = error.message
      if (typeof message === 'string' && message !== '') return message
    } catch {
      /* 敌意对象读 message 也会炸 */
    }
    try {
      return String(error)
    } catch {
      return '无法字符串化的错误'
    }
  }

  // ── 上下文/服务读取（全部防御式：缺服务是常态，不是异常） ──────────────────

  /**
   * 读一个可选服务。`ctx.get(name)` 是 DSH 里读可选服务的通行做法
   * （见 `dsh-user-questions/lib/index.js:537` 的 `this.ctx.get("sessionProjections")`）。
   * @param name 服务名。
   * @returns 服务实例，取不到时 `undefined`。
   */
  function service(name) {
    try {
      if (ctx === null || typeof ctx !== 'object') return undefined
      if (typeof ctx.get === 'function') return ctx.get(name)
      return ctx[name]
    } catch {
      return undefined
    }
  }

  /** 从任意宿主对象上安全取字符串 id。 */
  function idOf(value) {
    if (value === null || typeof value !== 'object') return ''
    try {
      return typeof value.id === 'string' ? value.id : ''
    } catch {
      return ''
    }
  }

  /**
   * 按 sessionId 找会话对象。先问 `ctx.sessions`，再退回 `ctx.agents.get(id).session`
   * （`Agent` 的 id 就是 `SessionId`，见 `dsh-api-session-controller/lib/index.js:2880`
   * 的 `ctx.sessions.get(agent.id) === agent.session`）。
   * @param sessionId 会话 id。
   * @returns 会话对象，取不到时 `undefined`。
   */
  function sessionOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    const sessions = service('sessions')
    if (sessions !== null && typeof sessions === 'object' && typeof sessions.get === 'function') {
      try {
        const found = sessions.get(sessionId)
        if (found !== null && typeof found === 'object') return found
      } catch {
        /* 存储实现炸了就当没有 */
      }
    }
    const agents = service('agents')
    if (agents !== null && typeof agents === 'object' && typeof agents.get === 'function') {
      try {
        const agent = agents.get(sessionId)
        const session = agent !== null && typeof agent === 'object' ? agent.session : undefined
        if (session !== null && typeof session === 'object') return session
      } catch {
        /* 同上 */
      }
    }
    return undefined
  }

  /** 非空字符串判定。 */
  function filled(value) {
    return typeof value === 'string' && value !== ''
  }

  /**
   * 取会话标题。**取不到就返回 `undefined`（省略字段），绝不编造**。
   *
   * 真机可得的两个来源：
   *  1. `ctx.sessionTitle.get(session).title`——`dsh-session-title/lib/index.js:281-283`
   *     折的是 `session/title` 日志事件，返回 `{title, messageSeqs, source, eventSeq, updatedAt}`；
   *  2. 回落：直接折 `session.snapshotEvents()` 里最后一条 `session/title` 的 `data.title`
   *     （与服务同一条真相，服务缺席时用）。
   *
   * ⚠️ `SessionHeader` 里**没有标题字段**（`dsh-api-session-controller/lib/typert.host.js:2157`：
   * version/id/createdAt/cwd?/parentSession?/isSeeded/origin?/delegationDepth?/agentPreset?），
   * 所以"标题"只能走上面两条，任何从 header 猜标题的写法都是错的。
   * @param session 已知的会话对象（可空）。
   * @param sessionId 会话 id。
   * @returns 标题字符串，或 `undefined`。
   */
  function titleOf(session, sessionId) {
    const target = session !== undefined && session !== null ? session : sessionOf(sessionId)
    if (target === undefined || target === null) return undefined

    const titles = service('sessionTitle')
    if (titles !== null && typeof titles === 'object' && typeof titles.get === 'function') {
      try {
        const snapshot = titles.get(target)
        const title = snapshot !== null && typeof snapshot === 'object' ? snapshot.title : undefined
        if (filled(title)) return title
      } catch (error) {
        degradeOnce('sessionTitle:get', '读取会话标题失败，改用日志折算 — ' + describe(error))
      }
    } else {
      degradeOnce('sessionTitle:missing', 'sessionTitle 服务不可用，标题改从会话日志的 session/title 事件折算')
    }

    try {
      if (typeof target.snapshotEvents === 'function') {
        const events = target.snapshotEvents()
        if (Array.isArray(events)) {
          for (let index = events.length - 1; index >= 0; index -= 1) {
            const event = events[index]
            if (event !== null && typeof event === 'object' && event.type === 'session/title') {
              const data = event.data
              if (data !== null && typeof data === 'object' && filled(data.title)) return data.title
            }
          }
        }
      }
    } catch (error) {
      degradeOnce('sessionTitle:fold', '折算会话标题失败 — ' + describe(error))
    }
    return undefined
  }

  /**
   * 取子代理标记。唯一真值是 `session.header.origin === 'subagent'`
   * （`SessionHeader.origin?: 'subagent'`，`dsh-api-session-controller/lib/typert.host.js:2157`；
   * 写入点 `dsh-subagent/lib/index.js:478`）。**不从 `parentSession` 猜**。
   * @param session 已知的会话对象（可空）。
   * @param sessionId 会话 id。
   * @returns `'subagent'` 或 `undefined`。
   */
  function originOf(session, sessionId) {
    const target = session !== undefined && session !== null ? session : sessionOf(sessionId)
    if (target === undefined || target === null) return undefined
    try {
      const header = target.header
      if (header !== null && typeof header === 'object' && header.origin === 'subagent') return 'subagent'
    } catch {
      /* header 取不到就不打标记 */
    }
    return undefined
  }

  // ── 去重 ────────────────────────────────────────────────────────────────────

  /** 按时间清理去重表。 */
  function pruneSeen(at) {
    if (seen.size <= DEDUPE_MAX) return
    const cutoff = at - DEDUPE_TTL_MS
    for (const [key, time] of seen) {
      if (time < cutoff) seen.delete(key)
    }
    // 全是新鲜条目（极端情况）时至少砍掉一半，保证有界。
    if (seen.size > DEDUPE_MAX) {
      const overflow = seen.size - Math.floor(DEDUPE_MAX / 2)
      let dropped = 0
      for (const key of seen.keys()) {
        if (dropped >= overflow) break
        seen.delete(key)
        dropped += 1
      }
    }
  }

  /**
   * 认领一个去重键。
   * @param key 去重身份。
   * @returns 这是第一次见到该键时为 `true`。
   */
  function claim(key) {
    const at = safeNow()
    pruneSeen(at)
    if (seen.has(key)) return false
    seen.set(key, at)
    return true
  }

  /** `now()` 是外部注入的；它炸了也不能让链路塌。 */
  function safeNow() {
    try {
      const value = now()
      return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
    } catch {
      return Date.now()
    }
  }

  // ── 事件产出 ────────────────────────────────────────────────────────────────

  /**
   * 产出一条提醒事件。
   * @param event 完整事件对象（含 `kind` / `sessionId` / `key`）。
   */
  function report(event) {
    if (disposed) return
    if (!claim(event.key)) {
      counters.deduped += 1
      return
    }
    if (onEvent === null) {
      degradeOnce('onEvent:missing', '没有 onEvent 回调，提醒事件被丢弃')
      return
    }
    counters[event.kind] += 1
    try {
      onEvent(event)
    } catch (error) {
      degradeOnce('onEvent:throw', 'onEvent 回调抛出异常（已吞掉，不影响宿主） — ' + describe(error))
    }
  }

  /** 补 title / origin 这两个可选字段；取不到就不设键。 */
  function decorate(event, session, sessionId) {
    const title = titleOf(session, sessionId)
    if (filled(title)) event.title = title
    const origin = originOf(session, sessionId)
    if (origin !== undefined) event.origin = origin
    return event
  }

  /**
   * 完成事件的去重身份：**优先用 turn 号**（`turn/end` 与 `api-session/status` 两条来源
   * 都能拿到同一个 turn 号，所以天然只报一次）；拿不到 turn 号才退回周期号。
   * @param sessionId 会话 id。
   * @returns 去重键。
   */
  function completionKey(sessionId) {
    const turn = lastTurn.get(sessionId)
    if (typeof turn === 'number') return sessionId + '|c|t' + turn
    return sessionId + '|c|r' + (cycles.get(sessionId) ?? 0)
  }

  /**
   * 失败事件的去重身份：同一个 turn 只报一条（`api-session/error` 先到，
   * `turn/end reason=error` 后到，两者必须算成同一个键）。
   * @param sessionId 会话 id。
   * @param message 失败消息。
   * @returns 去重键。
   */
  function failureKey(sessionId, message) {
    const turn = lastTurn.get(sessionId)
    if (typeof turn === 'number') return sessionId + '|f|t' + turn
    return sessionId + '|f|m' + hashText(message)
  }

  /**
   * 造完成事件。
   * @param sessionId 会话 id。
   * @param session 会话对象（可能拿不到）。
   * @param durationMs 耗时；取不到就省略。
   */
  function completionEvent(sessionId, session, durationMs) {
    const event = { kind: 'completion', sessionId, key: completionKey(sessionId), source: 'host' }
    if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
      event.durationMs = Math.max(0, Math.round(durationMs))
    }
    return decorate(event, session, sessionId)
  }

  /**
   * 造失败事件。
   * @param sessionId 会话 id。
   * @param session 会话对象（可能拿不到）。
   * @param message 失败消息（可为空串，此时省略字段）。
   * @param reason 附加原因（如 `blocked`），可为空。
   */
  function failureEvent(sessionId, session, message, reason) {
    const text = filled(message) ? message : undefined
    const event = {
      kind: 'failure',
      sessionId,
      key: failureKey(sessionId, text ?? ''),
      source: 'host',
    }
    if (text !== undefined) event.message = text
    if (filled(reason)) event.reason = reason
    return decorate(event, session, sessionId)
  }

  // ── 接缝 1：api-session/status（完成边沿） ──────────────────────────────────

  /**
   * `api-session/status(sessionId, running)` —— emit，全局广播。
   * 只在**状态变化**时 emit（真机实测：一个 subagent 的完整生命周期恰好 2 次），
   * 所以 `true→false` 就是完成。
   * 本监听器整体 try/catch：emit 型 dispatch **不包含**监听器异常
   * （`cordis/lib/index.js:280-282` 是裸 `map`），抛出去会打断 DSH 自己的调用栈。
   */
  function onSessionStatus(sessionId, runningFlag) {
    try {
      const id = filled(sessionId) ? sessionId : ''
      if (id === '') return
      const next = runningFlag === true
      const previous = running.get(id)
      if (previous === next) return
      running.set(id, next)

      if (next) {
        // 新周期：周期号 +1，并清掉上一周期残留的收尾原因（否则会误吞本周期）。
        cycles.set(id, (cycles.get(id) ?? 0) + 1)
        startedAt.set(id, safeNow())
        lastReason.delete(id)
        return
      }

      // ── `true → false` 边沿 ──
      const reason = lastReason.get(id)
      if (reason === 'error') return // 失败通道已经报过，别再补一条"完成"
      if (typeof reason === 'string' && SILENT_REASONS.includes(reason)) return

      const began = startedAt.get(id)
      startedAt.delete(id)
      const duration = typeof began === 'number' ? Math.max(0, safeNow() - began) : undefined
      report(completionEvent(id, undefined, duration))
    } catch (error) {
      degradeOnce('listener:api-session/status', 'api-session/status 观测失败 — ' + describe(error))
    }
  }

  // ── 接缝 2：api-session/error（失败） ───────────────────────────────────────

  /**
   * `api-session/error(sessionId, message)` —— emit，全局广播，`message` 是用户可读的失败链。
   * 真机时序：`dsh-agent-loop/lib/index.js:877-885` 先 `agent/error`
   * （→ `dsh-api-session-controller/lib/index.js:2887-2889` 转成 `api-session/error`），
   * 之后 `finally`（同文件 1025-1034）才 append `turn/end`。
   */
  function onSessionError(sessionId, message) {
    try {
      const id = filled(sessionId) ? sessionId : ''
      if (id === '') return
      const text = typeof message === 'string' ? message : ''
      const open = openTurn.get(id)
      // 只有确实处在一个打开的 turn 里时，才把本周期标记成"已失败"，
      // 免得会话外失败（激活失败等）误吞掉下一条合法的完成提醒。
      if (open !== undefined) lastReason.set(id, 'error')
      report(failureEvent(id, undefined, text, undefined))
    } catch (error) {
      degradeOnce('listener:api-session/error', 'api-session/error 观测失败 — ' + describe(error))
    }
  }

  // ── 接缝 3：session/event（turn/start / turn/end 真值源） ───────────────────

  /**
   * `session/event(session, event)` —— post-commit 会话日志追加流。
   * 真机实测（Lead 探针 2026-10-01）：根上下文收得到，`event.type` 里看得到
   * `turn/start` / `turn/end` / `tool/call` / `session/title`。
   *
   * 这条接缝给了两个 `api-session/status` 给不了的东西：
   *  - **耗时**：`turn/end.time - turn/start.time`（两个事件都带 `time: Date.now()`）；
   *  - **收尾原因**：`turn/end.data.reason.kind`，用来区分"真完成 / 报错 / 被按停"。
   *
   * `Session.append()` 把监听器异常按个兜住了（`dsh-session/lib/index.js:1228-1236`），
   * 但仍然整段 try/catch——观测代码不该有"靠别人兜底"的假设。
   * @param session 会话对象。
   * @param event 已提交的会话事件。
   */
  function onSessionEvent(session, event) {
    try {
      if (event === null || typeof event !== 'object') return
      const sessionId = idOf(session)
      if (sessionId === '') return
      const type = event.type

      if (type === 'turn/start') {
        const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
        const turn = typeof data.turn === 'number' ? data.turn : undefined
        if (turn !== undefined) lastTurn.set(sessionId, turn)
        openTurn.set(sessionId, { turn, time: typeof event.time === 'number' ? event.time : safeNow() })
        // 新 turn 开始：上一轮的收尾原因立刻作废。
        lastReason.delete(sessionId)
        return
      }

      if (type !== 'turn/end') return

      const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
      const reason = data.reason !== null && typeof data.reason === 'object' ? data.reason : {}
      const kind = typeof reason.kind === 'string' ? reason.kind : ''

      const started = openTurn.get(sessionId)
      openTurn.delete(sessionId)
      let duration
      if (
        started !== undefined &&
        typeof event.time === 'number' &&
        typeof started.time === 'number' &&
        Number.isFinite(event.time) &&
        Number.isFinite(started.time)
      ) {
        duration = Math.max(0, event.time - started.time)
      }

      lastReason.set(sessionId, kind)

      if (kind === 'error') {
        // `turn/end reason=error` 与 `api-session/error` 共用一个去重键：
        // 先到的报，后到的算重复。通常 api-session/error 先到。
        const failure = reason.error !== null && typeof reason.error === 'object' ? reason.error : {}
        const message = typeof failure.message === 'string' ? failure.message : ''
        report(failureEvent(sessionId, session, message, 'error'))
        return
      }
      if (SILENT_REASONS.includes(kind)) return
      if (!COMPLETION_REASONS.includes(kind) && kind !== '') {
        // 未来 DSH 新增了收尾原因：出声一次，并**保守地仍然当完成**——
        // 宁可多提醒，也不要静默丢掉一条"任务停下来了"。
        degradeOnce('turn/end:unknown-reason', '收到未知的 turn/end 收尾原因 ' + JSON.stringify(kind) + '，按完成处理')
      }
      report(completionEvent(sessionId, session, duration))
    } catch (error) {
      degradeOnce('listener:session/event', 'session/event 观测失败 — ' + describe(error))
    }
  }

  // ── 接缝 4/5：两条 waterfall（审批 / 提问） ─────────────────────────────────

  /**
   * `approval/request(req, next)` —— waterfall。
   * `req = { agent, toolName, callId?, reason?, displayReason?, signal? }`
   * （`dsh-user-approval/lib/index.js:176` 的派发点）。
   *
   * 结构见文件头：观测全在 try 里，`next()` 无条件透传。
   * @param req 审批请求。
   * @param next 下游链。
   * @returns `next()` 的原样返回值。
   */
  function onApprovalRequest(req, next) {
    try {
      const request = req !== null && typeof req === 'object' ? req : {}
      const sessionId = idOf(request.agent)
      const toolName = filled(request.toolName) ? request.toolName : ''
      const callId = filled(request.callId) ? request.callId : ''
      const rawReason = filled(request.reason) ? request.reason : ''

      if (sessionId === '') {
        degradeOnce('approval:no-session', '审批请求没有 agent，无法确定会话（仍会转发，不产出提醒）')
      } else {
        // 展示用理由：`reason` 缺失时退回 `displayReason`（多语言对象，先 zh 再 en），
        // 否则卡片上只剩工具名，用户看不出在审批什么。
        const reason = rawReason !== '' ? rawReason : displayReasonText(request.displayReason)
        // 去重键**只用原始 reason**，与 client.js:606 的拼法逐字一致，
        // 这样页面通道与宿主通道同时到达时上层能用同一个键去重。
        const key = sessionId + '|' + (callId !== '' ? callId : toolName + '|' + hashText(rawReason))
        const event = { kind: 'approval', sessionId, key, source: 'host' }
        if (toolName !== '') event.toolName = toolName
        if (filled(reason)) event.reason = reason
        const session = sessionOf(sessionId)
        report(decorate(event, session, sessionId))
      }
    } catch (error) {
      degradeOnce('listener:approval/request', '审批观测失败（已吞掉，审批链不受影响） — ' + describe(error))
    }
    // ⚠️ 必须无条件透传：不调用 next() 会截断瀑布 = 真机审批卡死。
    return next()
  }

  /**
   * `user-questions/request(request, next)` —— waterfall。
   * `request = { questions, agent?, signal?, wait? }`
   * （`dsh-user-questions/lib/index.js:681-684` 的派发点；**agent 是可选的**，
   * 无 agent 时那条派发连 scope carrier 都没有）。
   *
   * 结构同上：观测全在 try 里，`next()` 无条件透传。
   * @param request 提问请求。
   * @param next 下游链。
   * @returns `next()` 的原样返回值。
   */
  function onQuestionsRequest(request, next) {
    try {
      const req = request !== null && typeof request === 'object' ? request : {}
      const questions = Array.isArray(req.questions) ? req.questions : []
      const first = questions.length > 0 && questions[0] !== null && typeof questions[0] === 'object' ? questions[0] : {}
      const text = filled(first.question) ? first.question : filled(first.header) ? first.header : ''
      const wait = req.wait !== null && typeof req.wait === 'object' ? req.wait : {}
      const callId = filled(wait.callId) ? wait.callId : ''
      const sessionId = idOf(req.agent)

      if (sessionId === '') {
        // 真机上 `ask()` 的 agent 是可选的（dsh-tool-ask-user 在 exec.agent 缺失时
        // 就不会带上 agent）。这时我们**拿不到会话身份**，无法编造，只能出声说明。
        degradeOnce('question:no-session', '提问请求没有 agent，无法确定会话（已出声；提醒仍会发出，sessionId 为空串）')
      }

      // 去重键与 client.js:637 逐字一致。
      const key = sessionId + '|q|' + (callId !== '' ? callId : hashText(text) + '|' + String(questions.length))
      const event = { kind: 'question', sessionId, key, source: 'host' }
      if (text !== '') event.question = text
      // `questionCount` 是**权威字段**（冻结接口定义）。
      event.questionCount = questions.length
      // `count` 只是**兼容别名**，值恒等于 `questionCount`：仓库现有的卡片渲染读的是
      // `event.count`（client.js:376）。消费者请以 `questionCount` 为准，`count` 不保证长期保留。
      event.count = questions.length
      const session = sessionOf(sessionId)
      report(decorate(event, session, sessionId))
    } catch (error) {
      degradeOnce('listener:user-questions/request', '提问观测失败（已吞掉，提问链不受影响） — ' + describe(error))
    }
    // ⚠️ 必须无条件透传：不调用 next() 会让"提问"永远等不到回答者。
    return next()
  }

  /**
   * 从 `displayReason`（`{ en: string, [locale]: string }`）里挑一条可读理由。
   * @param source 多语言理由对象。
   * @returns 理由字符串，取不到时空串。
   */
  function displayReasonText(source) {
    if (source === null || typeof source !== 'object') return ''
    try {
      if (filled(source.zh)) return source.zh
      if (filled(source.en)) return source.en
      for (const key of Object.keys(source)) {
        if (filled(source[key])) return source[key]
      }
    } catch {
      /* 敌意对象 */
    }
    return ''
  }

  // ── 注册 ────────────────────────────────────────────────────────────────────

  /**
   * 注册一条监听器。`ctx.on` 不存在时**出声**（而不是安静地什么都不做）。
   * @param name 事件名。
   * @param listener 监听器。
   * @param options Cordis 监听器选项（透传；只给两条 waterfall 用 `{ prepend: true }`）。
   */
  function listen(name, listener, options) {
    if (ctx === null || typeof ctx !== 'object' || typeof ctx.on !== 'function') {
      degradeOnce('ctx.on:missing', '运行上下文没有 ctx.on，无法注册 ' + name + ' 监听器（宿主侧提醒将不会触发）')
      return
    }
    try {
      // `ctx.on(name, fn, options)` 是宿主侧 Cordis 的正规签名（`cordis/lib/index.js:371-380`），
      // 与客户端 `ctx.remote.$on` 不同，**接受** options。
      const disposer = options === undefined ? ctx.on(name, listener) : ctx.on(name, listener, options)
      if (typeof disposer === 'function') {
        disposers.push(disposer)
      } else {
        // `ctx.on` 在 `internal/listener` 被别的钩子 bail 掉时会返回那个值而不是注销函数
        // （`cordis/lib/index.js:375-376` 的 `if (result) return result`）。
        // 目前没有这样的钩子，但"注册看似成功、其实没挂上"是典型的静默失败，必须出声。
        degradeOnce(
          'ctx.on:not-registered:' + name,
          '注册 ' + name + ' 监听器没有返回注销函数（被 internal/listener 钩子拦下？），该事件不会触发提醒',
        )
      }
    } catch (error) {
      degradeOnce('ctx.on:' + name, '注册 ' + name + ' 监听器失败 — ' + describe(error))
    }
  }

  // emit 型：全局广播、没有链，**不需要** prepend（保持注册顺序不动，避免无谓的行为变化）。
  listen('api-session/status', onSessionStatus)
  listen('api-session/error', onSessionError)
  listen('session/event', onSessionEvent)

  // ⚠️ 两条 waterfall **必须** `prepend: true` —— 这是真机抓到的坑，不是风格问题。
  //
  // `cordis/lib/index.js:317-325` 的 waterfall 是**按注册顺序串链**：
  //     const next = () => { return (cbs.shift() ?? inner)(...args); };
  // 任何一个监听器不调用 `next()` 就截断整条链。
  // 而把这两条事件转发给浏览器、`await` 用户作答的宿主侧 answerer 是官方的
  // `dsh-api-remotes`（`dsh-api-remotes/lib/index.js:147-157` 注册，**不带 prepend**），
  // 它拿到请求后走 `forwardWaterfall`（同文件 `215-232`），在拿到浏览器答案的那条路径上
  // **直接 resolve 并 return，从不调用 `next()`**。
  //
  // 官方包在加载顺序上早于本插件 ⇒ 不 prepend 的话我们排在链条**末尾** ⇒ 真机上永远轮不到我们：
  // 用户看到通知弹了，但 `sensors.question` 是 0（通知是页面中继发的，不是宿主传感器）。
  //
  // `prepend` 让我们成为链条的**最外层包装**：先观测、再 `return next()` 把控制权原样交回原来的链。
  // 我们不在场时的行为与被调用时的行为完全一致（我们只读、不写 `req`、不吞返回值）。
  // 唯一新增的风险是"我们抛异常"，而观测体已整体 try/catch ⇒ 原有的不变式仍然成立。
  // 官方自己也用这个手法插到链首（`cordis/lib/index.js:246-249` 的 `{ global: true, prepend: true }`）。
  listen('approval/request', onApprovalRequest, { prepend: true })
  listen('user-questions/request', onQuestionsRequest, { prepend: true })

  // 子智能体事件**照发**并带 `origin: "subagent"`：本传感器只负责观测，
  // "要不要提醒"是上层的策略（用户定稿是"一律不提醒"，那条判断在 index.js 的 deliver 里）。
  // 传感器不在这里过滤，是为了让计数如实反映"看到了多少事件"。

  // ── 对外接口（冻结） ────────────────────────────────────────────────────────

  /**
   * 读计数器快照。每次返回**新对象**，调用方改它不会污染内部状态。
   * @returns `{ completion, approval, question, failure, deduped, lastError? }`。
   */
  function stats() {
    const snapshot = {
      completion: counters.completion,
      approval: counters.approval,
      question: counters.question,
      failure: counters.failure,
      deduped: counters.deduped,
    }
    if (lastError !== undefined) snapshot.lastError = lastError
    return snapshot
  }

  /**
   * 注销全部监听并清空状态。**幂等**——HMR 会反复重载插件，泄漏会翻车。
   * 第二次及以后调用直接返回，不重复执行任何注销。
   */
  function dispose() {
    if (disposed) return
    disposed = true
    for (const disposer of disposers.splice(0)) {
      try {
        disposer()
      } catch (error) {
        // 注销失败也要出声，但只走 console：此时调用方的 log 可能已经拆了。
        try {
          console.warn('[donevoice] 注销监听器失败 — ' + describe(error))
        } catch {
          /* 什么都不做也不能抛 */
        }
      }
    }
    running.clear()
    cycles.clear()
    lastTurn.clear()
    openTurn.clear()
    lastReason.clear()
    startedAt.clear()
    seen.clear()
    warned.clear()
  }

  return { stats, dispose }
}
