// END-TO-END test, no human needed.
//
// Chromium can feed a WAV file in as the "microphone", so the whole real chain
// runs: getUserMedia -> AudioWorklet -> resample to 16 kHz -> IPC -> native
// libvosk -> recognised text back in the renderer.
//
// Everything here is production code (registerAsrIPC + preload.js + the real
// renderer scripts); only the audio source is synthetic.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const WAV = process.argv[2];
const EXPECTED = process.argv[3] || '';

// Serve the synthesised speech as the microphone input.
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', WAV);
app.disableHardwareAcceleration();

// The real app runs from source via `electron .`, so app.getName() is the
// package.json name and userData resolves to %APPDATA%\live2dpet. Running this
// probe as a bare script would otherwise pick a different folder and report the
// engine as "not installed" while it plainly is.
app.setName('live2dpet');

const { registerAsrIPC } = require('./src/main/asr-ipc');

app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media'));

    const ctx = {};
    registerAsrIPC(ctx, ipcMain, { app });

    // A page with exactly the scripts the real settings window loads.
    const pageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
    const page = path.join(pageDir, 'page.html');
    const rel = (p) => 'file:///' + path.resolve(__dirname, p).replace(/\\/g, '/');
    fs.writeFileSync(page, `<!DOCTYPE html><html><body>e2e</body>
<script src="${rel('src/core/pcm-util.js')}"></script>
<script src="${rel('src/renderer/offline-asr.js')}"></script>
<script>
window.__heard = [];
window.__cap = null;
window.__start = async function () {
    window.__cap = new window.OfflineAsr.OfflineAsrCapture({
        onText: (t) => window.__heard.push(t),
        onError: (r) => window.__heard.push('ERROR:' + r),
    });
    return await window.__cap.start();
};
window.__stop = async function () { if (window.__cap) await window.__cap.stop(); };
</script></html>`);

    const win = new BrowserWindow({
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    ctx.petWindow = win;                 // recognised text is delivered here
    const logs = [];
    win.webContents.on('console-message', (e) => logs.push(String(e && e.message !== undefined ? e.message : e)));

    await win.loadFile(page);
    console.log('bridge present :', await win.webContents.executeJavaScript('typeof window.electronAPI?.asrStart'));
    console.log('asr status     :', JSON.stringify(await win.webContents.executeJavaScript('window.electronAPI.asrStatus()')));

    const started = await win.webContents.executeJavaScript('window.__start()');
    console.log('capture start  :', JSON.stringify(started));
    if (!started.ok) { console.log('RESULT: capture refused — ' + started.reason); app.exit(1); return; }

    // Let the fake microphone loop through the model for a while.
    const deadline = Date.now() + 30000;
    let heard = [];
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        heard = await win.webContents.executeJavaScript('window.__heard');
        if (heard.length) break;
    }
    await win.webContents.executeJavaScript('window.__stop()');

    console.log('');
    console.log('expected  :', EXPECTED);
    console.log('heard     :', JSON.stringify(heard));
    console.log('');
    console.log(heard.length
        ? 'RESULT: END-TO-END WORKS — full offline chain produced text'
        : 'RESULT: no text produced');
    const errs = logs.filter((l) => /error|fail|denied/i.test(l)).slice(0, 5);
    if (errs.length) { console.log('console:'); errs.forEach((l) => console.log('   ' + l.slice(0, 200))); }
    app.exit(heard.length ? 0 : 1);
});
