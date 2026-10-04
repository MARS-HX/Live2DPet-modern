/**
 * Capture IPC — let the user open the OBS-capturable pet window.
 *
 * Channels
 *   capture-status  → { open, color, title, docked }
 *   capture-show    → open (or focus) the capture window
 *   capture-hide    → close it
 *   capture-config  → read (no arg) or patch the persisted capture settings
 */
'use strict';

const { CaptureWindowManager, normalizeChromaColor } = require('./capture-window');

function registerCaptureIPC(ctx, ipcMain, deps) {
    const { configManager, app, path, basePath, BrowserWindow } = deps;

    const manager = new CaptureWindowManager({
        BrowserWindow,
        path,
        basePath,
        preloadPath: path.join(basePath, 'preload.js'),
    });
    ctx.captureWindowManager = manager;

    async function readConfig() {
        try {
            const cfg = (await configManager.loadConfigFile()).capture || {};
            return {
                enabled: cfg.enabled === true,
                color: normalizeChromaColor(cfg.color),
                width: Number(cfg.width) || 600,
                height: Number(cfg.height) || 800,
                title: cfg.title || 'Live2DPet Capture',
            };
        } catch {
            return { enabled: false, color: '#00FF00', width: 600, height: 800, title: 'Live2DPet Capture' };
        }
    }

    ipcMain.handle('capture-status', async () => {
        const cfg = await readConfig();
        return { ...manager.status(cfg), config: cfg };
    });

    ipcMain.handle('capture-config', async (_event, patch) => {
        try {
            if (patch && typeof patch === 'object') {
                const current = await configManager.loadConfigFile();
                const merged = { ...(current.capture || {}), ...patch };
                if (patch.color !== undefined) merged.color = normalizeChromaColor(patch.color);
                await configManager.saveConfigFile({ capture: merged });
                // Apply colour/size changes to a window that is already open.
                if (manager.isOpen()) manager.refresh({ ...(await readConfig()) });
            }
            const cfg = await readConfig();
            return { success: true, status: manager.status(cfg), config: cfg };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('capture-toggle', async () => {
        if (manager.isOpen()) {
            manager.close();
            try { await configManager.saveConfigFile({ capture: { enabled: false } }); } catch { /* ignore */ }
            return { success: true, open: false };
        }
        const cfg = await readConfig();
        const win = manager.show(cfg);
        if (win) {
            try { await configManager.saveConfigFile({ capture: { enabled: true } }); } catch { /* ignore */ }
        }
        return { success: !!win, open: manager.isOpen() };
    });

    app.on?.('before-quit', () => { try { manager.close(); } catch { /* ignore */ } });

    // Reopen automatically if it was left on.
    app.whenReady?.().then(async () => {
        const cfg = await readConfig();
        if (cfg.enabled) {
            setTimeout(() => { try { manager.show(cfg); } catch { /* ignore */ } }, 3000);
        }
    });

    return { manager };
}

module.exports = { registerCaptureIPC };
