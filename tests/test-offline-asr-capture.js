/**
 * Tests for the renderer-side microphone capture (src/renderer/offline-asr.js).
 *
 * This is the glue between the browser audio APIs and the native engine, so it
 * is tested against fakes: a stub getUserMedia, a stub AudioContext whose
 * worklet port we can push frames into, and a stub IPC bridge. That covers the
 * parts that would otherwise only fail on a real machine with a real mic.
 *
 * Run with: node --test tests/test-offline-asr-capture.js
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const pcmUtil = require('../src/core/pcm-util');

const CHUNK_BYTES = 3200;      // 1600 int16 samples = 100 ms at 16 kHz

/** Install browser-ish globals, and hand back the knobs to drive them. */
function installFakes(opts = {}) {
    const saved = {};
    // Node defines `navigator` as a getter-only global, so a plain assignment
    // silently does nothing — every global has to go through defineProperty.
    const setGlobal = (k, v) => {
        if (!(k in saved)) {
            saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
        }
        Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
    };

    const feeds = [];
    const results = { handler: null };
    const media = {
        stopped: false,
        getTracks() { return [{ stop: () => { media.stopped = true; } }]; },
    };

    const api = {
        started: 0, stopped: 0,
        asrStart: async () => (opts.startResult || { success: true }),
        asrStop: async () => { api.stopped++; return { success: true }; },
        asrFeed: (buf) => feeds.push(buf),
        onAsrResult: (cb) => { results.handler = cb; },
    };

    const ctx = {
        sampleRate: opts.sampleRate || 48000,
        state: 'running',
        closed: false,
        audioWorklet: { addModule: async (u) => { ctx.moduleUrl = u; } },
        createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
        createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
        destination: {},
        async close() { ctx.closed = true; this.state = 'closed'; },
    };

    const ports = [];
    class FakeWorkletNode {
        constructor() {
            this.port = { onmessage: null, postMessage() {} };
            ports.push(this.port);
        }
        connect() {} disconnect() {}
    }

    setGlobal('electronAPI', opts.noBridge ? undefined : api);
    setGlobal('navigator', opts.noMic
        ? {}
        : {
            mediaDevices: {
                getUserMedia: opts.denyMic
                    ? async () => { throw new Error('Permission denied'); }
                    : async () => media,
            },
        });
    setGlobal('AudioContext', function () { return ctx; });
    setGlobal('AudioWorkletNode', opts.noWorklet ? undefined : FakeWorkletNode);
    setGlobal('PcmUtil', pcmUtil);
    setGlobal('Blob', class { constructor(parts) { this.parts = parts; } });
    setGlobal('URL', { createObjectURL: () => 'blob:fake', revokeObjectURL() {} });

    return {
        api, ctx, media, feeds, results, ports,
        restore() {
            for (const [k, desc] of Object.entries(saved)) {
                if (desc) Object.defineProperty(globalThis, k, desc);
                else delete globalThis[k];
            }
        },
    };
}

// The module captures globals at call time, so load it fresh per test.
function loadModule() {
    delete require.cache[require.resolve('../src/renderer/offline-asr')];
    return require('../src/renderer/offline-asr');
}

const QUIET = { log() {}, warn() {}, error() {} };

let env;
afterEach(() => { if (env) { env.restore(); env = null; } });

