/**
 * main.js — Electron main process orchestrator (without STT)
 */
const { app, BrowserWindow, ipcMain, desktopCapturer, Menu, Tray, dialog, shell, powerMonitor, systemPreferences, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

// 全局启用 Web Speech API（备用，但已禁用 STT）
app.commandLine.appendSwitch('enable-blink-features', 'SpeechRecognition');

// OBS 兼容模式：必须在 GPU 进程启动前决定，所以同步读一次配置。
// Chromium 的渲染绕过了 Windows GDI，OBS 读窗口只会得到纯黑；
// 关掉 GPU 合成后 OBS 才能抓到画面（代价是渲染性能下降，因此做成开关）。
const { applyObsCompatibility } = require('./src/main/obs-mode');
const obsMode = applyObsCompatibility(app, { fs, path, app, basePath: __dirname });
if (obsMode.enabled) {
    console.log('[OBS] compatibility mode ON —', obsMode.switches.join(', '));
}
global.__obsModeActive = obsMode.enabled;

const { AppContext } = require('./src/main/app-context');
const { createConfigManager } = require('./src/main/config-manager');
const { createI18nHelper } = require('./src/main/i18n-helper');
const { createTrayManager } = require('./src/main/tray-manager');
const { registerWindowHandlers } = require('./src/main/window-manager');
const { registerScreenCapture } = require('./src/main/screen-capture');
const { registerUtilityIPC } = require('./src/main/utility-ipc');
const { registerCharacterHandlers } = require('./src/main/character-manager');
const { registerEmotionIPC } = require('./src/main/emotion-ipc');
const { registerTTSIPC } = require('./src/main/tts-ipc');
const { registerEnhanceIPC } = require('./src/main/enhance-ipc');
const { registerDefaultAudioIPC } = require('./src/main/default-audio-ipc');
const { registerModelImport } = require('./src/main/model-import');
const { registerDshIPC } = require('./src/main/dsh-ipc');
const { registerBilibiliIPC } = require('./src/main/bilibili-ipc');
const { registerObsIPC } = require('./src/main/obs-ipc');
const { createPathUtils } = require('./src/utils/path-utils');
const { TTSService } = require('./src/core/tts-service');

const ctx = new AppContext();
const configManager = createConfigManager(app);
const { mt } = createI18nHelper(ctx);
const basePath = __dirname;

// ========== 不再加载 STT 服务 ==========

const { createSettingsWindow } = registerWindowHandlers(ctx, ipcMain, {
    BrowserWindow, path, basePath, updateTrayMenu: () => trayManager.updateTrayMenu()
});

const trayManager = createTrayManager(ctx, {
    Tray, Menu, path, mt, basePath, app, createSettingsWindow
});

registerScreenCapture(ctx, ipcMain, { desktopCapturer, powerMonitor });
registerUtilityIPC(ctx, ipcMain, { configManager, mt, Menu, shell, app, createSettingsWindow });
registerCharacterHandlers(ctx, ipcMain, { fs, path, crypto, app, dialog, configManager });
registerEmotionIPC(ctx, ipcMain);
registerTTSIPC(ctx, ipcMain, { configManager, fs, path, app, mt });
registerEnhanceIPC(ctx, ipcMain, { app, fs, https, http });
registerDefaultAudioIPC(ctx, ipcMain, { app, fs, path, configManager });
registerModelImport(ctx, ipcMain, { app, fs, path, dialog, mt, configManager, BrowserWindow });

// ========== DeepSeek Harness bridge ==========
registerDshIPC(ctx, ipcMain, { configManager, app, path });

// ========== Bilibili live danmaku ==========
registerBilibiliIPC(ctx, ipcMain, { configManager, app });

// ========== OBS 兼容模式 ==========
ctx.obsModeActive = !!global.__obsModeActive;
registerObsIPC(ctx, ipcMain, { configManager, app });

// ========== 麦克风权限（保留，但 STT 未使用） ==========
ipcMain.handle('REQUEST_MICROPHONE_ACCESS', async () => {
    if (process.platform === 'darwin') {
        const status = systemPreferences.getMediaAccessStatus('microphone');
        if (status !== 'granted') {
            return await systemPreferences.askForMediaAccess('microphone');
        }
        return status === 'granted';
    }
    return true;
});

// ========== 不再注册 stt 相关 IPC ==========

// ========== App Lifecycle ==========
app.whenReady().then(async () => {
    // 自动授予媒体权限（避免弹窗）
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        callback(permission === 'media');
    });

    ctx.pathUtils = createPathUtils(app, path);
    try { ctx._cachedLang = (await configManager.loadConfigFile()).uiLanguage || 'en'; } catch {}

    // 初始化 TTS
    ctx.ttsService = new TTSService();

    createSettingsWindow();
    trayManager.createTray();

    // TTS 初始化（多后端支持）
    setImmediate(async () => {
        const config = await configManager.loadConfigFile();
        const ttsConfig = config.tts || {};
        const serviceType = ttsConfig.serviceType || 'mimo';
        const options = { serviceType };

        if (ttsConfig.mimo || serviceType === 'mimo') {
            options.mimo = {
                baseURL: ttsConfig.mimo?.baseURL || 'https://api.xiaomimimo.com/v1',
                apiKey: ttsConfig.mimo?.apiKey || '',
                model: ttsConfig.mimo?.model || 'mimo-v2.5-tts',
                format: ttsConfig.mimo?.format || 'wav',
                stylePrompt: ttsConfig.mimo?.stylePrompt || '自然、流畅、清晰的中文语音'
            };
        }
        if (ttsConfig.aliyun || serviceType === 'aliyun') {
            options.aliyun = {
                apiKey: ttsConfig.aliyun?.apiKey || '',
                accessKeyId: ttsConfig.aliyun?.accessKeyId || '',
                accessKeySecret: ttsConfig.aliyun?.accessKeySecret || '',
                voice: ttsConfig.aliyun?.voice || 'longxiaoxia'
            };
        }
        if (ttsConfig.local || serviceType === 'local') {
            options.local = {
                baseURL: ttsConfig.local?.baseURL || 'http://localhost:7860',
                ttsEndpoint: ttsConfig.local?.ttsEndpoint || '/run/tts',
                method: ttsConfig.local?.method || 'get',
                textParam: ttsConfig.local?.textParam || 'text',
                speaker: ttsConfig.local?.speaker || '0',
                language: ttsConfig.local?.language || 'zh',
                responseType: ttsConfig.local?.responseType || 'json',
                audioPath: ttsConfig.local?.audioPath || 'audio'
            };
        }

        const initSuccess = ctx.ttsService.init(options);
        console.log(`[TTS] ${initSuccess ? 'Initialized' : 'Not available'} with backend: ${serviceType}`);
    });
});

app.on('window-all-closed', () => {
    if (!ctx.tray && process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
    ctx.isQuitting = true;
});