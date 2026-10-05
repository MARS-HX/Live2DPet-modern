/**
 * OBS compatibility mode IPC.
 *
 *   obs-mode-get  → { compatible, active, restartRequired }
 *   obs-mode-set  → { compatible } persisted; takes effect after a restart
 *   app-restart   → relaunch so the switch is applied
 *
 * `active` is what the current process actually launched with; `compatible` is
 * what the config now asks for. When they differ the UI tells the user to
 * restart — the command-line switches cannot be changed at runtime.
 */
'use strict';

const { OBS_COMPAT_SWITCHES } = require('./obs-mode');

function registerObsIPC(ctx, ipcMain, deps) {
    const { configManager, app } = deps;
    const activeAtLaunch = !!(ctx && ctx.obsModeActive);

    async function readConfig() {
        try {
            const raw = (await configManager.loadConfigFile()).obs || {};
            return { compatible: raw.compatible === true };
        } catch {
            return { compatible: false };
        }
    }

    const payload = (cfg) => ({
        compatible: cfg.compatible,
        active: activeAtLaunch,
        restartRequired: cfg.compatible !== activeAtLaunch,
        switches: OBS_COMPAT_SWITCHES.slice(),
    });

    ipcMain.handle('obs-mode-get', async () => payload(await readConfig()));

    ipcMain.handle('obs-mode-set', async (_event, patch) => {
        try {
            const compatible = !!(patch && patch.compatible);
            await configManager.saveConfigFile({ obs: { compatible } });
            const cfg = await readConfig();
            console.log(`[OBS] compatibility mode set to ${compatible} (restart required to apply)`);
            return { success: true, ...payload(cfg) };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('app-restart', () => {
        try {
            console.log('[App] restarting to apply the new launch switches');
            app.relaunch();
            app.exit(0);
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // ========== Browser Source（推荐方式） ==========

    async function readBrowserSourceConfig() {
        try {
            const raw = (await configManager.loadConfigFile()).obs || {};
            const bs = raw.browserSource || {};
            return { enabled: bs.enabled !== false, port: Number.isFinite(bs.port) ? bs.port : 0 };
        } catch {
            return { enabled: true, port: 0 };
        }
    }

    const browserPayload = (cfg) => {
        const src = ctx.obsBrowserSource;
        const st = src ? src.status : { running: false, port: 0, url: '', clients: 0 };
        return {
            enabled: cfg.enabled,
            preferredPort: cfg.port,
            running: st.running,
            port: st.port,
            clients: st.clients,
            url: st.url,
        };
    };

    ipcMain.handle('obs-server-get', async () => browserPayload(await readBrowserSourceConfig()));

    ipcMain.handle('obs-server-start', async (_event, patch) => {
        try {
            const cfg = await readBrowserSourceConfig();
            const want = patch && patch.port !== undefined ? Number(patch.port) || 0 : cfg.port;
            await configManager.saveConfigFile({ obs: { browserSource: { enabled: true, port: want } } });
            const res = ctx.obsBrowserSource ? await ctx.obsBrowserSource.start(want) : { error: 'not_available' };
            if (res.error) return { success: false, error: res.error, ...browserPayload({ enabled: true, port: want }) };
            return { success: true, ...browserPayload({ enabled: true, port: want }) };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('obs-server-stop', async () => {
        try {
            await configManager.saveConfigFile({ obs: { browserSource: { enabled: false } } });
            if (ctx.obsBrowserSource) ctx.obsBrowserSource.stop();
            return { success: true, ...browserPayload({ enabled: false, port: 0 }) };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // Reopen automatically when it was left enabled.
    app.whenReady?.().then(async () => {
        const cfg = await readBrowserSourceConfig();
        if (!cfg.enabled) return;
        setTimeout(() => {
            ctx.obsBrowserSource?.start(cfg.port).catch(() => {});
        }, 2500);
    });

    return { activeAtLaunch };
}

module.exports = { registerObsIPC };