describe('OfflineAsrCapture — refusing to start', () => {
    it('reports when the IPC bridge is missing', async () => {
        env = installFakes({ noBridge: true });
        const { OfflineAsrCapture } = loadModule();
        const cap = new OfflineAsrCapture({ logger: QUIET });
        assert.deepStrictEqual(await cap.start(), { ok: false, reason: 'no_bridge' });
    });

    it('reports when getUserMedia is unavailable', async () => {
        env = installFakes({ noMic: true });
        const { OfflineAsrCapture } = loadModule();
        const cap = new OfflineAsrCapture({ logger: QUIET });
        assert.strictEqual((await cap.start()).reason, 'no_getusermedia');
    });

    it('reports when AudioWorklet is unavailable', async () => {
        env = installFakes({ noWorklet: true });
        const { OfflineAsrCapture } = loadModule();
        const cap = new OfflineAsrCapture({ logger: QUIET });
        assert.strictEqual((await cap.start()).reason, 'no_audioworklet');
    });

    it('does not open the microphone when the engine is not installed', async () => {
        env = installFakes({ startResult: { success: false, error: 'native_not_installed' } });
        const { OfflineAsrCapture } = loadModule();
        const cap = new OfflineAsrCapture({ logger: QUIET });
        const res = await cap.start();
        assert.strictEqual(res.reason, 'native_not_installed');
        assert.strictEqual(cap.active, false);
    });

    it('reports a denied microphone rather than throwing', async () => {
        env = installFakes({ denyMic: true });
        const { OfflineAsrCapture } = loadModule();
        const cap = new OfflineAsrCapture({ logger: QUIET });
        assert.strictEqual((await cap.start()).reason, 'microphone_denied');
        assert.strictEqual(cap.active, false);
    });
});

