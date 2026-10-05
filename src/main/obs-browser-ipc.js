/**
 * OBS Browser Source wiring.
 *
 * Starts the loopback server and mirrors every event the app sends to the pet
 * window / chat bubble into the browser source, so the OBS copy behaves exactly
 * like the desktop pet (expressions, motions, talking state, speech bubbles).
 *
 * The mirror is installed by wrapping `webContents.send` on those two windows,
 * which means new event types are forwarded automatically without touching
 * every call site.
 */
'use strict';

const { createObsServer } = require('./obs-server');

function registerObsBrowserSource(ctx, deps) {
    const { app, http, fs, path, ws, basePath, configManager, logger = console } = deps;

    let server = null;
    let mirrorInstalled = false;

    /**
     * Config for the browser source, read synchronously with the same
     * precedence the app uses: a packaged build prefers userData, a dev run
     * uses the config next to the source. (Reading the wrong one made the model
     * URL resolve to nothing and every request 404.)
     */
    function readConfigSync() {
        const candidates = [];
        if (app.isPackaged) {
            try { candidates.push(path.join(app.getPath('userData'), 'config.json')); } catch { /* ignore */ }
        }
        candidates.push(path.join(basePath, 'config.json'));
        for (const file of candidates) {
            try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
        }
        return {};
    }

    function resolveModelDir() {
        try {
            const model = (readConfigSync().model) || {};
            if (model.userDataModelPath) return path.join(app.getPath('userData'), model.userDataModelPath);
            return model.folderPath || null;
        } catch {
            return null;
        }
    }

    const getConfig = () => readConfigSync();

    /** Forward one window event to every connected browser source. */
    function mirror(channel, args) {
        if (server && server.running) server.broadcast(channel, args);
    }

    /**
     * Wrap a window's webContents.send so every message is also mirrored.
     * Idempotent: wrapping twice would double-send.
     */
    function installMirror(win) {
        if (!win || win.isDestroyed || win.isDestroyed()) return;
        const wc = win.webContents;
        if (!wc || wc.__obsMirrored) return;
        const original = wc.send.bind(wc);
        wc.send = (channel, ...args) => {
            try { mirror(channel, args); } catch { /* never break the pet */ }
            return original(channel, ...args);
        };
        wc.__obsMirrored = true;
    }

    function installMirrors() {
        installMirror(ctx.petWindow);
        installMirror(ctx.chatBubbleWindow);
    }

    let starting = null;

    async function start(preferredPort = 0) {
        if (server && server.running) return { port: server.port, url: server.url() };
        // Join an in-flight start instead of binding a second port: `server` is
        // assigned before listen() completes, so a concurrent call used to
        // create a second server and leak the first one on its own port.
        if (starting) return starting;
        starting = (async () => {
            if (server) { try { server.close(); } catch { /* ignore */ } server = null; }
            server = createObsServer({
                http, fs, path, ws, rootDir: basePath,
                getConfig, getModelDir: resolveModelDir, logger,
            });
            try {
                await server.start(preferredPort);
            } catch (e) {
                logger.warn?.(`[OBS] browser source failed to start: ${e.message}`);
                server = null;
                return { error: e.message };
            }
            if (!mirrorInstalled) {
                installMirrors();
                mirrorInstalled = true;
            }
            return { port: server.port, url: server.url() };
        })();
        try {
            return await starting;
        } finally {
            starting = null;
        }
    }

    function stop() {
        if (server) { server.close(); server = null; }
    }

    // Keep mirrors attached whenever a window (re)appears.
    app.on?.('browser-window-created', (_e, win) => {
        if (win === ctx.petWindow || win === ctx.chatBubbleWindow) installMirror(win);
    });

    app.on?.('before-quit', stop);

    ctx.obsBrowserSource = {
        start, stop, mirror, installMirrors,
        get status() {
            return {
                running: !!(server && server.running),
                port: server ? server.port : 0,
                // url() is a METHOD on the server object — calling it matters:
                // returning the function itself made the IPC payload
                // un-structured-cloneable ("An object could not be cloned").
                url: server ? server.url() : '',
                clients: server ? server.clients : 0,
            };
        },
    };
    return ctx.obsBrowserSource;
}

module.exports = { registerObsBrowserSource };
