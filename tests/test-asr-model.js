/**
 * Tests for offline ASR model download + install.
 *
 * The download test runs against a real local HTTP server serving a synthetic
 * zip, so the whole path (redirect-free GET -> stream to disk -> extract ->
 * verify) is exercised without touching the internet.
 *
 * Run with: node --test tests/test-asr-model.js
 */
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const http = require('http');

const {
    MODEL, modelsRoot, modelDir, verifyModelDir, findModelRoot,
    modelStatus, downloadFile, installModel, downloadAndInstall,
} = require('../src/main/asr-model');

const QUIET = { log() {}, warn() {}, error() {} };

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'asr-')); }

/** A minimal but structurally valid Vosk model tree. */
function modelFiles(prefix = 'vosk-model-small-cn-0.22/') {
    return [
        { name: `${prefix}README`, data: 'readme' },
        { name: `${prefix}am/final.mdl`, data: 'mdl' },
        { name: `${prefix}conf/model.conf`, data: 'cfg' },
        { name: `${prefix}graph/HCLr.fst`, data: 'fst' },
    ];
}

function makeZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(e.name, 'utf8');
        const data = Buffer.from(e.data || '', 'utf8');
        const body = zlib.deflateRawSync(data);
        const local = Buffer.alloc(30 + name.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(8, 8);            // deflate
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        name.copy(local, 30);
        locals.push(local, body);

        const cen = Buffer.alloc(46 + name.length);
        cen.writeUInt32LE(0x02014b50, 0);
        cen.writeUInt16LE(20, 4);
        cen.writeUInt16LE(20, 6);
        cen.writeUInt16LE(8, 10);
        cen.writeUInt32LE(body.length, 20);
        cen.writeUInt32LE(data.length, 24);
        cen.writeUInt16LE(name.length, 28);
        cen.writeUInt32LE(offset, 42);
        name.copy(cen, 46);
        centrals.push(cen);
        offset += local.length + body.length;
    }
    const centralBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBuf, eocd]);
}

describe('model paths', () => {
    it('keeps models under userData, never in the app directory', () => {
        const root = modelsRoot('/ud', path);
        assert.ok(root.startsWith('/ud') || root.includes('ud'));
        assert.ok(modelDir('/ud', path).endsWith(MODEL.name));
    });

    it('advertises the small Chinese model', () => {
        assert.match(MODEL.url, /^https:\/\/alphacephei\.com\/vosk\/models\//);
        assert.ok(MODEL.approxBytes > 10 * 1024 * 1024);
    });
});

describe('verifyModelDir / findModelRoot', () => {
    it('reports exactly what is missing in an empty directory', () => {
        const res = verifyModelDir(tmp(), { fs, path });
        assert.strictEqual(res.ok, false);
        assert.deepStrictEqual(res.missing, ['am/', 'conf/', 'graph/', 'am/final.mdl']);
    });

    it('accepts a complete model tree', () => {
        const dir = tmp();
        for (const f of modelFiles('')) {
            const p = path.join(dir, f.name);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, f.data);
        }
        assert.strictEqual(verifyModelDir(dir, { fs, path }).ok, true);
    });

    it('finds the model inside the archive’s wrapper folder', () => {
        const dir = tmp();
        fs.mkdirSync(path.join(dir, MODEL.name, 'am'), { recursive: true });
        fs.mkdirSync(path.join(dir, MODEL.name, 'conf'), { recursive: true });
        fs.mkdirSync(path.join(dir, MODEL.name, 'graph'), { recursive: true });
        fs.writeFileSync(path.join(dir, MODEL.name, 'am', 'final.mdl'), 'x');
        assert.strictEqual(findModelRoot(dir, { fs, path }), path.join(dir, MODEL.name));
    });

    it('returns null for a directory that is not a model', () => {
        const dir = tmp();
        fs.writeFileSync(path.join(dir, 'random.txt'), 'x');
        assert.strictEqual(findModelRoot(dir, { fs, path }), null);
    });

    it('reports not-installed before anything is downloaded', () => {
        const st = modelStatus(tmp(), { fs, path });
        assert.strictEqual(st.installed, false);
    });
});

