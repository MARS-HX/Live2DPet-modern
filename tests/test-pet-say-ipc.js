/**
 * pet-say / set-mouth-level 的单元测试。
 *
 * 关注点：拒绝路径要结构化返回（不抛）、音频真的发到了宠物窗、
 * 口型值必须夹在 0..1（否则模型参数会被写进荒唐的数值）、
 * 以及"合成是秒级的，期间窗口可能关掉"这个真实竞态。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { registerPetSayIPC, MAX_SAY_CHARS } = require(
    path.join(__dirname, '..', 'src', 'main', 'pet-say-ipc.js')
);

function makeHarness(opts = {}) {
    const sent = [];
    const handlers = new Map();
    const ipcMain = { handle: (channel, fn) => { handlers.set(channel, fn); } };
    const defaultWin = {
        isDestroyed: () => false,
        webContents: { send: (channel, ...args) => sent.push([channel, ...args]) },
    };
    const synthCalls = [];
    const ctx = {
        petWindow: 'petWindow' in opts ? opts.petWindow : defaultWin,
        ttsService: 'ttsService' in opts ? opts.ttsService : {
            isAvailable: () => true,
            tts: async (chunk) => { synthCalls.push(chunk); return Buffer.from('WAV<' + chunk + '>'); },
        },
    };
    registerPetSayIPC(ctx, ipcMain, { logger: { log() {} } });
    return {
        ctx, sent, synthCalls, defaultWin,
        call: (channel, ...args) => handlers.get(channel)({}, ...args),
        has: (channel) => handlers.has(channel),
    };
}

const fromBase64 = (b64) => Buffer.from(b64, 'base64').toString('utf8');

/** 生成一个合法的最小 WAV（44 字节头 + 若干 PCM），用来模拟真实 TTS 的输出。 */
function makeWav(pcmBytes = 4) {
    const buf = Buffer.alloc(44 + pcmBytes);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + pcmBytes, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);          // PCM
    buf.writeUInt16LE(1, 22);          // 单声道
    buf.writeUInt32LE(44100, 24);
    buf.writeUInt32LE(88200, 28);
    buf.writeUInt16LE(2, 32);          // blockAlign
    buf.writeUInt16LE(16, 34);         // 16 bit
    buf.write('data', 36);
    buf.writeUInt32LE(pcmBytes, 40);
    for (let i = 0; i < pcmBytes; i++) buf.writeUInt8(i % 251, 44 + i);
    return buf;
}

