/**
 * TrayManager — System tray icon and context menu.
 * Extracted from main.js lines 188-231.
 */
function createTrayManager(ctx, deps) {
    // deps: { Tray, Menu, path, mt, createSettingsWindow, basePath }
    const { Tray, Menu, path, mt, basePath } = deps;

    function createTray() {
        ctx.tray = new Tray(path.join(basePath, 'assets', 'app-icon.png'));
        ctx.tray.setToolTip('Live2DPet');
        ctx.tray.on('click', () => {
            if (ctx.settingsWindow && !ctx.settingsWindow.isDestroyed()) {
                ctx.settingsWindow.show();
                ctx.settingsWindow.focus();
            } else {
                deps.createSettingsWindow();
            }
        });
        updateTrayMenu();
    }

    function updateTrayMenu() {
        if (!ctx.tray) return;
        const hasPet = ctx.petWindow && !ctx.petWindow.isDestroyed();
        const template = [
            { label: mt('tray.showSettings'), click: () => {
                if (ctx.settingsWindow && !ctx.settingsWindow.isDestroyed()) {
                    ctx.settingsWindow.show();
                    ctx.settingsWindow.focus();
                } else {
                    deps.createSettingsWindow();
                }
            }},
            { label: hasPet ? mt('tray.hidePet') : mt('tray.showPet'), click: () => {
                if (ctx.petWindow && !ctx.petWindow.isDestroyed()) {
                    ctx.petWindow.close();
                } else if (ctx.settingsWindow && !ctx.settingsWindow.isDestroyed()) {
                    ctx.settingsWindow.show();
                    ctx.settingsWindow.focus();
                }
            }},
            { type: 'separator' },
            { label: mt('tray.quit'), click: () => {
                ctx.isQuitting = true;
                deps.app.quit();
            }}
        ];
        ctx.tray.setContextMenu(Menu.buildFromTemplate(template));
    }

    return { createTray, updateTrayMenu };
}

module.exports = { createTrayManager };
