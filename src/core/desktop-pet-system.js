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

        // Enhancement orchestrator
        this.enhancer = null;
        this._showLayout = false; // desktop layout in prompt, default off

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

        // 截图频率控制
        this.screenshotInterval = 0;  // 0=跟随检测间隔
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

        // 读取截图频率配置
        try {
            const config = await window.electronAPI.loadConfig();
            if (config.screenshotInterval !== undefined) {
                this.screenshotInterval = config.screenshotInterval;
                console.log('[DesktopPetSystem] Screenshot interval:', this.screenshotInterval, 's');
            }
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

        // Enhancement orchestrator (only if master toggle enabled)
        if (typeof EnhancementOrchestrator !== 'undefined') {
            try {
                const config = await window.electronAPI.loadConfig();
                if (config.enhance?.enabled) {
                    this.enhancer = new EnhancementOrchestrator(this.aiClient);
                    await this.enhancer.init();
                }
            } catch {}
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
        // Check TTS availability
        if (window.electronAPI.ttsGetStatus) {
            try {
                const status = await window.electronAPI.ttsGetStatus();
                this.audioStateMachine.setTTSAvailable(status.initialized && !status.degraded && status.configured);
            } catch (e) {}
        }
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
                console.log('[DesktopPetSystem] Started');
            }
        } catch (error) {
            console.error('[DesktopPetSystem] Failed to start:', error);
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
        if (this.enhancer) await this.enhancer.stop();
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
            if (this.enhancer) this.enhancer.onFocusTick(windowKey);
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

        // Never interrupt something the pet is already saying.
        if (this.isPlayingMessage || this.pendingMessage) return;
        this.gameCompanion.noteFocus(win);
        if (!this.gameCompanion.shouldComment(win)) return;
        this._companionMoment(win).catch(() => {});
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
            // 默认根据截屏了解用户在干什么
            if (this.gameCompanion.useScreenshots) {
                const shot = await this._companionScreenshot(win);
                if (shot) {
                    content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + shot } });
                }
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
                // 'not-allowed' means the user denied the mic: stop retrying loudly.
                if (e && (e.error === 'not-allowed' || e.error === 'service-not-allowed')) {
                    console.log('[CompanionVoice] microphone denied; disabling voice input');
                    this.companionVoiceInput = false;
                    this._companionVoiceActive = false;
                    this._companionRecognition = null;
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
                const shot = await this._companionScreenshot(win);
                if (shot) content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + shot } });
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

    async tick() {
        console.log('[DEBUG:tick] tick start, isActive=' + this.isActive + ', isRequesting=' + this.isRequesting + ', configured=' + (this.aiClient ? this.aiClient.isConfigured() : 'no-client'));
        if (!this.isActive || this.isRequesting || !this.aiClient.isConfigured()) return;

        try {
            console.log('[DEBUG:tick] calling getActiveWindow...');
            const result = await window.electronAPI.getActiveWindow();
            console.log('[DEBUG:tick] getActiveWindow result:', JSON.stringify(result));
            if (!result?.success || !result.data?.owner?.name) {
                console.log('[DEBUG:tick] getActiveWindow failed or no owner.name');
                return;
            }

            if (this.shouldSkipApp(result.data.owner.name)) return;

            const windowTitle = result.data.title || result.data.owner.name;
            const bounds = result.data.bounds;
            this.lastAppName = windowTitle;
            await this.sendRequest(windowTitle, bounds);
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
        const mode = forceTts ? 'tts' : this.audioStateMachine.effectiveMode;

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

    async sendRequest(appName, bounds) {
        if (this.isRequesting) return;

        // 截图频率控制：如果设置了间隔且未到期，跳过截图
        const now = Date.now();
        const screenshotIntervalMs = this.screenshotInterval > 0
            ? this.screenshotInterval * 1000
            : 0;  // 0=每次检测都截图（原行为）
        const shouldScreenshot = screenshotIntervalMs === 0 ||
            (now - this.lastScreenshotTime) >= screenshotIntervalMs;

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
            // Enhancement side-effects (memory tracking)
            let enhancerMemoryContext = '';
            if (this.enhancer) {
                enhancerMemoryContext = await this.enhancer.beforeRequest(appName, null);
            }
            let metaInfo = '';
            if (this.emotionSystem) {
                const nextEmotion = this.emotionSystem.nextEmotionBuffer;
                if (nextEmotion) {
                    metaInfo += '\n' + this._t('sys.toneHint').replace('{0}', nextEmotion);
                }
            }
            metaInfo += idleInfo + petPosInfo + layoutSummary;
            // 注入增强记忆（窗口使用习惯等）
            if (enhancerMemoryContext) {
                metaInfo += '\n' + enhancerMemoryContext;
            }
            const dynamicContext = this.buildDynamicContext() + metaInfo;
            const currentSystemPrompt = this.promptBuilder.buildSystemPrompt(dynamicContext);

            const boundsInfo = bounds ? ` [${bounds.width}x${bounds.height}]` : '';
            const hitContext = this._buildHitContext();
            const textPrompt = this.promptBuilder.getAppDetectionPrompt(this._shortenTitle(appName, 50) + boundsInfo) + hitContext;

            // Gather screenshots: HQ fresh capture + one older from mipmap
            const screenshots = [];
            const maxScreenshots = 2;
            if (shouldScreenshot) {
                if (window.electronAPI?.getScreenCaptureHQ) {
                    try {
                        const result = await window.electronAPI.getScreenCaptureHQ(appName);
                        if (result?.success && result.data) {
                            screenshots.push({ base64: result.data, timestamp: Date.now(), source: 'fresh' });
                            this.lastScreenshotTime = now;
                        }
                    } catch (e) { console.log('[DEBUG:ss] HQ exception:', e.message); }
                }
                if (!screenshots.length && window.electronAPI?.getScreenCapture) {
                    try {
                        const result = await window.electronAPI.getScreenCapture();
                        if (result?.success && result.data) {
                            screenshots.push({ base64: result.data, timestamp: Date.now(), source: 'fresh' });
                            this.lastScreenshotTime = now;
                        }
                    } catch (e) { console.log('[DEBUG:ss] exception:', e.message); }
                }
            }
            if (this.enhancer?.vlmExtractor) {
                const older = this.enhancer.vlmExtractor.getScreenshotsForMainAI(1);
                for (const entry of older) {
                    if (screenshots.length > 0 && entry.base64 === screenshots[0].base64) continue;
                    // 简单的 base64 头部分析：如果前 1000 字符差不多，大概率内容重复
                    if (screenshots.length > 0) {
                        const a = screenshots[0].base64.slice(0, 1000);
                        const b = entry.base64.slice(0, 1000);
                        let diff = 0;
                        for (let i = 0; i < a.length && i < b.length; i++) {
                            if (a[i] !== b[i]) diff++;
                        }
                        // 前 1000 字符差异 < 5% → 视为重复，跳过
                        if (diff / Math.min(a.length, b.length) < 0.05) continue;
                    }
                    if (screenshots.length < maxScreenshots) screenshots.push(entry);
                }
            }

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

            // Build messages: system + optional keyframe context + current user message
            const messages = [
                { role: 'system', content: currentSystemPrompt + memoryContext }
            ];

            // Keyframe context (mid-term visual memory)
            if (this.enhancer?.vlmExtractor) {
                const keyframes = await this.enhancer.vlmExtractor.getKeyframesForMainAI(2);
                if (keyframes.length > 0) {
                    const now = Date.now();
                    const kfContent = [{ type: 'text', text: this._t('sys.kfLabel') }];
                    for (let i = 0; i < keyframes.length; i++) {
                        const kf = keyframes[i];
                        const kfTime = new Date(kf.timestamp);
                        const kfTimeStr = `${kfTime.getHours()}:${String(kfTime.getMinutes()).padStart(2, '0')}`;
                        const ageSec = Math.round((now - kf.timestamp) / 1000);
                        const ageStr = ageSec < 60 ? `${ageSec}s` : `${Math.round(ageSec / 60)}min`;
                        const shortTitle = this._shortenTitle(kf.title, 25);
                        kfContent.push(
                            { type: 'text', text: this._t('sys.kfEntry').replace('{0}', i + 1).replace('{1}', kfTimeStr).replace('{2}', shortTitle).replace('{3}', ageStr) },
                            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + kf.base64 } }
                        );
                    }
                    messages.push({ role: 'user', content: kfContent });
                    messages.push({ role: 'assistant', content: this._t('sys.kfAck') });
                }
            }

            let response;
            const hasScreenshots = screenshots.length > 0;

            if (hasScreenshots) {
                const now = new Date();
                const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
                const userContent = [
                    { type: 'text', text: `[${timeStr}] ${textPrompt}${this._t('sys.screenshotAttached')}` }
                ];
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
