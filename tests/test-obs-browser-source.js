/**
 * Tests for the OBS browser-source wrapper.
 *
 * Regression guard: Electron structured-clones every IPC reply, so a payload
 * holding anything non-cloneable (a function, a Promise) makes the handler fail
 * with "An object could not be cloned". `server.url` is a METHOD, and returning
 * it uncalled broke obs-server-get exactly that way.
 *
 * Run with: node --test tests/test-obs-browser-source.js
 */
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { registerObsBrowserSource } = require('../src/main/obs-browser-ipc');

// Track every fixture directory so the suite stops leaving `obs-bs-*` / 
// `obs-bs-model-*` dirs in the user's %TEMP% (two per fixture, every run).
const _fixtureDirs = [];
after(() => {
    for (const dir of _fixtureDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 测试目录 */ }
    }
});

function makeFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-bs-'));
    const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-bs-model-'));
    _fixtureDirs.push(root, modelDir);
    fs.writeFileSync(path.join(root, 'desktop-pet.html'), '<html><body>pet</body></html>');
    const config = { model: { folderPath: modelDir }, apiKey: 'sk-NOPE' };

    const app = {
        isPackaged: false,
        getPath: () => root,
        on() {},
        whenReady: () => Promise.resolve(),
    };
    const configManager = {
        loadConfigFile: async () => config,
        saveConfigFile: async () => {},
    };
    const ctx = {};
    const source = registerObsBrowserSource(ctx, {
        app, http, fs, path, ws: require('ws'),
        basePath: root, configManager,
        logger: { log() {}, warn() {}, error() {} },
    });
    return { source, root, modelDir, ctx };
}

