/**
 * Standalone Desktop Pet System
 * No game engine dependency - runs independently
 */
class DesktopPetSystem {
    constructor() {
        this.isActive = false;
        this.aiClient = null;
        this.promptBuilder = null;
        this.systemPrompt = null;
        this.detectionInterval = null;
        this.detectionIntervalMs = 10000;
        this.lastAppName = null;
        this.isRequesting = false;
        this.emotionSystem = null;

        // Audio state machine + playback tracking
        this.audioStateMachine = null;
        this.currentAudio = null;
        this.currentAudioUrl = null;
        this.currentSession = null;

        // Screenshot: captured on-demand in sendRequest (VLM captures independently)
        this.screenshotTimer = null; // kept for API compat, unused

        // Window focus tracking (1s sampling, cleared after each AI request)
        this.focusTimer = null;
        this.focusTracker = {};

        // Recent discussion pool: timestamped responses + LLM analysis for anti-repetition
        this.recentPool = [];       // [{response, timestamp, analysis}]
        this.recentPoolTTL = 30000; // 30s expiry

        // Message double-buffer: always play the latest, skip stale ones
        this.pendingMessage = null;   // next message to play (overwritten by newer)
        this.isPlayingMessage = false; // lock: currently playing a session
        this.chatGapMs = 5000;        // minimum gap between two message sessions

        // Desktop layout in prompt, default off
        this._showLayout = false;

        // 识屏流水线客户端（see-now 移植版）：按变化量挑帧、多帧拼一张图
        this.visionClient = null;

        // Game companion + hands-free voice input
        this.gameCompanion = null;
        this.companionVoiceInput = true;      // default on while accompanying
        this.companionVoiceLang = 'zh-CN';
        this._companionVoiceActive = false;
        this._companionRecognition = null;

        // Live danmaku delivery + on-demand pet start
        this._danmakuQueue = [];
        this._drainingDanmaku = false;
        this._autoStarting = false;
        this._suppressAutoStart = false;

        // 上次真正带上画面说话的时刻（诊断与去重用；不再用于节流）
        this.lastScreenshotTime = 0;

        // Hit interaction buffer
        this._hitBuffer = [];     // [{area, timestamp, description}]
        this._hitCount = 0;       // session total
    }

    async init() {
        this.aiClient = new AIChatClient();
        await this.aiClient.init();

        this.promptBuilder = new PetPromptBuilder();
        await this.promptBuilder.init();

        this.systemPrompt = this.promptBuilder.buildSystemPrompt();

        this.emotionSystem = new EmotionSystem(this);
        await this.emotionSystem.loadConfig();

        // Audio state machine
        this.audioStateMachine = new AudioStateMachine();
        await this._initAudioState();

        // 读配置（游戏陪伴 / 直播弹幕等）
        try {
            const config = await window.electronAPI.loadConfig();
            // 游戏陪伴：让宠物在用户玩游戏时陪伴吐槽
            if (typeof GameCompanion !== 'undefined') {
                const comp = config.companion || {};
                this.gameCompanion = new GameCompanion({
                    config: comp,
                    lang: config.uiLanguage === 'zh' ? 'zh' : (config.uiLanguage || 'en')
                });
                // 语音输入默认打开（用户可关）
                this.companionVoiceInput = comp.voiceInput !== false;
                this.companionVoiceLang = config.uiLanguage === 'zh' ? 'zh-CN'
                    : config.uiLanguage === 'ja' ? 'ja-JP' : 'en-US';
                console.log('[DesktopPetSystem] Game companion:',
                    this.gameCompanion.enabled ? 'on' : 'off',
                    '| screenshots:', this.gameCompanion.useScreenshots ? 'on' : 'off',
                    '| voice input:', this.companionVoiceInput ? 'on' : 'off');
            }
            // 哔哩哔哩直播间弹幕：让宠物回应弹幕
            if (typeof LiveCompanion !== 'undefined') {
                const bili = config.bilibili || {};
                this.liveCompanion = new LiveCompanion({
                    config: bili,
                    lang: config.uiLanguage === 'zh' ? 'zh' : (config.uiLanguage || 'en')
                });
                this.biliRoomTitle = bili.roomTitle || '';
                console.log('[DesktopPetSystem] Live companion:',
                    this.liveCompanion.enabled ? 'on' : 'off', '| mode:', this.liveCompanion.mode);
            }
        } catch (e) {}

        // 订阅直播间弹幕
        if (window.electronAPI?.onBiliDanmaku) {
            window.electronAPI.onBiliDanmaku((msg) => this._onDanmaku(msg));
        }
        if (window.electronAPI?.onBiliStatus) {
            window.electronAPI.onBiliStatus((st) => {
                if (st?.roomId && !this.biliRoomTitle && st.realRoomId) {
                    this.biliRoomTitle = 'room ' + st.realRoomId;
                }
            });
        }

        // 识屏流水线（变化分筛选 + 多帧拼图）。配置关掉时自动退回旧的单张截图。
        if (typeof VisionClient !== 'undefined' && window.electronAPI?.visionGrab) {
            try {
                const config = await window.electronAPI.loadConfig();
                const vc = config.vision || {};
                this.visionClient = new VisionClient.createVisionClient({ electronAPI: window.electronAPI });
                await this.visionClient.refreshSettings();
                const st = this.visionClient.getStatus();
                console.log('[DesktopPetSystem] Vision pipeline:',
                    vc.enabled === false ? 'off' : 'on',
                    '| quality:', (st && st.settings && st.settings.quality) || vc.quality || 'low',
                    '| pace:', (st && st.settings && st.settings.pace) || vc.pace || 'normal');
            } catch (e) {
                console.log('[DesktopPetSystem] Vision client unavailable:', e.message);
            }
        }

        // Listen for hit events from pet window
        if (window.electronAPI?.onPetHit) {
            window.electronAPI.onPetHit((data) => this._onHit(data));
        }

        console.log('[DesktopPetSystem] Initialized');
    }

    async _initAudioState() {
        if (!window.electronAPI) return;
        // Load preferred mode from config
        try {
            const config = await window.electronAPI.loadConfig();
            const mode = config.tts?.audioMode || 'tts';
            this.audioStateMachine.setPreferredMode(mode);
        } catch (e) {}
        // Check TTS availability.
        //
        // **必须带重试**：见 `_refreshTTSAvailability` 的说明 —— main.js 用
        // setImmediate 初始化 TTS，设置页可能抢在它前面来问。这里多试几次，
        // 后端一就绪就立刻把 effectiveMode 从 silent 拉回 tts。
        await this._refreshTTSAvailability({ retries: 10, delayMs: 300 });
        // Load default audio clips
        if (window.electronAPI.loadDefaultAudio) {
            try {
                const result = await window.electronAPI.loadDefaultAudio();
                if (result.success && result.files.length > 0) {
                    const clips = result.files.map(f => {
                        const bytes = Uint8Array.from(atob(f.base64), c => c.charCodeAt(0));
                        const blob = new Blob([bytes], { type: 'audio/wav' });
                        return new Audio(URL.createObjectURL(blob));
                    });
                    this.audioStateMachine.setDefaultAudioAvailable(true, clips);
                }
            } catch (e) {}
        }
        console.log('[DesktopPetSystem] Audio mode:', this.audioStateMachine.effectiveMode);
    }

