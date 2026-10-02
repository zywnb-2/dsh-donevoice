/**
 * dsh-donevoice 安装/卸载脚本（默认**只预演，不写盘**）。
 *
 * ## 为什么需要它
 * 本插件不发布到 npm，也不带 node_modules。DSH 的 profile 用 pnpm 的 `link:` 协议安装本地包，
 * 于是"装插件"这件事就是三件可逆的小事：
 *   1. profile 的 package.json 里加一条 `"dsh-donevoice": "link:<本插件绝对路径>"`
 *   2. 把 `dsh-donevoice` 追加进 `dsh.profile.bundles`（决定它进入 Loader 组合）
 *   3. 在 profile 的 node_modules 下建一个指向本插件目录的 junction（Windows）/ symlink
 * 再加上本插件自带的 `cordis.patch.yml`（`dsh.bundle.patch` 指向它），宿主条目 `donevoice`
 * 就会被插进 Loader 树。**profile 自己的 cordis.patch.yml 不需要改动**。
 *
 * ## 为什么默认不写盘
 * 桌面进程正在运行。写完文件后，**新的 JS 代际必须重启桌面进程才会被加载**
 * （dsh-plugin-manager README 原文：Package replacements require restarting the process to
 * load a fresh JavaScript module generation）。重启会中断你正在用的界面，所以：
 * 先 `node install.mjs` 看清楚要动哪几个文件，确认后再 `node install.mjs --apply`。
 *
 * ## 用法
 *   node install.mjs                      # 预演（默认）：只打印计划，不写任何文件
 *   node install.mjs --apply              # 执行安装（写 profile package.json + 建 junction）
 *   node install.mjs --uninstall          # 预演卸载
 *   node install.mjs --uninstall --apply  # 执行卸载
 *   node install.mjs --profile <目录>     # 指定别的 profile 目录
 *
 * 卸载是精确可逆的：只删本插件自己加的那一条依赖、那一个 bundles 项、那一个 junction，
 * 其余内容原样保留，并且每次写盘前都会先备份 package.json。
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本插件根目录（脚本所在目录）。 */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
/** 本插件的包名。 */
const PACKAGE_NAME = 'dsh-donevoice'
/** 宿主 Loader 条目 id（= 设置命名空间）。 */
const ENTRY_ID = 'donevoice'

/** 解析命令行参数。 */
function parseArgs(argv) {
  const args = { apply: false, uninstall: false, profile: undefined, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--apply') args.apply = true
    else if (token === '--uninstall') args.uninstall = true
    else if (token === '--help' || token === '-h') args.help = true
    else if (token === '--profile') { args.profile = argv[index + 1]; index += 1 }
    else if (token.startsWith('--profile=')) args.profile = token.slice('--profile='.length)
    else throw new Error('未知参数：' + token)
  }
  return args
}

/** 打印用法。 */
function usage() {
  console.log([
    '用法：',
    '  node install.mjs                      预演安装（默认，不写盘）',
    '  node install.mjs --apply              执行安装',
    '  node install.mjs --uninstall          预演卸载',
    '  node install.mjs --uninstall --apply  执行卸载',
    '  node install.mjs --profile <目录>     指定 profile（默认自动在 $DSH_HOME/profiles 下找；DSH_HOME 优先于 ~/.dsh）',
  ].join('\n'))
}

/**
 * 定位 profile 目录。
 *
 * **为什么不能只写死 `profiles/desktop`**：那是本机这台机器的名字。换一台电脑（这正是
 * "打包给任何人用"要过的关），profile 可能叫别的名字，或者用户设了 `DSH_HOME`。
 * 写死的后果是：装进一个不存在的目录、报错还指不到原因。
 * 所以这里按"**能不能装**"来选，而不是按名字猜：
 *   1. `--profile` 显式给的一律优先（不做任何猜测）；
 *   2. `DSH_HOME` 环境变量优先于 `~/.dsh`；
 *   3. 在 `<home>/profiles/*` 里找**含 package.json 且带 `dsh.profile.bundles` 数组**的目录；
 *      恰好一个 → 用它；多个 → 优先名为 `desktop` 的，否则取最近修改的那个并出声说明；
 *      一个都没有 → **报错退出**并给出 `--profile` 用法，绝不静默造目录。
 * @param explicit 命令行显式给出的路径。
 * @returns 绝对路径。
 * @throws 找不到任何可用 profile 时抛错（由入口统一转成友好提示）。
 */
