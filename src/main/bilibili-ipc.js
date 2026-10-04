/**
 * Bilibili IPC — bridge the danmaku client to the renderer.
 *
 * Channels
 *   bili-status → connection + room info + last error
 *   bili-start  → connect to a room (accepts a bare id or a live URL)
 *   bili-stop   → disconnect
 *   bili-config → read (no arg) or patch the persisted settings
 *
 * Push events
 *   bili://danmaku { type, user, uid, text, medal?, extra? }
 *   bili://status  { connected, roomId, realRoomId, received, lastError }
 */
'use strict';

const { BilibiliDanmakuClient } = require('./bilibili-danmaku');

function registerBilibiliIPC(ctx, ipcMain, deps) {
    const { configManager, app } = deps;

    const client = new BilibiliDanmakuClient();
    ctx.biliDanmaku = client;

    // Coalesce status pushes so a flapping connection cannot flood the renderer.
    let lastStatusPush = 0;
    const broadcast = (channel, payload) => {
        const { BrowserWindow } = require('electron');
        for (const win of BrowserWindow.getAllWindows()) {
            try { win.webContents.send(channel, payload); } catch { /* window closing */ }
        }
    };

    client.on('message', (msg) => {
        // Log every arrival: without this it is impossible to tell "the room is
        // quiet" apart from "the pet ignored it".
        console.log(`[Bili] danmaku <${msg.user}>: ${msg.text}`);
        broadcast('bili://danmaku', msg);
    });
    client.on('status', (status) => {
        const now = Date.now();
        if (now - lastStatusPush < 500) return;
        lastStatusPush = now;
        broadcast('bili://status', status);
    });

    async function readConfig() {
        try {
            const cfg = (await configManager.loadConfigFile()).bilibili || {};
            return {
                enabled: cfg.enabled === true,
                roomId: cfg.roomId != null ? String(cfg.roomId) : '',
                mode: cfg.mode || 'question',
                replyIntervalMs: Number.isFinite(cfg.replyIntervalMs) ? cfg.replyIntervalMs : 15000,
                userCooldownMs: Number.isFinite(cfg.userCooldownMs) ? cfg.userCooldownMs : 60000,
                minLength: Number.isFinite(cfg.minLength) ? cfg.minLength : 2,
                ignoreList: Array.isArray(cfg.ignoreList) ? cfg.ignoreList : [],
                mentions: Array.isArray(cfg.mentions) ? cfg.mentions : [],
                replyTypes: Array.isArray(cfg.replyTypes) ? cfg.replyTypes : ['danmaku', 'superchat'],
                floodWindowMs: Number.isFinite(cfg.floodWindowMs) ? cfg.floodWindowMs : 8000,
                floodUserThreshold: Number.isFinite(cfg.floodUserThreshold) ? cfg.floodUserThreshold : 4,
                cookie: typeof cfg.cookie === 'string' ? cfg.cookie : '',
                roomTitle: cfg.roomTitle || '',
                lastError: cfg.lastError || null,
            };
        } catch {
            return { enabled: false, roomId: '', mode: 'question', replyIntervalMs: 15000, userCooldownMs: 60000, minLength: 2, ignoreList: [], mentions: [], replyTypes: ['danmaku', 'superchat'], floodWindowMs: 8000, floodUserThreshold: 4, cookie: '' };
        }
    }

    ipcMain.handle('bili-status', async () => {
        const cfg = await readConfig();
        return { ...client.status(), loggedIn: client.isLoggedIn, hasCookie: !!cfg.cookie, config: cfg };
    });

    ipcMain.handle('bili-start', async (_event, roomInput) => {
        const cfg = await readConfig();
        const room = roomInput != null && String(roomInput).trim() ? roomInput : cfg.roomId;
        if (!room) return { success: false, error: 'no_room_id' };
        // Apply the optional login cookie before connecting (blivedm-style).
        if (client.setCookie(cfg.cookie)) {
            console.log(cfg.cookie ? '[Bili] using the supplied cookie for login' : '[Bili] login cookie cleared');
        }
        const res = await client.start(room);
        // Remember the resolved room so a restart reconnects to the same place.
        if (res.success) {
            try {
                await configManager.saveConfigFile({
                    bilibili: { roomId: String(room), roomTitle: res.room?.title || '' },
                });
            } catch { /* non-fatal */ }
        }
        return res;
    });

    ipcMain.handle('bili-stop', async () => {
        client.stop();
        return { success: true };
    });

    ipcMain.handle('bili-config', async (_event, patch) => {
        try {
            if (patch && typeof patch === 'object') {
                const current = await configManager.loadConfigFile();
                const merged = { ...(current.bilibili || {}), ...patch };
                await configManager.saveConfigFile({ bilibili: merged });
            }
            return { success: true, config: await readConfig() };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // Reconnect automatically when the user had it enabled.
    app.whenReady?.().then(async () => {
        const cfg = await readConfig();
        if (cfg.enabled && cfg.roomId) {
            setTimeout(() => {
                client.setCookie(cfg.cookie);
                client.start(cfg.roomId).catch(() => {});
            }, 4000);
        }
    });

    app.on?.('before-quit', () => { try { client.stop(); } catch { /* ignore */ } });

    return { client };
}

module.exports = { registerBilibiliIPC };
