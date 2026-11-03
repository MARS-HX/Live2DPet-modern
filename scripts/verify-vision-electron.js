/**
 * 在真实 Electron 环境里验证识屏链路（不依赖桌宠 UI 的可交互部分）。
 *
 * 为什么要这一步：前面所有测试都是纯 Node。但真正的运行环境里，
 * vision-ipc 是从 `app.getPath('userData')` 拿路径、`configManager` 读配置、
 * 主进程里 spawn 子进程 —— 这些只有真起 Electron 才能验。
 *
 *     npm run verify:electron          （打包前用）
 *     或： npx electron scripts/verify-vision-electron.js
 *
 * 它会：
 *   1. 起一个无窗口的 Electron 主进程
 *   2. 装配真实的 config-manager / vision-ipc
 *   3. 走一遍 vision-status / vision-grab / vision-peek / vision-stop
 *   4. 把拿到的图存盘，并断言 content 块形态正确
 *   5. 退出码 0 = 整条链通
 */

'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// 让 Electron 在无显示环境也能跑（CI 用）
app.disableHardwareAcceleration();

const OUT = path.join(__dirname, '..', '.vision-e2e');
fs.mkdirSync(OUT, { recursive: true });

function log(...a) { console.log('[verify]', ...a); }

async function main() {
    await app.whenReady();

    // 一个离屏窗口：vision-ipc 里推送 / 广播要用到 webContents
    const win = new BrowserWindow({
        show: false,
        width: 400,
        height: 300,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    await win.loadURL('data:text/html,<html><body>verify</body></html>');

    // ---- 装配真实的主进程模块 ----
    const ipcMain = require('electron').ipcMain;
    const { AppContext } = require('../src/main/app-context');
    const { createConfigManager } = require('../src/main/config-manager');
    const { registerVisionIPC } = require('../src/main/vision-ipc');

    const ctx = new AppContext();
    const configManager = createConfigManager(app);
    const { getDefaultVisionConfig } = require('../src/main/config-manager');

    const ipc = registerVisionIPC(ctx, ipcMain, { app, configManager });
    log('vision-ipc registered. defaults =', JSON.stringify(getDefaultVisionConfig()));

    // ---- 直接调用 handler（等价于渲染进程 invoke）----
    const invoke = async (channel, ...args) => {
        const handler = ipcMain._invokeHandlers
            ? ipcMain._invokeHandlers.get(channel)
            : null;
        if (!handler) throw new Error(`no handler for ${channel}`);
        return handler({ sender: win.webContents }, ...args);
    };

    // 1) status
    const st = await invoke('vision-status');
    log('1. vision-status:', JSON.stringify({
        running: st.running, quality: st.settings.quality, pace: st.settings.pace,
        enabled: st.settings.enabled, platformSupported: st.platformSupported,
        ffmpeg: st.ffmpeg,
    }));
    if (!st.platformSupported) {
        console.error('[verify] FAIL: 平台不支持（Linux 尚未接入）');
        app.exit(1);
        return;
    }

    // 2) 抓第一张（冷启动 eager）
    const t0 = Date.now();
    const grab = await invoke('vision-grab', { seconds: 15, minFrames: 1 });
    log(`2. vision-grab: ok=${grab.ok} reason=${grab.reason || '-'} waited=${grab.waited?.toFixed(1)}s `
        + `实际 ${Date.now() - t0}ms`);
    if (!grab.ok) {
        console.error('[verify] FAIL: 抓不到图 —', grab.error || grab.reason);
        app.exit(1);
        return;
    }
    const p = grab.payload;
    log(`   payload: ${p.width}x${p.height} frames=${p.frames.length} ${Math.round(p.bytes / 1024)}KB`);
    if (!p.dataUrl || !p.dataUrl.startsWith('data:image/png;base64,')) {
        console.error('[verify] FAIL: dataUrl 形态不对');
        app.exit(1);
        return;
    }
    const file = path.join(OUT, 'electron-01.png');
    fs.writeFileSync(file, Buffer.from(p.dataUrl.split(',')[1], 'base64'));
    log('   存盘:', file);

    // 3) peek（不等待）
    const peek = await invoke('vision-peek');
    log(`3. vision-peek: ok=${peek.ok} reason=${peek.reason || '-'}`);

    // 4) status 再看一次，确认统计在跑
    const st2 = await invoke('vision-status');
    log('4. 采集统计:', JSON.stringify({
        running: st2.running, frames: st2.frames, sheets: st2.sheets,
        kept: st2.stats && st2.stats.kept, cuts: st2.stats && st2.stats.cuts,
    }));
    if (!st2.frames) {
        console.error('[verify] FAIL: 一帧都没解码');
        app.exit(1);
        return;
    }

    // 5) stop 并确认硬闸生效
    await invoke('vision-stop', { suppress: true });
    const afterStop = await invoke('vision-status');
    log('5. vision-stop 后 suppressed =', afterStop.suppressed);
    if (!afterStop.suppressed) {
        console.error('[verify] FAIL: 硬闸没生效');
        app.exit(1);
        return;
    }
    const blocked = await invoke('vision-grab', { seconds: 5 });
    if (blocked.ok || blocked.reason !== 'suppressed') {
        console.error('[verify] FAIL: 停止后还能抓图（reason=' + blocked.reason + '）');
        app.exit(1);
        return;
    }
    log('   停止后取图已被拦截 ✓');

    // 6) 还原配置，别污染用户数据
    try { await configManager.saveConfigFile({ vision: getDefaultVisionConfig() }); } catch { /* ignore */ }

    log('');
    log('全部通过 ✓  样张在', OUT);
    ctx.visionObserver?.dispose();
    app.exit(0);
}

main().catch((e) => {
    console.error('[verify] 异常:', e);
    app.exit(1);
});
