#!/usr/bin/env node
// Launch script: ensures ELECTRON_RUN_AS_NODE is removed before starting Electron.
// VSCode's integrated terminal sets this env var, which forces electron.exe
// into plain Node.js mode, breaking require('electron').
const { spawn } = require('child_process');
const electronPath = require('electron');

delete process.env.ELECTRON_RUN_AS_NODE;

// 解决 Windows 控制台输出乱码：显式设置编码并重定向 stdio
const isWindows = process.platform === 'win32';
let options = {
    env: process.env,
    stdio: isWindows ? ['ignore', 'pipe', 'pipe'] : 'inherit'
};

// Windows 下需要手动处理 stdout/stderr 编码
if (isWindows) {
    // 设置环境变量提示 Electron 使用 UTF-8 输出（部分有效）
    options.env.ELECTRON_NO_ATTACH_CONSOLE = '1';
    options.env.NODE_OPTIONS = '--no-warnings';
}

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], options);

if (isWindows) {
    // 显式将子进程输出按 utf8 解码后写入父进程 stdout/stderr
    child.stdout.on('data', (data) => {
        process.stdout.write(data.toString('utf8'));
    });
    child.stderr.on('data', (data) => {
        process.stderr.write(data.toString('utf8'));
    });
}

child.on('close', (code, signal) => {
    if (code === null) {
        console.error('electron exited with signal', signal);
        process.exit(1);
    }
    process.exit(code);
});

['SIGINT', 'SIGTERM'].forEach(sig => {
    process.on(sig, () => { if (!child.killed) child.kill(sig); });
});