function resolveProfile(explicit) {
  if (explicit !== undefined && explicit !== '') return resolve(explicit)

  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  const home = fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
  const profilesRoot = join(home, 'profiles')

  /** @type {{dir: string, at: number}[]} */
  const candidates = []
  let names = []
  try {
    names = readdirSync(profilesRoot)
  } catch {
    names = []
  }
  for (const name of names) {
    const dir = join(profilesRoot, name)
    const manifestPath = join(dir, 'package.json')
    try {
      if (statSync(dir).isDirectory() !== true) continue
      if (existsSync(manifestPath) !== true) continue
      const manifest = readJson(manifestPath)
      // 判据：一定要有 dsh.profile.bundles —— 那才是一个能被安装的 profile，而不是别的目录。
      if (Array.isArray(manifest?.dsh?.profile?.bundles) !== true) continue
      candidates.push({ dir, at: statSync(manifestPath).mtimeMs })
    } catch {
      // 读不动的候选直接跳过（权限、坏 JSON），不影响其它候选
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      '找不到可安装的 profile（在 ' + profilesRoot + ' 下没有"含 package.json 且带 dsh.profile.bundles"的目录）。\n' +
      '       请显式指定：node install.mjs --apply --profile "<你的 profile 目录>"\n' +
      '       （DSH_HOME 也可用来指定 .dsh 的位置，当前用的是 ' + home + '）',
    )
  }

  const named = candidates.find((entry) => basename(entry.dir) === 'desktop')
  if (named !== undefined) return named.dir

  candidates.sort((left, right) => right.at - left.at)
  if (candidates.length > 1) {
    console.log('[提示] 找到 ' + candidates.length + ' 个 profile，自动选了最近改动的那个：' + candidates[0].dir)
    console.log('       要装到别的上面请用 --profile 指定。')
  }
  return candidates[0].dir
}

/**
 * 读 JSON 文件。
 * @param path 文件路径。
 * @returns 解析后的对象。
 */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * 写入 JSON（2 空格缩进 + 结尾换行，尽量贴合原文件风格）。
 * @param path 文件路径。
 * @param value 对象。
 */
function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

/**
 * 安装主体。
 * @param options `{ profile, apply }`。
 */
