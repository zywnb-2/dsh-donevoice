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
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
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
  const args = { apply: false, uninstall: false, profile: undefined, link: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--apply') args.apply = true
    else if (token === '--uninstall') args.uninstall = true
    else if (token === '--link') args.link = true
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
    '  node install.mjs --link               开发模式：不复制，直接把 profile 链到本插件源码目录',
    '  node install.mjs --profile <目录>     指定 profile（默认自动在 $DSH_HOME/profiles 下找；DSH_HOME 优先于 ~/.dsh）',
    '',
    '安装位置（默认）：插件会被**复制**到 <DSH_HOME>/donevoice/plugin/，profile 里放一条指向它的链接。',
    '  也就是说装完之后，插件本体就在 C:\\Users\\<你>\\.dsh 里，和从 npm / GitHub 装的其它插件一样；',
    '  源码目录与安装结果**彻底解耦**——卸载只会删掉 .dsh 里那份副本，永远碰不到你的源码目录。',
    '  只有开发本插件时才用 --link（改一个文件即刻生效，代价是卸载可能连带删源码目录）。',
  ].join('\n'))
}

/**
 * DSH 的 home 目录（与宿主半区 `index.js` 的 `homeDir()` 同口径：`DSH_HOME` 优先，否则 `~/.dsh`）。
 * @returns 绝对路径。
 */
function resolveHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/**
 * 默认安装位置：`<home>/donevoice/plugin/`。
 *
 * 为什么要复制到这里，而不是让 profile 直接指向插件源码目录（今天的真机事故）：
 * 插件在 profile 里是一条 **junction**；DSH 卸载插件时如果"递归删除跟随链接"，
 * 就会把 junction 指向的整个目录清空——源码目录因此被删过一次。
 * 装进 `.dsh` 里之后，那个"会被连带删掉"的目录只是这份副本，
 * 与用户的源码目录彻底解耦；这也与从 npm / GitHub 安装的其它插件落点一致（都在 `.dsh` 内）。
 * @returns 绝对路径。
 */
function installTargetDir() {
  return join(resolveHome(), 'donevoice', 'plugin')
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
 * 把插件目录整棵复制到目标位置（跳过 `.git`、`node_modules` 与本地工作数据）。
 *
 * `.workbuddy-ai` 与 `.workbuddy` 都是"开发时托管 Agent 的工作目录"（两代 harness 各用各的名字），
 * 它们是本机私有数据、不属于插件产物 —— 一起跳过，免得每次安装都往 `.dsh` 里塞一份日志。
 * @param from 源目录。
 * @param to 目标目录（须已存在）。
 */
/** 备份保留份数：只留最近几次，避免每次安装/卸载都堆一份、只增不减。 */
const BACKUP_KEEP = 5

/**
 * 备份 `package.json`，并清理更早的历史备份。
 *
 * 为什么要有上限：安装与卸载每次写盘前都会备份一份，原先只增不减——实测攒到 30 多份，
 * 和 `package.json` 挤在同一层，`ls` 一眼看去全是备份。保留最近几份足够回滚，
 * 更早的没有价值（真要看历史还有 git）。
 * @param {string} packageJsonPath profile 目录下的 package.json。
 * @returns {string} 本次备份的路径。
 */
function backupPackageJson(packageJsonPath) {
  const backup = packageJsonPath + '.donevoice-backup-' + new Date().toISOString().replace(/[:.]/g, '-')
  copyFileSync(packageJsonPath, backup)
  // 文件名里带 ISO 时间戳（冒号与点已换成连字符），所以**按名字排序就是按时间排序**。
  const prefix = basename(packageJsonPath) + '.donevoice-backup-'
  const dir = dirname(packageJsonPath)
  let siblings = []
  try {
    siblings = readdirSync(dir)
  } catch {
    return backup // 读不了目录就只完成备份本身，别让轮转失败影响安装。
  }
  const expired = siblings.filter((name) => name.startsWith(prefix)).sort().slice(0, -BACKUP_KEEP)
  for (const name of expired) {
    try {
      rmSync(join(dir, name), { force: true })
    } catch {
      // 删不掉就算了：这是清理副产品，不该因为它挡住安装本身。
    }
  }
  return backup
}

function copyPluginTree(from, to) {
  for (const name of readdirSync(from)) {
    if (name === '.git' || name === '.workbuddy-ai' || name === '.workbuddy' || name === 'node_modules') continue
    const source = join(from, name)
    const target = join(to, name)
    if (statSync(source).isDirectory()) {
      mkdirSync(target, { recursive: true })
      copyPluginTree(source, target)
    } else {
      copyFileSync(source, target)
    }
  }
}

/**
 * 只摘掉一条链接本身，**绝不递归进入目标目录**。
 *
 * ⚠️ 这是今天真机事故的直接教训：插件在 profile 里是一条 junction，指向插件目录；
 * "递归删除"如果跟随了链接，就会把目标目录里的文件全部清空（用户源码目录被删过一次）。
 * 所以这里对链接一律只做 unlink / rmdir（摘掉重解析点），只有**真的是普通目录**时才递归删。
 * @param path 链接或目录路径。
 */
function removeLink(path) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    try {
      unlinkSync(path)
    } catch {
      rmdirSync(path)
    }
    return
  }
  if (stat.isDirectory()) {
    rmSync(path, { recursive: true, force: true })
    return
  }
  rmSync(path, { force: true })
}

