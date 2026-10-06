/**
 * Every IPC channel the preload bridge talks to must have a handler.
 *
 * Regression guard: the STT modules were removed but `preload.js` kept
 * `sttInitialize: () => ipcRenderer.invoke('stt:initialize')`, so the renderer
 * blew up with "No handler registered for 'stt:initialize'" at runtime. Nothing
 * in the suite noticed, because a dangling channel is invisible to linting.
 *
 * Run with: node --test tests/test-ipc-channels.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', 'dist', 'libs'].includes(e.name)) continue;
        const p = path.join(dir, e.name);
        e.isDirectory() ? walk(p, out) : out.push(p);
    }
    return out;
}

const allFiles = walk(ROOT);
const mainFiles = allFiles.filter((f) => /\.js$/.test(f) &&
    (f.includes(`${path.sep}src${path.sep}main${path.sep}`) || f.endsWith(`${path.sep}main.js`)));

const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const mainSource = mainFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

/** Channels the renderer calls and expects an answer for. */
function channelsUsed(src, method) {
    const out = new Set();
    const re = new RegExp(`ipcRenderer\\.${method}\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'g');
    let m;
    while ((m = re.exec(src)) !== null) out.add(m[1]);
    return out;
}

/** Channels the main process actually handles. */
function channelsHandled(src, method) {
    const out = new Set();
    const re = new RegExp(`ipcMain\\.${method}\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'g');
    let m;
    while ((m = re.exec(src)) !== null) out.add(m[1]);
    return out;
}

describe('preload IPC channels', () => {
    it('parsed a sane amount of the bridge', () => {
        assert.ok(channelsUsed(preload, 'invoke').size > 20, 'should find many invoke channels');
    });

    it('every invoke() channel has an ipcMain.handle()', () => {
        const handled = channelsHandled(mainSource, 'handle');
        const missing = [...channelsUsed(preload, 'invoke')].filter((c) => !handled.has(c)).sort();
        assert.deepStrictEqual(missing, [],
            `invoke() without a handler:\n  ${missing.join('\n  ')}`);
    });

    it('every send() channel has an ipcMain.on()', () => {
        const listened = channelsHandled(mainSource, 'on');
        const missing = [...channelsUsed(preload, 'send')].filter((c) => !listened.has(c)).sort();
        assert.deepStrictEqual(missing, [],
            `send() without a listener:\n  ${missing.join('\n  ')}`);
    });

    it('no handler is registered twice', () => {
        const seen = new Map();
        const re = /ipcMain\.(handle|on)\(\s*['"`]([^'"`]+)['"`]/g;
        for (const f of mainFiles) {
            const src = fs.readFileSync(f, 'utf8');
            let m;
            while ((m = re.exec(src)) !== null) {
                const key = `${m[1]}:${m[2]}`;
                if (seen.has(key)) {
                    assert.fail(`channel ${key} registered twice (${path.relative(ROOT, seen.get(key))} and ${path.relative(ROOT, f)}) — Electron throws on the second one`);
                }
                seen.set(key, f);
            }
        }
        assert.ok(seen.size > 20, 'should have found many handlers');
    });
});
