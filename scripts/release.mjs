#!/usr/bin/env node
/**
 * 发版脚本：把「改版本号 → 自检 → 提交 → 打 tag → 推送」这五步压成一条命令。
 *
 * 为什么需要它：DoneVoice 的版本号**必须三处一致**
 * （`package.json`、`index.js` 的 `export const version`、`client.js` 的 `const VERSION`），
 * 这是 ARCHITECTURE.md 里写死的契约。手改三次一定会漏一次，漏了之后
 * 「关于」页显示的版本和实际装到的版本对不上，用户报障时根本说不清。
 *
 * 默认是**预演**：只打印将要做什么，不写盘、不提交、不推送。
 *
 * 用法：
 *   node scripts/release.mjs --bump patch                 # 预演 1.1.0 -> 1.1.1
 *   node scripts/release.mjs --version 1.2.0              # 预演到指定版本
 *   node scripts/release.mjs --version 1.2.0 --apply      # 真的做
 *   node scripts/release.mjs --version 1.2.0 --apply --push   # 连推送一起
 *
 * 说明：--apply 只做本地提交与打标签；推送要再加 --push，因为推上去之后
 * 用户就能装到这一版了，值得单独确认一次。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_JSON = join(ROOT, 'package.json')
const INDEX_JS = join(ROOT, 'index.js')
const CLIENT_JS = join(ROOT, 'client.js')
const README = join(ROOT, 'README.md')
const CHANGELOG = join(ROOT, 'CHANGELOG.md')

/** 仓库地址，用来拼 Release 链接。改 remote 时记得一起改这里。 */
const REPO = 'zywnb-2/dsh-donevoice'

function git(args, { quiet = false } = {}) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'],
  }).trim()
}

function node(args) {
  execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
}

/**
 * 推送一个 ref，并在**读不到凭据**时自动补救。
 *
 * 为什么需要这段：`git push` 需要一个能给出凭据的 credential helper。在非交互环境里
 * （CI、脚本、没有 TTY 的终端）git 无法弹窗，只能报
 *
 *     fatal: could not read Username for 'https://github.com': terminal prompts disabled
 *
 * 而 Windows 上凭据其实**已经在 Credential Manager 里了**——只是 `~/.gitconfig` 里的
 * `credential.helper=` 被清空（PortableGit 的 helper-selector 选过「no helper」就会这样），
 * 于是没人去取。所以这里显式挂上 wincred 再试一次。凭据本身不会被打印出来。
 *
 * 真机踩过：一次发版里 `git push origin main` 成功、紧接着 `git push origin v1.1.1` 失败，
 * 脚本当场抛栈退出，标签留在本地没推上去——用户装到的还是旧版。
 * @param ref 分支名或标签名。
 * @returns 推送成功返回 true。
 * @throws 两次都失败时抛出（调用方负责给出人话）。
 */
