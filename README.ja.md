# 🐱 Live2DPet — AI デスクトップペット

**[中文](README.md)** | **[English](README.en.md)** | **日本語**

![License](https://img.shields.io/github/license/MARS-HX/Live2DPet-modern)
![Electron](https://img.shields.io/badge/Electron-42.4.0-blue)
![Live2D](https://img.shields.io/badge/Live2D-Cubism%204-ff69b4)

> Electron + Live2D で作られた AI デスクトップペット。デスクトップに常駐し、画面を認識し、会話し、記憶します。

---

## ✨ 機能

### 🎭 Live2D デスクトップペット
- Live2D Cubism 3/4 モデル対応
- ドラッグ、クリック、スワイプ操作
- **27+ 表情**: 輪光、うさ耳、星目、照れ、怒り、寝る…
- マウス追跡機能

### 💬 AI チャット
- OpenAI 互換 API に対応（Ollama / OpenRouter / DeepSeek…）
- 使用中のウィンドウを自動認識
- **拡張記憶システム**:
  - 📝 自動会話要約
  - 🏷️ トピック追跡
  - ❤️ 好み学習
  - 👁️ 視覚記憶（スクリーンショット解析）
  - 💡 能動的想起

### 🎤 音声対話
- **ローカル音声認識**: Web Speech API（オフライン対応）
- クラウド代替: Mimo ASR API
- 押して話す、離して送信
- リアルタイム音量表示

### 🔊 マルチバックエンド TTS

| バックエンド | 種類 | 説明 |
|------------|------|------|
| **Mimo** | ☁️ クラウド | すぐ使える、API Key 必要 |
| **阿里雲 TTS** | ☁️ クラウド |  Alibaba Cloud 音声合成 |
| **Local VITS2** | 🖥️ ローカル | 完全オフライン、自己ホスト |

### 🧠 記憶システム
- 会話履歴の保存（最大300件）
- 自動会話要約
- トピック抽出と追跡
- 好み学習（好き/嫌い/習慣）
- 視覚記憶（スクリーンショット解析）
- 能動的想起メカニズム

---

## 🚀 クイックスタート

### ダウンロード
[Releases](https://github.com/MARS-HX/Live2DPet-modern/releases) から最新版をダウンロードして解凍するだけ。インストール不要。

### 初回設定
1. `Live2DPet.exe` をダブルクリック
2. タスクトレイアイコンを右クリック → **設定**
3. **API URL + Key** を設定（Ollama / OpenRouter 等）
4. Live2D モデルをインポート
5. **開始** をクリック

### ソースから実行
```bash
git clone https://github.com/MARS-HX/Live2DPet-modern.git
cd Live2DPet-modern
npm install
npm start
```

### ビルド
```bash
npm run build          # ポータブル EXE
npm run build:dir      # ディレクトリビルド
```

---

## 🙏 クレジット

- オリジナルプロジェクト: [x380kkm/Live2DPet](https://github.com/x380kkm/Live2DPet)
- [Live2D Cubism](https://www.live2d.com/)
- [Electron](https://www.electronjs.org/)
- [Mimo API](https://xiaomimimo.com/)
- [OpenRouter](https://openrouter.ai/)

---

## 📄 ライセンス

[MIT License](LICENSE)

---

*Made with ❤️ by MARS-HX & x380kkm*
