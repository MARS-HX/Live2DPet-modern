/**
 * window-manager 的气泡窗口回归用例。
 *
 * 起因：`win.close()` 是**异步**的 —— 调用返回时窗口还没销毁，`closed` 之后才触发。
 * 旧实现在创建新气泡之前先把槽置 null，又把 `closed` 处理器的注册放在 await 之后，
 * 于是旧气泡的 `closed` 迟到时会无条件把**共享槽**写成 null，而此时槽里已经是新气泡：
 *   - 新气泡再也拿不到 `resize-chat-bubble`（那是它唯一的显示路径）→ 第二条回复永不出现；
 *   - `close-chat-bubble` / `resize-chat-bubble` 都因槽为 null 而空转 → 新气泡永不关闭，
 *     每个泄漏一个渲染进程（它以 show:false 创建，从没被显示过）。
 * 症状就是「每隔一条回复就消失」。
 *
 * 运行：node --test tests/test-window-manager.js
 */
const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// 每个 setup() 都会建一个 userData 临时目录；不登记清理就会往用户 %TEMP% 里丢
// （实测漏了 12 个 l2d-winmgr-*，把之前修好的目录泄漏问题又踩回去）。
const tempDirs = [];
after(() => {
    for (const dir of tempDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 测试目录 */ }
    }
});
let userDataDir = '';

class FakeBrowserWindow {
    constructor(opts = {}) {
        this.opts = opts;
        this.destroyed = false;
        this.closing = false;
        this.sent = [];
        this.handlers = new Map();
        this.visible = false;
        this.webContents = {
            send: (channel, payload) => { this.sent.push([channel, payload]); },
            session: { webRequest: { onHeadersReceived: () => { /* CSP hook */ } } },
        };
        created.push(this);
    }
    isDestroyed() { return this.destroyed; }
    /** Electron 的 close() 是异步的：这里刻意不立刻触发 closed。 */
    close() { this.closing = true; }
    /** 模拟事件循环随后投递 closed。 */
    emitClosed() {
        this.destroyed = true;
        const fn = this.handlers.get('closed');
        if (fn) fn();
    }
    on(event, fn) { this.handlers.set(event, fn); }
    loadFile() { return Promise.resolve(); }
    getBounds() { return { x: 0, y: 0, width: 300, height: 300 }; }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    show() { this.visible = true; }
    showInactive() { this.visible = true; }
    isVisible() { return this.visible; }
    focus() {}
    hide() {}
    setBounds() {}
    setPosition() {}
}

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
        screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
        app: { getPath: () => userDataDir, getAppPath: () => ROOT, isPackaged: false },
        BrowserWindow: FakeBrowserWindow,
    },
};

const { registerWindowHandlers } = require('../src/main/window-manager');

const QUIET = { log() {}, warn() {}, error() {} };

function setup() {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2d-winmgr-'));
    tempDirs.push(userDataDir);
    const ctx = { isQuitting: false, petWindow: null, chatBubbleWindow: null, settingsWindow: null };
    const handles = new Map();
    const ipcMain = { handle: (ch, fn) => handles.set(ch, fn), on: () => {} };
    const deps = {
        BrowserWindow: FakeBrowserWindow,
        path,
        basePath: ROOT,
        updateTrayMenu: () => {},
    };
    registerWindowHandlers(ctx, ipcMain, deps);
    ctx.petWindow = new FakeBrowserWindow({});
    return { ctx, handles };
}

beforeEach(() => { created = []; });

describe('show-pet-chat 气泡槽', () => {
    it('旧气泡迟到的 closed 不得抹掉新气泡（回归：第二条回复必然丢失）', async () => {
        const { ctx, handles } = setup();

        await handles.get('show-pet-chat')({}, '第一条', 8000);
        const first = ctx.chatBubbleWindow;
        assert.ok(first, '第一条消息应创建气泡');

        // 第一条还活着时来第二条
        await handles.get('show-pet-chat')({}, '第二条', 8000);
        const second = ctx.chatBubbleWindow;
        assert.notStrictEqual(second, first, '应当换成一个新气泡');
        assert.strictEqual(first.closing, true, '旧气泡应当被 close()');

        // 模拟异步投递：旧气泡的 closed 现在才到
        first.emitClosed();
        assert.strictEqual(ctx.chatBubbleWindow, second,
            '旧气泡的 closed 不能把新气泡从槽里抹掉 —— 抹掉就等于永不显示、永不关闭、消息丢失');

        // 新气泡必须真的收到消息（旧实现在这里查到 null 直接跳过）
        await new Promise((r) => setTimeout(r, 560));
        const delivered = second.sent.filter(([ch]) => ch === 'chat-bubble-message');
        assert.strictEqual(delivered.length, 1, '第二条消息必须送达新气泡');
        assert.strictEqual(delivered[0][1].message, '第二条');

        // 而且它仍然可以被关掉（旧实现里槽是 null，这个 handler 空转）
        await handles.get('close-chat-bubble')();
        assert.strictEqual(second.closing, true, '新气泡必须仍然可被关闭');
    });

    it('新气泡自己关闭时才清空槽', async () => {
        const { ctx, handles } = setup();
        await handles.get('show-pet-chat')({}, '唯一一条', 8000);
        const bubble = ctx.chatBubbleWindow;
        assert.ok(bubble);

        bubble.emitClosed();
        assert.strictEqual(ctx.chatBubbleWindow, null, '自己的 closed 应当清空槽');
    });

    it('第三条消息到来时，第二条的消息不会再发出去', async () => {
        const { ctx, handles } = setup();
        await handles.get('show-pet-chat')({}, '甲', 8000);
        const first = ctx.chatBubbleWindow;
        await handles.get('show-pet-chat')({}, '乙', 8000);
        const second = ctx.chatBubbleWindow;
        await handles.get('show-pet-chat')({}, '丙', 8000);

        await new Promise((r) => setTimeout(r, 560));
        assert.strictEqual(first.sent.filter(([c]) => c === 'chat-bubble-message').length, 0,
            '被替换掉的气泡不该再收到陈旧消息');
        assert.strictEqual(second.sent.filter(([c]) => c === 'chat-bubble-message').length, 0);
        assert.strictEqual(ctx.chatBubbleWindow.sent.filter(([c]) => c === 'chat-bubble-message').length, 1,
            '只有当前气泡该收到消息');
    });
});
