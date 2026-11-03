/**
 * 验证「回复频率」与识屏流水线的配合：**没有新画面就不发请求**。
 *
 * 这是改造后的核心行为：画面由 vision 后台采集按变化量筛帧，
 * 慢循环只负责消费。静止屏幕应该安静，而不是对着同一张图反复烧 token。
 *
 * Run with: node --test tests/test-tick-gating.js
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert');

/** 最小化的 window.electronAPI 桩件 */
const calls = { peek: 0, grab: 0 };

function setupGlobals() {
    global.window = {
        electronAPI: {
            getActiveWindow: async () => ({
                success: true,
                data: {
                    title: 'Visual Studio Code',
                    owner: { name: 'Code.exe' },
                    bounds: { width: 1200, height: 800 },
                },
            }),
            loadConfig: async () => ({
                vision: { enabled: true, pace: 'normal' },
                tts: { audioMode: 'tts' },
            }),
            ttsGetStatus: async () => ({ initialized: true, degraded: false, configured: true }),
            loadDefaultAudio: async () => ({ success: true, files: [] }),
            ttsSynthesize: async () => ({ success: false }),
            showSettings: () => {},
        },
    };
}

describe('tick gating: only speak when the screen changed', () => {
    let DPS;

    before(() => {
        setupGlobals();
        for (const f of ['prompt-builder', 'emotion-system', 'audio-state-machine', 'message-session',
            'conversation-store', 'game-companion', 'live-companion', 'desktop-pet-system']) {
            require(`../src/core/${f}`);
        }
        DPS = global.window.DesktopPetSystem;
    });

    /** 造一个只测 tick 决策的系统实例 */
    function makeSystem({ peekResult, grabResult = null }) {
        const sys = new DPS();
        sys.isActive = true;
        sys.aiClient = { isConfigured: () => true };
        sys.promptBuilder = { _t: (k) => k };
        sys._sent = [];
        // 拦截"真的去问模型"这一步，只记录有没有发生
        sys.sendRequest = async (title, bounds, sheet) => { sys._sent.push({ title, sheet }); };
        sys.visionClient = {
            available: () => true,
            peek: async () => { calls.peek += 1; return peekResult; },
            grab: async () => { calls.grab += 1; return grabResult; },
        };
        return sys;
    }

    it('speaks when a sheet is already queued', async () => {
        const sys = makeSystem({ peekResult: { dataUrl: 'data:image/png;base64,AAA', frames: [] } });
        sys._spokeOnce = true;
        await sys.tick();
        assert.strictEqual(sys._sent.length, 1, 'should ask the model once');
        assert.ok(sys._sent[0].sheet && sys._sent[0].sheet.dataUrl, 'the sheet must be passed through');
    });

    it('stays silent when there is no new frame (this is the whole point)', async () => {
        const sys = makeSystem({ peekResult: null });
        sys._spokeOnce = true;
        sys.gameCompanion = { enabled: false };
        await sys.tick();
        assert.strictEqual(sys._sent.length, 0, 'a still screen must not cost tokens');
    });

    it('waits for a first frame on startup so the pet can say hello', async () => {
        const sys = makeSystem({
            peekResult: null,
            grabResult: { ok: true, dataUrl: 'data:image/png;base64,BBB', frames: [] },
        });
        sys._spokeOnce = false;
        await sys.tick();
        assert.strictEqual(sys._sent.length, 1, 'the first run should wait for a frame');
    });

    it('does not fall back to a stale screenshot when no frame arrives', async () => {
        // 旧逻辑会"拿不到新图就截一张旧的照样发"，那是同一块屏幕付两遍钱
        const sys = makeSystem({ peekResult: null, grabResult: null });
        sys._spokeOnce = false;
        await sys.tick();
        assert.strictEqual(sys._sent.length, 0, 'must not send a text request with an old picture');
    });

    it('does nothing when the pet is inactive', async () => {
        const sys = makeSystem({ peekResult: { dataUrl: 'data:image/png;base64,AAA' } });
        sys.isActive = false;
        await sys.tick();
        assert.strictEqual(sys._sent.length, 0);
    });

    it('does nothing while a request is already in flight', async () => {
        const sys = makeSystem({ peekResult: { dataUrl: 'data:image/png;base64,AAA' } });
        sys.isRequesting = true;
        await sys.tick();
        assert.strictEqual(sys._sent.length, 0);
    });

    it('skips its own windows (the pet must not watch itself)', async () => {
        const sys = makeSystem({ peekResult: { dataUrl: 'data:image/png;base64,AAA' } });
        global.window.electronAPI.getActiveWindow = async () => ({
            success: true,
            data: { title: 'Live2DPet', owner: { name: 'desktop-pet' }, bounds: { width: 300, height: 300 } },
        });
        await sys.tick();
        assert.strictEqual(sys._sent.length, 0, 'shouldSkipApp must reject our own window');
        // 还原
        global.window.electronAPI.getActiveWindow = async () => ({
            success: true,
            data: {
                title: 'Visual Studio Code',
                owner: { name: 'Code.exe' },
                bounds: { width: 1200, height: 800 },
            },
        });
    });
});
