/**
 * Integration test for the live-danmaku reply pipeline.
 *
 * Drives the real DesktopPetSystem code from a synthetic danmaku and asserts
 * the full renderer chain:
 *   danmaku → rate limiter → queue → AI → bubble + FORCED in-app TTS
 *
 * `window` is aliased to the Node global so the browser-style modules'
 * `window.X = ...` assignments become real globals, exactly like a browser.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

// ---- minimal browser environment ----
function setupEnv() {
    global.window = global;                 // window.X === global X, like a browser

    const calls = { tts: [], chat: [], talking: [], ai: [] };

    global.electronAPI = {
        loadConfig: async () => ({ bilibili: { enabled: true, mode: 'all' } }),
        saveConfig: async () => true,
        getActiveWindow: async () => ({ success: true, data: { title: 'Minecraft', owner: { name: 'javaw.exe' } } }),
        ttsSynthesize: async (text) => { calls.tts.push(text); return { success: true, wav: 'UklGRg==' }; },
        showPetChat: (text) => { calls.chat.push(text); },
        setTalkingState: (v) => { calls.talking.push(v); },
    };

    // Browser APIs used by prepareAudio / MessageSession. A real <audio> fires
    // 'loadedmetadata' on its own and 'ended' when playback finishes; the stubs
    // must do both or the pipeline legitimately waits forever.
    global.Audio = class {
        constructor() { this.duration = 1.5; this._listeners = {}; }
        addEventListener(ev, cb) {
            (this._listeners[ev] = this._listeners[ev] || []).push(cb);
            if (ev === 'loadedmetadata') setImmediate(cb);
        }
        play() {
            setImmediate(() => {
                for (const cb of this._listeners.ended || []) cb();
            });
            return Promise.resolve();
        }
        pause() {}
    };
    global.Blob = class { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } };
    global.URL = { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} };
    global.atob = (s) => Buffer.from(s, 'base64').toString('binary');

    return calls;
}

function loadModules() {
    (0, eval)(read('src/core/live-companion.js'));
    (0, eval)(read('src/core/message-session.js'));
    (0, eval)(read('src/core/desktop-pet-system.js'));
}

/** Build a pet system wired with stubs but using the REAL reply pipeline. */
function makeSystem(LiveCompanion, calls, overrides = {}) {
    const Sys = global.DesktopPetSystem;
    const sys = new Sys();
    sys.isActive = true;
    sys.systemPrompt = 'you are a pet';
    sys.buildDynamicContext = () => '';
    sys.aiClient = {
        isConfigured: () => true,
        callAPI: async (messages) => {
            calls.ai.push(messages);
            return '这条弹幕挺有意思的。';
        },
    };
    sys.emotionSystem = {
        forceRevert() {}, onAIResponse() {}, _selectEmotionFromAI() {}, stop() {}, start() {},
        emotionValue: 0, triggerAligned() {},
    };
    // Never leave real timers running: the tests must be able to exit.
    sys.startDetection = () => {};
    sys.startFocusTimer = () => {};
    sys.stopDetection = () => {};
    sys.stopFocusTimer = () => {};
    sys.stopCurrentAudio = () => {};
    // Deliberately SILENT: a danmaku reply must still be voiced via in-app TTS.
    sys.audioStateMachine = { effectiveMode: 'silent', getRandomClip: () => null };
    sys.liveCompanion = new LiveCompanion({
        lang: 'zh',
        config: { enabled: true, mode: 'all', replyIntervalMs: 1000, userCooldownMs: 0, ...(overrides.companion || {}) },
    });
    return sys;
}

const waitFor = async (predicate, timeoutMs = 4000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 25));
    }
    return false;
};

