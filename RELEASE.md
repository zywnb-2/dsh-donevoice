# 发版与上架：怎么让用户一行装完

这份文档回答一件事：**DoneVoice 现在是「一个源码文件夹」，怎么变成「用户点一下就能装」的插件。**

参考实现是 [Oh My DSH](https://github.com/gulagala001/oh-my-dsh)：它的 README 里那句
`github:gulagala001/oh-my-dsh#v0.2.0-rc.2.omd.0.5.0` 就是最终形态。下面是同一套思路落到本仓库的做法。

---

## 一、先说清 DSH 是怎么装一个 GitHub 插件的

这部分是 DSH 内置插件管理器（`@deepseek-ai/dsh-plugin-manager`）的行为，决定了仓库必须长什么样。

### 1. 用户填进去的那串东西叫「安装规格」

DSH 认这几种形式（源码 `install-spec.ts` 的判定）：

| 形式 | 例子 | 说明 |
|---|---|---|
| 托管平台简写 | `github:zywnb-2/dsh-donevoice#v1.1.0` | **推荐**。`gitlab:` / `bitbucket:` / `gist:` 同理 |
| 仓库地址 | `https://github.com/zywnb-2/dsh-donevoice` | 也能装，但**锁不住版本**，跟着默认分支跑 |
| git 地址 | `git+https://…`、`git@github.com:…` | 私有仓库走这条 |
| 本地绝对路径 | `C:\path\to\extracted\dsh-donevoice` | 仅针对用户自己的解压目录；通常是本地引用，移走原目录可能失效；相对路径会被拒 |
| 压缩包 | `…/dsh-donevoice-1.1.0.tgz` | 离线分发用 |
| npm 包名 | `dsh-donevoice@1.1.0` | 如果以后发到 npm |

`#` 后面就是 git 的 ref，可以是 tag、分支或 commit。**写成 tag 才算「发布」。**

### 2. 装的时候实际发生了什么

```
① git ls-remote 探活         GitHub 仓库连得上吗（默认 5 秒超时，只查 GitHub）
② pnpm add <规格>            在 profile 目录里跑，用的就是 DSH 自带的 pnpm 11
③ 拉整包                     pnpm 从 codeload 下载整个仓库的 tarball（不是 clone）
④ 按 files 过滤              npm-packlist 用 package.json 的 files 白名单裁一遍
⑤ 落进 profile               <DSH_HOME>/profiles/<profile>/node_modules/dsh-donevoice
                            （默认 DSH_HOME=%USERPROFILE%\.dsh；各用户安装到自己的目录）
⑥ 写两处清单                 package.json 的 dependencies 加一条
                            dsh.profile.bundles 追加 "dsh-donevoice"（新装的默认启用）
⑦ 重启后挂载                 Host 半区由 cordis.patch.yml 插进组合树
```

失败或被取消时，第 ⑥ 步写的 `package.json` 和 `pnpm-lock.yaml` 会被**恢复原样**——
所以一次失败的安装不会把你的 profile 弄脏。

### 3. 三个「看代码看不出来、但会直接让用户装不上」的坑

| 坑 | 后果 | 本仓库的应对 |
|---|---|---|
| **`files` 漏了运行时文件** | 源码目录里一切正常，用户装到的是残包（最常见的是音效和语言包没了） | `scripts/check-package.mjs` 会跑一遍 `npm pack`，逐个断言必需文件在产物里 |
| **package.json 里有 `prepare` / `postinstall` 等构建脚本** | pnpm 11 会以 `GIT_DEP_PREPARE_NOT_ALLOWED` **直接拒绝安装**；用户看到的是「装不上」 | 同上，自检会把这些脚本名当红灯 |
| **peerDependencies 不满足宿主版本** | git 规格要**先下载再判定**兼容性，判不过就回滚重装 | 本插件只声明 `@deepseek-ai/cordis: "*"` 且标为 optional，不会被这条 peer 拦住；不代表所有 DSH 版本都能正常运行 |

还有一条不属于坑但要知道：**装完必须重启 DSH**，新的 Host 代码才会加载
（除非 profile 里开了 HMR）。

---

## 二、仓库要满足的条件（清单）

对照检查，本仓库现在**全部满足**：

- [x] `package.json` 在仓库根目录，且 `name` / `version` / `description` / `license` 齐全
- [x] `dsh.manifestVersion: 1`
- [x] `dsh.bundle.patch` 指向 `./cordis.patch.yml`，文件真实存在
- [x] `dsh.client.platform: "web"`，`exports["./client"]` 指向 `client.js`
- [x] `files` 白名单覆盖全部运行时文件（`index.js`、`client.js`、三个 host 模块、`cordis.patch.yml`、`icon.svg`、`sounds/*.mp3`、`locale/*.json`）
- [x] **没有**任何 `prepare` / `postinstall` 之类的构建脚本（源码即产物）
- [x] `peerDependencies` 宽松且 optional
- [x] `repository` / `homepage` / `bugs` 指向正确的 GitHub 地址
- [x] `icon.svg` 存在（插件卡片会显示它）
- [x] 版本号三处一致：`package.json` / `index.js` 的 `export const version` / `client.js` 的 `const VERSION`
- [x] `LICENSE`（MIT）与 `sounds/SOURCES.md`（提示音出处）都在
- [x] 有一个 `v<version>` 形式的 tag

---

## 三、发一次新版：四步

### 第 1 步：写更新记录

在 `CHANGELOG.md` 顶部加一节，标题必须是 `## <新版本号>`：

```markdown
## 1.2.0

**一句话说清这版为什么值得升。**

- 用户能感知到的变化，按重要性排。
```

发版脚本会检查这一节存不存在——写漏了不让发。

### 第 2 步：预演

```bash
node scripts/release.mjs --bump minor      # 1.1.0 -> 1.2.0，只打印要做什么
```

它会先拦下这几种情况：工作区不干净、tag 已存在、CHANGELOG 缺这一节。
预演输出里会明确列出**三处版本号**分别从什么改成什么。

### 第 3 步：执行

```bash
node scripts/release.mjs --bump minor --apply --push
```

脚本依次做：改三处版本号 → 跑发布自检 → `git commit -m "release: v1.2.0"` →
打附注标签 `v1.2.0` → 推分支和标签。

> 首次发版（版本号已经是 1.1.0、只是还没有标签）用：
> `node scripts/release.mjs --tag-current --apply --push`

### 第 4 步：在 GitHub 建 Release

打开脚本打印的地址，标题填 `v1.2.0`，正文从 `CHANGELOG.md` 复制对应那一节。

**Release 不是安装的必要条件**——tag 推上去用户就能装了。但 Release 页面是用户看
「这版改了什么」的地方，也是 GitHub 通知关注者的渠道，别省。

---

## 四、用户侧会看到的安装方式

发完版之后，把这三行写进 README 和任何宣传材料里：

**在 DSH 里装（推荐）** —— 设置 → 插件 → 添加插件，粘贴：

```
github:zywnb-2/dsh-donevoice#v1.2.0
```

**命令行装**：

```bash
dsh plugin --profile desktop add github:zywnb-2/dsh-donevoice#v1.2.0
```

（个别 DSH 版本不认 `add`，用 `install` 代替。）

**离线 / 开发用**（用户先下载并解压 ZIP，在内层含 `package.json` 的目录执行；不走 GitHub 探活）：

```bash
node install.mjs                # 先预演
node install.mjs --apply        # 确认后复制到该用户自己的 <DSH_HOME>/donevoice/plugin
```

注意：GitHub 版与脚本复制版**都在各用户的 DSH home 下，但落点不同**；不要让用户在插件页输入作者电脑上的绝对路径。本地路径直接装通常链接解压目录，移走后可能失效。GitHub 上的 `v1.1.1` 原版 ZIP 脚本有 `linkExists` 未定义的故障：下一个发布版本必须包含已修复的 `install.mjs`，否则不要把这条路当作公开的备用安装方案。

三种方式装完都要**重启 DSH**。

---

## 五、首次上架要做的一次性动作

- [ ] 仓库设为 **public**（私有仓库装不了）
- [ ] 仓库 About 填一句用途，Topics 加 `dsh`、`deepseek-harness`、`dsh-plugin`、`windows`、`notification`
- [ ] 打第一个 tag 并建 Release（见上面第三、四步）
- [ ] 确认 `LICENSE` 和 `sounds/SOURCES.md` 已在仓库里（提示音是 Pixabay 素材，出处要留）
- [ ] （可选，但值得）向 [Oh My DSH 的插件投稿队列](https://github.com/gulagala001/oh-my-dsh/issues/new?template=plugin-submission.yml)提一个 Issue：只填仓库地址和一句用途。被收录后会出现在它的「推荐插件」页里，是现成的曝光位
- [ ] （可选）以后想发到 npm：删掉 `private`（本仓库已无），`npm publish --access public`。发到 npm 之后安装规格可以简化成 `dsh-donevoice@1.2.0`

---

## 六、出问题时的排查顺序

| 现象 | 先看这里 |
|---|---|
| 用户说「装不上」 | 让他在插件页看错误码。`incompatible-version` = peer 不满足；`GIT_DEP_PREPARE_NOT_ALLOWED` = 仓库里有构建脚本；`not-a-bundle` = 包里没有 `dsh.bundle.patch` |
| 装上了但没反应 | 先确认重启过 DSH、总开关开了。再看 `http://127.0.0.1:<端口>/plugins/dsh-donevoice/health.json` |
| 装上了但缺音效 / 文案 | `files` 漏了文件。本地跑 `node scripts/check-package.mjs` 会直接点出来 |
| 设置页读不到值 | `cordis.patch.yml` 里的 id 和 `client.js` 的 `HOST_ENTRY_ID` 不一致，自检也会拦 |
| 版本对不上 | 三处版本号不一致，自检会拦 |

本地随时可以跑一遍完整自检：

```bash
node scripts/check-package.mjs
```
