# Changelog

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
