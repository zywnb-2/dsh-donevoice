/**
 * win-native.js —— DoneVoice 的 **Windows 原生通知通道**（宿主半区，零第三方依赖）。
 *
 * ## 这个文件解决什么问题
 *
 * 用户的要求只有两条：提醒必须**弹到 DSH 窗口外面**（Windows 通知中心右下角），并且**要有音效**。
 * 浏览器渲染进程那套 `new Notification(...)` 满足不了：它要权限、被窗口生命周期牵着走、
 * 更不能在 DSH 没前台时可靠地响。所以这条通道必须由 **DSH 宿主进程自己**拉起——
 * 宿主是一个普通 Node 进程（`node.exe`），能直接调 Windows 的 WinRT / .NET。
 *
 * ## 为什么这么做
 *
 *  1. **只 import `node:*`**。本项目已经用真机血换过一条约束：宿主半区静态 import 任何裸包名，
 *     一旦 profile 的 node_modules 里没有它，就是**链接期错误**——整个宿主条目加载失败，
 *     表现成"插件装上去像没装"。所以这里只用 `node:child_process` / `node:fs` / `node:os` / `node:path`。
 *  2. **发 toast 走 Windows PowerShell 5.1（不是 pwsh 7）**。WinRT 投影在 5.1 里现成可用，
 *     pwsh 7 需要额外装 WinRT 模块。调用方式是
 *     `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand <base64 UTF-16LE>`：
 *     中文与引号全部走 UTF-16LE base64，**绝不拼字符串**，所以不会有乱码/转义炸掉的问题；
 *     `-WindowStyle Hidden` + `windowsHide` 双保险，**不闪黑框**。
 *  3. **常驻 worker**。实测 `powershell.exe` 冷启动 **820~960ms**（见 evidence/native-toast.md），
 *     单次调用还要再叠 WinRT 类型加载 ≈ 300ms，端到端 ~1.2s——太慢。于是第一次调用时惰性拉起一个
 *     常驻 PowerShell 进程：它一次加载好 WinRT 类型，之后靠 stdin/stdout 上的行协议收发，
 *     单次投递降到几十毫秒。空闲 60 秒自退、`child.unref()`（**连 stdin/stdout/stderr 三个管道
 *     一起 unref**，否则管道 handle 会把事件循环钉住、宿主退不出去）、dispose 时干净杀掉，
 *     **绝不阻止宿主进程退出**。
 *  4. **协议全 base64**。worker 的 stdin 收 `<id> <base64(UTF-8 JSON)>`，stdout 出
 *     `@@DV <id> <base64(UTF-8 JSON)>`。原因是踩过的坑：PowerShell 的错误流被重定向时
 *     会在 stdout 里吐一段 `#< CLIXML ...>` 垃圾（中文还是 GBK 乱码），
 *     直接用**行内 JSON** 当协议会被它污染；base64 后连编码问题一起消失。
 *  5. **音效自己合成**。不用系统提示音糊弄：Node 现场合成 16bit/44.1kHz 单声道 PCM WAV
 *     （正弦 + 60ms 线性 attack + 指数衰减，soft/bright/triple 三套预设与插件既有音同频，
 *     失败用下行版），落到 `$DSH_HOME/donevoice/sounds/`，由 worker 用
 *     `[System.Media.SoundPlayer]` 异步播放。`volume` 直接烘进 WAV 振幅（0 静音、100 满幅）。
 *  6. **toast 自带静音**。XML 里写 `<audio silent="true"/>`：不写这一句，Windows 会同时播它
 *     自己的默认提示音，把我们的音效盖掉。
 *  7. **AUMID 注册**。想让通知里显示正确的应用名，就在开始菜单建一个带 AppUserModelID 的
 *     快捷方式（BurntToast 同款做法，PKEY_AppUserModel_ID = {9F4C2855-...},5）。注册失败不影响
 *     投递（实测未注册的 AUMID 也能弹、也进历史），只是通知上显示的应用名会退化成 PowerShell。
 *
 * ## 踩过的坑（都留了注释在对应位置）
 *  - `New-Object Windows.Data.Xml.Dom.XmlDocument` 在 PS 5.1 里直接 **TypeNotFound**，
 *    必须先 `[... , ContentType = WindowsRuntime]` 把类型加载进来（见 WORKER 脚本 init 段）。
 *  - `ToastNotification.Tag` 上限 **16 字符**，超了会抛异常 → 标签一律短名（dv-complete…）。
 *  - 多个通知并发时，同 tag + 同 group 的新 toast 会**顶掉**旧的 → 不同 kind 用不同 tag。
 *  - UIAutomation 从另一个进程**看不到** toast 窗口（实测枚举结果 0 个元素），
 *    所以"真的弹出来了"只能用 `History.GetHistory(<aumid>)` 回读来证明（验收脚本当年就是这么做的）。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 我们自己的 AppUserModelID（开始菜单快捷方式里注册的就是它）。 */
export const NATIVE_AUMID = 'DeepSeek.Harness.DoneVoice'

/**
 * 点击通知用的自定义协议。
 *
 * 为什么必须有它（真机事故）：只注册 AUMID 快捷方式时，**点击横幅什么都不发生**——
 * 宿主探针 `clickProbes` 一直涨、`clickHits` 始终为 0，说明激活脚本从未被执行。
 * 给 toast 加 `activationType="protocol"` + `launch="donevoice://focus"`，
 * 并在 `HKCU\Software\Classes\donevoice\shell\open\command` 注册本脚本，
 * 点击才会变成确定的 `ShellExecute(donevoice://focus)`。
 */
export const ACTIVATE_SCHEME = 'donevoice'

/** 通知里声明的激活 URI（点击后由 Windows 交给上面的协议处理程序）。 */
export const ACTIVATE_URI = ACTIVATE_SCHEME + '://focus'

/**
 * 回退用的已注册 AUMID：Windows PowerShell 自己的。
 * 注册失败时用它——通知照弹，只是应用名显示成 "Windows PowerShell"。
 */
export const PS_FALLBACK_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

/** 单次投递的硬超时（毫秒）：到点杀子进程，绝不挂住调用方。 */
export const DEFAULT_TIMEOUT_MS = 4000

/** worker 空闲自退时长（毫秒）。 */
export const DEFAULT_IDLE_MS = 60000

/**
 * 卡片从 `Show` 到"真的画在屏幕上"的耗时（毫秒）——**音效等这么久再起音**。
 *
 * 真机量出来的：发出一条后每 100ms 连拍，卡片覆盖面积在 **100ms 那帧就跳到位**（此后稳定），
 * 即 100~200ms 完成入场。`Show` 之后立刻播音效，人耳是先听到声音、再看到卡片；
 * 留出这段时间，卡片出现与音效起音就落在同一瞬（用户要的"绝对同步"）。
 * 这是**感知对齐**，不是精确同步——但比起"音效先响完、卡片才排队出来"（秒级）是两个世界。
 * 可用 `options.cardDrawMs` 覆盖（单测传 0 以免拖慢）。
 */
/**
 * 同一个音效文件的**最短重播间隔**（毫秒）。
 *
 * 为什么需要：MediaPlayer 一个文件一个实例，同一文件再 Play 会先把上一声掐掉
 * （Position 归零）—— 两个会话几乎同时收尾时，人耳听到的是半截音，像坏了。
 * 只对同一文件限流：不同音效各播各的（多会话同时结束本来就该同时响）。
 * 900ms 的取法：自带音效长度 0.5–1.1 秒，取中位数略短，既能防切碎又不会吞掉正常的连发提醒。
 */
export const SOUND_MIN_GAP_MS = 900

/** 卡片从 Show 到画在屏幕上要多久（毫秒）——用来把音效对齐到"卡片出现那一瞬"。 */
export const CARD_DRAW_MS = 160

/**
 * "上一张横幅大概还挂在屏幕上"的时间窗（毫秒）——落在这个窗内才主动收掉它。
 *
 * 为什么要这个窗口，而不是无脑收：
 *   · **收掉是同步的唯一手段**：同应用的横幅在 Windows 里排队，不收旧的新卡就上不来。
 *   · **但收掉会把那张在通知中心里的历史也删掉**（真机实验：`Hide` 连历史一起删；
 *     而"自然超时"不删历史；对已超时的通知调 `Hide` 照样删）。
 *   ⇒ 所以只在"**不收就会挡住新卡**"时才收：即两条提醒挨得足够近、旧的大概率还没消失。
 *     隔得久（> 这个窗口）的提醒，旧卡早已自然消失、历史留着，此时绝不能去碰它。
 * 窗口取值覆盖 Windows 默认的 5 秒与 7 秒两档横幅时长；
 * 若用户把"通知显示时长"设成 15/30 秒，隔 10 秒的新提醒会排队——这时**历史优先**（不误删）。
 */
export const HIDE_WINDOW_MS = 8000

/** worker 从 spawn 到打出 READY 的容忍上限（毫秒）；超了就杀掉并降级，避免调用方永久挂住。 */
export const DEFAULT_READY_TIMEOUT_MS = 8000

/**
 * **插件自带的提示音目录**（`sounds/`，跟着插件一起走）。
 *
 * 这些是收录进来的真实音效（MP3），不是运行时合成出来的：
 * 插件移动到任何地方、打包给别人，音效都跟着走，**不依赖任何外部目录**。
 * 播放用 WPF `MediaPlayer`（见 worker 的 PlaySound），因为 `SoundPlayer` 只吃 WAV。
 */
export function soundDir(options) {
  const opt = options !== null && typeof options === 'object' ? options : {}
  if (typeof opt.soundDir === 'string' && opt.soundDir !== '') return opt.soundDir
  // 本模块就在插件根目录里，所以 `sounds/` 永远是"插件自己的 sounds"。
  return join(dirname(fileURLToPath(import.meta.url)), 'sounds')
}

/** 提示音 id → 文件名（与 `sounds/` 目录里的实际文件一一对应）。 */
export const SOUND_FILES = Object.freeze({
  bell: 'bell.mp3',
  ping: 'ping.mp3',
  ping2: 'ping2.mp3',
  notify1: 'notify1.mp3',
  notify2: 'notify2.mp3',
  notify3: 'notify3.mp3',
  type20: 'type20.mp3',
  msgping: 'msgping.mp3',
  new017: 'new017.mp3',
  new018: 'new018.mp3',
  new02: 'new02.mp3',
  new027: 'new027.mp3',
  new03: 'new03.mp3',
  positive: 'positive.mp3',
  system02: 'system02.mp3',
})

/**
 * 提示音 id → 绝对路径；id 不存在或文件缺失时返回 null。
 *
 * 查找顺序：**用户目录优先**，其次插件自带目录。这样用户导入的同名音效可以覆盖自带的，
 * 而删除自带文件也不会影响用户自己那份。
 * @param options 选项（可用 `soundDir` / `homeDir` 注入，便于测试）。
 * @param preset 提示音 id（不含 `none`）。
 * @returns 绝对路径或 null。
 */
export function soundFileFor(options, preset) {
  const id = String(preset)
  if (SOUND_ID_PATTERN.test(id) !== true) return null
  return listSounds(options).find((item) => item.id === id)?.file ?? null
}

/** 允许导入的音频扩展名（WPF MediaPlayer 都能播；其余一律拒绝并说明原因）。 */
export const SOUND_EXTS = Object.freeze(['.mp3', '.wav', '.m4a', '.wma', '.aac'])

/** 合法的提示音 id：小写字母数字开头，后接字母数字/下划线/连字符，最长 40。 */
export const SOUND_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/

/** 单个音效文件的大小上限（4 MiB）：提示音不该比这更大，也防着被当成上传口。 */
export const MAX_SOUND_BYTES = 4 * 1024 * 1024

/**
 * 用户自己导入的音效目录（`$DSH_HOME/donevoice/sounds/`）。
 *
 * 为什么和自带的分开：自带的是**插件包的一部分**（跟着插件走、更新时会被覆盖），
 * 用户导入的是**用户数据**（跟着人走，插件升级不该动它）。查找时用户目录优先。
 */
export function userSoundDir(options) {
  const opt = options !== null && typeof options === 'object' ? options : {}
  if (typeof opt.userSoundDir === 'string' && opt.userSoundDir !== '') return opt.userSoundDir
  return join(resolveHomeDir(opt), 'donevoice', 'sounds')
}

/**
 * 按优先级列出所有音效目录：用户目录 → 插件自带目录。
 * @param options 选项。
 * @returns 目录数组。
 */
export function soundDirs(options) {
  return [userSoundDir(options), soundDir(options)]
}

