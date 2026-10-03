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
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/**
 * 从 `win-native.js` 里抠出提示音清单（`SOUND_FILES` 的 id → 文件名）。
 *
 * 为什么用正则读文本而不是 `import('./win-native.js')`：这个脚本的职责是"包结构对不对"，
 * 应该在**没有 DSH、没有装任何依赖**的干净环境里也能跑；而 `win-native.js` 是插件模块。
 * 抠不到就返回空对象，由调用方**判失败**——空清单会让下面那条逐项核对变成空转，
 * 那种"永远绿灯"的校验比没有校验更危险。
 * @returns id → 文件名的映射。
 */
function parseSoundFiles() {
  const src = readFileSync(join(ROOT, 'win-native.js'), 'utf8')
  const at = src.indexOf('export const SOUND_FILES = Object.freeze({')
  if (at < 0) return {}
  const end = src.indexOf('\n})', at)
  if (end < 0) return {}
  const out = {}
  for (const m of src.slice(at, end).matchAll(/([A-Za-z0-9_]+):\s*'([^']+)'/g)) out[m[1]] = m[2]
  return out
}

/** 提示音允许的扩展名（与 `win-native.js` 的 `SOUND_EXTS` 同一口径）。 */
const PACKED_SOUND_EXTS = ['.mp3', '.wav', '.m4a', '.wma', '.aac']

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
  // ⚠️ `win-overlay.cs` 是**运行时从插件目录读**的（`win-native.js` 的 `readOverlayScript()`，
  //    读成文本、拼进 worker 由 PowerShell 现场 `Add-Type` 编译）。
  //    它不在 `files` 里的后果不是"少个装饰"，而是**顶部提醒整个消失**，
  //    而且失败是静默的（只在日志里留一行 `overlay-source-missing`）。所以必须钉住。
  'win-overlay.cs',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'locale/zh.json',
  'locale/en.json',
  'sounds/bell.mp3',
  // 本地 ZIP 安装流程要用（从 GitHub 装的话用不到，但它在 `files` 里是**有意**的）。
  'install.mjs',
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

// ------------------------------------------------- 宿主半区不许 import 裸包名

