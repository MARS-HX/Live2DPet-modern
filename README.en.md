# 🐱 Live2DPet — AI Desktop Pet Companion

**[中文](README.md)** | **[日本語](README.ja.md)** | **English**

![License](https://img.shields.io/github/license/MARS-HX/Live2DPet-modern)
![Electron](https://img.shields.io/badge/Electron-42.4.0-blue)
![Live2D](https://img.shields.io/badge/Live2D-Cubism%204-ff69b4)

> An AI-powered desktop pet companion built with Electron + Live2D. Lives on your desktop, sees what you're doing, talks with you, and remembers everything.

---

## ✨ Features

### 🎭 Live2D Desktop Pet
- Live2D Cubism 3/4 model support
- Drag, click, and swipe interactions
- **27+ expressions**: halo, bunny ears, star eyes, blush, anger, sleep…
- Automatic mouse tracking

### 💬 AI Chat
- Compatible with any OpenAI-compatible API (Ollama, OpenRouter, DeepSeek…)
- Context-aware: knows what window you're using
- **Enhanced memory system**:
  - 📝 Auto conversation summarization
  - 🏷️ Topic tracking
  - ❤️ Preference learning
  - 👁️ Visual memory (screenshot analysis)
  - 💡 Proactive recall

### 🎤 Voice Interaction
- **Local STT**: Web Speech API (offline, no internet needed)
- Cloud fallback: Mimo ASR API
- Press & hold to talk
- Real-time audio level indicator

### 🔊 Multi-Backend TTS

| Backend | Type | Description |
|---------|------|-------------|
| **Mimo** | ☁️ Cloud | Ready to use, API key required |
| **Aliyun TTS** | ☁️ Cloud | Alibaba Cloud speech service |
| **Local VITS2** | 🖥️ Local | Fully offline, self-hosted |

### 🧠 Memory System
- Persistent chat history (up to 300 messages)
- Auto conversation summarization
- Topic extraction and tracking
- Preference learning (likes/dislikes/habits)
- **Visual memory**: screenshot analysis
- Proactive recall mechanism

### 🎨 Customization
- Character card system (multiple characters)
- Custom name, personality, speech style
- Expression/motion toggles
- Adjustable detection & screenshot intervals
- Multi-language UI (中文 / English / 日本語)

---

## 🚀 Quick Start

### Download & Run
Download the latest portable release from [Releases](https://github.com/MARS-HX/Live2DPet-modern/releases), unzip and run. No runtime installation required.

### First Time Setup
1. Double-click `Live2DPet.exe`
2. Right-click tray icon → **Settings**
3. Configure **API URL + Key** (Ollama, OpenRouter, etc.)
4. Import your Live2D model
5. Click **Start**

> The usage guide will open automatically on first launch

### From Source
```bash
git clone https://github.com/MARS-HX/Live2DPet-modern.git
cd Live2DPet-modern
npm install
npm start
```

### Build
```bash
npm run build          # Portable EXE
npm run build:dir      # Directory build (faster)
```

---

## 📖 User Guide

### Pet Controls
| Action | Effect |
|--------|--------|
| Drag pet | Move position |
| Click pet | Interactive chat |
| 「−」「+」buttons | Zoom out/in |
| 「💬」button | Open chat |
| 「⚙」button | Open settings |
| Right-click pet | Context menu |

### Text Chat
1. Click 「💬」to open chat
2. Type and press Enter
3. Quick reply buttons for fast chat

### Voice Chat
1. Click 「🎤」button
2. **Press & hold** to speak, release to send
3. Auto-transcribed to text

---

## 🧩 Project Structure

```
Live2DPet-modern/
├── main.js                    # Electron main process
├── preload.js                 # IPC bridge
├── index.html                 # Settings page
├── desktop-pet.html           # Pet window
├── src/
│   ├── core/                  # Core logic
│   ├── main/                  # Main process IPC
│   └── renderer/              # Renderer process
├── assets/                    # Resources
├── libs/                      # Live2D engine
└── models/                    # Whisper models (optional)
```

---

## 🙏 Credits

- Original project: [x380kkm/Live2DPet](https://github.com/x380kkm/Live2DPet)
- [Live2D Cubism](https://www.live2d.com/) — Model rendering engine
- [Electron](https://www.electronjs.org/) — Desktop framework
- [Mimo API](https://xiaomimimo.com/) — Speech services
- [OpenRouter](https://openrouter.ai/) — AI model API

---

## 📄 License

[MIT License](LICENSE)

---

*Made with ❤️ by MARS-HX & x380kkm*
