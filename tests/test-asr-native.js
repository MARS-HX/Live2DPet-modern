/**
 * Tests for the native (libvosk.dll + koffi) speech engine.
 *
 * The unit tests are pure. The integration test only runs when the native
 * library AND the model have actually been installed on this machine — it must
 * not make the suite depend on a 60 MB download, but when the pieces are there
 * it verifies the real thing (the WASM route failed exactly at this boundary).
 *
 * Run with: node --test tests/test-asr-native.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    NATIVE, nativeRoot, nativeLibDir, nativeStatus, parseText, createEngine,
} = require('../src/main/asr-native');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'asrn-')); }

function makeFakeNative(userData, { withWrapper = true, skip = [] } = {}) {
    // Mirror the real layout: <userData>/vosk-native/lib/<wrapper>/libvosk.dll
    const base = nativeRoot(userData, path);
    const dir = withWrapper
        ? path.join(base, 'lib', 'vosk-win64-0.3.45')
        : path.join(base, 'lib');
    fs.mkdirSync(dir, { recursive: true });
    for (const dll of NATIVE.dlls) {
        if (!skip.includes(dll)) fs.writeFileSync(path.join(dir, dll), 'x');
    }
    return dir;
}

describe('NATIVE descriptor', () => {
    it('points at the official Windows release', () => {
        assert.match(NATIVE.url, /^https:\/\/github\.com\/alphacep\/vosk-api\/releases\/download\//);
        assert.ok(NATIVE.url.endsWith('.zip'));
        assert.ok(NATIVE.dlls.includes('libvosk.dll'));
    });

    it('lists the MinGW runtime DLLs libvosk needs beside it', () => {
        // Shipping only libvosk.dll fails to load on a clean machine.
        for (const d of ['libstdc++-6.dll', 'libgcc_s_seh-1.dll', 'libwinpthread-1.dll']) {
            assert.ok(NATIVE.dlls.includes(d), `missing ${d}`);
        }
    });
});

describe('parseText', () => {
    it('extracts text from the Vosk JSON shape', () => {
        assert.strictEqual(parseText('{"text":"你好"}'), '你好');
        assert.strictEqual(parseText('{"text":""}'), '');
    });
    it('tolerates partial results with extra fields', () => {
        assert.strictEqual(parseText('{"partial":"你"}'), '');
    });
    it('never throws on junk', () => {
        assert.strictEqual(parseText('not json'), '');
        assert.strictEqual(parseText(null), '');
        assert.strictEqual(parseText(undefined), '');
        assert.strictEqual(parseText(''), '');
    });
    it('passes objects straight through', () => {
        assert.strictEqual(parseText({ text: '好' }), '好');
        assert.strictEqual(parseText({}), '');
    });
});

describe('nativeLibDir / nativeStatus', () => {
    it('finds the DLL inside the archive wrapper folder', () => {
        const root = tmp();
        const dir = makeFakeNative(root);
        assert.strictEqual(nativeLibDir(root, { fs, path }), dir);
    });

    it('handles a flat layout too', () => {
        const root = tmp();
        const dir = makeFakeNative(root, { withWrapper: false });
        assert.strictEqual(nativeLibDir(root, { fs, path }), dir);
    });

    it('reports which DLLs are still missing', () => {
        const root = tmp();
        makeFakeNative(root, { skip: ['libstdc++-6.dll'] });
        const st = nativeStatus(root, { fs, path });
        assert.deepStrictEqual(st.missing, ['libstdc++-6.dll']);
        assert.strictEqual(st.installed, false);
    });

    it('is installed when everything is present (Windows only)', () => {
        const root = tmp();
        makeFakeNative(root);
        const st = nativeStatus(root, { fs, path });
        assert.deepStrictEqual(st.missing, []);
        assert.strictEqual(st.installed, process.platform === 'win32');
    });

    it('keeps natives under userData', () => {
        assert.ok(nativeRoot('/ud', path).includes('ud'));
        assert.ok(nativeRoot('/ud', path).endsWith('vosk-native'));
    });
});

describe('native engine (integration, skipped when not installed)', () => {
    const userData = path.join(os.homedir(), 'AppData', 'Roaming', 'live2dpet');
    const st = nativeStatus(userData, { fs, path });
    const modelDir = path.join(userData, 'vosk-models',
        path.join('vosk-model-small-cn-0.22', 'vosk-model-small-cn-0.22'));
    const ready = st.installed && fs.existsSync(modelDir);

    it('loads the real model and survives silence', { skip: !ready && 'native lib/model not installed on this machine' }, () => {
        const engine = createEngine(userData, { logLevel: -1 });
        try {
            const rec = engine.createRecognizer();
            // One second of silence: a broken binding crashes or returns junk
            // here; a working one reports an empty transcript.
            assert.strictEqual(rec.feed(Buffer.alloc(32000)), null);
            assert.strictEqual(rec.flush(), '');
            rec.dispose();
        } finally {
            engine.dispose();
        }
    });

    it('refuses to start when the native library is missing', () => {
        const empty = tmp();
        assert.throws(() => createEngine(empty, { fs, path, logger: { log() {} } }),
            /native_not_installed/);
    });
});