section('宿主半区无裸包名 import（链接期炸点）')
// 为什么必须有这条：宿主半区**静态 import 任何裸包名**，一旦 profile 的 node_modules 里
// 没有它，就是**链接期错误** —— 整个宿主条目加载失败，表现成"插件装上去像没装"。
// 真机踩过一次（`@deepseek-ai/schemastery`，照 DSH 源码的官方写法来的），代价是整条原生通道不工作。
// 只有 `node:*` 内置模块与相对路径是安全的。
const HOST_HALF_FILES = ['index.js', 'host-config.js', 'host-sensors.js', 'win-native.js']
const bareImports = []
for (const rel of HOST_HALF_FILES) {
  const text = readFileSync(join(ROOT, rel), 'utf8')
  const specs = [
    ...[...text.matchAll(/^\s*(?:import|export)\b[^\n]*?\bfrom\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]),
    ...[...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]),
  ]
  for (const spec of specs) {
    if (spec.startsWith('.') || spec.startsWith('node:')) continue
    bareImports.push(`${rel} → ${spec}`)
  }
}
if (bareImports.length === 0) {
  ok('宿主半区只用 node:* 与相对导入', `${HOST_HALF_FILES.length} 个文件`)
} else {
  fail(
    '宿主半区出现了裸包名 import',
    `${bareImports.join('、')}；这在 profile 里是**链接期错误**，整个宿主条目会加载失败（插件看起来像没装）`,
  )
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

// ------------------------------------------------- 配置契约对拍（两份副本）

section('配置契约（host-config.js vs client.js 内联副本）')
// 单独一个脚本，因为它是**纯逻辑**检查、不需要打包；但放在这里跑是为了让本地
// 一条命令就能覆盖全部检查项，而不是"CI 上才知道红了"。
try {
  const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'check-config-contract.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  })
  const last = out.trim().split('\n').filter(Boolean).pop() ?? ''
  ok('两份副本一致', last.replace(/^\u2713\s*/, ''))
} catch (error) {
  const detail = String(error.stdout ?? '').trim().split('\n').filter(Boolean).slice(-4).join(' / ')
  fail('配置契约对拍失败', detail || String(error.message).split('\n')[0])
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

  // 提示音：**逐项核对清单里点名的文件**，而不是只数个数。
  //
  // 只数个数会漏掉最阴的一种残包：`files` 白名单里写的是 `sounds/*.mp3`，而后来收录的
  // 音效是 `.wav` —— 数量检查照样通过（mp3 那批还在），用户装完却是
  // 「设置页下拉里有这个音效、点了没声音」。所以两条判据都要：
  //   ① 产物里至少有提示音（防整个 sounds/ 掉出包）；
  //   ② `SOUND_FILES` 里点名的文件**逐个**都在产物里（防只掉了一部分 / 只掉了新增的那批）。
  const packagedSounds = packed.filter(
    (p) => p.startsWith('sounds/') && PACKED_SOUND_EXTS.includes(extname(p).toLowerCase()))
  if (packagedSounds.length > 0) {
    const byExt = PACKED_SOUND_EXTS
      .map((e) => [e, packagedSounds.filter((p) => p.toLowerCase().endsWith(e)).length])
      .filter(([, n]) => n > 0)
      .map(([e, n]) => `${n} 个 ${e.slice(1)}`)
      .join(' + ')
    ok('产物含提示音', byExt)
  } else {
    fail('产物含提示音', 'sounds/ 下的音频没进包，用户只能听到静音')
  }

  const soundFiles = parseSoundFiles()
  const soundIds = Object.keys(soundFiles)
  if (soundIds.length === 0) {
    fail('提示音清单', '没能从 win-native.js 里读出 SOUND_FILES —— 这条核对会变成空转，先修它')
  } else {
    const absent = soundIds.filter((id) => packed.includes(`sounds/${soundFiles[id]}`) !== true)
    if (absent.length === 0) ok('清单里的提示音全部在产物里', `${soundIds.length} 个，逐个核对`)
    else {
      fail('产物缺提示音', `${absent.map((id) => `${id}(${soundFiles[id]})`).join(', ')}`
        + ' —— package.json 的 files 里补上对应扩展名（例如 "sounds/*.wav"）')
    }
  }

  const packagedLocale = packed.filter((p) => p.startsWith('locale/'))
  if (packagedLocale.length > 0) ok('产物含语言包', packagedLocale.join(', '))
  else fail('产物含语言包', 'locale/*.json 没进包，设置页文案会回退')

  // ------------------------------------------------ export-ignore 不得误伤运行时文件
  //
  // `.gitattributes` 里的 `export-ignore` 决定**下载时拉什么**，`files` 决定**装完之后留什么**。
  // 两者一旦重叠，用户会装到**残包**：下载里没有那个文件，`files` 也就无从过滤。
  // 而且这种坏法是**静默**的——本地开发用的是完整工作区，一切正常，
  // 只有从 GitHub 装的人才会缺文件。所以必须在这里挡住。
  // 用 `git check-attr` 直接问"这个路径被 export-ignore 了吗"，比生成归档再比对更准
  // （归档读的是已提交的树，尚未提交的新文件会造成假报警）。
  if (packed.length > 0) {
    // ⚠️ **必须把每一级祖先目录也问一遍**。
    //    `git check-attr` 对"目录规则"只在**目录路径本身**返回 `set`，
    //    对目录里的文件返回 `unspecified` —— 而 `git archive` 是**真的**按目录规则排除的。
    //    实测：`.gitattributes` 里写了 `scripts/ export-ignore`，
    //      `git check-attr export-ignore -- scripts/check-package.mjs` → unspecified（骗人）
    //      `git archive` 里 `scripts/` 一个文件都没有（真的排除了）
    //    只问文件路径的话，`scripts/` `docs/` 这类目录规则会**整个漏过**这个守卫。
    const probes = []
    for (const rel of packed) {
      const parts = rel.split('/')
      for (let i = 1; i < parts.length; i += 1) probes.push(parts.slice(0, i).join('/') + '/')
      probes.push(rel)
    }
    let ignored = new Set()
    try {
      const raw = execFileSync('git', ['check-attr', '-z', 'export-ignore', '--', ...probes], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      // `-z` 输出是 `路径\0属性\0值\0` 三元组
      const parts = raw.split('\0')
      for (let i = 0; i + 2 < parts.length; i += 3) {
        if (parts[i + 2] === 'set' || parts[i + 2] === 'true') ignored.add(parts[i])
      }
    } catch (error) {
      ignored = null
      notes.push(`git check-attr 未能执行（${String(error.message).split('\n')[0]}），跳过 export-ignore 误伤检查`)
    }
    if (ignored !== null) {
      const hurt = packed.filter((rel) => {
        const parts = rel.split('/')
        for (let i = 1; i < parts.length; i += 1) if (ignored.has(parts.slice(0, i).join('/') + '/')) return true
        return ignored.has(rel)
      })
      if (hurt.length === 0) {
        ok('export-ignore 未误伤运行时文件', `${packed.length} 个产物路径（含各级父目录）全部未被排除`)
      } else {
        fail(
          'export-ignore 把运行时文件也排除了',
          `${hurt.join('、')}；下载包里会没有它们，从 GitHub 安装的用户会装到残包。把对应那几行从 .gitattributes 里删掉`,
        )
      }
    }
  }
}

// ------------------------------------------------- 本地 ZIP 安装路径（隔离 profile）

section('本地 ZIP 安装脚本（隔离 profile，不修改真实 DSH）')
// 隔离测试目录放**系统临时目录**，不落在工作区里。理由见下。
//
// 历史教训：它原来放在 `.workbuddy-ai/` 下，好处是 installer 复制源码时会跳过它。
// 但它是**机器产物**，一份完整插件副本 ≈4 MB：自检正常跑完会自己删掉，可一旦进程被
// 中断（Ctrl-C、超时被杀、CI 取消、被沙箱拦下），下面的 `finally` 就不会执行，
// 4 MB 当场落地。更麻烦的是它被 `.gitignore` 挡着，`git status` 里完全看不见——
// 实测攒过三个（≈12 MB），占了整个工作区一大半才被发现。
//
// 改放 `os.tmpdir()` 之后三件事一起成立：① 工作区永远干净；② 系统自己会回收临时目录；
// ③ 它本来就在工作区之外，installer 自然不会把它复制进插件副本（原注释担心的那点自动成立）。
const testRoot = tmpdir()
mkdirSync(testRoot, { recursive: true })

// 每次开跑前扫一遍，删掉**陈旧的**隔离目录：残留只要出现，就说明有进程没跑完 finally，
// 下次自检顺手带走即可。除了当前的临时目录，也回扫历史位置 `.workbuddy-ai/`，
// 让早期版本留下的残留自己消失，不用人工清。
//
// 阈值 `10` 分钟怎么来的：自检本体只需要几秒，10 分钟是 **100 倍**余量，
// 足够让并行跑的另一轮自检不被打断。
const STALE_TEST_HOME_MS = 10 * 60 * 1000
for (const dir of [testRoot, join(ROOT, '.workbuddy-ai')]) {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    continue // 目录不存在（例如历史位置已被清空）就跳过，这不是错误。
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('check-install-')) continue
    const stale = join(dir, entry.name)
    try {
      if (Date.now() - statSync(stale).mtimeMs > STALE_TEST_HOME_MS) rmSync(stale, { recursive: true, force: true })
    } catch {
      // 清不掉就算了：这是清理副产品，不该因为它挡住真正的自检结论。
    }
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
