/**
 * bilibili-ipc 状态推送节流的回归用例。
 *
 * 旧实现是纯领先沿节流：`if (now - lastStatusPush < 500) return;` 把窗口内的
 * 事件直接丢掉，没有任何补发。于是一串快速状态变化里**最后那个**（也就是终态）
 * 会永久消失 —— 典型是「刚连上」之后紧跟着「鉴权失败 / 掉线」，settings 面板
 * 会一直显示已连接，而实际连接早就没了。
 *
 * 运行：node --test tests/test-bilibili-ipc.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');

// broadcast() 在函数体内懒加载 electron：往 require 缓存里预置一个桩，
// 就能在纯 Node 下验证它的推送行为。
const sent = [];
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
        BrowserWindow: {
            getAllWindows: () => [
                { webContents: { send: (ch, payload) => sent.push({ ch, payload }) } },
            ],
        },
    },
};

const { registerBilibiliIPC } = require('../src/main/bilibili-ipc');

function makeHarness() {
    const ctx = {};
    const handles = new Map();
    const ipcMain = { handle: (ch, fn) => handles.set(ch, fn), on: () => {} };
    registerBilibiliIPC(ctx, ipcMain, {
        configManager: {
            loadConfigFile: async () => ({ bilibili: {} }),
            saveConfigFile: async () => true,
        },
        app: { whenReady: () => Promise.resolve(), on: () => {} },
    });
    return { client: ctx.biliDanmaku, handles };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('bilibili-ipc 状态推送节流', () => {
    it('节流窗口内后到的状态必须被补发（回归：终态被永久丢弃）', async () => {
        const { client } = makeHarness();
        sent.length = 0;

        client._emitStatus();                 // 领先沿：立刻推送
        assert.strictEqual(sent.length, 1);

        client._emitStatus();                 // 落在窗口内 —— 旧实现直接丢弃
        assert.strictEqual(sent.length, 1, '窗口内不应立刻再推一次');

        await sleep(620);
        assert.strictEqual(sent.length, 2, '窗口结束后必须把最后那个状态补发出去');
        assert.ok(sent.every((s) => s.ch === 'bili://status'));
    });

    it('停止之后不再补发遗留状态（否则界面会继续显示已连接）', async () => {
        const { client, handles } = makeHarness();
        sent.length = 0;

        client._emitStatus();                 // 立即推
        client._emitStatus();                 // 挂起，等补发
        await handles.get('bili-stop')();

        await sleep(620);
        assert.strictEqual(sent.length, 1, 'stop 之后不该再有补发');
    });

    it('间隔足够时每个状态都立即推送', async () => {
        const { client } = makeHarness();
        sent.length = 0;
        client._emitStatus();
        await sleep(520);
        client._emitStatus();
        assert.strictEqual(sent.length, 2);
    });
});
