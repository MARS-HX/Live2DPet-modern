/**
 * vision-ipc.js — 把识屏流水线暴露给渲染进程。
 *
 * 职责边界（和 ASR 那边同一套思路）：
 *   - **采集与流水线在主进程**（ffmpeg 子进程、内存里的帧缓冲、PNG 编码都在这里，
 *     渲染进程不该为了看一眼屏幕去解码 12fps 的 rawvideo）；
 *   - **渲染进程只做决策**（桌面宠物决定"现在要不要看一眼"），通过 IPC 拿 data URL。
 *
 * 通道一览：
 *   vision-status  → { running, quality, frames, sheets, stats, ffmpeg, ... }
 *   vision-start   → 显式开始采集（通常不用调，grab 会自动启动）
 *   vision-grab    → 阻塞到有一张图，返回 { ok, payload:{dataUrl, frames:[...]}, ... }
 *   vision-peek    → 立刻取队列里已有的那张（没有就 null）
 *   vision-stop    → 停止（默认立硬闸，不许自动拉起）
 *   vision-config  → 读/写视觉相关配置（quality / pace / scene）
 *
 * 推送事件：
 *   vision://sheet  有新图（后台唤醒用，payload 同 grab 的 payload）
 */

'use strict';

const {
    createScreenObserver, SIZES, PACES, DEFAULT_PACE, DEFAULT_QUALITY, SCENE_OPTS,
} = require('../core/screen-observer');

/** 一次 grab 最多阻塞多久。主进程不能无限挂着 —— 渲染进程可能已经不在了。 */
const MAX_GRAB_SECONDS = 120;