    /**
     * 查一次 TTS 是否可用，并写进音频状态机。
     *
     * ## 为什么需要"复查"而不是查一次了事
     *
     * `main.js` 里 TTS 是在 `app.whenReady()` 之后用 `setImmediate` 初始化的：
     *
     *     setImmediate(async () => { ctx.ttsService.init(options) })
     *
     * 而本类的 `init()`（设置页加载时跑）**不受这个顺序约束**。设置页如果渲染得
     * 快，就会在 `ttsService.init()` 之前来问 `tts:status`，那一刻拿到的是
     * `initialized: false` —— 于是状态机把 TTS 判成不可用，`_recompute()` 把
     * 有效模式降到 `silent`，然后**再也没有人复查过**。
     *
     * 用户看到的现象就是"宠物突然不说话"，而 TTS 配置、API Key、网络全都是好的。
     * 因为这不是配置问题，是一次启动竞态，只是它每次的胜负取决于机器快慢。
     *
     * 所以这里改成：查到不可用就**安排几次重试**，一旦后端就绪立刻恢复发声。
     * 重试间隔递增、总时长有限，不会一直空转。
     *
     * @param {{retries?:number, delayMs?:number}} o
     * @returns {Promise<boolean>} 这次查到的可用性
     */
    async _refreshTTSAvailability({ retries = 0, delayMs = 400 } = {}) {
        if (!window.electronAPI?.ttsGetStatus) return false;
        let available = false;
        try {
            const status = await window.electronAPI.ttsGetStatus();
            available = !!(status.initialized && !status.degraded && status.configured);
            this.audioStateMachine.setTTSAvailable(available);
            if (!available) {
                // 把判定依据打出来 —— 否则"没声音"这件事在日志里完全没有痕迹
                console.log('[DesktopPetSystem] TTS not ready:',
                    `initialized=${status.initialized}`,
                    `degraded=${status.degraded}`,
                    `configured=${status.configured}`,
                    `service=${status.serviceType || '?'}`);
            }
        } catch (e) {
            console.log('[DesktopPetSystem] tts-status failed:', e.message);
        }

        if (!available && retries > 0) {
            if (this._ttsRetryTimer) clearTimeout(this._ttsRetryTimer);
            this._ttsRetryTimer = setTimeout(() => {
                this._ttsRetryTimer = null;
                this._refreshTTSAvailability({ retries: retries - 1, delayMs: Math.min(delayMs * 2, 4000) })
                    .catch(() => {});
            }, delayMs);
        } else if (available) {
            console.log('[DesktopPetSystem] TTS ready, audio mode:',
                this.audioStateMachine.effectiveMode);
        }
        return available;
    }

    /** 停掉进行中的 TTS 复查轮询（停宠物时调用）。 */
    _stopTTSRetry() {
        if (this._ttsRetryTimer) {
            clearTimeout(this._ttsRetryTimer);
            this._ttsRetryTimer = null;
        }
    }

    async start() {
        if (this.isActive) return;
        this._suppressAutoStart = false;   // an explicit start clears a manual stop
        if (!this.aiClient.isConfigured()) {
            console.warn('[DesktopPetSystem] API not configured');
            if (window.electronAPI) window.electronAPI.showSettings();
            return;
        }

        try {
            const result = await window.electronAPI.createPetWindow({});
            if (result.success) {
                this.isActive = true;
                this.startDetection();
                this.startFocusTimer();
                this.emotionSystem.start();
                // 后台开始攒图（按变化量筛帧）。这样 tick 到的时候队列里已经有货，
                // 不必在 tick 里阻塞等待 —— 见 sendRequest 里那段注释。
                this._startVisionWatcher();
                // 启动时再复查一次 TTS：从初始化到用户点"开始"之间，
                // 后端的 setImmediate 基本已经跑完，这一刻的结论才是可信的。
                await this._refreshTTSAvailability({ retries: 6, delayMs: 500 });
                console.log('[DesktopPetSystem] Started, audio:', this.audioStateMachine.effectiveMode);
            }
        } catch (error) {
            console.error('[DesktopPetSystem] Failed to start:', error);
        }
    }

    /** 起/停后台识屏（幂等，失败不影响主流程） */
    async _startVisionWatcher() {
        if (!this.visionClient) return;
        try {
            const r = await this.visionClient.startWatcher();
            if (r && r.success) console.log('[DesktopPetSystem] Vision watcher on:', r.intervalSec + 's');
            else if (r && r.error) console.log('[DesktopPetSystem] Vision watcher skipped:', r.error);
        } catch (e) {
            console.log('[DesktopPetSystem] Vision watcher failed:', e.message);
        }
    }

    async _stopVisionWatcher({ stopCapture = true } = {}) {
        if (!this.visionClient) return;
        try { await this.visionClient.stopWatcher(); } catch (e) {}
        if (stopCapture) {
            // suppress=true：用户主动停了桌宠，别让后台再自己把采集拉起来
            try { await this.visionClient.stop(); } catch (e) {}
        }
    }

    async stop() {
        // Remember that the user stopped the pet on purpose, so incoming danmaku
        // do not immediately bring it back.
        this._suppressAutoStart = true;
        if (!this.isActive) return;
        this.stopDetection();
        this.stopFocusTimer();
        this.stopCurrentAudio();
        this._stopCompanionVoice();
        this.emotionSystem.stop();
        await this._stopVisionWatcher();
        this._stopTTSRetry();
        try {
            await window.electronAPI.closePetWindow();
        } catch (e) {}
        this.isActive = false;
        this.focusTracker = {};
        this.recentPool = [];
        this._hitBuffer = [];
        this._hitCount = 0;
        this.pendingMessage = null;
        this.isPlayingMessage = false;
        console.log('[DesktopPetSystem] Stopped');
    }

    startDetection() {
        this.stopDetection();
        this.detectionInterval = setInterval(() => this.tick(), this.detectionIntervalMs);
        setTimeout(() => this.tick(), 3000);
        console.log(`[DesktopPetSystem] Detection started, interval: ${this.detectionIntervalMs}ms`);
    }

    stopDetection() {
        if (this.detectionInterval) {
            clearInterval(this.detectionInterval);
            this.detectionInterval = null;
        }
    }

    setInterval(ms) {
        this.detectionIntervalMs = Math.max(10000, ms);
        if (this.isActive) this.startDetection();
    }

    // ========== Focus Tracking (1s) ==========

    startFocusTimer() {
        this.stopFocusTimer();
        this.focusTimer = setInterval(() => this.focusTick(), 1000);
        console.log('[DesktopPetSystem] Focus timer started (1s interval)');
    }

