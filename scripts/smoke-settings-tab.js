/**
 * 设置页 DOM 冒烟：真的把 index.html 加载进 Electron，检查
 *   ① 页面没有抛错（尤其是"对 null 设 .checked"这类）
 *   ② see-now 卡片在「设置」选项卡里，不在「集成」里
 *   ③ 所有 vision 控件都存在且唯一
 *   ④ 切换选项卡后控件可见
 *
 *     node scripts/smoke-settings-tab.js   （由 electron 启动）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const LOG = process.env.SMOKE_LOG || 'C:\\Windows\\Temp\\settings-tab-smoke.log';

try { fs.writeFileSync(LOG, ''); } catch { /* ignore */ }
const say = (s) => { try { fs.appendFileSync(LOG, `${s}\n`); } catch { /* ignore */ } };
const str = (x) => { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); } };
console.log = (...a) => say(a.map(str).join(' '));
console.warn = console.log;
console.error = console.log;
console.info = console.log;

const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();

// 设置页会调这些通道；给最小桩件，避免因"没注册"而报错干扰观察
const stubs = {
    'load-config': async () => ({
        apiKey: '', baseURL: 'https://openrouter.ai/api/v1', modelName: 'test',
        interval: 10, chatGap: 5, emotionFrequency: 30, maxTokensMultiplier: 1,
        enhance: { enabled: false }, vision: {},
        dsh: {}, companion: {}, bilibili: {}, obs: {},
        model: { type: 'none' },
    }),
    'save-config': async () => true,
    'list-characters': async () => ({ characters: [], activeCharacterId: '' }),
    'load-prompt': async () => ({ success: false }),
    'tts-get-status': async () => ({ initialized: false }),
    'tts-get-metas': async () => [],
    'load-default-audio': async () => ({ success: false, files: [] }),
    'get-gender-term': async () => 'you',
    'vision-status': async () => ({
        running: false, frames: 0, sheets: 0, stats: null,
        settings: { enabled: true, quality: 'low', pace: 'normal', scene: false },
        platformSupported: true,
    }),
    'vision-grab': async () => ({ ok: false, reason: 'stub' }),
    'obs-server-get': async () => ({ running: false, url: '', clients: 0 }),
    'obs-mode-get': async () => ({ compatible: false }),
    'asr-status': async () => ({ platformSupported: true, nativeInstalled: false, modelInstalled: false }),
    'dsh-status': async () => ({ available: false, running: false }),
    'bili-status': async () => ({ connected: false }),
};
for (const [ch, fn] of Object.entries(stubs)) ipcMain.handle(ch, fn);

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false,
        width: 560, height: 900,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '..', 'preload.js'),
        },
    });

    const errors = [];
    // Electron 42+ 用事件对象；旧签名仍可用但会打弃用警告。两种都接。
    win.webContents.on('console-message', (event, level, message) => {
        const msg = (event && typeof event === 'object' && event.message !== undefined)
            ? event.message
            : message;
        const lv = (event && typeof event === 'object' && event.level !== undefined)
            ? event.level
            : level;
        // 开发期的 CSP 提示不是应用错误：打包后不会出现，
        // 而且它每次都会命中，留着只会淹没真正的问题。
        if (typeof msg === 'string' && /Electron Security Warning/.test(msg)) return;
        const isErr = lv === 'error' || lv === 3 || lv === 2;
        if (isErr) errors.push(typeof msg === 'string' ? msg : JSON.stringify(msg));
    });
    win.webContents.on('render-process-gone', (_e, d) => errors.push('render gone: ' + JSON.stringify(d)));

    try {
        await win.loadFile(path.join(__dirname, '..', 'index.html'));
    } catch (e) {
        say('LOAD FAILED: ' + e.message);
        app.exit(1);
        return;
    }
    // 等脚本跑完（loadFile 之后还有一些 async 初始化）
    await new Promise((r) => setTimeout(r, 2500));

    const probe = await win.webContents.executeJavaScript(`(() => {
        const inTab = (el, tabId) => {
            if (!el) return false;
            let n = el;
            while (n) { if (n.id === tabId) return true; n = n.parentElement; }
            return false;
        };
        const ids = ['vision-enabled','vision-quality','vision-pace','vision-scene',
                     'btn-save-vision','btn-test-vision','vision-status-line','vision-msg'];
        const presence = {};
        for (const id of ids) {
            const els = document.querySelectorAll('#' + id);
            presence[id] = { count: els.length, inSettings: inTab(els[0], 'tab-settings'),
                             inIntegrations: inTab(els[0], 'tab-integrations') };
        }
        // 所有 tab 里是否还残留 enhance master
        const enhanceLeft = document.querySelectorAll('#enhance-enabled').length;
        // 卡片标题
        const h2s = [...document.querySelectorAll('#tab-settings h2')].map(h => h.textContent.trim());
        return { presence, enhanceLeft, settingsHeadings: h2s };
    })()`);

    say('=== 控件存在性与归属 ===');
    let bad = 0;
    for (const [id, info] of Object.entries(probe.presence)) {
        const ok = info.count === 1 && info.inSettings && !info.inIntegrations;
        if (!ok) bad++;
        say(`  ${ok ? 'OK  ' : 'FAIL'} ${id}  count=${info.count} inSettings=${info.inSettings} inIntegrations=${info.inIntegrations}`);
    }
    say(`=== enhance-enabled 残留: ${probe.enhanceLeft}（应为 0）===`);
    if (probe.enhanceLeft !== 0) bad++;
    say('=== 设置页卡片标题 ===');
    probe.settingsHeadings.forEach((h) => say('  - ' + h));

    // 切到「集成」页，确认那里没有 vision 卡片
    const integProbe = await win.webContents.executeJavaScript(`(() => {
        const integ = document.getElementById('tab-integrations');
        const has = !!integ && !!integ.querySelector('#vision-enabled');
        const heads = integ ? [...integ.querySelectorAll('h2')].map(h => h.textContent.trim()) : [];
        return { has, heads };
    })()`);
    say(`=== 集成页里有 vision-enabled: ${integProbe.has}（应为 false）===`);
    if (integProbe.has) bad++;
    say('=== 集成页卡片标题 ===');
    integProbe.heads.forEach((h) => say('  - ' + h));

    // 切 tab 验证显示
    await win.webContents.executeJavaScript(`document.querySelector('[data-tab="settings"]').click();`);
    await new Promise((r) => setTimeout(r, 300));
    const vis = await win.webContents.executeJavaScript(`(() => {
        const el = document.getElementById('vision-enabled');
        const card = el && el.closest('.card');
        return { visible: !!(card && card.offsetParent !== null), w: card ? card.offsetWidth : 0 };
    })()`);
    say(`=== 设置页激活时 vision 卡片可见: ${vis.visible} (宽 ${vis.w}px) ===`);
    if (!vis.visible) bad++;

    say('');
    say('=== 页面控制台错误 ===');
    if (!errors.length) say('  （无）');
    errors.slice(0, 10).forEach((e) => say('  ! ' + e));

    say('');
    const result = bad === 0 && errors.length === 0 ? 'OK' : 'FAILED';
    say('RESULT: ' + result + ` (bad=${bad}, consoleErrors=${errors.length})`);
    app.exit(result === 'OK' ? 0 : 1);
}).catch((e) => {
    say('EXCEPTION: ' + (e && e.stack));
    app.exit(1);
});
