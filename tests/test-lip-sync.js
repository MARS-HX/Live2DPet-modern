/**
 * 口型同步（LipSync）单元测试。
 *
 * 播放循环用**假 rAF** 手动驱动，不靠计时器：这样"取样本→算口型→回调"的顺序
 * 完全确定，不会因为机器忙就闪烁失败。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const mod = require(path.join(__dirname, '..', 'src', 'renderer', 'lip-sync.js'));

/** 假 rAF：把回调排队，由测试自己决定推进几帧。 */
function makeRaf() {
    let queue = [];
    let seq = 0;
    return {
        raf: (cb) => { queue.push(cb); return ++seq; },
        cancel: () => {},
        flush(times = 1) {
            for (let i = 0; i < times; i++) {
                const cbs = queue.splice(0);
                cbs.forEach((cb) => cb());
            }
        },
        pending: () => queue.length,
    };
}

/** 假 AudioContext：时域样本由测试指定，用来模拟"有声音 / 静音"。 */
function makeFakeCtx({ sample, state: ctxState } = {}) {
    const state = { started: false, stopped: false, gain: null, closed: false, resumed: 0 };
    const ctx = {
        state: ctxState,
        destination: { name: 'destination' },
        resume() { state.resumed += 1; ctx.state = 'running'; return Promise.resolve(); },
        createAnalyser: () => ({
            fftSize: 0,
            // 真实的 AnalyserNode 是 AudioNode，能被串进音频图
            connect() {},
            disconnect() {},
            getFloatTimeDomainData: (view) => {
                const v = typeof sample === 'function' ? sample() : sample;
                for (let i = 0; i < view.length; i++) view[i] = v === undefined ? 0.2 : v;
            },
        }),
        createGain: () => {
            const g = { gain: { value: 1 }, connect() {}, disconnect() {} };
            state.gain = g;
            return g;
        },
        createBufferSource: () => ({
            buffer: null,
            connect() {},
            disconnect() {},
            start() { state.started = true; },
            stop() { state.stopped = true; },
            onended: null,
        }),
        decodeAudioData: (buf, ok) => { ok({ duration: 1, sampleRate: 48000 }); return undefined; },
        close: () => { state.closed = true; return Promise.resolve(); },
    };
    return { ctx, state };
}

function makePlayer(opts = {}) {
    const raf = makeRaf();
    const levels = [];
    const ends = [];
    const player = new mod.LipSyncPlayer({
        logger: { warn() {}, log() {} },
        audioContextFactory: opts.audioContextFactory,
        audioFactory: opts.audioFactory,
        raf: raf.raf,
        cancelRaf: raf.cancel,
        now: opts.now || (() => 0),
    });
    return {
        player, raf, levels, ends,
        handlers: {
            onLevel: (v) => levels.push(v),
            onEnd: (reason) => ends.push(reason),
        },
        base64: 'AAAA',
    };
}

const flushMicrotasks = () => new Promise((r) => setImmediate(r));