describe('danmaku → reply pipeline', () => {
    let calls;
    beforeEach(() => {
        calls = setupEnv();
        loadModules();
    });

    it('answers a danmaku and voices it through the in-app TTS', async () => {
        const sys = makeSystem(global.LiveCompanion, calls);

        sys._onDanmaku({ type: 'danmaku', user: '观众甲', uid: 1, text: '这个boss怎么打？' });

        assert.ok(await waitFor(() => calls.tts.length > 0), 'TTS was asked to synthesize');
        assert.ok(await waitFor(() => calls.chat.length > 0), 'the bubble was shown');

        // The reply must be spoken even though the audio mode is 'silent'.
        assert.strictEqual(calls.tts.length, 1);
        assert.strictEqual(calls.chat[0], '这条弹幕挺有意思的。');

        // The prompt actually carried the danmaku through.
        assert.strictEqual(calls.ai.length, 1);
        const userMsg = calls.ai[0].find((m) => m.role === 'user');
        assert.ok(userMsg.content.includes('这个boss怎么打？'), 'the danmaku text reaches the model');
        assert.ok(userMsg.content.includes('观众甲'), 'the viewer name reaches the model');

        // Talking state toggled on and off around playback.
        assert.deepStrictEqual(calls.talking, [true, false]);
        sys.stop?.();
    });

    it('does not answer when the live companion is disabled', async () => {
        const sys = makeSystem(global.LiveCompanion, calls, { companion: { enabled: false } });
        sys._onDanmaku({ type: 'danmaku', user: '观众甲', uid: 1, text: '你好呀主播' });
        await new Promise((r) => setTimeout(r, 300));
        assert.strictEqual(calls.ai.length, 0, 'no model call while disabled');
    });

    it('filters noise before spending a model call', async () => {
        const sys = makeSystem(global.LiveCompanion, calls);
        sys._onDanmaku({ type: 'danmaku', user: '路人', uid: 2, text: '666' });
        sys._onDanmaku({ type: 'danmaku', user: '路人', uid: 2, text: '哈哈哈' });
        await new Promise((r) => setTimeout(r, 300));
        assert.strictEqual(calls.ai.length, 0, 'noise never reaches the model');
    });

    it('queues several danmaku instead of dropping them', async () => {
        const sys = makeSystem(global.LiveCompanion, calls);
        sys._onDanmaku({ type: 'danmaku', user: 'A', uid: 1, text: '第一条有用的弹幕' });
        await waitFor(() => calls.ai.length === 1);
        // While the pet is busy, more danmaku arrive.
        sys.liveCompanion.replyIntervalMs = 0;
        sys._onDanmaku({ type: 'danmaku', user: 'B', uid: 2, text: '第二条有用的弹幕' });
        sys._onDanmaku({ type: 'danmaku', user: 'C', uid: 3, text: '第三条有用的弹幕' });
        assert.ok(await waitFor(() => calls.ai.length >= 2, 6000), 'a queued danmaku still gets answered');
    });

    it('reloads the live settings so the switch applies without a restart', async () => {
        const sys = makeSystem(global.LiveCompanion, calls, { companion: { enabled: false } });
        assert.strictEqual(sys.liveCompanion.enabled, false);

        global.electronAPI.loadConfig = async () => ({ bilibili: { enabled: true, mode: 'mention', mentions: ['小门'], roomTitle: '测试间' } });
        await sys.reloadLiveCompanionConfig();

        assert.strictEqual(sys.liveCompanion.enabled, true);
        assert.strictEqual(sys.liveCompanion.mode, 'mention');
        assert.deepStrictEqual(sys.liveCompanion.mentions, ['小门']);
        assert.strictEqual(sys.biliRoomTitle, '测试间');
    });

    it('starts the pet on demand instead of dropping the danmaku', async () => {
        // The pet only runs after "Start Pet"; live chat arrives long before the
        // user notices, so an incoming danmaku must bring it up.
        const sys = makeSystem(global.LiveCompanion, calls);
        sys.isActive = false;
        let startCalls = 0;
        sys.start = async () => { startCalls++; sys.isActive = true; };

        sys._onDanmaku({ type: 'danmaku', user: '观众', uid: 9, text: '主播这个怎么打' });

        assert.ok(await waitFor(() => startCalls === 1), 'the pet is started on demand');
        assert.strictEqual(sys._suppressAutoStart, false);
    });

    it('answers the next danmaku once the on-demand start finished', async () => {
        const sys = makeSystem(global.LiveCompanion, calls);
        sys.isActive = false;
        sys.start = async () => { sys.isActive = true; };

        sys._onDanmaku({ type: 'danmaku', user: '观众', uid: 9, text: '第一条触发启动' });
        await waitFor(() => sys.isActive);

        sys._onDanmaku({ type: 'danmaku', user: '观众', uid: 10, text: '第二条应该被回应' });
        assert.ok(await waitFor(() => calls.ai.length > 0), 'the model is called after the start');
    });

    it('does not resurrect the pet after the user stopped it', async () => {
        const sys = makeSystem(global.LiveCompanion, calls);
        sys.isActive = true;
        await sys.stop();
        assert.strictEqual(sys._suppressAutoStart, true);

        let startCalls = 0;
        sys.start = async () => { startCalls++; };
        sys._onDanmaku({ type: 'danmaku', user: '观众', uid: 9, text: '主播在吗' });
        await new Promise((r) => setTimeout(r, 250));
        assert.strictEqual(startCalls, 0, 'a manual stop is respected');
    });

    it('clears the manual-stop flag when the user starts the pet again', async () => {
        const sys = makeSystem(global.LiveCompanion, calls);
        sys.isActive = true;
        await sys.stop();
        assert.strictEqual(sys._suppressAutoStart, true);

        sys.isActive = false;
        global.electronAPI.createPetWindow = async () => ({ success: true });
        await sys.start();
        assert.strictEqual(sys._suppressAutoStart, false, 'starting clears the suppression');
    });
});
