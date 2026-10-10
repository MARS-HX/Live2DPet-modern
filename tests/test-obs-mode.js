/**
 * Tests for OBS compatibility mode ("streamer mode").
 *
 * Background: Chromium renders through a path that bypasses the Windows GDI,
 * so OBS captures a black rectangle. Disabling GPU compositing puts Chromium
 * back onto a capturable path.
 * See https://github.com/electron/electron/issues/16955
 *
 * Run with: node --test tests/test-obs-mode.js
 */
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    OBS_COMPAT_SWITCHES,
    obsSwitchesFor,
    readObsCompatibleSync,
    applyObsCompatibility,
} = require('../src/main/obs-mode');

// Every temp dir the suite creates is tracked and removed at the end. Without
// this each run left a handful of `obs-mode-*` directories in the user's %TEMP%
// for good — 1242 of them had piled up across runs before this was added.
const _tmpDirs = [];
function tmpDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-mode-'));
    _tmpDirs.push(dir);
    return dir;
}
after(() => {
    for (const dir of _tmpDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 测试目录 */ }
    }
});

describe('obsSwitchesFor', () => {
    it('returns nothing when compatibility mode is off', () => {
        assert.deepStrictEqual(obsSwitchesFor({ obs: { compatible: false } }), []);
        assert.deepStrictEqual(obsSwitchesFor({ obs: {} }), []);
        assert.deepStrictEqual(obsSwitchesFor({}), []);
        assert.deepStrictEqual(obsSwitchesFor(null), []);
    });

    it('returns the switches when it is on', () => {
        const s = obsSwitchesFor({ obs: { compatible: true } });
        assert.ok(s.includes('disable-gpu-compositing'), 'the switch that actually fixes capture');
    });

    it('only accepts an explicit boolean true', () => {
        // A config round-tripped through JSON must not accidentally enable it.
        assert.deepStrictEqual(obsSwitchesFor({ obs: { compatible: 'true' } }), []);
        assert.deepStrictEqual(obsSwitchesFor({ obs: { compatible: 1 } }), []);
    });

    it('does not hand out the shared array (callers must not mutate it)', () => {
        const a = obsSwitchesFor({ obs: { compatible: true } });
        a.push('bogus');
        assert.ok(!OBS_COMPAT_SWITCHES.includes('bogus'));
        assert.ok(!obsSwitchesFor({ obs: { compatible: true } }).includes('bogus'));
    });
});

describe('readObsCompatibleSync', () => {
    function tmpConfig(name, obj) {
        const dir = tmpDir();
        const file = path.join(dir, name);
        fs.writeFileSync(file, JSON.stringify(obj));
        return { dir, file };
    }

    it('reads the bundled config in dev (not packaged)', () => {
        const { dir } = tmpConfig('config.json', { obs: { compatible: true } });
        const got = readObsCompatibleSync({
            fs, path, basePath: dir,
            app: { isPackaged: false, getPath: () => path.join(dir, 'userData') },
        });
        assert.strictEqual(got, true);
    });

    it('returns false when the file is missing', () => {
        const dir = tmpDir();
        assert.strictEqual(readObsCompatibleSync({ fs, path, basePath: dir, app: { isPackaged: false } }), false);
    });

    it('returns false when the file is not valid JSON', () => {
        const dir = tmpDir();
        fs.writeFileSync(path.join(dir, 'config.json'), '{ broken');
        assert.strictEqual(readObsCompatibleSync({ fs, path, basePath: dir, app: { isPackaged: false } }), false);
    });

    it('prefers userData when the app is packaged', () => {
        const user = tmpConfig('config.json', { obs: { compatible: false } });
        const bundled = tmpConfig('config.json', { obs: { compatible: true } });
        const got = readObsCompatibleSync({
            fs, path,
            basePath: bundled.dir,
            app: { isPackaged: true, getPath: () => user.dir },
        });
        assert.strictEqual(got, false, 'the user config wins over the bundled one');
    });

    it('falls back to the bundled config when a packaged app has no user config', () => {
        const bundled = tmpConfig('config.json', { obs: { compatible: true } });
        const empty = tmpDir();
        const got = readObsCompatibleSync({
            fs, path,
            basePath: bundled.dir,
            app: { isPackaged: true, getPath: () => empty },
        });
        assert.strictEqual(got, true);
    });
});

describe('applyObsCompatibility', () => {
    function fakeApp() {
        const applied = [];
        return { commandLine: { appendSwitch: (s) => applied.push(s) }, applied };
    }

    it('appends the switches when enabled', () => {
        const dir = tmpDir();
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ obs: { compatible: true } }));
        const app = fakeApp();
        const res = applyObsCompatibility(app, { fs, path, basePath: dir, app: { isPackaged: false } });
        assert.strictEqual(res.enabled, true);
        assert.ok(app.applied.includes('disable-gpu-compositing'));
    });

    it('touches nothing when disabled', () => {
        const dir = tmpDir();
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ obs: { compatible: false } }));
        const app = fakeApp();
        const res = applyObsCompatibility(app, { fs, path, basePath: dir, app: { isPackaged: false } });
        assert.strictEqual(res.enabled, false);
        assert.deepStrictEqual(app.applied, []);
    });
});
