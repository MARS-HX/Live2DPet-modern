# 🐱 Live2DPet — AI 桌面宠物伴侣

**[English](README.en.md)** | **[日本語](README.ja.md)** | **中文**

![License](https://img.shields.io/github/license/MARS-HX/Live2DPet-modern)
![Version](https://img.shields.io/badge/version-1.5.0-blue)
![Electron](https://img.shields.io/badge/Electron-42.4.0-blue)
![Live2D](https://img.shields.io/badge/Live2D-Cubism%204-ff69b4)

> 基于 Electron + Live2D 的 AI 桌面宠物伴侣。能看、能听、能说、能记住你的每一次互动。

---

## ✨ 功能特性

### 🎭 Live2D 桌面宠物
- 支持 Live2D Cubism 3/4 模型，常驻桌面
- 鼠标拖拽、点击、划过等互动
- 27+ 种表情动作：光环、兔耳朵、星星眼、脸红、生气、睡觉…
- 自动追踪鼠标视线

### 💬 双模式 AI 聊天
| 模式 | 说明 |
|------|------|
| 🐱 **陪伴模式** | 原有的 AI 宠物聊天，长期记忆，主动搭话 |
| 🏰 **酒馆模式** | 你是冒险者，AI 是酒馆老板，支持自定义世界观 |

- 接入任意 OpenAI 兼容 API（Ollama / OpenRouter / DeepSeek 等）
- 自动感知当前窗口场景
- **独立聊天窗口**，可自由拖动到屏幕任意位置

### 🎤 语音交互
- **本地语音识别**：Web Speech API（无需网络）
- 云端备选：Mimo ASR API
- 按住说话，松开发送
- 实时音量电平指示

### 🔊 多后端 TTS 语音合成

| 后端 | 类型 | 配置 |
|------|------|------|
| **小米蜜模 Mimo** | ☁️ 云端 | API 地址 + Key + 风格描述 |
| **阿里云 TTS** | ☁️ 云端 | AccessKey ID/Secret + AppKey + 音色 |
| **本地 VITS2** | 🖥️ 本地 | 服务地址 + 接口路径 + 说话人 ID |

### 🧠 增强记忆系统
- 对话历史持久化（最多 300 条）
- **自动阶段总结**（每 10 条对话）
- **兴趣话题追踪**与提取
- **用户偏好学习**（喜欢/不喜欢/习惯）
- **视觉记忆**：截屏识别画面内容
- **主动回忆机制**：冷不丁提起以前聊过的话题
- **酒馆模式独立记忆**：与陪伴模式互不干扰
- **自动冒险日记**：酒馆模式切换时生成日记弹窗

### 🎨 酒馆预设系统
- 内置预设：奇幻酒馆、赛博酒吧、仙侠客栈
- 支持用户自定义预设（JSON 格式）
- 预设编辑/导入/导出/删除
- 预设保存在浏览器 localStorage

### 🖥️ 界面特性
- **毛玻璃 UI**：backdrop-filter 模糊效果，圆角卡片
- **暗色模式**：支持亮/暗切换，跟随系统偏好
- **三语言界面**：中文 / English / 日本語（完整 i18n）
- **可拖动聊天窗口**：独立 BrowserWindow，不受桌宠窗口限制

### 🛠 用桌宠驱动 DeepSeek Harness (DSH)
- **聊天窗口点 🛠 进入 DSH 模式**：发出去的话直接变成 `dsh` 任务，读写文件、跑命令、查资料都行
- **实时过程输出**：stdout/stderr 流式显示在聊天气泡里，跑完给出最终结论并可用 TTS 念出来
- **随时可停**：一键取消，连子进程一起杀掉
- **自动定位 dsh**：自动找到 npm 全局的启动脚本，找不到则回退 PATH
- 每次任务是独立的 headless 一次性会话（工作目录、超时、Profile 均可在设置里改）

### 👁 识屏流水线

- **不再定时截全屏**：每一帧先打一个「画面变化了多少」的分（64×36 网格 HSV 加权差，约 0.2ms）
- **只留值得看的帧**：画面突然换了一张（切点）或一直在动、攒够了量（积分）才留
- **多帧拼一张图**：4~8 帧拼进同一张，固定成本摊开 —— 静止屏幕几乎不花 token
- **四档节奏**：calm / normal / dense / action（全屏游戏每帧都在动，需要单独一档）
- **一眼可以验**：设置 → 屏幕感知 → 「测试采集」会真抓一帧并报出实测数字

### 🎮 游戏陪伴
- **看画面说话**：触发时抓一张**屏幕截图**喂给模型，评论贴着画面里真实发生的事（默认开启）
- **免提语音输入**：陪伴期间**默认打开语音输入**，打游戏腾不出手就直接说话，宠物带截图回答
- **一眼搭话**：检测到你在玩游戏时，时不时说 1-2 句短评，像旁边坐着朋友
- **不刷屏**：同一局游戏按间隔开口（默认 120 秒）
- **广泛识别**：内置 Steam/原神/崩坏/LOL/Minecraft 等大量中英日关键词，支持自定义补充
- **隐私可控**：截图与语音输入都可单独关闭
- **可调成日常陪伴**：关掉"仅游戏窗口"后，工作、看片时也会偶尔搭话

### 📺 哔哩哔哩直播间弹幕
- **接入直播间**：填房间号或直播间链接即可，**无需登录 / Cookie / API Key**（走 B 站自己的弹幕 WebSocket）
- **读弹幕并回应**：解析实时弹幕，用宠物的气泡 + TTS 回应，像直播间常驻观众
- **克制而不刷屏**：默认只回应提问与被点名的弹幕，全局间隔 15 秒、同一观众冷却 60 秒
- **智能过滤**：自动忽略 `666`/`哈哈`/`233`/`打卡`/纯标点/`@别人`/命令等低信息量弹幕，并对重复内容去重
- **醒目留言优先**：Super Chat 即使在其他模式下也一定回应
- **自动重连**：断线指数退避重连，重启后自动连回上次的房间

### 🎥 OBS 采集（直播用）
- **浏览器源（推荐）**：桌宠启动后 OBS 用「浏览器」源加载 `http://127.0.0.1:<端口>/obs`
  —— 由 OBS 自己渲染，**背景真透明、不需要绿幕、不涉及窗口采集、桌面不多出任何东西**
- 与桌宠本体状态实时同步：表情、动作、说话状态都会镜像过去
- 只监听 `127.0.0.1`，白名单目录，**API Key / Cookie 永不下发**
- 备选：「OBS 兼容模式」可让窗口采集读到画面（关掉 Chromium GPU 合成，性能略降）
- ⚠️ 「窗口采集 / 游戏采集」抓透明 Electron 窗口必然是黑的：分层窗口 + Chromium 绕过 GDI

### ⚙️ 丰富的自定义
- 角色卡片系统（多角色切换）
- 自定义宠物名字、性格、说话风格
- 表情/动作自由开关
- 检测频率、截图频率可调
- TTS 诊断工具
- DSH 工作目录 / 超时 / Profile、游戏陪伴间隔与关键词均可配置

---

## 🚀 快速开始

### 下载即用
从 [Releases](https://github.com/MARS-HX/Live2DPet-modern/releases) 下载最新版，解压即可运行。

### 首次配置
1. 双击 `Live2DPet.exe` 启动
2. 右下角托盘图标右键 → **设置**
3. 配置 **API 地址 + Key**（支持 Ollama / OpenRouter 等）
4. 导入你的 Live2D 模型
5. 点击 **开始**

> 首次启动会自动打开使用说明文档

### 从源码运行
```bash
git clone https://github.com/MARS-HX/Live2DPet-modern.git
cd Live2DPet-modern
npm install
npm start
```

### 打包发布
```bash
npm run build          # 打包为便携版 EXE
npm run build:dir      # 打包为目录（速度更快）
```

---

## 📖 使用指南

### 宠物操作
| 操作 | 效果 |
|------|------|
| 拖拽宠物 | 移动位置 |
| 点击宠物 | 互动对话 |
| 「💬」按钮 | 打开独立聊天窗口 |
| 「⚙」按钮 | 打开设置 |
| 右键宠物 | 快捷菜单 |

### 文字聊天
1. 点击「💬」打开独立聊天窗口
2. 输入文字按 Enter 发送
3. 点击顶部「切换」在陪伴/酒馆模式间切换

### 语音聊天
1. 点击聊天窗口的「🎤」按钮
2. **按住说话**，松开发送
3. 自动识别为文字并发送

### 酒馆模式
1. 打开聊天窗口 → 点击「切换」→ **酒馆模式**
2. 点击预设下拉菜单选择世界观
3. 和酒馆老板对话，展开冒险！
4. 切回陪伴模式 → 📜 自动生成冒险日记弹窗

### TTS 配置
设置 → TTS → 选择服务商并填写对应配置。

### 用桌宠驱动 DSH
1. 先装好 DSH：`npm i -g @deepseek-ai/dsh`
2. 打开聊天窗口 → 点右上角 **🛠** → 进入 DSH 模式
3. 输入任务（例如「帮我修一下 build 报错」），执行过程实时显示，完成后给结论并朗读
4. 跑太久点 **■** 取消
5. 工作目录 / 超时 / Profile 在 **设置 → 集成 → DeepSeek Harness** 里改

### 游戏陪伴
设置 → **集成** → **Game Companion** → 打开「启用游戏陪伴」。
小众游戏识别不到时，在「自定义游戏关键词」里填窗口标题包含的词即可（如 `雀魂`）。

### 直播间弹幕
设置 → **集成** → **Bilibili Live Danmaku** → 打开开关并填写房间号（如 `5440`）→ 点「连接」。
默认只回应**提问**和**被点名的弹幕**；想让它多说点，把「什么时候回应」改成「任何能读的弹幕」。

详细说明见 [使用说明.md](使用说明.md)。

---

## ⚙️ 配置文件

> **首次运行前**：把 `config.example.json` 复制成 `config.json` 再填写密钥。
> `config.json` 内含 API Key，已加入 `.gitignore`，**请勿提交到仓库**。

```json
{
  "apiKey": "your-api-key",
  "baseURL": "http://localhost:11434/v1",
  "interval": 60,
  "screenshotInterval": 0,
  "appMode": "companion",
  "tts": {
    "serviceType": "mimo",
    "mimo": { "apiKey": "..." },
    "aliyun": { "accessKeyId": "...", "accessKeySecret": "..." },
    "local": { "baseURL": "http://localhost:7860" }
  }
}
```

### 数据文件
| 文件 | 说明 |
|------|------|
| `config.json` | 配置文件 |
| `enhance-data.json` | 记忆数据 |
| `presets/*.json` | 酒馆预设文件 |
| `使用说明.md` | 使用文档 |

---

## 🧩 项目结构

```
Live2DPet-modern/
├── main.js                    # Electron 主进程
├── preload.js                 # IPC 桥接
├── index.html                 # 设置页面（毛玻璃 UI + 暗色模式）
├── desktop-pet.html           # 宠物窗口
├── pet-chat-window.html       # 独立聊天窗口
├── src/
│   ├── core/                  # 核心逻辑
│   │   ├── ai-chat.js         # AI 聊天客户端
│   │   ├── vision/            # 识屏流水线（移植自 dsh-see-now，Apache-2.0）
│   │   │   ├── cuts.js        #   64×36 网格 HSV 变化分
│   │   │   ├── tiers.js       #   出帧密度 → 格子档位
│   │   │   ├── pack.js        #   DP 装箱
│   │   │   ├── sheet.js       #   拼图 + 点阵编号
│   │   │   ├── png.js         #   纯 JS PNG 编码
│   │   │   ├── pipeline.js    #   帧 → 筛选 → 出图
│   │   │   └── capture.js     #   ffmpeg 采集
│   │   ├── screen-observer.js # 识屏会话管理（start/watch/peek/节奏）
│   │   ├── conversation-store.js  # 对话记忆（双模式独立）│   │   ├── desktop-pet-system.js  # 桌面宠物主控
│   │   ├── game-companion.js      # 游戏陪伴（游戏识别 / 开口节奏 / 提示词）
│   │   ├── live-companion.js      # 直播间弹幕回应策略（过滤 / 限流 / 提示词）
│   │   ├── tts-service.js         # TTS 语音合成（多后端）
│   │   └── enhance/               # 增强功能
│   ├── main/                  # 主进程 IPC
│   │   ├── dsh-bridge.js      # DeepSeek Harness 桥接（headless 一次性任务）
│   │   ├── dsh-ipc.js         # DSH 的 IPC 通道
│   │   ├── bilibili-danmaku.js    # B 站弹幕客户端（WBI 签名 + WebSocket 协议）
│   │   └── bilibili-ipc.js        # 弹幕的 IPC 通道
│   └── renderer/              # 渲染进程
├── assets/                    # 资源文件
├── libs/                      # Live2D 引擎库
├── presets/                   # 酒馆预设
└── tests/                     # 单元测试（node --test）
```

---

## 📋 更新日志

### v1.7.2 — 回复频率适配识屏流水线

识屏流水线上线后，旧的两个"按秒数"的控制已经不适用了，这一版把它们拆清楚。

**问题**：`检测间隔`（10s）和 `截图间隔`（60s）都是给"定时截全屏"设计的。
新的流水线按**画面变化量**决定留不留帧（`vision.pace`：calm 30s / normal 15s /
dense 8s / action 20s），两个秒数节流和它打架 —— 该说的话会因为"没到截图时间"被跳过，
不该说的话又会对着没变的画面反复说。

**改动**：

| 项 | 之前 | 现在 |
|---|---|---|
| 设置项名称 | Detection Settings / 检测设置 | **Reply Frequency / 回复频率** |
| `interval` 语义 | 多久截一张图并检测 | **多久允许看一次**（不是强制定时器） |
| `screenshotInterval` | 截图节流 | **已移除**（画面节奏交给 `vision.pace`） |
| 没有新画面时 | 退回截一张旧图照样发 | **不发请求，安静** |

**核心行为**：`tick()` 先 `peek()` 队列里有没有**新的一张图**：

- 有 → 问模型（带图）
- 没有 → 跳过，不花 token

两个例外仍会等图：**首次启动**（让宠物能开口打招呼）、**游戏陪伴到点时**。
静止屏幕也不会永远沉默 —— 流水线自己有兜底帧，20 秒左右会产出"确实没变"的一张。

**设置界面**会实时算出"回复间隔 vs 唤识间隔"的关系并给出提示：
间隔小于唤醒间隔时会警告"多数检查会空转"。

**测试**：新增 `tests/test-tick-gating.js`（7 个），钉住上面四条决策路径。
全量 **508 通过 / 0 失败**。

### v1.7.1 — 移除旧的增强层（enhance/*）

see-now 识屏流水线上线后，旧的「增强层」已经没有任何 UI 入口，成为纯死代码。
这一版把它整体删掉，不再两套"看屏幕"的实现并存。

**删除的内容**（8 个模块 + 1 个测试文件，约 60KB / 2300 行）：

| 文件 | 原来做什么 |
|---|---|
| `enhance/enhancement-orchestrator.js` | 增强层总控（v2.0 起文本流水线已停用） |
| `enhance/vlm-extractor.js` | 分层 mipmap 截图 + 视觉 LLM 情境提取 |
| `enhance/memory-tracker.js` | 窗口焦点计时 → 长期记忆 |
| `enhance/knowledge-acquisition.js` | 自动搜索并积累主题知识 |
| `enhance/knowledge-store.js` | LLM 整理知识 |
| `enhance/search-service.js` | 网络搜索（DuckDuckGo / 自定义 API） |
| `enhance/context-pool.js` | 短期/长期记忆池 + 轻量 RAG |
| `enhance/enhance-utils.js` | 共享工具函数 |
| `tests/test-enhance.js` | 对应测试 |

**保留的内容**（这些和"看屏幕"无关，仍在用）：

- `enhance-data.json` 的读写通道 —— `conversation-store.js` 用它保存对话历史、
  阶段总结、话题与偏好。**磁盘格式与 IPC 通道名都没改**，用户的长期记忆不会丢。
- `enhance.tokens.*` 的 i18n 键 —— 「响应长度」卡片仍在用。
- `config.json` 里 `enhance.search.customApiKey` 的解密逻辑 —— 老配置里可能还存着
  这一项的密文，留着才能正确读出来而不是把 Base64 当明文显示。
- `web-search` IPC 通道已移除（搜索服务是它唯一的调用方）。

**验证**：全量测试 501 通过 / 0 失败；主进程 100 个 IPC 通道装配正常；
设置页零控制台错误；真实应用启动日志中不再出现任何 `[Enhance:*]` 输出。

### v1.7.0 — 识屏重写：按画面变化量筛帧，多帧拼一张图

把原本「定时截一张全屏喂模型」的截图逻辑，换成
[dsh-see-now](https://github.com/SAOS-3624/dsh-see-now)（Apache-2.0）的流水线。

**为什么换**：旧做法的两个死结 —— 截得勤就是 30 张重复图烧穿 token，
截得慢就丢掉中间发生的一切，模型只会说"看起来你在用电脑"。

**新做法**：

| 阶段 | 做什么 |
|---|---|
| 采集 | 一根 ffmpeg rawvideo 管道，12fps → 800×450（Windows 走 ddagrab，挡不住就自动退 gdigrab） |
| 打分 | 每帧算一个 0–255 变化分（64×36 网格、HSV 三通道加权差，约 0.2ms/帧） |
| 筛选 | **切点**（跳得又高又孤立）或**积分**（一直在动、攒够 144 分）才留；静止画面另有 20 秒兜底 |
| 档位 | 按当前出帧密度决定格子大小（1..8 档，边长 1/k） |
| 装箱 | DP 求占用率最高的排布，多帧拼进**同一张** PNG |
| 交付 | 一张图 + 每帧时刻，作为一个 `image_url` 块交给模型 |

**实测（Windows / gdigrab / 12fps）**：首帧 408ms，解码 11.5fps，静止屏幕 8 秒只出 1 张；
6 段纯色每段 2 秒的硬切素材，**5/5 个切点全部命中**（变化分峰值 70.67）。

**新增**：设置 → 屏幕感知（清晰度 / 四档节奏 / 逐场景 / 一键测试采集）、
`vision.*` 配置块、`npm run verify:vision` 真机冒烟、`tests/test-vision.js`（70 个测试）。

**移植改动**：ESM → CommonJS；DSH 的悬浮窗与聊天插话层剥掉；
`watch` 由阻塞式工具调用改成 Promise；新增 ffmpeg 路径解析（打包后 GUI 进程拿不到 PATH）。
算法参数**一个没改**（`cutAbs=12`、`REF_SCORE=4`、`binCost=1000` 等均为上游实测标定值）。


### v1.6.7 — 清理无主的 STT 残留
- **修复 `No handler registered for 'stt:initialize'`**：早先移除云端 STT 时留下了悬空引用
  —— `preload.js` 的 7 个 STT 桥接方法、`settings-ui.js` 227 行云端 STT 逻辑、
  `index.html` 整张「语音对话（云端 STT）」卡片，已全部移除
- **新增 `tests/test-ipc-channels.js` 永久防线**：对账 preload 的
  `invoke()/send()` 与主进程的 `handle()/on()`，并检测重复注册
  —— 加上去当场又抓出一个同类残留（`TRANSCRIBE_AUDIO`）

### v1.6.6 — 修复浏览器源设置面板报错
- **修复 `obs-server-get` 的 `An object could not be cloned`**：
  返回值里塞进了 `url` **方法**而不是调用结果，Electron 无法结构化克隆 → 面板全部失效
- **修复重复启动泄漏端口**：`running` 以前只要 `http.Server` 对象存在就为 true
  （此时还没绑定端口），导致重复调用 `start()` 会开第二个端口；现在只在 `listen()`
  成功后为 true，并合并进行中的启动
- 新增 `tests/test-obs-browser-source.js`，直接断言 `structuredClone(status)` 不抛错
  —— 用的就是 Electron 会做的那个操作,这类 bug 以后不会再溜过去

### v1.6.5 — 浏览器源可调「桌宠在画面里的位置与大小」
- **新增三个控制**：缩放（%）、水平偏移、垂直偏移 → 设置 → 集成
- **改动实时推送到 OBS**：不用重新添加源、不用重新粘贴地址（走 WebSocket 推送）
- 也支持用 URL 参数临时调：`/obs?scale=0.6&x=0&y=-100`（URL 优先于设置）
- 位置/大小以 CSS transform 作用在桌宠容器上，不侵入 Live2D 渲染逻辑
- 数值做了归一化与钳制（缩放 10%~500%、偏移 ±4000px），坏值不会让桌宠消失
- 实测：50% + 上移 120px → 绘制像素 65,978 → 16,856（≈0.5²）、y 范围 128..599 → 93..329

### v1.6.4 — 新增 **OBS 浏览器源**（终于能稳定显示了）
- **推荐改用「浏览器源」**：OBS 用「浏览器」源加载 `http://127.0.0.1:<端口>/obs`，
  由 OBS 自己渲染桌宠页面 —— **背景真透明、不需要绿幕、不涉及窗口采集、桌面不多出任何东西**
- **复用桌宠本体页面**（`desktop-pet.html`）：服务器把 IPC 垫片注入进去，
  OBS 里的桌宠与桌面桌宠同源、不会走样；表情 / 动作 / 说话状态通过 WebSocket 镜像
- 安全：只监听 `127.0.0.1`、白名单目录 + 路径穿越防护、**API Key / Cookie 永不下发**
- 设置 → 集成 显示运行状态、地址、已连接源数量，支持一键复制地址与启停
- 「OBS 兼容模式」保留为备选（窗口采集用）
- 修复实测中发现的两个 bug：模型目录读错配置文件（dev 下读到 userData 的旧配置导致模型 404）；
  垫片返回的模型基址必须是绝对 http URL，否则 `model-adapter.js` 会把它改写成 `file:///` 导致表情全部加载失败

### v1.6.3 — 定位 OBS 全黑的根因
- 查明 Chromium 的渲染绕过 Windows GDI，OBS 读窗口只能得到纯黑
- 新增「OBS 兼容模式」（`--disable-gpu-compositing`）+ 一键重启
- 实测表明**仅此一项仍抓不到透明窗口**，故 v1.6.4 改为浏览器源为推荐方案

### v1.6.2 — 移除多余的 OBS 采集窗口
- 删除「另开一个不透明抠像窗口」的错误方案（复制渲染 + 遮挡屏幕）

### v1.6.1 — 修复 OBS 采集窗口不可见
- 仅作历史记录；该方案已在 v1.6.2 整体移除

### v1.6.0 — DSH 接入 + 游戏陪伴 + 直播弹幕 + OBS 采集

#### 🛠 用桌宠驱动 DeepSeek Harness (DSH)
- 通过桌宠本体直接执行 DSH 任务，结果实时回传到宠物气泡
- 一次性的 headless 会话：不开端口、不做 shell 字符串拼接，支持取消与超时

#### 🎮 游戏陪伴与日常陪伴
- 自动识别正在玩的游戏（Steam / 原神 / 崩坏 / LOL / Minecraft 等）并按节奏开口
- **截屏理解你在干什么**，话题跟你当下的操作相关
- 分时段问候，融入日常生活
- **默认开启免手语音输入**：陪伴时直接说话，不用碰键盘

#### 📺 哔哩哔哩直播间弹幕
- 读取直播间弹幕，并**用软件内置 TTS 念出来**回应
- 回应策略：全部 / 只答提问 / 只答被点名 / 关闭；另有回应间隔与单观众冷却
- 智能过滤：`666` / `哈哈` / `233` / 纯标点 / 命令等低信息量弹幕；按**不同观众数**判定刷屏，少数人重复仍会回应
- **可选登录（SESSDATA，加密存本机）**：部分房间匿名收不到弹幕，登录后才能收到
- 房间未开播时静默等待、开播即连；断线指数退避重连，不会疯狂握手

#### 🎥 OBS 采集（直播用）
- 解决「OBS 窗口采集桌宠一片全黑」——透明窗口在 OBS 里必然是黑的
- 另开一个**不透明抠像窗口**（默认纯绿），OBS 加「色度键」即可抠出透明桌宠

#### 🔊 TTS 与语音
- 默认模型修正为 `mimo-v2.5-tts`（旧默认值会返回空音频，导致频繁熔断）
- 熔断修复：指数退避、未配置时不再空跑、状态与诊断显示真实后端
- 前端可直接**修改并测试** TTS 配置

#### 🐛 其它修复
- 修复截屏链路返回值契约不一致，导致视觉记忆长期失效
- 修复弹幕在宠物忙碌时被静默丢弃（改为有界队列，不再漏回应）
- 修复集成设置改动必须重启才生效
- 修复保存设置会清空动作/表情列表
- 修复表情列表陈旧导致部分表情无法触发

#### 🔒 安全
- `config.json` / `enhance-data.json` **不再纳入版本控制**（内含 API Key），已加入 `.gitignore`
- 新增 `config.example.json` 作为配置模板

### v1.5.0 — 双模式 + 独立聊天窗口 + 酒馆预设系统
- **双模式聊天**：陪伴模式 + 酒馆模式，各自独立记忆
- **独立聊天窗口**：可拖动到屏幕任意位置
- **酒馆预设系统**：内置奇幻/赛博/仙侠预设，支持自定义编辑导入导出
- **自动冒险日记**：酒馆切换时 AI 生成日记弹窗
- **毛玻璃 UI** + 暗色模式
- **完整 i18n**：中/英/日三语言
- **多后端 TTS**：Mimo / 阿里云 / 本地 VITS2
- **增强记忆系统**：自动总结、话题追踪、偏好学习、视觉记忆

### v1.0.0 — Interaction & Visual Memory
- 互动系统、关键帧视觉记忆、反重复机制

---

## 🙏 致谢

- 原始项目：[x380kkm/Live2DPet](https://github.com/x380kkm/Live2DPet) —— 本项目的基础
- **[SAOS-3624/dsh-see-now](https://github.com/SAOS-3624/dsh-see-now)** —— 识屏流水线的来源。
  `src/core/vision/` 是它的移植（Apache-2.0）：按变化量给帧打分、切点与积分两条判据、
  档位系统、DP 装箱、纯 JS PNG 编码，全部出自该项目。详见
  [`src/core/vision/README.md`](src/core/vision/README.md) 与 `THIRD-PARTY-NOTICES`。
- **[xfgryujk/blivedm](https://github.com/xfgryujk/blivedm)** —— 直播间弹幕客户端的设计参照。本项目的 WebSocket 实现借鉴了它的握手方式：WBI 签名与失效重签、auth 包内携带 `buvid`、弹幕主机列表轮换与定时重新初始化、接口失败时降级到默认服务器、以及可选的 SESSDATA 登录。感谢作者把协议细节整理得这么清楚。
- [xfgryujk/blivechat](https://github.com/xfgryujk/blivechat) —— 同作者的直播弹幕应用，弹幕展示思路的参考
- [B站直播开放平台协议文档](https://open-live.bilibili.com/document/657d8e34-f926-a133-16c0-300c1afc6e6b) —— 弹幕协议说明
- [DeepSeek Harness](https://github.com/deepseek-ai) —— 桌宠接入的 Agent 运行环境
- [Live2D Cubism](https://www.live2d.com/)
- [Electron](https://www.electronjs.org/)
- [PixiJS](https://pixijs.com/)
- [Mimo API](https://xiaomimimo.com/) / [阿里云百炼](https://bailian.console.aliyun.com/) —— TTS 与多模态能力
- [OpenRouter](https://openrouter.ai/)

---

## 📄 许可

[MIT License](LICENSE)

---

*Made with ❤️ by MARS-HX & x380kkm*
