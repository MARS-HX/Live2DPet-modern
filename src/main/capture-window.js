/**
 * CaptureWindow — an OBS-capturable rendering of the pet.
 *
 * Why this exists: the desktop pet window is created with `transparent: true`,
 * which on Windows makes it a WS_EX_LAYERED window. OBS's Window Capture reads
 * layered windows as pure black, so the pet cannot be captured from it at all.
 *
 * The capture window is deliberately OPAQUE and filled with a chroma-key colour
 * instead. In OBS you add Window Capture → this window, then a Chroma Key
 * filter, and the flat colour disappears — giving a transparent pet for the
 * stream while the desktop pet keeps its real transparency.
 *
 * Pure helpers live here so they can be unit-tested without Electron.
 */
'use strict';

const DEFAULT_CHROMA = '#00FF00';
const DEFAULT_TITLE = 'Live2DPet Capture';
const DEFAULT_WIDTH = 600;
const DEFAULT_HEIGHT = 800;
const MIN_SIZE = 120;
const MAX_SIZE = 4096;

/** Normalize '#0f0' / '00ff00' / '#00FF00' → '#00FF00'. */
function normalizeChromaColor(input, fallback = DEFAULT_CHROMA) {
    const raw = String(input == null ? '' : input).trim();
    const match = raw.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!match) return fallback;
    let hex = match[1].toLowerCase();
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    return '#' + hex.toUpperCase();
}

function clampSize(value, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(MAX_SIZE, Math.max(MIN_SIZE, n));
}

/** Query handed to desktop-pet.html so the renderer paints the key colour. */
function buildCaptureQuery(config = {}) {
    return {
        capture: '1',
        color: normalizeChromaColor(config.color).slice(1),
    };
}

/**
 * BrowserWindow options for the capture window: opaque, taskbar-visible (so it
 * is easy to find in OBS), never on top of the user's work.
 */
function captureWindowOptions(config = {}, deps = {}) {
    const width = clampSize(config.width, DEFAULT_WIDTH);
    const height = clampSize(config.height, DEFAULT_HEIGHT);
    return {
        width,
        height,
        minWidth: MIN_SIZE,
        minHeight: MIN_SIZE,
        frame: false,
        transparent: false,
        backgroundColor: normalizeChromaColor(config.color),
        hasShadow: false,
        skipTaskbar: false,
        alwaysOnTop: false,
        resizable: true,
        minimizable: true,
        maximizable: false,
        fullscreenable: false,
        title: String(config.title || DEFAULT_TITLE),
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: deps.preloadPath,
        },
    };
}

/** The manager owns at most one capture window. */
class CaptureWindowManager {
    constructor(deps = {}) {
        this._BrowserWindow = deps.BrowserWindow;
        this._path = deps.path;
        this._basePath = deps.basePath;
        this._preloadPath = deps.preloadPath;
        this._logger = deps.logger || console;
        this._window = null;
        this._applied = null;
    }

    get window() { return this._window; }

    isOpen() {
        return !!(this._window && !this._window.isDestroyed());
    }

    status(config = {}) {
        return {
            open: this.isOpen(),
            color: normalizeChromaColor(config.color),
            title: String(config.title || DEFAULT_TITLE),
        };
    }

    /** Create (or focus) the capture window. Returns the window or null. */
    show(config = {}) {
        if (!this._BrowserWindow) return null;
        if (this.isOpen()) {
            this._window.show();
            this._window.focus();
            return this._window;
        }
        const options = captureWindowOptions(config, { preloadPath: this._preloadPath });
        try {
            this._window = new this._BrowserWindow(options);
        } catch (e) {
            this._logger.warn?.(`[Capture] window creation failed: ${e.message}`);
            this._window = null;
            return null;
        }
        this._applied = { color: options.backgroundColor, width: options.width, height: options.height };
        const file = this._path.join(this._basePath, 'desktop-pet.html');
        const query = buildCaptureQuery(config);
        this._window.loadFile(file, { query });
        this._window.once?.('ready-to-show', () => {
            try { this._window.show(); } catch { /* closed already */ }
        });
        this._window.on('closed', () => { this._window = null; });
        this._logger.log?.(`[Capture] capture window opened (chroma ${options.backgroundColor})`);
        return this._window;
    }

    close() {
        if (!this.isOpen()) { this._window = null; return false; }
        try { this._window.close(); } catch { /* already gone */ }
        this._window = null;
        return true;
    }

    /**
     * Apply new settings to an open window. Only rebuilds when something that
     * affects the window actually changed, so saving unrelated settings does not
     * make the capture window blink out of OBS.
     */
    refresh(config = {}) {
        if (!this.isOpen()) return false;
        const next = captureWindowOptions(config, { preloadPath: this._preloadPath });
        const same = this._applied
            && this._applied.color === next.backgroundColor
            && this._applied.width === next.width
            && this._applied.height === next.height;
        if (same) return true;
        this.close();
        this.show(config);
        return this.isOpen();
    }
}

module.exports = {
    CaptureWindowManager,
    normalizeChromaColor,
    buildCaptureQuery,
    captureWindowOptions,
    clampSize,
    DEFAULT_CHROMA,
    DEFAULT_TITLE,
    DEFAULT_WIDTH,
    DEFAULT_HEIGHT,
    MIN_SIZE,
    MAX_SIZE,
};
