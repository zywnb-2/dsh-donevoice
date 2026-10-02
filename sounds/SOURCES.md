# 提示音素材来源

本目录的 MP3 是插件**自带**的提示音，随插件一起移动/打包——
运行时不读取任何外部目录（收录后就地打包，运行时不依赖任何外部目录）。

播放方式：宿主进程的常驻 PowerShell worker 用 WPF `System.Windows.Media.MediaPlayer`
播放（`Add-Type -AssemblyName PresentationCore`）。选它而不是 `System.Media.SoundPlayer`
是因为 **SoundPlayer 只能播 WAV**，而这些素材是 MP3；MediaPlayer 还能直接按
`Volume` 调音量（0..1），不必像以前那样把音量烘进合成出来的 WAV 里。

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
| `audiomass-output` | `audiomass-output.mp3` | `audiomass-output.mp3`（作者自制） | 仓库作者自制 |

> Pixabay 内容许可：可免费用于商业与非商业用途、无需署名（此处署名是出于礼貌与可追溯）。
> 若要替换成自己的音效：把文件放进本目录，在 `win-native.js` 的 `SOUND_PRESETS`
> 与 `host-config.js` 的 `ENUM_FIELDS.soundPreset` 里各加一条即可（两边必须一致，
> 宿主启动时的契约自检会盯着）。
