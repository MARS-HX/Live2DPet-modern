/**
 * ConfigManager — Configuration persistence, migration, and defaults.
 * Extracted from main.js lines 21-178.
 */
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { encrypt, decrypt } = require('./crypto-utils');

const CURRENT_CONFIG_VERSION = 1;
const ENCRYPTED_FIELDS = ['apiKey', 'translation.apiKey', 'enhance.search.customApiKey'];

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
        enhance: {
            enabled: false,
            memory: { enabled: true, retentionDays: 30 },
            search: { enabled: false, provider: 'custom', customUrl: '', customApiKey: '', maxFrequencyMs: 30000, minFocusSeconds: 10 },
            knowledge: { enabled: false, minIntervalMs: 60000, maxIntervalMs: 3600000 },
            vlm: { enabled: false, baseIntervalMs: 15000, maxIntervalMs: 60000, minFocusSeconds: 10 },
            knowledgeAcq: { enabled: false, minFocusSeconds: 60, termCooldownMs: 3600000, maxTermsPerTopic: 15, maxSearchesPerRequest: 2, retentionDays: 30 }
        }
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
    }

    function encryptFields(config) {
        if (config.apiKey) config.apiKey = _encrypt(config.apiKey);
        if (config.translation?.apiKey) config.translation.apiKey = _encrypt(config.translation.apiKey);
        if (config.enhance?.search?.customApiKey) config.enhance.search.customApiKey = _encrypt(config.enhance.search.customApiKey);
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
                enhance: {
                    ...defaults.enhance,
                    ...(raw.enhance || {}),
                    memory: { ...defaults.enhance.memory, ...((raw.enhance || {}).memory || {}) },
                    search: { ...defaults.enhance.search, ...((raw.enhance || {}).search || {}) },
                    knowledge: { ...defaults.enhance.knowledge, ...((raw.enhance || {}).knowledge || {}) },
                    vlm: { ...defaults.enhance.vlm, ...((raw.enhance || {}).vlm || {}) },
                    knowledgeAcq: { ...defaults.enhance.knowledgeAcq, ...((raw.enhance || {}).knowledgeAcq || {}) }
                }
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
            if (data.enhance) {
                merged.enhance = { ...(existing.enhance || {}), ...data.enhance };
                if (data.enhance.memory) merged.enhance.memory = { ...(existing.enhance?.memory || {}), ...data.enhance.memory };
                if (data.enhance.search) merged.enhance.search = { ...(existing.enhance?.search || {}), ...data.enhance.search };
                if (data.enhance.knowledge) merged.enhance.knowledge = { ...(existing.enhance?.knowledge || {}), ...data.enhance.knowledge };
                if (data.enhance.vlm) merged.enhance.vlm = { ...(existing.enhance?.vlm || {}), ...data.enhance.vlm };
                if (data.enhance.knowledgeAcq) merged.enhance.knowledgeAcq = { ...(existing.enhance?.knowledgeAcq || {}), ...data.enhance.knowledgeAcq };
            }
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
    migrateConfig,
    CURRENT_CONFIG_VERSION
};
