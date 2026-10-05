/**
 * Tests for the OBS Browser Source server.
 *
 * Run with: node --test tests/test-obs-server.js
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { createObsServer, sanitizeConfig, resolveWithin } = require('../src/main/obs-server');

describe('sanitizeConfig', () => {
    it('blanks every credential-shaped field', () => {
        const out = sanitizeConfig({
            apiKey: 'sk-live-secret',
            baseURL: 'https://example.com',
            tts: { mimo: { apiKey: 'sk-tts' }, serviceType: 'mimo' },
            bilibili: { cookie: 'SESSDATA=abc', roomId: '5440' },
            dsh: { apiKey: '', model: 'x' },
        });
        assert.strictEqual(out.apiKey, '');
        assert.strictEqual(out.tts.mimo.apiKey, '');
        assert.strictEqual(out.bilibili.cookie, '');
        assert.strictEqual(out.dsh.apiKey, '');
        // non-secret values must survive
        assert.strictEqual(out.baseURL, 'https://example.com');
        assert.strictEqual(out.tts.serviceType, 'mimo');
        assert.strictEqual(out.bilibili.roomId, '5440');
    });

    it('does not mutate the original object', () => {
        const cfg = { apiKey: 'secret' };
        sanitizeConfig(cfg);
        assert.strictEqual(cfg.apiKey, 'secret');
    });

    it('handles arrays and nulls', () => {
        const out = sanitizeConfig({ list: [{ apiKey: 'a' }, null], n: null });
        assert.strictEqual(out.list[0].apiKey, '');
        assert.strictEqual(out.list[1], null);
        assert.strictEqual(out.n, null);
    });

    it('never leaves a secret anywhere in the serialized output', () => {
        const json = JSON.stringify(sanitizeConfig({
            apiKey: 'sk-SECRET-1', tts: { aliyun: { apiKey: 'sk-SECRET-2' } },
            bilibili: { cookie: 'SESSDATA=SECRET-3' },
        }));
        assert.ok(!json.includes('SECRET-1'));
        assert.ok(!json.includes('SECRET-2'));
        assert.ok(!json.includes('SECRET-3'));
    });
});

describe('resolveWithin', () => {
    const root = path.resolve('/srv/app');

    it('resolves normal paths inside the root', () => {
        assert.strictEqual(resolveWithin(root, '/src/a.js'), path.join(root, 'src', 'a.js'));
    });

    it('refuses traversal out of the root', () => {
        assert.strictEqual(resolveWithin(root, '/../../etc/passwd'), null);
        assert.strictEqual(resolveWithin(root, '/src/../../../etc/passwd'), null);
    });

    it('refuses encoded traversal', () => {
        assert.strictEqual(resolveWithin(root, '/%2e%2e/%2e%2e/etc/passwd'), null);
    });

    it('ignores the query string', () => {
        assert.strictEqual(resolveWithin(root, '/src/a.js?v=2'), path.join(root, 'src', 'a.js'));
    });
});

describe('createObsServer', () => {
    let root, modelDir, server, baseUrl;

    before(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-srv-'));
        modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-model-'));
        fs.writeFileSync(path.join(root, 'desktop-pet.html'), '<html><body><h1>pet</h1></body></html>');
        fs.mkdirSync(path.join(root, 'libs'));
        fs.writeFileSync(path.join(root, 'libs', 'pixi.min.js'), '// pixi');
        fs.mkdirSync(path.join(root, 'src', 'renderer'), { recursive: true });
        fs.writeFileSync(path.join(root, 'src', 'renderer', 'obs-shim.js'), '// shim');
        fs.writeFileSync(path.join(modelDir, 'm.model3.json'), '{"ok":true}');

        server = createObsServer({
            http, fs, path, ws: require('ws'),
            rootDir: root,
            getConfig: () => ({ apiKey: 'sk-SECRET', bilibili: { cookie: 'SESSDATA=x' }, model: { type: 'live2d' } }),
            getModelDir: () => modelDir,
            logger: { log() {}, warn() {}, error() {} },
        });
        const res = await server.start(0);
        baseUrl = `http://127.0.0.1:${res.port}`;
    });

    after(() => { server.close(); });

    const get = (p) => new Promise((resolve) => {
        http.get(baseUrl + p, (res) => {
            let d = '';
            res.on('data', (c) => d += c);
            res.on('end', () => resolve({ status: res.statusCode, body: d }));
        }).on('error', () => resolve({ status: 0, body: '' }));
    });

    it('binds to loopback and reports a url', () => {
        assert.match(server.url(), /^http:\/\/127\.0\.0\.1:\d+\/obs$/);
    });

    it('serves the real pet page with the shim injected first', async () => {
        const res = await get('/obs');
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.includes('<h1>pet</h1>'), 'the real page is served');
        assert.ok(res.body.includes('obs-shim.js'), 'the shim is injected');
        assert.ok(res.body.indexOf('obs-shim.js') < res.body.indexOf('<h1>'),
            'the shim must run before the page body');
    });

    it('serves app assets', async () => {
        const res = await get('/libs/pixi.min.js');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body, '// pixi');
    });

    it('serves the live2d model from its own directory', async () => {
        const res = await get('/model/m.model3.json');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body, '{"ok":true}');
    });

    it('never exposes credentials through /api/config', async () => {
        const res = await get('/api/config');
        assert.strictEqual(res.status, 200);
        assert.ok(!res.body.includes('sk-SECRET'));
        assert.ok(!res.body.includes('SESSDATA'));
        assert.ok(res.body.includes('live2d'), 'non-secret config still travels');
    });

    it('refuses directory traversal', async () => {
        const res = await get('/libs/../../../etc/passwd');
        assert.ok(res.status === 403 || res.status === 404, `expected refusal, got ${res.status}`);
    });

    it('rejects requests with a foreign Host header', async () => {
        const res = await new Promise((resolve) => {
            const req = http.request({ host: '127.0.0.1', port: server.port, path: '/api/config',
                headers: { Host: 'evil.example.com' } }, (r) => {
                let d = ''; r.on('data', (c) => d += c); r.on('end', () => resolve({ status: r.statusCode }));
            });
            req.on('error', () => resolve({ status: 0 }));
            req.end();
        });
        assert.strictEqual(res.status, 403);
    });

    it('delivers broadcast events to a connected browser source', async () => {
        const WebSocket = require('ws');
        const sock = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
        const seen = [];
        // Attach before 'open': the server pushes `init` the moment it accepts,
        // and an EventEmitter drops messages that arrive with no listener.
        sock.on('message', (m) => seen.push(JSON.parse(m.toString())));
        await new Promise((r) => sock.on('open', r));
        await new Promise((r) => setTimeout(r, 200));   // let the init message land

        server.broadcast('play-expression', ['兴奋']);
        server.broadcast('talking-state-changed', [true]);
        await new Promise((r) => setTimeout(r, 200));

        const names = seen.map((s) => s.channel);
        assert.ok(names.includes('init'), 'a late client gets the config first');
        assert.ok(names.includes('play-expression'), 'expressions are mirrored');
        assert.ok(names.includes('talking-state-changed'), 'talking state is mirrored');
        assert.deepStrictEqual(seen.find((s) => s.channel === 'play-expression').args, ['兴奋']);

        // the init payload must not leak credentials either
        const init = JSON.stringify(seen.find((s) => s.channel === 'init'));
        assert.ok(!init.includes('sk-SECRET'));
        sock.close();
    });

    it('stop() closes the port', async () => {
        const s2 = createObsServer({ http, fs, path, ws: require('ws'), rootDir: root,
            getConfig: () => ({}), getModelDir: () => modelDir, logger: { log() {} } });
        const r = await s2.start(0);
        assert.ok(r.port > 0);
        s2.close();
        assert.strictEqual(s2.running, false);
    });
});
