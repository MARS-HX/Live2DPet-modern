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

    /** 根据屏幕 DPI 计算最佳截图尺寸（高清屏自动放大） */
    function _getCaptureSize() {
        try {
            const { screen } = require('electron');
            const display = screen.getPrimaryDisplay();
            const scale = display.scaleFactor || 1;
            // 基础 512px，按 DPI 缩放，上限 1536px
            const base = 512;
            const size = Math.min(1536, Math.round(base * Math.min(scale, 2)));
            return { width: size, height: size };
        } catch {
            return { width: 512, height: 512 };
        }
    }

    /** 根据屏幕 DPI 计算 HQ 尺寸 */
    function _getCaptureSizeHQ() {
        try {
            const { screen } = require('electron');
            const display = screen.getPrimaryDisplay();
            const scale = display.scaleFactor || 1;
            const base = 768;
            const size = Math.min(2048, Math.round(base * Math.min(scale, 2)));
            return { width: size, height: size };
        } catch {
            return { width: 768, height: 768 };
        }
    }

    ipcMain.handle('get-screen-capture', async (event, targetTitle) => {
        let winSources = null, sources = null;
        try {
            const capSize = _getCaptureSize();
            if (targetTitle) {
                winSources = await desktopCapturer.getSources({
                    types: ['window'], thumbnailSize: capSize
                });
                const match = winSources.find(s => s.name === targetTitle);
                if (match) {
                    const result = match.thumbnail.toJPEG(75).toString('base64'); // 30→75
                    releaseSources(winSources);
                    return { success: true, data: result };
                }
                releaseSources(winSources);
                winSources = null;
            }
            sources = await desktopCapturer.getSources({
                types: ['screen'], thumbnailSize: capSize
            });
            if (sources.length > 0) {
                const result = sources[0].thumbnail.toJPEG(75).toString('base64'); // 30→75
                releaseSources(sources);
                return { success: true, data: result };
            }
            releaseSources(sources);
            return { success: false, error: 'no capture source' };
        } catch (error) {
            releaseSources(winSources);
            releaseSources(sources);
            console.error('Screen capture failed:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-screen-capture-hq', async (event, targetTitle) => {
        let winSources = null, sources = null;
        try {
            const capSize = _getCaptureSizeHQ();
            if (targetTitle) {
                winSources = await desktopCapturer.getSources({
                    types: ['window'], thumbnailSize: capSize
                });
                const match = winSources.find(s => s.name === targetTitle);
                if (match) {
                    const result = match.thumbnail.toJPEG(85).toString('base64'); // 40→85
                    releaseSources(winSources);
                    return { success: true, data: result };
                }
                releaseSources(winSources);
                winSources = null;
            }
            sources = await desktopCapturer.getSources({
                types: ['screen'], thumbnailSize: capSize
            });
            if (sources.length > 0) {
                const result = sources[0].thumbnail.toJPEG(85).toString('base64'); // 40→85
                releaseSources(sources);
                return { success: true, data: result };
            }
            releaseSources(sources);
            return { success: false, error: 'no capture source' };
        } catch (error) {
            releaseSources(winSources);
            releaseSources(sources);
            console.error('HQ screen capture failed:', error);
            return { success: false, error: error.message };
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