describe('installModel', () => {
    it('installs a good archive and removes the zip', () => {
        const dir = tmp();
        const zip = path.join(dir, 'm.zip');
        fs.writeFileSync(zip, makeZip(modelFiles()));

        const dest = path.join(dir, MODEL.name);
        const res = installModel(zip, dest, { fs, path, zlib, logger: QUIET });
        assert.strictEqual(res.ok, true, `missing: ${res.missing}`);
        assert.strictEqual(res.extracted, 4);
        // The archive wraps everything in a folder, so the usable model lives at
        // res.dir (which is not necessarily `dest` itself).
        assert.ok(fs.existsSync(path.join(res.dir, 'am', 'final.mdl')));
        assert.strictEqual(fs.existsSync(zip), false, 'the archive is cleaned up');
    });

    it('refuses a broken archive and leaves no half-install behind', () => {
        const dir = tmp();
        const zip = path.join(dir, 'bad.zip');
        fs.writeFileSync(zip, makeZip([{ name: 'not-a-model/readme.txt', data: 'x' }]));

        const dest = path.join(dir, MODEL.name);
        assert.throws(() => installModel(zip, dest, { fs, path, zlib, logger: QUIET }), /model_incomplete/);
        assert.strictEqual(fs.existsSync(dest), false,
            'a failed install must not leave a directory that looks installed');
    });

    it('skips unsafe entries instead of writing outside the folder', () => {
        const dir = tmp();
        const zip = path.join(dir, 'm.zip');
        fs.writeFileSync(zip, makeZip([
            { name: '../escape.txt', data: 'nope' },
            ...modelFiles(),
        ]));
        const dest = path.join(dir, MODEL.name);
        const res = installModel(zip, dest, { fs, path, zlib, logger: QUIET });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.skipped, 1);
        assert.strictEqual(fs.existsSync(path.join(dir, 'escape.txt')), false);
    });
});

describe('downloadFile', () => {
    let server;
    after(() => { if (server) server.close(); });

    function serve(payload, { status = 200, redirect = null, delayMs = 0 } = {}) {
        return new Promise((resolve) => {
            server = http.createServer((req, res) => {
                // Only bounce the *first* path, otherwise the redirect target
                // redirects again and the client correctly gives up.
                if (redirect && req.url !== redirect) {
                    res.writeHead(302, { Location: redirect });
                    res.end();
                    return;
                }
                res.writeHead(status, { 'Content-Length': payload.length });
                if (delayMs) { setTimeout(() => res.end(payload), delayMs); return; }
                res.end(payload);
            });
            server.listen(0, '127.0.0.1', () => resolve(server.address().port));
        });
    }

    it('streams a file to disk and reports progress', async () => {
        const payload = Buffer.alloc(64 * 1024, 7);
        const port = await serve(payload);
        const dir = tmp();
        const dest = path.join(dir, 'nested', 'out.bin');
        const seen = [];

        const res = await downloadFile(`http://127.0.0.1:${port}/m.zip`, dest, {
            fs, path, http, onProgress: (frac) => seen.push(frac),
        });
        assert.strictEqual(res.bytes, payload.length);
        assert.strictEqual(fs.readFileSync(dest).length, payload.length);
        assert.ok(seen.length > 0, 'progress was reported');
        assert.ok(seen[seen.length - 1] > 0.9);
        assert.strictEqual(fs.existsSync(`${dest}.part`), false, 'no temp file left');
        server.close(); server = null;
    });

    it('follows redirects', async () => {
        const payload = Buffer.from('redirected-payload');
        const port = await serve(payload, { redirect: '/real.zip' });
        const dir = tmp();
        const dest = path.join(dir, 'out.bin');
        await downloadFile(`http://127.0.0.1:${port}/start.zip`, dest, { fs, path, http });
        assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'redirected-payload');
        server.close(); server = null;
    });

    it('fails loudly on an HTTP error instead of writing a bad file', async () => {
        const port = await serve(Buffer.from('nope'), { status: 404 });
        const dir = tmp();
        const dest = path.join(dir, 'out.bin');
        await assert.rejects(
            () => downloadFile(`http://127.0.0.1:${port}/missing.zip`, dest, { fs, path, http }),
            /http_404/);
        assert.strictEqual(fs.existsSync(dest), false);
        server.close(); server = null;
    });

    it('rejects a malformed url', async () => {
        await assert.rejects(() => downloadFile('not-a-url', path.join(tmp(), 'x'), { fs, path, http }),
            /bad_url/);
    });
});

describe('downloadAndInstall', () => {
    let server;
    after(() => { if (server) server.close(); });

    it('goes from a url to a verified model directory', async () => {
        const payload = makeZip(modelFiles());
        const port = await new Promise((resolve) => {
            server = http.createServer((req, res) => {
                res.writeHead(200, { 'Content-Length': payload.length });
                res.end(payload);
            });
            server.listen(0, '127.0.0.1', () => resolve(server.address().port));
        });

        const userData = tmp();
        // Point the module at the local server by overriding MODEL.url for this run.
        const original = MODEL.url;
        MODEL.url = `http://127.0.0.1:${port}/model.zip`;
        try {
            const res = await downloadAndInstall(userData, { fs, path, zlib, http, logger: QUIET });
            assert.strictEqual(res.ok, true, `missing: ${res.missing}`);
            assert.ok(res.bytes > 0);
            assert.strictEqual(modelStatus(userData, { fs, path }).installed, true);
        } finally {
            MODEL.url = original;
            server.close(); server = null;
        }
    });
});