function pushRef(ref) {
  const first = spawnSync('git', ['push', 'origin', ref], { cwd: ROOT, encoding: 'utf8' })
  if (first.status === 0) {
    process.stdout.write(first.stderr ?? '')
    return true
  }
  const text = `${first.stdout ?? ''}${first.stderr ?? ''}`
  if (!/could not read Username|terminal prompts disabled|Authentication failed|403/i.test(text)) {
    process.stderr.write(text)
    throw new Error(`git push origin ${ref} 失败`)
  }
  console.log(`  第一次推送没拿到凭据（非交互环境），改用 Windows 凭据管理器重试：${ref}`)
  const second = spawnSync('git', ['-c', 'credential.helper=wincred', 'push', 'origin', ref], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  if (second.status === 0) {
    process.stdout.write(second.stderr ?? '')
    return true
  }
  process.stderr.write(`${second.stdout ?? ''}${second.stderr ?? ''}`)
  throw new Error(
    `非交互环境读不到 GitHub 凭据，标签 ${ref} 没能推上去。`
      + `提交和标签都在本地，不会丢；在**你自己的终端**里跑这一行即可：git push origin ${ref}`,
  )
}

function parseArgs(argv) {
  const out = { apply: false, push: false, bump: null, version: null, allowDirty: false, tagCurrent: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') out.apply = true
    else if (arg === '--push') out.push = true
    else if (arg === '--allow-dirty') out.allowDirty = true
    else if (arg === '--tag-current') out.tagCurrent = true
    else if (arg === '--bump') out.bump = argv[++i]
    else if (arg.startsWith('--bump=')) out.bump = arg.slice(7)
    else if (arg === '--version') out.version = argv[++i]
    else if (arg.startsWith('--version=')) out.version = arg.slice(10)
    else if (arg === '--help' || arg === '-h') out.help = true
    else {
      console.error(`未知参数：${arg}`)
      process.exit(2)
    }
  }
  return out
}

function usage() {
  console.log(`用法：
  node scripts/release.mjs --bump patch|minor|major [--apply] [--push]
  node scripts/release.mjs --version <x.y.z>       [--apply] [--push]
  node scripts/release.mjs --tag-current           [--apply] [--push]   # 给当前版本补标签（首次发版用）

不加 --apply 时只预演；不加 --push 时只提交并打本地标签。`)
}

function bumpVersion(current, kind) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current)
  if (!match) throw new Error(`当前版本 "${current}" 不是 x.y.z 形式，请用 --version 指定`)
  const [major, minor, patch] = match.slice(1).map(Number)
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`
  throw new Error(`--bump 只接受 patch / minor / major，收到 "${kind}"`)
}

function readVersionIn(file, pattern) {
  const value = pattern.exec(readFileSync(file, 'utf8'))?.[1]
  if (!value) throw new Error(`${file} 里没找到版本号，模式：${pattern}`)
  return value
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  usage()
  process.exit(0)
}

// ------------------------------------------------------------------ 现状

const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))
const current = pkg.version
const target = args.tagCurrent
  ? current
  : args.version ?? (args.bump ? bumpVersion(current, args.bump) : null)
if (!target) {
  usage()
  process.exit(2)
}
if (!/^\d+\.\d+\.\d+$/.test(target)) {
  console.error(`目标版本 "${target}" 必须是 x.y.z 形式（不带 v 前缀，标签会自动加 v）`)
  process.exit(2)
}
if (target === current && !args.tagCurrent) {
  console.error(`目标版本与当前版本相同（${current}）。如果只是想给当前版本补一个标签，用 --tag-current`)
  process.exit(2)
}

const tag = `v${target}`
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { quiet: true })
const dirty = git(['status', '--porcelain'], { quiet: true })
const existingTags = git(['tag', '--list', tag], { quiet: true })

console.log(`当前版本   ${current}`)
console.log(`目标版本   ${target}  (标签 ${tag})`)
console.log(`分支       ${branch}`)
console.log('')

const blockers = []
if (existingTags === tag) blockers.push(`标签 ${tag} 已经存在，先确认是不是发重了`)
if (dirty !== '' && !args.allowDirty) {
  blockers.push(`工作区不干净，先把改动提交或暂存（或用 --allow-dirty 强行继续）：\n${dirty}`)
}
if (!readFileSync(CHANGELOG, 'utf8').includes(`## ${target}`) &&
    !readFileSync(CHANGELOG, 'utf8').includes(`## [${target}]`)) {
  blockers.push(`CHANGELOG.md 里没有 "## ${target}" 这一节。先手写这一版给用户看的话，再发版。`)
}
if (blockers.length > 0) {
  console.error('先解决这些再发版：')
  for (const item of blockers) console.error(`  · ${item}`)
  process.exit(1)
}

// ------------------------------------------------------------------ 计划

