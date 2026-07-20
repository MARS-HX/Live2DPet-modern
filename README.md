# 🐱 Live2DPet — AI 桌面宠物伴侣

**[English](README.en.md)** | **[日本語](README.ja.md)** | **中文**

![License](https://img.shields.io/github/license/MARS-HX/Live2DPet-modern)
![Electron](https://img.shields.io/badge/Electron-42.4.0-blue)
![Live2D](https://img.shields.io/badge/Live2D-Cubism%204-ff69b4)

> 基于 Electron + Live2D 的 AI 桌面宠物伴侣。常驻桌面，能看、能听、能说、能记住你。

<div align="center">
  <img src="assets/example-little-demon.png" width="60%" alt="示例">
</div>

---

## ✨ 功能特性

### 🎭 Live2D 桌面宠物
- 支持 Live2D Cubism 3/4 模型，常驻桌面
- 鼠标拖拽、点击、划过等互动
- **27+ 种表情动作**：光环、兔耳朵、星星眼、脸红、生气、睡觉…
- 自动追踪鼠标视线

### 💬 AI 智能聊天
- 接入任意 OpenAI 兼容 API（Ollama / OpenRouter / DeepSeek 等）
- 自动感知当前窗口场景，主动搭话
- **增强版长期记忆系统**：
  - 📝 对话自动总结
  - 🏷️ 兴趣话题追踪
  - ❤️ 用户偏好学习
  - 👁️ 视觉记忆（截屏识别）
  - 💡 主动回忆机制

### 🎤 语音交互
- **本地语音识别**：Web Speech API（无需网络）
- 云端备选：Mimo ASR API
- 按住说话，松开发送
- 实时音量电平指示

### 🔊 多后端 TTS 语音合成

| 后端 | 类型 | 说明 |
|------|------|------|
| **小米蜜模 Mimo** | ☁️ 云端 | 开箱即用，需申请 API Key |
| **阿里云 TTS** | ☁️ 云端 | 需开通阿里云语音合成服务 |
| **本地 VITS2** | 🖥️ 本地 | 完全离线，需自行部署 VITS2 服务 |

### 🧠 智能记忆系统
- 对话历史持久化（最多 300 条）
- 自动阶段总结
- 兴趣话题提取与追踪
- 偏好学习（喜欢/不喜欢/习惯）
- **视觉记忆**：自动截屏并识别画面内容
- 主动回忆：冷不丁提起以前聊过的话题

### 🎨 丰富的自定义
- 角色卡片系统（多角色切换）
- 自定义宠物名字、性格、说话风格
- 表情/动作自由开关
- 检测频率、截图频率可调
- 多语言界面（中文 / English / 日本語）

---

## 🚀 快速开始

### 下载即用
从 [Releases](https://github.com/MARS-HX/Live2DPet-modern/releases) 下载最新便携版，解压即可运行，无需安装任何运行时。

### 首次配置
1. 双击 `Live2DPet.exe` 启动
2. 右下角托盘图标右键 → **设置**
3. 配置 **API 地址 + Key**（支持 Ollama / OpenRouter 等）
4. 导入你的 Live2D 模型
5. 点击 **开始** 按钮

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
| 「−」「+」按钮 | 缩小/放大 |
| 「💬」按钮 | 打开聊天框 |
| 「⚙」按钮 | 打开设置 |
| 宠物上右键 | 快捷菜单 |

### 文字聊天
1. 点击「💬」打开聊天框
2. 输入文字按 Enter 发送
3. 也可点击快捷回复按钮快速聊天

### 语音聊天
1. 点击「🎤」按钮
2. **按住说话**，松开发送
3. 自动识别为文字并发送

### TTS 配置
设置 → TTS 设置 → 选择服务商并填写对应配置。

---

## ⚙️ 配置说明

### 配置文件 `config.json`
```json
{
  "apiKey": "your-api-key",
  "baseURL": "http://localhost:11434/v1",
  "modelName": "qwen3.5:2b",
  "interval": 60,
  "screenshotInterval": 0,
  "tts": {
    "serviceType": "mimo",
    "mimo": { "apiKey": "..." },
    "aliyun": { "accessKeyId": "...", "accessKeySecret": "...", "appKey": "..." },
    "local": { "baseURL": "http://localhost:7860" }
  }
}
```

### 数据文件
| 文件 | 说明 |
|------|------|
| `config.json` | 配置文件（API Key 等） |
| `enhance-data.json` | 记忆数据（对话历史、话题等） |
| `使用说明.md` | 使用文档 |

---

## 🧩 项目结构

```
Live2DPet-modern/
├── main.js                    # Electron 主进程
├── preload.js                 # IPC 桥接
├── index.html                 # 设置页面
├── desktop-pet.html           # 宠物窗口
├── src/
│   ├── core/                  # 核心逻辑
│   │   ├── ai-chat.js         # AI 聊天客户端
│   │   ├── conversation-store.js  # 对话记忆
│   │   ├── desktop-pet-system.js  # 桌面宠物主控
│   │   ├── emotion-system.js      # 表情系统
│   │   ├── tts-service.js         # TTS 语音合成（多后端）
│   │   ├── stt-service.js         # 语音识别
│   │   └── enhance/               # 增强功能
│   ├── main/                  # 主进程 IPC
│   │   ├── tts-ipc.js
│   │   ├── enhance-ipc.js
│   │   └── screen-capture.js
│   └── renderer/              # 渲染进程
│       ├── settings-ui.js
│       └── model-adapter.js
├── assets/                    # 资源文件
├── libs/                      # Live2D 引擎库
└── models/                    # Whisper 模型（可选）
```

---

## 🙏 致谢

- 原始项目：[x380kkm/Live2DPet](https://github.com/x380kkm/Live2DPet)
- [Live2D Cubism](https://www.live2d.com/) — 模型渲染引擎
- [Electron](https://www.electronjs.org/) — 桌面应用框架
- [Mimo API](https://xiaomimimo.com/) — 语音合成/识别服务
- [OpenRouter](https://openrouter.ai/) — AI 模型接口

---

## 📄 许可

本项目基于 [MIT License](LICENSE) 开源。

---

*Made with ❤️ by MARS-HX & x380kkm*