/**
 * 扫描音效目录，得到**实际可用**的音效清单。
 *
 * 这是音效的**唯一事实来源**：列表来自磁盘扫描，所以用户导入/删除后立刻生效，
 * 不需要改任何静态枚举（`host-config.js` 那边只按 id 语法校验，见 SOUND_ID_PATTERN）。
 * @param options 选项。
 * @returns `[{ id, file, builtin, size }]`，同名时用户目录的那份胜出。
 */
export function listSounds(options) {
  const byId = new Map()
  for (const [index, dir] of soundDirs(options).entries()) {
    const builtin = index > 0
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const ext = extname(name).toLowerCase()
      if (SOUND_EXTS.includes(ext) !== true) continue
      const id = name.slice(0, -ext.length)
      if (SOUND_ID_PATTERN.test(id) !== true) continue
      if (byId.has(id)) continue // 用户目录在前 ⇒ 同名时它胜出
      let size = 0
      try {
        const stat = statSync(join(dir, name))
        if (!stat.isFile()) continue
        size = stat.size
      } catch {
        continue
      }
      byId.set(id, { id, file: join(dir, name), builtin, size })
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * 把 id 变成合法的音效 id（用户导入时用文件名派生）。
 * @param raw 原始名字。
 * @returns 合法 id（可能为空串，调用方需兜底）。
 */
export function soundIdFrom(raw) {
  const text = String(raw)
    .replace(/\.[A-Za-z0-9]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 40)
  return text.replace(/[^a-z0-9]+$/, '')
}

/** toast 的 group 名（同 group 内不同 tag 互不覆盖）。 */
export const TOAST_GROUP = 'donevoice'

/**
 * 每种提醒的 toast 标签：**必须 ≤16 字符**（Tag 的硬上限），
 * 且不同 kind 必须不同，否则并发的通知会互相顶掉。
 */
export const TOAST_TAGS = Object.freeze({
  completion: 'dv-complete',
  approval: 'dv-approve',
  question: 'dv-question',
  failure: 'dv-failure',
  test: 'dv-test',
})

/**
 * 每种提醒的图标规格：文件名 + 颜色 + 字形（字形只在"拿不到应用图标"的退路上用）。
 *
 * 为什么要图标：页内卡片好看的地方就是「左侧一枚图标 + 标题 + 正文」，用 toast 的
 * `appLogoOverride` 把同样的形态搬到系统通知上。
 *
 * **演进（按用户逐次点名改的）**：① 彩色圆 + 白色字形 → ② DeepSeek 标志 + 类别色外环
 * → ③（现状）**只有 DeepSeek 图标本身，不要圆圈**。所以现在的正路是"把应用图标铺满画布"，
 * 状态色只在退路（没有应用图标可画时）里用。
 *
 * 图标是 **PowerShell + GDI+ 现画**的（宿主机上没有 canvas，也不该为此引第三方图形库），
 * 画一次落在 `%PUBLIC%\DoneVoice\icons\`（必须是 ASCII 路径，见 `iconDir`），之后复用。
 */
export const TOAST_ICONS = Object.freeze({
  completion: Object.freeze({ file: 'complete', color: '#2EA043', glyph: '✓' }), // 绿勾：跑完了
  approval: Object.freeze({ file: 'approve', color: '#D29922', glyph: '!' }), //   琥珀叹号：等你许可
  question: Object.freeze({ file: 'question', color: '#4D6BFE', glyph: '?' }), //  蓝问号：等你回答
  failure: Object.freeze({ file: 'failure', color: '#F85149', glyph: '✕' }), //    红叉：出错了
  test: Object.freeze({ file: 'test', color: '#4D6BFE', glyph: '✓' }), //         测试用蓝勾
})

/**
 * 一个极小的 FNV-1a 哈希（32 位，十六进制）。
 *
 * 用途：把"品牌字符串"压成纯 ASCII 的短标记写进 `.donevoice-branding`。
 * 为什么不直接写原串：那个标记是用 `Set-Content -Encoding ASCII` 落的盘，
 * 而安装路径里带中文（`C:\Users\<用户名>\...`）时会被写成 `???`，
 * 于是"实际值"永远不等于"期望值" ⇒ 每次拉 worker 都误判成"变了"、白白重建快捷方式。
 * @param value 任意字符串。
 * @returns 8 位十六进制字符串。
 */
export function shortHash(value) {
  let hash = 0x811c9dc5
  const text = String(value)
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * `-EncodedCommand` 的安全上限。
 *
 * Windows 的 CreateProcess 命令行上限是 32767 字符，而 `-EncodedCommand` 的载荷是
 * **base64(UTF-16LE)**（约等于脚本字节数的 2.7 倍）。留出余量取 30000：
 * 超过就不再走这条路，改用落盘的 `-File`（见 `ensureWorkerScriptFile`）。
 */
export const MAX_ENCODED_COMMAND = 30000

/**
 * worker 脚本的落盘路径。
 * @param options 选项（取 homeDir / env）。
 * @returns `$DSH_HOME/donevoice/worker.ps1`。
 */
export function workerScriptFile(options) {
  return join(resolveHomeDir(options), 'donevoice', 'worker.ps1')
}

/**
 * 把 worker 脚本落到磁盘（内容变了才写），返回可用路径。
 *
 * 为什么要落盘：`-EncodedCommand` 会撞 Windows 命令行上限（真机症状 `spawn ENAMETOOLONG`），
 * 而脚本只会越长越完整。落盘后长度不再受限，且 **stdin 完整留给行协议**。
 * 任何写盘失败都返回 `{ path: null, reason }`，由调用方决定是退回 `-EncodedCommand`
 * 还是明确降级——**绝不装作能跑**。
 * @param options 选项（取 homeDir / env）。
 * @param script 脚本文本。
 * @returns `{ path: string|null, reason: string|null }`。
 */
export function ensureWorkerScriptFile(options, script) {
  return writeScriptFile(workerScriptFile(options), script)
}

/**
 * 把脚本文本写到磁盘（内容变了才写，**带 UTF-8 BOM**）。
 *
 * ⚠️ 必须带 BOM：Windows PowerShell 5.1 读 .ps1 时**没有 BOM 就按系统 ANSI 解**
 * （中文机器上是 GBK），脚本里的中文注释会变成乱码、直接语法崩溃
 * （真机症状：`Unexpected token '}'`、`The hash literal was incomplete`）。
 * 这也是"pwsh 7 里语法检查 0 错误"骗过我一次的原因：pwsh 7 默认按 UTF-8 读。
 * @param file 目标绝对路径。
 * @param script 脚本文本。
 * @returns `{ path: string|null, reason: string|null }`。
 */
function writeScriptFile(file, script) {
  const payload = '\uFEFF' + script
  try {
    mkdirSync(dirname(file), { recursive: true })
    let current = null
    try {
      current = readFileSync(file, 'utf8')
    } catch {
      current = null
    }
    if (current !== payload) writeFileSync(file, payload, 'utf8')
    return { path: file, reason: null }
  } catch (error) {
    return { path: null, reason: 'script-write-failed: ' + String(error) }
  }
}

/** "点击通知后激活 DSH 窗口"的脚本路径（与 worker 脚本同目录）。 */
export function activateScriptFile(options) {
  return join(resolveHomeDir(options), 'donevoice', 'activate.ps1')
}

/** 激活用的 VBS 启动器路径（见 `activateLauncherScript` 的说明）。 */
export function activateLauncherFile(options) {
  return join(resolveHomeDir(options), 'donevoice', 'activate.vbs')
}

/**
 * `wscript.exe` 的绝对路径（无控制台的脚本宿主，见 `activateLauncherScript`）。
 * @returns 绝对路径（SystemRoot 取不到时回落 `C:\Windows`）。
 */
export function windowsDir() {
  const root = typeof process.env.SystemRoot === 'string' && process.env.SystemRoot !== ''
    ? process.env.SystemRoot
    : (typeof process.env.windir === 'string' && process.env.windir !== '' ? process.env.windir : 'C:\\Windows')
  return join(root, 'System32')
}

/**
 * 生成"无窗口"激活启动器（VBScript，由 `wscript.exe` 执行）。
 *
 * **为什么需要它（用户报的"弹出一个黑窗口"）**：直接把协议处理程序指到 `powershell.exe`
 * 会**闪一个控制台窗口**——`powershell.exe` 是控制台子系统程序，窗口在它解析
 * `-WindowStyle Hidden` 之前就已经创建了（真机实测：激活瞬间出现 `PseudoConsoleWindow`）。
 * 而 `wscript.exe` 是 GUI 子系统、**根本没有控制台**，由它用窗口样式 `0`（隐藏）拉起
 * PowerShell，整条链路一个窗口都不会出现。
 *
 * 注意：脚本里带中文安装路径（`C:\\Users\\<用户名>\\...`），所以落盘时必须写 **UTF-16LE + BOM**
 * ——Windows Script Host 读 ANSI 的 .vbs 会把中文路径读成乱码，脚本直接找不到文件。
 * @param options 选项（`selfExe` 可注入，便于测试）。
 * @returns VBS 文本。
 */
export function activateLauncherScript(options) {
  const opt = options !== null && typeof options === 'object' ? options : {}
  const ps = resolvePowershell(opt)
  const script = activateScriptFile(opt)
  const vbsQuote = (value) => '"' + String(value).replace(/"/g, '""') + '"'
  const cmd = vbsQuote(ps.path) + ' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + vbsQuote(script)
  return [
    "' DoneVoice：无窗口激活启动器。",
    "' 由 donevoice:// 协议处理程序调用（wscript.exe //B \"本文件\" \"donevoice://focus\"）。",
    "' 存在的唯一理由：powershell.exe 自己会带一个控制台窗口，wscript 不会。",
    'Option Explicit',
    'Dim shell',
    'Set shell = CreateObject("WScript.Shell")',
    "' 0 = 隐藏窗口，False = 不等待（点了通知立刻返回）。",
    'shell.Run ' + vbsQuote(cmd) + ', 0, False',
    '',
  ].join('\r\n')
}

/**
 * 确保 VBS 启动器存在（**UTF-16LE + BOM**，见 `activateLauncherScript` 的说明）。
 * @param options 选项。
 * @returns `{ path, reason }`。
 */
export function ensureActivateLauncherFile(options) {
  const file = activateLauncherFile(options)
  const payload = '\uFEFF' + activateLauncherScript(options)
  try {
    mkdirSync(dirname(file), { recursive: true })
    let current = null
    try {
      current = readFileSync(file, 'utf16le')
    } catch {
      current = null
    }
    if (current !== payload) writeFileSync(file, Buffer.from(payload, 'utf16le'))
    return { path: file, reason: null }
  } catch (error) {
    return { path: null, reason: 'launcher-write-failed: ' + String(error) }
  }
}

/** 点击标记文件：激活脚本写、宿主读一次就删（页面聚焦后据此跳到那张通知的会话）。 */
export function clickMarkerFile(options) {
  return join(resolveHomeDir(options), 'donevoice', 'clicked.json')
}

/**
 * 生成"点击系统通知后把 DSH 窗口拿到前台"的脚本。
 *
 * 为什么需要它：Windows 对未打包桌面应用，**点击通知执行的是 AUMID 快捷方式的 target + arguments**。
 * 最初那对参数是 `-Command "exit"`（只为注册 AUMID，不为点击），于是点通知只会拉起一个
 * 立刻退出的隐藏 PowerShell —— 用户看到的就是"点了没反应、回不到桌面"。
 * 现在改成跑这个脚本：把 DSH 主窗口恢复并置前；DSH 没在跑就直接把它启动起来。
 *
 * 为什么 SetForegroundWindow 在这里能成：Windows 只允许"当前前台进程"抢焦点，
 * 而这个脚本正是**由用户点击通知拉起**的（此刻它就是前台），所以有抢焦点的资格。
 *
 * ⚠️ **顺序是关键（真机踩过的竞态）**：必须**先写点击标记、再抢焦点**。
 *    页面是在"拿到焦点"那一刻去读标记的，如果先抢焦点，页面读的时候标记还没落盘
 *    （脚本后面才写），它又不会再读第二次 —— 结果就是"窗口回来了，但没跳到那个会话"。
 * @param options 选项（`selfExe` 可注入，便于测试）。
 * @returns PowerShell 脚本文本。
 */
export function activateScript(options) {
  const opt = options !== null && typeof options === 'object' ? options : {}
  const exe = typeof opt.selfExe === 'string' && opt.selfExe !== '' ? opt.selfExe : process.execPath
  const name = typeof exe === 'string' && exe.toLowerCase().endsWith('.exe') === true ? basename(exe, '.exe') : ''
  return [
    '# DoneVoice：点击系统通知 → 把 DSH 窗口拿到前台（并留一个点击标记给页面用）。',
    '# 本脚本由 AUMID 快捷方式的 arguments 拉起，所以它天然拥有"抢焦点"的资格。',
    "$ErrorActionPreference = 'Continue'",
    '# ① 先落点击标记：页面在"拿到焦点"的那一瞬就要读到它，晚了就读不到（竞态）。',
    'try {',
    '    $stamp = (Get-Date).ToUniversalTime().ToString(' + psLiteral('o') + ')',
    '    Set-Content -LiteralPath ' + psLiteral(clickMarkerFile(opt)) + ' -Value $stamp -Encoding ASCII -Force',
    '} catch { }',
    'Add-Type -TypeDefinition ' + psLiteral(ACTIVATE_CSHARP) + ' -Language CSharp | Out-Null',
    '# ② 再把 DSH 窗口拿到前台。',
    '$target = $null',
    name === '' ? '$procs = @()' : '$procs = @(Get-Process -Name ' + psLiteral(name) + ' -ErrorAction SilentlyContinue)',
    'foreach ($p in $procs) {',
    '    if ($p.MainWindowHandle -ne 0) { $target = $p; break }',
    '}',
    'if ($null -eq $target) {',
    '    # DSH 没在跑：顺手把它启动起来（点提醒的人显然想回到它）。页面加载后会自己读走标记。',
    '    try { Start-Process ' + psLiteral(exe) + ' } catch { }',
    '    exit 0',
    '}',
    '$h = $target.MainWindowHandle',
    '# 最小化时先还原（SW_RESTORE=9），否则"置前"只是让它闪一下。',
    'if ([FgActivate]::IsIconic($h)) { [void][FgActivate]::ShowWindow($h, 9) }',
    '[void][FgActivate]::BringWindowToTop($h)',
    '# ③ 抢焦点：三步走，专治 Windows 的**前台锁**（后台进程直接 focus 往往只让任务栏闪一下）。',
    '#    ① 先老实调一次 SetForegroundWindow；',
    '#    ② 不成则「临时置顶」——把窗口设成 TOPMOST 再 focus，这是参考实现（Electron 版）用的手法，',
    '#       比抖 Alt 键稳；120ms 后立刻复位，不留置顶副作用；',
    '#    ③ 还不行就抖一下 Alt 键（经典 workaround，前台锁会因为"刚有输入"而放开）。',
    '$ok = [FgActivate]::SetForegroundWindow($h)',
    'if (-not $ok) {',
    '    $rect = New-Object FgActivate+RECT',
    '    [void][FgActivate]::GetWindowRect($h, [ref]$rect)',
    '    $w = $rect.Right - $rect.Left',
    '    $ht = $rect.Bottom - $rect.Top',
    '    # HWND_TOPMOST = -1；SWP_NOMOVE|SWP_NOSIZE = 0x0002|0x0001',
    '    [void][FgActivate]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0003)',
    '    [void][FgActivate]::SetForegroundWindow($h)',
    '    Start-Sleep -Milliseconds 120',
    '    # HWND_NOTOPMOST = -2；只改 Z 序，位置尺寸原样。',
    '    [void][FgActivate]::SetWindowPos($h, [IntPtr](-2), $rect.Left, $rect.Top, $w, $ht, 0x0000)',
    '    [void][FgActivate]::SetForegroundWindow($h)',
    '}',
    'if (-not [FgActivate]::SetForegroundWindow($h)) {',
    '    # ③ 抖 Alt：让系统认为"刚发生过用户输入"，前台锁随之放开。',
    '    [FgActivate]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)',
    '    [void][FgActivate]::SetForegroundWindow($h)',
    '    [FgActivate]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)',
    '}',
    '',
  ].join('\n')
}

/**
 * 把激活脚本落到磁盘（内容变了才写）。
 * 必须在 worker 建快捷方式**之前**完成——快捷方式的 arguments 指向它，脚本不在就是个死链接。
 * @param options 选项。
 * @returns `{ path: string|null, reason: string|null }`。
 */
export function ensureActivateScriptFile(options) {
  return writeScriptFile(activateScriptFile(options), activateScript(options))
}

/**
 * 把音量夹到 0..100 的整数。
 * @param value 任意候选值。
 * @returns 0..100 的整数（非法输入回落 70）。
 */
export function clampVolume(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 70
  return Math.min(100, Math.max(0, Math.round(value)))
}

/**
 * 解析 DSH home 目录。
 * 优先级：`options.homeDir` > `options.env.DSH_HOME`（缺省用 process.env）> `~/.dsh`。
 * @param options createNativeNotifier 的选项。
 * @returns 绝对路径。
 */
export function resolveHomeDir(options) {
  const opt = options !== null && typeof options === 'object' ? options : {}
  if (typeof opt.homeDir === 'string' && opt.homeDir.trim() !== '') return opt.homeDir.trim()
  const env = opt.env !== null && typeof opt.env === 'object' ? opt.env : process.env
  const fromEnv = env?.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/**
 * 通知图标的落盘目录 —— **必须是纯 ASCII 路径**。
 *
 * ⚠️ 真机抓到的坑（截屏对比实验定的案）：图标放在 `C:\Users\<中文名>\.dsh\...` 时，
 * `file:///` URI 里的中文会被百分号编码（`%E6%9C%B1...`），**Windows 的 toast 图片加载器
 * 读不出来**，结果 `appLogoOverride` 那张图**完全不显示**（用户看到的是系统回退的小应用图标）。
 * 同一张图换到 `C:\Users\Public\...` 立刻正常显示。
 * 所以图标统一放 `%PUBLIC%\DoneVoice\icons`（Windows 上恒为 ASCII、且所有用户可写）。
 * 拿不到 PUBLIC 目录时才退回 DSH_HOME（此时图标可能不显示，但通知照发）。
 * @param options 选项（可用 `iconsDir` 注入；`env` 覆盖环境变量）。
 * @returns 绝对路径。
 */
export function iconDir(options) {
  const opt = options !== null && typeof options === 'object' ? options : {}
  if (typeof opt.iconsDir === 'string' && opt.iconsDir !== '') return opt.iconsDir
  const env = opt.env !== null && typeof opt.env === 'object' ? opt.env : process.env
  const publicDir = typeof env?.PUBLIC === 'string' && env.PUBLIC.trim() !== '' ? env.PUBLIC.trim() : 'C:\\Users\\Public'
  if (isAsciiPath(publicDir) === true) return join(publicDir, 'DoneVoice', 'icons')
  return join(resolveHomeDir(opt), 'donevoice', 'icons')
}

/**
 * 路径是否全 ASCII（非 ASCII 的路径会让 toast 图片加载失败，见 `iconDir` 的说明）。
 * @param value 路径。
 * @returns 是否全 ASCII。
 */
export function isAsciiPath(value) {
  if (typeof value !== 'string' || value === '') return false
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 127) return false
  }
  return true
}

/**
 * DSH 自己的应用图标（`<appRoot>\resources\icon.png`）——通知上要显示的那个 DeepSeek 标志。
 * @param options 选项（可注入 `appRoot` / `brandLogo`）。
 * @returns PNG 绝对路径，找不到返回 null。
 */
export function resolveBrandLogo(options) {
  const opt = options !== null && typeof options === 'object' ? options : {}
  if (typeof opt.brandLogo === 'string' && opt.brandLogo !== '') return existsSync(opt.brandLogo) ? opt.brandLogo : null
  const icon = resolveBrandIcon(opt)
  const exe = icon.split(',')[0]
  const root = typeof exe === 'string' && exe !== '' && existsSync(exe) ? dirname(exe) : appRootFromArgv(process.argv[1])
  if (root === null || root === undefined) return null
  for (const candidate of [join(root, 'resources', 'icon.png'), join(root, 'icon.png')]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 图标绘制的版本号：改了画法就 +1（文件名带它，避免复用旧图）。
 *
 * 版本史：r1 = 实心彩色圆 + 白色字形；r2 = DeepSeek 标志 + 类别色外环；
 * **r3 = 只有 DeepSeek 标志本身（用户点名：不要圆圈）**。
 */
export const ICON_REVISION = 3

/**
 * 某种提醒的图标 PNG 路径（worker 会在需要时现画）。
 * @param options 选项（取 homeDir / env）。
 * @param kind 四类之一（或 test）。
 * @returns 绝对路径。
 */
export function iconFile(options, kind) {
  const spec = TOAST_ICONS[kind] ?? TOAST_ICONS.test
  return join(iconDir(options), spec.file + '.r' + ICON_REVISION + '.png')
}

/**
 * 单个音符的包络值：attack 线性渐入，之后指数衰减到结尾约 1%。
 * @param ms 音符内的毫秒偏移。
 * @param durationMs 这个音符的总时长（毫秒）。
/**
 * 解析 powershell.exe 的路径。
 * 绝对路径但不存在时**直接判定缺失**——省掉一次 4 秒的白等（这是"powershell 被裁掉"的常见形态）。
 * @param options 选项。
 * @returns { path, ok }。
 */
export function resolvePowershell(options) {
  const opt = options !== null && typeof options === 'object' ? options : {}
  if (typeof opt.powershell === 'string' && opt.powershell.trim() !== '') {
    const candidate = opt.powershell.trim()
    if (/^[a-zA-Z]:[\\/]/.test(candidate) && !existsSync(candidate)) return { path: candidate, ok: false }
    return { path: candidate, ok: true }
  }
  const env = opt.env !== null && typeof opt.env === 'object' ? opt.env : process.env
  const root = typeof env?.SystemRoot === 'string' && env.SystemRoot !== '' ? env.SystemRoot : 'C:\\Windows'
  const full = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (existsSync(full)) return { path: full, ok: true }
  // 兜底交给 PATH 解析：真找不到会在 spawn 的 error 事件里降级成 no-powershell。
  return { path: 'powershell.exe', ok: true }
}

/**
 * 把任意字符串编码成 PowerShell 的单引号字面量（内部单引号翻倍）。
 * @param value 原始字符串。
 * @returns 可直接嵌进脚本的字面量（含两侧单引号）。
 */
function psLiteral(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/**
 * 把脚本文本编码成 `-EncodedCommand` 需要的 base64（UTF-16LE）。
 * 中文、引号、换行全靠这一步保平安。
 * @param script PowerShell 脚本源文本。
 * @returns base64 字符串。
 */
export function encodeCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64')
}

/** 点击通知后"把窗口拿到前台"用的 C# 互操作。 */
const ACTIVATE_CSHARP = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class FgActivate',
  '{',
  '    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
  '    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
  '    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
  '    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);',
  '    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);',
  // 「临时置顶」用的两个：SetWindowPos 换 TOPMOST/NOTOPMOST，GetWindowRect 取原位置尺寸。
  '    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);',
  '    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);',
  '    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
  '}',
].join('\n')

/** AUMID 注册用的 C# 互操作（写快捷方式的 PKEY_AppUserModel_ID）。 */
const FOREGROUND_CSHARP = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class FgWindow',
  '{',
  '    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);',
  '}',
].join('\n')

const AUMID_CSHARP = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class AumidHelper',
  '{',
  '    [StructLayout(LayoutKind.Sequential, Pack = 4)]',
  '    public struct PropertyKey { public Guid formatId; public int propertyId; }',
  '    [StructLayout(LayoutKind.Explicit)]',
  '    public struct PropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr pointerValue; }',
  '    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  '    public interface IPropertyStore',
  '    {',
  '        int GetCount(out uint cProps);',
  '        int GetAt(uint iProp, out PropertyKey pkey);',
  '        int GetValue(ref PropertyKey key, out PropVariant pv);',
  '        int SetValue(ref PropertyKey key, ref PropVariant pv);',
  '        int Commit();',
  '    }',
  '    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
  '    public static extern int SHGetPropertyStoreFromParsingName(string pszPath, IntPtr pbc, int flags, ref Guid riid, out IPropertyStore ppv);',
  '    public static string SetAumid(string lnkPath, string aumid)',
  '    {',
  '        Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");',
  '        IPropertyStore store;',
  '        int hr = SHGetPropertyStoreFromParsingName(lnkPath, IntPtr.Zero, 2, ref iid, out store);',
  '        if (hr != 0) return "SHGetPropertyStore 0x" + hr.ToString("X8");',
  '        try',
  '        {',
  '            PropertyKey key = new PropertyKey { formatId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), propertyId = 5 };',
  '            PropVariant pv = new PropVariant { vt = 31, pointerValue = Marshal.StringToCoTaskMemUni(aumid) };',
  '            try',
  '            {',
  '                hr = store.SetValue(ref key, ref pv);',
  '                if (hr != 0) return "SetValue 0x" + hr.ToString("X8");',
  '                hr = store.Commit();',
  '                if (hr != 0) return "Commit 0x" + hr.ToString("X8");',
  '            }',
  '            finally { Marshal.FreeCoTaskMem(pv.pointerValue); }',
  '        }',
  '        finally { Marshal.ReleaseComObject(store); }',
  '        return "ok";',
  '    }',
  '}',
].join('\n')

/**
 * 通知上显示的**应用名**。
 *
 * 用户要求：通知上要写 "DeepSeek Harness"、并带 DeepSeek 的图标，而不是我们插件自己的名字。
 * Windows 对"未打包桌面应用"的通知，**应用名与图标都取自 AUMID 对应的那个开始菜单快捷方式**
 * （快捷方式的文件名就是显示名，图标取它的 IconLocation）——插件自己在 toast XML 里改不了。
 * 所以这里把快捷方式命名成 "DeepSeek Harness.lnk" 并把它的图标指向 DSH 自己的 exe。
 */
export const TOAST_APP_NAME = 'DeepSeek Harness'

/**
 * 开始菜单快捷方式的路径（AUMID 注册的载体）。
 *
 * 目录仍是 DoneVoice（避免和 DSH 自己的 `DeepSeek Harness.lnk` 撞名），
 * **文件名**才是通知上显示的应用名。
 * @returns `%APPDATA%\Microsoft\Windows\Start Menu\Programs\DoneVoice\DeepSeek Harness.lnk`。
 */
export function shortcutPath() {
  return join(shortcutDir(), TOAST_APP_NAME + '.lnk')
}

/**
 * 旧版本用过的快捷方式（名字是 DoneVoice）。它注册的是同一个 AUMID，
 * 留着会让 Windows 有两份注册、通知上可能仍显示 "DoneVoice" ⇒ 首次升级时删掉。
 * @returns 旧快捷方式的绝对路径。
 */
export function legacyShortcutPath() {
  return join(shortcutDir(), 'DoneVoice.lnk')
}

/**
 * 品牌标记文件：记录"当前快捷方式应该长什么样"。
 *
 * 为什么需要它：注册检查只看"快捷方式里有没有我们的 AUMID"，**看不出图标/名字是否已经过期**。
 * 老版本建的快捷方式图标是 shell32 的，光靠 AUMID 检查会永远跳过重建，用户就看不到新图标。
 * 标记内容变了 ⇒ 重建快捷方式。这与"改一次代码就 +1 的 rev"是同一个套路。
 * @returns 标记文件绝对路径。
 */
export function brandingMarkerPath() {
  return join(shortcutDir(), '.donevoice-branding')
}

/** 开始菜单 Programs 目录。 */
function shortcutDir() {
  const appData = process.env.APPDATA
  const base = typeof appData === 'string' && appData !== ''
    ? join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    : join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  return join(base, 'DoneVoice')
}

/**
 * 找 DSH 自己的图标给通知用（用户点名要 DeepSeek 的图标）。
 *
 * 为什么要"找"而不是写死：装到别人电脑上，DSH 的安装位置很可能不一样。
 * 但有一条稳定的事实可以依赖：**本模块跑在 DSH 宿主进程里，而该进程的 `process.execPath`
 * 就是 DSH 的可执行文件本身**（真机验证：命令行是
 * `"<DSH 安装目录>\DeepSeek Harness.exe" --expose-internals ...dsh-desktop-host/lib/index.js`）。
 * 于是按优先级探测：
 *   1. `<exe>,0`            —— exe 内嵌图标，就是任务栏/开始菜单上那个 DeepSeek 图标
 *   2. `<exe目录>\resources\tray.ico,0`
 *   3. 系统 shell32.dll,167 —— 最后的兜底（图标不对但通知照发）
 * @param options 选项（可注入 `execPath` 便于测试）。
 * @returns 可直接写进快捷方式 IconLocation 的字符串。
 */
export function resolveBrandIcon(options) {
  const opt = options !== null && typeof options === 'object' ? options : {}
  const env = opt.env !== null && typeof opt.env === 'object' ? opt.env : process.env
  const candidates = []

  // 应用根目录的三条线索，从最可靠到最弱：
  //   ① 显式注入（测试用）；
  //   ② 宿主入口参数里的 `…\resources\app.asar\…` —— 真机命令行就是这样，最可靠；
  //   ③ 宿主进程自己就是个 exe（桌面版下 `process.execPath` 正是 DeepSeek Harness.exe）。
  const fromArgv = appRootFromArgv(process.argv[1])
  const execPath = typeof opt.execPath === 'string' && opt.execPath !== '' ? opt.execPath : process.execPath
  const fromExec = typeof execPath === 'string' && execPath.toLowerCase().endsWith('.exe') === true && existsSync(execPath)
    ? dirname(execPath)
    : null
  const appRoot = typeof opt.appRoot === 'string' && opt.appRoot !== ''
    ? opt.appRoot
    : (fromArgv ?? fromExec)

  if (appRoot !== null && existsSync(appRoot)) {
    const exe = findAppExe(appRoot)
    if (exe !== null) candidates.push(exe + ',0')
    candidates.push(join(appRoot, 'resources', 'tray.ico') + ',0')
  }
  // 兜底：至少能拿到"某个 exe"的图标（比系统默认图标更像应用）。
  // 但**排除 node.exe**：合成环境（单测 / headless）下 process.execPath 是 node，
  // 拿 Node 的标志当通知图标比系统默认图标更让人困惑。
  const execName = typeof execPath === 'string' ? basename(execPath).toLowerCase() : ''
  if (execName.endsWith('.exe') && execName !== 'node.exe' && existsSync(execPath)) {
    candidates.push(execPath + ',0')
    candidates.push(join(dirname(execPath), 'resources', 'tray.ico') + ',0')
  }

  for (const candidate of candidates) {
    if (existsSync(candidate.split(',')[0])) return candidate
  }
  const systemRoot = typeof env?.SystemRoot === 'string' && env.SystemRoot !== '' ? env.SystemRoot : 'C:\\Windows'
  return join(systemRoot, 'System32', 'shell32.dll') + ',167'
}

/**
 * 从宿主入口参数里反推 Electron 应用根目录。
 *
 * 真机命令行：`"<DSH 安装目录>\DeepSeek Harness.exe" --expose-internals
 * <DSH 安装目录>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js`
 * ⇒ 认出 `resources\app.asar` 这一段，前面就是应用根目录。
 * 这样即使宿主的 `process.execPath` 是 node.exe（headless / SDK 组合），也照样找得到应用图标。
 * @param arg `process.argv[1]`。
 * @returns 应用根目录，或 null。
 */
function appRootFromArgv(arg) {
  if (typeof arg !== 'string' || arg === '') return null
  const marker = 'resources\\app.asar'
  const at = arg.toLowerCase().indexOf(marker)
  if (at < 0) return null
  let root = arg.slice(0, at)
  while (root.length > 0 && (root.endsWith('\\') || root.endsWith('/'))) root = root.slice(0, -1)
  return root === '' ? null : root
}

/**
 * 在应用根目录里找主程序 exe（优先名字里带 harness/deepseek 的，跳过卸载程序）。
 * @param appRoot 应用根目录。
 * @returns exe 绝对路径，或 null。
 */
function findAppExe(appRoot) {
  let names = []
  try {
    names = readdirSync(appRoot)
  } catch {
    return null
  }
  const exes = names.filter((name) => name.toLowerCase().endsWith('.exe') && name.toLowerCase().includes('uninstall') !== true)
  const preferred = exes.find((name) => {
    const lower = name.toLowerCase()
    return lower.includes('harness') || lower.includes('deepseek')
  })
  const chosen = preferred ?? exes[0]
  return chosen === undefined ? null : join(appRoot, chosen)
}

/**
 * 生成常驻 worker 的 PowerShell 脚本。
 *
 * 协议（全 ASCII 行协议，编码无关）：
 *   stdin   ← `<id> <base64(UTF-8 JSON 请求)>`
 *   stdout  → `@@DV READY <base64(JSON)>` / `@@DV <id> <base64(JSON 结果)>`
 *
 * ⚠️ 这段脚本里**不能出现反引号**（它是 JS 模板字符串的定界符），
 * 也不要用 PowerShell 的 `${...}` 子表达式语法。
 * @param options 选项（powershell / env / idleMs）。
 * @returns PowerShell 脚本文本。
 */
export function workerScript(options) {
  const opt = options !== null && typeof options === 'object' ? options : {}
  const ps = resolvePowershell(opt)
  const idleMs = Number.isFinite(opt.idleMs) ? Math.max(1000, opt.idleMs) : DEFAULT_IDLE_MS
  // 音效等"卡片画完"再起音的时长；单测传 0，免得每条用例都白等 160ms。
  const cardDrawMs = Number.isFinite(opt.cardDrawMs) ? Math.max(0, opt.cardDrawMs) : CARD_DRAW_MS
  const soundMinGapMs = Number.isFinite(opt.soundMinGapMs) ? Math.max(0, opt.soundMinGapMs) : SOUND_MIN_GAP_MS
  // "旧横幅还挂在屏幕上"的时间窗；单测传 0 表示"从不去 Hide"。
  const hideWindowMs = Number.isFinite(opt.hideWindowMs) ? Math.max(0, opt.hideWindowMs) : HIDE_WINDOW_MS
  const env = opt.env !== null && typeof opt.env === 'object' ? opt.env : process.env
  // 通知上那枚"应用图标"（用户点名要 DeepSeek 的图标）= 快捷方式的 IconLocation。
  const brandIcon = resolveBrandIcon(opt)
  const iconSpecLines = Object.keys(TOAST_ICONS).map((kind) => {
    const spec = TOAST_ICONS[kind]
    return '    @{ file = ' + psLiteral(spec.file + '.r' + ICON_REVISION) + '; color = ' + psLiteral(spec.color) + '; glyph = ' + psLiteral(spec.glyph) + ' }'
  })
  // DSH 自己的应用图标（PNG）；有它就把通知图做成「DeepSeek 标志 + 按类别着色的外环」。
  const brandLogo = resolveBrandLogo(opt)
  // 自己的进程名（PowerShell 的 ProcessName 不带 .exe）：用来判断"前台窗口是不是 DSH"。
  // 真机上宿主就跑在 `DeepSeek Harness.exe` 里，所以 process.execPath 的 basename 正是它。
  const selfExe = typeof opt.selfExe === 'string' && opt.selfExe !== '' ? opt.selfExe : process.execPath
  const selfProcessName = typeof selfExe === 'string' && selfExe.toLowerCase().endsWith('.exe') === true
    ? basename(selfExe, '.exe')
    : (typeof opt.selfProcessName === 'string' && opt.selfProcessName !== '' ? opt.selfProcessName : '')
  return [
    "$ErrorActionPreference = 'Continue'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
    '',
    '# 行协议输出：payload 统一 base64(UTF-8)，彻底绕开重定向时的 CLIXML 垃圾与 GBK 乱码。',
    'function Say([string]$id, [string]$payload) {',
    "    $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($payload))",
    "    [Console]::Out.WriteLine('@@DV ' + $id + ' ' + $b64)",
    '    [Console]::Out.Flush()',
    '}',
    '',
    '# XML 转义交给 .NET，中文安全。',
    'function Esc([string]$s) { return [System.Security.SecurityElement]::Escape($s) }',
    '',
    '# —— 通知图标：用 GDI+ 现画（宿主上没有 canvas，也不该为一个图标引图形库）。',
    '#    画法：**只放 DSH 自己的应用图标（DeepSeek 标志）本身，不加任何圆环/底色**——',
    '#    用户点名"不要圆圈，单纯一个 icon"。拿不到应用图标才退回"实心彩色圆 + 白色字形"',
    '#    （那时候圆是图标本身，不是装饰）。',
    '#    ⚠️ 目录必须是纯 ASCII：中文路径的 file:/// URI 会让 Windows 加载不出图片（真机截屏对照实验定的案）。',
    '$script:iconDir = ' + psLiteral(iconDir(opt)),
    '$script:brandLogo = ' + psLiteral(brandLogo === null ? '' : brandLogo),
    '$script:iconSpecs = @(',
    ...iconSpecLines.map((line, index) => (index === iconSpecLines.length - 1 ? line : line + ',')),
    ')',
    'function EnsureIcons {',
    '    try {',
    '        if (-not (Test-Path -LiteralPath $script:iconDir)) { New-Item -ItemType Directory -Path $script:iconDir -Force | Out-Null }',
    '        Add-Type -AssemblyName System.Drawing',
    '        # 清掉本插件自己留下的历史版本图标（换画法后不该在目录里留垃圾）。',
    '        $keep = @()',
    '        foreach ($s in $script:iconSpecs) { $keep += ($s.file + ' + psLiteral('.png') + ') }',
    '        try {',
    '            foreach ($f in Get-ChildItem -LiteralPath $script:iconDir -Filter ' + psLiteral('*.r*.png') + ' -ErrorAction SilentlyContinue) {',
    '                if ($keep -notcontains $f.Name) { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue }',
    '            }',
    '        } catch { }',
    '        foreach ($s in $script:iconSpecs) {',
    '            $path = Join-Path $script:iconDir ($s.file + ' + psLiteral('.png') + ')',
    '            if (Test-Path -LiteralPath $path) { continue }',
    '            $bmp = New-Object System.Drawing.Bitmap 96, 96',
    '            $g = [System.Drawing.Graphics]::FromImage($bmp)',
    '            $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias',
    '            $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias',
    '            $g.Clear([System.Drawing.Color]::Transparent)',
    '            $color = [System.Drawing.ColorTranslator]::FromHtml($s.color)',
    '            $logo = $script:brandLogo',
    "            if ($logo -ne '' -and (Test-Path -LiteralPath $logo)) {",
    '                # 只有图标本身：铺满整块画布，不画环、不加底色。',
    '                try {',
    '                    $img = [System.Drawing.Image]::FromFile($logo)',
    '                    $g.DrawImage($img, (New-Object System.Drawing.Rectangle 2, 2, 92, 92))',
    '                    $img.Dispose()',
    '                } catch { }',
    '            } else {',
    '                # 退路：实心彩色圆 + 白色字形',
    '                $brush = New-Object System.Drawing.SolidBrush -ArgumentList $color',
    '                $g.FillEllipse($brush, 2, 2, 92, 92)',
    '                $brush.Dispose()',
    "                $font = New-Object System.Drawing.Font('Segoe UI Symbol', 46, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)",
    '                $fmt = New-Object System.Drawing.StringFormat',
    '                $fmt.Alignment = [System.Drawing.StringAlignment]::Center',
    '                $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center',
    '                $rect = New-Object System.Drawing.RectangleF 0, 0, 96, 96',
    '                $g.DrawString([string]$s.glyph, $font, [System.Drawing.Brushes]::White, $rect, $fmt)',
    '                $font.Dispose()',
    '            }',
    '            $g.Dispose()',
    '            $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)',
    '            $bmp.Dispose()',
    '        }',
    '    } catch { }',
    '}',
    '',
    '# 卡片式 toast：左侧一枚图标（appLogoOverride，只有图标本身、不裁圆）+ 标题 + 正文，',
    '# 就是页内卡片那套视觉搬过来。**不用 scenario="reminder"**：它是"常驻提醒"，会一直赖着不走。',
    '#',
    '# ★ 卡片与音效"绝对同步"的命门：**同一个应用的横幅在 Windows 里是排队的**——',
    '#   上一张不消失，下一张根本不上屏。而我们的音效是在 Show 之后立刻响的，',
    '#   于是多提醒场景下就成了"音效先响完、卡片几秒后排队出来"（用户点名的不同步）。',
    '#   解法：新横幅先上屏、旧横幅立刻 Hide 掉，音效等卡片画完再起音 ⇒ 三者落在同一瞬。',
    '#   Hide 只收横幅，**不动通知中心的历史**（历史可用 GetHistory 回读校验，见 README 的三步验收）。',
    '$script:notifier = $null',
    '$script:lastToast = $null',
    '$script:lastShownTick = 0',
    '$script:hideWindowMs = ' + String(hideWindowMs),
    'function ShowToast([string]$aumid, [string]$title, [string]$body, [string]$tag, [string]$group, [string]$iconPath) {',
    "    $img = ''",
    "    if ($iconPath -ne '' -and (Test-Path -LiteralPath $iconPath)) {",
    '        try { $img = ' + psLiteral('<image placement="appLogoOverride" src="') + ' + ([System.Uri]$iconPath).AbsoluteUri + ' + psLiteral('"/>') + ' } catch { $img = ' + psLiteral('') + ' }',
    '    }',
    "    $xmlText = '<toast activationType=\"protocol\" launch=\"" + ACTIVATE_URI + "\"><visual><binding template=\"ToastGeneric\">' + $img + '<text>' + (Esc $title) + '</text><text>' + (Esc $body) + '</text></binding></visual><audio silent=\"true\"/></toast>'",
    '    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '    $doc.LoadXml($xmlText)',
    '    $t = New-Object Windows.UI.Notifications.ToastNotification $doc',
    '    $t.Tag = $tag',
    '    $t.Group = $group',
    '    if ($null -eq $script:notifier) { $script:notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid) }',
    '    # 顺序很讲究：**先把新横幅推上去、再收掉旧的**。反过来（先 Hide 再 Show）会变成',
    '    # "旧卡收起 → 空一瞬 → 新卡入场"两段串行动画（实测 400ms 以上空窗）；',
    '    # 这个顺序让收与放两段动画重叠，新卡出现更快（实测 ~200ms）。',
    '    $previous = $script:lastToast',
    '    $script:notifier.Show($t)',
    '    $script:lastToast = $t',
    '    if ($null -ne $previous) {',
    '        # 只在"上一张大概率还挂在屏幕上"时才收：这是避免排队（同步）的唯一手段，',
    '        # 但收掉会连带删掉它在通知中心的历史（实测）。隔得久的不动它 —— 历史优先。',
    '        $ageMs = [Environment]::TickCount - $script:lastShownTick',
    '        if ($ageMs -lt $script:hideWindowMs) {',
    '            try { $script:notifier.Hide($previous) } catch {',
    '                try { [Windows.UI.Notifications.ToastNotificationManager]::History.Remove($previous.Tag, $previous.Group, $aumid) } catch { }',
    '            }',
    '        }',
    '    }',
    '    $script:lastShownTick = [Environment]::TickCount',
    '}',
    '',
    '# ── 提示音播放：WPF MediaPlayer。',
    '#    为什么不是 [System.Media.SoundPlayer]：它**只支持 WAV**，而自带音效是 MP3。',
    '#    MediaPlayer 还能直接按 Volume(0..1) 调音量，不必像以前那样把音量烘进波形里。',
    '#    每个文件只 Open 一次并缓存（首播约 290ms 准备时间，重播几乎瞬时）。',
    '#    注意：无消息泵的隐藏进程里 MediaOpened 事件不会触发 —— 不需要等它，Play() 会自动排队。',
    'Add-Type -AssemblyName PresentationCore | Out-Null',
    '$script:players = @{}',
    "# 每个音效文件最近一次起播的时刻（TickCount）：用来做**最短间隔**，别把上一声切碎。",
    '# 为什么需要：MediaPlayer 是"一个文件一个实例"，同一个文件再 Play 会先把上一声掐掉',
    '# （Position 归零）——两个会话几乎同时收尾时，人耳听到的是半截音，像坏了。',
    '# 注意只对**同一个文件**限流：不同音效各播各的，本来就该同时响（多会话同时结束是正常的）。',
    '$script:lastPlay = @{}',
    '$script:minGapMs = ' + String(soundMinGapMs),
    'function PlaySound([string]$path, [int]$volume) {',
    '    $now = [Environment]::TickCount',
    '    if ($script:lastPlay.ContainsKey($path)) {',
    '        if (($now - $script:lastPlay[$path]) -lt $script:minGapMs) { return $false }',
    '    }',
    '    if (-not $script:players.ContainsKey($path)) {',
    '        $np = New-Object System.Windows.Media.MediaPlayer',
    '        $np.Open([Uri]$path)',
    '        $script:players[$path] = $np',
    '    }',
    '    $p = $script:players[$path]',
    '    $v = [Math]::Max(0, [Math]::Min(100, $volume)) / 100.0',
    '    $p.Volume = $v',
    '    $p.Position = [TimeSpan]::Zero',
    '    $p.Play()',
    '    $script:lastPlay[$path] = $now',
    '    return $true',
    '}',
    '',
    '# 卡片从 Show 到"画在屏幕上"要 100~200ms（真机每 100ms 连拍量出来的）。',
    '# Show 之后立刻播音效，人耳听到的是"声音先到、卡片还没画完"。',
    '# 所以先等这段时间再播 —— 让**卡片出现与音效起音落在同一瞬**（用户要的"绝对同步"）。',
    '$script:cardDrawMs = ' + String(cardDrawMs),
    '',
    '$script:aumid = ' + psLiteral(NATIVE_AUMID),
    '$script:fallbackAumid = ' + psLiteral(PS_FALLBACK_AUMID),
    '$script:registered = $false',
    '$script:appName = ' + psLiteral('Windows PowerShell'),
    '$script:initError = ' + psLiteral(''),
    '',
    '# —— WinRT 类型必须**显式按 WindowsRuntime 内容类型加载**。',
    '# 坑：PS 5.1 里直接 New-Object Windows.Data.Xml.Dom.XmlDocument 会 TypeNotFound。',
    'try {',
    '    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '    [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '} catch {',
    "    $script:initError = 'winrt: ' + $_.Exception.Message",
    '}',
    '',
    '# —— AUMID 注册：开始菜单快捷方式 + PKEY_AppUserModel_ID。',
    '#    通知上的**应用名 = 快捷方式文件名**，**图标 = 快捷方式的 IconLocation**，',
    '#    所以这两样必须在这里设对（插件在 toast XML 里改不了它们）。',
    'if ($script:initError -eq ' + psLiteral('') + ') {',
    '    $lnkPath = ' + psLiteral(shortcutPath()),
    '    $legacyPath = ' + psLiteral(legacyShortcutPath()),
    '    $markerPath = ' + psLiteral(brandingMarkerPath()),
    '    # 品牌标记用哈希：纯 ASCII 落盘，中文安装路径不会被打成 ???（见 shortHash 的说明）。',
    '    $branding = ' + psLiteral(shortHash(TOAST_APP_NAME + '|' + NATIVE_AUMID + '|' + brandIcon + '|' + activateScriptFile(opt) + '|' + ACTIVATE_URI)),
    '    $needsCreate = $true',
    "    if (Test-Path -LiteralPath $lnkPath) {",
    '        try {',
    '            # 免 Add-Type 的廉价校验：AppUserModelID 以 UTF-16LE 明文躺在 .lnk 的 ExtraData 里。',
    '            $bytes = [System.IO.File]::ReadAllBytes($lnkPath)',
    '            $text = [System.Text.Encoding]::Unicode.GetString($bytes)',
    '            if ($text.Contains($script:aumid)) { $needsCreate = $false; $script:registered = $true }',
    '        } catch { }',
    '    }',
    '    # 名字/图标变了（老版本是 DoneVoice + shell32 图标）→ 必须重建，否则用户永远看到旧样子。',
    "    if (-not $needsCreate) {",
    "        try { if ((Get-Content -LiteralPath $markerPath -Raw -ErrorAction Stop).Trim() -ne $branding) { $needsCreate = $true } }",
    '        catch { $needsCreate = $true }',
    '    }',
    '    if ($needsCreate) {',
    '        try {',
    '            $dir = Split-Path -Parent $lnkPath',
    '            if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }',
    '            $shell = New-Object -ComObject WScript.Shell',
    '            $sc = $shell.CreateShortcut($lnkPath)',
    '            $sc.TargetPath = ' + psLiteral(ps.path),
    '            $sc.IconLocation = ' + psLiteral(brandIcon),
    "            $sc.Description = 'DeepSeek Harness notification channel (DoneVoice plugin)'",
    '            # ★ 点击通知时 Windows 执行的就是这对 target+arguments。',
    '            #   必须指向"激活 DSH 窗口"的脚本——写成 -Command "exit" 的话，',
    '            #   用户点通知只会拉起一个立刻退出的隐藏 PowerShell，看起来就是"点了没反应"。',
    '            $sc.Arguments = ' + psLiteral('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + activateScriptFile(opt) + '"'),
    '            $sc.Save()',
    '            $source = ' + psLiteral(AUMID_CSHARP),
    '            Add-Type -TypeDefinition $source -Language CSharp | Out-Null',
    '            $r = [AumidHelper]::SetAumid($lnkPath, $script:aumid)',
    "            if ($r -eq 'ok') {",
    '                $script:registered = $true',
    '                Set-Content -LiteralPath $markerPath -Value $branding -Encoding ASCII -ErrorAction SilentlyContinue',
    '            } else { $script:initError = ' + psLiteral('aumid: ') + ' + $r }',
    '        } catch {',
    "            $script:initError = 'aumid: ' + $_.Exception.Message",
    '        }',
    '    }',
    '    # 迁移：老版本那个 DoneVoice.lnk 注册的是同一个 AUMID，留着会让名字/图标二义。',
    '    if ($script:registered -and (Test-Path -LiteralPath $legacyPath)) {',
    '        try { Remove-Item -LiteralPath $legacyPath -Force } catch { }',
    '    }',
    '    if ($script:registered) { $script:appName = ' + psLiteral(TOAST_APP_NAME) + ' }',
    '    # —— 协议激活：这是**点击通知真正能跑起来**的那条路。',
    '    #    真机教训：只注册 AUMID 快捷方式时，点击横幅什么都不会发生',
    '    #    （宿主探针 clickHits 长期为 0 = 激活脚本从没被执行过）。',
    '    #    所以给 toast 加 activationType="protocol" + launch="donevoice://focus"，',
    '    #    并在 HKCU 注册同名协议 ⇒ 点击 = ShellExecute(donevoice://focus) ⇒ 跑激活脚本。',
    '    #    用 HKCU（不需要管理员），可逆：卸载时删掉这个键即可。',
    '    try {',
    '        $protoRoot = ' + psLiteral('HKCU:\\Software\\Classes\\' + ACTIVATE_SCHEME),
    '        if (-not (Test-Path -LiteralPath $protoRoot)) { New-Item -Path $protoRoot -Force | Out-Null }',
    "        Set-ItemProperty -LiteralPath $protoRoot -Name '(Default)' -Value 'DoneVoice notification activation' -Force",
    "        Set-ItemProperty -LiteralPath $protoRoot -Name 'URL Protocol' -Value '' -Force",
    '        $cmdKey = Join-Path $protoRoot ' + "'shell\\open\\command'",
    '        if (-not (Test-Path -LiteralPath $cmdKey)) { New-Item -Path $cmdKey -Force | Out-Null }',
    '        # ★ 处理程序指向 **wscript + VBS**，不是 powershell.exe：',
    '        #   powershell.exe 是控制台程序，会在它解析 -WindowStyle Hidden 之前先建出控制台窗口',
    '        #   —— 用户看到的就是"点了通知闪一个黑窗口"。wscript 是 GUI 程序，没有控制台。',
    '        $protoCmd = ' + psLiteral('"' + windowsDir() + '\\wscript.exe" //B "' + activateLauncherFile(opt) + '" "%1"'),
    "        Set-ItemProperty -LiteralPath $cmdKey -Name '(Default)' -Value $protoCmd -Force",
    '    } catch {',
    '        # 协议注册失败不影响弹通知：点击会退化回「系统按快捷方式激活」那条路。',
    '    }',
    '}',
    '# 注册失败 → 回退到已注册的 PowerShell AUMID：通知照样弹，只是应用名变成 Windows PowerShell。',
    'if (-not $script:registered) { $script:aumid = $script:fallbackAumid }',
    '',
    '# 图标与 AUMID 无关，先画好（失败也无所谓，只是通知上少一枚图标）。',
    'EnsureIcons',
    '',
    '# —— 系统通知总开关探测（"为什么我什么都没看到"最常见的答案）。',
    '#    注意：**专注助手 / 勿扰模式不在 ctypes 可读范围内**（它是 CloudStore 里的二进制 blob，',
    '#    解析它既不可靠也没必要）—— 但这两个 DWORD 开关能覆盖绝大多数"通知被全局关掉"的情况。',
    '#    读不到就报 unknown，不猜。',
    '$script:toastEnabled = $true',
    '$script:toastGate = ' + psLiteral('unknown'),
    'try {',
    "    $pk = Get-ItemProperty -LiteralPath 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\PushNotifications' -Name 'ToastEnabled' -ErrorAction Stop",
    '    if ($null -ne $pk.ToastEnabled) {',
    '        if ([int]$pk.ToastEnabled -eq 0) { $script:toastEnabled = $false; $script:toastGate = ' + psLiteral('PushNotifications.ToastEnabled=0') + ' }',
    "        else { $script:toastGate = 'on' }",
    '    }',
    '} catch { }',
    'try {',
    "    $nk = Get-ItemProperty -LiteralPath 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings' -Name 'NOC_GLOBAL_SETTING_TOASTS_ENABLED' -ErrorAction Stop",
    '    if ($null -ne $nk.NOC_GLOBAL_SETTING_TOASTS_ENABLED) {',
    '        if ([int]$nk.NOC_GLOBAL_SETTING_TOASTS_ENABLED -eq 0) { $script:toastEnabled = $false; $script:toastGate = ' + psLiteral('NOC_GLOBAL_SETTING_TOASTS_ENABLED=0') + ' }',
    "        else { $script:toastGate = 'on' }",
    '    }',
    '} catch { }',
    '',
    "$ready = @{ init = ($script:initError -eq " + psLiteral('') + "); aumid = $script:aumid; registered = $script:registered; appName = $script:appName; error = $script:initError; toastEnabled = $script:toastEnabled; toastGate = $script:toastGate }",
    "Say 'READY' ($ready | ConvertTo-Json -Compress)",
    '',
    '# —— 前台窗口探测：判断"用户此刻是不是就坐在 DSH 页面上"。',
    '#    这是"我在页面上就别弹"这条要求的**唯一可靠判据**：宿主传感器不依赖页面，',
    '#    页面被冻结/没打开时也照跑，所以不能靠页面报告焦点，必须直接问 Windows。',
    '#    GetForegroundWindow → 拿到前台窗口 → 查它属于哪个进程 → 和本进程的 exe 比。',
    'Add-Type -TypeDefinition ' + psLiteral(FOREGROUND_CSHARP) + ' -Language CSharp | Out-Null',
    '$script:selfName = ' + psLiteral(selfProcessName === null ? '' : selfProcessName),
    'function ForegroundProbe {',
    '    $out = @{ present = $false; foreground = ' + psLiteral('') + '; self = $script:selfName; error = ' + psLiteral('') + ' }',
    '    try {',
    '        $hwnd = [FgWindow]::GetForegroundWindow()',
    '        if ($hwnd -eq [IntPtr]::Zero) { $out.error = ' + psLiteral('no-foreground-window') + '; return $out }',
    '        $fpid = 0',
    '        [void][FgWindow]::GetWindowThreadProcessId($hwnd, [ref]$fpid)',
    '        $proc = Get-Process -Id $fpid -ErrorAction SilentlyContinue',
    '        if ($null -eq $proc) { $out.error = ' + psLiteral('no-process') + '; return $out }',
    '        $out.foreground = $proc.ProcessName',
    '        if ($script:selfName -ne ' + psLiteral('') + ') {',
    '            $out.present = ($proc.ProcessName -ieq $script:selfName)',
    '        } else {',
    '            # 拿不到自身进程名 ⇒ 判不了，按"不在"处理（宁可多弹，也别让你漏掉提醒）',
    '            $out.error = ' + psLiteral('no-self-name') + '',
    '        }',
    '    } catch {',
    "        $out.error = 'probe: ' + $_.Exception.Message",
    '    }',
    '    return $out',
    '}',
    '',
    '# —— 单条请求的处理（base64 解 JSON → 弹 toast → 放音 → 回执）。',
    'function Handle([string]$line) {',
    "    $parts = $line.Split(' ', 2)",
    '    $rid = $parts[0]',
    '    # 前台探测是一条独立命令：payload 是 ?（也容忍尾随空格 / 空 payload）。',
    '    # 行协议只保证按换行符切行，尾随空白必须先裁掉再判——',
    '    # 真机调试时被 `echo 1 ? ` 的尾空格坑过一次（判成 ? + 空格 ⇒ 掉进 base64 分支报 bad-request）。',
    '    $probeOnly = ($parts.Length -lt 2) -or ($parts[1].Trim() -eq ' + psLiteral('?') + ') -or ($parts[1].Trim() -eq ' + psLiteral('') + ')',
    '    if ($probeOnly) {',
    '        Say $rid ((ForegroundProbe) | ConvertTo-Json -Compress)',
    '        return',
    '    }',
    '    $req = $null',
    '    try {',
    '        $req = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1])) | ConvertFrom-Json',
    '    } catch {',
    '        Say $rid \'{"ok":false,"toast":false,"sound":false,"error":"bad-request"}\'',
    '        return',
    '    }',
    '    $res = @{ ok = $false; toast = $false; sound = $false; aumid = $script:aumid; appName = $script:appName; registered = $script:registered; error = ' + psLiteral('') + ' }',
    '    # 释放命令：把缓存的 MediaPlayer 全部 Close 掉。',
    '    # 为什么需要（真机踩到）：MediaPlayer 一旦 Open 就会**占住文件句柄**，',
    '    # 于是宿主删不掉那个音效（EPERM）。用户在设置页点"删除"时必须先释放。',
    '    if ($req.release -eq $true) {',
    '        $closed = 0',
    '        foreach ($key in @($script:players.Keys)) {',
    '            try { $script:players[$key].Close(); $closed += 1 } catch { }',
    '        }',
    '        $script:players = @{}',
    "        Say $rid ('{\"ok\":true,\"released\":' + $closed + '}')",
    '        return',
    '    }',
    "    $soundOnly = ($req.soundOnly -eq $true)",
    '    if (-not $soundOnly) {',
    '        try {',
    '            ShowToast $script:aumid $req.title $req.body $req.tag $req.group $req.icon',
    '            $res.toast = $true',
    '        } catch {',
    "            $res.error = 'toast: ' + $_.Exception.Message",
    '        }',
    '    }',
    '    if ($null -ne $req.sound) {',
    '        try {',
    '            # 只播音效时不需要等"卡片画完"（根本没有卡片）。',
    "            if (-not $soundOnly -and $script:cardDrawMs -gt 0) { Start-Sleep -Milliseconds $script:cardDrawMs }",
    '            # PlaySound 返回 $false = 被最短间隔挡下（同一个音效刚响过），',
    '            # 这时**如实回报 sound=false + skippedMinGap**，不要谎报"播过了"——',
    '            # 页面/探针据此才能区分"没播"和"播失败"。',
    '            $played = PlaySound $req.sound.path ([int]$req.sound.volume)',
    '            if ($played) { $res.sound = $true } else { $res.skippedMinGap = $true }',
    '        } catch {',
    "            $res.error = $res.error + ' | sound: ' + $_.Exception.Message",
    '        }',
    '    }',
    '    $res.ok = ($res.toast -or $soundOnly)',
    '    Say $rid ($res | ConvertTo-Json -Compress)',
    '}',
    '',
    '# —— 主循环：**异步**读 stdin，500ms 一轮好让空闲自退能被检查到。',
    '# ⚠️ 坑（真机抓到的）：这里不能用 [Console]::In.ReadLineAsync()。',
    '#    PS 5.1 里 Console.In 是 SyncTextReader，它的 ReadLineAsync() 实现就是',
    '#    Task.FromResult(ReadLine())——**同步阻塞**。于是 Wait(500) 每次都立刻返回 true，',
    '#    轮询分支永远走不到，worker 不会空闲自退（实测 idleMs=3000 时 t+15s 还活着）。',
    '#    改成对标准输入流做 APM 异步读 + AsyncWaitHandle.WaitOne(500) 轮询，这才真的能超时。',
    '#    行的拆分自己来：协议全是 ASCII（base64），按 [char]10 切即可。',
    '$script:idleMs = ' + String(idleMs),
    '$stdin = [Console]::OpenStandardInput()',
    '$buffer = New-Object byte[] 65536',
    '$text = ' + psLiteral(''),
    '$async = $null',
    '$last = [DateTime]::UtcNow',
    'while ($true) {',
    '    if ($null -eq $async) { $async = $stdin.BeginRead($buffer, 0, $buffer.Length, $null, $null) }',
    '    if (-not $async.AsyncWaitHandle.WaitOne(500)) {',
    '        if (([DateTime]::UtcNow - $last).TotalMilliseconds -gt $script:idleMs) { exit 0 }',
    '        continue',
    '    }',
    '    $count = 0',
    '    try { $count = $stdin.EndRead($async) } catch { break }',
    '    $async = $null',
    '    if ($count -le 0) { break }',
    '    $text = $text + [System.Text.Encoding]::ASCII.GetString($buffer, 0, $count)',
    '    while ($true) {',
    '        $idx = $text.IndexOf([char]10)',
    '        if ($idx -lt 0) { break }',
    '        $one = $text.Substring(0, $idx).TrimEnd([char]13).TrimEnd()',
    '        $text = $text.Substring($idx + 1)',
    '        if ($one.Length -gt 0) {',
    '            $last = [DateTime]::UtcNow',
    '            Handle $one',
    '        }',
    '    }',
    '}',
    'exit 0',
    '',
  ].join('\n')
}



/**
 * 创建原生通知通道。
 *
 * 冻结接口（Lead 的 index.js 按这个调用）：
 *   notifier.notify(msg) -> Promise<{ delivered: string[], degraded: string[] }>
 *   notifier.status() -> { available, backend, reason?, calls, failures, lastLatencyMs? }
 *   notifier.dispose() -> void
 *
 * @param options 注入点（全部可选）：
 *   log       日志出口，默认 console.warn
 *   spawn     子进程工厂，默认 node:child_process.spawn（单测注入桩）
 *   env       环境变量表，默认 process.env
 *   platform  平台名，默认 process.platform
 *   powershell powershell.exe 路径
 *   homeDir   DSH home（决定音效落盘位置）
 *   timeoutMs 单次投递硬超时，默认 4000
 *   idleMs    worker 空闲自退，默认 60000
 * @returns notifier。
 */
export function createNativeNotifier(options) {
  const opt = options !== null && typeof options === 'object' ? options : {}
  const spawnFn = typeof opt.spawn === 'function' ? opt.spawn : nodeSpawn
  const log = typeof opt.log === 'function' ? opt.log : (message) => console.warn(message)
  const platform = typeof opt.platform === 'string' ? opt.platform : process.platform
  const timeoutMs = Number.isFinite(opt.timeoutMs) ? Math.max(50, opt.timeoutMs) : DEFAULT_TIMEOUT_MS
  const idleMs = Number.isFinite(opt.idleMs) ? Math.max(1000, opt.idleMs) : DEFAULT_IDLE_MS
  const readyTimeoutMs = Number.isFinite(opt.readyTimeoutMs) ? Math.max(100, opt.readyTimeoutMs) : DEFAULT_READY_TIMEOUT_MS

  const state = {
    disposed: false,
    calls: 0,
    /** 系统通知总开关（worker READY 时才知道；null = 还没探到）。 */
    toastEnabled: null,
    toastGate: 'unknown',
    failures: 0,
    lastLatencyMs: undefined,
    available: platform === 'win32',
    reason: platform === 'win32' ? undefined : 'not-windows',
    aumid: NATIVE_AUMID,
    appName: 'DoneVoice',
    registered: false,
    worker: null,
    nextId: 1,
    /** 正在飞的通知数（>0 时 pin 住 worker 的管道，保证投递完成）。 */
    pendingNotifies: 0,
  }

  /**
   * 把 worker 的进程句柄与三个管道一起 unref：**不阻止宿主退出**，但读写照常工作。
   * @param worker worker 记录。
   */
  function unpinWorker(worker) {
    const child = worker?.child
    for (const stream of [child, child?.stdin, child?.stdout, child?.stderr]) {
      if (stream !== null && stream !== undefined && typeof stream.unref === 'function') stream.unref()
    }
  }

  /**
   * 把 worker 的进程句柄与三个管道一起 ref（只有"有通知正在飞"时才这么干）。
   * @param worker worker 记录。
   */
  function pinWorker(worker) {
    const child = worker?.child
    for (const stream of [child, child?.stdin, child?.stdout, child?.stderr]) {
      if (stream !== null && stream !== undefined && typeof stream.ref === 'function') stream.ref()
    }
  }

  /**
   * 按当前在飞的通知数决定 pin 还是 unpin。
   * 规则：`pendingNotifies > 0` → pin（这条通知必须送出去）；否则 unref（宿主随时可以退）。
   */
  function applyPin() {
    const worker = state.worker
    if (worker === null || worker === undefined) return
    if (state.pendingNotifies > 0) pinWorker(worker)
    else unpinWorker(worker)
  }

  /** 拉起 worker（幂等）。返回 { promise, worker }——promise 在收到 READY 后兑现。 */
  function startWorker() {
    const ps = resolvePowershell(opt)
    if (!ps.ok) {
      state.available = false
      state.reason = 'no-powershell'
      return { promise: Promise.resolve(null), worker: null, reason: 'no-powershell' }
    }
    const worker = {
      child: null,
      ready: false,
      buffer: '',
      pending: new Map(),
      failed: false,
      stderr: '',
    }
    // ⚠️ 真机炸过的坑：`-EncodedCommand` 的载荷是 base64(UTF-16LE)，**受 Windows 命令行上限
    //    （32767 字符）约束**。脚本长到 266 行时直接 `spawn ENAMETOOLONG`，整条通道死掉。
    //    所以改成**把脚本落盘 + `-File` 启动**：长度不再受限，stdin 也完整留给行协议。
    //    落盘失败才退回 `-EncodedCommand`（此时长度超限就明确降级，不装作能跑）。
    let args
    try {
      // ★ 先把"点击通知激活窗口"的脚本落盘：worker 建快捷方式时 arguments 指向它，
      //   脚本不在的话，快捷方式就是个死链接（点了没反应）。
      const activate = ensureActivateScriptFile(opt)
      if (activate.path === null) log('[donevoice] 激活脚本落盘失败：' + String(activate.reason))
      // ★ 还要落 VBS 启动器：协议处理程序指向它（wscript 没有控制台 ⇒ 不会再闪黑窗口）。
      //   漏了这一步的后果真机见过：协议指向一个不存在的 .vbs，点击静默失效（clickHits 一直是 0）。
      const launcher = ensureActivateLauncherFile(opt)
      if (launcher.path === null) log('[donevoice] 无窗口启动器落盘失败：' + String(launcher.reason))
      const script = workerScript({ ...opt, idleMs })
      const placed = ensureWorkerScriptFile(opt, script)
      if (placed.path !== null) {
        args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', placed.path]
      } else {
        const encoded = encodeCommand(script)
        if (encoded.length > MAX_ENCODED_COMMAND) {
          state.available = false
          state.reason = 'script-too-long'
          log('[donevoice] worker 脚本落盘失败且超过命令行上限（' + encoded.length + ' > ' + MAX_ENCODED_COMMAND + '）— ' + placed.reason)
          return { promise: Promise.resolve(null), worker: null, reason: 'script-too-long' }
        }
        args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded]
      }
    } catch (error) {
      state.available = false
      state.reason = 'script-build-failed'
      log('[donevoice] worker 脚本生成失败 — ' + String(error))
      return { promise: Promise.resolve(null), worker: null, reason: 'script-build-failed' }
    }
    let child
    try {
      child = spawnFn(ps.path, args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: opt.env !== null && typeof opt.env === 'object' ? opt.env : process.env,
      })
    } catch (error) {
      state.available = false
      state.reason = 'spawn-failed'
      log('[donevoice] native worker 启动失败 — ' + String(error))
      return { promise: Promise.resolve(null), worker: null, reason: 'spawn-failed' }
    }
    worker.child = child
    // 让 worker 绝不拖住宿主退出。
    // ⚠️ 坑（真机抓到的）：只 unref 子进程**不够**——child.stdin/stdout/stderr 三个管道
    // 仍然是 ref 状态的 handle，会把 Node 的事件循环钉住，宿主想退出就得等 worker
    // 空闲 60 秒自退（实测就是这样挂住的）。三个管道必须一起 unref。
    // 反过来，全程 unref 又会让"只有这一件事可做"的短命进程在投递途中直接退出
    // （实测 155ms 就退了，通知根本没发出去）。所以策略是：
    //   **平时 unref（绝不阻止宿主退出），notify 在飞的时候临时 ref（保证这条通知送得出去），
    //     投递结束立刻恢复 unref。**
    unpinWorker(worker)
    // READY 也要有超时：worker 起来了却始终不打 READY，不能让调用方永久挂住。
    // 这个计时器**故意 unref**：宿主想退出时它不该成为阻碍；宿主还活着时它保证调用方能收场。
    const readyTimer = setTimeout(() => {
      worker.failed = true
      // 先记账再杀进程：这样"死因"是 timeout，而不是随后那次 close 的 worker-gone。
      log('[donevoice] native worker 就绪超时（' + readyTimeoutMs + 'ms），已杀掉')
      finish(worker, 'timeout')
      try { child.kill() } catch { /* 忽略 */ }
    }, readyTimeoutMs)
    if (typeof readyTimer.unref === 'function') readyTimer.unref()
    worker.readyTimer = readyTimer
    // 已经有通知在等这个 worker 的话，替它把管道 pin 住，别让进程在 READY 之前退出。
    if (state.pendingNotifies > 0) pinWorker(worker)

    const readyPromise = new Promise((resolve) => {
      worker.settleReady = resolve
    })
    // 并发闸门：多个 notify 同时来时只能拉起**一个** worker，其余的等这一个 READY。
    worker.readyPromise = readyPromise

    child.stdout?.on('data', (chunk) => {
      worker.buffer += String(chunk)
      let index = worker.buffer.indexOf('\n')
      while (index >= 0) {
        const line = worker.buffer.slice(0, index).replace(/\r$/, '')
        worker.buffer = worker.buffer.slice(index + 1)
        handleLine(worker, line)
        index = worker.buffer.indexOf('\n')
      }
      // 防御：真出现无换行的异常洪水时不要把内存吃光。
      if (worker.buffer.length > 1_000_000) worker.buffer = ''
    })
    child.stderr?.on('data', (chunk) => {
      worker.stderr = (worker.stderr + String(chunk)).slice(-2000)
    })
    child.stdin?.on?.('error', () => {}) // EPIPE：worker 先死时的正常现象，别让它变成未捕获异常。
    child.on('error', (error) => {
      worker.failed = true
      state.available = false
      state.reason = 'no-powershell'
      log('[donevoice] native worker 无法启动（' + ps.path + '）— ' + String(error))
      finish(worker, 'no-powershell')
    })
    child.on('close', () => {
      worker.failed = true
      finish(worker, 'worker-gone')
      if (state.worker === worker) state.worker = null
    })
    state.worker = worker
    return { promise: readyPromise, worker, reason: null }
  }

  /** worker 退出：把所有在等回执的请求就地降级，绝不留下悬空的 Promise。 */
  function finish(worker, code) {
    // 只记第一个原因：先到的才是真因（例如 spawn ENOENT 之后必然还会来一次 close，
    // 那次的原因只是"进程关了"，不能覆盖掉 no-powershell）。
    if (worker.exitCode === undefined) worker.exitCode = code
    if (worker.readyTimer !== undefined) {
      clearTimeout(worker.readyTimer)
      worker.readyTimer = undefined
    }
    const settle = worker.settleReady
    worker.settleReady = null
    if (typeof settle === 'function') settle(null)
    for (const [, entry] of worker.pending) {
      clearTimeout(entry.timer)
      entry.resolve({ delivered: [], degraded: [code] })
    }
    worker.pending.clear()
  }

  /** 处理 worker 的一行输出（READY / 回执）。 */
  function handleLine(worker, line) {
    if (line.indexOf('@@DV ') !== 0) return
    const rest = line.slice(5)
    const sep = rest.indexOf(' ')
    if (sep < 0) return
    const id = rest.slice(0, sep)
    let payload
    try {
      payload = JSON.parse(Buffer.from(rest.slice(sep + 1), 'base64').toString('utf8'))
    } catch {
      return
    }
    if (id === 'READY') {
      worker.ready = true
      if (worker.readyTimer !== undefined) {
        clearTimeout(worker.readyTimer)
        worker.readyTimer = undefined
      }
      if (payload !== null && typeof payload === 'object') {
        if (typeof payload.aumid === 'string' && payload.aumid !== '') state.aumid = payload.aumid
        if (typeof payload.appName === 'string' && payload.appName !== '') state.appName = payload.appName
        state.registered = payload.registered === true
        // 系统通知总开关：关着的话"投递成功"也看不见任何东西 —— 这是最常见的误报来源，
        // 所以一旦知道就**当场出声**（免得用户以为插件坏了、我们还在探针里说一切正常）。
        if (payload.toastEnabled === false) {
          state.toastEnabled = false
          state.toastGate = typeof payload.toastGate === 'string' ? payload.toastGate : 'off'
          console.warn('[donevoice] ⚠️ 系统通知总开关是关闭的（' + state.toastGate + '）——'
            + '提醒会被系统静默丢弃，屏幕上看不到任何横幅，但音效照响。'
            + '请在「设置 → 系统 → 通知」里打开通知。')
        } else if (payload.toastEnabled === true) {
          state.toastEnabled = true
          state.toastGate = typeof payload.toastGate === 'string' ? payload.toastGate : 'on'
        }
        if (payload.init === false) log('[donevoice] native worker 初始化降级 — ' + payload.error)
        else log('[donevoice] native worker 就绪 aumid=' + state.aumid + ' app=' + state.appName)
      }
      const settle = worker.settleReady
      worker.settleReady = null
      if (settle) settle(worker)
      return
    }
    const entry = worker.pending.get(id)
    if (!entry) return
    worker.pending.delete(id)
    clearTimeout(entry.timer)
    // 前台探测的回执是"原样 JSON"，不走投递结果那套翻译。
    if (entry.presence === true) entry.resolve(payload !== null && typeof payload === 'object' ? payload : { present: false })
    else entry.resolve(normalizeResult(payload, entry.wantSound, entry.soundOnly))
  }

  /** 把 worker 的回执翻译成冻结接口要求的 { delivered, degraded }。 */
  function normalizeResult(payload, wantSound, soundOnly) {
    const delivered = []
    const degraded = []
    const ok = payload !== null && typeof payload === 'object' ? payload : {}
    // `soundOnly` 请求本来就不该弹卡片 ⇒ 不把"没弹"记成失败。
    if (soundOnly !== true) {
      if (ok.toast === true) delivered.push('toast')
      else degraded.push('toast-failed')
    }
    if (wantSound) {
      if (ok.sound === true) delivered.push('sound')
      // 被"最短重播间隔"挡下不是失败：同一个音效刚刚响过（两个会话几乎同时收尾），
      // 再播只会把上一声掐成半截。如实标注 `sound-skipped`，别谎报 failed。
      else if (ok.skippedMinGap === true) degraded.push('sound-skipped')
      else degraded.push('sound-failed')
    }
    if (ok.error) log('[donevoice] native 投递降级 — ' + String(ok.error))
    return { delivered, degraded }
  }

  /**
   * 一个 worker 的"死因"：优先用它自己记下的第一个原因（timeout / no-powershell / …），
   * 兜底才用全局 reason。
   * @param worker worker 记录。
   * @returns 降级原因码。
   */
  function firstReason(worker) {
    return worker?.exitCode ?? state.reason ?? 'worker-gone'
  }

  /** 确保 worker 就绪；失败时返回原因码。 */
  async function ensureWorker() {
    if (state.worker !== null) {
      if (state.worker.ready === true) return { worker: state.worker, reason: null }
      // 正在启动中：复用同一个 READY Promise，避免并发拉出多个 powershell。
      if (state.worker.failed !== true && state.worker.readyPromise !== undefined) {
        const waiting = state.worker
        const pendingWorker = await waiting.readyPromise
        if (pendingWorker !== null) return { worker: pendingWorker, reason: null }
        return { worker: null, reason: firstReason(waiting) }
      }
      state.worker = null
    }
    const started = startWorker()
    if (started.reason !== null) return { worker: null, reason: started.reason }
    const worker = await started.promise
    if (worker === null) return { worker: null, reason: firstReason(started.worker) }
    return { worker, reason: null }
  }

  function status() {
    const value = {
      available: state.available,
      backend: state.available ? 'winrt-toast' : 'none',
      calls: state.calls,
      failures: state.failures,
    }
    if (state.reason !== undefined) value.reason = state.reason
    if (state.lastLatencyMs !== undefined) value.lastLatencyMs = state.lastLatencyMs
    // 以下是非冻结的附加信息，方便 evidence / 排障，不改变上面的契约。
    value.aumid = state.aumid
    value.appName = state.appName
    value.registered = state.registered
    value.worker = state.worker !== null && state.worker.ready ? 'ready' : 'idle'
    // 系统通知总开关（worker 起来后才知道；没起来时是 unknown）。
    value.toastEnabled = state.toastEnabled
    value.toastGate = state.toastGate
    value.sounds = soundDir(opt)
    value.icons = iconDir(opt)
    return value
  }

  /** 只读：当前实际生效的 AUMID（回读历史要用它）。 */
  function aumid() {
    return state.aumid
  }

  /**
   * 预热（**非冻结**的附加接口）：提前把 worker 拉起来，把 ~1.2s 的首次冷启动
   * 挪到插件加载时，别让用户的第一条提醒等在那里。
   * @returns Promise<boolean> 是否就绪；任何失败都只返回 false，不抛。
   */
  function warmup() {
    if (state.disposed || platform !== 'win32') return Promise.resolve(false)
    return ensureWorker().then((ensured) => ensured.worker !== null).catch(() => false)
  }

  async function notify(message) {
    if (state.disposed) return { delivered: [], degraded: ['disposed'] }
    if (platform !== 'win32') return { delivered: [], degraded: ['not-windows'] }
    state.calls += 1
    const startedAt = Date.now()
    // 这条通知在飞期间：把 worker 的管道 pin 住，保证"宿主只有这一件事可做"时也送得出去；
    // 送完立刻 unpin，恢复"绝不阻止宿主退出"。
    state.pendingNotifies += 1
    applyPin()
    try {
      return await deliver(message, startedAt)
    } finally {
      state.pendingNotifies -= 1
      applyPin()
    }
  }

  /**
   * 让 worker 释放它缓存的播放器（关闭文件句柄）。
   *
   * Windows 不允许删除被占用的文件：MediaPlayer 一 Open 就占住音效文件，
   * 于是"删除音效"会 EPERM。删文件之前先调这个。worker 没起来就直接返回（没占用，无须释放）。
   * @returns 释放结果（`{ ok, released }`）。
   */
  async function release() {
    if (state.disposed || platform !== 'win32') return { ok: false, released: 0, reason: 'not-available' }
    if (state.worker === null || state.worker.ready !== true) return { ok: true, released: 0, skipped: true }
    // 与 presence 同口径：先 pin 住管道，否则在"宿主只有这一件事可做"时事件循环会空掉。
    state.pendingNotifies += 1
    applyPin()
    try {
      const worker = state.worker
      const id = String(state.nextId++)
      const payload = Buffer.from(JSON.stringify({ release: true }), 'utf8').toString('base64')
      const reply = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          worker.pending.delete(id)
          resolve({ ok: false, released: 0, reason: 'timeout' })
        }, 2000)
        worker.pending.set(id, { resolve, timer, wantSound: false, presence: true })
        const stdin = worker.child?.stdin
        if (stdin === null || stdin === undefined || typeof stdin.write !== 'function') {
          clearTimeout(timer)
          worker.pending.delete(id)
          resolve({ ok: false, released: 0, reason: 'worker-gone' })
          return
        }
        try {
          stdin.write(id + ' ' + payload + '\n')
        } catch {
          clearTimeout(timer)
          worker.pending.delete(id)
          resolve({ ok: false, released: 0, reason: 'write-failed' })
        }
      })
      return reply !== null && typeof reply === 'object' ? reply : { ok: false, released: 0 }
    } finally {
      state.pendingNotifies -= 1
      applyPin()
    }
  }

  async function deliver(message, startedAt) {
    const msg = message !== null && typeof message === 'object' ? message : {}
    const kind = typeof msg.kind === 'string' && TOAST_TAGS[msg.kind] !== undefined ? msg.kind : 'test'
    const title = typeof msg.title === 'string' ? msg.title : 'DoneVoice'
    const body = typeof msg.body === 'string' ? msg.body : ''
    const sound = msg.sound !== null && typeof msg.sound === 'object' ? msg.sound : null
    const preset = sound !== null && typeof sound.preset === 'string' ? sound.preset : 'none'
    const volume = sound !== null ? clampVolume(sound.volume) : 0

    // 音效：preset none / volume 0 → 不播（也不算失败）。
    // 文件取自**插件自带的 `sounds/` 目录**（跟着插件走，不读任何外部路径）。
    let soundRequest = null
    let soundBroken = false
    if (preset !== 'none' && volume > 0) {
      const file = soundFileFor(opt, preset)
      if (file === null) soundBroken = true
      else soundRequest = { path: file, preset, volume }
    }
    if (soundBroken) log('[donevoice] 提示音文件缺失或 id 未知，只发通知 — preset=' + String(preset))

    // `soundOnly`：只播音效、不弹通知。用于"你在 DSH 页面上、但开了页内音效"那一档——
    // 那时不该有系统卡片（用户点名"我在工作状态，提醒多余"），但要能听见声音。
    const soundOnly = msg.soundOnly === true
    if (soundOnly && soundRequest === null) {
      // 没有可播的音效（静音/音量为 0/合成失败）⇒ 什么都不做，也不算失败。
      if (soundBroken) {
        state.failures += 1
        state.lastLatencyMs = Date.now() - startedAt
        return { delivered: [], degraded: ['sound-failed'] }
      }
      state.lastLatencyMs = Date.now() - startedAt
      return { delivered: [], degraded: [] }
    }

    const ensured = await ensureWorker()
    if (ensured.worker === null) {
      state.failures += 1
      state.lastLatencyMs = Date.now() - startedAt
      log('[donevoice] native 投递降级 — ' + ensured.reason)
      return { delivered: [], degraded: [soundBroken ? 'sound-failed' : ensured.reason].filter(Boolean) }
    }
    const worker = ensured.worker
    const id = String(state.nextId++)
    const request = {
      title,
      body,
      tag: String(TOAST_TAGS[kind]).slice(0, 16),
      group: TOAST_GROUP.slice(0, 16),
      // 卡片式视觉：一枚按 kind 着色的圆形图标（worker 会现画并缓存）。
      icon: iconFile(opt, kind),
      sound: soundRequest === null ? null : { path: soundRequest.path, volume: soundRequest.volume },
      // true = 只播音效、不弹卡片（"你在页面上但开了页内音效"那一档）。
      soundOnly,
    }
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        worker.pending.delete(id)
        // 卡死的 worker 直接杀掉：下一条通知会拉起一个干净的。
        try { worker.child?.kill() } catch { /* 忽略 */ }
        worker.failed = true
        if (state.worker === worker) state.worker = null
        log('[donevoice] native 投递超时（' + timeoutMs + 'ms），已杀掉 worker')
        resolve({ delivered: [], degraded: ['timeout'] })
      }, timeoutMs)
      worker.pending.set(id, {
        resolve,
        timer,
        wantSound: soundRequest !== null,
        soundOnly,
      })
      const line = id + ' ' + Buffer.from(JSON.stringify(request), 'utf8').toString('base64') + '\n'
      const stdin = worker.child?.stdin
      if (stdin === null || stdin === undefined || typeof stdin.write !== 'function') {
        clearTimeout(timer)
        worker.pending.delete(id)
        resolve({ delivered: [], degraded: ['worker-gone'] })
        return
      }
      try {
        stdin.write(line)
      } catch (error) {
        clearTimeout(timer)
        worker.pending.delete(id)
        log('[donevoice] native 投递写入失败 — ' + String(error))
        resolve({ delivered: [], degraded: ['worker-gone'] })
      }
    })
    state.lastLatencyMs = Date.now() - startedAt
    // 失败计数只在这里记一次：delivered 空 = 这条通知没送达（timeout / toast-failed / worker-gone 都算）。
    if (result.delivered.length === 0) state.failures += 1
    if (soundBroken && result.degraded.indexOf('sound-failed') < 0) result.degraded.push('sound-failed')
    return result
  }

