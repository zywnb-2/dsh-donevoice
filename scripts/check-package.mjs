#!/usr/bin/env node
/**
 * 发布自检：验证包结构与本地复制安装流程（不替代 GitHub 连通性和真机启动测试）。
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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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

// ------------------------------------------------- README 里的版本号

section('README 安装命令的版本号')
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
const wanted = `#v${pkg.version}`
if (readme.includes(wanted)) {
  ok('README 指向当前版本', wanted)
} else {
  const found = [...new Set([...readme.matchAll(/#v(\d+\.\d+\.\d+)/g)].map((m) => m[0]))]
  fail(
    'README 指向的不是当前版本',
    found.length > 0
      ? `README 里是 ${found.join('、')}，当前版本是 ${wanted}；发版脚本会一起改，手改时别漏`
      : `README 里找不到 ${wanted}，安装章节的 tag 可能被改坏了`,
  )
}

// 「版本对应与升级」表里那一格是裸版本号（没有 #），发版脚本单独改它；
// 漏改的后果是安装命令写着新版本、表格却还写旧版本，用户不知道信哪个。
if (readme.includes(`| **${pkg.version}** |`)) {
  ok('README 版本对应表', `**${pkg.version}**`)
} else {
  const row = /^\|\s*\*\*(\d+\.\d+\.\d+)\*\*\s*\|/m.exec(readme)?.[1]
  fail(
    'README 版本对应表的版本号不是当前版本',
    row ? `表格里是 **${row}**，当前版本是 **${pkg.version}**` : '找不到 `| **<版本号>** |` 形式的表格行',
  )
}

// 站内锚点：改写标题会让 `](#旧锚点)` **静默**失效——渲染出来照常是个链接，点了没反应。
// 真踩过：把「方式 A（推荐）：一行装完」改成别的标题后，「怎么升级」里的链接就指空了。
// 按 GitHub 的 slug 规则（小写、去掉标点、空格转连字符）校验一遍。
const slug = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-')
const headings = new Set([...readme.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])))
const anchors = [...readme.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1])
const deadAnchors = anchors.filter((anchor) => !headings.has(anchor))
if (deadAnchors.length === 0) {
  ok('README 站内锚点', `${anchors.length} 个全部有效`)
} else {
  fail('README 站内锚点失效', `${deadAnchors.join('、')}；标题被改过就会这样，链接要跟着改`)
}

// README 里的本地图片：路径写错在 GitHub 上只是「图裂」，不报错，很容易一直没人发现。
// 只校验相对路径（外链跳过），并剥掉可能存在的 #anchor。
const images = [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)]
  .map((m) => m[1].trim())
  .filter((src) => !/^(?:https?:)?\/\//i.test(src))
const missingImages = images.filter((src) => !existsSync(join(ROOT, src.replace(/^\.\//, '').split('#')[0])))
if (missingImages.length === 0) {
  ok('README 图片', images.length > 0 ? `${images.length} 个本地图片都在` : '无本地图片引用')
} else {
  fail('README 图片路径失效', `${missingImages.join('、')}；在 GitHub 上会显示成图裂`)
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

// ------------------------------------------------- 本地 ZIP 安装路径（隔离 profile）

section('本地 ZIP 安装脚本（隔离 profile，不修改真实 DSH）')
// 测试目录在 .workbuddy-ai 下：installer 复制源码时跳过它，避免把测试目录复制进自身。
const testRoot = join(ROOT, '.workbuddy-ai')
mkdirSync(testRoot, { recursive: true })

// 上一次自检若被中断（Ctrl-C、超时被杀、编辑器里点了停止），下面的隔离目录会留在
// .workbuddy-ai 下——里面是一份完整的插件源码副本，约 2 MB。攒几次就是几十兆，
// 而且它被 .gitignore 挡着，`git status` 里完全看不见，很容易一直没人发现。
// 所以每次开跑前先扫一遍：只删**超过 1 小时**的，避免误伤正在并行跑的另一次自检。
const STALE_TEST_HOME_MS = 60 * 60 * 1000
for (const entry of readdirSync(testRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith('check-install-')) continue
  const stale = join(testRoot, entry.name)
  try {
    if (Date.now() - statSync(stale).mtimeMs > STALE_TEST_HOME_MS) rmSync(stale, { recursive: true, force: true })
  } catch {
    // 清不掉就算了：这是清理副产品，不该因为它挡住真正的自检结论。
  }
}

const testHome = mkdtempSync(join(testRoot, 'check-install-'))
const testProfile = join(testHome, 'profiles', 'desktop')
const testLink = join(testProfile, 'node_modules', pkg.name)
const testCopy = join(testHome, 'donevoice', 'plugin')
const testEnv = { ...process.env, DSH_HOME: testHome }
const installScript = join(ROOT, 'install.mjs')
const runInstall = (...args) => execFileSync(process.execPath, [installScript, '--profile', testProfile, ...args], {
  cwd: ROOT,
  env: testEnv,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 20_000,
})
const samePath = (left, right) => {
  const normalize = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  return normalize(left) === normalize(right)
}
try {
  mkdirSync(testProfile, { recursive: true })
  writeFileSync(join(testProfile, 'package.json'), JSON.stringify({
    name: 'donevoice-install-check',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }))
  runInstall('--apply')
  const installed = JSON.parse(readFileSync(join(testProfile, 'package.json'), 'utf8'))
  if (!lstatSync(testLink).isSymbolicLink() || !samePath(realpathSync(testLink), testCopy)
    || !installed.dsh.profile.bundles.includes(pkg.name)
    || !installed.dependencies[pkg.name]?.startsWith('link:')) {
    throw new Error('复制模式未写好链接 / dependencies / bundles')
  }
  ok('默认复制安装', '<DSH_HOME>/donevoice/plugin + profile/node_modules 链接')

  runInstall('--link', '--apply')
  if (!samePath(realpathSync(testLink), ROOT)) throw new Error('--link 模式未指向源码目录')
  runInstall('--apply')
  if (!samePath(realpathSync(testLink), testCopy)) throw new Error('切回复制模式时旧链接没有重新指向副本')
  if (existsSync(join(testCopy, '.workbuddy-ai'))) throw new Error('把 .workbuddy-ai 工作数据复制到了插件副本')
  ok('切换安装模式', '--link ↔ 默认复制，且不复制工作数据')

  runInstall('--uninstall', '--apply')
  const cleaned = JSON.parse(readFileSync(join(testProfile, 'package.json'), 'utf8'))
  if (existsSync(testLink) || cleaned.dependencies[pkg.name] || cleaned.dsh.profile.bundles.includes(pkg.name)) {
    throw new Error('卸载后 profile 仍有插件残留')
  }
  ok('隔离卸载', 'profile 依赖与链接均已清除')
} catch (error) {
  fail('本地 ZIP 安装脚本', `${error.message.split('\n')[0]}${error.stderr ? `；${String(error.stderr).trim().split('\n').slice(-1)[0]}` : ''}`)
} finally {
  // 若测试中断在 --link 模式，先摘掉 junction，绝不递归进入它指向的源码目录。
  try {
    const kind = lstatSync(testLink)
    if (!kind.isSymbolicLink()) throw new Error(`隔离目录里有非链接条目：${testLink}`)
    try { unlinkSync(testLink) } catch { rmdirSync(testLink) }
  } catch (error) {
    if (error.code !== 'ENOENT') fail('清理测试链接', String(error))
  }
  try {
    lstatSync(testLink) // 有残留时禁止递归清理测试目录，避免跟随链接损伤源码。
    fail('清理测试目录', `链接仍存在，保留隔离目录：${testHome}`)
  } catch (error) {
    if (error.code === 'ENOENT') rmSync(testHome, { recursive: true, force: true })
    else fail('清理测试目录', String(error))
  }
}

// --------------------------------------------- 本机私有路径（不该出现在公开仓库）

section('本机私有路径')
// 一行 YAML 示例里的真实路径，在 diff 里毫不起眼，但推上去就永久留在公开仓库和 git 历史里。
// 真漏过一次：NATIVE.md 的 hmr 示例里写着开发机的实际路径。
//
// ⚠️ 这里**刻意不维护「私有字符串黑名单」**。第一版就是那么写的——把开发机的目录名列进脚本里，
//    结果脚本自己成了泄漏源：为了检测某个私有名字而把它抄进公开仓库，等于帮倒忙。
//    所以改成**结构判断**：盘符绝对路径的**第一段**不在通用名单里，就视为「本机真实路径」。
const GENERIC_PATH_SEGMENTS = new Set([
  'users', 'windows', 'program files', 'program files (x86)', 'programdata',
  'path', 'to', 'public', 'temp', 'tmp', 'appdata', 'ds', 'dsh',
])
// 前一个字符不能是字母数字或连字符，否则会误伤 `dsh-app://app`、`https://…` 这类协议串。
const DRIVE_PATH = /(?<![-\w])[A-Za-z]:[\\/][^\s`"'|,;)\]}]*/g
const SCANNED_EXTENSIONS = /\.(?:md|js|mjs|json|yml|yaml|txt|svg|html|css)$/i

