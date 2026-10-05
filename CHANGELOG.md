# Changelog

## v1.6.4 — 新增 OBS 浏览器源（推荐方案）

> v1.6.0 ~ v1.6.3 一直在尝试「让 OBS 抓到桌宠窗口」。
> 结论是**这条路走不通**：桌宠窗口既是透明（分层窗口），又由 Chromium 绕过 GDI 渲染，
> 两件事叠加，窗口采集与游戏采集都只能得到纯黑。
>
> **这一版换思路：不抓窗口了，让 OBS 自己渲染桌宠。**

### ✨ 浏览器源

桌宠启动后在本地开一个只监听 `127.0.0.1` 的 HTTP + WebSocket 服务，
OBS 用内置的 **浏览器源** 加载它：

1. 设置 → 集成 → 「在 OBS 里使用桌宠」→ 复制地址（形如 `http://127.0.0.1:14511/obs`）
2. OBS：来源 → `+` → **浏览器** → 粘贴地址 → 设置宽高 → 确定
3. 完成 —— **背景真透明，不需要绿幕**

| | 浏览器源 | 窗口/游戏采集 |
|---|---|---|
| 透明度 | ✅ 原生 | ❌ 纯黑 |
| 需要绿幕 | ✅ 不需要 | — |
| 桌面多出东西 | ✅ 不会 | — |
| 依赖窗口采集 | ✅ 完全不依赖 | 是（且抓不到） |

### 🔁 复用本体页面，不另做一套渲染

服务器把一份 **IPC 垫片**（`src/renderer/obs-shim.js`）注入到 **`desktop-pet.html` 本体**里，
垫片用 HTTP + WebSocket 实现同样的 `window.electronAPI`。所以：

- OBS 里的桌宠与桌面上的桌宠是**同一份页面**，永远不会走样
- 主进程把发给桌宠窗口的所有事件（`play-expression` / `play-motion` /
  `talking-state-changed` / `set-canvas-y` / …）**自动镜像**到浏览器源 —— 通过包装
  `webContents.send` 实现，新增事件类型无需改任何调用点

### 🔒 安全

- 只绑定 `127.0.0.1`，异地 `Host` 头直接 403
- 只服务白名单目录（`/src` `/libs` `/assets` `/model`）+ 路径穿越防护（含 URL 编码穿越）
- `/api/config` 与 WebSocket 的 `init` 都经过**深度脱敏**，API Key / Cookie 永不下发

### 🐛 实测中发现并修复的两个 bug

1. **模型目录读错配置文件**：dev 下承诺优先读 `userData`，结果读到了三个月前的旧配置，
   指向一个不存在的模型 → `/model/...` 全部 404。改为与主程序一致的优先级。
2. **垫片返回的模型基址必须是绝对 http URL**：`model-adapter.js` 会把任何不以
   `file://` / `http` 开头的路径改写成 `file:///...`（桌面上正确，浏览器源里不可用），
   导致**表情文件全部加载失败**。改为返回 `location.origin + '/model'`。

### ✅ 验证方式

用一个真实的 Chromium（与 OBS 同引擎）加载该地址并截图取像素：

```
captured size  : 400x600
drawn pixels   : 62327 (26.0% of the frame)
coloured pixels: 17450
shim connected : yes
model loaded   : yes
console errors : (none)
```

即页面确实画出了桌宠、且背景是透明的。

### 保留「OBS 兼容模式」

`--disable-gpu-compositing` 作为**备选**保留（万一你想用窗口采集）。
但实测它**并不能**让透明窗口变得可采集，所以不要再把它当主方案。

### 测试

新增 `tests/test-obs-server.js`（17 个）：脱敏（含序列化后不残留密钥）、
路径穿越与编码穿越防护、异地 Host 拒绝、`/obs` 注入垫片且注入位置在正文之前、
静态资源与模型目录服务、WebSocket 广播到客户端、端口释放。

## v1.6.3 — 修复 OBS 抓不到桌宠的真正原因

> v1.6.1 / v1.6.2 都还在围着「透明窗口」打转。这一版才是根因。

### 🎯 根因：Chromium 的渲染绕过了 Windows GDI