describe('lip-sync 纯函数', () => {
    it('静音 / NaN / 负数一律闭嘴', () => {
        assert.strictEqual(mod.rmsToLevel(0), 0);
        assert.strictEqual(mod.rmsToLevel(0.001), 0, '低于底噪门限');
        assert.strictEqual(mod.rmsToLevel(NaN), 0);
        assert.strictEqual(mod.rmsToLevel(-1), 0);
        assert.strictEqual(mod.rmsToLevel(undefined), 0);
        assert.strictEqual(mod.rmsToLevel('不是数字'), 0);
    });

    it('音量越大嘴张得越大，且封顶 1', () => {
        const a = mod.rmsToLevel(0.05);
        const b = mod.rmsToLevel(0.12);
        const c = mod.rmsToLevel(0.30);
        assert.ok(a > 0 && b > a && c >= b, `应当单调递增：${a} ${b} ${c}`);
        assert.strictEqual(mod.rmsToLevel(5), 1, '再大也不能超过 1');
    });

    it('平滑：张嘴比闭嘴快（否则一帧一帧地抖）', () => {
        const open = mod.smoothLevel(0, 1);
        const close = mod.smoothLevel(1, 0);
        assert.ok(open > 0.4, `张嘴应当很快跟上（实际 ${open}）`);
        assert.ok(1 - close < open, `闭嘴应当比张嘴慢（闭合后剩 ${close}）`);
        assert.ok(close < 1 && close > 0);
    });

    it('平滑入参非法时不会传播 NaN', () => {
        assert.strictEqual(mod.smoothLevel(NaN, 0.5) >= 0, true);
        assert.ok(Number.isFinite(mod.smoothLevel(undefined, undefined)));
        assert.strictEqual(mod.smoothLevel(2, 3), 1, '越界入参要夹住');
    });

    it('退路节奏在 0..1 内随时间起伏', () => {
        const vals = [];
        for (let t = 0; t < 2000; t += 25) vals.push(mod.fallbackLevel(t));
        assert.ok(vals.every((v) => v >= 0 && v <= 1), '必须始终在 0..1');
        assert.ok(Math.max(...vals) - Math.min(...vals) > 0.5, '必须有明显的开合起伏');
        assert.strictEqual(mod.fallbackLevel(500), mod.fallbackLevel(500), '同一时刻结果确定');
    });

    it('自适应参考：只跟着更大走，回落很慢，且有下限', () => {
        let ref = mod.adaptReference(0.08, 0.3);
        assert.strictEqual(ref, 0.3, '出现更大的音量要立刻跟上');
        const quiet = mod.adaptReference(ref, 0.05);
        assert.ok(quiet > 0.29 && quiet < 0.3, `一声变小不该让参考暴跌（实际 ${quiet}）`);
        for (let i = 0; i < 5000; i++) ref = mod.adaptReference(ref, 0.001);
        assert.ok(ref >= 0.03, `回落必须有下限，否则静音会把增益推到天上（实际 ${ref}）`);
        assert.strictEqual(mod.adaptReference(NaN, 0.2), 0.2);
        assert.strictEqual(mod.adaptReference(0.2, 0), 0.2, '无人声时保持参考');
    });

    it('量化：小声和大声都要把嘴张开（三个 TTS 后端电平差很多）', () => {
        const quiet = mod.gainForReference(0.05);
        const loud = mod.gainForReference(0.30);
        assert.ok(quiet > loud, '越小声放大倍数要越大');
        assert.ok(mod.rmsToLevel(0.05, { gain: quiet }) > 0.9, '小声说话也该接近满开');
        assert.ok(mod.rmsToLevel(0.30, { gain: loud }) > 0.9, '大声同样接近满开');
    });

    it('RMS 计算正确', () => {        assert.strictEqual(mod.rmsOf([]), 0);
        assert.strictEqual(mod.rmsOf([0, 0, 0, 0]), 0);
        assert.ok(Math.abs(mod.rmsOf([0.5, 0.5, 0.5, 0.5]) - 0.5) < 1e-9);
        assert.ok(Math.abs(mod.rmsOf([0.5, -0.5]) - 0.5) < 1e-9, '负号不该被抵消');
        assert.strictEqual(mod.rmsOf(null), 0);
    });

    it('base64 解出来就是原字节', () => {
        const bytes = Buffer.from([0, 1, 2, 250, 255]);
        const ab = mod.base64ToArrayBuffer(bytes.toString('base64'));
        assert.deepStrictEqual(Array.from(new Uint8Array(ab)), [0, 1, 2, 250, 255]);
        const withPrefix = mod.base64ToArrayBuffer('data:audio/wav;base64,' + bytes.toString('base64'));
        assert.deepStrictEqual(Array.from(new Uint8Array(withPrefix)), [0, 1, 2, 250, 255]);
    });
});

