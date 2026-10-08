# phone-mcp · 让 AI 用一部安卓手机

> 一个 MCP（Model Context Protocol）服务器：把你的安卓手机或模拟器交给 AI。
> 点按、滑动、输入中文、截图、录屏、跑连招、控制网易云音乐、刷 QQ 空间。

[![npm](https://img.shields.io/badge/npm-phone--mcp-cb3837)](https://www.npmjs.com/)
[![license](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-339933)](https://nodejs.org/)

---

## 这是什么

AI 现在能写代码、能查资料，但它**摸不到你的手机**。

`phone-mcp` 补上这一环：它通过 `adb` 把手机的操作能力包装成 34 个 MCP 工具，
任何支持 MCP 的客户端（Claude Desktop、Cursor、自研 Agent……）接上它之后，
AI 就能：

- 看一眼手机现在是什么界面（截图 / 界面结构）
- 点按钮、滑列表、打字、按返回
- 打开某个 App，然后一连串操作（连招 / 宏）
- 录一段屏幕，抽成关键帧"看"整个过程
- 顺手控制网易云音乐播放、看评论、在「一起听」房间里说话
- 刷 QQ 空间、点赞、评论

**手机侧不需要装任何东西**（中文输入可选装 ADBKeyboard）。
只要开着「无线调试」或插着 USB 就行。

---

## 快速开始

### 1. 准备 adb

```bash
# Windows: 下载 platform-tools 解压到任意目录，把该目录加进 PATH
# macOS:   brew install android-platform-tools
# Linux:   sudo apt install adb
```

`phone-mcp` 会自动去找 adb；找不到就让它走 `PATH`。
也可以显式指定：

```bash
export PHONE_ADB=/path/to/adb        # Windows: set PHONE_ADB=D:\platform-tools\adb.exe
```

### 2. 连上手机

**方式 A · 无线调试（Android 11+，推荐）**

手机：`设置 → 开发者选项 → 无线调试 → 使用配对码配对设备`

你会看到一组 `IP:端口` 和一个 6 位配对码。然后在 MCP 客户端里调用：

```
phone_pair   host=192.168.1.98  port=37821  code=123456
phone_connect host=192.168.1.98 port=5555
```

> 配对只需做一次。之后每次重连只要 `phone_connect`。

**方式 B · USB**

插上线，手机上允许 USB 调试。`phone_status` 就能看到设备了。

### 3. 装依赖并接入

```bash
npm install
node src/phone-mcp.js --selftest      # 自检：看看 adb 和设备认到没有
```

MCP 客户端配置（以通用 stdio 形式为例）：

```json
{
  "mcpServers": {
    "phone": {
      "command": "npx",
      "args": ["-y", "phone-mcp"],
      "env": {
        "PHONE_SERIAL": "192.168.1.98:5555"
      }
    }
  }
}
```

本地开发时：

```json
{
  "mcpServers": {
    "phone": {
      "command": "node",
      "args": ["/绝对路径/packages/phone-mcp/src/phone-mcp.js"]
    }
  }
}
```

---

## 34 个工具

### 📱 设备与连接（4）

| 工具 | 作用 |
|---|---|
| `phone_status` | adb 是否可用、认到了哪些设备 |
| `phone_pair` | 首次无线配对（填 IP / 端口 / 6 位配对码） |
| `phone_connect` | 连接到 `ip:端口` |
| `phone_devices` | 列出所有设备，并可切换当前使用的那台 |

### 👁 看（3）

| 工具 | 作用 |
|---|---|
| `phone_screenshot` | 截屏，直接把图片返回给视觉模型 |
| `phone_dump` | 导出界面结构，解析成「可点元素清单（文字/类型/中心坐标）」 |
| `phone_record_screen` | 录一段屏幕（最长 60 秒），自动抽帧成图片——用来"看"一个过程 |

> 💡 先 `phone_dump` 拿到元素和坐标再 `phone_tap`，比盲点稳得多；
> 但如果是自绘引擎的游戏（`dumpsys` 拿不到节点），就只能靠 `phone_screenshot` 看图点。

### ✋ 操作（7）

| 工具 | 作用 |
|---|---|
| `phone_tap` | 点坐标 |
| `phone_tap_text` | **按界面上的文字/描述找元素并点击**（推荐，比坐标稳） |
| `phone_swipe` | 滑动（返回桌面、下拉通知栏、翻页） |
| `phone_text` | 往输入框打字（**支持中文**，需手机装有 ADBKeyboard） |
| `phone_key` | 按键：back / home / enter / recent / 音量 / 电源 / 删除 / menu |
| `phone_open_app` | 按包名或关键字启动 App（内部用 `am start`，带多重兜底） |
| `phone_shell` | 直接跑一条 `adb shell` 命令（进阶） |

### 🎬 连招 / 宏（1）

**`phone_macro`** —— 一次调用执行一整串动作，是最高效的工具。

```jsonc
{
  "actions": [
    { "type": "tap",       "x": 1120, "y": 530 },
    { "type": "swipe",     "x1": 640, "y1": 600, "x2": 640, "y2": 200, "ms": 300 },
    { "type": "longpress", "x": 600, "y": 800, "ms": 800 },
    { "type": "text",      "text": "你好呀" },
    { "type": "key",       "key": "back" },
    { "type": "sleep",     "ms": 500 }
  ],
  "stepMs": 400,          // 每个动作之后的默认等待
  "repeat": 10,           // 整套重复 N 次
  "repeatGapMs": 300,     // 每次重复之间等多久
  "saveAs": "daily_run",  // 存成命名宏，下次 playName 一键放
  "screenshot": true      // 最后截个图
}
```

下次直接：

```jsonc
{ "playName": "daily_run", "repeat": 5 }
```

> 玩游戏、刷视频、重复签到——用这个比一次次 `phone_tap` 快几十倍。
> `listMacros: true` 可以列出存过的所有宏。

### 🎵 网易云音乐（11）

| 工具 | 作用 |
|---|---|
| `ncm_search` | 搜歌，返回 id 和歌名歌手 |
| `ncm_play` | 让 PC 版网易云播放指定的歌 |
| `ncm_now` | 现在在听什么（歌名/歌手/进度/是否在播/**正在唱的那一句歌词**） |
| `ncm_control` | play / pause / next / previous |
| `ncm_comments` | 看某首歌的热评 + 最新评论 |
| `music_lyrics` | 查歌词（公开接口，填歌名即可） |
| `ncm_room` | 「一起听」房间状态：在不在房间、有谁、听了多久 |
| `ncm_room_control` | 房间内同步播放控制（PLAY/PAUSE/NEXT/GOTO） |
| `ncm_room_say` | **在「一起听」房间里说话**（真发到房间聊天框） |
| `ncm_msg_users` | 列出你的私信会话（谁给你发过消息） |
| `ncm_inbox` | 看某个人的私信内容 |

> 「一起听」房间那部分走的是本机 PC 客户端的 CDP，不需要账号密码。

### 🌐 QQ 空间（7）

| 工具 | 作用 |
|---|---|
| `qzone_feeds` | 看好友动态（返回里带 `tid`） |
| `qzone_like` | 给一条说说点赞 |
| `qzone_comment` | 评论一条说说（**有严格限额**：每 10 分钟 1 条、每天 3 条） |
| `qzone_recent_like` | 给最新一条好友动态直接点赞（只要知道昵称） |
| `qzone_post` | 发一条说说（可带图，每分钟 1 条 / 每天 8 条） |
| `qzone_my_posts` | 看自己的说说列表 |
| `qzone_user_posts` | 看指定人的说说（传 QQ 号即可） |

> 📌 点赞优先，评论慎用——**评论发出去撤不回**，所以内置了限流。

### 🎥 视频（1）

| 工具 | 作用 |
|---|---|
| `video_frames` | 把一段视频抽成若干张关键画面，让视觉模型"看懂"内容 |

支持本机文件或 `http(s)` 直链，最长取 600 秒。

---

## 环境变量

全部可选，不填也能用（会自动探测）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PHONE_ADB` | 自动探测 | adb 可执行文件路径 |
| `PHONE_SERIAL` | 自动选第一台 | 设备序列号，例如 `192.168.1.98:5555` 或 `emulator-5554` |
| `PHONE_SHOT_DIR` | 系统临时目录 | 截图输出目录 |
| `PHONE_MACRO_FILE` | `~/.phone-mcp/macros.json` | 宏存储文件 |
| `PHONE_FFMPEG` | `ffmpeg` | ffmpeg 路径（只有 `video_frames` 需要） |
| `PHONE_MUSIC_OWNER_UID` | 空 | 网易云里"主人"的数字 uid（只有私信相关工具需要） |

---

## 中文输入

安卓的 `adb shell input text` **不支持中文**。

解决办法是装一个叫 **ADBKeyboard** 的输入法（开源、体积很小）：

1. 下载 APK 装到手机
2. 在 `设置 → 语言和输入法` 里启用它

`phone-mcp` 会在第一次输入中文时自动把它切成默认输入法，用完不管它。
没装的话工具会**明确告诉你**，而不是静默丢字。

---

## 安全提醒

这个 MCP 给 AI 的是**真手机的完整操作权**。请务必：

- ⚠️ **不要**把它接到你日常主力机上，尤其是装着支付、银行 App 的那台
- ✅ 推荐用**模拟器**或一台备用机
- ✅ 给 QQ 空间评论这类"发出去撤不回"的操作留好限额（本项目已内置）
- ✅ 在 MCP 客户端侧也加上人工确认

---

## 常见问题

**Q: `phone_status` 说 adb 不可用？**
装 platform-tools 并加进 PATH，或设 `PHONE_ADB`。

**Q: 连上了但 `phone_dump` 返回 0 个节点？**
说明这个 App 是自绘引擎（很多游戏都是）。改用 `phone_screenshot` 看图，
然后用 `phone_tap` 按坐标点。

**Q: 截图是黑的？**
某些 App 会禁止截屏（`FLAG_SECURE`）。模拟器上一般可以关掉这个限制。

**Q: 无线调试每次重启都要重新配对？**
不用。配对是一次性的，之后 `phone_connect` 即可。如果端口变了，
在手机的无线调试页面看新的端口。

**Q: 能在多个设备之间切换吗？**
能。`phone_devices` 传 `use` 参数即可切换。

---

## 开发

```bash
git clone <this-repo>
cd packages/phone-mcp
npm install

# 自检
node src/phone-mcp.js --selftest

# 在 MCP Inspector 里调试
npx @modelcontextprotocol/inspector node src/phone-mcp.js
```

代码结构：

```
src/
├── phone-mcp.js    MCP 服务器主体（工具定义 + adb 封装）
└── ncm.js          网易云音乐客户端（CDP 驱动本机 PC 客户端）
```

---

## License

MIT