    stopFocusTimer() {
        if (this.focusTimer) {
            clearInterval(this.focusTimer);
            this.focusTimer = null;
        }
    }

    async focusTick() {
        if (!this.isActive) return;
        try {
            const result = await window.electronAPI.getActiveWindow();
            if (!result?.success || !result.data?.owner?.name) return;
            if (this.shouldSkipApp(result.data.owner.name)) return;
            const windowKey = result.data.title || result.data.owner.name;
            if (!this.focusTracker[windowKey]) this.focusTracker[windowKey] = 0;
            this.focusTracker[windowKey] += 1;
            this._companionTick({
                title: result.data.title || '',
                process: result.data.owner.name || ''
            });
        } catch (e) {}
    }

    /**
     * Game-companion tick — runs inside the 1s focus loop but only actually
     * speaks when the companion says a moment is due (default: every 2 minutes).
     */
    _companionTick(win) {
        if (!this.gameCompanion) return;
        if (!this.gameCompanion.enabled) {
            // Companion turned off → make sure hands-free voice is off too.
            if (this._companionVoiceActive) this._stopCompanionVoice();
            return;
        }
        this._syncCompanionVoice();

        // Visible diagnostics. The companion is silent by design whenever it
        // decides not to speak, which makes a healthy setup indistinguishable
        // from a broken one — so report the decision, throttled.
        const now = Date.now();
        if (!this._lastCompanionLogAt || now - this._lastCompanionLogAt > 30000) {
            this._lastCompanionLogAt = now;
            const isGame = this.gameCompanion.isGameWindow(win);
            const busy = !!(this.isPlayingMessage || this.pendingMessage);
            const sinceLast = this.gameCompanion._lastCommentAt
                ? Math.round((now - this.gameCompanion._lastCommentAt) / 1000) + 's ago'
                : 'never';
            console.log(`[Companion] tick: "${(win && win.title) || ''}" `
                + `game=${isGame} busy=${busy} lastComment=${sinceLast} `
                + `interval=${Math.round(this.gameCompanion.commentIntervalMs / 1000)}s`);
        }

        // Never interrupt something the pet is already saying.
        if (this.isPlayingMessage || this.pendingMessage) return;
        this.gameCompanion.noteFocus(win);
        if (!this.gameCompanion.shouldComment(win)) return;
        console.log(`[Companion] moment due — speaking about "${(win && win.title) || ''}"`);
        this._companionMoment(win).catch(() => {});
    }