describe('LipSyncPlayer — Web Audio 路径', () => {
    it('有声音时口型跟着张开，播完自动闭嘴', async () => {
        const { ctx } = makeFakeCtx({ sample: 0.35 });       // 稳定大声（RMS 0.35）
        const t = makePlayer({ audioContextFactory: () => ctx });
        const playing = t.player.play(t.base64, t.handlers);
        await flushMicrotasks();

        t.raf.flush(30);                                     // 推进 30 帧
        const loud = t.levels.filter((v) => v > 0.1);
        assert.ok(loud.length >= 20, `应当持续报出张口值（实际 ${loud.length} 帧）`);
        assert.ok(Math.max(...t.levels) > 0.9, `稳定大声时应当接近满开（实际 ${Math.max(...t.levels)}）`);

        // 让音频自然结束 → 必须收尾闭嘴
        t.player._source.onended();
        const res = await playing;
        assert.strictEqual(res.ok, true);
        assert.strictEqual(t.levels[t.levels.length - 1], 0, '结束前必须报一次 0');
        assert.deepStrictEqual(t.ends, ['ended']);
        assert.strictEqual(t.player.level, 0);
    });

    it('小声的音频也会把嘴张开（自适应增益，不再"小声那次几乎不动"）', async () => {
        const { ctx } = makeFakeCtx({ sample: 0.06 });
        const t = makePlayer({ audioContextFactory: () => ctx });
        const playing = t.player.play(t.base64, t.handlers);
        await flushMicrotasks();
        t.raf.flush(40);
        const peak = Math.max(...t.levels);
        // 固定增益时代这里只有 ~0.15（(0.06-0.012)*3.2），实测两次同一句文案峰值
        // 差了一倍（0.83 / 0.43），正是这个原因 —— 三个 TTS 后端电平本来就不一样。
        assert.ok(peak > 0.7, `小声说话也该把嘴张开（实际峰值 ${peak}）`);
        t.player._source.onended();
        await playing;
    });

    it('静音时嘴不动（不能凭"在播放"就一直张着）', async () => {
        const { ctx } = makeFakeCtx({ sample: 0 });          // 全零
        const t = makePlayer({ audioContextFactory: () => ctx });
        const playing = t.player.play(t.base64, t.handlers);
        await flushMicrotasks();
        t.raf.flush(20);
        assert.ok(t.levels.every((v) => v === 0), `静音不该有张口值：${JSON.stringify(t.levels.slice(0, 5))}`);
        t.player._source.onended();
        await playing;
    });

    it('播到一半 stop()：立刻闭嘴且不再推进', async () => {
        const { ctx, state } = makeFakeCtx({ sample: 0.25 });
        const t = makePlayer({ audioContextFactory: () => ctx });
        const playing = t.player.play(t.base64, t.handlers);
        await flushMicrotasks();
        t.raf.flush(10);
        assert.ok(t.levels.some((v) => v > 0.1));

        t.player.stop();
        t.raf.flush(5);
        assert.strictEqual(state.stopped, true, '应当真的停掉音频源');
        assert.strictEqual(t.player.level, 0);
        assert.strictEqual(t.player.playing, false);
        await playing;                                        // 不能悬着不 resolve
    });

    it('AudioContext 处于 suspended 时会先恢复（否则分析恒为 0，嘴一动不动）', async () => {
        const { ctx, state } = makeFakeCtx({ sample: 0.3, state: 'suspended' });
        const t = makePlayer({ audioContextFactory: () => ctx });
        const playing = t.player.play(t.base64, t.handlers);
        await flushMicrotasks();
        t.raf.flush(5);
        assert.strictEqual(state.resumed, 1, '挂起的上下文必须被 resume');
        assert.ok(Math.max(...t.levels) > 0.5, '恢复之后应当真的取到口型值');
        t.player._source.onended();
        await playing;
    });

    it('audible=false 时增益置 0（OBS 可只同步口型不出声）', async () => {
        const { ctx, state } = makeFakeCtx({ sample: 0.2 });
        const t = makePlayer({ audioContextFactory: () => ctx });
        const playing = t.player.play(t.base64, { ...t.handlers, audible: false });
        await flushMicrotasks();
        t.raf.flush(3);
        assert.strictEqual(state.gain.gain.value, 0);
        t.player._source.onended();
        await playing;
    });

    it('解码失败要退回 <audio> 继续出声，而不是让宠物失声', async () => {
        const { ctx } = makeFakeCtx({});
        ctx.decodeAudioData = (buf, ok, fail) => { fail(new Error('bad wav')); };
        const el = { play: () => Promise.resolve(), pause() {}, onended: null };
        const t = makePlayer({ audioContextFactory: () => ctx, audioFactory: () => el, now: () => 100 });
        const playing = t.player.play(t.base64, t.handlers);
        await flushMicrotasks();
        t.raf.flush(12);
        assert.ok(t.levels.some((v) => v > 0.1), '退回路径仍然要驱动口型');
        el.onended();
        const res = await playing;
        assert.strictEqual(res.ok, true, '解码失败不该让整段话消失');
        assert.strictEqual(t.levels[t.levels.length - 1], 0, '结束也必须闭嘴');
    });

    it('解码失败且环境完全放不了音 → 结构化失败，不抛不挂', async () => {
        const { ctx } = makeFakeCtx({});
        ctx.decodeAudioData = (buf, ok, fail) => { fail(new Error('bad wav')); };
        const t = makePlayer({ audioContextFactory: () => ctx, audioFactory: null });
        const res = await t.player.play(t.base64, t.handlers);
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.reason, 'no_audio_support');
        assert.strictEqual(t.player.playing, false);
        assert.strictEqual(t.levels[t.levels.length - 1], 0, '失败也必须闭嘴');
    });
});

describe('LipSyncPlayer — 退路（没有 Web Audio）', () => {
    it('退回 <audio> + 定时节奏，仍然有口型、且播完闭嘴', async () => {
        const el = {
            muted: false,
            play: () => Promise.resolve(),
            pause() { el.paused = true; },
            onended: null,
        };
        const t = makePlayer({ audioContextFactory: null, audioFactory: () => el, now: () => 200 });
        const playing = t.player.play(t.base64, t.handlers);
        await flushMicrotasks();
        t.raf.flush(25);
        assert.ok(t.levels.some((v) => v > 0.1), '退路也要有开合');
        assert.ok(t.levels.every((v) => v >= 0 && v <= 1));

        el.onended();
        await playing;
        assert.strictEqual(t.levels[t.levels.length - 1], 0);
    });

    it('连 <audio> 都没有时返回失败，而不是挂住', async () => {
        const t = makePlayer({ audioContextFactory: null, audioFactory: null });
        const res = await t.player.play(t.base64, t.handlers);
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.reason, 'no_audio_support', '原因要能看出是"这台环境根本放不了音"');
        assert.strictEqual(t.player.playing, false);
        assert.strictEqual(t.levels[t.levels.length - 1], 0, '失败也必须闭嘴');
    });
});
