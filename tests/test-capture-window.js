/**
 * Unit tests for the OBS capture window.
 * Run with: node --test tests/test-capture-window.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const {
    CaptureWindowManager,
    normalizeChromaColor,
    buildCaptureQuery,
    captureWindowOptions,
    clampSize,
    DEFAULT_CHROMA,
    DEFAULT_TITLE,
    REVEAL_FALLBACK_MS,
} = require('../src/main/capture-window');

describe('normalizeChromaColor', () => {
    it('accepts the common spellings', () => {
        assert.strictEqual(normalizeChromaColor('#00ff00'), '#00FF00');
        assert.strictEqual(normalizeChromaColor('00FF00'), '#00FF00');
        assert.strictEqual(normalizeChromaColor('#0f0'), '#00FF00');
        assert.strictEqual(normalizeChromaColor('  #FF00FF  '), '#FF00FF');
    });

    it('falls back for unusable input', () => {
        assert.strictEqual(normalizeChromaColor('', '#123456'), '#123456');
        assert.strictEqual(normalizeChromaColor('nonsense', '#123456'), '#123456');
        assert.strictEqual(normalizeChromaColor(null, '#123456'), '#123456');
        assert.strictEqual(normalizeChromaColor(undefined), DEFAULT_CHROMA);
    });
});

describe('clampSize', () => {
    it('clamps to sane bounds', () => {
        assert.strictEqual(clampSize(10, 600), 120);
        assert.strictEqual(clampSize(99999, 600), 4096);
        assert.strictEqual(clampSize(800, 600), 800);
        assert.strictEqual(clampSize('abc', 600), 600);
    });
});

describe('buildCaptureQuery', () => {
    it('flags capture mode and passes the bare hex colour', () => {
        assert.deepStrictEqual(buildCaptureQuery({ color: '#00FF00' }), { capture: '1', color: '00FF00' });
    });
});

describe('captureWindowOptions', () => {
    const opts = captureWindowOptions({ color: '#00ff00', width: 500, height: 700 }, { preloadPath: '/p/preload.js' });

    it('is OPAQUE — the whole point, since OBS reads layered windows as black', () => {
        assert.strictEqual(opts.transparent, false);
        assert.strictEqual(opts.backgroundColor, '#00FF00');
        assert.ok(!opts.transparent);
    });

    it('is discoverable in the OBS window list', () => {
        assert.strictEqual(opts.skipTaskbar, false, 'a taskbar window is easy to find in OBS');
        assert.strictEqual(opts.title, DEFAULT_TITLE);
    });

    it('stays on top, because an occluded window captures as black', () => {
        // Regression: this used to be false, so the surface hid behind the
        // user's fullscreen apps and OBS saw nothing at all.
        assert.strictEqual(opts.alwaysOnTop, true);
        assert.strictEqual(opts.frame, false);
    });

    it('can be told not to stay on top', () => {
        assert.strictEqual(captureWindowOptions({ alwaysOnTop: false }).alwaysOnTop, false);
    });

    it('applies the requested size and the preload script', () => {
        assert.strictEqual(opts.width, 500);
        assert.strictEqual(opts.height, 700);
        assert.strictEqual(opts.webPreferences.preload, '/p/preload.js');
        assert.strictEqual(opts.webPreferences.contextIsolation, true);
    });

    it('honours a custom title', () => {
        assert.strictEqual(captureWindowOptions({ title: 'My Pet' }).title, 'My Pet');
    });
});

// ========== Manager ==========

class FakeWindow extends EventEmitter {
    constructor(opts) {
        super();
        this.opts = opts;
        this.destroyed = false;
        this.shown = false;
        this.file = null;
        this.query = null;
    }
    loadFile(file, o) { this.file = file; this.query = o && o.query; return Promise.resolve(); }
    show() { this.shown = true; }
    focus() {}
    close() { this.destroyed = true; this.emit('closed'); }
    isDestroyed() { return this.destroyed; }
}

function makeManager() {
    const created = [];
    const manager = new CaptureWindowManager({
        BrowserWindow: class extends FakeWindow { constructor(o) { super(o); created.push(this); } },
        path: { join: (...p) => p.join('/') },
        basePath: 'E:/app',
        preloadPath: 'E:/app/preload.js',
        logger: { log() {}, warn() {}, error() {} },
    });
    return { manager, created };
}

describe('CaptureWindowManager', () => {
    it('reports closed before anything is opened', () => {
        const { manager } = makeManager();
        assert.strictEqual(manager.isOpen(), false);
        assert.strictEqual(manager.status({ color: '#00ff00' }).open, false);
        assert.strictEqual(manager.status({ color: '#00ff00' }).color, '#00FF00');
    });

    it('opens an opaque window that loads the pet with capture params', () => {
        const { manager, created } = makeManager();
        manager.show({ color: '#00FF00', width: 600, height: 800 });
        assert.strictEqual(created.length, 1);
        const win = created[0];
        assert.strictEqual(win.opts.transparent, false);
        assert.strictEqual(win.opts.backgroundColor, '#00FF00');
        assert.match(win.file, /desktop-pet\.html$/);
        assert.deepStrictEqual(win.query, { capture: '1', color: '00FF00' });
        assert.strictEqual(manager.isOpen(), true);
    });

    it('focuses the existing window instead of opening a second one', () => {
        const { manager, created } = makeManager();
        manager.show({});
        manager.show({});
        assert.strictEqual(created.length, 1, 'only one capture window exists');
    });

    it('closes and forgets the window', () => {
        const { manager, created } = makeManager();
        manager.show({});
        manager.close();
        assert.strictEqual(created[0].destroyed, true);
        assert.strictEqual(manager.isOpen(), false);
        assert.strictEqual(manager.close(), false, 'closing twice is harmless');
    });

    it('refresh re-opens with the new colour', () => {
        const { manager, created } = makeManager();
        manager.show({ color: '#00FF00' });
        manager.refresh({ color: '#FF00FF' });
        assert.strictEqual(created.length, 2);
        assert.strictEqual(created[1].opts.backgroundColor, '#FF00FF');
    });

    it('refresh keeps the window when nothing relevant changed', () => {
        const { manager, created } = makeManager();
        manager.show({ color: '#00FF00', width: 600, height: 800 });
        manager.refresh({ color: '#00ff00', width: 600, height: 800 });
        assert.strictEqual(created.length, 1, 'no needless rebuild — the OBS source stays put');
    });

    it('refresh rebuilds when the size changes', () => {
        const { manager, created } = makeManager();
        manager.show({ color: '#00FF00', width: 600, height: 800 });
        manager.refresh({ color: '#00FF00', width: 900, height: 800 });
        assert.strictEqual(created.length, 2);
        assert.strictEqual(created[1].opts.width, 900);
    });

    it('refresh does nothing when the window was never open', () => {
        const { manager, created } = makeManager();
        manager.refresh({ color: '#FF00FF' });
        assert.strictEqual(created.length, 0);
    });

    it('reveals the window even when ready-to-show never fires', async () => {
        // Regression, found by screenshotting a real desktop: the surface was
        // created (and logged) but never became visible, so OBS had nothing to
        // capture and the user saw no green window at all.
        const { manager, created } = makeManager();
        manager.show({});
        const win = created[0];
        assert.strictEqual(win.shown, false, 'not shown synchronously');
        await new Promise((r) => setTimeout(r, REVEAL_FALLBACK_MS + 300));
        assert.strictEqual(win.shown, true, 'the fallback timer revealed it');
        manager.close();
    });

    it('reveals immediately when ready-to-show does fire', () => {
        const { manager, created } = makeManager();
        manager.show({});
        const win = created[0];
        win.emit('ready-to-show');
        assert.strictEqual(win.shown, true);
        assert.strictEqual(manager.isOpen(), true);
        manager.close();
    });

    it('survives a BrowserWindow constructor failure', () => {        const manager = new CaptureWindowManager({
            BrowserWindow: class { constructor() { throw new Error('no display'); } },
            path: { join: (...p) => p.join('/') },
            basePath: 'E:/app',
            logger: { log() {}, warn() {}, error() {} },
        });
        assert.strictEqual(manager.show({}), null);
        assert.strictEqual(manager.isOpen(), false);
    });
});
