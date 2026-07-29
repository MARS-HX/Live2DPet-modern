/**
 * Unit tests for ConfigManager + i18n Helper
 * Run with: node --test tests/test-config-manager.js
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
    createConfigManager,
    getDefaultConfig,
    getDefaultModelConfig,
    migrateConfig,
    CURRENT_CONFIG_VERSION
} = require('../src/main/config-manager');
const { createI18nHelper } = require('../src/main/i18n-helper');
const { isEncrypted } = require('../src/main/crypto-utils');

describe('getDefaultConfig', () => {
    it('returns object with configVersion', () => {
        assert.strictEqual(getDefaultConfig().configVersion, CURRENT_CONFIG_VERSION);
    });

    it('has all required top-level fields', () => {
        const config = getDefaultConfig();
        for (const key of ['apiKey', 'baseURL', 'modelName', 'interval',
            'chatGap', 'emotionFrequency', 'enabledEmotions',
            'maxTokensMultiplier', 'model', 'bubble', 'enhance']) {
            assert.ok(key in config, `missing field: ${key}`);
        }
    });

    it('has complete enhance sub-sections', () => {
        const config = getDefaultConfig();
        for (const s of ['memory', 'search', 'knowledge', 'vlm', 'knowledgeAcq']) {
            assert.ok(s in config.enhance, `missing enhance.${s}`);
        }
    });
});

describe('getDefaultModelConfig', () => {
    it('has correct paramMapping keys', () => {
        const model = getDefaultModelConfig();
        for (const k of ['angleX', 'angleY', 'angleZ', 'bodyAngleX', 'eyeBallX', 'eyeBallY']) {
            assert.ok(k in model.paramMapping, `missing paramMapping.${k}`);
            assert.strictEqual(model.paramMapping[k], null);
        }
    });

    it('defaults to type none', () => {
        assert.strictEqual(getDefaultModelConfig().type, 'none');
    });
});

describe('migrateConfig', () => {
    it('does not touch current version', () => {
        const result = migrateConfig({ configVersion: CURRENT_CONFIG_VERSION, apiKey: 'test' });
        assert.strictEqual(result.apiKey, 'test');
        assert.strictEqual(result.configVersion, CURRENT_CONFIG_VERSION);
    });

    it('upgrades v0 (no version) to v1', () => {
        assert.strictEqual(migrateConfig({ apiKey: 'old' }).configVersion, CURRENT_CONFIG_VERSION);
    });

    it('adds model section if missing', () => {
        const result = migrateConfig({});
        assert.ok(result.model);
        assert.strictEqual(result.model.type, 'none');
    });

    it('clears old hardcoded emotions', () => {
        assert.deepStrictEqual(migrateConfig({ enabledEmotions: ['happy', 'sad'] }).enabledEmotions, []);
    });

    it('preserves existing API settings', () => {
        const result = migrateConfig({ apiKey: 'sk-123', baseURL: 'https://custom.api/v1' });
        assert.strictEqual(result.apiKey, 'sk-123');
        assert.strictEqual(result.baseURL, 'https://custom.api/v1');
    });
});

describe('createConfigManager (async)', () => {
    const BASE = path.resolve('/mock/app');
    const USER_DATA = path.resolve('/mock/userData');
    let files, mockApp, cm;

    function cfgPath(base) { return path.join(base, 'config.json'); }

    function mockOpts(extraFiles = {}) {
        files = { ...extraFiles };
        return {
            basePath: BASE,
            readFile: async (p) => {
                if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
                return files[p];
            },
            writeFile: async (p, d) => { files[p] = d; },
            exists: async (p) => p in files
        };
    }

    beforeEach(() => {
        mockApp = { isPackaged: false, getPath: () => USER_DATA };
    });

    it('loadConfigFile returns defaults when no file exists', async () => {
        cm = createConfigManager(mockApp, mockOpts());
        const config = await cm.loadConfigFile();
        assert.strictEqual(config.configVersion, CURRENT_CONFIG_VERSION);
        assert.strictEqual(config.apiKey, '');
    });

    it('loadConfigFile merges saved config with defaults', async () => {
        cm = createConfigManager(mockApp, mockOpts({ [cfgPath(BASE)]: JSON.stringify({ apiKey: 'sk-test', interval: 60 }) }));
        const config = await cm.loadConfigFile();
        assert.strictEqual(config.apiKey, 'sk-test');
        assert.strictEqual(config.interval, 60);
        assert.strictEqual(config.baseURL, 'https://openrouter.ai/api/v1');
        assert.ok(config.model);
    });

    it('loadConfigFile applies env var overrides', async () => {
        process.env.LIVE2DPET_API_KEY = 'env-key';
        try {
            cm = createConfigManager(mockApp, mockOpts());
            assert.strictEqual((await cm.loadConfigFile()).apiKey, 'env-key');
        } finally {
            delete process.env.LIVE2DPET_API_KEY;
        }
    });

    it('saveConfigFile deep-merges model section', async () => {
        cm = createConfigManager(mockApp, mockOpts({ [cfgPath(BASE)]: JSON.stringify({ model: { type: 'live2d', folderPath: '/m' } }) }));
        await cm.saveConfigFile({ model: { type: 'image' } });
        const saved = JSON.parse(files[cfgPath(BASE)]);
        assert.strictEqual(saved.model.type, 'image');
        assert.strictEqual(saved.model.folderPath, '/m');
    });

    it('saveConfigFile deep-merges tts section', async () => {
        cm = createConfigManager(mockApp, mockOpts({ [cfgPath(BASE)]: JSON.stringify({ tts: { audioMode: 'tts', vvmFiles: ['0.vvm'], styleId: 3 } }) }));
        await cm.saveConfigFile({ tts: { styleId: 5 } });
        const saved = JSON.parse(files[cfgPath(BASE)]);
        assert.strictEqual(saved.tts.styleId, 5);
        assert.strictEqual(saved.tts.audioMode, 'tts');
        assert.deepStrictEqual(saved.tts.vvmFiles, ['0.vvm']);
    });

    it('saveConfigFile deep-merges enhance sub-sections', async () => {
        cm = createConfigManager(mockApp, mockOpts({ [cfgPath(BASE)]: JSON.stringify({ enhance: { memory: { enabled: true, retentionDays: 30 } } }) }));
        await cm.saveConfigFile({ enhance: { memory: { retentionDays: 7 } } });
        const saved = JSON.parse(files[cfgPath(BASE)]);
        assert.strictEqual(saved.enhance.memory.retentionDays, 7);
        assert.strictEqual(saved.enhance.memory.enabled, true);
    });

    it('saveConfigFile writes valid JSON', async () => {
        cm = createConfigManager(mockApp, mockOpts());
        await cm.saveConfigFile({ apiKey: 'test' });
        assert.doesNotThrow(() => JSON.parse(files[cfgPath(BASE)]));
    });

    it('saveConfigFile returns true on success', async () => {
        cm = createConfigManager(mockApp, mockOpts());
        assert.strictEqual(await cm.saveConfigFile({ apiKey: 'test' }), true);
    });

    it('loadConfigFile reads from userData in packaged mode', async () => {
        mockApp.isPackaged = true;
        cm = createConfigManager(mockApp, mockOpts({ [cfgPath(USER_DATA)]: JSON.stringify({ apiKey: 'packaged-key' }) }));
        assert.strictEqual((await cm.loadConfigFile()).apiKey, 'packaged-key');
    });

    it('saveConfigFile encrypts API keys on disk', async () => {
        cm = createConfigManager(mockApp, mockOpts());
        await cm.saveConfigFile({ apiKey: 'sk-secret-123' });
        const raw = JSON.parse(files[cfgPath(BASE)]);
        assert.ok(isEncrypted(raw.apiKey), 'apiKey should be encrypted on disk');
    });

    it('loadConfigFile decrypts API keys transparently', async () => {
        cm = createConfigManager(mockApp, mockOpts());
        await cm.saveConfigFile({ apiKey: 'sk-secret-456' });
        const config = await cm.loadConfigFile();
        assert.strictEqual(config.apiKey, 'sk-secret-456');
    });

    it('loadConfigFile handles old plaintext API keys (backward compat)', async () => {
        cm = createConfigManager(mockApp, mockOpts({ [cfgPath(BASE)]: JSON.stringify({ apiKey: 'sk-old-plaintext' }) }));
        assert.strictEqual((await cm.loadConfigFile()).apiKey, 'sk-old-plaintext');
    });
});

describe('createI18nHelper', () => {
    it('returns key itself for unknown key', () => {
        const { mt } = createI18nHelper({ _cachedLang: 'en' });
        assert.strictEqual(mt('nonexistent.key'), 'nonexistent.key');
    });

    it('switching language changes output', () => {
        const ctx = { _cachedLang: 'en' };
        const { mt } = createI18nHelper(ctx);
        const en = mt('tray.quit');
        ctx._cachedLang = 'zh';
        const zh = mt('tray.quit');
        assert.strictEqual(typeof en, 'string');
        assert.strictEqual(typeof zh, 'string');
    });

    it('falls back to en for missing locale', () => {
        const { mt } = createI18nHelper({ _cachedLang: 'xx' });
        const result = mt('tray.quit');
        assert.strictEqual(typeof result, 'string');
        assert.notStrictEqual(result, 'tray.quit');
    });
});
