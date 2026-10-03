# 提示音素材来源

本目录是插件**自带**的提示音，随插件一起移动/打包——
运行时不读取任何外部目录（收录后就地打包，运行时不依赖任何外部目录）。

现有 **48 个**，分两批：**15 个收录的第三方素材（MP3）** + **33 个本项目自己生成的（WAV）**。

播放方式：宿主进程的常驻 PowerShell worker 用 WPF `System.Windows.Media.MediaPlayer`
播放（`Add-Type -AssemblyName PresentationCore`）。选它而不是 `System.Media.SoundPlayer`
是因为 `MediaPlayer` 支持的格式更全（MP3 / WAV 都能播，`SoundPlayer` 只吃 WAV），
还能直接按 `Volume` 调音量（0..1），不必像以前那样把音量烘进合成出来的 WAV 里。

## 一、收录的第三方素材（15 个 MP3）

| id | 文件 | 原文件名 | 来源 |
|---|---|---|---|
| `bell` | `bell.mp3` | `dragon-studio-notification-bell-sound-1-376885.mp3` | Pixabay / dragon-studio |
| `ping` | `ping.mp3` | `dragon-studio-notification-ping-372476.mp3` | Pixabay / dragon-studio |
| `ping2` | `ping2.mp3` | `dragon-studio-notification-ping-372479.mp3` | Pixabay / dragon-studio |
| `notify1` | `notify1.mp3` | `dragon-studio-notification-sound-372474.mp3` | Pixabay / dragon-studio |
| `notify2` | `notify2.mp3` | `dragon-studio-notification-sound-effect-372475.mp3` | Pixabay / dragon-studio |
| `notify3` | `notify3.mp3` | `dragon-studio-new-notification-3-398649.mp3` | Pixabay / dragon-studio |
| `type20` | `type20.mp3` | `ribhavagrawal-notification-sound-type-20-no-copyright-410276.mp3` | Pixabay / ribhavagrawal |
| `msgping` | `msgping.mp3` | `universfield-message-ping-351298.mp3` | Pixabay / universfield |
| `new017` | `new017.mp3` | `universfield-new-notification-017-352293.mp3` | Pixabay / universfield |
| `new018` | `new018.mp3` | `universfield-new-notification-018-363746.mp3` | Pixabay / universfield |
| `new02` | `new02.mp3` | `universfield-new-notification-02-323592.mp3` | Pixabay / universfield |
| `new027` | `new027.mp3` | `universfield-new-notification-027-383749.mp3` | Pixabay / universfield |
| `new03` | `new03.mp3` | `universfield-new-notification-03-323602.mp3` | Pixabay / universfield |
| `positive` | `positive.mp3` | `universfield-positive-notification-351299.mp3` | Pixabay / universfield |
| `system02` | `system02.mp3` | `universfield-system-notification-02-352442.mp3` | Pixabay / universfield |

> Pixabay 内容许可：可免费用于商业与非商业用途、无需署名（此处署名是出于礼貌与可追溯）。

## 二、本项目自己生成的音效（33 个 WAV）

`ethereal_notify` 起这一批是**为本插件合成**的，不含任何第三方素材，不受上一条许可约束。
原始输出目录是 `Notice/outputs/ethereal_sounds`；那边的文件名带数字前缀与中文，
收录时按 `SOUND_ID_PATTERN`（`^[a-z0-9][a-z0-9_-]{0,39}$`）规整成小写 id，
对应关系见下表第三列。

<!-- BEGIN generated-sounds（由 .workbuddy-ai/add-sounds.mjs 生成，勿手改） -->

