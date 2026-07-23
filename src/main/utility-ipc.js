/**
 * UtilityIPC — General utility IPC handlers.
 * Extracted from main.js lines 532-592.
 */
const { isValidURL } = require('./validators');

function registerUtilityIPC(ctx, ipcMain, deps) {
    // deps: { configManager, mt, Menu, shell, app, createSettingsWindow }
    const { configManager, mt, Menu, shell, app } = deps;

    ipcMain.handle('load-config', async () => {
        return await configManager.loadConfigFile();
    });

    ipcMain.handle('save-config', async (event, data) => {
        if (data.uiLanguage) ctx._cachedLang = data.uiLanguage;
        const result = await configManager.saveConfigFile(data);
        // Notify pet window to hot-reload model config
        if (data.model && ctx.petWindow && !ctx.petWindow.isDestroyed()) {
            const config = await configManager.loadConfigFile();
            ctx.petWindow.webContents.send('model-config-update', config.model);
        }
        return result;
    });

    ipcMain.handle('get-cursor-position', async () => {
        const { screen } = require('electron');
        return screen.getCursorScreenPoint();
    });

    ipcMain.handle('show-pet-context-menu', async () => {
        if (!ctx.petWindow || ctx.petWindow.isDestroyed()) return;
        const sizes = [200, 300, 400, 500];
        const template = [
            { label: mt('main.size'), submenu: sizes.map(s => ({
                label: `${s}x${s}`,
                click: () => {
                    ctx.petWindow.setResizable(true);
                    ctx.petWindow.setSize(s, s);
                    ctx.petWindow.setResizable(false);
                    ctx.petWindow.webContents.send('size-changed', s);
                }
            }))},
            { type: 'separator' },
            { label: mt('main.settings'), click: () => {
                if (ctx.settingsWindow && !ctx.settingsWindow.isDestroyed()) {
                    ctx.settingsWindow.show(); ctx.settingsWindow.focus();
                } else { deps.createSettingsWindow(); }
            }},
            { label: mt('main.close'), click: () => { if (ctx.petWindow && !ctx.petWindow.isDestroyed()) ctx.petWindow.close(); }}
        ];
        Menu.buildFromTemplate(template).popup({ window: ctx.petWindow });
    });

    ipcMain.handle('get-gender-term', async () => {
        return { success: true, term: 'you' };
    });

    ipcMain.handle('open-dev-tools', async () => {
        if (ctx.petWindow && !ctx.petWindow.isDestroyed()) ctx.petWindow.webContents.openDevTools();
        return { success: true };
    });

    ipcMain.handle('get-app-path', async () => {
        return app.getAppPath();
    });

    ipcMain.handle('open-external', async (_, url) => {
        if (!isValidURL(url)) return { success: false, error: 'invalid URL' };
        await shell.openExternal(url);
    });

    ipcMain.handle('show-settings', async () => {
        if (ctx.settingsWindow && !ctx.settingsWindow.isDestroyed()) {
            ctx.settingsWindow.show();
            ctx.settingsWindow.focus();
        } else {
            deps.createSettingsWindow();
        }
        return { success: true };
    });

    // Forward renderer console.log to main process stdout (no --enable-logging needed)
    ipcMain.on('renderer-log', (_, level, args) => {
        const fn = console[level] || console.log;
        fn.apply(console, args);
    });
}

module.exports = { registerUtilityIPC };
