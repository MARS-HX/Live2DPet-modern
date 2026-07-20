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
const { createPathUtils } = require('./src/utils/path-utils');
const { TTSService } = require('./src/core/tts-service');
const { TranslationService } = require('./src/core/translation-service');

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
    ctx.translationService = new TranslationService();

    createSettingsWindow();
    trayManager.createTray();

    // TTS 初始化（原有逻辑）
    setImmediate(async () => {
        const config = await configManager.loadConfigFile();
        const ttsConfig = config.tts || {};
        const serviceType = ttsConfig.serviceType || 'voicevox';
        let initSuccess = false;
        if (serviceType === 'mimo') {
            const mimoOptions = {
                serviceType: 'mimo',
                mimo: {
                    baseURL: ttsConfig.mimo?.baseURL || 'https://api.xiaomimimo.com/v1',
                    apiKey: ttsConfig.mimo?.apiKey || '',
                    voice: ttsConfig.mimo?.voice || 'Chloe',
                    model: ttsConfig.mimo?.model || 'mimo-v2.5-tts',
                    format: ttsConfig.mimo?.format || 'wav',
                    speed: ttsConfig.mimo?.speed ?? 1.0,
                    pitch: ttsConfig.mimo?.pitch ?? 1.0,
                    stylePrompt: ttsConfig.mimo?.stylePrompt || '小女孩、活泼、开朗、充满好奇心'
                }
            };
            initSuccess = ctx.ttsService.init(mimoOptions);
            if (initSuccess && ttsConfig.mimo) ctx.ttsService.setConfig({ mimo: ttsConfig.mimo });
        } else {
            const voicevoxDir = ctx.pathUtils.getVoicevoxPath();
            if (voicevoxDir && fs.existsSync(voicevoxDir)) {
                const vvmFiles = ttsConfig.vvmFiles || ['0.vvm', '8.vvm'];
                const gpuMode = ttsConfig.gpuMode || false;
                initSuccess = ctx.ttsService.init(voicevoxDir, vvmFiles, { gpuMode });
                if (initSuccess && ttsConfig) ctx.ttsService.setConfig(ttsConfig);
            } else {
                console.log('[TTS] voicevox_core not found, VOICEVOX TTS disabled');
            }
        }
        console.log(`[TTS] ${initSuccess ? 'Initialized' : 'Not available'} with backend: ${serviceType}`);

        if (config.apiKey) {
            const tl = config.translation || {};
            ctx.translationService.configure({
                apiKey: tl.apiKey || config.apiKey,
                baseURL: tl.baseURL || config.baseURL || 'https://openrouter.ai/api/v1',
                modelName: tl.modelName || config.modelName || 'x-ai/grok-4.1-fast'
            });
        }
    });
});

app.on('window-all-closed', () => {
    if (!ctx.tray && process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
    ctx.isQuitting = true;
});