| id | 文件 | 生成时的文件名 | 中文名 |
|---|---|---|---|
| `ethereal_notify` | `ethereal_notify.wav` | `01_notify_空灵.wav` | 空灵·通知 |
| `ethereal_message` | `ethereal_message.wav` | `02_message_空灵.wav` | 空灵·消息 |
| `ethereal_error` | `ethereal_error.wav` | `03_error_空灵.wav` | 空灵·错误 |
| `notify_clean` | `notify_clean.wav` | `11_notify_clean.wav` | 干净通知 |
| `dingdong` | `dingdong.wav` | `12_dingdong.wav` | 叮咚 |
| `chime2` | `chime2.wav` | `13_chime2.wav` | 风铃 |
| `shortmsg` | `shortmsg.wav` | `14_shortmsg.wav` | 短消息 |
| `popup` | `popup.wav` | `15_popup.wav` | 弹出 |
| `prompt` | `prompt.wav` | `16_prompt.wav` | 提示 |
| `error` | `error.wav` | `17_error.wav` | 错误 |
| `deny` | `deny.wav` | `18_deny.wav` | 拒绝 |
| `click` | `click.wav` | `19_click.wav` | 点击 |
| `toggle` | `toggle.wav` | `20_toggle.wav` | 开关 |
| `mechanical_click` | `mechanical_click.wav` | `21_mechanical_click.wav` | 机械键 |
| `bubble` | `bubble.wav` | `22_bubble.wav` | 气泡 |
| `marimba` | `marimba.wav` | `23_marimba.wav` | 马林巴 |
| `arcade_powerup` | `arcade_powerup.wav` | `24_arcade_powerup.wav` | 街机升级 |
| `kalimba` | `kalimba.wav` | `25_kalimba.wav` | 拇指琴 |
| `laser_zap` | `laser_zap.wav` | `26_laser_zap.wav` | 激光 |
| `typewriter` | `typewriter.wav` | `27_typewriter.wav` | 打字机 |
| `pluck_bass` | `pluck_bass.wav` | `28_pluck_bass.wav` | 拨弦低音 |
| `celesta` | `celesta.wav` | `29_celesta.wav` | 钢片琴 |
| `coin` | `coin.wav` | `30_coin.wav` | 金币 |
| `sonar_ping` | `sonar_ping.wav` | `31_sonar_ping.wav` | 声呐 |
| `wood_tock` | `wood_tock.wav` | `32_wood_tock.wav` | 木鱼 |
| `warp_sweep` | `warp_sweep.wav` | `33_warp_sweep.wav` | 跃迁 |
| `heartbeat` | `heartbeat.wav` | `34_heartbeat.wav` | 心跳 |
| `ringtone_retro` | `ringtone_retro.wav` | `35_ringtone_retro.wav` | 复古铃声 |
| `glass_ping` | `glass_ping.wav` | `36_glass_ping.wav` | 玻璃叮 |
| `step_click` | `step_click.wav` | `37_step_click.wav` | 步进 |
| `bass_drop` | `bass_drop.wav` | `38_bass_drop.wav` | 低音下坠 |
| `sparkle_arp` | `sparkle_arp.wav` | `39_sparkle_arp.wav` | 闪烁琶音 |
| `mute_tap` | `mute_tap.wav` | `40_mute_tap.wav` | 静音轻点 |

<!-- END generated-sounds -->

## 加 / 换音效要动的地方

把文件放进本目录，然后**这四处必须一起改**——少改任何一处都**不会报错**，
只会表现成「设置页里选了没反应」「英文界面显示成一串 id」「下拉里有但点了没声」：

| 位置 | 内容 |
|---|---|
| `win-native.js` | `SOUND_FILES`：id → 文件名 |
| `host-config.js` | `ENUM_FIELDS.soundPreset`：配置契约的合法值 |
| `client.js` | `SOUND_IDS`：页面侧回落清单 |
| `client.js` | `settings.sound.<id>` 的中英标签**各一条** |

另外 `package.json` 的 `files` 要覆盖对应扩展名（现在同时收录 `sounds/*.mp3` 与
`sounds/*.wav`）。改完跑这两条：

```
node .workbuddy-ai/verify-sounds.mjs   # 清单三边一致 + 与磁盘逐字对账 + 标签齐全
node scripts/check-package.mjs         # 产物里逐个音效都在（防残包）
```
