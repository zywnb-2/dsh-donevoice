/**
 * DoneVoice 的**配置契约**（零依赖纯模块）。
 *
 * 硬规则（与 dsh-settings 的"任何非法输入一律回落默认值而绝不抛异常"同口径）：
 *   normalizeConfig() 对任何输入都必须返回一个**完整、合法**的配置对象，永不抛异常。
 *   损坏的 patch、恶意 PUT、旧版本残留字段，都不能让页面渲染不出来。
 *
 * ⚠️ 字段数量是被用户**按 UI 精简要求砍过的**：设置页现在只有两个开关
 * （总开关 + 页内卡片），所以"完成/审批/提问/失败"四类提醒、页内音效、子代理开关
 * 这些字段**整体删除**（不是藏起来）——它们的语义变成了硬行为：
 *   · 总开关开着 ⇒ 四类提醒全都提醒（走开时系统通知 + 音效，强制）；
 *   · 子智能体（`origin === 'subagent'`）**一律不提醒**，连开关都不给；
 *   · 页内音效没有开关 ⇒ 你在页面上时保持安静（要声音就切走，那条是强制的）。
 */

/** 开关类字段。 */
export const BOOLEAN_FIELDS = Object.freeze([
  'enabled', //  总开关：关掉则一切静默（设置页里它单独一块、优先级最高）
  'pageCard', // 页内卡片：只在你正看着 DSH 时生效的**唯一**可选开关（默认关：我在工作状态，提醒多余）
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
   * 提示音：**插件自带的 15 个真实音效**（`sounds/*.mp3`）+ 用户自己导入的 + `none` 静音。
   *
   * ⚠️ 这份清单现在只作为**自带的默认集合**（用于客户端离线时的回落列表）。
   * 合法值的判定已改成**按 id 语法**（见 `isSoundId`）——因为用户可以自由导入/删除音效，
   * 静态枚举没法涵盖用户的集合；"这个 id 到底能不能播"由宿主扫盘决定
   * （`win-native.js` 的 `listSounds` / `soundFileFor`，探针里能直接看到）。
   * （历史：以前是 8 套运行时**合成**的音效；改成收录真实音效后，合成器整体删掉了。）
   */
  soundPreset: Object.freeze([
    'bell', 'ping', 'ping2', 'notify1', 'notify2', 'notify3', 'type20', 'msgping',
    'new017', 'new018', 'new02', 'new027', 'new03', 'positive', 'system02', 'none',
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
})

/** 数值字段的边界与默认值（闭区间，取整）。 */
export const NUMBER_FIELDS = Object.freeze({
  durationSec: Object.freeze({ min: 3, max: 30, fallback: 6 }),
  volume: Object.freeze({ min: 0, max: 100, fallback: 70 }),
  maxStack: Object.freeze({ min: 1, max: 10, fallback: 4 }),
})

/** 工厂默认值（宿主 schema 的 default 与客户端内联副本必须与此一致）。 */
export const DEFAULT_CONFIG = Object.freeze({
  // ⚠️ 全默认关闭（用户定稿）：总开关关着。语义是"装上先安静，要用自己开"——
  //    总开关没打开时，界面上唯一的另一个开关（页内卡片）变灰且不可点。
  enabled: false,
  pageCard: false,
  // 下面三个不在设置页显示（用户要求"没有必要的选项一个都不显示"），
  // 但仍是配置字段：手改 config.json 依然生效，取值也仍然会被归一化夹紧。
  durationSec: 6,
  volume: 70,
  maxStack: 4,
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
    // 大小写不敏感：手改配置文件时写成 "BELL" 也该认账。
    const candidate = typeof source[field] === 'string' ? source[field].trim().toLowerCase() : ''
    // `soundPreset` 是**开放式**字段：用户可以导入任意 id 的音效，所以按语法判定，
    // 不要求出现在上面那份静态清单里（那份只是自带的默认集合）。
    out[field] = field === 'soundPreset'
      ? (isSoundId(candidate) ? candidate : ENUM_FALLBACK[field])
      : (allowed.includes(candidate) ? candidate : ENUM_FALLBACK[field])
  }
  for (const field of Object.keys(NUMBER_FIELDS)) {
    const spec = NUMBER_FIELDS[field]
    out[field] = clampInt(source[field], spec.min, spec.max, spec.fallback)
  }
  return out
}
