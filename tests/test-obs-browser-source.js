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

function makeFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-bs-'));
    fs.writeFileSync(path.join(root, 'desktop-pet.html'), '<html><body>pet</body></html>');
    const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-bs-model-'));
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
    return { source, root, modelDir };
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

    it('reports running only after listen() has bound a port', async () => {
        const { source } = makeFixture();
        assert.strictEqual(source.status.running, false);
        const res = await source.start(0);
        assert.ok(res.port > 0, 'a started server must report a real port');
        assert.strictEqual(source.status.port, res.port);
        source.stop();
    });
});