const trackedFiles = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean)
const suspiciousPaths = []
for (const rel of trackedFiles) {
  if (!SCANNED_EXTENSIONS.test(rel)) continue
  const text = readFileSync(join(ROOT, rel), 'utf8')
  for (const match of text.matchAll(DRIVE_PATH)) {
    const raw = match[0]
    const segments = raw.slice(2).split(/[\\/]+/).filter(Boolean)
    if (segments.length === 0) continue
    const head = segments[0].toLowerCase()
    if (!GENERIC_PATH_SEGMENTS.has(head)) {
      suspiciousPaths.push(`${rel} → ${raw}`)
      continue
    }
    // `C:\Users\<你>\…`（占位符）与 `C:\Users\Public\…`（系统）放行；
    // 换成真实用户名的写法就要拦——这是最容易漏的一类（Windows 用户名往往就是真名）。
    if (head === 'users' && segments.length > 1) {
      const user = segments[1]
      if (!user.startsWith('<') && user.toLowerCase() !== 'public') suspiciousPaths.push(`${rel} → ${raw}`)
    }
  }
}
if (suspiciousPaths.length === 0) {
  ok('无本机私有路径', `扫描 ${trackedFiles.length} 个被跟踪文件`)
} else {
  fail('检出疑似本机私有路径', `${[...new Set(suspiciousPaths)].join('；')}；改成 <你的…> 这类占位符再提交`)
}

// ---------------------------------------------------------------- 结论

console.log('')
if (notes.length > 0) {
  console.log('提示：')
  for (const note of notes) console.log(`  · ${note}`)
  console.log('')
}

if (failures.length === 0) {
  console.log(`\u2713 自检通过：${pkg.name}@${pkg.version} 包结构与本地复制安装正常（GitHub 网络及 DSH 实际启动须另验）`)
  process.exit(0)
}

console.error(`\u2717 自检失败 ${failures.length} 项：`)
for (const item of failures) console.error(`  · ${item}`)
process.exit(1)
