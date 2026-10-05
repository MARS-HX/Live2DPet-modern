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

    return { activeAtLaunch };
}

module.exports = { registerObsIPC };
