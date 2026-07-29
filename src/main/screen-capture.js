/**
 * ScreenCapture — Screen capture, window detection, idle time.
 * Extracted from main.js lines 488-530.
 */

/** Release NativeImage references to free GPU/process memory sooner */
function releaseSources(sources) {
    if (!sources) return;
    for (const s of sources) try { s.thumbnail = null; s.appIcon = null; } catch {}
}

function registerScreenCapture(ctx, ipcMain, deps) {
    // deps: { desktopCapturer, powerMonitor }
    const { desktopCapturer, powerMonitor } = deps;

    ipcMain.handle('get-screen-capture', async (event, targetTitle) => {
        let winSources = null, sources = null;
        try {
            if (targetTitle) {
                winSources = await desktopCapturer.getSources({
                    types: ['window'], thumbnailSize: { width: 512, height: 512 }
                });
                const match = winSources.find(s => s.name === targetTitle);
                if (match) {
                    const result = match.thumbnail.toJPEG(30).toString('base64');
                    releaseSources(winSources);
                    return result;
                }
                releaseSources(winSources);
                winSources = null;
            }
            sources = await desktopCapturer.getSources({
                types: ['screen'], thumbnailSize: { width: 512, height: 512 }
            });
            if (sources.length > 0) {
                const result = sources[0].thumbnail.toJPEG(30).toString('base64');
                releaseSources(sources);
                return result;
            }
            releaseSources(sources);
            return null;
        } catch (error) {
            releaseSources(winSources);
            releaseSources(sources);
            console.error('Screen capture failed:', error);
            return null;
        }
    });

    ipcMain.handle('get-screen-capture-hq', async (event, targetTitle) => {
        let winSources = null, sources = null;
        try {
            if (targetTitle) {
                winSources = await desktopCapturer.getSources({
                    types: ['window'], thumbnailSize: { width: 768, height: 768 }
                });
                const match = winSources.find(s => s.name === targetTitle);
                if (match) {
                    const result = match.thumbnail.toJPEG(40).toString('base64');
                    releaseSources(winSources);
                    return result;
                }
                releaseSources(winSources);
                winSources = null;
            }
            sources = await desktopCapturer.getSources({
                types: ['screen'], thumbnailSize: { width: 768, height: 768 }
            });
            if (sources.length > 0) {
                const result = sources[0].thumbnail.toJPEG(40).toString('base64');
                releaseSources(sources);
                return result;
            }
            releaseSources(sources);
            return null;
        } catch (error) {
            releaseSources(winSources);
            releaseSources(sources);
            console.error('HQ screen capture failed:', error);
            return null;
        }
    });

    ipcMain.handle('get-active-window', async () => {
        try {
            const activeWin = (await import('active-win')).default;
            const result = await activeWin();
            if (result) return { success: true, data: result };
            return { success: false, error: 'no active window' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-open-windows', async () => {
        try {
            const { getOpenWindows } = await import('active-win');
            const windows = await getOpenWindows();
            return { success: true, data: windows || [] };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-system-idle-time', () => {
        return powerMonitor.getSystemIdleTime();
    });
}

module.exports = { registerScreenCapture };
