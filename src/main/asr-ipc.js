/**
 * Offline ASR session + IPC.
 *
 * Split of responsibilities:
 *   - the renderer owns the microphone (only it can call getUserMedia) and
 *     sends 16 kHz mono int16 PCM over IPC at ~32 KB/s, which is negligible;
 *   - the main process owns the native engine, because that is where koffi and
 *     the model on disk live.
 *
 * The engine is loaded lazily and kept alive: loading a Vosk model takes
 * seconds and hundreds of MB, so it must not happen per utterance.
 */
'use strict';

const { createEngine, nativeStatus, installNativeLib } = require('./asr-native');
const { modelStatus, downloadAndInstall } = require('./asr-model');

/**
 * Wraps one recogniser. Kept separate from Electron so it can be tested with a
 * fake engine.
 */
class AsrSession {
    constructor(deps = {}) {
        this._createRecognizer = deps.createRecognizer;
        this._onText = deps.onText || (() => {});
        this._logger = deps.logger || console;
        this._rec = null;
        this._utterances = 0;
        this._chunks = 0;
    }

    get active() { return !!this._rec; }
    get stats() { return { utterances: this._utterances, chunks: this._chunks }; }

    start() {
        if (this._rec) return true;
        this._rec = this._createRecognizer();
        this._logger.log?.('[ASR] listening');
        return true;
    }

    /**
     * Feed one chunk of PCM.
     * @param {Buffer} pcm 16 kHz mono int16 little-endian
     * @returns {string|null} the transcript when an utterance ended
     */
    feed(pcm) {
        if (!this._rec) return null;
        if (!Buffer.isBuffer(pcm) || !pcm.length) return null;
        this._chunks++;
        const text = this._rec.feed(pcm);
        if (text) {
            this._utterances++;
            const clean = String(text).trim();
            if (clean) { this._logger.log?.(`[ASR] heard: ${clean}`); this._onText(clean); }
            return clean || null;
        }
        return null;
    }

    /** End the current utterance (e.g. the mic was released). */
    flush() {
        if (!this._rec) return '';
        const text = String(this._rec.flush() || '').trim();
        this._utterances++;
        if (text) { this._logger.log?.(`[ASR] heard: ${text}`); this._onText(text); }
        return text;
    }

    stop() {
        if (!this._rec) return;
        try { this.flush(); } catch { /* ignore */ }
        try { this._rec.dispose(); } catch { /* ignore */ }
        this._rec = null;
        this._logger.log?.('[ASR] stopped');
    }
}

function registerAsrIPC(ctx, ipcMain, deps) {
    const { app, configManager, logger = console } = deps;
    const userData = () => app.getPath('userData');

    let engine = null;              // loaded lazily, kept for the app lifetime
    let session = null;
    let installing = null;

    /** Where recognised text goes: the pet window (it owns the reply pipeline). */
    function deliver(text) {
        const targets = [ctx.petWindow, ctx.settingsWindow];
        for (const win of targets) {
            if (win && !win.isDestroyed()) {
                try { win.webContents.send('asr://result', text); } catch { /* ignore */ }
            }
        }
    }

    function ensureEngine() {
        if (engine) return engine;
        engine = createEngine(userData(), { logger, logLevel: -1 });
        return engine;
    }

    function status() {
        const native = nativeStatus(userData(), {});
        const model = modelStatus(userData(), {});
        return {
            platformSupported: process.platform === 'win32',
            nativeInstalled: native.installed,
            nativeUrl: native.url,
            nativeMissing: native.missing,
            modelInstalled: model.installed,
            modelUrl: model.url,
            modelApproxBytes: model.approxBytes,
            engineLoaded: !!engine,
            listening: !!(session && session.active),
            stats: session ? session.stats : { utterances: 0, chunks: 0 },
        };
    }

    ctx.asr = {
        get status() { return status(); },
        get engine() { return engine; },
        get session() { return session; },
        dispose() {
            if (session) { session.stop(); session = null; }
            if (engine) { try { engine.dispose(); } catch { /* ignore */ } engine = null; }
        },
    };

    ipcMain.handle('asr-status', async () => status());

    /** Download whatever is missing, reporting progress to the renderer. */
    ipcMain.handle('asr-install', async () => {
        if (installing) return installing;
        installing = (async () => {
            const progress = (stage, frac, extra = {}) => {
                for (const win of [ctx.settingsWindow, ctx.petWindow]) {
                    if (win && !win.isDestroyed()) {
                        try { win.webContents.send('asr://install-progress', { stage, fraction: frac, ...extra }); } catch { /* ignore */ }
                    }
                }
            };
            try {
                const native = nativeStatus(userData(), {});
                if (!native.installed) {
                    progress('native', 0);
                    await installNativeLib(userData(), {
                        onProgress: (f) => progress('native', f),
                        logger,
                    });
                    progress('native', 1);
                }
                const model = modelStatus(userData(), {});
                if (!model.installed) {
                    progress('model', 0);
                    await downloadAndInstall(userData(), {
                        onProgress: (f) => progress('model', f),
                        logger,
                    });
                    progress('model', 1);
                }
                return { success: true, ...status() };
            } catch (e) {
                logger.warn?.(`[ASR] install failed: ${e.message}`);
                return { success: false, error: e.message, ...status() };
            } finally {
                installing = null;
            }
        })();
        return installing;
    });

    ipcMain.handle('asr-start', async () => {
        try {
            const st = status();
            if (!st.nativeInstalled) return { success: false, error: 'native_not_installed' };
            if (!st.modelInstalled) return { success: false, error: 'model_not_installed' };
            const eng = ensureEngine();
            if (session) session.stop();
            session = new AsrSession({ createRecognizer: eng.createRecognizer, onText: deliver, logger });
            session.start();
            return { success: true, ...status() };
        } catch (e) {
            logger.warn?.(`[ASR] start failed: ${e.message}`);
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('asr-stop', async () => {
        if (session) { session.stop(); session = null; }
        return { success: true, ...status() };
    });

    // PCM flows renderer -> main with `send` (no reply needed, one per ~100 ms).
    ipcMain.on('asr-feed', (_event, pcm) => {
        if (!session || !session.active) return;
        try {
            session.feed(Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm));
        } catch (e) {
            logger.warn?.(`[ASR] feed failed: ${e.message}`);
        }
    });

    app.on?.('before-quit', () => { try { ctx.asr.dispose(); } catch { /* ignore */ } });

    return ctx.asr;
}

module.exports = { registerAsrIPC, AsrSession };
