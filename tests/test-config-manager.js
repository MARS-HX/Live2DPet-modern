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

    it('includes the DSH bridge defaults', () => {
        const dsh = getDefaultConfig().dsh;
        assert.ok(dsh, 'missing dsh section');
        assert.strictEqual(dsh.enabled, true);
        assert.strictEqual(dsh.profile, 'headless');
        assert.strictEqual(dsh.workspace, '');
        assert.ok(dsh.timeoutMs > 0);
        assert.strictEqual(dsh.speakResult, true);
    });

    it('includes the game companion defaults', () => {
        const c = getDefaultConfig().companion;
        assert.ok(c, 'missing companion section');
        assert.strictEqual(c.enabled, false);
        assert.strictEqual(c.gameOnly, true);
        assert.ok(c.commentIntervalMs >= 30000);
        assert.deepStrictEqual(c.gamePatterns, []);
        assert.strictEqual(c.voiceInput, true, 'voice input is on by default');
        assert.strictEqual(c.useScreenshots, true, 'screenshot awareness is on by default');
    });

    it('includes the Bilibili danmaku defaults', () => {
        const b = getDefaultConfig().bilibili;
        assert.ok(b, 'missing bilibili section');
        assert.strictEqual(b.enabled, false);
        assert.strictEqual(b.roomId, '');
        assert.strictEqual(b.mode, 'question');
        assert.ok(b.replyIntervalMs >= 3000);
        assert.deepStrictEqual(b.replyTypes, ['danmaku', 'superchat']);
    });

    it('no longer ships the removed OBS capture-window section', () => {
        // Replaced by Game Capture guidance in the UI; the separate chroma
        // window duplicated rendering and blocked the screen.
        assert.strictEqual(getDefaultConfig().capture, undefined);
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

    it('saveConfigFile deep-merges the dsh section', async () => {
        cm = createConfigManager(mockApp, mockOpts({ [cfgPath(BASE)]: JSON.stringify({ dsh: { enabled: true, profile: 'headless', timeoutMs: 600000 } }) }));
        await cm.saveConfigFile({ dsh: { workspace: 'E:/code' } });
        const saved = JSON.parse(files[cfgPath(BASE)]);
        assert.strictEqual(saved.dsh.workspace, 'E:/code');
        assert.strictEqual(saved.dsh.profile, 'headless', 'untouched keys survive the merge');
        assert.strictEqual(saved.dsh.timeoutMs, 600000);
    });

    it('saveConfigFile deep-merges the companion section', async () => {
        cm = createConfigManager(mockApp, mockOpts({ [cfgPath(BASE)]: JSON.stringify({ companion: { enabled: true, gameOnly: true } }) }));
        await cm.saveConfigFile({ companion: { commentIntervalMs: 300000 } });
        const saved = JSON.parse(files[cfgPath(BASE)]);
        assert.strictEqual(saved.companion.commentIntervalMs, 300000);
        assert.strictEqual(saved.companion.enabled, true);
    });

    it('loadConfigFile fills in missing dsh defaults', async () => {
        cm = createConfigManager(mockApp, mockOpts({ [cfgPath(BASE)]: JSON.stringify({ dsh: { workspace: 'E:/code' } }) }));
        const cfg = await cm.loadConfigFile();
        assert.strictEqual(cfg.dsh.workspace, 'E:/code');
        assert.strictEqual(cfg.dsh.profile, 'headless', 'default fills the gap');
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

    it('一个字段解不开密时，不会把整份配置重置成默认值', async () => {
        // 真实触发：config.json 从别的机器拷过来，或改过 Windows 主机名/用户名
        // —— 解密密钥由这两者派生，密文于是解不开（GCM 校验失败会抛）。
        const broken = {
            apiKey: 'enc:v1:00:00:00',
            modelName: 'my-model',
            characters: [{ id: 'c1' }],
            obs: { browserSource: { enabled: true, port: 4242 } }
        };
        cm = createConfigManager(mockApp, mockOpts({ [cfgPath(BASE)]: JSON.stringify(broken) }));
        const cfg = await cm.loadConfigFile();
        assert.strictEqual(cfg.modelName, 'my-model', '模型名不该被默认值顶掉');
        assert.deepStrictEqual(cfg.characters, [{ id: 'c1' }], '角色卡不该丢');
        assert.strictEqual(cfg.obs.browserSource.port, 4242, 'OBS 端口不该被重置');
    });

    it('解不开密之后写盘，也不会抹掉其它设置，且密文原样保留', async () => {
        const broken = { apiKey: 'enc:v1:00:00:00', modelName: 'my-model', characters: [{ id: 'c1' }] };
        cm = createConfigManager(mockApp, mockOpts({ [cfgPath(BASE)]: JSON.stringify(broken) }));
        // character-manager / bilibili-ipc 就是这种「只写一小块」的调用
        await cm.saveConfigFile({ bilibili: { roomId: '111' } });
        const saved = JSON.parse(files[cfgPath(BASE)]);
        assert.strictEqual(saved.modelName, 'my-model');
        assert.deepStrictEqual(saved.characters, [{ id: 'c1' }]);
        assert.strictEqual(saved.bilibili.roomId, '111');
        assert.strictEqual(saved.apiKey, 'enc:v1:00:00:00',
            '解不开的密文要原样留着（对原机器仍可恢复），不能被再包一层');
    });

    it('反复读写不会把 API Key 层层包裹', async () => {
        cm = createConfigManager(mockApp, mockOpts());
        await cm.saveConfigFile({ apiKey: 'sk-once' });
        await cm.saveConfigFile({ interval: 30 });
        assert.strictEqual((await cm.loadConfigFile()).apiKey, 'sk-once',
            '第二次写盘后仍应解回原文，而不是解出一层密文');
    });

    it('saveConfigFile 合并 browserSource，而不是整段替换', async () => {
        cm = createConfigManager(mockApp, mockOpts({
            [cfgPath(BASE)]: JSON.stringify({
                obs: { browserSource: { enabled: true, port: 4242, transform: { scale: 2, x: 10, y: 20 } } }
            })
        }));

        // 启停服务器时 obs-ipc 只写 enabled/port
        await cm.saveConfigFile({ obs: { browserSource: { enabled: true, port: 4243 } } });
        let saved = JSON.parse(files[cfgPath(BASE)]);
        assert.strictEqual(saved.obs.browserSource.port, 4243);
        assert.deepStrictEqual(saved.obs.browserSource.transform, { scale: 2, x: 10, y: 20 },
            '启停服务器不该清掉用户调好的位置与大小');

        // 拖动 OBS 缩放时只写 transform
        await cm.saveConfigFile({ obs: { browserSource: { transform: { scale: 1.5, x: 1, y: 2 } } } });
        saved = JSON.parse(files[cfgPath(BASE)]);
        assert.strictEqual(saved.obs.browserSource.enabled, true, '改缩放不该丢掉 enabled');
        assert.strictEqual(saved.obs.browserSource.port, 4243, '改缩放不该丢掉 port');
        assert.strictEqual(saved.obs.browserSource.transform.scale, 1.5);
    });

    it('loadConfigFile 给 browserSource 补齐默认值而不是整段替换', async () => {
        cm = createConfigManager(mockApp, mockOpts({
            [cfgPath(BASE)]: JSON.stringify({ obs: { browserSource: { port: 5000 } } })
        }));
        const cfg = await cm.loadConfigFile();
        assert.strictEqual(cfg.obs.browserSource.port, 5000);
        assert.strictEqual(cfg.obs.browserSource.enabled, true, '缺的字段要由默认值补上');
        assert.deepStrictEqual(cfg.obs.browserSource.transform, { scale: 1, x: 0, y: 0 });
    });

    it('并发写盘不会互相覆盖（回归：读-改-写跨越多个 await，没有串行化）', async () => {
        // 真实场景：拖 OBS 缩放滑杆触发 obs-transform-set 的同时，
        // TTS 默认音频生成完成触发保存 —— 后写者基于同一份旧快照，前者的字段被丢弃。
        const slowFiles = { [cfgPath(BASE)]: JSON.stringify({ interval: 10 }) };
        const slowOpts = {
            basePath: BASE,
            readFile: async (p) => {
                await new Promise((r) => setTimeout(r, 5));
                if (!(p in slowFiles)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
                return slowFiles[p];
            },
            writeFile: async (p, d) => {
                await new Promise((r) => setTimeout(r, 5));
                slowFiles[p] = d;
            },
            exists: async (p) => p in slowFiles,
        };
        const cm2 = createConfigManager(mockApp, slowOpts);

        await Promise.all([
            cm2.saveConfigFile({ interval: 30 }),
            cm2.saveConfigFile({ chatGap: 9 }),
        ]);

        const saved = JSON.parse(slowFiles[cfgPath(BASE)]);
        assert.strictEqual(saved.interval, 30, '先发起的写盘不该被后发起的覆盖');
        assert.strictEqual(saved.chatGap, 9, '两次并发写都必须落地');
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
        // 只断言 typeof 的话，一个完全忽略 _cachedLang 的实现也能通过这一组用例。
        assert.notStrictEqual(en, zh, '切换语言必须真的换掉文案');
        assert.strictEqual(en, 'Quit');
        assert.strictEqual(zh, '退出');
    });

    it('falls back to en for missing locale', () => {
        const { mt } = createI18nHelper({ _cachedLang: 'xx' });
        const result = mt('tray.quit');
        assert.strictEqual(typeof result, 'string');
        assert.notStrictEqual(result, 'tray.quit');
    });
});
