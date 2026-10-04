/**
 * DSH IPC — expose the DeepSeek Harness bridge to the renderer.
 *
 * Channels
 *   dsh-status  → { available, script, running, task, elapsedMs, config }
 *   dsh-run     → runs one task, resolves with the final result
 *   dsh-cancel  → cancels the running task
 *   dsh-config  → { profile, workspace, timeoutMs, script } persisted settings
 *   dsh-probe   → lightweight availability probe (no task submitted)
 *
 * Push events (renderer subscribes via preload)
 *   dsh://output { stream, text }
 *   dsh://done   { ok, answer, error, exitCode, durationMs }
 */
'use strict';

const { DshBridge, DEFAULT_PROFILE, DEFAULT_TIMEOUT_MS } = require('./dsh-bridge');

const MAX_TASK_CHARS = 8000;

function registerDshIPC(ctx, ipcMain, deps) {
    const { configManager, app, path } = deps;

    const bridge = new DshBridge();
    ctx.dshBridge = bridge;

    /** Push an event to every live renderer. */
    const broadcast = (channel, payload) => {
        const { BrowserWindow } = require('electron');
        for (const win of BrowserWindow.getAllWindows()) {
            try { win.webContents.send(channel, payload); } catch { /* window closing */ }
        }
    };

    bridge.on('output', (payload) => broadcast('dsh://output', payload));
    bridge.on('done', (payload) => broadcast('dsh://done', payload));

    /** Normalize stored settings into the shape the bridge expects. */
    async function readSettings() {
        let cfg = {};
        try { cfg = (await configManager.loadConfigFile()).dsh || {}; } catch { /* defaults */ }
        const workspace = cfg.workspace && cfg.workspace.trim()
            ? cfg.workspace.trim()
            : app.getPath('home');
        return {
            enabled: cfg.enabled !== false,
            profile: (cfg.profile || DEFAULT_PROFILE).trim() || DEFAULT_PROFILE,
            workspace,
            timeoutMs: Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS,
            script: cfg.script && cfg.script.trim() ? cfg.script.trim() : null,
            extraArgs: Array.isArray(cfg.extraArgs) ? cfg.extraArgs.filter((a) => typeof a === 'string') : [],
            speakResult: cfg.speakResult !== false,
        };
    }

    ipcMain.handle('dsh-status', async () => {
        const settings = await readSettings();
        const avail = bridge.availability(settings.script);
        return {
            ...bridge.status(),
            available: avail.available,
            script: avail.script,
            via: avail.via,
            enabled: settings.enabled,
            profile: settings.profile,
            workspace: settings.workspace,
            timeoutMs: settings.timeoutMs,
        };
    });

    ipcMain.handle('dsh-probe', async () => {
        const settings = await readSettings();
        return bridge.availability(settings.script);
    });

    ipcMain.handle('dsh-config', async (_event, patch) => {
        try {
            if (patch && typeof patch === 'object') {
                const current = await configManager.loadConfigFile();
                const merged = { ...(current.dsh || {}), ...patch };
                await configManager.saveConfigFile({ dsh: merged });
            }
            const settings = await readSettings();
            const avail = bridge.availability(settings.script);
            return { success: true, config: settings, available: avail.available, script: avail.script };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('dsh-run', async (_event, task) => {
        const settings = await readSettings();
        if (!settings.enabled) return { ok: false, error: 'dsh_disabled', answer: '' };

        let text = typeof task === 'string' ? task.trim() : '';
        if (!text) return { ok: false, error: 'empty_task', answer: '' };
        if (text.length > MAX_TASK_CHARS) text = text.slice(0, MAX_TASK_CHARS);

        const avail = bridge.availability(settings.script);
        if (!avail.available && avail.via === 'path') {
            // No script found: the PATH fallback may still work, so only warn.
            console.warn('[DSH] launcher script not found; falling back to `dsh` on PATH');
        }

        const result = await bridge.run(text, {
            profile: settings.profile,
            workspace: settings.workspace,
            timeoutMs: settings.timeoutMs,
            extraArgs: settings.extraArgs,
            explicitPath: settings.script,
        });
        return { ...result, profile: settings.profile, workspace: settings.workspace };
    });

    ipcMain.handle('dsh-cancel', async () => ({ success: bridge.cancel() }));

    // Stop a runaway task when the app goes away.
    app.on?.('before-quit', () => { try { bridge.cancel(); } catch { /* ignore */ } });

    return { bridge };
}

module.exports = { registerDshIPC, MAX_TASK_CHARS };
