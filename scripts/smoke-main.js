/**
 * 冒烟：真实启动整个 Live2DPet 主进程，确认 Electron 升级后没有破坏装配阶段。
 *
 * 它不弹宠物窗、不联网、不需要 API Key，只做一件事：把 main.js 完整跑起来，
 * 确认所有 register*IPC 都成功注册、app 进入 ready、然后干净退出。
 *
 * 用法： node scripts/smoke-main.js     （由 electron 启动，见 verify:main）
 */
'use strict';

const fs = require('node:fs');
const LOG = process.env.SMOKE_LOG || 'C:\\Windows\\Temp\\live2dpet-smoke.log';

try { fs.writeFileSync(LOG, ''); } catch { /* ignore */ }
const say = (s) => { try { fs.appendFileSync(LOG, `${s}\n`); } catch { /* ignore */ } };

const { app, ipcMain } = require('electron');

// 不真的开窗口：把 createWindow 之类的东西挡在 ready 之后按需触发
app.disableHardwareAcceleration();

/**
 * GUI 进程的 stdout 在后台启动时会被判定为已关闭的管道，
 * 应用里任何 `console.log` 都会抛 `EPIPE: broken pipe, write`。
 * 那不是应用的 bug，是"没人读 stderr/stdout"的症状 —— 但 uncaughtException
 * 会把冒烟测试判成失败。所以这里把控制台输出重定向到文件，
 * 让测量本身不产生噪声（也让检查更贴近真实：用户双击启动时同样没有控制台）。
 */
const realLog = (...a) => say(a.map((x) => (typeof x === 'string' ? x : tryStr(x))).join(' '));
function tryStr(x) { try { return JSON.stringify(x); } catch { return String(x); } }
console.log = realLog;
console.info = realLog;
console.warn = realLog;
console.error = realLog;
console.debug = () => {};
console.trace = () => {};

say(`electron=${process.versions.electron} chrome=${process.versions.chrome} node=${process.versions.node}`);

let failed = false;
process.on('uncaughtException', (e) => { failed = true; say(`UNCAUGHT: ${e && e.stack}`); });
process.on('unhandledRejection', (e) => { failed = true; say(`UNHANDLED: ${e && (e.stack || e)}`); });

app.whenReady().then(async () => {
    say('app ready');

    // 把 main.js 跑起来。它自己会 createSettingsWindow + createTray，
    // 这在无显示环境也可能抛错，所以包起来单独报告。
    try {
        require('../main.js');
        say('main.js loaded');
    } catch (e) {
        failed = true;
        say(`main.js FAILED: ${e && e.stack}`);
        app.exit(1);
        return;
    }

    // 等装配完成
    await new Promise((r) => setTimeout(r, 1500));

    // 对账：看看关键通道都注册了没有
    const handlers = ipcMain._invokeHandlers;
    const channels = handlers ? [...handlers.keys()] : [];
    say(`ipc handlers registered: ${channels.length}`);
    for (const must of ['load-config', 'save-config', 'vision-status', 'vision-grab',
        'dsh-status', 'bili-status', 'asr-status', 'obs-server-get', 'create-pet-window']) {
        say(`  ${channels.includes(must) ? 'OK  ' : 'MISS'} ${must}`);
        if (!channels.includes(must)) failed = true;
    }

    // 窗口情况
    const wins = require('electron').BrowserWindow.getAllWindows();
    say(`windows: ${wins.length} (${wins.map((w) => (w.webContents ? 'web' : '?')).join(',')})`);

    say(failed ? 'RESULT: FAILED' : 'RESULT: OK');
    app.exit(failed ? 1 : 0);
}).catch((e) => {
    say(`whenReady rejected: ${e && e.stack}`);
    app.exit(1);
});
