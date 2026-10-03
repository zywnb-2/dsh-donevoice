/**
 * DoneVoice 的**配置契约**（零依赖纯模块）。
 *
 * 硬规则（与 dsh-settings 的"任何非法输入一律回落默认值而绝不抛异常"同口径）：
 *   normalizeConfig() 对任何输入都必须返回一个**完整、合法**的配置对象，永不抛异常。
 *   损坏的 patch、恶意 PUT、旧版本残留字段，都不能让页面渲染不出来。
 *
 * 字段清单遵循一条口径：**只留"用户真的会想调"的**。
 * 被砍掉的一律变成硬行为而不是藏起来的开关：
 *   · 总开关开着 ⇒ 四类提醒全都提醒（走开时系统通知 + 音效，强制）；
 *   · 子智能体（`origin === 'subagent'`）**一律不提醒**，连开关都不给；
 *   · "完成/审批/提问/失败"四类各自开关、投递档位枚举 —— 整体删除。
 *
 * ## 一条**死逻辑**（用户定稿，别把它做成可调项）
 *
 * **边框光效的时长 = 通知音效的时长**，没有第二个数。
 * 它既不是固定值、也不是可调项：音效响多久，边框就亮多久。
 * 所以这里**刻意没有** `glowDurationSec` 之类的字段——想改边框时长就去换音效。
 * 音效的真实时长由宿主量出来（`win-native.js` 的 `audioDurationMs`），
 * 随 `sounds.json` 交给页面；页面只在"量不出来 / 静音"时才用兜底值。
 */

/**
 * 四类提醒的**强调色**（唯一真相）。
 *
 * 为什么它属于"配置契约"：这些颜色现在有**三个消费方** ——
 *   ① 宿主系统通知的图标（`win-native.js` 的 `TOAST_ICONS`）
 *   ② 宿主原生覆盖层的卡片竖条（`index.js` 的 `resolvePresentation`）
 *   ③ 页面右下角卡片的图标（`client.js` 的 `ICON_SVG`）
 * 各写一份的后果就是"同一个『完成』，三处三个绿"（真发生过：`#2EA043` / `#34c77b` / DSH token）。
 * 放到这里 + 客户端内联副本由 `scripts/check-config-contract.mjs` 守着，才能保证永远是同一个值。
 */
export const ACCENT_COLORS = Object.freeze({
  completion: '#2EA043', // 绿：跑完了
  approval: '#D29922', //   琥珀：等你许可
  question: '#4D6BFE', //   蓝：等你回答
  failure: '#F85149', //    红：出错了
  test: '#4D6BFE', //       测试用（与提问同色）
})

/** 开关类字段。 */
export const BOOLEAN_FIELDS = Object.freeze([
  'enabled', //  总开关：关掉则一切静默（设置页里它单独一块、优先级最高）
  'pageCard', // 页内卡片：只在你正看着 DSH 时生效（默认关：我在工作状态，提醒多余）
  'edgeGlow', // 边框光效：仅在 `noticeStyle === 'topCard'` 时有意义（默认关：满屏彩色很抢眼）
  'pageSound', // 页内音效：在 DSH 页面上**也**响一次（默认关 —— 原定稿是"在页面上保持安静"）
])

/**
 * 枚举字段及其合法取值。
 *
 * 投递策略**已经不是一个可选项，而是固定行为**（用户定稿）：
 *   · **不在 DSH 页面上** ⇒ 系统通知 + 音效，**强制**，没有关掉它的开关；
 *   · **在 DSH 页面上**   ⇒ 永不弹系统通知、不响音效（"我在工作状态，能看到任务，提醒多余"）；
 *     页面内只有一个可选动作：`pageCard` 开着才出卡片。
 *
 * 历史：曾经有过 `delivery` 枚举（`system` / `always` / `auto` / `toast`），已按用户要求**整体删除**——
 * 其中 `toast` 那档会让"走开时必须有系统弹窗"失效，与定稿语义直接冲突。
 * 旧配置里的 `delivery` 字段会被 `normalizeConfig` 丢弃（它只处理自己认识的字段）。
 */
export const ENUM_FIELDS = Object.freeze({
  /**
   * 通知形式：**两种形态并存、可切换**（用户定稿）。
   *   · `card`    —— 右下角页内卡片（原有形态，默认；装上不改变任何既有观感）
   *   · `topCard` —— 顶部中间的提醒卡片（果冻弹出），可叠加「边框光效」
   * 两者的**投递语义完全一致**，只是换了一层皮：点卡片都跳回对应会话。
   */
  noticeStyle: Object.freeze(['card', 'topCard']),
  /**
   * 提示音：**插件自带的 48 个真实音效**（`sounds/*.mp3` + `sounds/*.wav`）+ 用户自己导入的 + `none` 静音。
   *
   * ⚠️ 这份清单现在只作为**自带的默认集合**（用于客户端离线时的回落列表）。
   * 合法值的判定已改成**按 id 语法**（见 `isSoundId`）——因为用户可以自由导入/删除音效，
   * 静态枚举没法涵盖用户的集合；"这个 id 到底能不能播"由宿主扫盘决定
   * （`win-native.js` 的 `listSounds` / `soundFileFor`，探针里能直接看到）。
   * （历史：以前是 8 套运行时**合成**的音效；改成收录真实音效后，合成器整体删掉了。）
   */
  soundPreset: Object.freeze([
    'bell', 'ping', 'ping2', 'notify1', 'notify2', 'notify3', 'type20', 'msgping',
    'new017', 'new018', 'new02', 'new027', 'new03', 'positive', 'system02',
    'ethereal_notify', 'ethereal_message', 'ethereal_error', 'notify_clean', 'dingdong', 'chime2', 'shortmsg', 'popup',
    'prompt', 'error', 'deny', 'click', 'toggle', 'mechanical_click', 'bubble', 'marimba',
    'arcade_powerup', 'kalimba', 'laser_zap', 'typewriter', 'pluck_bass', 'celesta', 'coin', 'sonar_ping',
    'wood_tock', 'warp_sweep', 'heartbeat', 'ringtone_retro', 'glass_ping', 'step_click', 'bass_drop', 'sparkle_arp',
    'mute_tap',
    'none',
  ]),
})