/**
 * 解析链接当前指向哪里（拿不到就返回 null）。
 *
 * ⚠️ **返回 null 不代表"没有链接"**：断链（目标已被删掉）也会返回 null。
 * 判断"有没有东西在那儿"必须用 `entryKind`，不能用 `existsSync`——
 * `existsSync` 会跟着链接去解析，目标不存在就返回 false，
 * 于是"断链"和"什么都没有"被混成同一种，见 `entryKind` 的注释。
 * @param path 链接路径。
 * @returns 规范化后的绝对路径或 null。
 */
function linkTargetOf(path) {
  try {
    return resolve(realpathSync(path))
  } catch {
    return null
  }
}

/**
 * 看清 `path` 位置上**实际存在的是什么**，不跟随链接去解析目标。
 *
 * ⚠️ 这里必须用 `lstat`，不能用 `existsSync`。真机事故：
 * `install.mjs` 早先把插件复制到 `<DSH_HOME>/donevoice/plugin/` 并让 profile 指向那份副本；
 * 后来那份副本被删掉了，`node_modules/dsh-donevoice` 就成了一条**断链**。
 * 而 `existsSync` 对断链返回 `false` ⇒ 卸载计划里写的是「（不存在）」⇒ 谁都不去清它。
 * 后果是用户从 DSH 插件页装 GitHub 版时，pnpm 走到最后一步报：
 *
 *     [ERR_PNPM_EPERM] rename 'node_modules/dsh-donevoice_tmp_1_1' -> 'node_modules/dsh-donevoice'
 *
 * 界面上显示成「没有写入权限，无法安装」——一条断链伪装成了权限问题。
 * @param path 待探测的路径。
 * @returns `'link'` 符号链接/junction（含断链）、`'dir'` 普通目录、`'file'` 其它条目、`'missing'` 什么都没有。
 */
function entryKind(path) {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return 'link'
    if (stat.isDirectory()) return 'dir'
    return 'file'
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing'
    return 'file'
  }
}

/**
 * 读出链接**自己写的**目标路径（断链也读得到，`linkTargetOf` 读不到）。
 * @param path 链接路径。
 * @returns 原始目标字符串，读不到就返回 `'(读不到)'`。
 */
function rawLinkTarget(path) {
  try {
    return readlinkSync(path)
  } catch {
    return '(读不到)'
  }
}

/**
 * 安装主体。
 *
 * 两种模式：
 *   · **默认（复制）**：把插件复制到 `<DSH_HOME>/donevoice/plugin/`，profile 指向那份副本。
 *     与 npm / GitHub 安装的其它插件落点一致（都在 `.dsh` 内），且源码目录与安装结果解耦。
 *   · `--link`（开发）：profile 直接指向本插件源码目录，改一个文件即刻生效。
 * @param options `{ profile, apply, link }`。
 */
