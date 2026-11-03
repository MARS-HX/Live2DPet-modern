/**
 * ConfigManager — Configuration persistence, migration, and defaults.
 * Extracted from main.js lines 21-178.
 */
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { encrypt, decrypt } = require('./crypto-utils');

const CURRENT_CONFIG_VERSION = 1;
// 需要加解密落盘的字段。
//
// 注意 `enhance.search.customApiKey` 是**历史字段**：增强层已删除，
// 但老用户的 config.json 里可能还留着这一项的密文。留着它在列表里、
// 并保留下面对应的加解密代码，是为了让旧配置能正常读出来 ——
// 直接不管的话，界面上会把 Base64 密文当成 API Key 显示。
const ENCRYPTED_FIELDS = ['apiKey', 'translation.apiKey', 'enhance.search.customApiKey', 'bilibili.cookie'];

function getDefaultModelConfig() {
    return {
        type: 'none',
        folderPath: null,
        modelJsonFile: null,
        copyToUserData: true,
        userDataModelPath: null,
        staticImagePath: null,
        bottomAlignOffset: 0.5,
        gifExpressions: {},
        paramMapping: {
            angleX: null, angleY: null, angleZ: null,
            bodyAngleX: null, eyeBallX: null, eyeBallY: null
        },
        hasExpressions: false,
        expressions: [],
        expressionDurations: {},
        defaultExpressionDuration: 5000,
        canvasYRatio: 0.60
    };
}

function getDefaultConfig() {
    return {
        configVersion: CURRENT_CONFIG_VERSION,
        apiKey: '',
        baseURL: 'https://openrouter.ai/api/v1',
        modelName: 'x-ai/grok-4.1-fast',
        interval: 10,
        chatGap: 5,
        emotionFrequency: 30,
        enabledEmotions: [],
        maxTokensMultiplier: 1.0,
        model: getDefaultModelConfig(),
        bubble: { frameImagePath: null },
        appIcon: null,
        // 注：原先的 `enhance` 配置块（memory / search / knowledge / vlm / knowledgeAcq）
        // 已随增强层一起移除。画面相关的职责由 `vision` 接管；
        // 长期记忆改由 `enhance-data.json` 承载（见 src/main/enhance-ipc.js）。
        // DeepSeek Harness bridge: drive `dsh` from the pet.
        dsh: getDefaultDshConfig(),
        // Game companion: let the pet watch and accompany gameplay.
        companion: getDefaultCompanionConfig(),
        // Bilibili live danmaku: let the pet react to a live room's chat.
        bilibili: getDefaultBilibiliConfig(),
        // OBS compatibility mode: makes the pet window readable by OBS.
        obs: getDefaultObsConfig(),
        // 识屏流水线：按画面变化量筛帧，多帧拼进一张图交模型。
        vision: getDefaultVisionConfig()
    };
}

function getDefaultVisionConfig() {
    return {
        // 关掉就退回旧的"定时截一张全屏"行为
        enabled: true,
        // 清晰度：low(800×450) / standard(1066×600) / high(1280×720) / ultra(1600×900)
        quality: 'low',
        // 节奏：calm / normal / dense / action —— 只改"多久算变了"和"多久看一次"
        pace: 'normal',
        // 逐场景：一张图只装一个画面、铺满，每换一次画面单独出图
        scene: false,
        // 停采集后留多久宽限（期间再要看不用重新冷启动）
        graceSec: 60,
        // 少于这么多帧的图不交出去（省 token）
        minFrames: 1,
        // ffmpeg 路径；空 = 自动找
        ffmpegPath: '',
        // 采集帧率
        fps: 12,
        // 后台常驻唤醒间隔（秒）；null = 跟着 pace 走
        wakeIntervalSec: null,
        // 主动搭话时是否带一句"这段时间发生了什么"
        speakPreview: true
    };
}