console.log('将要改动：')
if (args.tagCurrent) {
  console.log(`  （--tag-current：版本号保持 ${current} 不变，只补标签）`)
} else {
  console.log(`  package.json   "version": "${current}" -> "${target}"`)
  console.log(`  index.js       export const version = '${current}' -> '${target}'`)
  console.log(`  client.js      const VERSION = '${current}' -> '${target}'`)
  console.log(`  README.md      安装命令里的 #v${current} -> #v${target}`)
}
console.log('将要执行：')
console.log(`  node scripts/check-package.mjs`)
console.log(`  git add -A && git commit -m "release: ${tag}"`)
console.log(`  git tag ${tag}`)
console.log(`  git push origin ${branch} ${args.push ? `&& git push origin ${tag}` : '（需再加 --push）'}`)
console.log('')

if (!args.apply) {
  console.log('预演结束，什么都没改。确认无误后加 --apply。')
  process.exit(0)
}

// ------------------------------------------------------------------ 执行

const rewrite = (file, pattern, replacement) => {
  const before = readFileSync(file, 'utf8')
  const after = before.replace(pattern, replacement)
  if (after === before) throw new Error(`${file} 的版本号没有被改写，模式可能已经失效`)
  writeFileSync(file, after)
}

if (!args.tagCurrent) {
  rewrite(PACKAGE_JSON, new RegExp(`"version": "${current}"`), `"version": "${target}"`)
  rewrite(INDEX_JS, new RegExp(`export const version = '${current}'`), `export const version = '${target}'`)
  rewrite(CLIENT_JS, new RegExp(`const VERSION = '${current}'`), `const VERSION = '${target}'`)
  // README 的安装章节把 tag 写死在命令里，漏改就会让文档指着一个旧版本——
  // 正是这份文档自己反复警告的「文档和实际装到的版本对不上」。全局替换所有 #v<旧>。
  rewrite(README, new RegExp(`#v${current.replace(/\./g, '\\.')}\\b`, 'g'), `#v${target}`)
}

console.log('\n→ 自检')
node(['scripts/check-package.mjs'])

console.log('\n→ 提交')
git(['add', '-A'])
if (git(['status', '--porcelain'], { quiet: true }) === '') {
  console.log('  （没有需要提交的改动，跳过）')
} else {
  git(['commit', '-m', `release: ${tag}`])
}

console.log('\n→ 打标签')
git(['tag', '-a', tag, '-m', `${pkg.name} ${tag}`])

if (args.push) {
  console.log('\n→ 推送')
  let tagPushed = true
  pushRef(branch)
  try {
    pushRef(tag)
  } catch (error) {
    // 不在这里抛栈退出：分支已经推上去了，此时崩掉只会让人以为"整个发版失败"，
    // 而真正要记住的是"标签还没推，用户装到的还是旧版"。
    tagPushed = false
    console.error(`\n⚠️  分支推上去了，但标签 ${tag} 没推上去。`)
    console.error(`   ${error instanceof Error ? error.message : error}`)
  }

  if (tagPushed) {
    console.log(`
已推送。用户现在就能用这一行装到新版：

  github:${REPO}#${tag}

还差最后一步——建一个 Release。tag 已经够安装用了，Release 页面是给用户看
「这版改了什么」的地方，也是 GitHub 通知关注者的渠道：

  1. 打开 https://github.com/${REPO}/releases/new?tag=${tag}
  2. 标题填 ${tag}，正文从 CHANGELOG.md 复制「## ${target}」那一节
  3. 发布`)
  } else {
    console.log(`
⚠️  远端还只有旧标签，用户暂时装不到 ${tag}。把标签推上去之后再建 Release：

  https://github.com/${REPO}/releases/new?tag=${tag}`)
  }
} else {
  console.log(`
本地已完成（提交 + 标签），还没推。推送：

  git push origin ${branch} && git push origin ${tag}

推完再去建 Release：https://github.com/${REPO}/releases/new?tag=${tag}`)
}