function registerVisionIPC(ctx, ipcMain, deps = {}) {
    const { app, configManager, logger = console } = deps;

    let observer = null;
    let cachedCfg = null;

    /** 读视觉配置（带默认值），失败不影响采集 */
    async function readSettings() {
        let cfg = {};
        try { cfg = (await configManager.loadConfigFile()).vision || {}; } catch { /* defaults */ }
        const quality = SIZES[cfg.quality] ? cfg.quality : DEFAULT_QUALITY;
        const pace = PACES[cfg.pace] ? cfg.pace : DEFAULT_PACE;
        return {
            enabled: cfg.enabled !== false,
            quality,
            pace,
            scene: cfg.scene === true,
            graceSec: Number.isFinite(cfg.graceSec) ? cfg.graceSec : 60,
            minFrames: Number.isFinite(cfg.minFrames) ? cfg.minFrames : 1,
            ffmpegPath: cfg.ffmpegPath || null,
            fps: Number.isFinite(cfg.fps) ? cfg.fps : 12,
            wakeIntervalSec: Number.isFinite(cfg.wakeIntervalSec) ? cfg.wakeIntervalSec : null,
            // 让模型看到"这段时间发生了什么"而不是"此刻"
            speakPreview: cfg.speakPreview !== false,
        };
    }

    function getObserver(settings) {
        if (observer) return observer;
        let userDataPath = null;
        try { userDataPath = app.getPath('userData'); } catch { /* ignore */ }
        observer = createScreenObserver({
            ffmpegPath: settings.ffmpegPath,
            graceSec: settings.graceSec,
            userDataPath,
            log: (...a) => logger.log?.(...a),
        });
        ctx.visionObserver = observer;
        return observer;
    }

    /** 该用哪套 pipeline 参数：pace 档 + 逐场景模式 */
    function pipelineOpts(settings) {
        const pace = PACES[settings.pace] ?? PACES[DEFAULT_PACE];
        const base = { ...pace.pipeline, fps: settings.fps };
        if (settings.scene) return { ...base, ...SCENE_OPTS };
        return base;
    }

    /** 把 pace 的 cutAbs 塞进管线参数 */
    function grabOpts(settings, extra = {}) {
        const pace = PACES[settings.pace] ?? PACES[DEFAULT_PACE];
        return {
            quality: settings.quality,
            minFrames: settings.minFrames,
            opts: { cutAbs: pace.cutAbs, ...pipelineOpts(settings) },
            ...extra,
        };
    }

    ipcMain.handle('vision-status', async () => {
        const settings = await readSettings();
        const obs = observer;
        return {
            ...(obs ? obs.status() : {
                running: false, quality: settings.quality, frames: 0, sheets: 0,
                stats: null, pending: 0, ffmpeg: null,
            }),
            settings,
            sizes: SIZES,
            paces: Object.keys(PACES),
            sceneOpts: SCENE_OPTS,
            // 平台支持情况
            platformSupported: process.platform === 'win32' || process.platform === 'darwin',
        };
    });

    ipcMain.handle('vision-start', async (_e, patch = null) => {
        const settings = await readSettings();
        if (patch && typeof patch === 'object') {
            const current = await configManager.loadConfigFile();
            await configManager.saveConfigFile({ vision: { ...(current.vision || {}), ...patch } });
            cachedCfg = null;
        }
        const eff = patch ? await readSettings() : settings;
        const obs = getObserver(eff);
        try {
            const r = await obs.start({
                src: { kind: 'screen' },
                opts: pipelineOpts(eff),
                quality: eff.quality,
            });
            return { success: true, ...r, status: obs.status() };
        } catch (e) {
            return { success: false, error: e.message, status: obs.status() };
        }
    });

    /**
     * 核心接口：要一张图。
     * 渲染进程传 `seconds` 控制最多阻塞多久（默认 30，封顶 120）。
     */
    ipcMain.handle('vision-grab', async (_e, options = {}) => {
        const settings = await readSettings();
        if (!settings.enabled) return { ok: false, reason: 'disabled', waited: 0 };
        const obs = getObserver(settings);
        const seconds = Math.min(MAX_GRAB_SECONDS, Math.max(2, Number(options.seconds) || 30));
        // 逐场景 / 清晰度可以单次覆盖（决定要不要重开管线）
        const q = SIZES[options.quality] ? options.quality : settings.quality;
        const scene = options.scene === undefined ? settings.scene : options.scene === true;
        const eff = { ...settings, quality: q, scene };
        try {
            const res = await obs.grab(grabOpts(eff, { seconds }));
            return res;
        } catch (e) {
            return { ok: false, reason: 'error', error: e.message, waited: 0 };
        }
    });

    ipcMain.handle('vision-peek', async () => {
        if (!observer) return { ok: false, reason: 'not-running', payload: null };
        const payload = observer.grabPeek();
        return payload ? { ok: true, payload } : { ok: false, reason: 'empty', payload: null };
    });

    ipcMain.handle('vision-stop', async (_e, opts = {}) => {
        if (!observer) return { success: true, stopped: false };
        const r = observer.stop({ suppress: opts.suppress !== false });
        return { success: true, ...r };
    });

    ipcMain.handle('vision-config', async (_e, patch) => {
        try {
            if (patch && typeof patch === 'object') {
                const current = await configManager.loadConfigFile();
                const merged = { ...(current.vision || {}), ...patch };
                await configManager.saveConfigFile({ vision: merged });
            }
            const settings = await readSettings();
            return { success: true, settings };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    /**
     * 后台常驻：有新图就算"可以唤醒模型看一眼"。
     *
     * 这条通道和 `vision-grab` 的区别：grab 是**主动要**（阻塞等），
     * 这里是**被动通知**（有一张攒好的了就推给渲染进程）。
     * 渲染进程自己决定要不要因为这张图去问模型。
     */
    ipcMain.handle('vision-watch-start', async (_e, options = {}) => {
        const settings = await readSettings();
        if (!settings.enabled) return { success: false, error: 'disabled' };
        const obs = getObserver(settings);
        const intervalSec = Number(options.intervalSec)
            || settings.wakeIntervalSec
            || (PACES[settings.pace] ?? PACES[DEFAULT_PACE]).wakeGapSec;

        if (ctx.visionWakeTimer) clearInterval(ctx.visionWakeTimer);
        ctx.visionWakeTimer = setInterval(async () => {
            try {
                if (!obs.status().running) {
                    obs.touch();
                    // 没在跑但也不是用户停的 → 拉起来（否则静止屏幕永远不会有图）
                    if (!obs.isSuppressed() && !obs.status().running) {
                        await obs.start({
                            src: { kind: 'screen' },
                            opts: pipelineOpts(settings),
                            quality: settings.quality,
                        });
                    }
                    return;
                }
                obs.touch();
                const payload = observer.grabPeek();
                if (!payload) return;
                const { BrowserWindow } = require('electron');
                for (const win of BrowserWindow.getAllWindows()) {
                    if (win.isDestroyed()) continue;
                    try { win.webContents.send('vision://sheet', payload); } catch { /* closing */ }
                }
            } catch (e) {
                logger.warn?.(`[Vision] wake tick failed: ${e.message}`);
            }
        }, Math.max(5, intervalSec) * 1000);
        if (ctx.visionWakeTimer.unref) ctx.visionWakeTimer.unref();
        return { success: true, intervalSec };
    });

    ipcMain.handle('vision-watch-stop', async () => {
        if (ctx.visionWakeTimer) { clearInterval(ctx.visionWakeTimer); ctx.visionWakeTimer = null; }
        return { success: true };
    });

    app.on?.('before-quit', () => {
        if (ctx.visionWakeTimer) { clearInterval(ctx.visionWakeTimer); ctx.visionWakeTimer = null; }
        try { observer?.dispose(); } catch { /* ignore */ }
    });

    return {
        get observer() { return observer; },
        readSettings,
    };
}

module.exports = { registerVisionIPC, MAX_GRAB_SECONDS };
