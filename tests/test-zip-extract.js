/**
 * Tests for the dependency-free ZIP extractor used to unpack the Vosk model.
 * Run with: node --test tests/test-zip-extract.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { extractZip, listEntries, isUnsafeName } = require('../src/main/zip-extract');

/** Build a real zip in memory (stored or deflated entries). */
function makeZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const e of entries) {
        const name = Buffer.from(e.name, 'utf8');
        const data = Buffer.from(e.data || '', 'utf8');
        const deflated = e.method === 8;
        const body = deflated ? zlib.deflateRawSync(data) : data;
        const crc = zlib.crc32 ? zlib.crc32(data) >>> 0 : 0;   // optional field

        const local = Buffer.alloc(30 + name.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(deflated ? 8 : 0, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        name.copy(local, 30);
        locals.push(local, body);

        const central = Buffer.alloc(46 + name.length);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(deflated ? 8 : 0, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(0, 38);                    // external attrs
        central.writeUInt32LE(offset, 42);
        name.copy(central, 46);
        centrals.push(central);

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

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'zipx-')); }

describe('isUnsafeName', () => {
    it('allows ordinary nested paths', () => {
        assert.strictEqual(isUnsafeName('am/model/file.txt'), false);
    });
    it('rejects traversal, absolute paths and drive letters', () => {
        assert.strictEqual(isUnsafeName('../evil.txt'), true);
        assert.strictEqual(isUnsafeName('a/../../evil.txt'), true);
        assert.strictEqual(isUnsafeName('/etc/passwd'), true);
        assert.strictEqual(isUnsafeName('C:\\Windows\\evil'), true);
        assert.strictEqual(isUnsafeName('a\\..\\..\\evil'), true);
        assert.strictEqual(isUnsafeName(''), true);
    });
});

describe('extractZip', () => {
    it('extracts stored entries', () => {
        const buf = makeZip([
            { name: 'model/', method: 0, data: '' },
            { name: 'model/a.txt', method: 0, data: 'hello' },
        ]);
        const dir = tmp();
        const res = extractZip(buf, dir);
        assert.strictEqual(res.files, 1);
        assert.strictEqual(fs.readFileSync(path.join(dir, 'model/a.txt'), 'utf8'), 'hello');
    });

    it('extracts deflated entries (what a real model archive uses)', () => {
        const payload = '语音模型数据'.repeat(200);
        const buf = makeZip([{ name: 'am/final.mdl', method: 8, data: payload }]);
        const dir = tmp();
        extractZip(buf, dir);
        assert.strictEqual(fs.readFileSync(path.join(dir, 'am/final.mdl'), 'utf8'), payload);
    });

    it('creates nested directories', () => {
        const buf = makeZip([{ name: 'a/b/c/d.txt', method: 8, data: 'x' }]);
        const dir = tmp();
        extractZip(buf, dir);
        assert.ok(fs.existsSync(path.join(dir, 'a/b/c/d.txt')));
    });

    it('refuses to write outside the destination', () => {
        const buf = makeZip([
            { name: '../escape.txt', method: 0, data: 'nope' },
            { name: 'ok.txt', method: 0, data: 'yes' },
        ]);
        const dir = tmp();
        const res = extractZip(buf, dir);
        assert.deepStrictEqual(res.skipped, ['../escape.txt']);
        assert.ok(!fs.existsSync(path.join(path.dirname(dir), 'escape.txt')), 'nothing escaped');
        assert.ok(fs.existsSync(path.join(dir, 'ok.txt')), 'legitimate entry still extracted');
    });

    it('rejects a buffer that is not a zip', () => {
        assert.throws(() => extractZip(Buffer.from('definitely not a zip'), tmp()), /not_a_zip/);
    });

    it('reports an unsupported compression method instead of guessing', () => {
        const buf = makeZip([{ name: 'a.txt', method: 0, data: 'x' }]);
        // Patch the method to something we do not implement (e.g. bzip2 = 12).
        const entries = listEntries(buf);
        assert.strictEqual(entries.length, 1);
        const eocd = buf.length - 22;
        const cen = buf.readUInt32LE(eocd + 16);
        buf.writeUInt16LE(12, cen + 10);
        const dir = tmp();
        assert.throws(() => extractZip(buf, dir), /unsupported_compression_method:12/);
    });
});