function install(options) {
  const packageJsonPath = join(options.profile, 'package.json')
  const modulesDir = join(options.profile, 'node_modules')
  const linkPath = join(modulesDir, PACKAGE_NAME)
  const copyMode = options.link !== true
  const copyDir = copyMode ? installTargetDir() : null
  const linkTarget = (copyMode ? copyDir : PLUGIN_DIR).replace(/\\/g, '/')

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
  if (copyMode) {
    steps.push({ kind: 'copy', text: '复制插件到 ' + copyDir + '（就在 .dsh 里，与你的源码目录解耦）' })
  } else {
    notes.push('--link 开发模式：profile 将直接指向源码目录 ' + PLUGIN_DIR + '；卸载时请确保该目录有备份（如 git）')
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

  const wantTarget = copyMode ? copyDir : PLUGIN_DIR
  let needsLink = false
  const linkKind = entryKind(linkPath)
  if (linkKind === 'missing') {
    steps.push({ kind: 'link', text: '建立链接：' + linkPath + '  →  ' + wantTarget })
    needsLink = true
  } else if (linkKind === 'link') {
    const current = linkTargetOf(linkPath)
    if (current === null) {
      // 断链：链接还在，目标没了。留着它会让 DSH 插件页装 GitHub 版时报
      // [ERR_PNPM_EPERM]（pnpm 无法把临时目录 rename 成一个已存在的名字），
      // 界面上显示成「没有写入权限，无法安装」——一个纯粹的假象。必须摘掉。
      steps.push({
        kind: 'relink',
        text: '清掉断链：' + linkPath
          + '\n          它指向 ' + rawLinkTarget(linkPath) + '，而那里已经没有东西了'
          + '\n          留着它会让 DSH 插件页报「没有写入权限，无法安装」',
      })
      needsLink = true
    } else if (current.toLowerCase() !== resolve(wantTarget).toLowerCase()) {
      // 已存在也要看**指向对不对**：在复制模式与 --link 模式之间切换时必须重新指向，
      // 否则会出现"文件复制进 .dsh 了，链接却还指着源码目录"的假象（第一版就漏了这点）。
      steps.push({ kind: 'relink', text: '重新指向：' + linkPath + '\n          现在指向 ' + current + '\n          改为    ' + wantTarget })
      needsLink = true
    } else {
      steps.push({ kind: 'skip', text: 'node_modules/' + PACKAGE_NAME + ' 已指向 ' + wantTarget })
    }
  } else if (linkKind === 'dir') {
    if (resolve(linkPath).toLowerCase() === resolve(wantTarget).toLowerCase()) {
      steps.push({ kind: 'skip', text: 'node_modules/' + PACKAGE_NAME + ' 就是 ' + wantTarget })
    } else {
      steps.push({
        kind: 'relink',
        text: '替换为链接：' + linkPath
          + '\n          现在是一个普通目录（可能是从 npm / GitHub 装进来的）'
          + '\n          改为指向 ' + wantTarget,
      })
      needsLink = true
    }
  } else {
    problems.push('目标已存在且不是目录/链接，拒绝覆盖：' + linkPath)
  }

  console.log('== 安装计划 ==')
  console.log('插件源码   ：' + PLUGIN_DIR)
  console.log('安装模式   ：' + (copyMode ? '复制到 .dsh（默认，推荐）' : '--link 直连源码（开发用）'))
  if (copyMode) console.log('安装位置   ：' + copyDir)
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
    console.log('（写入前会自动备份 package.json 为 package.json.donevoice-backup-<时间戳>，只保留最近 ' + BACKUP_KEEP + ' 份）')
    return
  }

  // ── 真正写盘 ────────────────────────────────────────────────────────────────
  // 默认模式：先把插件复制进 .dsh（每次覆盖，保证装的就是当前这份源码），再让 profile 指向副本。
  if (copyMode) {
    try {
      if (existsSync(copyDir)) rmSync(copyDir, { recursive: true, force: true })
      mkdirSync(copyDir, { recursive: true })
      copyPluginTree(PLUGIN_DIR, copyDir)
      console.log('已复制插件到 ' + copyDir)
    } catch (error) {
      console.error('复制插件失败：' + String(error))
      process.exitCode = 3
      return
    }
  }

  const backup = backupPackageJson(packageJsonPath)
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

  if (needsLink) {
    mkdirSync(modulesDir, { recursive: true })
    // ⚠️ target 必须跟着安装模式走：默认模式指向 .dsh 里的副本，--link 模式才指向源码目录。
    //    （这里曾漏改，结果复制模式也把 junction 指到了源码目录 —— 那等于没解决问题。）
    const junctionTarget = copyMode ? copyDir : PLUGIN_DIR
    if (linkKind !== 'missing') {
      // 重新指向：只摘掉已有条目本身（链接不递归进入目标目录），再建新的。
      try {
        removeLink(linkPath)
      } catch (error) {
        console.error('移除旧链接失败：' + String(error))
        process.exitCode = 3
        return
      }
    }
    try {
      symlinkSync(junctionTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      console.error('建立链接失败：' + String(error))
      // junction 是用户级操作，**不需要管理员**（旧文案写错了，审计时抓到的）。
      console.error('可手动执行（普通 PowerShell 即可，无需管理员）：')
      console.error('  New-Item -ItemType Junction -Path "' + linkPath + '" -Target "' + junctionTarget + '"')
      process.exitCode = 3
      return
    }
    console.log('已建立链接 ' + linkPath + '  →  ' + junctionTarget)
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
 *
 * 三种模式留下的东西都会被清理：profile 的依赖项、bundles 项、node_modules 里的链接，
 * 以及**默认模式下 `.dsh` 里的那份副本**（`<home>/donevoice/plugin/`，只认这个路径，绝不碰别处）。
 * @param options `{ profile, apply }`。
 */
function uninstall(options) {
  const packageJsonPath = join(options.profile, 'package.json')
  const linkPath = join(options.profile, 'node_modules', PACKAGE_NAME)
  const copyDir = installTargetDir()

  if (!existsSync(packageJsonPath)) {
    console.log('profile 的 package.json 不存在：' + packageJsonPath + ' —— 无需卸载')
    return
  }
  const manifest = readJson(packageJsonPath)
  const hasDependency = Object.prototype.hasOwnProperty.call(manifest.dependencies ?? {}, PACKAGE_NAME)
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const hasBundle = bundles.includes(PACKAGE_NAME)
  const linkKind = entryKind(linkPath)
  const hasLink = linkKind !== 'missing'
  // 断链（链接还在、目标已删）必须按"要清理"处理：`existsSync` 会把它误判成"不存在"，
  // 于是谁都不去清它，而它恰恰是唯一能挡住 pnpm 安装的东西。见 `entryKind` 的注释。
  const linkIsDangling = linkKind === 'link' && linkTargetOf(linkPath) === null
  // 只删"看起来确实是我们那份副本"的目录（有 package.json 且 name 对得上），避免误删别人的东西。
  let hasCopy = false
  try {
    if (existsSync(join(copyDir, 'package.json'))) {
      hasCopy = readJson(join(copyDir, 'package.json')).name === PACKAGE_NAME
    }
  } catch {
    hasCopy = false
  }

  console.log('== 卸载计划 ==')
  console.log('  删除依赖项：' + (hasDependency ? '是' : '否（本来就是干净的）'))
  console.log('  删除 bundles 项：' + (hasBundle ? '是' : '否'))
  console.log('  删除链接：' + linkPath
    + (hasLink
      ? (linkIsDangling ? '（断链：指向 ' + rawLinkTarget(linkPath) + '，目标已不存在——它会挡住 pnpm 安装）' : '')
      : '（不存在）'))
  console.log('  删除 .dsh 里的副本：' + (hasCopy ? copyDir : '无（当前不是默认复制模式）'))
  console.log('  只动这几处，其余原样保留；**你的插件源码目录不会被碰**。')

  if (options.apply !== true) {
    console.log('')
    console.log('以上为预演。确认无误后执行：node install.mjs --uninstall --apply')
    return
  }

  const backup = backupPackageJson(packageJsonPath)
  const next = readJson(packageJsonPath)
  if (hasDependency) delete next.dependencies[PACKAGE_NAME]
  if (hasBundle) next.dsh.profile.bundles = bundles.filter((entry) => entry !== PACKAGE_NAME)
  writeJson(packageJsonPath, next)
  if (hasLink) {
    // 只删这一个链接本身：removeLink 对链接走 unlink/rmdir，**绝递归跟随**（今天的真机事故）。
    try {
      removeLink(linkPath)
    } catch (error) {
      console.warn('删除链接失败（可手动删）：' + String(error))
    }
  }
  if (hasCopy) {
    try {
      rmSync(copyDir, { recursive: true, force: true })
      console.log('已删除副本 ' + copyDir)
    } catch (error) {
      console.warn('删除副本失败（可手动删）：' + String(error))
    }
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
  const options = { profile, apply: args.apply, link: args.link }
  console.log('（' + (args.apply ? '执行模式：会写入文件' : '预演模式：不会写入任何文件') + '）')
  if (args.uninstall) uninstall(options)
  else install(options)
}
