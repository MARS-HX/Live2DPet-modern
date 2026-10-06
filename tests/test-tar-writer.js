/**
 * Tests for the tar writer used to hand the ASR model to the WASM engine.
 *
 * The archive is verified by actually extracting it with Windows' bundled tar,
 * so this checks the bytes against a real implementation rather than against
 * my own assumptions.
 *
 * Run with: node --test tests/test-tar-writer.js
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { buildTar, entriesFromDirectory, splitName, octalField, BLOCK } = require('../src/main/tar-writer');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tar-')); }

/** Is a working `tar` available? (Windows 10+ ships one.) */
let tarExe = null;
try { execFileSync('tar', ['--version'], { stdio: 'ignore' }); tarExe = 'tar'; } catch { tarExe = null; }

describe('octalField', () => {
    it('writes NUL-terminated octal', () => {
        assert.strictEqual(octalField(0o644, 8), '0000644\0');
        assert.strictEqual(octalField(0, 12), '00000000000\0');
    });
    it('never overflows the field width', () => {
        assert.strictEqual(octalField(0o7777777, 8).length, 8);
    });
});

describe('splitName', () => {
    it('keeps short paths in the name field', () => {
        assert.deepStrictEqual(splitName('am/final.mdl'), { name: 'am/final.mdl', prefix: '' });
    });
    it('uses the prefix field for long paths', () => {
        const long = 'a'.repeat(120) + '/file.mdl';
        const r = splitName(long);
        assert.strictEqual(r.name, 'file.mdl');
        assert.strictEqual(r.prefix, 'a'.repeat(120));
    });
    it('rejects a path that cannot be represented', () => {
        assert.throws(() => splitName('x'.repeat(400)), /tar_name_too_long/);
    });
    it('normalises backslashes and leading slashes', () => {
        assert.deepStrictEqual(splitName('\\am\\final.mdl'), { name: 'am/final.mdl', prefix: '' });
    });
});

describe('buildTar', () => {
    it('pads data to 512-byte blocks and ends with two zero blocks', () => {
        const buf = buildTar([{ name: 'a.txt', data: Buffer.from('hello') }]);
        assert.strictEqual(buf.length, BLOCK + BLOCK + BLOCK * 2);
        assert.strictEqual(buf.slice(BLOCK, BLOCK + 5).toString('utf8'), 'hello');
        assert.ok(buf.slice(BLOCK + 5, BLOCK * 2).every((b) => b === 0), 'padding is zeroed');
        assert.ok(buf.slice(-BLOCK * 2).every((b) => b === 0));
    });

    it('writes a ustar magic', () => {
        const buf = buildTar([{ name: 'a.txt', data: Buffer.from('x') }]);
        assert.strictEqual(buf.slice(257, 263).toString('ascii'), 'ustar\0');
    });

    it('marks directories with typeflag 5 and size 0', () => {
        const buf = buildTar([{ name: 'am/', isDirectory: true }]);
        assert.strictEqual(buf.slice(156, 157).toString('ascii'), '5');
        assert.strictEqual(buf.slice(124, 136).toString('ascii'), '00000000000\0');
    });

    it('computes a checksum a real tar accepts', { skip: !tarExe && 'tar not available' }, () => {
        const dir = tmp();
        const buf = buildTar([
            { name: 'm/', isDirectory: true },
            { name: 'm/a.txt', data: Buffer.from('hello tar') },
            { name: 'm/sub/', isDirectory: true },
            { name: 'm/sub/b.bin', data: Buffer.alloc(1000, 7) },
        ]);
        const archive = path.join(dir, 'm.tar');
        fs.writeFileSync(archive, buf);

        const out = path.join(dir, 'out');
        fs.mkdirSync(out);
        execFileSync('tar', ['-xf', archive, '-C', out]);   // throws on a bad checksum

        assert.strictEqual(fs.readFileSync(path.join(out, 'm/a.txt'), 'utf8'), 'hello tar');
        assert.strictEqual(fs.readFileSync(path.join(out, 'm/sub/b.bin')).length, 1000);
    });

    it('round-trips a real directory tree', { skip: !tarExe && 'tar not available' }, () => {
        const src = tmp();
        fs.mkdirSync(path.join(src, 'am'));
        fs.mkdirSync(path.join(src, 'conf'));
        fs.writeFileSync(path.join(src, 'am', 'final.mdl'), Buffer.alloc(2048, 3));
        fs.writeFileSync(path.join(src, 'conf', 'model.conf'), 'cfg');
        fs.writeFileSync(path.join(src, 'README'), 'hi');

        const entries = entriesFromDirectory(src, 'vosk-model-test/');
        const archive = path.join(src, '..', `t-${Date.now()}.tar`);
        fs.writeFileSync(archive, buildTar(entries));

        const out = tmp();
        execFileSync('tar', ['-xf', archive, '-C', out]);
        assert.strictEqual(fs.readFileSync(path.join(out, 'vosk-model-test/am/final.mdl')).length, 2048);
        assert.strictEqual(fs.readFileSync(path.join(out, 'vosk-model-test/conf/model.conf'), 'utf8'), 'cfg');
        assert.strictEqual(fs.readFileSync(path.join(out, 'vosk-model-test/README'), 'utf8'), 'hi');
    });

    it('lists entries for a directory with the prefix applied', () => {
        const src = tmp();
        fs.mkdirSync(path.join(src, 'am'));
        fs.writeFileSync(path.join(src, 'am', 'final.mdl'), 'x');
        const names = entriesFromDirectory(src, 'top/').map((e) => e.name);
        assert.ok(names.includes('top/am/'));
        assert.ok(names.includes('top/am/final.mdl'));
    });
});
