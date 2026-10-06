/**
 * Native (offline) speech recognition via libvosk.dll and koffi.
 *
 * Why native instead of the WebAssembly build: the WASM route (vosk-browser)
 * needs cross-origin isolation, a loopback HTTP server, a tar archive pushed
 * into an Emscripten filesystem — and it still dead-ends in `FS.syncfs`
 * ("FS error") on current Chromium. See ASR-NOTES.md.
 *
 * Loading the real library through koffi removes that entire layer:
 *   - the model is read straight from its directory on disk
 *   - no HTTP, no COOP/COEP, no SharedArrayBuffer, no archive, no WASM runtime
 *   - koffi is already a project dependency (used for VOICEVOX)
 *
 * Audio in: 16 kHz mono signed 16-bit PCM, which is what the recogniser wants.
 */
'use strict';

const MODEL_NAME = 'vosk-model-small-cn-0.22';
/** Native library release that ships libvosk.dll for Windows x64. */
const NATIVE = {
    name: 'vosk-win64-0.3.45',
    url: 'https://github.com/alphacep/vosk-api/releases/download/v0.3.45/vosk-win64-0.3.45.zip',
    approxBytes: 14900000,
    /** libvosk.dll needs these next to it on Windows (MinGW runtime). */
    dlls: ['libvosk.dll', 'libstdc++-6.dll', 'libgcc_s_seh-1.dll', 'libwinpthread-1.dll'],
};

/** Directory holding the unpacked native library. */
function nativeRoot(userDataPath, path) {
    return path.join(userDataPath, 'vosk-native');
}

/** Directory holding libvosk.dll (the archive adds one wrapper folder). */
function nativeLibDir(userDataPath, deps = {}) {
    const fs = deps.fs || require('fs');
    const path = deps.path || require('path');
    const root = path.join(nativeRoot(userDataPath, path), 'lib');
    if (!fs.existsSync(root)) return root;
    if (fs.existsSync(path.join(root, 'libvosk.dll'))) return root;
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (e.isDirectory() && fs.existsSync(path.join(root, e.name, 'libvosk.dll'))) {
            return path.join(root, e.name);
        }
    }
    return root;
}

/** Is the native library unpacked and complete? */
function nativeStatus(userDataPath, deps = {}) {
    const fs = deps.fs || require('fs');
    const path = deps.path || require('path');
    const dir = nativeLibDir(userDataPath, deps);
    const missing = NATIVE.dlls.filter((d) => !fs.existsSync(path.join(dir, d)));
    return { dir, installed: missing.length === 0 && process.platform === 'win32', missing, url: NATIVE.url };
}

/**
 * Download and unpack libvosk.dll (plus its MinGW runtime DLLs).
 * Reuses the downloader / zip extractor that were validated against the real
 * model archive, so there is one implementation of "fetch and unpack" here.
 */
async function installNativeLib(userDataPath, deps = {}) {
    const fs = deps.fs || require('fs');
    const path = deps.path || require('path');
    const { downloadFile } = require('./asr-model');
    const { extractZip } = require('./zip-extract');

    const already = nativeStatus(userDataPath, deps);
    if (already.installed) return { ...already, skipped: true };

    const root = nativeRoot(userDataPath, path);
    fs.mkdirSync(root, { recursive: true });
    const zipPath = path.join(root, `${NATIVE.name}.zip`);

    const dl = await downloadFile(NATIVE.url, zipPath, { ...deps, fs, path });
    const res = extractZip(fs.readFileSync(zipPath), path.join(root, 'lib'), { ...deps, fs, path });
    try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }

    const after = nativeStatus(userDataPath, deps);
    if (!after.installed) throw new Error(`native_install_incomplete:${after.missing.join(',')}`);
    return { ...after, bytes: dl.bytes, extracted: res.files };
}

/**
 * Bind the Vosk C API from libvosk.dll.
 * Signatures are taken verbatim from the vosk_api.h shipped in the archive.
 */