describe('pet-say', () => {
    it('注册了通道，且把合成结果发到宠物窗', async () => {
        const h = makeHarness();
        assert.ok(h.has('pet-say'), '必须注册 pet-say');
        assert.ok(h.has('set-mouth-level'));

        const res = await h.call('pet-say', '你好呀');
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.chars, 3);

        assert.strictEqual(h.sent.length, 1);
        const [channel, payload] = h.sent[0];
        assert.strictEqual(channel, 'pet-say', '必须走 pet-say 通道（OBS 镜像只转发这一条）');
        assert.strictEqual(payload.text, '你好呀');
        assert.strictEqual(payload.mime, 'audio/wav');
        assert.strictEqual(fromBase64(payload.wav), 'WAV<你好呀>');
    });

    it('首尾空白会被去掉', async () => {
        const h = makeHarness();
        await h.call('pet-say', '  说这句  ');
        assert.strictEqual(h.sent[0][1].text, '说这句');
    });

    it('空 / 非字符串输入被拒绝，且不发任何东西', async () => {
        const h = makeHarness();
        for (const bad of ['', '   ', undefined, null]) {
            const res = await h.call('pet-say', bad);
            assert.strictEqual(res.success, false);
            assert.strictEqual(res.error, 'empty_text', `输入 ${JSON.stringify(bad)} 应报 empty_text`);
        }
        assert.strictEqual(h.sent.length, 0);
        assert.strictEqual(h.synthCalls.length, 0, '被拒绝的输入不该去合成（那是要花钱的）');
    });

    it('超长文案被拒绝并告知上限', async () => {
        const h = makeHarness();
        const res = await h.call('pet-say', '啊'.repeat(MAX_SAY_CHARS + 1));
        assert.strictEqual(res.success, false);
        assert.strictEqual(res.error, 'too_long');
        assert.strictEqual(res.maxChars, MAX_SAY_CHARS);
        assert.strictEqual(h.sent.length, 0);
    });

    it('长文案会分句合成，并把各段 PCM 拼成一个 WAV', async () => {
        // 假的 TTS 返回合法 WAV（每段 PCM 长度 = 句子长度 × 2），
        // 这样"拼接"就能被真正验证：总 PCM 长度必须等于各段之和，且头部仍是合法 WAV。
        const h = makeHarness({
            ttsService: {
                isAvailable: () => true,
                tts: async (chunk) => { h.synthCalls.push(chunk); return makeWav(chunk.length * 2); },
            },
        });
        const long = '第一句话要够长才能触发分句处理。'.repeat(8);
        const res = await h.call('pet-say', long);
        assert.strictEqual(res.success, true, `不该失败：${res.error}`);

        assert.ok(h.synthCalls.length > 1, `应当分句合成（实际 ${h.synthCalls.length} 次）`);
        assert.strictEqual(h.synthCalls.join(''), long, '分句后拼起来必须还是原文');

        const wav = Buffer.from(h.sent[0][1].wav, 'base64');
        assert.strictEqual(wav.slice(0, 4).toString(), 'RIFF');
        assert.strictEqual(wav.slice(8, 12).toString(), 'WAVE');
        const expectedPcm = h.synthCalls.reduce((n, c) => n + c.length * 2, 0);
        assert.strictEqual(wav.readUInt32LE(40), expectedPcm, 'data 段长度应等于各段 PCM 之和');
        assert.strictEqual(wav.readUInt32LE(4), 36 + expectedPcm, 'RIFF 长度也要跟着改');
    });

    it('TTS 不可用时报 tts_unavailable', async () => {
        const h = makeHarness({ ttsService: { isAvailable: () => false, tts: async () => Buffer.from('x') } });
        const res = await h.call('pet-say', '喂');
        assert.strictEqual(res.success, false);
        assert.strictEqual(res.error, 'tts_unavailable');
        assert.strictEqual(h.sent.length, 0);
    });

    it('完全没有 TTS 服务时不炸', async () => {
        const h = makeHarness({ ttsService: null });
        const res = await h.call('pet-say', '喂');
        assert.strictEqual(res.success, false);
        assert.strictEqual(res.error, 'tts_unavailable');
    });

    it('宠物窗不在时报 no_pet_window，不白花钱合成', async () => {
        const h = makeHarness({ petWindow: null });
        const res = await h.call('pet-say', '喂');
        assert.strictEqual(res.success, false);
        assert.strictEqual(res.error, 'no_pet_window');
        assert.strictEqual(h.synthCalls.length, 0, '没有窗口就不该合成');
    });

    it('窗口已销毁同样拒绝', async () => {
        const h = makeHarness({ petWindow: { isDestroyed: () => true, webContents: { send() {} } } });
        const res = await h.call('pet-say', '喂');
        assert.strictEqual(res.success, false);
        assert.strictEqual(res.error, 'no_pet_window');
    });

    it('合成期间窗口被关掉 → 不往已销毁的窗口发（真实竞态）', async () => {
        let destroyed = false;
        const win = {
            isDestroyed: () => destroyed,
            webContents: { send: () => { throw new Error('Object has been destroyed'); } },
        };
        const h = makeHarness({
            petWindow: win,
            ttsService: {
                isAvailable: () => true,
                tts: async () => { destroyed = true; return Buffer.from('WAV'); },  // 合成花了时间
            },
        });
        const res = await h.call('pet-say', '慢一点');
        assert.strictEqual(res.success, false);
        assert.strictEqual(res.error, 'no_pet_window', '合成完成后必须重新检查窗口');
    });

    it('合成返回空 → synthesis_failed', async () => {
        const h = makeHarness({ ttsService: { isAvailable: () => true, tts: async () => null } });
        const res = await h.call('pet-say', '喂');
        assert.strictEqual(res.success, false);
        assert.strictEqual(res.error, 'synthesis_failed');
        assert.strictEqual(h.sent.length, 0);
    });

    it('合成抛错 → 结构化返回，不把异常抛给渲染层', async () => {
        const h = makeHarness({
            ttsService: { isAvailable: () => true, tts: async () => { throw new Error('网络断了'); } },
        });
        const res = await h.call('pet-say', '喂');
        assert.strictEqual(res.success, false);
        assert.strictEqual(res.error, '网络断了');
    });

    it('只实现了 synthesize() 的后端也能用', async () => {
        const h = makeHarness({
            ttsService: { isAvailable: () => true, synthesize: (t) => Buffer.from('SYN<' + t + '>') },
        });
        const res = await h.call('pet-say', '备用后端');
        assert.strictEqual(res.success, true);
        assert.strictEqual(fromBase64(h.sent[0][1].wav), 'SYN<备用后端>');
    });

    it('可以关掉气泡或声音', async () => {
        const h = makeHarness();
        await h.call('pet-say', '静音说', { audible: false, showBubble: false });
        assert.strictEqual(h.sent[0][1].audible, false);
        assert.strictEqual(h.sent[0][1].showBubble, false);
    });
});

describe('pet-say-stop', () => {
    it('会告诉宠物窗停下（不只是把嘴闭上，音频也要断）', async () => {
        const h = makeHarness();
        assert.ok(h.has('pet-say-stop'), '必须注册 pet-say-stop');
        const res = await h.call('pet-say-stop');
        assert.strictEqual(res.success, true);
        assert.deepStrictEqual(h.sent[0], ['pet-say-stop']);
    });

    it('没有宠物窗时也不报错', async () => {
        const h = makeHarness({ petWindow: null });
        const res = await h.call('pet-say-stop');
        assert.strictEqual(res.success, true);
        assert.strictEqual(h.sent.length, 0);
    });
});

describe('set-mouth-level', () => {
    it('把口型值转发给宠物窗（OBS 由镜像自动拿到）', async () => {
        const h = makeHarness();
        const res = await h.call('set-mouth-level', 0.42);
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.level, 0.42);
        assert.deepStrictEqual(h.sent[0], ['mouth-level', 0.42]);
    });

    it('越界与非法值一律夹到 0..1（参数写坏会让模型崩）', async () => {
        const h = makeHarness();
        const cases = [[2, 1], [-1, 0], [NaN, 0], [undefined, 0], ['0.5', 0.5], ['不是数', 0]];
        for (const [input, expected] of cases) {
            const res = await h.call('set-mouth-level', input);
            assert.strictEqual(res.success, true);
            assert.strictEqual(res.level, expected, `输入 ${String(input)} 应得到 ${expected}`);
        }
        const forwards = h.sent.filter(([c]) => c === 'mouth-level');
        assert.ok(forwards.every(([, v]) => v >= 0 && v <= 1));
    });

    it('没有宠物窗时也不报错（口型是尽力而为）', async () => {
        const h = makeHarness({ petWindow: null });
        const res = await h.call('set-mouth-level', 0.7);
        assert.strictEqual(res.success, true);
        assert.strictEqual(h.sent.length, 0);
    });
});