describe('OfflineAsrCapture — capturing', () => {
    beforeEach(() => { env = installFakes(); });

    async function started(overrides = {}) {
        const mod = loadModule();
        const onText = overrides.onText || (() => {});
        const cap = new mod.OfflineAsrCapture({ logger: QUIET, onText });
        const res = await cap.start();
        assert.strictEqual(res.ok, true, `start failed: ${res.reason}`);
        return { cap, mod };
    }

    const sine = (n, rate) => {
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) out[i] = Math.sin(2 * Math.PI * 440 * i / rate);
        return out;
    };

    it('loads the worklet from a blob URL and revokes it', async () => {
        const { cap } = await started();
        assert.strictEqual(env.ctx.moduleUrl, 'blob:fake');
        await cap.stop();
    });

    it('converts 48 kHz mic audio into 100 ms int16 chunks', async () => {
        const { cap } = await started();
        assert.strictEqual(env.ports.length, 1);
        // One second at 48 kHz, delivered in worklet-sized blocks.
        const src = sine(48000, 48000);
        for (let off = 0; off < src.length; off += 2048) {
            env.ports[0].onmessage({ data: src.subarray(off, off + 2048) });
        }
        assert.ok(env.feeds.length >= 9, `expected ~10 chunks, got ${env.feeds.length}`);
        for (const buf of env.feeds) {
            assert.strictEqual(buf.byteLength, CHUNK_BYTES, 'every chunk must be exactly 100 ms at 16 kHz');
        }
        await cap.stop();
    });

    it('handles a non-integer rate (44.1 kHz)', async () => {
        env.restore();
        env = installFakes({ sampleRate: 44100 });
        const { cap } = await started();
        const src = sine(44100, 44100);
        for (let off = 0; off < src.length; off += 2048) {
            env.ports[0].onmessage({ data: src.subarray(off, off + 2048) });
        }
        const total = env.feeds.length * 1600;
        assert.ok(Math.abs(total - 16000) <= 3200, `got ${total} samples for 1 s, expected ~16000`);
        await cap.stop();
    });

    it('stops feeding after stop(), so a released mic goes quiet', async () => {
        const { cap } = await started();
        // Keep the handler: stop() detaches it from the port, and we want to
        // prove the guard inside the capture (not the detach) is what stops it.
        const handler = env.ports[0].onmessage;
        handler({ data: sine(2048, 48000) });
        const before = env.feeds.length;
        await cap.stop();
        handler({ data: sine(2048, 48000) });
        assert.strictEqual(env.feeds.length, before, 'audio after stop must be ignored');
    });

    it('surfaces recognised text from the main process', async () => {
        const heard = [];
        const { cap } = await started({ onText: (t) => heard.push(t) });
        assert.ok(env.results.handler, 'must subscribe to asr results');
        env.results.handler('你好世界');
        assert.deepStrictEqual(heard, ['你好世界']);
        await cap.stop();
    });

    it('ignores empty results', async () => {
        const heard = [];
        const { cap } = await started({ onText: (t) => heard.push(t) });
        env.results.handler('');
        env.results.handler(null);
        assert.deepStrictEqual(heard, []);
        await cap.stop();
    });

    it('releases the microphone and closes the audio context on stop()', async () => {
        const { cap } = await started();
        await cap.stop();
        assert.strictEqual(env.media.stopped, true, 'mic tracks must be stopped');
        assert.strictEqual(env.ctx.closed, true, 'audio context must be closed');
        assert.strictEqual(env.api.stopped, 1, 'main process session must be told to stop');
        assert.strictEqual(cap.active, false);
    });

    it('已经 active 时再 start() 直接返回 ok', async () => {
        const { cap } = await started();
        const res = await cap.start();
        assert.strictEqual(res.ok, true);
        await cap.stop();
    });

    it('getUserMedia 在途时 stop()：麦克风必须被释放，且不能再被置为 active（回归：只修了同实例去重）', async () => {
        // settings-ui 的「测试听写」每次点击都 new 一个 capture，所以同实例的
        // _startPromise 去重跨点击不生效。旧实现在这里放行后会把 _active 置回 true，
        // 而 asrTestCapture 早已指向新实例 —— 那支麦克风永远没人能停。
        const mod = loadModule();
        let release;
        const gate = new Promise((r) => { release = r; });
        const realGetUserMedia = globalThis.navigator.mediaDevices.getUserMedia;
        globalThis.navigator.mediaDevices.getUserMedia = async (...args) => {
            await gate;
            return realGetUserMedia(...args);
        };

        const cap = new mod.OfflineAsrCapture({ logger: QUIET, onText: () => {} });
        const starting = cap.start();
        await new Promise((r) => setTimeout(r, 0));   // 让它卡在 getUserMedia 上
        await cap.stop();                             // 此刻各字段仍为 null，_teardown 无事可做
        release();

        const res = await starting;
        assert.strictEqual(res.ok, false, '被停止的启动不该报告成功');
        assert.strictEqual(res.reason, 'cancelled');
        assert.strictEqual(cap.active, false, 'stop 之后不能再被置为 active');
        assert.strictEqual(env.media.stopped, true, '放行后必须把麦克风轨道停掉，否则话筒一直开着');
        assert.strictEqual(env.ports.length, 0, '被取消的启动不该再建 worklet 节点');
    });

    it('starting twice does not open a second microphone', async () => {
        const { cap } = await started();
        const res = await cap.start();
        assert.strictEqual(res.ok, true);
        assert.strictEqual(env.ports.length, 1, 'a second start must not build another worklet node');
        await cap.stop();
    });

    it('并发 start() 只能开一支麦克风（回归：_active 要到函数末尾才置位）', async () => {
        // 上面那条是串行 await，_active 早已为真，测不到真正的并发窗口。
        // 真实触发：双击 index.html 上的「测试离线语音」按钮。
        const mod = loadModule();
        let release;
        const gate = new Promise((r) => { release = r; });
        let mediaCalls = 0;
        const realGetUserMedia = globalThis.navigator.mediaDevices.getUserMedia;
        globalThis.navigator.mediaDevices.getUserMedia = async (...args) => {
            mediaCalls += 1;
            await gate;
            return realGetUserMedia(...args);
        };

        const cap = new mod.OfflineAsrCapture({ logger: QUIET, onText: () => {} });
        const first = cap.start();
        await new Promise((r) => setTimeout(r, 0));   // 让第一次走到 getUserMedia 的 await
        const second = cap.start();                   // 旧实现在这里会再开一支
        release();
        const [a, b] = await Promise.all([first, second]);

        assert.strictEqual(mediaCalls, 1, '两次并发 start 只能调用一次 getUserMedia');
        assert.strictEqual(a.ok, true);
        assert.strictEqual(b.ok, true);
        assert.strictEqual(env.ports.length, 1, '只能建一个 worklet 节点（旧实现会建两个并都往识别器喂数据）');
        assert.strictEqual(cap.active, true);
        await cap.stop();
        assert.strictEqual(env.media.stopped, true, '停止必须能真正释放麦克风');
    });
});