OBS 读窗口内容依赖 Windows GDI 那条路，而 **Electron/Chromium 用自己的合成路径把这条路绕过去了**，
所以 OBS 只能读到一片黑 —— 这解释了为什么：

- 窗口采集是黑的
- **游戏采集**也是黑的
- 采集方式选 Automatic / BitBlt / WGC 全都是黑的
- 换成不透明的抠像窗口就能抓到（因为那是另一种呈现方式）

> 佐证：[electron/electron#16955](https://github.com/electron/electron/issues/16955)
> —— OBS 开发者原话：「nothing I can do about capturing browser-based applications due to
> that render technique they're all using which **bypasses the windows GDI**」

### ✅ 修复：新增「OBS 兼容模式」

启动时关掉 Chromium 的 GPU 合成：

```js
app.commandLine.appendSwitch('disable-gpu-compositing');
```

这是其他 Electron 应用验证过的做法（它们叫它 streamer mode）。

| | |
|---|---|
| 打开方式 | 设置 → 集成 → 「OBS 兼容模式」→ 勾选 → 保存 → **立即重启** |
| 生效判据 | 启动日志出现 `[OBS] compatibility mode ON — disable-gpu-compositing, …` |
| 界面反馈 | 显示开关**当前是否真的生效**、是否需要重启 |
| 代价 | 渲染性能略降 —— 不直播时可以关掉 |

> 命令行开关只能在进程启动时决定，所以改完必须重启；界面上直接给了「立即重启」按钮。

### 也可以临时验证（不改设置）

```bash
node launch.js --disable-gpu-compositing     # 源码运行
Live2DPet.exe --disable-gpu-compositing      # 便携版
```

### 附带的一件事

兼容模式打开后，OBS 里直接用 **窗口采集** 抓 `Desktop Pet` 就行；
若仍是黑的，再试 **游戏采集 + 允许透明度**；最后兜底用 **显示器采集**。

采集的是**桌宠本体窗口** —— 功能完整、不遮挡屏幕、不需要绿幕、不需要任何额外窗口。

### 新增测试

`tests/test-obs-mode.js`（11 个）：开关解析、只接受显式 `true`、
不泄漏共享数组、配置文件缺失/损坏时的降级、打包版优先 userData、
以及开关确实被 append 到命令行。

## v1.6.2 — 改用正确的 OBS 采集方式（移除多余的采集窗口）

> 这是对 v1.6.0 / v1.6.1 中 OBS 方案的**方向纠正**。

### ❌ 之前错在哪

v1.6.0 引入「另开一个不透明抠像窗口」来绕开「透明窗口无法被采集」的问题。这个方案有三个硬伤：

1. **是复制渲染**：那个窗口自己加载了一份桌宠，**收不到主进程发来的表情、动作、说话气泡**，
   等于一个不会动的假人 —— 正常的桌宠功能在那个画面上根本用不了
2. **一大片色块挡住屏幕**：600×800 的不透明窗口置顶显示，会盖住用户正在看的内容
3. **方向本身就错了**：Windows 上透明窗口无法被「窗口采集」抓到，
   但**可以**被「游戏采集」抓到 —— 根本不需要额外窗口

### ✅ 正确做法

**OBS 用「游戏采集」（Game Capture）直接采集桌宠窗口本体：**

1. 来源 → `+` → **游戏采集**
2. 模式选「采集特定窗口」→ 窗口选 **`Desktop Pet`**
3. 勾选 **「允许透明度」**

特点：

| | 游戏采集 | 之前的抠像窗口 |
|---|---|---|
| 透明度 | ✅ 自带透明通道 | 需色度键抠像 |
| 功能完整 | ✅ 就是本体，表情/动作/气泡都在 | ❌ 复制渲染，不动 |
| 遮挡屏幕 | ✅ 不遮挡 | ❌ 600×800 色块置顶 |
| 需要绿幕 | ✅ 不需要 | ❌ 需要 |

> 同类透明 Live2D 软件（如 [VTube Studio](https://github.com/DenchiSoft/VTubeStudio/wiki/Recording-Streaming-with-OBS)）
> 官方推荐的就是这个做法：「**永远不要用绿幕**……选择 **Game Capture**，它支持透明背景」。

### 🧹 移除

- 删除 `src/main/capture-window.js`、`src/main/capture-ipc.js` 及其全部测试（21 个）
- 删除相关的配置段（`capture`）、托盘菜单项、preload IPC、渲染层样式与逻辑
- 删除全部 `capture.*` / `tray.captureWindow` i18n 键（3 语言同步）

### 📖 新增指引

设置 → 集成 的卡片改为**逐步指引**，并新增「游戏采集也是黑的」排查清单：

1. **以管理员身份运行 OBS**（最常见原因）
2. 确认窗口选的是 `Desktop Pet`
3. 确认勾了「允许透明度」
4. 双显卡笔记本确认 OBS 与桌宠在同一块显卡
5. 兜底：改用「显示器采集」

## v1.6.1 — 修复 OBS 采集窗口不可见（导致 OBS 抓不到）

> 这是 v1.6.0 的**关键修复**。如果你用 OBS 抓不到桌宠，请升级到本版本。

### 🐛 Bug 修复

**采集窗口创建了却从不显示 → OBS 自然抓不到**

- 现象：日志有 `[Capture] capture window opened`，但屏幕上**根本看不到绿色窗口**，OBS 里自然也没有东西可抓
- 两个原因：
  1. 采集窗口此前是 `alwaysOnTop: false`，会被浏览器/游戏等全屏窗口**完全盖住**；
     OBS 的 BitBlt 窗口采集是读窗口后台缓冲的，**被遮挡就是一片黑**
  2. 窗口以 `show: false` 创建，只依赖 `ready-to-show` 事件来显示；该事件在某些 GPU/加载路径下
     **不触发**，窗口就永远留在隐藏状态
- 修复：
  - 采集窗口改为**始终置顶**（可用 `alwaysOnTop: false` 关掉），确保不会被遮挡
  - 增加 **1.2 秒兜底显示**：即使 `ready-to-show` 不触发，也会强制把窗口显示出来
  - 窗口保持**可拖动**，置顶后依然能挪开（此前误把整页设为 `no-drag`，会导致窗口无法移动）

**验证方式**：直接对 1920×1080 桌面截图并按色值扫描统计抠像底色像素

| | 修复前 | 修复后 |
|---|---|---|
| 屏幕上纯色像素 | **0** | **20,390** |
| 判定 | 窗口不可见 | 596×764 的绿底窗口正常置顶显示 |

同时补充了 2 个回归测试（`ready-to-show` 不触发时仍会显示、置顶开关可关闭）。

### 📖 文档

- `使用说明.md`：补充「如果 OBS 里还是黑的」排查清单，并明确写出
  **不要直接采集 `Desktop Pet` 窗口**——透明窗口在 OBS 里必然全黑，这是系统限制

## v1.6.0 — DSH 接入 + 游戏陪伴 + 直播弹幕 + OBS 采集

> 主线是**接入外部世界**：能看到你在玩什么、能听懂直播间的弹幕、能被 OBS 抓到直播里，还能通过它本体使用 DeepSeek Harness。

### ✨ 新功能

**🛠 用桌宠驱动 DeepSeek Harness (DSH)**
- 通过桌宠本体直接执行 DSH 任务，输出实时回传到宠物气泡
- 一次性 headless 会话：不开端口、不拼 shell 字符串（避免引号注入），支持取消与超时
- 子进程树完整清理，不留孤儿进程

**🎮 游戏陪伴与日常陪伴**
- 自动识别正在玩的游戏（Steam / 原神 / 崩坏 / LOL / Minecraft 等），并有非游戏窗口排除规则
- **截屏理解你在干什么**，话题与当下操作相关（可关闭）
- 开口节奏控制 + 分时段问候，融入日常生活
- **默认开启免手语音输入**：陪伴时直接说话，不必碰键盘

**📺 哔哩哔哩直播间弹幕**
- 读取直播间弹幕，并**用软件内置 TTS 念出来**回应（用 `forceTts` 强制发声，不受音频模式影响）
- 回应策略：全部 / 只答提问 / 只答被点名 / 关闭；另有全局回应间隔与单观众冷却
- 智能过滤：`666` / `哈哈` / `233` / `打卡` / 纯标点 / 命令 / `@别人` 等低信息量弹幕
- **刷屏判定以「不同观众数」为准**：同一句话 8 秒内被 4 个以上不同观众刷出才抑制
- **可选登录（SESSDATA）**：部分房间匿名连接收不到弹幕，填 Cookie 以真实 uid 握手即可；
  **仅加密存本机**，与 API Key 同等处理
- 房间未开播时静默等待、开播即连；断线指数退避；主机列表轮换；WBI 失效自动重签；接口异常降级到默认服务器
- **宠物按需启动**：收到弹幕而宠物未运行时自动启动，不再静默丢弃

**🎥 OBS 采集（直播用）**
- 解决「OBS 窗口采集桌宠一片全黑」：透明窗口在 Windows 上属分层窗口，OBS 读它必然是黑的
- 另开一个**不透明抠像窗口**（默认纯绿 `#00FF00`），OBS 加「色度键」即可抠出透明桌宠
- 窗口标题固定 `Live2DPet Capture` 且显示在任务栏，便于在 OBS 列表中识别；底色与尺寸可调

### 🔧 改进
- **TTS 默认模型修正**：`mimo-v2.5-tts-voicedesign` → `mimo-v2.5-tts`
  （前者返回 HTTP 200 但音频为空且耗时约 10 秒，是**熔断频繁触发的根因**）
- **熔断修复**：指数退避（上限 10 分钟）、未配置时不再空跑、初始化重置熔断器、状态与诊断显示真实后端
- 前端可直接**修改并测试** TTS 配置，无需改文件重启
- 设置页新增**「集成 / Integrations」**标签，集中放置 DSH / 游戏陪伴 / 直播弹幕 / OBS 采集
- 设置窗口改为 520×780 可缩放，并复用已存在的窗口
- 新增 i18n 键值，中/英/日三语言各 345 项保持同步

### 🐛 Bug 修复
- 修复截屏链路返回值契约不一致（返回裸 base64，调用方按 `{success, data}` 读取），导致视觉记忆长期失效
- 修复弹幕在宠物忙碌时被静默丢弃，改为有界队列 + 排空循环
- 修复集成设置改动必须重启才生效（新增配置热重载）
- 修复保存设置会清空动作/表情列表
- 修复表情名单陈旧（27 项 vs 模型实际 11 项）导致部分表情无法触发
- 修复房间未开播时每 3 秒疯狂重建连接的握手循环
- 修复「相同文字 30 秒内只回一次」把少数观众的重复发言全部吞掉的问题

### 🧹 代码清理
- 移除已停用的 STT 相关模块（`local-stt.js` / `stt-service.js`）

### 🔒 安全
- `config.json`、`enhance-data.json` **已从版本控制移除**并加入 `.gitignore`（内含 API Key 等凭据）
- 新增 `config.example.json` 作为可分享的配置模板（密钥字段留空）

### 🙏 致谢

本次更新特别感谢 **[xfgryujk/blivedm](https://github.com/xfgryujk/blivedm)** —— Python 获取 B 站直播弹幕的库，也是本次弹幕客户端的主要参照。

本项目的 WebSocket 实现直接借鉴了它的成熟做法：

| 借鉴点 | 说明 |
|--------|------|
| WBI 签名与失效重签 | 遇 `-352` 时清空缓存口令并重新签名重试 |
| auth 包携带 `buvid` | 让服务端看到一致的设备身份 |
| 弹幕主机列表轮换 | 按 `retry_count % len(host_list)` 轮换，避免死磕单台故障主机 |
| 定时重新初始化 | 每 `max(3, 主机数)` 次重试重新获取 token 与主机列表 |
| 接口异常降级 | 取不到主机列表时退回默认服务器，而不是直接失败 |
| 可选 SESSDATA 登录 | 以真实 uid 握手，部分房间匿名收不到弹幕 |
| 协议文档整理 | [B站直播开放平台协议说明](https://open-live.bilibili.com/document/657d8e34-f926-a133-16c0-300c1afc6e6b) |

同时感谢 [xfgryujk/blivechat](https://github.com/xfgryujk/blivechat)（弹幕展示思路参考）、
[x380kkm/Live2DPet](https://github.com/x380kkm/Live2DPet)（本项目基础）、
[DeepSeek Harness](https://github.com/deepseek-ai)（Agent 运行环境），
以及 Live2D Cubism / Electron / PixiJS / Mimo API / 阿里云百炼 / OpenRouter 等开源项目与服务。

## v1.5.0 — 双模式 + 独立聊天窗口 + 酒馆预设系统

### ✨ 新功能
- **双模式聊天**：陪伴模式 + 酒馆模式（奇幻/赛博/仙侠），各自独立记忆
- **独立聊天窗口**：脱离桌宠窗口限制，可拖到屏幕任意位置
- **酒馆预设系统**：内置 3 套预设，支持 JSON 导入/导出/编辑
- **自动冒险日记**：酒馆切换时 AI 生成日记弹窗
- **暗色模式**：支持亮/暗切换，跟随系统偏好，同步聊天窗口
- **毛玻璃 UI**：设置页 backdrop-filter 模糊效果 + 圆角卡片
- **完整 i18n**：Settings/TTS/Tavern 全部支持中/英/日切换
- **TTS 诊断工具**：一键查看 TTS 服务状态

### 🔧 改进
- 移除废弃的 Translation API 和相关代码
- 移除 VOICEVOX 遗留代码和配置
- 聊天框改为独立 BrowserWindow（解决遮挡桌宠问题）
- 单窗口限制（防止多个聊天窗口）

### 🐛 Bug 修复
- 修复多后端 TTS 配置保存问题
- 修复 i18n 中 tavern 键缺失问题
- 修复暗色模式下拉菜单白色背景
- 修复大量字符串换行符语法错误



## v2.1.0 — Multi-Backend TTS & Enhanced Memory

### ✨ 新功能
- **多后端 TTS 语音合成**：支持小米蜜模 Mimo / 阿里云 TTS / 本地 VITS2 三种后端，设置中可切换
- **本地 VITS2 支持**：可配置服务地址、接口路径、说话人 ID，适配任意 VITS2 HTTP API
- **TTS 诊断工具**：设置页新增「🔍 诊断TTS」按钮，一键查看服务状态、熔断情况、API 配置
- **截图频率可配置**：设置中可自定义截图间隔（0=每次检测都截，也可设为 30秒/60秒等）
- **首次运行引导**：首次启动自动用浏览器打开使用说明文档
- **语音识别双保险**：优先使用 Web Speech API（本地离线识别），失败自动切换到 Mimo 云端

### 🧠 记忆系统增强
- **对话自动总结**：每 10 条对话自动生成阶段总结
- **兴趣话题追踪**：从对话中自动提取并追踪用户感兴趣的话题
- **偏好学习**：识别用户的喜欢/不喜欢/日常习惯
- **主动回忆机制**：宠物会冷不丁提起以前聊过的话题
- **视觉 + 文字记忆共享**：VLM 截屏识别结果融入对话记忆，AI 知道「你刚才在看什么」
- **记忆存储修复**：修复 ConversationStore 和 LongTermPool 互相覆盖数据的 bug，改为合并写入

### 🎤 语音交互优化
- **PCM 直接录音**：改用 ScriptProcessorNode 直接捕获 PCM 音频，不再依赖 WebM→WAV 转换
- **分块 Base64 编码**：修复大音频文件 `Maximum call stack size exceeded` 爆栈问题
- **实时音量指示**：录音时显示实时音量电平
- **按住说话**：按下录音松开发送，支持 60 秒长录音

### 🐛 Bug 修复
- 修复 TTS `optimize_text_preview` 参数在非 voicedesign 模型下导致 400 错误
- 修复 `desktop-pet-system.js` 和 `desktop-pet.html` 中多处字符串换行符被错误写入的语法问题
- 修复 `get-active-window` 频繁 fallback 导致后台刷屏的问题（添加 2 秒缓存）
- 修复截图频率控制中 `shouldScreenshot` 判断逻辑
- 修复 Aliyun Provider HMAC 签名中的反斜杠转义问题
- 修复多处多行字符串被实际写入文件导致的 SyntaxError

### 🧹 代码清理
- 删除已停用的 `translation-service.js` 及相关 UI/配置代码
- 删除旧的 `convertToWav()` 函数（已被 `pcmToWavBlob()` 替代）
- 删除旧的 `MediaRecorder` 录音方案残留代码
- 删除 `VOICEVOX` 相关遗留代码
- 清理 i18n 中翻译 API 相关的键值

<details>
<summary>中文</summary>

- **多后端 TTS**：支持 Mimo / 阿里云 / 本地 VITS2，设置中可切换
- **记忆系统增强**：自动总结、话题追踪、偏好学习、主动回忆
- **语音识别优化**：Web Speech API 本地优先，PCM 直接录音
- **截图频率可调**：设置中自定义间隔
- **首次运行引导**：自动打开使用说明
- **大量 Bug 修复和代码清理**

</details>

<details>
<summary>日本語</summary>

- **マルチバックエンド TTS**：Mimo / 阿里雲 / ローカル VITS2 対応
- **記憶システム強化**：自動要約、トピック追跡、好み学習、アクティブリコール
- **音声認識最適化**：Web Speech API 優先、PCM 直接録音
- **スクリーンショット間隔設定可能**
- **初回起動ガイド**：自動的に使用方法を表示
- **多数のバグ修正とコード整理**

</details>
## v2.0.0 — Interaction & Visual Memory

- Interaction system: click/touch/drag/swipe/resize detection on pet, events injected into AI context
- Keyframe visual memory: auto-sample screenshots, VLM picks representative keyframes for AI mid-term memory
- HQ window-targeted screenshots: new `getScreenCaptureHQ` captures the active window at higher quality
- Style buffer replaces conversation history: no text history sent to API, only style buffer for anti-repetition
- Enhanced anti-repetition: detects similar response length, exclamation overuse, ellipsis overuse
- Recent discussion pool: timestamped response pool with LLM-based topic/habit extraction for semantic anti-repetition
- Fix: prune expired pool entries before structural pattern detection
- Cleanup: removed 12 dead i18n keys (sys.historyScreenshot, sys.searchQueryPrompt, etc.) from suspended text pipeline
- Enhancement system simplified: text pipeline (search, knowledge, memory, VLM situation) suspended, keyframe-only mode
- Detection interval reduced (30s → 10s), idle threshold raised (10s → 60s), desktop layout default off
- Settings UI streamlined, AI-ARCHITECTURE.md removed

<details>
<summary>中文</summary>

- 互动系统：宠物窗口支持点击/触摸/拖拽/划过/缩放检测，互动事件注入 AI 上下文
- 关键帧视觉记忆：自动采样截图，VLM 挑选代表性关键帧作为 AI 中期记忆
- HQ 窗口定向截图：新增 `getScreenCaptureHQ` 针对活动窗口高清截图
- Style Buffer 替代对话历史：不再向 API 发送文本历史，仅保留风格缓冲用于反重复
- 反重复增强：新增长度相似、感叹号过多、省略号过多检测
- 近期讨论池：带时间戳的响应池 + LLM 话题/语癖提取，实现语义级反重复
- 修复：结构模式检测前剪枝过期条目
- 清理：移除已弃置文本管线遗留的 12 个死 i18n 键
- 增强系统精简：文本管线（搜索/知识/记忆/VLM情景）暂停使用，仅保留关键帧模式
- 检测间隔缩短（30s→10s），空闲阈值提高（10s→60s），桌面布局默认关闭
- 设置界面精简，删除 AI-ARCHITECTURE.md

</details>

<details>
<summary>日本語</summary>

- インタラクションシステム：ペットウィンドウでクリック/タッチ/ドラッグ/スワイプ/リサイズ検出、イベントをAIコンテキストに注入
- キーフレーム視覚メモリ：スクリーンショットを自動サンプリング、VLMが代表的なキーフレームをAI中期メモリとして選択
- HQウィンドウターゲットスクリーンショット：新しい `getScreenCaptureHQ` でアクティブウィンドウを高品質キャプチャ
- スタイルバッファが会話履歴を置換：テキスト履歴をAPIに送信せず、反復防止用のスタイルバッファのみ
- 反復防止の強化：類似応答長、感嘆符多用、省略記号多用を検出
- 最近の議論プール：タイムスタンプ付き応答プール + LLMによる話題/口癖抽出で意味的反復防止
- 修正：構造パターン検出前に期限切れエントリを剪定
- クリーンアップ：停止中のテキストパイプラインから残存していた12個の未使用i18nキーを削除
- 拡張システム簡素化：テキストパイプライン（検索/知識/記憶/VLM状況）一時停止、キーフレームのみモード
- 検出間隔短縮（30s→10s）、アイドル閾値引き上げ（10s→60s）、デスクトップレイアウトデフォルトオフ
- 設定UIの簡素化、AI-ARCHITECTURE.md削除

</details>

## v1.10.0 — Visual Analysis & Smart Search

- VLM visual analysis refactor: independent capture system, multi-resolution buffering, situation history tracking
- Smart search optimization: auto query extraction, per-title cooldown & failure backoff, IDE window filtering
- Context quality improvements: expanded enhancement budgets, activity summary noise filtering, higher RAG confidence
- Debugging improvements: renderer log forwarding to main process, new debug launcher script
- Major test coverage expansion (IDE detection, search cooldown, situation history, and more)

<details>
<summary>中文</summary>

- VLM 视觉分析重构：独立截图系统、多分辨率缓冲、情景历史追踪
- 智能搜索优化：自动查询提取、逐标题冷却与失败退避、IDE 窗口自动过滤
- 上下文质量提升：增强预算扩大、活动摘要噪声过滤、RAG 置信度提高
- 调试改善：渲染进程日志转发至主进程、新增调试启动脚本
- 测试覆盖大幅扩展（新增 IDE 检测、搜索冷却、情景历史等测试套件）

</details>

<details>
<summary>日本語</summary>

- VLM 視覚分析リファクタリング：独立キャプチャシステム、マルチ解像度バッファ、状況履歴追跡
- スマート検索の最適化：自動クエリ抽出、タイトル別クールダウンと失敗バックオフ、IDE ウィンドウフィルタリング
- コンテキスト品質の向上：拡張バジェット拡大、アクティビティ要約のノイズフィルタリング、RAG 信頼度向上
- デバッグ改善：レンダラーログのメインプロセス転送、デバッグランチャースクリプト追加
- テストカバレッジの大幅拡張（IDE 検出、検索クールダウン、状況履歴などのテストスイート追加）

</details>

## v1.9.0 — Main Process Modular Refactor

- Split main.js (1665 lines) into 15 independent modules (`src/main/`) with clear responsibilities
- New AppContext shared state management with dependency injection pattern
- AES-256-GCM API key encryption at rest, backward compatible with plaintext
- Input validation module: UUID / URL / path traversal protection
- Unit tests: config-manager / crypto-utils / validators (42 tests)
- Settings page TTS save optimization: only sends tts config section, avoids model hot-reload
- Architecture diagram updated to reflect modular structure

<details>
<summary>中文</summary>

- 将 main.js（1665 行）拆分为 15 个独立模块（`src/main/`），职责清晰
- 新增 AppContext 共享状态管理，依赖注入模式
- 新增 AES-256-GCM API 密钥加密存储，向后兼容明文
- 新增输入验证模块：UUID / URL / 路径遍历防护
- 新增单元测试：config-manager / crypto-utils / validators（42 个测试）
- 设置页 TTS 保存优化：仅发送 tts 配置段，避免触发模型热重载
- 架构图更新，反映模块化结构

</details>

<details>
<summary>日本語</summary>

- main.js（1665行）を 15 個の独立モジュール（`src/main/`）に分割、責務を明確化
- 新しい AppContext 共有状態管理、依存性注入パターン
- AES-256-GCM による API キーの暗号化保存、平文との後方互換性あり
- 入力バリデーションモジュール：UUID / URL / パストラバーサル防御
- ユニットテスト追加：config-manager / crypto-utils / validators（42 テスト）
- 設定画面の TTS 保存を最適化：tts セクションのみ送信し、モデルのホットリロードを回避
- アーキテクチャ図をモジュール構造に更新

</details>

## v1.8.0 — Enhancement System

- New "Enhance" settings tab with modular context enhancement: activity memory, context search, knowledge organization, screen analysis, knowledge acquisition
- Context Pool architecture: layered storage (short-term / long-term) with Jaccard-similarity RAG retrieval
- Main process Web Search IPC: DuckDuckGo HTML scraping and custom API support (Bing / SearXNG, etc.)
- Adjustable response length multiplier (×0.5 / ×1 / ×1.5 / ×2)
- Auto-sanitization of context data to prevent API key leakage
- Emotion classifier prompt fully internationalized
- Screenshot resolution optimized (640→512) to reduce API costs

<details>
<summary>中文</summary>

- 新增「增强」设置标签页，模块化上下文增强：活动记忆、上下文搜索、知识整理、屏幕分析、知识获取
- 上下文池架构：分层存储（短期/长期），Jaccard 相似度 RAG 检索
- 主进程 Web 搜索 IPC：DuckDuckGo HTML 抓取和自定义 API
- 可调节回复长度倍率（×0.5 / ×1 / ×1.5 / ×2）
- 上下文数据自动脱敏，防止敏感信息泄露
- 情绪分类提示词完全国际化
- 截图分辨率优化（640→512），降低 API 开销

</details>

<details>
<summary>日本語</summary>

- 新しい「拡張」設定タブ、モジュール式コンテキスト強化：アクティビティ記憶、コンテキスト検索、知識整理、画面分析、知識獲得
- コンテキストプールアーキテクチャ：階層型ストレージ（短期/長期）、Jaccard 類似度ベースの軽量 RAG 検索
- メインプロセス Web 検索 IPC：DuckDuckGo HTML スクレイピングとカスタム API 対応
- 応答長さ倍率の調整（×0.5 / ×1 / ×1.5 / ×2）
- コンテキストデータの自動サニタイズで機密情報漏洩を防止
- 感情分類プロンプトの完全国際化
- スクリーンショット解像度の最適化（640→512）で API コストを削減

</details>

## v1.7.1 — Self-Awareness & Idle Detection

- Pet can locate itself in screenshots via screen position info
- Window title shortening for cleaner context
- System idle time detection (keyboard/mouse inactivity)
- Minimized window filtering

## v1.7.0 — Window Awareness & GPU TTS

- Window detection reads window titles (e.g. browser tab titles), tracked independently per title
- AI requests include desktop window layout info and window dimensions
- One-click setup downloads DirectML (GPU) ONNX Runtime for GPU-accelerated TTS

## v1.6.1 — Hot-Reload & Auto-Restart

- Model config changes hot-reload the pet window without restart
- VVM download auto-adds to config and restarts TTS
- Fixed TTS restart failure caused by duplicate koffi type registration
- Fixed app relaunch for portable exe builds

## v1.6.0 — System Tray Support

- System tray icon, app minimizes to tray area
- Settings window auto-hides to tray when pet starts
- Closing settings window hides to tray instead of quitting

## v1.5.0 — Multi-Language UI

- i18n support for settings UI (English / 中文 / 日本語)
- Character card import, built-in card auto-sync on version update
- Built-in card label in character list

## v1.4.0 — Translation & Chat

- Separate translation API config from main API
- Message double-buffer mechanism with configurable chat gap

## v1.3.0 — Documentation & UX

- Streamlined API configuration guide with model recommendations
- Detailed VOICEVOX voice setup workflow documentation
- Troubleshooting guide and known issues

## v1.2.0 — Image Model

- Image folder model: select an image folder, tag each image as idle/talking/emotion
- Supports PNG / JPG / WebP

## v1.1.0 — Fast Response

- Fast response mode, conversation history buffer, screenshot dedup, language-agnostic translation & emotion

## v1.0.0 — Initial Release

- Live2D desktop pet, AI visual awareness, VOICEVOX TTS, emotion/expression system
