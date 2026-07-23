/**
 * Window Manager — extracted from main.js
 * Handles settings window, pet window, chat bubble, and window control IPC handlers.
 */

const CSP = "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; " +
    "connect-src * data: blob:; img-src * data: file: blob:; " +
    "media-src * data: blob:; font-src 'self' data:";

function applyCSP(win) {
    win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': [CSP]
            }
        });
    });
}

function registerWindowHandlers(ctx, ipcMain, deps) {
    // deps: { BrowserWindow, path, screen, updateTrayMenu, basePath }

    function createSettingsWindow() {
        ctx.settingsWindow = new deps.BrowserWindow({
            width: 480,
            height: 600,
            frame: true,
            resizable: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: deps.path.join(deps.basePath, 'preload.js')
            }
        });
        ctx.settingsWindow.loadFile(deps.path.join(deps.basePath, 'index.html'));
        ctx.settingsWindow.on('close', (e) => {
            if (!ctx.isQuitting) {
                e.preventDefault();
                ctx.settingsWindow.hide();
                return;
            }
        });
        ctx.settingsWindow.on('closed', () => { ctx.settingsWindow = null; });
        applyCSP(ctx.settingsWindow);
    }

    // ========== Pet Window ==========

    ipcMain.handle('create-pet-window', async (event, data) => {
        try {
            if (ctx.petWindow && !ctx.petWindow.isDestroyed()) {
                ctx.petWindow.focus();
                return { success: true, message: 'already open' };
            }
            if (data) ctx.characterData = { ...ctx.characterData, ...data };

            ctx.petWindow = new deps.BrowserWindow({
                width: 300, height: 300,
                frame: false, transparent: true, alwaysOnTop: true,
                resizable: true, minimizable: false, maximizable: false,
                fullscreenable: false, skipTaskbar: true,
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    preload: deps.path.join(deps.basePath, 'preload.js')
                }
            });
            ctx.petWindow.setAlwaysOnTop(true, 'screen-saver');
            ctx.petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
            ctx.petWindow.loadFile(deps.path.join(deps.basePath, 'desktop-pet.html'));
            applyCSP(ctx.petWindow);

            const { screen } = require('electron');
            const primaryDisplay = screen.getPrimaryDisplay();
            const { width, height } = primaryDisplay.workAreaSize;
            ctx.petWindow.setPosition(width - 220, height - 220);

            ctx.petWindow.on('closed', () => {
                ctx.petWindow = null;
                if (ctx.chatBubbleWindow && !ctx.chatBubbleWindow.isDestroyed()) ctx.chatBubbleWindow.close();
                if (ctx.settingsWindow && !ctx.settingsWindow.isDestroyed()) {
                    ctx.settingsWindow.webContents.send('pet-window-closed');
                }
                deps.updateTrayMenu();
            });

            // Hide settings window to tray when pet starts
            if (ctx.settingsWindow && !ctx.settingsWindow.isDestroyed()) {
                ctx.settingsWindow.hide();
            }
            deps.updateTrayMenu();

            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('close-pet-window', async () => {
        try {
            if (ctx.petWindow && !ctx.petWindow.isDestroyed()) ctx.petWindow.close();
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('update-pet-character', async (event, data) => {
        try {
            if (data) ctx.characterData = { ...ctx.characterData, ...data };
            if (ctx.petWindow && !ctx.petWindow.isDestroyed()) {
                ctx.petWindow.webContents.send('character-update', ctx.characterData);
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-character-data', async () => {
        return ctx.characterData;
    });

    // ========== Window Control ==========

    ipcMain.handle('set-window-size', async (event, width, height) => {
        try {
            if (ctx.petWindow && !ctx.petWindow.isDestroyed()) ctx.petWindow.setSize(width, height);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('set-window-position', async (event, x, y, w, h) => {
        try {
            if (ctx.petWindow && !ctx.petWindow.isDestroyed()) {
                if (w && h) {
                    ctx.petWindow.setBounds({ x, y, width: w, height: h });
                } else {
                    ctx.petWindow.setPosition(x, y);
                }
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-window-bounds', async () => {
        if (ctx.petWindow && !ctx.petWindow.isDestroyed()) return ctx.petWindow.getBounds();
        return { x: 0, y: 0, width: 200, height: 200 };
    });

    ipcMain.handle('get-window-position', async () => {
        if (ctx.petWindow && !ctx.petWindow.isDestroyed()) {
            const pos = ctx.petWindow.getPosition();
            return { x: pos[0], y: pos[1] };
        }
        return { x: 0, y: 0 };
    });

    // ========== Chat Bubble ==========

    ipcMain.handle('show-pet-chat', async (event, message, autoCloseTime = 8000) => {
        try {
            if (!ctx.petWindow || ctx.petWindow.isDestroyed()) return { success: false, error: 'no pet window' };

            // Close existing bubble
            if (ctx.chatBubbleWindow && !ctx.chatBubbleWindow.isDestroyed()) {
                ctx.chatBubbleWindow.close();
                ctx.chatBubbleWindow = null;
            }

            const petBounds = ctx.petWindow.getBounds();

            ctx.chatBubbleWindow = new deps.BrowserWindow({
                width: 250, height: 80,
                x: petBounds.x + (petBounds.width - 250) / 2,
                y: petBounds.y - 80 + petBounds.height * 0.25,
                frame: false, transparent: true, alwaysOnTop: true,
                resizable: true, minimizable: false, maximizable: false,
                fullscreenable: false, skipTaskbar: true, focusable: false,
                show: false,
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    preload: deps.path.join(deps.basePath, 'preload.js')
                }
            });
            ctx.chatBubbleWindow.setAlwaysOnTop(true, 'screen-saver');
            ctx.chatBubbleWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
            await ctx.chatBubbleWindow.loadFile(deps.path.join(deps.basePath, 'pet-chat-bubble.html'));
            applyCSP(ctx.chatBubbleWindow);

            setTimeout(() => {
                if (ctx.chatBubbleWindow && !ctx.chatBubbleWindow.isDestroyed()) {
                    ctx.chatBubbleWindow.webContents.send('chat-bubble-message', { message, autoCloseTime });
                }
            }, 500);

            ctx.chatBubbleWindow.on('closed', () => { ctx.chatBubbleWindow = null; });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('close-chat-bubble', async () => {
        try {
            if (ctx.chatBubbleWindow && !ctx.chatBubbleWindow.isDestroyed()) ctx.chatBubbleWindow.close();
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('resize-chat-bubble', async (event, width, height) => {
        try {
            if (ctx.chatBubbleWindow && !ctx.chatBubbleWindow.isDestroyed() && ctx.petWindow && !ctx.petWindow.isDestroyed()) {
                const petBounds = ctx.petWindow.getBounds();
                ctx.chatBubbleWindow.setBounds({
                    x: Math.round(petBounds.x + (petBounds.width - width) / 2),
                    y: Math.round(petBounds.y - height + petBounds.height * 0.25),
                    width: width, height: height
                });
                if (!ctx.chatBubbleWindow.isVisible()) {
                    ctx.chatBubbleWindow.showInactive();
                }
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // ---- 独立聊天窗口 ----
    ipcMain.handle('create-chat-window', async () => {
        try {
            if (ctx.chatWindow && !ctx.chatWindow.isDestroyed()) {
                ctx.chatWindow.focus();
                return { success: true };
            }
            const petBounds = ctx.petWindow ? ctx.petWindow.getBounds() : { x: 100, y: 100 };
            ctx.chatWindow = new deps.BrowserWindow({
                width: 320, height: 420,
                x: petBounds.x + petBounds.width + 10,
                y: petBounds.y,
                frame: false,
                alwaysOnTop: true, resizable: true,
                minimizable: true, maximizable: false,
                fullscreenable: false,
                show: false,
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    preload: deps.path.join(deps.basePath, 'preload.js'),
                    webSecurity: false
                }
            });
            ctx.chatWindow.setAlwaysOnTop(true, 'screen-saver');
            applyCSP(ctx.chatWindow);
            console.log('[ChatWindow] Loading:', deps.path.join(deps.basePath, 'pet-chat-window.html'));
            await ctx.chatWindow.loadFile(deps.path.join(deps.basePath, 'pet-chat-window.html'));
            ctx.chatWindow.on('closed', () => { ctx.chatWindow = null; });
            ctx.chatWindow.show();
            console.log('[ChatWindow] Opened successfully');
            return { success: true };
        } catch (error) {
            console.error('[ChatWindow] Failed:', error.message);
            return { success: false, error: error.message };
        }
    });
    ipcMain.handle('close-chat-window', async () => {
        try {
            if (ctx.chatWindow && !ctx.chatWindow.isDestroyed()) ctx.chatWindow.close();
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    return { createSettingsWindow };
}

module.exports = { registerWindowHandlers };
