/**
 * default-audio-ipc 的回归用例。
 *
 * 旧实现是「先把 default-audio 目录里的 .wav 全删掉，再逐条合成」。于是只要
 * TTS 后端当时是坏的（synthesize 抛错或返回 null），用户原有的一整套默认音频
 * 就被清空且没有任何东西补回来。同一段代码还有两个问题：
 *   - styleId 的恢复写在成功路径上，中途抛错就永久停在本次传入的值；
 *   - phrases 非法时抛 TypeError，而文件已经被删。
 *
 * 运行：node --test tests/test-default-audio-ipc.js
 */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { registerDefaultAudioIPC } = require('../src/main/default-audio-ipc');

const tmpDirs = [];
afterEach(() => {
    while (tmpDirs.length) {
        try { fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* 测试目录 */ }
    }
});

function makeHarness(opts = {}) {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'l2d-default-audio-'));
    tmpDirs.push(userData);
    const audioDir = path.join(userData, 'default-audio');
    fs.mkdirSync(audioDir, { recursive: true });

    const handles = new Map();
    const ipcMain = { handle: (ch, fn) => handles.set(ch, fn), on: () => {} };
    const saved = [];
    const ttsService = {
        styleId: opts.styleId !== undefined ? opts.styleId : 7,
        isAvailable: () => opts.available !== false,
        synthesize: opts.synthesize || (() => Buffer.from('wav')),
    };

    registerDefaultAudioIPC({ ttsService }, ipcMain, {
        app: { getPath: () => userData },
        fs,
        path,
        configManager: {
            saveConfigFile: opts.saveConfigFile || (async (d) => { saved.push(d); return true; }),
        },
    });

    return {
        audioDir,
        ttsService,
        saved,
        run: (phrases, styleId) => handles.get('generate-default-audio')({}, phrases, styleId),
    };
}

const wavs = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).sort();

describe('generate-default-audio', () => {
    it('合成全部失败时，已有的默认音频必须原封不动（回归：先删后合成）', async () => {
        const h = makeHarness({ synthesize: () => { throw new Error('backend down'); } });
        fs.writeFileSync(path.join(h.audioDir, 'default_0.wav'), Buffer.from('old-0'));
        fs.writeFileSync(path.join(h.audioDir, 'default_1.wav'), Buffer.from('old-1'));

        const res = await h.run(['你好', '再见']);

        assert.strictEqual(res.success, false);
        assert.strictEqual(res.error, 'synthesis failed');
        assert.deepStrictEqual(wavs(h.audioDir), ['default_0.wav', 'default_1.wav'],
            '合成失败不该把旧的默认音频删掉');
        assert.strictEqual(fs.readFileSync(path.join(h.audioDir, 'default_0.wav'), 'utf8'), 'old-0');
    });

    it('synthesize 返回 null 也算失败，同样保留旧文件', async () => {
        const h = makeHarness({ synthesize: () => null });
        fs.writeFileSync(path.join(h.audioDir, 'default_0.wav'), Buffer.from('old'));
        const res = await h.run(['甲']);
        assert.strictEqual(res.success, false);
        assert.deepStrictEqual(wavs(h.audioDir), ['default_0.wav']);
    });

    it('合成抛错后 styleId 必须恢复（回归：只在成功路径恢复）', async () => {
        const h = makeHarness({ styleId: 7, synthesize: () => { throw new Error('boom'); } });
        await h.run(['甲'], 42);
        assert.strictEqual(h.ttsService.styleId, 7, 'styleId 不该被一次失败的生成永久改掉');
    });

    it('phrases 非法时干净报错，且不动已有文件（回归：TypeError 之前文件已被删）', async () => {
        const h = makeHarness();
        fs.writeFileSync(path.join(h.audioDir, 'default_0.wav'), Buffer.from('old'));

        for (const bad of [undefined, null, 'not-an-array', []]) {
            const res = await h.run(bad, 1);
            assert.strictEqual(res.success, false);
            assert.strictEqual(res.error, 'no phrases');
            assert.deepStrictEqual(wavs(h.audioDir), ['default_0.wav'], `输入 ${String(bad)} 时不该删文件`);
        }
        assert.strictEqual(h.ttsService.styleId, 7);
    });

    it('全部成功时替换成新的音频集合，并落盘 defaultPhrases', async () => {
        const h = makeHarness({ synthesize: (t) => Buffer.from('wav:' + t) });
        fs.writeFileSync(path.join(h.audioDir, 'default_9.wav'), Buffer.from('stale'));

        const res = await h.run(['甲', '乙']);

        assert.strictEqual(res.success, true);
        assert.deepStrictEqual(wavs(h.audioDir), ['default_0.wav', 'default_1.wav'], '陈旧的 default_9 应被清掉');
        assert.strictEqual(fs.readFileSync(path.join(h.audioDir, 'default_1.wav'), 'utf8'), 'wav:乙');
        assert.deepStrictEqual(h.saved, [{ tts: { defaultPhrases: ['甲', '乙'] } }]);
    });

    it('部分失败时写入成功的那几条，并如实报告每一条的结果', async () => {
        const h = makeHarness({ synthesize: (t) => (t === '坏' ? null : Buffer.from('wav:' + t)) });
        const res = await h.run(['好', '坏', '也好']);
        assert.strictEqual(res.success, true);
        assert.deepStrictEqual(res.results.map((r) => r.success), [true, false, true]);
        assert.deepStrictEqual(wavs(h.audioDir), ['default_0.wav', 'default_2.wav']);
    });

    it('并发调用被挡下（回归：两次运行会互相踩 styleId）', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const h = makeHarness({
            saveConfigFile: async () => { await gate; return true; },
            synthesize: (t) => Buffer.from('wav:' + t),
        });

        const first = h.run(['甲']);
        await new Promise((r) => setTimeout(r, 5));   // 让第一次走到 saveConfigFile
        const second = await h.run(['乙']);
        assert.strictEqual(second.success, false);
        assert.strictEqual(second.error, 'already generating');

        release();
        assert.strictEqual((await first).success, true);
        assert.strictEqual(h.ttsService.styleId, 7);
    });

    it('TTS 不可用时直接返回错误，不碰磁盘', async () => {
        const h = makeHarness({ available: false });
        fs.writeFileSync(path.join(h.audioDir, 'default_0.wav'), Buffer.from('old'));
        const res = await h.run(['甲']);
        assert.strictEqual(res.success, false);
        assert.strictEqual(res.error, 'TTS not available');
        assert.deepStrictEqual(wavs(h.audioDir), ['default_0.wav']);
    });
});
