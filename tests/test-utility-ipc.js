/**
 * utility-ipc 的两组回归用例。
 *
 * 1) renderer-log：`level` 由渲染进程提供。旧实现是 `console[level] || console.log`，
 *    而 `console['__proto__']` 是 Object.prototype（不是函数），`.apply` 抛出的异常
 *    发生在 `ipcMain.on` 的监听器里 —— 那是主进程的未捕获异常。
 * 2) stt-windows：临时 .ps1 原先只在成功路径删除，每次识别失败都在 %TEMP% 留一个文件；
 *    同一行还把换行写成了双反斜杠字面量，导致多行输出不会被正确合并。
 *
 * 这两个用例都不启动 Electron：给一个假的 ipcMain 收集注册的通道即可。
 * 运行：node --test tests/test-utility-ipc.js
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const { registerUtilityIPC } = require('../src/main/utility-ipc');

const ROOT = path.join(__dirname, '..');
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

/** 只记录注册了哪些通道，不启动 Electron。 */
function registerIntoFakeIpc() {
    const handles = new Map();
    const listeners = new Map();
    const ipcMain = {
        handle: (channel, fn) => handles.set(channel, fn),
        on: (channel, fn) => listeners.set(channel, fn),
    };
    const deps = {
        configManager: {
            loadConfigFile: async () => ({}),
            saveConfigFile: async () => ({ success: true }),
        },
        mt: (key) => key,
        Menu: { buildFromTemplate: () => ({ popup() {} }) },
        shell: { openExternal: async () => {} },
        app: { getAppPath: () => ROOT },
        createSettingsWindow: () => {},
    };
    registerUtilityIPC({}, ipcMain, deps);
    return { handles, listeners };
}

describe('renderer-log 转发', () => {
    it('不在白名单里的 level 回落到 console.log，且绝不抛异常', () => {
        const { listeners } = registerIntoFakeIpc();
        const forward = listeners.get('renderer-log');
        assert.ok(forward, 'renderer-log 应已注册');

        const original = console.log;
        const seen = [];
        console.log = (...args) => seen.push(args);
        try {
            assert.doesNotThrow(() => forward({}, '__proto__', ['x']));
            assert.doesNotThrow(() => forward({}, 'constructor', ['x']));
            assert.doesNotThrow(() => forward({}, 'nope', ['x']));
        } finally {
            console.log = original;
        }
        assert.strictEqual(seen.length, 3, '三次都应由 console.log 兜住');
    });

    it('白名单里的 level 走对应的 console 方法', () => {
        const { listeners } = registerIntoFakeIpc();
        const forward = listeners.get('renderer-log');

        const original = console.warn;
        const seen = [];
        console.warn = (...args) => seen.push(args);
        try {
            forward({}, 'warn', ['a', 'b']);
        } finally {
            console.warn = original;
        }
        assert.deepStrictEqual(seen, [['a', 'b']]);
    });

    it('args 不是数组时也能安全转发', () => {
        const { listeners } = registerIntoFakeIpc();
        const forward = listeners.get('renderer-log');

        const original = console.log;
        const seen = [];
        console.log = (...args) => seen.push(args);
        try {
            assert.doesNotThrow(() => forward({}, 'log', 'plain'));
        } finally {
            console.log = original;
        }
        assert.deepStrictEqual(seen, [['plain']]);
    });
});

describe('stt-windows 临时脚本与输出解析', () => {
    const realTmpdir = os.tmpdir;
    const realExecSync = childProcess.execSync;
    let sandbox;

    before(() => {
        sandbox = fs.mkdtempSync(path.join(realTmpdir(), 'l2d-utility-ipc-'));
        os.tmpdir = () => sandbox;
    });

    after(() => {
        os.tmpdir = realTmpdir;
        childProcess.execSync = realExecSync;
        try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) { /* 测试目录，忽略 */ }
    });

    const leftovers = () => fs.readdirSync(sandbox);

    it('powershell 失败/超时后不留下 .ps1', async () => {
        childProcess.execSync = () => { throw new Error('powershell timed out'); };
        const { handles } = registerIntoFakeIpc();
        const result = await handles.get('stt-windows')();

        assert.strictEqual(result.success, false);
        assert.match(result.error, /timed out/);
        assert.deepStrictEqual(leftovers(), [], '失败路径同样要删临时文件');
    });

    it('识别到 __TIMEOUT__ 时按「没听到」处理', async () => {
        childProcess.execSync = () => '__TIMEOUT__' + CR + LF;
        const { handles } = registerIntoFakeIpc();
        const result = await handles.get('stt-windows')();

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'no_speech');
        assert.deepStrictEqual(leftovers(), []);
    });

    it('多行输出按行 trim 后合并成一行', async () => {
        childProcess.execSync = () => ' 你好 ' + CR + LF + '世界 ' + LF;
        const { handles } = registerIntoFakeIpc();
        const result = await handles.get('stt-windows')();

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.text, '你好 世界');
        assert.deepStrictEqual(leftovers(), []);
    });
});
