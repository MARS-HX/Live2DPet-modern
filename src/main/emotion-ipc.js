/**
 * EmotionIPC — Expression/motion forwarding to pet window.
 * Extracted from main.js lines 886-937.
 */
function registerEmotionIPC(ctx, ipcMain) {
    ipcMain.handle('trigger-expression', async (event, expressionName) => {
        try {
            console.log(`[Main] trigger-expression: "${expressionName}", petWindow: ${!!ctx.petWindow}`);
            if (ctx.petWindow && !ctx.petWindow.isDestroyed()) {
                ctx.petWindow.webContents.send('play-expression', expressionName);
                return { success: true };
            }
            return { success: false, error: 'no pet window' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('revert-expression', async () => {
        try {
            console.log('[Main] revert-expression');
            if (ctx.petWindow && !ctx.petWindow.isDestroyed()) {
                ctx.petWindow.webContents.send('revert-expression');
                return { success: true };
            }
            return { success: false, error: 'no pet window' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('trigger-motion', async (event, group, index) => {
        try {
            console.log(`[Main] trigger-motion: group="${group}", index=${index}, petWindow: ${!!ctx.petWindow}`);
            if (ctx.petWindow && !ctx.petWindow.isDestroyed()) {
                ctx.petWindow.webContents.send('play-motion', group, index);
                return { success: true };
            }
            return { success: false, error: 'no pet window' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('report-hover-state', async (event, isHovering) => {
        try {
            if (ctx.settingsWindow && !ctx.settingsWindow.isDestroyed()) {
                ctx.settingsWindow.webContents.send('pet-hover-state', isHovering);
                return { success: true };
            }
            return { success: false, error: 'no settings window' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Hit interaction — forwarded to settings window (renderer picks it up)
    ipcMain.handle('report-hit', async (event, data) => {
        try {
            if (ctx.settingsWindow && !ctx.settingsWindow.isDestroyed()) {
                ctx.settingsWindow.webContents.send('pet-hit', data);
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('set-talking-state', async (event, isTalking) => {
        try {
            if (ctx.petWindow && !ctx.petWindow.isDestroyed()) {
                ctx.petWindow.webContents.send('talking-state-changed', isTalking);
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
}

module.exports = { registerEmotionIPC };