function getDefaultObsConfig() {
    return {
        // Chromium bypasses the Windows GDI, so OBS captures a black rectangle.
        // Turning off GPU compositing puts it back on a capturable path.
        // Needs an app restart; costs some rendering performance.
        compatible: false,
        // Browser Source: OBS renders the pet itself, so no window capture is
        // involved and transparency works properly. This is the reliable path.
        browserSource: {
            enabled: true,
            port: 0,           // 0 = pick a free port automatically
            // Where the pet sits inside the source rectangle, and how big it is.
            // OBS moves the rectangle; this moves the pet within it.
            transform: { scale: 1, x: 0, y: 0 }
        }
    };
}

function getDefaultBilibiliConfig() {
    return {
        enabled: false,
        roomId: '',               // bare id or a live URL
        roomTitle: '',
        mode: 'question',         // all | question | mention | none
        replyIntervalMs: 15000,   // global pacing between replies
        userCooldownMs: 60000,    // one viewer cannot monopolise the pet
        minLength: 2,
        ignoreList: [],
        mentions: [],             // names that always get a reply
        replyTypes: ['danmaku', 'superchat'],
        floodWindowMs: 8000,      // burst window for identical text
        floodUserThreshold: 4,    // distinct viewers that make it a flood
        cookie: '',               // optional SESSDATA/Cookie for a logged-in handshake
        lastError: null
    };
}

function getDefaultDshConfig() {
    return {
        enabled: true,
        profile: 'headless',
        workspace: '',            // '' = user's home directory
        timeoutMs: 600000,        // 10 minutes
        script: '',               // explicit path to dsh lib/bin.js when auto-detect fails
        extraArgs: [],
        speakResult: true         // read the final answer through TTS
    };
}

function getDefaultCompanionConfig() {
    return {
        enabled: false,
        gameOnly: true,           // only react while a game window is focused
        commentIntervalMs: 120000,
        gamePatterns: [],         // extra window-title substrings treated as games
        offerDshHelp: true,       // allow escalating a stuck moment to DSH
        useScreenshots: true,     // look at the screen to know what is happening
        voiceInput: true          // hands-free voice input while accompanying
    };
}

function migrateConfig(config) {
    if (config.configVersion >= CURRENT_CONFIG_VERSION) return config;
    if (!config.configVersion) {
        config.configVersion = CURRENT_CONFIG_VERSION;
        if (!config.model) config.model = getDefaultModelConfig();
        if (!config.bubble) config.bubble = { frameImagePath: null };
        if (config.appIcon === undefined) config.appIcon = null;
        if (Array.isArray(config.enabledEmotions) && config.enabledEmotions.length > 0) {
            config.enabledEmotions = [];
        }
    }
    return config;
}

