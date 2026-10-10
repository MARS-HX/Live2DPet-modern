/**
 * asr-ipc 安装流程的回归用例。
 *
 * 旧的 asr-install 把外壳赋值写成 `installing = (async () => { ... finally { installing = null } })()`。
 * 当 native 与 model 都已安装时，async 函数体内一个 await 都没有，于是它内部的
 * finally 在**赋值之前**就同步跑完并把 installing 清成 null，紧接着外壳赋值又把这个
 * 已 resolve 的 Promise 写回 installing —— 而且再也不会被清空。后果：此后每次
 * asr-install 都直接返回那一次的快照，不再重新检测。
 *
 * 运行：node --test tests/test-asr-ipc.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');

const { registerAsrIPC } = require('../src/main/asr-ipc');

function makeHarness(state, hooks = {}) {
    const handles = new Map();
    const ipcMain = { handle: (ch, fn) => handles.set(ch, fn), on: () => {} };
    const calls = { nativeInstall: 0, modelInstall: 0 };

    registerAsrIPC({}, ipcMain, {
        app: { getPath: () => '/tmp/live2dpet-asr-test' },
        configManager: {},
        logger: { log() {}, warn() {}, error() {} },
        nativeStatus: () => ({ installed: state.nativeInstalled, missing: [], url: 'native://' }),
        modelStatus: () => ({ installed: state.modelInstalled, url: 'model://', approxBytes: 1 }),
        installNativeLib: async () => {
            calls.nativeInstall += 1;
            if (hooks.onNativeInstall) await hooks.onNativeInstall();
            state.nativeInstalled = true;
        },
        downloadAndInstall: async () => {
            calls.modelInstall += 1;
            if (hooks.onModelInstall) await hooks.onModelInstall();
            state.modelInstalled = true;
        },
    });

    return { handles, calls, state, install: () => handles.get('asr-install')() };
}

describe('asr-install', () => {
    it('已全部安装时不会缓存陈旧结果（回归：installing 卡着一个已 resolve 的 Promise）', async () => {
        const h = makeHarness({ nativeInstalled: true, modelInstalled: true });

        const first = await h.install();
        assert.strictEqual(first.success, true);
        assert.strictEqual(first.modelInstalled, true);

        // 用户手动删掉模型之后再次点击安装：必须重新检测并真的去装
        h.state.modelInstalled = false;
        const second = await h.install();

        assert.strictEqual(h.calls.modelInstall, 1,
            '第二次必须真的执行安装，而不是返回上一次留下的快照');
        assert.strictEqual(second.success, true);
        assert.strictEqual(second.modelInstalled, true);
    });

    it('缺什么装什么', async () => {
        const h = makeHarness({ nativeInstalled: false, modelInstalled: false });
        const res = await h.install();
        assert.strictEqual(res.success, true);
        assert.strictEqual(h.calls.nativeInstall, 1);
        assert.strictEqual(h.calls.modelInstall, 1);
    });

    it('并发调用共用同一次安装', async () => {
        const h = makeHarness({ nativeInstalled: true, modelInstalled: false }, {
            onModelInstall: () => new Promise((r) => setTimeout(r, 10)),
        });
        const [a, b] = await Promise.all([h.install(), h.install()]);
        assert.strictEqual(h.calls.modelInstall, 1, '并发点击不该装两遍');
        assert.strictEqual(a.success, true);
        assert.strictEqual(b.success, true);
    });

    it('安装失败后可以重试（installing 必须被放掉）', async () => {
        let fail = true;
        const h = makeHarness({ nativeInstalled: true, modelInstalled: false }, {
            onModelInstall: async () => {
                if (fail) { fail = false; throw new Error('network down'); }
            },
        });

        const first = await h.install();
        assert.strictEqual(first.success, false);
        assert.match(first.error, /network down/);

        const second = await h.install();
        assert.strictEqual(h.calls.modelInstall, 2, '失败之后必须能重试');
        assert.strictEqual(second.success, true);
    });
});