    /**
     * Grab visual context for the companion.
     *
     * 优先走识屏流水线：游戏画面每帧都在变，切点判据在 `action` 档里被调得很钝
     * （cutAbs 80、积分 30 秒），正好对上"打游戏时一直在动"这种情况。拿到的是一张
     * **多帧拼图**，模型能看到"刚才发生了这几件事"而不是一瞬间的定格。
     *
     * 拿不到才退回旧的高清单张。
     *
     * @returns {Promise<Array|null>} OpenAI content blocks（text + image_url）或 null
     */
    async _companionVisual(win) {
        if (!window.electronAPI) return null;
        const title = win && win.title ? win.title : '';
        // ① 新流水线
        if (this.visionClient?.available && this.visionClient.available()) {
            try {
                const sheet = await this.visionClient.grab({
                    seconds: 20,
                    minFrames: 1,
                    quality: 'low',
                    scene: false,
                });
                if (sheet && sheet.ok && sheet.dataUrl) {
                    const block = this.visionClient.toContentBlock(sheet);
                    if (block) return block;
                }
            } catch (e) {
                console.log('[DEBUG:companion] vision grab failed:', e.message);
            }
        }
        // ② 旧路：一张高清单帧
        const shot = await this._companionScreenshot(win);
        if (!shot) return null;
        return [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + shot } }];
    }

    /**
     * Grab one frame for the companion. Returns base64 JPEG or null.
     * Prefers the focused window so the remark is about the game itself.
     */
    async _companionScreenshot(win) {
        if (!window.electronAPI) return null;
        const title = win && win.title ? win.title : '';
        try {
            if (title && window.electronAPI.getScreenCaptureHQ) {
                const hq = await window.electronAPI.getScreenCaptureHQ(title);
                if (hq?.success && hq.data) return hq.data;
            }
            if (window.electronAPI.getScreenCapture) {
                const cap = await window.electronAPI.getScreenCapture();
                if (cap?.success && cap.data) return cap.data;
            }
        } catch (e) {
            console.log('[DEBUG:companion] screenshot failed:', e.message);
        }
        return null;
    }

    /** Ask the pet's model for a short in-game remark and queue it. */
    async _companionMoment(win) {
        if (this.isRequesting || !this.aiClient?.isConfigured?.()) return;
        const instruction = this.gameCompanion.buildGamePrompt(win);
        try {
            const content = [{ type: 'text', text: instruction }];
            // 默认根据截屏了解用户在干什么（优先多帧拼图）
            if (this.gameCompanion.useScreenshots) {
                const visual = await this._companionVisual(win);
                if (visual) content.push(...visual);
            }
            const response = await this.aiClient.callAPI([
                { role: 'system', content: this.systemPrompt + '\n\n' + this.buildDynamicContext() },
                { role: 'user', content }
            ]);
            if (!response || !this.isActive) return;
            this.pendingMessage = response;
            this._processQueue();
        } catch (e) {
            console.log('[DEBUG:companion] failed:', e.message);
        }
    }

    // ========== 游戏陪伴：免提语音输入 ==========

    /** Start/stop hands-free voice listening to match the companion config. */
    _syncCompanionVoice() {
        const wanted = !!(this.gameCompanion && this.gameCompanion.enabled && this.companionVoiceInput);
        if (wanted && !this._companionVoiceActive) this._startCompanionVoice();
        else if (!wanted && this._companionVoiceActive) this._stopCompanionVoice();
    }

    _startCompanionVoice() {
        // Prefer the fully offline engine. Electron exposes webkitSpeechRecognition
        // but has no Google API key behind it, so that path always fails with
        // "network"; the offline engine needs no network at all.
        if (typeof window !== 'undefined' && window.OfflineAsr?.OfflineAsrCapture) {
            this._startOfflineVoice();
            return;
        }
        this._startWebSpeechVoice();
    }

    /**
     * Offline capture: microphone -> 16 kHz PCM -> native Vosk in the main
     * process -> recognised text back here. See src/renderer/offline-asr.js.
     */
    _startOfflineVoice() {
        if (this._offlineCapture) return;
        try {
            this._offlineCapture = new window.OfflineAsr.OfflineAsrCapture({
                onText: (text) => { this._handleCompanionUtterance(text).catch(() => {}); },
                onError: (reason) => {
                    console.log(`[CompanionVoice] offline engine unavailable: ${reason}`);
                    this._companionVoiceFailedReason = reason;
                    // Assets simply not installed yet: don't retry in a hot loop.
                    if (reason === 'native_not_installed' || reason === 'model_not_installed') {
                        this.companionVoiceInput = false;
                    }
                    this._companionVoiceActive = false;
                    this._offlineCapture = null;
                },
            });
        } catch (e) {
            console.log('[CompanionVoice] offline engine setup failed:', e.message);
            this._companionVoiceActive = false;
            return;
        }
        this._companionVoiceActive = true;      // optimistic; onError corrects it
        this._offlineCapture.start().then((res) => {
            if (!res.ok) {
                console.log(`[CompanionVoice] offline listening not started: ${res.reason}`);
                this._companionVoiceActive = false;
            } else {
                console.log('[CompanionVoice] listening (offline)');
            }
        });
    }

    _startWebSpeechVoice() {
        const SR = (typeof window !== 'undefined') && (window.SpeechRecognition || window.webkitSpeechRecognition);
        if (!SR) {
            console.log('[CompanionVoice] Web Speech API unavailable; voice input stays off');
            this._companionVoiceActive = false;
            return;
        }
        try {
            const rec = new SR();
            rec.lang = this.companionVoiceLang || 'zh-CN';
            rec.continuous = true;
            rec.interimResults = false;
            rec.maxAlternatives = 1;
            rec.onresult = (event) => {
                for (let i = event.resultIndex; i < event.results.length; i++) {
                    if (!event.results[i].isFinal) continue;
                    const text = (event.results[i][0]?.transcript || '').trim();
                    if (text) this._handleCompanionUtterance(text).catch(() => {});
                }
            };
            rec.onerror = (e) => {
                const reason = (e && e.error) || 'unknown';
                // Chromium's recogniser is a *cloud* service. Electron ships no
                // Google API key for it, so `start()` normally fails with
                // "network" / "service-not-allowed" no matter what the user
                // does — previously every failure was mislabelled as "microphone
                // denied", which hid the real cause. Report it truthfully.
                if (reason === 'no-speech' || reason === 'aborted') return;   // benign
                console.log(`[CompanionVoice] speech recognition error: "${reason}"`
                    + (reason === 'network' || reason === 'service-not-allowed'
                        ? ' — Chromium 的语音识别依赖 Google 在线服务，Electron 不带该密钥，'
                          + '所以免手语音输入在本应用内无法工作'
                        : ''));
                if (reason === 'not-allowed' || reason === 'service-not-allowed' || reason === 'network') {
                    // Stop retrying: no amount of restarts will fix a missing service.
                    this.companionVoiceInput = false;
                    this._companionVoiceActive = false;
                    this._companionRecognition = null;
                    this._companionVoiceFailedReason = reason;
                }
            };
            rec.onend = () => {
                // Continuous mode still ends on silence in Chromium; restart while wanted.
                if (this._companionVoiceActive && this.isActive) {
                    try { rec.start(); } catch (e) {}
                }
            };
            rec.start();
            this._companionRecognition = rec;
            this._companionVoiceActive = true;
            console.log('[CompanionVoice] listening');
        } catch (e) {
            console.log('[CompanionVoice] failed to start:', e.message);
            this._companionVoiceActive = false;
        }
    }

    _stopCompanionVoice() {
        this._companionVoiceActive = false;
        // Offline capture owns the microphone and the engine session.
        if (this._offlineCapture) {
            const cap = this._offlineCapture;
            this._offlineCapture = null;
            cap.stop().catch(() => {});
        }
        if (this._companionRecognition) {
            try { this._companionRecognition.onend = null; this._companionRecognition.abort(); } catch (e) {}
            this._companionRecognition = null;
        }
        console.log('[CompanionVoice] stopped');
    }

    /** Answer something the user said out loud, using the current screen. */
    async _handleCompanionUtterance(text) {
        if (!this.isActive || this.isRequesting || !this.aiClient?.isConfigured?.()) return;
        let win = { title: '', process: '' };
        try {
            const active = await window.electronAPI?.getActiveWindow?.();
            if (active?.success && active.data) {
                win = { title: active.data.title || '', process: active.data.owner?.name || '' };
            }
        } catch (e) {}

        const instruction = this.gameCompanion.buildVoiceReplyPrompt(text, win);
        if (!instruction) return;
        this.isRequesting = true;
        try {
            const content = [{ type: 'text', text: instruction }];
            if (this.gameCompanion.useScreenshots) {
                const visual = await this._companionVisual(win);
                if (visual) content.push(...visual);
            }
            const response = await this.aiClient.callAPI([
                { role: 'system', content: this.systemPrompt + '\n\n' + this.buildDynamicContext() },
                { role: 'user', content }
            ]);
            if (!response || !this.isActive) return;
            this.pendingMessage = response;
            this._processQueue();
        } catch (e) {
            console.log('[DEBUG:companion] voice reply failed:', e.message);
        } finally {
            this.isRequesting = false;
        }
    }

    // ========== 哔哩哔哩直播间弹幕 ==========

    /**
     * A danmaku arrived. Rate limiting happens here; delivery is queued so a
     * busy pet does not silently swallow the message (the live chat is a
     * firehose and the pet's own loop occupies it most of the time).
     */
    _onDanmaku(msg) {
        if (!this.liveCompanion) {
            console.log('[Danmaku] ignored: live companion not initialised');
            return;
        }
        if (!this.liveCompanion.enabled) {
            console.log('[Danmaku] ignored: live danmaku is disabled in settings');
            return;
        }
        // A danmaku reply needs a running pet (it owns the bubble and the voice).
        // Live chat is exactly the case where the user is not watching this app,
        // so bring the pet up instead of silently dropping everything.
        if (!this.isActive) {
            this._ensureRunningForDanmaku();
            return;
        }
        if (!this.liveCompanion.shouldReply(msg)) {
            console.log(`[Danmaku] skipped by policy (mode=${this.liveCompanion.mode}): ${msg.text}`);
            return;
        }
        if (!this._danmakuQueue) this._danmakuQueue = [];
        this._danmakuQueue.push(msg);
        // Keep the queue fresh: older danmaku stop mattering quickly.
        while (this._danmakuQueue.length > 3) this._danmakuQueue.shift();
        console.log(`[Danmaku] queued (${this._danmakuQueue.length} waiting): ${msg.text}`);
        this._drainDanmakuQueue();
    }

    /** Start the pet on demand so an incoming danmaku actually gets answered. */
    async _ensureRunningForDanmaku() {
        if (this._autoStarting || this.isActive) return;
        if (this._suppressAutoStart) {
            console.log('[Danmaku] ignored: the pet was stopped manually');
            return;
        }
        if (!this.aiClient?.isConfigured?.()) {
            console.log('[Danmaku] cannot answer: the AI model is not configured');
            return;
        }
        this._autoStarting = true;
        console.log('[Danmaku] pet is not running — starting it so danmaku can be answered');
        try {
            await this.start();
            console.log('[Danmaku] pet started:', this.isActive ? 'yes' : 'no');
        } catch (e) {
            console.log('[Danmaku] auto-start failed:', e.message);
        } finally {
            this._autoStarting = false;
        }
    }

    /** Deliver queued danmaku replies one at a time, waiting for a free pet. */
    async _drainDanmakuQueue() {
        if (this._drainingDanmaku) return;
        this._drainingDanmaku = true;
        try {
            while (this._danmakuQueue && this._danmakuQueue.length > 0 && this.isActive) {
                if (this.isRequesting || this.isPlayingMessage || this.pendingMessage) {
                    await new Promise((r) => setTimeout(r, 1500));
                    continue;
                }
                const msg = this._danmakuQueue.shift();
                console.log(`[Danmaku] answering <${msg.user}>: ${msg.text}`);
                await this._replyToDanmaku(msg);
            }
        } finally {
            this._drainingDanmaku = false;
        }
    }

    /** Re-read the live-danmaku settings (the settings panel calls this on save). */
    async reloadLiveCompanionConfig() {
        try {
            const cfg = (await window.electronAPI.loadConfig()).bilibili || {};
            if (this.liveCompanion) {
                this.liveCompanion.configure(cfg);
            } else if (typeof LiveCompanion !== 'undefined') {
                this.liveCompanion = new LiveCompanion({ config: cfg, lang: 'zh' });
            }
            this.biliRoomTitle = cfg.roomTitle || this.biliRoomTitle || '';
            console.log('[DesktopPetSystem] Live companion reloaded:',
                this.liveCompanion?.enabled ? 'on' : 'off', '| mode:', this.liveCompanion?.mode);
        } catch (e) {
            console.log('[DEBUG:danmaku] reload failed:', e.message);
        }
    }

    /** Answer one danmaku through the pet's normal bubble + TTS path. */
    async _replyToDanmaku(msg) {
        if (!this.aiClient?.isConfigured?.()) return;
        const instruction = this.liveCompanion.buildReplyPrompt(msg, { roomTitle: this.biliRoomTitle });
        this.isRequesting = true;
        try {
            const response = await this.aiClient.callAPI([
                { role: 'system', content: this.systemPrompt + '\n\n' + this.buildDynamicContext() },
                { role: 'user', content: instruction }
            ]);
            if (!response || !this.isActive) return;
            // 弹幕回应必须走软件内的 TTS 语音合成（即使音频模式是静音）
            this.pendingMessage = { text: response, forceTts: true };
            this._processQueue();
        } catch (e) {
            console.log('[DEBUG:danmaku] reply failed:', e.message);
        } finally {
            this.isRequesting = false;
        }
    }

    // ========== Knowledge Layer ==========

    /**
     * i18n helper — delegates to prompt builder's _t()
     */
    _t(key) {
        return this.promptBuilder ? this.promptBuilder._t(key) : key;
    }

    buildDynamicContext() {
        const parts = [];

        // Self-awareness: appearance (know but don't mention)
        parts.push(this._t('sys.selfAwareness'));

        // Window focus tracking summary (top 5) — core focus content
        if (Object.keys(this.focusTracker).length > 0) {
            const secLabel = this._t('sys.seconds');
            const focusEntries = Object.entries(this.focusTracker)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([name, seconds]) => `${this._shortenTitle(name)}: ${seconds}${secLabel}`)
                .join(', ');
            parts.push(this._t('sys.windowUsage') + focusEntries);
        }

        // Anti-repetition: structural pattern detection from recent pool
        this._pruneRecentPool();
        const recentResponses = this.recentPool.map(e => e.response);
        if (recentResponses.length >= 2) {
            const hint = this._detectRepetition(recentResponses.slice(-4));
            if (hint) parts.push(hint);
        }

        // Anti-repetition: semantic topic/habit avoidance from LLM analysis
        const poolContext = this._buildPoolContext();
        if (poolContext) parts.push(poolContext);

        return parts.join('\n');
    }

    /**
     * Detect repeated sentence patterns in recent responses.
     * Returns a hint string if repetition is found, or empty string.
     */
    _detectRepetition(responses) {
        if (responses.length < 2) return '';
        const patterns = [];

        // Check for repeated question marks (rhetorical questions)
        const questionCount = responses.filter(r => r.includes('？') || r.includes('?')).length;
        if (questionCount >= 2) patterns.push(this._t('sys.patternQuestion'));

        // Check for repeated opening words (first 2 chars)
        const openings = responses.map(r => r.slice(0, 2));
        if (openings.length >= 2 && new Set(openings).size === 1) {
            patterns.push(this._t('sys.patternOpening'));
        }

        // Check for repeated sentence-ending patterns (last 4 chars before punctuation)
        const endings = responses.map(r => {
            const clean = r.replace(/[。！？…\s]+$/, '');
            return clean.slice(-4);
        });
        if (endings.length >= 2 && new Set(endings).size === 1) {
            patterns.push(this._t('sys.patternEnding'));
        }

        // Check for similar response length (all within ±20% of mean)
        if (responses.length >= 3) {
            const lengths = responses.map(r => r.length);
            const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
            const allSimilar = mean > 0 && lengths.every(l => Math.abs(l - mean) / mean <= 0.2);
            if (allSimilar) patterns.push(this._t('sys.patternLength'));
        }

        // Check for exclamation overuse
        const exclCount = responses.filter(r => r.includes('！') || r.includes('!')).length;
        if (exclCount >= 3) patterns.push(this._t('sys.patternExclamation'));

        // Check for ellipsis overuse
        const ellipsisCount = responses.filter(r => r.includes('…') || r.includes('...')).length;
        if (ellipsisCount >= 3) patterns.push(this._t('sys.patternEllipsis'));

        if (patterns.length > 0) {
            return this._t('sys.antiRepetition').replace('{0}', patterns.join('、'));
        }
        return '';
    }

    // ========== Main Tick & Request ==========

    /**
     * 慢循环：多久"主动看一眼并说句话"。
     *
     * ## 和识屏流水线的关系（改造后的分工）
     *
     * 改造前这里是"到点就去截一张图、问一次 AI"，截图和说话绑死在一起。
     * 现在画面由 `vision` 后台常驻采集、按画面变化量筛帧、攒成 sheet，
     * 这里只负责**消费**：到点了看看队列里有没有**新的一张图**。
     *
     * - 有 → 问模型（`sendRequest`）
     * - 没有 → **这一轮直接跳过，不发请求**
     *
     * ## 为什么"没有新图就不发请求"
     *
     * 旧逻辑是"拿不到新图就退回截一张旧图照样发"，等于同一块屏幕付两遍钱，
     * 而且模型会对着十分钟没变的画面反复说相似的话（那时候靠防重复机制硬压）。
     * 画面没变本来就是"没什么可说的"，诚实地不说话比硬凑一句好。
     *
     * 静止屏幕也不会永远沉默：`vision` 自己有兜底帧（`silentFloorSec` / `floorGapK`），
     * 20 秒左右会产出"确实没变"的一张，那时这里照常说话。
     */
    async tick() {
        if (!this.isActive || this.isRequesting || !this.aiClient.isConfigured()) return;

        try {
            const result = await window.electronAPI.getActiveWindow();
            if (!result?.success || !result.data?.owner?.name) return;
            if (this.shouldSkipApp(result.data.owner.name)) return;

            const windowTitle = result.data.title || result.data.owner.name;
            const bounds = result.data.bounds;

            /**
             * **先问画面，再决定要不要说话。**
             *
             * `peek()` 是零等待的：后台采集一直在按变化量筛帧，队列里通常
             * 已经有货。只有它给了 null（这段时间画面没变化、攒不出新图）
             * 才轮到"要不要等一会儿"的例外情况。
             */
            let sheet = null;
            if (this.visionClient?.available && this.visionClient.available()) {
                sheet = await this.visionClient.peek().catch(() => null);

                if (!sheet) {
                    // 两种例外值得等一等：
                    //  ① 刚启动，队列还是空的，等一张让宠物能开口
                    //  ② 游戏陪伴开着且正到开口的时机（它自己有自己的节奏）
                    const companionDue = !!(this.gameCompanion?.enabled
                        && this.gameCompanion.shouldComment
                        && !this.isPlayingMessage);
                    const firstRun = !this._spokeOnce;
                    if (firstRun || companionDue) {
                        const r = await this.visionClient
                            .grab({ seconds: 6, minFrames: 2 })
                            .catch(() => null);
                        if (r && r.ok && r.dataUrl) sheet = r;
                    }
                }

                if (!sheet) {
                    // 没有新画面 → 不说话。这是刻意的省钱路径，不是失败。
                    console.log('[DesktopPetSystem] tick skipped: no new frame yet');
                    return;
                }
            }

            this.lastAppName = windowTitle;
            await this.sendRequest(windowTitle, bounds, sheet);
        } catch (error) {
            console.error('[DesktopPetSystem] Tick error:', error);
        }
    }

    stopCurrentAudio() {
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio = null;
        }
        if (this.currentAudioUrl) {
            URL.revokeObjectURL(this.currentAudioUrl);
            this.currentAudioUrl = null;
        }
    }

    /**
     * Prepare audio for playback (synthesis/loading phase).
     * Returns { play: () => Promise<void>, duration: number } or null.
     */
    async prepareAudio(text, forceTts = false) {
        if (!this.audioStateMachine && !forceTts) return null;
        // forceTts: live-danmaku replies must be voiced even if the user set the
        // audio mode to silent or default clips.
        let mode = forceTts ? 'tts' : this.audioStateMachine.effectiveMode;

        /**
         * **最后一道自愈**：用户明明选了 tts，有效模式却是 silent —— 几乎一定是
         * 启动时的竞态留下的错判（后端那时还没初始化完）。在这里复查一次，
         * 让"某一次启动后突然没声音"这种事能自己恢复，而不是要用户重启或去翻日志。
         *
         * 只在"偏好是 tts 但降级成 silent"时出手，静音是用户的显式选择就不打扰。
         */
        if (!forceTts && mode === 'silent' && this.audioStateMachine.preferredMode === 'tts') {
            const ok = await this._refreshTTSAvailability();
            if (ok) {
                mode = this.audioStateMachine.effectiveMode;
                console.log('[DesktopPetSystem] TTS recovered on demand, audio mode:', mode);
            }
        }

        if (mode === 'tts' && window.electronAPI?.ttsSynthesize) {
            try {
                const result = await window.electronAPI.ttsSynthesize(text);
                if (!result.success || !result.wav) {
                    if (forceTts) console.warn('[TTS] Forced synthesis failed:', result.error || 'no audio');
                    return null;
                }

                const audio = this._createAudioFromBase64(result.wav);
                // Wait for metadata to get duration
                const duration = await new Promise((resolve, reject) => {
                    audio.addEventListener('loadedmetadata', () => resolve(audio.duration * 1000));
                    audio.addEventListener('error', () => reject(new Error('audio load failed')));
                });

                return {
                    duration,
                    play: () => this._playPreparedAudio(audio)
                };
            } catch (e) {
                console.warn('[TTS] Prepare failed:', e.message);
                return null;
            }
        } else if (mode === 'default-audio') {
            const clip = this.audioStateMachine.getRandomClip();
            if (!clip) return null;
            const audio = clip.cloneNode();
            return {
                duration: 0, // unknown for default clips
                play: () => this._playPreparedAudio(audio)
            };
        }
        return null; // silent
    }

    _createAudioFromBase64(base64) {
        const wavBytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const blob = new Blob([wavBytes], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio._objectUrl = url;
        return audio;
    }

    /**
     * Play a prepared Audio element. Returns Promise that resolves when playback ends.
     */
    _playPreparedAudio(audio) {
        this.stopCurrentAudio();
        this.currentAudio = audio;
        this.currentAudioUrl = audio._objectUrl || null;
        return new Promise(resolve => {
            audio.addEventListener('ended', () => { this.stopCurrentAudio(); resolve(); });
            audio.addEventListener('error', () => { this.stopCurrentAudio(); resolve(); });
            audio.play().catch(() => { this.stopCurrentAudio(); resolve(); });
        });
    }

    shouldSkipApp(appName) {
        const skip = ['desktop-pet', 'electron'];
        return skip.some(s => appName.toLowerCase().includes(s));
    }

    /**
     * Shorten a window title for prompt use.
     * Strips common browser/app suffixes and truncates.
     */
    _shortenTitle(title, maxLen = 30) {
        if (!title) return '';
        // Strip trailing " - AppName" patterns (browser suffixes, IDE names, etc.)
        let short = title.replace(/\s*[-–—]\s*(?:Google Chrome|Microsoft\s*Edge|Firefox|Brave|Opera|Safari|Cursor|Visual Studio Code|VSCode|Code)$/i, '');
        if (short.length > maxLen) short = short.slice(0, maxLen) + '…';
        return short;
    }

    // ========== Hit Interaction ==========

    /**
     * Handle interaction event from pet window.
     * @param {{type: string, area: string, durationMs: number, size?: number}} data
     */
    _onHit(data) {
        const now = Date.now();
        this._hitCount++;
        const entry = {
            type: data.type || 'click',
            area: data.area || 'body',
            durationMs: data.durationMs || 0,
            timestamp: now,
            extra: data.size ? { size: data.size } : null
        };
        this._hitBuffer.push(entry);
        while (this._hitBuffer.length > 20) this._hitBuffer.shift();
        console.log(`[DesktopPetSystem] Interaction #${this._hitCount}: ${entry.type} ${entry.area}`);
    }

    /**
     * Build interaction context string for injection into AI prompt.
     * Uses configurable action descriptions from character card hitActions.
     * Format: 过去一分钟里(描述)N次,(描述)N次
     * Clears buffer after reading.
     */
    _buildHitContext() {
        if (this._hitBuffer.length === 0) return '';
        const now = Date.now();
        const recent = this._hitBuffer.filter(h => now - h.timestamp < 60000);
        if (recent.length === 0) {
            this._hitBuffer = [];
            return '';
        }

        // Get configurable descriptions from character card, fallback to i18n defaults
        const ha = this.promptBuilder?.characterPrompt?.hitActions || {};
        const types = ['click', 'touch', 'drag', 'swipe', 'resize'];
        const desc = {};
        for (const type of types) {
            desc[type] = (ha[type] && ha[type].trim()) || this._t(`sys.hitDefault.${type}`);
        }

        // Count by type
        const counts = {};
        for (const h of recent) {
            counts[h.type] = (counts[h.type] || 0) + 1;
        }

        const parts = [];
        for (const type of types) {
            if (counts[type]) {
                parts.push(this._t('sys.hitCount').replace('{0}', desc[type]).replace('{1}', counts[type]));
            }
        }

        if (parts.length === 0) {
            this._hitBuffer = [];
            return '';
        }

        this._hitBuffer = [];
        return '\n' + this._t('sys.hitContext').replace('{0}', parts.join(','));
    }

    // ========== Recent Discussion Pool ==========

    /**
     * Prune expired entries from the recent pool.
     */
    _pruneRecentPool() {
        const now = Date.now();
        this.recentPool = this.recentPool.filter(e => now - e.timestamp < this.recentPoolTTL);
    }

    /**
     * Fire-and-forget: call LLM to extract topics and speech habits from a response.
     */
    async _analyzeResponse(entry) {
        if (!this.aiClient?.isConfigured()) return;
        try {
            const prompt = this._t('sys.analyzePrompt');
            const result = await this.aiClient.callAPI([
                { role: 'system', content: prompt },
                { role: 'user', content: entry.response }
            ]);
            if (result) {
                const parsed = this._parseAnalysis(result);
                if (parsed) {
                    entry.analysis = parsed;
                    console.log('[DesktopPetSystem] Analysis:', JSON.stringify(parsed));
                }
            }
        } catch (e) {
            console.warn('[DesktopPetSystem] Analysis error:', e.message);
        }
    }

    /**
     * Parse JSON analysis from LLM response.
     */
    _parseAnalysis(text) {
        if (!text) return null;
        try {
            const parsed = JSON.parse(text);
            if (parsed.topics || parsed.habits) return parsed;
        } catch {}
        const match = text.match(/\{[\s\S]*?\}/);
        if (match) {
            try {
                const parsed = JSON.parse(match[0]);
                if (parsed.topics || parsed.habits) return parsed;
            } catch {}
        }
        return null;
    }

    /**
     * Build avoidance context from recent pool analyses.
     */
    _buildPoolContext() {
        this._pruneRecentPool();
        const analyses = this.recentPool
            .filter(e => e.analysis)
            .map(e => e.analysis);
        if (analyses.length === 0) return '';

        const parts = [];

        // Collect all topics
        const topics = [...new Set(analyses.flatMap(a => a.topics || []))];
        if (topics.length > 0) {
            parts.push(this._t('sys.topicAvoid').replace('{0}', topics.join('、')));
        }

        // Collect all habits
        const habits = [...new Set(analyses.flatMap(a => a.habits || []))];
        if (habits.length > 0) {
            parts.push(this._t('sys.habitAvoid').replace('{0}', habits.join('、')));
        }

        return parts.join('\n');
    }

    // ========== Message Double-Buffer ==========

    /**
     * Log the full request text (system prompt + history + user message),
     * stripping base64 image data for readability.
     */
    _logRequestText(messages) {
        const lines = messages.map(m => {
            const role = m.role;
            let text;
            if (typeof m.content === 'string') {
                text = m.content;
            } else if (Array.isArray(m.content)) {
                text = m.content
                    .filter(c => c.type === 'text')
                    .map(c => c.text)
                    .join(' ');
                const imgCount = m.content.filter(c => c.type === 'image_url').length;
                if (imgCount > 0) text += ` [+${imgCount} image(s)]`;
            } else {
                text = JSON.stringify(m.content);
            }
            return `[${role}] ${text}`;
        });
        console.log(`[DesktopPetSystem] === Request (${messages.length} messages) ===\n${lines.join('\n')}`);
    }

    async _processQueue() {
        if (this.isPlayingMessage) return;
        this.isPlayingMessage = true;

        while (this.pendingMessage && this.isActive) {
            // Grab latest and clear the slot. A plain string is the common case;
            // an object carries per-message options (e.g. forceTts).
            const raw = this.pendingMessage;
            this.pendingMessage = null;
            const text = typeof raw === 'string' ? raw : (raw && raw.text);
            const forceTts = !!(raw && typeof raw === 'object' && raw.forceTts);
            if (!text) continue;

            if (this.currentSession) this.currentSession.cancel();
            this.stopCurrentAudio();
            if (this.emotionSystem) this.emotionSystem.forceRevert();

            const session = MessageSession.create(text, { forceTts });
            this.currentSession = session;
            await session.run(this);

            // Wait minimum gap before playing next message
            if (this.chatGapMs > 0 && this.pendingMessage) {
                await new Promise(r => setTimeout(r, this.chatGapMs));
            }
        }

        this.isPlayingMessage = false;
    }

    /**
     * 问模型并安排播放。
     *
     * @param {string} appName 当前活动窗口标题
     * @param {object} bounds 窗口尺寸（可选）
     * @param {object|null} preSheet tick 已经取到的识屏图（新的流水线路径）
     */
    async sendRequest(appName, bounds, preSheet = null) {
        if (this.isRequesting) return;

        // 注：旧的 `screenshotInterval` 节流已移除。
        // 它原本用来限制"多久截一次全屏"，而截图现在由识屏流水线按
        // **画面变化量**决定（`vision.pace`），按秒数的节流已经没有意义 ——
        // 留着只会和 pace 打架，让某些该说的话因为"没到截图时间"而被跳过。
        const now = Date.now();

        this.isRequesting = true;

        try {
            // Fetch all open windows for layout context (default off)
            let layoutSummary = '';
            if (this._showLayout && window.electronAPI?.getOpenWindows) {
                try {
                    const winResult = await window.electronAPI.getOpenWindows();
                    if (winResult?.success && winResult.data.length > 0) {
                        const lines = winResult.data
                            .filter(w => {
                                if (!w.owner?.name || this.shouldSkipApp(w.owner.name)) return false;
                                // Skip minimized windows (taskbar button size)
                                const b = w.bounds;
                                return b && b.width > 200 && b.height > 200;
                            })
                            .slice(0, 5)
                            .map(w => {
                                const b = w.bounds;
                                const size = b ? `${b.width}x${b.height}` : '?';
                                return `${this._shortenTitle(w.title || w.owner.name)} [${size}]`;
                            });
                        if (lines.length > 2) {
                            layoutSummary = '\n' + this._t('sys.windowLayout') + lines.join(', ');
                        }
                    }
                } catch (e) {}
            }

            // System idle time (seconds since last keyboard/mouse input)
            let idleInfo = '';
            if (window.electronAPI?.getSystemIdleTime) {
                try {
                    const idleSec = await window.electronAPI.getSystemIdleTime();
                    if (idleSec >= 60) {
                        idleInfo = '\n' + this._t('sys.userIdle').replace('{0}', idleSec);
                    }
                } catch (e) {}
            }

            // Pet window position (for self-identification in screenshots)
            let petPosInfo = '';
            if (window.electronAPI?.getWindowBounds) {
                try {
                    const pb = await window.electronAPI.getWindowBounds();
                    if (pb) {
                        petPosInfo = '\n' + this._t('sys.petPosition')
                            .replace('{x}', pb.x).replace('{y}', pb.y)
                            .replace('{w}', pb.width).replace('{h}', pb.height);
                    }
                } catch (e) {}
            }

            // Build fresh system prompt with dynamic context
            let metaInfo = '';
            if (this.emotionSystem) {
                const nextEmotion = this.emotionSystem.nextEmotionBuffer;
                if (nextEmotion) {
                    metaInfo += '\n' + this._t('sys.toneHint').replace('{0}', nextEmotion);
                }
            }
            metaInfo += idleInfo + petPosInfo + layoutSummary;
            const dynamicContext = this.buildDynamicContext() + metaInfo;
            const currentSystemPrompt = this.promptBuilder.buildSystemPrompt(dynamicContext);

            const boundsInfo = bounds ? ` [${bounds.width}x${bounds.height}]` : '';
            const hitContext = this._buildHitContext();
            const textPrompt = this.promptBuilder.getAppDetectionPrompt(this._shortenTitle(appName, 50) + boundsInfo) + hitContext;

            // Gather visual context.
            //
            // 画面由识屏流水线（see-now）供给：后台常驻采集、按变化量筛帧、
            // 攒成多帧拼图。这里只做两件事：
            //   ① 用 tick 传来/或队列里已有的那张 sheet；
            //   ② **实在没有图就发文本请求** —— 内容聊天的价值不依赖截图，
            //      "问一句今天怎么样"不该因为屏幕没变化就答不上来。
            //
            // 旧逻辑里"没有新图就退回截一张旧的全屏"已经删掉：
            // 那等于同一块屏幕付两遍钱，模型还会对着没变的画面复读。
            const screenshots = [];
            let visionSheet = preSheet && preSheet.dataUrl ? preSheet : null;

            if (!visionSheet && this.visionClient?.available && this.visionClient.available()) {
                try {
                    const got = await this.visionClient.peek();
                    if (got && got.dataUrl) {
                        visionSheet = got;
                        this.lastScreenshotTime = now;
                    }
                } catch (e) {
                    console.log('[DEBUG:vision] peek failed:', e.message);
                }
            }
            if (visionSheet) this.lastScreenshotTime = now;

            // 注入长期记忆（增强版）
            let memoryContext = '';
            if (typeof ConversationStore !== 'undefined' && window.__chatStore) {
                try {
                    // 使用增强版的上下文（含总结+话题+偏好）
                    const enhanced = window.__chatStore.getEnhancedContext(5);
                    const todaySummary = window.__chatStore.getTodaySummary();
                    if (enhanced) {
                        memoryContext = `

[长期记忆]
${enhanced}
[今日概况] ${todaySummary}`;
                    }
                } catch (e) {}
            }

            // Build messages: system + current user message
            const messages = [
                { role: 'system', content: currentSystemPrompt + memoryContext }
            ];

            let response;
            const hasScreenshots = screenshots.length > 0;
            const hasVisionSheet = !!visionSheet;

            if (hasVisionSheet || hasScreenshots) {
                const now = new Date();
                const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
                const userContent = [
                    { type: 'text', text: `[${timeStr}] ${textPrompt}${this._t('sys.screenshotAttached')}` }
                ];
                // 新流水线的拼图：**一张图 = 一段时间里的多个变化帧**。
                // 附带每帧的时刻，模型才能说"刚才/这一会儿"而不是笼统的"现在"。
                if (hasVisionSheet) {
                    const block = this.visionClient.toContentBlock(visionSheet);
                    if (block) userContent.push(...block);
                }
                for (const shot of screenshots) {
                    userContent.push({
                        type: 'image_url',
                        image_url: { url: 'data:image/jpeg;base64,' + shot.base64 }
                    });
                }

                messages.push({ role: 'user', content: userContent });
                this._logRequestText(messages);
                response = await this.aiClient.callAPI(messages);
            } else {
                // No new screenshots — use idle prompt with timestamp
                const now = new Date();
                const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
                const idlePrompt = this.promptBuilder.getIdlePrompt();
                messages.push({ role: 'user', content: `[${timeStr}] ${idlePrompt}` });
                this._logRequestText(messages);
                response = await this.aiClient.callAPI(messages);
            }

            if (response) {
                // 记下"已经开过口"——tick 靠它决定首次启动时要不要等一张图
                this._spokeOnce = true;
                // Store response in recent pool for anti-repetition analysis
                const entry = { response, timestamp: Date.now(), analysis: null };
                this.recentPool.push(entry);
                this._analyzeResponse(entry).catch(e =>
                    console.warn('[DesktopPetSystem] Analysis failed:', e.message));

                // Double-buffer: overwrite pending with latest
                this.pendingMessage = response;
                this._processQueue();
            }

            // Clear focus tracker after each AI request
            this.focusTracker = {};

        } catch (error) {
            console.error('[DesktopPetSystem] Request failed:', error);
        } finally {
            this.isRequesting = false;
        }
    }

    /**
     * 手动发送聊天消息（来自输入框或语音识别）
     */
    async sendManualRequest(text, appName, bounds) {
        if (this.isRequesting) return;
        this.isRequesting = true;

        try {
            // 构建系统提示（含增强长期记忆）
            let memoryContext = '';
            if (typeof ConversationStore !== 'undefined' && window.__chatStore) {
                try {
                    const enhanced = window.__chatStore.getEnhancedContext(5);
                    const todaySummary = window.__chatStore.getTodaySummary();
                    if (enhanced) {
                        memoryContext = `

[长期记忆]
${enhanced}
[今日概况] ${todaySummary}`;
                    }
                } catch (e) {}
            }

            const dynamicContext = this.buildDynamicContext();
            const currentSystemPrompt = this.promptBuilder.buildSystemPrompt(dynamicContext);
            const messages = [
                {
                    role: 'system',
                    content: `你是一个可爱的桌面宠物，请用活泼、简短的方式回答。
你正在看「${appName || '桌面'}」窗口。${memoryContext}`
                },
                { role: 'user', content: text }
            ];

            this._logRequestText(messages);
            const response = await this.aiClient.callAPI(messages);

            if (response) {
                // 显示在聊天框
                if (window.__onChatReply) {
                    window.__onChatReply(response);
                }

                // 也走语音播放
                this.pendingMessage = response;
                this._processQueue();
            }
        } catch (error) {
            console.error('[DesktopPetSystem] Manual request failed:', error);
            if (window.__onChatReply) {
                window.__onChatReply('😅 刚才卡住了... ' + error.message);
            }
        } finally {
            this.isRequesting = false;
        }
    }
}

window.DesktopPetSystem = DesktopPetSystem;