function createConfigManager(app, options = {}) {
    const _encrypt = options.encrypt || encrypt;
    const _decrypt = options.decrypt || decrypt;
    const basePath = options.basePath || path.join(__dirname, '..', '..');

    // Async fs operations (injectable for testing)
    const _readFile = options.readFile || ((p) => fsp.readFile(p, 'utf-8'));
    const _writeFile = options.writeFile || ((p, d) => fsp.writeFile(p, d, 'utf-8'));
    const _exists = options.exists || ((p) => fsp.access(p).then(() => true).catch(() => false));

    function decryptFields(config) {
        if (config.apiKey) config.apiKey = _decrypt(config.apiKey);
        if (config.translation?.apiKey) config.translation.apiKey = _decrypt(config.translation.apiKey);
        if (config.enhance?.search?.customApiKey) config.enhance.search.customApiKey = _decrypt(config.enhance.search.customApiKey);
        if (config.bilibili?.cookie) config.bilibili.cookie = _decrypt(config.bilibili.cookie);
    }

    function encryptFields(config) {
        if (config.apiKey) config.apiKey = _encrypt(config.apiKey);
        if (config.translation?.apiKey) config.translation.apiKey = _encrypt(config.translation.apiKey);
        if (config.enhance?.search?.customApiKey) config.enhance.search.customApiKey = _encrypt(config.enhance.search.customApiKey);
        if (config.bilibili?.cookie) config.bilibili.cookie = _encrypt(config.bilibili.cookie);
    }

    const bundledConfigPath = path.join(basePath, 'config.json');
    const userConfigPath = app.isPackaged
        ? path.join(app.getPath('userData'), 'config.json')
        : path.join(basePath, 'config.json');

    async function loadConfigFile() {
        try {
            let raw = {};
            if (await _exists(userConfigPath)) {
                raw = JSON.parse(await _readFile(userConfigPath));
            } else if (app.isPackaged && await _exists(bundledConfigPath)) {
                raw = JSON.parse(await _readFile(bundledConfigPath));
            }
            const defaults = getDefaultConfig();
            const merged = {
                ...defaults,
                ...raw,
                model: { ...defaults.model, ...(raw.model || {}), paramMapping: { ...defaults.model.paramMapping, ...((raw.model || {}).paramMapping || {}) } },
                bubble: { ...defaults.bubble, ...(raw.bubble || {}) },
                tts: { ...(defaults.tts || {}), ...(raw.tts || {}) },
                dsh: { ...defaults.dsh, ...(raw.dsh || {}) },
                companion: { ...defaults.companion, ...(raw.companion || {}) },
                bilibili: { ...defaults.bilibili, ...(raw.bilibili || {}) },
                obs: { ...defaults.obs, ...(raw.obs || {}) },
                vision: { ...defaults.vision, ...(raw.vision || {}) }
            };
            if (process.env.LIVE2DPET_API_KEY) merged.apiKey = process.env.LIVE2DPET_API_KEY;
            if (process.env.LIVE2DPET_BASE_URL) merged.baseURL = process.env.LIVE2DPET_BASE_URL;
            if (process.env.LIVE2DPET_MODEL) merged.modelName = process.env.LIVE2DPET_MODEL;
            decryptFields(merged);
            return migrateConfig(merged);
        } catch (e) { console.warn('Failed to load config:', e.message); }
        return getDefaultConfig();
    }

    async function saveConfigFile(data) {
        try {
            const existing = await loadConfigFile();
            const merged = { ...existing, ...data };
            if (data.model) {
                merged.model = { ...existing.model, ...data.model };
                if (data.model.paramMapping) {
                    merged.model.paramMapping = { ...existing.model.paramMapping, ...data.model.paramMapping };
                }
            }
            if (data.bubble) merged.bubble = { ...existing.bubble, ...data.bubble };
            if (data.tts) merged.tts = { ...(existing.tts || {}), ...data.tts };
            if (data.translation) merged.translation = { ...(existing.translation || {}), ...data.translation };
            if (data.dsh) merged.dsh = { ...(existing.dsh || {}), ...data.dsh };
            if (data.companion) merged.companion = { ...(existing.companion || {}), ...data.companion };
            if (data.bilibili) merged.bilibili = { ...(existing.bilibili || {}), ...data.bilibili };
            if (data.obs) merged.obs = { ...(existing.obs || {}), ...data.obs };
            if (data.vision) merged.vision = { ...(existing.vision || {}), ...data.vision };
            const toWrite = JSON.parse(JSON.stringify(merged));
            encryptFields(toWrite);
            await _writeFile(userConfigPath, JSON.stringify(toWrite, null, 2));
            return true;
        } catch (e) { console.error('Failed to save config:', e.message); return false; }
    }

    return { loadConfigFile, saveConfigFile, userConfigPath, bundledConfigPath };
}

module.exports = {
    createConfigManager,
    getDefaultConfig,
    getDefaultModelConfig,
    getDefaultDshConfig,
    getDefaultCompanionConfig,
    getDefaultBilibiliConfig,
    getDefaultObsConfig,
    getDefaultVisionConfig,
    migrateConfig,
    CURRENT_CONFIG_VERSION
};
