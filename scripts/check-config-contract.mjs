#!/usr/bin/env node
/**
 * 配置契约对拍：`host-config.js`（唯一真相） vs `client.js` 的**内联副本**。
 *
 * 为什么必须有这个脚本：`client.js` 是浏览器半区，跑在 DSH 的动态包闭包里，
 * **没法 `require('./host-config.js')`**，所以字段清单/默认值/边界只能手抄一份。
 * 手抄的漏改**不会报错**——客户端会静默走 fallback，表现成
 * 「我在设置页选了 A，重启又变回 B」或者「新加的字段怎么调都没反应」。
 *
 * ARCHITECTURE §5 早就把这条写成了承诺，但仓库里一直**没有对应的脚本**
 * （只有 `check-package.mjs` 管打包，不管配置）。这里把它补上。
 *
 * 检查三件事：
 *   1. `BOOLEAN_FIELDS` / `ENUM_FIELDS` / `ENUM_FALLBACK` / `NUMBER_FIELDS` 结构相等；
 *   2. `DEFAULT_CONFIG` 深度相等；
 *   3. 一批刁钻输入（undefined / null / 字符串 / 数组 / NaN / Infinity / 越界 / 大小写枚举 /
 *      未知字段 / 原型污染）逐条跑两边的 `normalizeConfig`，输出必须**逐字段相同**。
 *
 * 用法：node scripts/check-config-contract.mjs
 * 退出码：0 通过；1 有差异。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

function fail(label, detail) {
  failures.push(`${label}：${detail}`)
  console.log(`  \u2717 ${label} — ${detail}`)
}
function ok(label, detail = '') {
  console.log(`  \u2713 ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(title) {
  console.log(`\n${title}`)
}

// ------------------------------------------------------- 从 client.js 里抠出内联副本

const source = readFileSync(join(ROOT, 'client.js'), 'utf8')

/**
 * 从 `text` 的 `from` 位置起，找到配对的收尾括号（跳过字符串与注释）。
 *
 * ⚠️ 不能只数字符深度：这段代码里有注释、有正则、有含括号的字符串，
 * 裸深度计数会被它们带偏（而且偏了以后**静默**截错位置，比报错更危险）。
 * @param text 源码全文。
 * @param from 起始下标（必须是 `[` 或 `{`）。
 * @returns 收尾括号的下标（含）。
 */
function matchBracket(text, from) {
  const open = text[from]
  const close = open === '[' ? ']' : '}'
  let depth = 0
  let i = from
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i)
      i = end < 0 ? text.length : end
      continue
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i += 1
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue }
        if (text[i] === quote) break
        i += 1
      }
      i += 1
      continue
    }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return -1
}

/**
 * 抠出一个 `const <name> = [ ... ]` / `= { ... }` 的字面量源码。
 * @param name 变量名。
 * @returns 字面量源码（含括号）；找不到时抛异常（**不静默返回空**——静默会让对拍变成假通过）。
 */
