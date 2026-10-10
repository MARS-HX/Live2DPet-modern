/**
 * preload 的事件订阅必须能退订。
 *
 * 起因：`ipcRenderer.on` 本身没有解除绑定的办法，而渲染层的热重载路径
 * （保存模型配置 → 重载适配器）会重复注册同一批监听器 —— 旧的那些就永远留着，
 * 各自继续驱动一个已经从页面上消失的元素。on* 系列现在统一返回退订函数。
 *
 * 这些入口过去都不返回值，所以本用例在旧实现上会失败（返回 undefined）。
 *
 * 运行：node --test tests/test-preload-listeners.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');

const electronPath = require.resolve('electron');
const registered = [];   // [channel, handler]
const removed = [];      // [channel, handler]
let exposed = null;

// preload 在模块顶层 require('electron')，所以必须先塞好桩件再加载它。
require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
        ipcRenderer: {
            on: (channel, handler) => { registered.push([channel, handler]); },
            removeListener: (channel, handler) => { removed.push([channel, handler]); },
            invoke: async () => ({}),
            send: () => {},
        },
        contextBridge: {
            exposeInMainWorld: (key, api) => { exposed = api; },
        },
    },
};
require('../preload.js');

const onHelpers = () => Object.keys(exposed || {}).filter((k) => k.startsWith('on'));

describe('preload 事件订阅', () => {
    it('暴露了足够多的 on* 订阅入口', () => {
        assert.ok(exposed, 'contextBridge.exposeInMainWorld 应被调用');
        assert.ok(onHelpers().length >= 15, `on* 入口应有 15 个以上，实际 ${onHelpers().length}`);
    });

    it('每个 on* 都返回可用的退订函数（回归：旧实现返回 undefined）', () => {
        const offenders = [];
        for (const name of onHelpers()) {
            registered.length = 0;
            removed.length = 0;
            const ret = exposed[name](() => {});

            if (registered.length !== 1) {
                offenders.push(`${name} 注册了 ${registered.length} 个监听器（应为 1）`);
                continue;
            }
            const [channel, handler] = registered[0];
            if (typeof ret !== 'function') {
                offenders.push(`${name} 返回了 ${typeof ret}，调用方无从退订`);
                continue;
            }
            ret();
            if (removed.length !== 1) {
                offenders.push(`${name} 的退订函数没有调用 removeListener`);
                continue;
            }
            if (removed[0][0] !== channel) offenders.push(`${name} 退订的频道与注册时不一致`);
            if (removed[0][1] !== handler) offenders.push(`${name} 退订的不是同一个 handler`);
        }
        assert.deepStrictEqual(offenders, [], `这些入口需要修：\n  ${offenders.join('\n  ')}`);
    });

    it('退订只影响自己那一个监听器', () => {
        const offA = exposed.onCharacterUpdate(() => {});
        assert.strictEqual(typeof offA, 'function');
        registered.length = 0;
        const offB = exposed.onCharacterUpdate(() => {});
        const handlerB = registered[0][1];

        removed.length = 0;
        offA();
        assert.strictEqual(removed.length, 1, '退订 A 只应产生一次 removeListener');
        assert.notStrictEqual(removed[0][1], handlerB, '退掉的必须是 A 自己的 handler，不能误伤 B');
        offB();
    });

    it('invoke 型方法不受影响（改动只应波及订阅类入口）', () => {
        for (const name of ['loadConfig', 'saveConfig', 'dshRun', 'asrStart', 'openExternal']) {
            assert.strictEqual(typeof exposed[name], 'function', `缺少 ${name}`);
        }
    });
});
