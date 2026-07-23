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

### ⚙️ 丰富的自定义
- 角色卡片系统（多角色切换）
- 自定义宠物名字、性格、说话风格
- 表情/动作自由开关
- 检测频率、截图频率可调
- TTS 诊断工具

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

---

## ⚙️ 配置文件

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
│   │   ├── conversation-store.js  # 对话记忆（双模式独立）
│   │   ├── desktop-pet-system.js  # 桌面宠物主控
│   │   ├── tts-service.js         # TTS 语音合成（多后端）
│   │   ├── stt-service.js         # 语音识别
│   │   └── enhance/               # 增强功能
│   ├── main/                  # 主进程 IPC
│   └── renderer/              # 渲染进程
├── assets/                    # 资源文件
├── libs/                      # Live2D 引擎库
├── presets/                   # 酒馆预设
└── models/                    # Whisper 模型（可选）
```

---

## 📋 更新日志

### v1.5.0 — 双模式 + 独立聊天窗口 + 酒馆预设系统
- **双模式聊天**：陪伴模式 + 酒馆模式，各自独立记忆
- **独立聊天窗口**：可拖动到屏幕任意位置
- **酒馆预设系统**：内置奇幻/赛博/仙侠预设，支持自定义编辑导入导出
- **自动冒险日记**：酒馆切换时 AI 生成日记弹窗
- **毛玻璃 UI** + 暗色模式
- **完整 i18n**：中/英/日三语言
- **多后端 TTS**：Mimo / 阿里云 / 本地 VITS2
- **增强记忆系统**：自动总结、话题追踪、偏好学习、视觉记忆

### v2.0.0 — Interaction & Visual Memory
- 互动系统、关键帧视觉记忆、反重复机制

---

## 🙏 致谢

- 原始项目：[x380kkm/Live2DPet](https://github.com/x380kkm/Live2DPet)
- [Live2D Cubism](https://www.live2d.com/)
- [Electron](https://www.electronjs.org/)
- [Mimo API](https://xiaomimimo.com/)
- [OpenRouter](https://openrouter.ai/)

---

## 📄 许可

[MIT License](LICENSE)

---

*Made with ❤️ by MARS-HX & x380kkm*
