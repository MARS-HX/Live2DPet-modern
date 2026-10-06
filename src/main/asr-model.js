/**
 * Offline ASR model management.
 *
 * The speech engine itself runs in the renderer as WebAssembly, but downloading
 * and unpacking the model belongs in the main process — that is where the file
 * and network access lives. After the one-time download the whole pipeline is
 * offline: nothing here is contacted again.
 *
 * Every dependency is injectable so the download+install path can be tested
 * end-to-end against a local HTTP server, with no real network involved.
 */
'use strict';

const { extractZip } = require('./zip-extract');

/** The model the UI offers. Small Chinese model: ~42 MB, streaming, low CPU. */
const MODEL = {
    name: 'vosk-model-small-cn-0.22',
    url: 'https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip',
    approxBytes: 43900000,
};

const MAX_REDIRECTS = 5;

function modelsRoot(userDataPath, path) {
    return path.join(userDataPath, 'vosk-models');
}

/** Where the unpacked model should end up. */
function modelDir(userDataPath, path) {
    return path.join(modelsRoot(userDataPath, path), MODEL.name);
}

/**
 * A Vosk model directory is only usable if these exist. Checked instead of
 * trusting the download, because a truncated or HTML-error-page "zip" would
 * otherwise leave a directory that fails much later with a cryptic error.
 */
function verifyModelDir(dir, deps = {}) {
    const fs = deps.fs || require('fs');
    const path = deps.path || require('path');
    const missing = [];
    const has = (rel) => fs.existsSync(path.join(dir, rel));

    if (!has('am')) missing.push('am/');
    if (!has('conf')) missing.push('conf/');
    if (!has('graph')) missing.push('graph/');
    if (!fs.existsSync(path.join(dir, 'am', 'final.mdl'))) missing.push('am/final.mdl');

    return { ok: missing.length === 0, missing, dir };
}

/**
 * Archives normally wrap everything in a top-level folder, but that is not
 * guaranteed — find the directory that actually looks like a model.
 */
function findModelRoot(dir, deps = {}) {
    const fs = deps.fs || require('fs');
    const path = deps.path || require('path');
    if (verifyModelDir(dir, deps).ok) return dir;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        const child = path.join(dir, e.name);
        if (verifyModelDir(child, deps).ok) return child;
    }
    return null;
}

/** Is a usable model already installed? */
function modelStatus(userDataPath, deps = {}) {
    const fs = deps.fs || require('fs');
    const path = deps.path || require('path');
    const dir = modelDir(userDataPath, path);
    const root = findModelRoot(dir, deps);
    return {
        model: MODEL.name,
        url: MODEL.url,
        approxBytes: MODEL.approxBytes,
        dir,
        installed: !!root,
        modelRoot: root || dir,
    };
}

/**
 * Stream a URL to disk, following redirects, reporting progress.
 * @returns {Promise<{path:string, bytes:number}>}
 */
function downloadFile(url, destPath, deps = {}) {
    const fs = deps.fs || require('fs');
    const path = deps.path || require('path');
    const https = deps.https || require('https');
    const http = deps.http || require('http');
    const onProgress = deps.onProgress || (() => {});

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const tmpPath = `${destPath}.part`;

    const attempt = (target, redirectsLeft) => new Promise((resolve, reject) => {
        let parsed;
        try { parsed = new URL(target); } catch { reject(new Error(`bad_url:${target}`)); return; }
        const mod = parsed.protocol === 'http:' ? http : https;

        const req = mod.get(target, { headers: { 'User-Agent': 'Live2DPet' } }, (res) => {
            // Redirects are normal for model hosting.
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (redirectsLeft <= 0) { reject(new Error('too_many_redirects')); return; }
                const next = new URL(res.headers.location, target).toString();
                attempt(next, redirectsLeft - 1).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`http_${res.statusCode}`));
                return;
            }

            const total = Number(res.headers['content-length']) || 0;
            let received = 0;
            const out = fs.createWriteStream(tmpPath);
            res.on('data', (chunk) => {
                received += chunk.length;
                onProgress(total ? received / total : 0, received, total);
            });
            res.pipe(out);
            out.on('finish', () => {
                out.close(() => {
                    try { fs.renameSync(tmpPath, destPath); } catch (e) { reject(e); return; }
                    resolve({ path: destPath, bytes: received });
                });
            });
            out.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout?.(0);
    });

    return attempt(url, MAX_REDIRECTS);
}

/**
 * Unpack a downloaded archive and verify it is a usable model.
 * The archive is removed afterwards so a failed install cannot leave a
 * half-written model that later looks "installed".
 */
function installModel(zipPath, destDir, deps = {}) {
    const fs = deps.fs || require('fs');
    const path = deps.path || require('path');
    const log = deps.logger || console;

    if (!fs.existsSync(zipPath)) throw new Error('zip_missing');
    const buf = fs.readFileSync(zipPath);
    fs.mkdirSync(destDir, { recursive: true });

    const res = extractZip(buf, destDir, deps);
    log.log?.(`[ASR] extracted ${res.files} file(s)`
        + (res.skipped.length ? `, skipped ${res.skipped.length} unsafe entr(ies)` : ''));

    const root = findModelRoot(destDir, deps);
    if (!root) {
        // Leave nothing behind that could be mistaken for a working install.
        try { fs.rmSync(destDir, { recursive: true, force: true }); } catch { /* ignore */ }
        throw new Error('model_incomplete');
    }
    try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }

    return { ...verifyModelDir(root, deps), extracted: res.files, skipped: res.skipped.length };
}

/** Download and install in one step. */
async function downloadAndInstall(userDataPath, deps = {}) {
    const path = deps.path || require('path');
    const dest = modelDir(userDataPath, path);
    const zipPath = `${dest}.zip`;
    const dl = await downloadFile(MODEL.url, zipPath, deps);
    const install = installModel(zipPath, dest, deps);
    return { ...install, bytes: dl.bytes };
}

module.exports = {
    MODEL,
    MAX_REDIRECTS,
    modelsRoot,
    modelDir,
    verifyModelDir,
    findModelRoot,
    modelStatus,
    downloadFile,
    installModel,
    downloadAndInstall,
};