function grabLiteral(name) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*(?:Object\\.freeze\\()?\\s*([\\[{])`)
  const m = re.exec(source)
  if (m === null) throw new Error(`client.js 里找不到 const ${name} =`)
  const at = m.index + m[0].length - 1
  const end = matchBracket(source, at)
  if (end < 0) throw new Error(`const ${name} 的括号没有配平`)
  return source.slice(at, end + 1)
}

/**
 * 抠出一个具名函数的完整源码（用括号配平找函数体结尾）。
 * @param name 函数名。
 * @returns 源码。
 */
function grabFunction(name) {
  const re = new RegExp(`function\\s+${name}\\s*\\(`)
  const m = re.exec(source)
  if (m === null) throw new Error(`client.js 里找不到 function ${name}`)
  const bodyStart = source.indexOf('{', m.index)
  const end = matchBracket(source, bodyStart)
  if (end < 0) throw new Error(`function ${name} 的括号没有配平`)
  return source.slice(m.index, end + 1)
}

const pieces = [
  `const ACCENT_COLORS = ${grabLiteral('ACCENT_COLORS')}`,
  `const BOOLEAN_FIELDS = ${grabLiteral('BOOLEAN_FIELDS')}`,
  `const ENUM_FIELDS = ${grabLiteral('ENUM_FIELDS')}`,
  `const ENUM_FALLBACK = ${grabLiteral('ENUM_FALLBACK')}`,
  `const NUMBER_FIELDS = ${grabLiteral('NUMBER_FIELDS')}`,
  `const DEFAULT_CONFIG = ${grabLiteral('DEFAULT_CONFIG')}`,
  `const SOUND_IDS = ${grabLiteral('SOUND_IDS')}`,
  'const SOUND_ID_PATTERN = ' + /const SOUND_ID_PATTERN = (\/.*\/[a-z]*)/.exec(source)[1],
  grabFunction('clampInt'),
  grabFunction('isSoundId'),
  grabFunction('normalizeConfig'),
  // client.js 里 `ENUM_FIELDS.soundPreset` 是在 SOUND_IDS 定义之后**赋值**上去的，
  // 抠字面量拿不到它，这里补回同一句，保证两边形状一致。
  'ENUM_FIELDS.soundPreset = SOUND_IDS',
]

let client
try {
  client = new Function(`${pieces.join('\n')}\nreturn { ACCENT_COLORS, BOOLEAN_FIELDS, ENUM_FIELDS, ENUM_FALLBACK, NUMBER_FIELDS, DEFAULT_CONFIG, normalizeConfig }`)()
} catch (error) {
  console.error(`\u2717 无法从 client.js 抠出内联配置副本：${String(error.message)}`)
  process.exit(1)
}

const host = await import('../host-config.js')

// ------------------------------------------------------------------ 结构对拍

section('字段清单与边界')

const sameArray = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

// 强调色：三个消费方（系统通知图标 / 原生覆盖层 / 页面卡片）共用这一份。
// 它漂了的后果是"同一个完成，三处三个绿" —— 肉眼能看出来，但不看代码找不到原因。
const hostAccentKeys = Object.keys(host.ACCENT_COLORS).sort()
const clientAccentKeys = Object.keys(client.ACCENT_COLORS).sort()
if (sameArray(hostAccentKeys, clientAccentKeys)) ok('ACCENT_COLORS 键集', hostAccentKeys.join(', '))
else fail('ACCENT_COLORS 键集不一致', `宿主 [${hostAccentKeys.join(', ')}] vs 客户端 [${clientAccentKeys.join(', ')}]`)
for (const key of hostAccentKeys) {
  if (host.ACCENT_COLORS[key] !== client.ACCENT_COLORS[key]) {
    fail(`ACCENT_COLORS.${key} 不一致`, `宿主 ${host.ACCENT_COLORS[key]} vs 客户端 ${client.ACCENT_COLORS[key]}；同一个状态在两处会显示成两个颜色`)
  }
}

if (sameArray(host.BOOLEAN_FIELDS, client.BOOLEAN_FIELDS)) {
  ok('BOOLEAN_FIELDS', `[${host.BOOLEAN_FIELDS.join(', ')}]`)
} else {
  fail('BOOLEAN_FIELDS 不一致', `宿主 [${host.BOOLEAN_FIELDS.join(', ')}] vs 客户端 [${client.BOOLEAN_FIELDS.join(', ')}]`)
}

const hostEnumKeys = Object.keys(host.ENUM_FIELDS).sort()
const clientEnumKeys = Object.keys(client.ENUM_FIELDS).sort()
if (sameArray(hostEnumKeys, clientEnumKeys)) ok('ENUM_FIELDS 键集', hostEnumKeys.join(', '))
else fail('ENUM_FIELDS 键集不一致', `宿主 [${hostEnumKeys.join(', ')}] vs 客户端 [${clientEnumKeys.join(', ')}]`)

for (const key of hostEnumKeys) {
  if (!sameArray(host.ENUM_FIELDS[key], client.ENUM_FIELDS[key] ?? [])) {
    fail(`ENUM_FIELDS.${key} 取值不一致`, `宿主 [${host.ENUM_FIELDS[key].join(', ')}] vs 客户端 [${(client.ENUM_FIELDS[key] ?? []).join(', ')}]`)
  }
}

const hostFallbackKeys = Object.keys(host.ENUM_FALLBACK).sort()
const clientFallbackKeys = Object.keys(client.ENUM_FALLBACK).sort()
if (sameArray(hostFallbackKeys, clientFallbackKeys)) ok('ENUM_FALLBACK 键集', hostFallbackKeys.join(', '))
else fail('ENUM_FALLBACK 键集不一致', `宿主 [${hostFallbackKeys.join(', ')}] vs 客户端 [${clientFallbackKeys.join(', ')}]`)
for (const key of hostFallbackKeys) {
  if (host.ENUM_FALLBACK[key] !== client.ENUM_FALLBACK[key]) {
    fail(`ENUM_FALLBACK.${key} 不一致`, `宿主 ${host.ENUM_FALLBACK[key]} vs 客户端 ${client.ENUM_FALLBACK[key]}`)
  }
}

const hostNumberKeys = Object.keys(host.NUMBER_FIELDS).sort()
const clientNumberKeys = Object.keys(client.NUMBER_FIELDS).sort()
if (sameArray(hostNumberKeys, clientNumberKeys)) ok('NUMBER_FIELDS 键集', hostNumberKeys.join(', '))
else fail('NUMBER_FIELDS 键集不一致', `宿主 [${hostNumberKeys.join(', ')}] vs 客户端 [${clientNumberKeys.join(', ')}]`)
for (const key of hostNumberKeys) {
  const a = host.NUMBER_FIELDS[key]
  const b = client.NUMBER_FIELDS[key]
  if (b === undefined || a.min !== b.min || a.max !== b.max || a.fallback !== b.fallback) {
    fail(`NUMBER_FIELDS.${key} 边界不一致`, `宿主 ${JSON.stringify(a)} vs 客户端 ${JSON.stringify(b)}`)
  }
}

// 默认值必须覆盖每一个已声明的字段（少一个就是"这个字段没有默认值"）。
const declared = [...host.BOOLEAN_FIELDS, ...hostEnumKeys, ...hostNumberKeys].sort()
const defaultKeys = Object.keys(host.DEFAULT_CONFIG).sort()
if (sameArray(declared, defaultKeys)) ok('DEFAULT_CONFIG 覆盖全部字段', `${defaultKeys.length} 个`)
else fail('DEFAULT_CONFIG 字段集与声明不符', `声明 [${declared.join(', ')}] vs 默认 [${defaultKeys.join(', ')}]`)

if (JSON.stringify(host.DEFAULT_CONFIG) === JSON.stringify(client.DEFAULT_CONFIG)) {
  ok('DEFAULT_CONFIG 深度相等')
} else {
  fail('DEFAULT_CONFIG 不一致', `宿主 ${JSON.stringify(host.DEFAULT_CONFIG)} vs 客户端 ${JSON.stringify(client.DEFAULT_CONFIG)}`)
}

// ------------------------------------------------------------------ 归一化对拍

section('归一化输出对拍（刁钻输入）')

const CASES = [
  ['undefined', undefined],
  ['null', null],
  ['字符串', 'nonsense'],
  ['数字', 42],
  ['数组', [1, 2, 3]],
  ['空对象', {}],
  ['布尔全错类型', { enabled: 'yes', pageCard: 1, edgeGlow: 0, pageSound: null }],
  ['数值 NaN', { durationSec: NaN, cardDurationSec: NaN, volume: NaN, glowFade: NaN }],
  ['数值 Infinity', { durationSec: Infinity, cardDurationSec: -Infinity, glowIntensity: Infinity }],
  ['数值越界', { durationSec: 9999, cardDurationSec: -5, volume: 101, maxStack: 0, glowFade: 500, glowSpeed: 1 }],
  ['数值小数', { durationSec: 7.6, cardDurationSec: 3.4, volume: 69.5, glowFade: 45.5 }],
  ['枚举大小写', { soundPreset: 'BELL', noticeStyle: 'TOPCARD' }],
  ['枚举非法', { soundPreset: '不合法 id', noticeStyle: 'glow' }],
  ['枚举空白', { soundPreset: '   ', noticeStyle: '  ' }],
  ['枚举合法', { soundPreset: 'new027', noticeStyle: 'topCard' }],
  ['用户导入的 id', { soundPreset: 'my_custom-sound_01' }],
  ['静音', { soundPreset: 'none' }],
  ['未知字段被丢弃', { enabled: true, hacker: 'x', __proto__: { polluted: true }, noticeStyle: 'topCard' }],
  ['全量合法', {
    enabled: true, pageCard: true, edgeGlow: true, pageSound: true, noticeStyle: 'topCard',
    durationSec: 12, cardDurationSec: 20, volume: 55, maxStack: 7,
    glowFade: 80, glowIntensity: 60, glowSpeed: 180, soundPreset: 'system02',
  }],
]

for (const [label, input] of CASES) {
  let a = null
  let b = null
  try {
    a = host.normalizeConfig(input)
  } catch (error) {
    fail(`宿主 normalizeConfig 抛异常（${label}）`, String(error.message))
    continue
  }
  try {
    b = client.normalizeConfig(input)
  } catch (error) {
    fail(`客户端 normalizeConfig 抛异常（${label}）`, String(error.message))
    continue
  }
  const ja = JSON.stringify(a)
  const jb = JSON.stringify(b)
  if (ja === jb) continue
  const diff = Object.keys(a).filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
  fail(`归一化结果不一致（${label}）`, `字段 [${diff.join(', ')}]：宿主 ${ja} vs 客户端 ${jb}`)
}

// 键顺序也要一致：客户端会用 `Object.keys(ENUM_FIELDS)` / `Object.keys(NUMBER_FIELDS)` 迭代，
// 顺序不同会让"哪个字段先被写进 out"不同，序列化出来的 config.json 也就不一样。
if (JSON.stringify(Object.keys(host.normalizeConfig({}))) === JSON.stringify(Object.keys(client.normalizeConfig({})))) {
  ok('归一化输出的键顺序一致')
} else {
  fail('归一化输出的键顺序不一致', '两边 Object.keys 顺序不同，落盘的 config.json 会长得不一样')
}

// 每个字段都要真的"能被改到"：拿默认值出发，逐个字段喂一个非默认值，输出必须跟着变。
// 这条专门抓"字段声明了但归一化时漏掉了"——那种漏法在别处完全看不出来。
const base = host.normalizeConfig({})
const probes = {
  enabled: true,
  pageCard: true,
  edgeGlow: true,
  pageSound: true,
  noticeStyle: 'topCard',
  durationSec: 11,
  cardDurationSec: 13,
  volume: 33,
  maxStack: 9,
  glowFade: 99,
  glowIntensity: 77,
  glowSpeed: 44,
  soundPreset: 'positive',
}
const dead = []
for (const [field, value] of Object.entries(probes)) {
  const out = host.normalizeConfig({ [field]: value })
  if (JSON.stringify(out[field]) !== JSON.stringify(value)) dead.push(`${field}（喂 ${JSON.stringify(value)} 得到 ${JSON.stringify(out[field])}）`)
  if (JSON.stringify(base[field]) === JSON.stringify(value)) dead.push(`${field} 的默认值就长这样，探针没意义`)
}
if (dead.length === 0) ok('每个字段都真的可写', `${Object.keys(probes).length} 个`)
else fail('有字段写了不生效', dead.join('；'))

// ------------------------------------------------------------------ 结论

console.log('')
if (failures.length === 0) {
  console.log(`\u2713 配置契约对拍通过：host-config.js 与 client.js 内联副本一致（${declared.length} 个字段，${CASES.length} 组输入）`)
  process.exit(0)
}
console.error(`\u2717 配置契约对拍失败 ${failures.length} 项：`)
for (const item of failures) console.error(`  · ${item}`)
process.exit(1)
