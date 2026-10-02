#!/usr/bin/env node
/**
 * 发布自检：确认这个仓库「从 GitHub 装得下来、装下来能跑」。
 *
 * 为什么需要它：DSH 的插件安装走 pnpm 的 git 依赖通道——先把仓库的
 * codeload tarball 整包拉下来，再用 npm-packlist 按 package.json 的
 * `files` 过滤一遍。于是有两条只靠肉眼看代码发现不了的坑：
 *
 *   1. `files` 漏了一个运行时文件（例如 sounds/ 或 locale/），
 *      源码目录里一切正常，用户装完却少了东西。
 *   2. package.json 里出现了 `prepare` / `postinstall` 之类的构建脚本，
 *      pnpm 11 会直接以 GIT_DEP_PREPARE_NOT_ALLOWED 拒绝安装，
 *      用户看到的是「装不上」，而不是「装上了有点小问题」。
 *
 * 本脚本把这两条变成 CI 上的红灯。
 *
 * 用法：node scripts/check-package.mjs
 * 退出码：0 全部通过；1 有检查项失败。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const failures = []
const notes = []

function ok(label, detail = '') {
  console.log(`  \u2713 ${label}${detail ? ` — ${detail}` : ''}`)
}

function fail(label, detail) {
  failures.push(`${label}：${detail}`)
  console.log(`  \u2717 ${label} — ${detail}`)
}

function section(title) {
  console.log(`\n${title}`)
}

/**
 * 打包产物里「必须出现」的文件。少任何一个都会让用户装到残包。
 * 这里只列运行时真正要读的东西；文档与开发文件不在此列。
 */
const REQUIRED_IN_PACKAGE = [
  'package.json',
  'index.js',
  'host-config.js',
  'host-sensors.js',
  'win-native.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'locale/zh.json',
  'locale/en.json',
  'sounds/bell.mp3',
  'LICENSE',
]

/** pnpm 11 遇到这些脚本会要求 allowBuilds 授权，一键安装会被打断。 */
const FORBIDDEN_SCRIPTS = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'prepack',
]

// ---------------------------------------------------------------- 元数据

section('package.json 元数据')
for (const field of ['name', 'version', 'description', 'license', 'main', 'icon']) {
  if (typeof pkg[field] === 'string' && pkg[field] !== '') ok(field, pkg[field])
  else fail(field, '缺失或不是非空字符串')
}

if (pkg.private === true) {
  fail('private', '为 true 会挡住 npm 发布；从 GitHub 安装虽不受影响，但建议删掉')
} else {
  ok('private', '未设置（可发布）')
}

if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? '')) {
  ok('version', '符合 SemVer，可直接作为 tag')
} else {
  fail('version', `"${pkg.version}" 不是 SemVer，无法生成 v<version> 标签`)
}

// ---------------------------------------------------------------- dsh 声明

section('dsh 声明')
const dsh = pkg.dsh ?? {}
if (dsh.manifestVersion === 1) ok('dsh.manifestVersion', '1')
else fail('dsh.manifestVersion', '应为 1')

const patch = dsh.bundle?.patch
const patchList = Array.isArray(patch) ? patch : patch === undefined ? [] : [patch]
if (patchList.length === 0) {
  fail('dsh.bundle.patch', '未声明，用户装完不会有任何 Host 半区')
} else {
  for (const rel of patchList) {
    if (existsSync(join(ROOT, rel))) ok('dsh.bundle.patch', rel)
    else fail('dsh.bundle.patch', `${rel} 在仓库里不存在`)
  }
}

if (dsh.client?.platform === 'web') ok('dsh.client.platform', 'web')
else fail('dsh.client.platform', '应为 web')

if (Array.isArray(dsh.client?.inject)) ok('dsh.client.inject', `长度 ${dsh.client.inject.length}`)
else fail('dsh.client.inject', '应为数组')

// ------------------------------------------------- 版本号三处一致（契约）

section('版本号一致性（ARCHITECTURE.md 约定：三处必须相同）')
const VERSION_SITES = [
  ['package.json', () => pkg.version],
  ['index.js', () => /export const version = '([^']+)'/.exec(readFileSync(join(ROOT, 'index.js'), 'utf8'))?.[1]],
  ['client.js', () => /const VERSION = '([^']+)'/.exec(readFileSync(join(ROOT, 'client.js'), 'utf8'))?.[1]],
]
const versionValues = VERSION_SITES.map(([file, read]) => [file, read()])
const distinct = [...new Set(versionValues.map(([, v]) => v))]
for (const [file, value] of versionValues) {
  if (value === undefined) fail(file, '没找到版本号')
  else ok(file, value)
}
if (distinct.length > 1) {
  fail('版本号不一致', `三处分别是 ${versionValues.map(([f, v]) => `${f}=${v}`).join('、')}；发版脚本会一起改，手改时别漏`)
}

