/**
 * OBS compatibility mode ("streamer mode").
 *
 * The problem: Chromium/Electron renders through a path that bypasses the
 * Windows GDI, so OBS cannot read the window's contents — the capture shows a
 * plain black rectangle. This affects both Window Capture and Game Capture, and
 * it is why a transparent pet window is invisible in OBS no matter what you do
 * in OBS itself. See https://github.com/electron/electron/issues/16955
 *
 * The fix that actually works (used by other Electron apps as a "streamer
 * mode") is to turn off GPU compositing, which puts Chromium back on a path OBS
 * can read. It costs some rendering performance, so it is opt-in.
 *
 * The switches must be appended to the command line *before* the GPU process
 * starts, so the config is read synchronously at startup.
 */
'use strict';

/**
 * Switches applied in compatibility mode.
 * `disable-gpu-compositing` is the one that matters; the video decode/encode
 * ones are disabled alongside it because they also bypass the capturable path.
 */
const OBS_COMPAT_SWITCHES = [
    'disable-gpu-compositing',
    'disable-accelerated-video-decode',
    'disable-accelerated-video-encode',
];

/** Pure: which switches a given config asks for. */
function obsSwitchesFor(config) {
    return config && config.obs && config.obs.compatible === true
        ? OBS_COMPAT_SWITCHES.slice()
        : [];
}

/**
 * Read `obs.compatible` from disk synchronously, honouring the same precedence
 * as config-manager: a packaged app prefers userData, otherwise the bundled
 * config next to the app is used.
 */
function readObsCompatibleSync(deps = {}) {
    const { fs, path, app, basePath } = deps;
    if (!fs || !path) return false;
    const candidates = [];
    const packaged = !!(app && app.isPackaged);
    if (packaged && app.getPath) {
        try { candidates.push(path.join(app.getPath('userData'), 'config.json')); } catch { /* ignore */ }
    }
    if (basePath) candidates.push(path.join(basePath, 'config.json'));

    for (const file of candidates) {
        let raw;
        try {
            raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            continue;   // missing or unreadable: try the next candidate
        }
        // First readable config wins, matching how the app loads its config.
        if (raw && raw.obs && raw.obs.compatible === true) return true;
        if (packaged) return false;     // userData existed -> its value is final
    }
    return false;
}

/**
 * Apply compatibility switches to the command line.
 * MUST be called before `app.whenReady()` resolves.
 */
function applyObsCompatibility(app, deps = {}) {
    const switches = obsSwitchesFor({ obs: { compatible: readObsCompatibleSync(deps) } });
    if (!switches.length) return { enabled: false, switches: [] };
    for (const s of switches) app.commandLine.appendSwitch(s);
    return { enabled: true, switches };
}

module.exports = {
    OBS_COMPAT_SWITCHES,
    obsSwitchesFor,
    readObsCompatibleSync,
    applyObsCompatibility,
};
