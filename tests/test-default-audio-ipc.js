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

    it('生成过程中途失败后 styleId 必须恢复（回归：恢复只写在成功路径上）', async () => {
        // 注意：synthesize 自身抛的异常会被逐句 try/catch 吞掉，旧实现末尾照样恢复 styleId，
        // 所以那种失败区分不出新旧实现（这条用例先前正是被证伪的那一条）。
        // 这里用能逃出内层 catch 的失败：phrases 非法时，旧实现是在 try 内部读
        // phrases.length 才抛的 —— 那时 styleId 已经被改成 42 了。
        const h = makeHarness({ styleId: 7, synthesize: () => Buffer.from('wav') });
        const res = await h.run(undefined, 42);
        assert.strictEqual(res.success, false);
        assert.strictEqual(h.ttsService.styleId, 7, 'styleId 不该停在本次传入的值上');
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
        // 第二次也要套 race：旧实现没有闸门，它会 await 同一个门，直接把测试挂死
        // （挂死比失败更糟 —— node:test 要等事件循环空下来才打印总结，整个套件会看起来卡住）。
        const second = await Promise.race([
            h.run(['乙']),
            new Promise((r) => { setTimeout(() => r({ success: 'TIMEOUT' }), 300); }),
        ]);
        assert.notStrictEqual(second.success, 'TIMEOUT', '第二次不该进入合成');
        assert.strictEqual(second.success, false);
        assert.strictEqual(second.error, 'already generating');

        // 关键补充：被拒绝的那次**不能**把闸门放开。旧实现把守卫放在 try/finally 里，
        // 于是第 2 次跑 finally 把 generating 清成 false，第 3 次就会真的并发执行。
        // 用 race 兜住：旧实现下第 3 次会卡在同一个门上，这里必须判定失败而不是把测试挂死。
        const third = await Promise.race([
            h.run(['丙']),
            new Promise((r) => { setTimeout(() => r({ success: 'TIMEOUT' }), 300); }),
        ]);
        assert.notStrictEqual(third.success, 'TIMEOUT',
            '第三次调用不该进入合成（它卡住了，说明闸门被第 2 次调用放开了）');
        assert.strictEqual(third.success, false, '闸门必须仍然关着');
        assert.strictEqual(third.error, 'already generating');

        release();
        assert.strictEqual((await first).success, true);
        assert.strictEqual(h.ttsService.styleId, 7);

        // 第一次结束后闸门才该打开
        const fourth = await h.run(['丁']);
        assert.strictEqual(fourth.success, true, '前一次结束后应能再次生成');
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