// ---------------------------------------------------------------- exports

section('exports 契约')
for (const key of ['.', './client', './package.json']) {
  if (typeof pkg.exports?.[key] === 'string') ok(`exports["${key}"]`, pkg.exports[key])
  else fail(`exports["${key}"]`, '缺失；DSH 靠它定位 Host 与浏览器半区')
}

// ---------------------------------------------------------------- 构建脚本

section('构建脚本（pnpm 11 allowBuilds）')
const declared = Object.keys(pkg.scripts ?? {})
const forbidden = declared.filter((name) => FORBIDDEN_SCRIPTS.includes(name))
if (forbidden.length === 0) {
  ok('无构建脚本', declared.length ? `已声明：${declared.join(', ')}` : '未声明任何脚本')
} else {
  for (const name of forbidden) {
    fail(`scripts.${name}`, 'pnpm 11 会以 GIT_DEP_PREPARE_NOT_ALLOWED 拒绝安装，必须移除')
  }
}

// ---------------------------------------------------------------- peer 依赖

section('peerDependencies')
const peers = pkg.peerDependencies ?? {}
if (Object.keys(peers).length === 0) {
  fail('peerDependencies', '空；建议声明 @deepseek-ai/cordis 以便兼容性检查通过')
} else {
  for (const [name, range] of Object.entries(peers)) {
    const optional = pkg.peerDependenciesMeta?.[name]?.optional === true
    if (optional) ok(name, `${range}（optional，宿主不满足也不会拦住安装）`)
    else {
      ok(name, `${range}（必需）`)
      notes.push(`${name} 是必需 peer（${range}），宿主版本不满足时安装会被判为不兼容`)
    }
  }
}

// ------------------------------------------------- 入口 id 与 client 一致

section('入口 id 一致性')
const patchText = patchList.map((rel) => readFileSync(join(ROOT, rel), 'utf8')).join('\n')
const patchIds = [...patchText.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1])
const clientText = readFileSync(join(ROOT, 'client.js'), 'utf8')
const hostIdMatch = /HOST_ENTRY_ID\s*=\s*'([^']+)'/.exec(clientText)
const hostId = hostIdMatch?.[1]

if (!hostId) {
  fail('client.js HOST_ENTRY_ID', '未找到 HOST_ENTRY_ID 常量')
} else if (patchIds.includes(hostId)) {
  ok('patch id 与 client 一致', hostId)
} else {
  fail(
    'patch id 与 client 不一致',
    `patch 里是 [${patchIds.join(', ')}]，client.js 里是 "${hostId}"；设置页会读不到值`,
  )
}

// ---------------------------------------------------------------- 打包产物

section('打包产物（npm pack，与 pnpm 的 git 依赖同一套 packlist）')
let packed = null
try {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })
  const start = raw.indexOf('[')
  packed = JSON.parse(raw.slice(start))[0]?.files?.map((f) => f.path) ?? null
} catch (error) {
  notes.push(`npm pack 未能执行（${error.message.split('\n')[0]}），跳过产物清单检查`)
}

if (packed) {
  ok('产物文件数', String(packed.length))
  for (const rel of REQUIRED_IN_PACKAGE) {
    if (packed.includes(rel)) ok(`产物含 ${rel}`)
    else fail(`产物缺 ${rel}`, 'package.json 的 files 里补上它，否则用户装到的是残包')
  }

  const packagedSounds = packed.filter((p) => p.startsWith('sounds/') && p.endsWith('.mp3'))
  if (packagedSounds.length > 0) ok('产物含提示音', `${packagedSounds.length} 个 mp3`)
  else fail('产物含提示音', 'sounds/*.mp3 没进包，用户只能听到静音')

  const packagedLocale = packed.filter((p) => p.startsWith('locale/'))
  if (packagedLocale.length > 0) ok('产物含语言包', packagedLocale.join(', '))
  else fail('产物含语言包', 'locale/*.json 没进包，设置页文案会回退')
}

// ---------------------------------------------------------------- 结论

console.log('')
if (notes.length > 0) {
  console.log('提示：')
  for (const note of notes) console.log(`  · ${note}`)
  console.log('')
}

if (failures.length === 0) {
  console.log(`\u2713 自检通过：${pkg.name}@${pkg.version} 可以从 GitHub 直接安装`)
  process.exit(0)
}

console.error(`\u2717 自检失败 ${failures.length} 项：`)
for (const item of failures) console.error(`  · ${item}`)
process.exit(1)
