const { contextBridge, ipcRenderer } = require('electron');

/**
 * Register an IPC listener and return an unsubscribe function.
 *
 * `ipcRenderer.on` has no detach of its own, and the renderer's hot-reload paths
 * re-register the same listeners (a model-config save reloads the adapter), so the
 * old ones piled up and each kept driving an element that was already gone.
 * Handing back the unsubscribe makes dropping them possible; ignoring the return
 * value stays exactly as harmless as it was before.
 */
function onIpc(channel, handler) {
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('electronAPI', {
    // Pet window
    createPetWindow: (data) => ipcRenderer.invoke('create-pet-window', data),
    closePetWindow: () => ipcRenderer.invoke('close-pet-window'),
    updatePetCharacter: (data) => ipcRenderer.invoke('update-pet-character', data),
    getCharacterData: () => ipcRenderer.invoke('get-character-data'),

    // Window control
    setWindowSize: (w, h) => ipcRenderer.invoke('set-window-size', w, h),
    setWindowPosition: (x, y, w, h) => ipcRenderer.invoke('set-window-position', x, y, w, h),
    getWindowBounds: () => ipcRenderer.invoke('get-window-bounds'),
    setCanvasY: (val) => ipcRenderer.invoke('set-canvas-y', val),
    onSetCanvasY: (callback) => onIpc('set-canvas-y', (_, val) => callback(val)),
    getWindowPosition: () => ipcRenderer.invoke('get-window-position'),

    // Chat bubble
    showPetChat: (msg, time) => ipcRenderer.invoke('show-pet-chat', msg, time),
    closeChatBubble: () => ipcRenderer.invoke('close-chat-bubble'),
    resizeChatBubble: (w, h) => ipcRenderer.invoke('resize-chat-bubble', w, h),

    // Screen & window detection
    getScreenCapture: () => ipcRenderer.invoke('get-screen-capture'),
    getScreenCaptureHQ: (targetTitle) => ipcRenderer.invoke('get-screen-capture-hq', targetTitle),
    getActiveWindow: () => ipcRenderer.invoke('get-active-window'),
    getOpenWindows: () => ipcRenderer.invoke('get-open-windows'),
    getSystemIdleTime: () => ipcRenderer.invoke('get-system-idle-time'),

    // Utility
    getGenderTerm: () => ipcRenderer.invoke('get-gender-term'),
    openDevTools: () => ipcRenderer.invoke('open-dev-tools'),
    getAppPath: () => ipcRenderer.invoke('get-app-path'),
    showSettings: () => ipcRenderer.invoke('show-settings'),
    createChatWindow: () => ipcRenderer.invoke('create-chat-window'),
    closeChatWindow: () => ipcRenderer.invoke('close-chat-window'),
    loadConfig: () => ipcRenderer.invoke('load-config'),
    saveConfig: (data) => ipcRenderer.invoke('save-config', data),
    getCursorPosition: () => ipcRenderer.invoke('get-cursor-position'),
    showPetContextMenu: () => ipcRenderer.invoke('show-pet-context-menu'),

    // Character card management
    listCharacters: () => ipcRenderer.invoke('list-characters'),
    loadPrompt: (id) => ipcRenderer.invoke('load-prompt', id),
    savePrompt: (id, data) => ipcRenderer.invoke('save-prompt', id, data),
    resetPrompt: (id) => ipcRenderer.invoke('reset-prompt', id),
    createCharacter: (name) => ipcRenderer.invoke('create-character', name),
    deleteCharacter: (id) => ipcRenderer.invoke('delete-character', id),
    renameCharacter: (id, name) => ipcRenderer.invoke('rename-character', id, name),
    setActiveCharacter: (id) => ipcRenderer.invoke('set-active-character', id),
    importCharacter: () => ipcRenderer.invoke('import-character'),
    resetBuiltinCards: () => ipcRenderer.invoke('reset-builtin-cards'),

    // Emotion system
    triggerExpression: (name) => ipcRenderer.invoke('trigger-expression', name),
    revertExpression: () => ipcRenderer.invoke('revert-expression'),
    triggerMotion: (group, index) => ipcRenderer.invoke('trigger-motion', group, index),
    reportHoverState: (hovering) => ipcRenderer.invoke('report-hover-state', hovering),
    reportHit: (data) => ipcRenderer.invoke('report-hit', data),

    // Model import & scanning (Phase 1)
    selectModelFolder: () => ipcRenderer.invoke('select-model-folder'),
    scanModelInfo: (folder, file) => ipcRenderer.invoke('scan-model-info', folder, file),
    selectStaticImage: () => ipcRenderer.invoke('select-static-image'),
    selectImageFolder: () => ipcRenderer.invoke('select-image-folder'),
    scanImageFolder: (folderPath) => ipcRenderer.invoke('scan-image-folder', folderPath),
    setTalkingState: (isTalking) => ipcRenderer.invoke('set-talking-state', isTalking),
    // 让宠物说出指定文案（合成交给主进程；宠物窗与 OBS 源各自播放并驱动口型）
    petSay: (text, options) => ipcRenderer.invoke('pet-say', text, options || {}),
    petSayStop: () => ipcRenderer.invoke('pet-say-stop'),
    // 在别的窗口里播音频时，由播放方每帧上报口型开合度
    setMouthLevel: (level) => ipcRenderer.invoke('set-mouth-level', level),
    selectBubbleImage: () => ipcRenderer.invoke('select-bubble-image'),
    selectAppIcon: () => ipcRenderer.invoke('select-app-icon'),
    copyModelToUserdata: (folder, modelName) => ipcRenderer.invoke('copy-model-to-userdata', folder, modelName),
    validateModelPaths: () => ipcRenderer.invoke('validate-model-paths'),
    deleteProfile: (id) => ipcRenderer.invoke('delete-profile', id),

    // TTS (Phase 2)
    ttsSynthesize: (text) => ipcRenderer.invoke('tts-synthesize', text),
    ttsGetStatus: () => ipcRenderer.invoke('tts-get-status'),
    ttsRestart: () => ipcRenderer.invoke('tts-restart'),
    ttsReinit: (config) => ipcRenderer.invoke('tts-reinit', config),
    ttsDiagnose: () => ipcRenderer.invoke('tts-diagnose'),
    appRelaunch: () => ipcRenderer.invoke('app-relaunch'),
    ttsSetConfig: (config) => ipcRenderer.invoke('tts-set-config', config),
    ttsGetMetas: () => ipcRenderer.invoke('tts-get-metas'),
    ttsGetAvailableVvms: () => ipcRenderer.invoke('tts-get-available-vvms'),
    downloadVvm: (filename) => ipcRenderer.invoke('download-vvm', filename),
    setupVoicevox: () => ipcRenderer.invoke('setup-voicevox'),
    // onVoicevoxSetupProgress 已删除：main 侧从不发送 voicevox-setup-progress，
    // 渲染层也没有任何调用点 —— VOICEVOX 被 Mimo 取代后留下的空桥接。

    // Default audio (Phase 2)
    generateDefaultAudio: (phrases, styleId) => ipcRenderer.invoke('generate-default-audio', phrases, styleId),
    loadDefaultAudio: () => ipcRenderer.invoke('load-default-audio'),

    // ========== DeepSeek Harness (DSH) 桥接 ==========
    // 让桌宠直接驱动 dsh：一次性 headless 任务，最终答复经 stdout 返回。
    dshStatus: () => ipcRenderer.invoke('dsh-status'),
    dshProbe: () => ipcRenderer.invoke('dsh-probe'),
    dshConfig: (patch) => ipcRenderer.invoke('dsh-config', patch),
    dshRun: (task) => ipcRenderer.invoke('dsh-run', task),
    dshCancel: () => ipcRenderer.invoke('dsh-cancel'),
    onDshOutput: (cb) => onIpc('dsh://output', (e, data) => cb(data)),
    onDshDone: (cb) => onIpc('dsh://done', (e, data) => cb(data)),

    // ========== 哔哩哔哩直播间弹幕 ==========
    // 读取直播间弹幕，让桌宠对弹幕作出回应。
    biliStatus: () => ipcRenderer.invoke('bili-status'),
    biliStart: (roomId) => ipcRenderer.invoke('bili-start', roomId),
    biliStop: () => ipcRenderer.invoke('bili-stop'),
    biliConfig: (patch) => ipcRenderer.invoke('bili-config', patch),
    onBiliDanmaku: (cb) => onIpc('bili://danmaku', (e, data) => cb(data)),
    onBiliStatus: (cb) => onIpc('bili://status', (e, data) => cb(data)),

    // ========== OBS 兼容模式 ==========
    // Chromium 绕过 Windows GDI，OBS 读窗口会得到纯黑；关掉 GPU 合成才能被抓到。
    obsModeGet: () => ipcRenderer.invoke('obs-mode-get'),
    obsModeSet: (patch) => ipcRenderer.invoke('obs-mode-set', patch),
    appRestart: () => ipcRenderer.invoke('app-restart'),

    // 浏览器源（推荐）：OBS 自己渲染桌宠页面，不依赖窗口采集，透明正常
    obsServerGet: () => ipcRenderer.invoke('obs-server-get'),
    obsServerStart: (patch) => ipcRenderer.invoke('obs-server-start', patch),
    obsServerStop: () => ipcRenderer.invoke('obs-server-stop'),
    // 桌宠在浏览器源画面里的位置与大小（实时推送到 OBS）
    obsTransformSet: (patch) => ipcRenderer.invoke('obs-transform-set', patch),

    // ========== 离线语音识别（原生 libvosk，完全离线） ==========
    // 渲染进程负责麦克风（只有它能调 getUserMedia），把 16kHz 单声道 PCM
    // 按 ~100ms 一块送主进程；主进程持有原生引擎并回传识别文字。
    asrStatus: () => ipcRenderer.invoke('asr-status'),
    asrInstall: () => ipcRenderer.invoke('asr-install'),
    asrStart: () => ipcRenderer.invoke('asr-start'),
    asrStop: () => ipcRenderer.invoke('asr-stop'),
    asrFeed: (pcm) => ipcRenderer.send('asr-feed', pcm),
    onAsrResult: (cb) => onIpc('asr://result', (e, text) => cb(text)),
    onAsrInstallProgress: (cb) => onIpc('asr://install-progress', (e, info) => cb(info)),

    // Event listeners (原有)
    onCharacterUpdate: (cb) => onIpc('character-update', (e, data) => cb(data)),
    onPetWindowClosed: (cb) => onIpc('pet-window-closed', () => cb()),
    onChatBubbleMessage: (cb) => onIpc('chat-bubble-message', (e, data) => cb(data)),
    // onShowChatMessage 已删除：main 侧从不发送 show-chat-message，渲染层也没有调用点。
    onSizeChanged: (cb) => onIpc('size-changed', (e, size) => cb(size)),
    onPlayExpression: (cb) => onIpc('play-expression', (e, name) => cb(name)),
    onRevertExpression: (cb) => onIpc('revert-expression', () => cb()),
    onPlayMotion: (cb) => onIpc('play-motion', (e, group, index) => cb(group, index)),
    onTalkingStateChanged: (cb) => onIpc('talking-state-changed', (e, isTalking) => cb(isTalking)),
    onPetSay: (cb) => onIpc('pet-say', (e, payload) => cb(payload)),
    onPetSayStop: (cb) => onIpc('pet-say-stop', () => cb()),
    onMouthLevel: (cb) => onIpc('mouth-level', (e, level) => cb(level)),
    onPetHoverState: (cb) => onIpc('pet-hover-state', (e, hovering) => cb(hovering)),
    onPetHit: (cb) => onIpc('pet-hit', (e, data) => cb(data)),
    onModelConfigUpdate: (cb) => onIpc('model-config-update', (e, config) => cb(config)),

    // External links
    openExternal: (url) => ipcRenderer.invoke('open-external', url),

    // Enhance system
    saveEnhanceData: (data) => ipcRenderer.invoke('save-enhance-data', data),
    loadEnhanceData: () => ipcRenderer.invoke('load-enhance-data'),
    webSearch: (query, provider, options) => ipcRenderer.invoke('web-search', query, provider, options),

    // Renderer log forwarding (avoids needing --enable-logging)
    rendererLog: (level, args) => ipcRenderer.send('renderer-log', level, args)
});