/** 提示音 id 的合法语法：与 win-native.js 的 SOUND_ID_PATTERN 必须保持一致。 */
export const SOUND_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/

/**
 * 提示音 id 是否合法（`none` 也合法，表示静音）。
 * @param value - 候选 id。
 * @returns 合法返回 true。
 */
export function isSoundId(value) {
  if (typeof value !== 'string') return false
  const id = value.trim().toLowerCase()
  return id === 'none' || SOUND_ID_PATTERN.test(id)
}

/** 枚举字段的回落值。 */
export const ENUM_FALLBACK = Object.freeze({
  soundPreset: 'bell',
  noticeStyle: 'card',
})

/**
 * 数值字段的边界与默认值（闭区间，取整）。
 *
 * 三个 `glow*` 的取值范围沿用设计原型里那三个滑条的实测区间
 * （原型是设计期产物，不随仓库发布；那三个滑条就是用来把参数调到手感对的）：
 *   · `glowFade`      —— 羽化宽度，px。太小像贴了条硬边，太大整屏发灰。
 *   · `glowIntensity` —— 浓度，%。100 = 原型里那版观感。
 *   · `glowSpeed`     —— 流速，%。100 = 原型默认（一圈 7.5s）。
 */
export const NUMBER_FIELDS = Object.freeze({
  durationSec: Object.freeze({ min: 3, max: 30, fallback: 6 }),
  cardDurationSec: Object.freeze({ min: 3, max: 30, fallback: 6 }),
  volume: Object.freeze({ min: 0, max: 100, fallback: 70 }),
  maxStack: Object.freeze({ min: 1, max: 10, fallback: 4 }),
  glowFade: Object.freeze({ min: 16, max: 110, fallback: 46 }),
  glowIntensity: Object.freeze({ min: 30, max: 100, fallback: 100 }),
  glowSpeed: Object.freeze({ min: 30, max: 220, fallback: 100 }),
})

/** 工厂默认值（宿主 schema 的 default 与客户端内联副本必须与此一致）。 */
export const DEFAULT_CONFIG = Object.freeze({
  // ⚠️ 全默认关闭（用户定稿）：总开关关着。语义是"装上先安静，要用自己开"——
  //    总开关没打开时，界面上其它开关全部变灰且不可点。
  enabled: false,
  pageCard: false,
  // 新形态的两个开关同样默认关：**装上不改变既有观感**。
  edgeGlow: false,
  pageSound: false,
  // 通知形式默认沿用原有的右下角卡片（换成顶部卡片是用户主动的选择）。
  noticeStyle: 'card',
  // 下面这些不在设置页显示的字段仍是配置字段：手改 config.json 依然生效，取值也仍会被夹紧。
  durationSec: 6,
  cardDurationSec: 6,
  volume: 70,
  maxStack: 4,
  glowFade: 46,
  glowIntensity: 100,
  glowSpeed: 100,
  soundPreset: 'bell',
})

/**
 * 把任意数值夹到闭区间并取整。
 * @param value - 待归一的候选值。
 * @param min - 下界（含）。
 * @param max - 上界（含）。
 * @param fallback - 非法输入时的回落值。
 * @returns 合法整数。
 */
export function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * 把任意输入归一化成完整配置。
 * 未知字段丢弃；类型不符回落默认；数值夹到边界；字符串 trim 后比对合法枚举。
 * @param raw - 任意来源的候选配置（可能为 null / 非对象 / 损坏）。
 * @returns 完整合法的配置对象（新对象，绝不修改入参）。
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const field of BOOLEAN_FIELDS) {
    out[field] = typeof source[field] === 'boolean' ? source[field] : DEFAULT_CONFIG[field]
  }
  for (const field of Object.keys(ENUM_FIELDS)) {
    const allowed = ENUM_FIELDS[field]
    // 大小写不敏感：手改配置文件时写成 "BELL" / "TOPCARD" 也该认账。
    const candidate = typeof source[field] === 'string' ? source[field].trim().toLowerCase() : ''
    // ⚠️ 比对必须**两边都小写**，并且**回写清单里那个写法**（canonical），
    //    不能把输入原样存下去。`noticeStyle` 的值是 camelCase 的 `topCard`：
    //    只把输入小写成 `topcard`、却拿它去比 `topCard`，会永远比不中 ⇒
    //    "这个字段怎么设都回落默认值"。这一条是对拍脚本第一次跑就抓出来的。
    const canonical = allowed.find((item) => item.toLowerCase() === candidate)
    // `soundPreset` 是**开放式**字段：用户可以导入任意 id 的音效，所以按语法判定，
    // 不要求出现在上面那份静态清单里（那份只是自带的默认集合）。
    out[field] = field === 'soundPreset'
      ? (isSoundId(candidate) ? candidate : ENUM_FALLBACK[field])
      : (canonical !== undefined ? canonical : ENUM_FALLBACK[field])
  }
  for (const field of Object.keys(NUMBER_FIELDS)) {
    const spec = NUMBER_FIELDS[field]
    out[field] = clampInt(source[field], spec.min, spec.max, spec.fallback)
  }
  return out
}