/**
   * 问一句"用户此刻是不是就坐在 DSH 页面上"。
   *
   * 判据是 Windows 的**前台窗口属于哪个进程**（见 worker 里的 ForegroundProbe）：
   * 宿主传感器不依赖页面，所以不能靠页面报告焦点 —— 页面没开、被冻结时也得能判断。
   * 任何失败（worker 起不来 / 探测抛错 / 拿不到自身进程名）都返回 `present: false`：
   * **宁可多弹一条，也别让你漏掉提醒**。
   * @returns `{ present: boolean, foreground?: string, error?: string }`。
   */
  async function presence() {
    if (platform !== 'win32') return { present: false, error: 'not-windows' }
    if (state.disposed) return { present: false, error: 'disposed' }
    // ⚠️ 必须和 notify 一样先 pin：worker 的进程与三个管道是**故意 unref** 的
    //    （绝不阻止宿主退出），READY 计时器也是 unref 的。只有 pendingNotifies > 0 时才临时 ref。
    //    漏了这一步的后果实测过：在"只有这一件事可做"的短命进程里，事件循环直接空掉、
    //    Node 以 exit 13（unsettled top-level await）退出，探测永远不落定。
    state.pendingNotifies += 1
    applyPin()
    try {
      const ensured = await ensureWorker()
      if (ensured.worker === null) return { present: false, error: ensured.reason }
      const worker = ensured.worker
      const id = String(state.nextId++)
      const probe = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          worker.pending.delete(id)
          resolve({ present: false, error: 'timeout' })
        }, Math.min(timeoutMs, 1500))
        worker.pending.set(id, { resolve, timer, wantSound: false, presence: true })
        const stdin = worker.child?.stdin
        if (stdin === null || stdin === undefined || typeof stdin.write !== 'function') {
          clearTimeout(timer)
          worker.pending.delete(id)
          resolve({ present: false, error: 'worker-gone' })
          return
        }
        try {
          stdin.write(id + ' ?\n')
        } catch {
          clearTimeout(timer)
          worker.pending.delete(id)
          resolve({ present: false, error: 'write-failed' })
        }
      })
      return { present: probe.present === true, foreground: probe.foreground, self: probe.self, error: probe.error }
    } finally {
      state.pendingNotifies -= 1
      applyPin()
    }
  }

  function dispose() {
    if (state.disposed) return
    state.disposed = true
    const worker = state.worker
    state.worker = null
    if (worker === null) return
    for (const [, entry] of worker.pending) {
      clearTimeout(entry.timer)
      entry.resolve({ delivered: [], degraded: ['disposed'] })
    }
    worker.pending.clear()
    try { worker.child?.kill() } catch { /* 忽略 */ }
  }

  const notifier = { notify, presence, release, status, dispose, aumid, warmup }
  return notifier
}