function install(options) {
  const packageJsonPath = join(options.profile, 'package.json')
  const modulesDir = join(options.profile, 'node_modules')
  const linkPath = join(modulesDir, PACKAGE_NAME)
  const linkTarget = PLUGIN_DIR.replace(/\\/g, '/')

  const steps = []
  const problems = []
  /** 提示（不阻断安装）：像"路径不含 .dsh"这种只是长相问题，不该拦人。 */
  const notes = []

  if (!existsSync(packageJsonPath)) problems.push('profile 的 package.json 不存在：' + packageJsonPath)
  // ⚠️ 这里曾经把"路径不含 .dsh"当成**阻断性**问题。后果：DSH_HOME 自定义成 `D:\DSH` 这类
  //    路径的用户会被直接挡住，而且**没有 --force 可以绕过**——模拟"陌生人首次安装"时抓到的。
  //    真正能证明"这是个可安装 profile"的是 `dsh.profile.bundles`（下面就会检查），
  //    路径长相只是长相，不该决定能不能装。
  if (options.profile.indexOf('.dsh') < 0) {
    notes.push('profile 路径不含 .dsh（' + options.profile + '）：自定义 DSH_HOME 很常见，继续安装')
  }

  let manifest = null
  if (problems.length === 0) {
    manifest = readJson(packageJsonPath)
    if (manifest.dependencies?.[PACKAGE_NAME] === 'link:' + linkTarget) {
      steps.push({ kind: 'skip', text: 'dependencies 已有 ' + PACKAGE_NAME + ' → link:' + linkTarget })
    } else {
      steps.push({ kind: 'edit', text: 'package.json: dependencies["' + PACKAGE_NAME + '"] = "link:' + linkTarget + '"' })
    }
    const bundles = manifest.dsh?.profile?.bundles
    if (Array.isArray(bundles) !== true) {
      problems.push('profile 的 package.json 里没有 dsh.profile.bundles 数组')
    } else if (bundles.includes(PACKAGE_NAME)) {
      steps.push({ kind: 'skip', text: 'dsh.profile.bundles 已包含 ' + PACKAGE_NAME })
    } else {
      steps.push({ kind: 'edit', text: 'package.json: dsh.profile.bundles += "' + PACKAGE_NAME + '"' })
    }
  }

  const linkExists = existsSync(linkPath)
  if (linkExists) {
    const stat = lstatSync(linkPath)
    if (stat.isSymbolicLink() !== true && stat.isDirectory() !== true) {
      problems.push('目标已存在且不是目录/链接，拒绝覆盖：' + linkPath)
    } else {
      steps.push({ kind: 'skip', text: 'node_modules/' + PACKAGE_NAME + ' 已存在（link 或目录）' })
    }
  } else {
    steps.push({ kind: 'link', text: '建立链接：' + linkPath + '  →  ' + linkTarget })
  }

  console.log('== 安装计划 ==')
  console.log('插件目录   ：' + PLUGIN_DIR)
  console.log('profile    ：' + options.profile)
  console.log('包名 / 条目：' + PACKAGE_NAME + ' / ' + ENTRY_ID)
  console.log('')
  for (const step of steps) {
    console.log('  [' + step.kind.padEnd(4) + '] ' + step.text)
  }
  console.log('')
  console.log('  宿主条目由本插件自带的 cordis.patch.yml 插入（id: ' + ENTRY_ID + '），')
  console.log('  profile 自己的 cordis.patch.yml 不会被改动。')
  for (const note of notes) {
    console.log('')
    console.log('  · ' + note)
  }

  if (problems.length > 0) {
    console.log('')
    for (const problem of problems) console.log('  ⚠ ' + problem)
    console.log('')
    console.log('安装中止：存在需要人工确认的问题。')
    process.exitCode = 2
    return
  }

  if (options.apply !== true) {
    console.log('')
    console.log('以上为预演。确认无误后执行：node install.mjs --apply')
    console.log('（写入前会自动备份 package.json 为 package.json.donevoice-backup-<时间戳>）')
    return
  }

  // ── 真正写盘 ────────────────────────────────────────────────────────────────
  const backup = packageJsonPath + '.donevoice-backup-' + new Date().toISOString().replace(/[:.]/g, '-')
  copyFileSync(packageJsonPath, backup)
  console.log('已备份 package.json → ' + backup)

  const next = readJson(packageJsonPath)
  next.dependencies = next.dependencies ?? {}
  next.dependencies[PACKAGE_NAME] = 'link:' + linkTarget
  next.dsh = next.dsh ?? {}
  next.dsh.profile = next.dsh.profile ?? {}
  const bundles = Array.isArray(next.dsh.profile.bundles) ? next.dsh.profile.bundles : []
  if (bundles.includes(PACKAGE_NAME) !== true) bundles.push(PACKAGE_NAME)
  next.dsh.profile.bundles = bundles
  writeJson(packageJsonPath, next)
  console.log('已更新 ' + packageJsonPath)

  if (existsSync(linkPath) !== true) {
    mkdirSync(modulesDir, { recursive: true })
    try {
      symlinkSync(PLUGIN_DIR, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      console.error('建立链接失败：' + String(error))
      // junction 是用户级操作，**不需要管理员**（旧文案写错了，审计时抓到的）。
      console.error('可手动执行（普通 PowerShell 即可，无需管理员）：')
      console.error('  New-Item -ItemType Junction -Path "' + linkPath + '" -Target "' + PLUGIN_DIR + '"')
      process.exitCode = 3
      return
    }
    console.log('已建立链接 ' + linkPath)
  }

  console.log('')
  console.log('== 安装完成，下一步 ==')
  console.log('  1. 重启 DSH 桌面进程（新的 JS 代际必须重启才会被加载）。')
  console.log('  2. 重启后验证宿主半区活着（端口就是 DSH 界面地址栏里那个端口，各人可能不同）：')
  console.log('       curl http://127.0.0.1:<你的 DSH 端口>/plugins/dsh-donevoice/health.json')
  console.log('     期望 200 且 body 形如 {"ok":true,"plugin":"dsh-donevoice",...}')
  console.log('  3. 在浏览器里确认客户端 bundle 被服务：devtools 执行')
  console.log('       __DSH_BOOT__.entries.map(e => e.id)   // 应含 "dsh-donevoice"')
  console.log('  4. 打开「设置 → 提醒」→ 打开「总开关」（默认是关的）→ 可选开「页内卡片」。')
  console.log('     然后在别的窗口用 DSH 跑个任务，任务结束时右下角应当弹出系统通知 + 提示音。')
  console.log('  5. 出问题就回滚：node install.mjs --uninstall --apply')
}

/**
 * 卸载主体。
 * @param options `{ profile, apply }`。
 */
function uninstall(options) {
  const packageJsonPath = join(options.profile, 'package.json')
  const linkPath = join(options.profile, 'node_modules', PACKAGE_NAME)

  if (!existsSync(packageJsonPath)) {
    console.log('profile 的 package.json 不存在：' + packageJsonPath + ' —— 无需卸载')
    return
  }
  const manifest = readJson(packageJsonPath)
  const hasDependency = Object.prototype.hasOwnProperty.call(manifest.dependencies ?? {}, PACKAGE_NAME)
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const hasBundle = bundles.includes(PACKAGE_NAME)
  const hasLink = existsSync(linkPath)

  console.log('== 卸载计划 ==')
  console.log('  删除依赖项：' + (hasDependency ? '是' : '否（本来就是干净的）'))
  console.log('  删除 bundles 项：' + (hasBundle ? '是' : '否'))
  console.log('  删除链接：' + linkPath + (hasLink ? '' : '（不存在）'))
  console.log('  只动这三处，其余原样保留。')

  if (options.apply !== true) {
    console.log('')
    console.log('以上为预演。确认无误后执行：node install.mjs --uninstall --apply')
    return
  }

  const backup = packageJsonPath + '.donevoice-backup-' + new Date().toISOString().replace(/[:.]/g, '-')
  copyFileSync(packageJsonPath, backup)
  const next = readJson(packageJsonPath)
  if (hasDependency) delete next.dependencies[PACKAGE_NAME]
  if (hasBundle) next.dsh.profile.bundles = bundles.filter((entry) => entry !== PACKAGE_NAME)
  writeJson(packageJsonPath, next)
  if (hasLink) {
    // 解析后的绝对路径已在上方打印过，这里只删这一个链接本身（rmSync 默认不跟随 symlink 删除目标）
    rmSync(linkPath, { recursive: true, force: true })
  }
  console.log('已备份 → ' + backup)
  console.log('卸载完成。重启 DSH 桌面进程后生效。')
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  usage()
} else {
  let profile
  try {
    // profile 定位失败（换机器 / 自定义 DSH_HOME / 没有 profile）要给人话，不要抛栈。
    profile = resolveProfile(args.profile)
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error))
    process.exit(2)
  }
  const options = { profile, apply: args.apply }
  console.log('（' + (args.apply ? '执行模式：会写入文件' : '预演模式：不会写入任何文件') + '）')
  if (args.uninstall) uninstall(options)
  else install(options)
}