describe('registerObsBrowserSource', () => {
    const fixture = makeFixture();
    after(() => { fixture.source.stop(); });

    it('is exposed on the app context', () => {
        assert.strictEqual(typeof fixture.source.start, 'function');
        assert.strictEqual(typeof fixture.source.mirror, 'function');
    });

    it('reports a status payload that Electron can structured-clone', async () => {
        await fixture.source.start(0);
        const status = fixture.source.status;
        // The exact operation Electron performs on every IPC reply.
        assert.doesNotThrow(() => structuredClone(status),
            'a non-cloneable value here breaks the renderer with "An object could not be cloned"');
        assert.strictEqual(typeof status.url, 'string', 'url must be the STRING, not the url() function');
        assert.match(status.url, /^http:\/\/127\.0\.0\.1:\d+\/obs$/);
        assert.strictEqual(typeof status.port, 'number');
        assert.strictEqual(typeof status.clients, 'number');
        assert.strictEqual(typeof status.running, 'boolean');
    });

    it('start() also returns only cloneable primitives', async () => {
        const res = await fixture.source.start(0);
        assert.doesNotThrow(() => structuredClone(res));
        assert.strictEqual(typeof res.url, 'string');
    });

    it('status is cloneable while stopped too', () => {
        const { source } = makeFixture();
        assert.doesNotThrow(() => structuredClone(source.status));
        assert.strictEqual(source.status.url, '');
        source.stop();
    });

    it('mirror() is a no-op before the server starts', () => {
        const { source } = makeFixture();
        assert.doesNotThrow(() => source.mirror('play-expression', ['兴奋']));
        source.stop();
    });

    it('starting twice does not leak a second server on another port', async () => {
        const { source } = makeFixture();
        const [a, b] = await Promise.all([source.start(0), source.start(0)]);
        const after = source.status;
        assert.strictEqual(a.port, b.port, 'concurrent starts must share one server');
        assert.strictEqual(after.port, a.port);
        assert.strictEqual(after.running, true);
        // A later call is a plain no-op on the same port.
        const c = await source.start(0);
        assert.strictEqual(c.port, a.port);
        source.stop();
        assert.strictEqual(source.status.running, false);
    });

    it('restarting after stop() picks up a fresh server', async () => {
        const { source } = makeFixture();
        await source.start(0);
        source.stop();
        const b = await source.start(0);
        assert.match(b.url, /^http:\/\/127\.0\.0\.1:\d+\/obs$/);
        assert.strictEqual(source.status.running, true);
        source.stop();
        assert.strictEqual(source.status.running, false);
    });

    it('start→stop 竞态不会留下永不 settle 的 Promise，之后仍能重启', async () => {
        const { source } = makeFixture();
        const racing = source.start(0);
        source.stop();   // 端口还没绑定完就停

        const settled = await Promise.race([
            racing,
            new Promise((resolve) => { setTimeout(() => resolve('TIMEOUT'), 1500); }),
        ]);
        assert.notStrictEqual(settled, 'TIMEOUT',
            'start() 必须被 stop() 结算掉；否则 starting 闩锁会把那个死 Promise 一直返回，本次运行内再也起不来');

        const again = await source.start(0);
        assert.ok(again.port > 0, '竞态之后必须还能正常启动');
        assert.strictEqual(source.status.running, true);
        source.stop();
        assert.strictEqual(source.status.running, false);
    });

    it('把宠物窗口的事件镜像给浏览器源（回归：isDestroyed 被当值用导致镜像整体失效）', async () => {
        // 旧代码是 `if (!win || win.isDestroyed || win.isDestroyed()) return;` ——
        // 中间那个 win.isDestroyed 是**方法引用**（恒真），于是 installMirror 每次
        // 都在第一行返回，没有任何窗口被包装，浏览器源收不到任何宠物事件。
        const { source, ctx } = makeFixture();
        const res = await source.start(0);

        const WebSocket = require('ws');
        const sock = new WebSocket(`ws://127.0.0.1:${res.port}/ws`);
        sock.on('error', () => { /* tearing the server down resets the socket */ });
        const seen = [];
        sock.on('message', (m) => seen.push(JSON.parse(m.toString())));
        try {
            await new Promise((r) => sock.on('open', r));
            await new Promise((r) => setTimeout(r, 200));
            seen.length = 0;   // 丢掉 init

            const original = [];
            const wc = { send: (channel, ...args) => { original.push([channel, args]); } };
            ctx.petWindow = { isDestroyed: () => false, webContents: wc };
            source.installMirrors();

            // 真实调用约定：Electron 的 webContents.send(channel, ...args)，
            // 所以单个参数就是 send('play-expression', '兴奋')，不是塞一个数组进去。
            wc.send('play-expression', '兴奋');
            wc.send('talking-state-changed', true);
            await new Promise((r) => setTimeout(r, 200));

            assert.deepStrictEqual(original.length, 2, '原 send 必须被照常调用（不能被包装吃掉）');
            assert.deepStrictEqual(original[0], ['play-expression', ['兴奋']]);
            const channels = seen.map((s) => s.channel);
            assert.ok(channels.includes('play-expression'), `浏览器源应收到 play-expression，实际收到 ${JSON.stringify(channels)}`);
            assert.ok(channels.includes('talking-state-changed'));
            assert.deepStrictEqual(seen.find((s) => s.channel === 'play-expression').args, ['兴奋'],
                'OBS 侧应当收到 args=[\'兴奋\']（shim 会用它去调 emit）');

            // 幂等：重复安装不应重复发送
            source.installMirrors();
            seen.length = 0;
            wc.send('play-expression', '再试');
            await new Promise((r) => setTimeout(r, 200));
            assert.strictEqual(seen.filter((s) => s.channel === 'play-expression').length, 1, '包装两次会重复发送');
        } finally {
            // Cleanup MUST run even when an assertion throws: a live socket or listener
            // keeps the event loop alive, and node:test only prints its summary once the
            // loop drains — the whole file then looks like it hung with no output.
            try { sock.terminate(); } catch (e) { /* already gone */ }
            source.stop();
        }
    });

    it('OBS 源启动之后才创建的宠物窗也必须装上镜像（回归：构造期事件早于赋值）', async () => {
        // 真实顺序是 `ctx.petWindow = new BrowserWindow(...)`，而 browser-window-created
        // 是在**构造期间**同步发出的 —— 那时 ctx.petWindow 还没赋值。旧代码当场比较身份，
        // 于是永远比不中：宠物窗、气泡窗一个都不会被包装，OBS 里什么动作都看不到。
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-late-'));
        const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-late-model-'));
        _fixtureDirs.push(root, modelDir);
        fs.writeFileSync(path.join(root, 'desktop-pet.html'), '<html><body>pet</body></html>');

        const handlers = {};
        const app = {
            isPackaged: false,
            getPath: () => root,
            on: (evt, cb) => { handlers[evt] = cb; },
            whenReady: () => Promise.resolve(),
        };
        const ctx = {};
        const source = registerObsBrowserSource(ctx, {
            app, http, fs, path, ws: require('ws'), basePath: root,
            configManager: {
                loadConfigFile: async () => ({ model: { folderPath: modelDir } }),
                saveConfigFile: async () => {},
            },
            logger: { log() {}, warn() {}, error() {} },
        });
        const res = await source.start(0);
        assert.ok(res.port, 'OBS 源应当起来');

        const WebSocket = require('ws');
        const sock = new WebSocket(`ws://127.0.0.1:${res.port}/ws`);
        sock.on('error', () => { /* 拆服务器时会被重置 */ });
        const seen = [];
        sock.on('message', (m) => seen.push(JSON.parse(m.toString())));
        try {
            await new Promise((r) => sock.on('open', r));
            await new Promise((r) => setTimeout(r, 150));
            seen.length = 0;   // 丢掉 init

            const sent = [];
            const win = {
                isDestroyed: () => false,
                webContents: { send: (ch, ...args) => sent.push([ch, ...args]) },
            };
            // ★ 先发事件（此刻 ctx.petWindow 还是空的），再赋值 —— 与真实顺序一致
            handlers['browser-window-created']({}, win);
            ctx.petWindow = win;
            await new Promise((r) => setImmediate(r));
            await new Promise((r) => setImmediate(r));

            win.webContents.send('play-expression', '兴奋');
            await new Promise((r) => setTimeout(r, 200));

            assert.strictEqual(sent.length, 1, '原 send 必须照常调用');
            assert.ok(seen.some((s) => s.channel === 'play-expression'),
                `后创建的宠物窗必须被镜像；实际收到 ${JSON.stringify(seen.map((s) => s.channel))}`);
        } finally {
            try { sock.terminate(); } catch (e) { /* 已经断了 */ }
            source.stop();
        }
    });

    it('reports running only after listen() has bound a port', async () => {
        const { source } = makeFixture();
        assert.strictEqual(source.status.running, false);
        const res = await source.start(0);
        assert.ok(res.port > 0, 'a started server must report a real port');
        assert.strictEqual(source.status.port, res.port);
        source.stop();
    });
});