function bindVosk(dllDir, deps = {}) {
    const path = deps.path || require('path');
    const koffi = deps.koffi || require('koffi');

    koffi.opaque('VoskModel');
    koffi.opaque('VoskRecognizer');

    const lib = koffi.load(path.join(dllDir, 'libvosk.dll'));
    return {
        setLogLevel: lib.func('void vosk_set_log_level(int level)'),
        modelNew: lib.func('VoskModel *vosk_model_new(const char *model_path)'),
        modelFree: lib.func('void vosk_model_free(VoskModel *model)'),
        recNew: lib.func('VoskRecognizer *vosk_recognizer_new(VoskModel *model, float sample_rate)'),
        recFree: lib.func('void vosk_recognizer_free(VoskRecognizer *rec)'),
        setWords: lib.func('void vosk_recognizer_set_words(VoskRecognizer *rec, int words)'),
        accept: lib.func('int vosk_recognizer_accept_waveform(VoskRecognizer *rec, const char *data, int length)'),
        result: lib.func('const char *vosk_recognizer_result(VoskRecognizer *rec)'),
        finalResult: lib.func('const char *vosk_recognizer_final_result(VoskRecognizer *rec)'),
    };
}

/**
 * A recogniser bound to one loaded model.
 * `feed()` takes raw PCM bytes (16 kHz mono int16); it returns the final text
 * when the library decides an utterance ended, otherwise null. `flush()` ends
 * the current utterance on demand (used when a recording window closes).
 */
class OfflineRecognizer {
    constructor(api, model) {
        this._api = api;
        this._model = model;
        this._rec = null;
    }

    get ready() { return !!this._rec || !!this._model; }

    start(sampleRate = 16000) {
        if (this._rec) return;
        this._rec = this._api.recNew(this._model, sampleRate);
        if (!this._rec) throw new Error('recognizer_create_failed');
    }

    /** @param {Buffer} pcm 16-bit little-endian mono samples */
    feed(pcm) {
        if (!this._rec) this.start();
        if (!pcm || !pcm.length) return null;
        const ended = this._api.accept(this._rec, pcm, pcm.length);
        if (!ended) return null;
        return parseText(this._api.result(this._rec));
    }

    /** Partial (in-progress) transcript, for live feedback. */
    partial() {
        if (!this._rec) return '';
        return parseText(this._api.result(this._rec));
    }

    /** Close the current utterance and return whatever was understood. */
    flush() {
        if (!this._rec) return '';
        return parseText(this._api.finalResult(this._rec));
    }

    dispose() {
        if (this._rec) { try { this._api.recFree(this._rec); } catch { /* ignore */ } this._rec = null; }
    }
}

/** Vosk returns JSON like {"text":"你好"}; be tolerant about the shape. */
function parseText(json) {
    if (!json) return '';
    if (typeof json === 'object') return String(json.text || '');
    try {
        const parsed = JSON.parse(json);
        return String((parsed && parsed.text) || '');
    } catch {
        return '';
    }
}

/**
 * Load the model once and hand out recognisers.
 * Model loading is the expensive part (seconds, hundreds of MB), so callers are
 * expected to keep one engine alive.
 */
function createEngine(userDataPath, deps = {}) {
    const fs = deps.fs || require('fs');
    const path = deps.path || require('path');
    const log = deps.logger || console;

    const native = nativeStatus(userDataPath, deps);
    if (!native.installed) throw new Error(`native_not_installed:${native.missing.join(',')}`);

    const modelRoot = path.join(userDataPath, 'vosk-models', MODEL_NAME, MODEL_NAME);
    const modelPath = fs.existsSync(modelRoot)
        ? modelRoot
        : path.join(userDataPath, 'vosk-models', MODEL_NAME);
    if (!fs.existsSync(modelPath)) throw new Error('model_not_installed');

    const api = bindVosk(native.dir, deps);
    api.setLogLevel(deps.logLevel === undefined ? -1 : deps.logLevel);
    const model = api.modelNew(modelPath);
    if (!model) throw new Error('model_load_failed');
    log.log?.(`[ASR] native model loaded: ${modelPath}`);

    return {
        api,
        model,
        modelPath,
        createRecognizer: () => new OfflineRecognizer(api, model),
        dispose() {
            try { api.modelFree(model); } catch { /* ignore */ }
        },
    };
}

module.exports = {
    NATIVE,
    MODEL_NAME,
    nativeRoot,
    nativeLibDir,
    nativeStatus,
    installNativeLib,
    bindVosk,
    createEngine,
    OfflineRecognizer,
    parseText,
};
