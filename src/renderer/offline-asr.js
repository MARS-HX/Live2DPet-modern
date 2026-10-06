/**
 * Microphone capture for offline speech recognition.
 *
 * Runs in the renderer because only it can call getUserMedia. The heavy work —
 * recognition — happens in the main process against the native Vosk library;
 * this file's whole job is to turn the microphone into the exact stream Vosk
 * wants: **16 kHz, mono, signed 16-bit little-endian PCM**, and hand it over.
 *
 * The AudioWorklet module is created from a Blob URL rather than a file: a
 * file:// page cannot load a worklet module by path, and the app's CSP already
 * allows `blob:`.
 *
 * Depends on: PcmUtil (src/core/pcm-util.js), window.electronAPI.asrFeed
 */
(function (root) {
    'use strict';

    const TARGET_RATE = 16000;
    const CHUNK_SAMPLES = 1600;        // 100 ms at 16 kHz
    const WORKLET_BUFFER = 2048;       // frames per message (from the audio thread)

    /**
     * The audio thread only forwards mono float frames; every conversion that
     * could be unit-tested lives in PcmUtil on this side.
     */
    const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._buf = new Float32Array(${WORKLET_BUFFER});
        this._n = 0;
    }
    process(inputs) {
        const input = inputs[0];
        if (!input || !input.length || !input[0]) return true;
        const channels = input.length;
        const frames = input[0].length;
        for (let i = 0; i < frames; i++) {
            let sum = 0;
            for (let c = 0; c < channels; c++) sum += input[c][i] || 0;
            this._buf[this._n++] = sum / channels;
            if (this._n === this._buf.length) {
                this.port.postMessage(this._buf.slice(0));
                this._n = 0;
            }
        }
        return true;
    }
}
registerProcessor('l2d-capture', CaptureProcessor);
`;

    class OfflineAsrCapture {
        constructor(deps = {}) {
            this._api = deps.api || (root.electronAPI || null);
            this._logger = deps.logger || console;
            this._onText = deps.onText || (() => {});
            this._onState = deps.onState || (() => {});
            this._onError = deps.onError || (() => {});
            this._media = null;
            this._ctx = null;
            this._node = null;
            this._source = null;
            this._resampler = null;
            this._pending = [];
            this._pendingLen = 0;
            this._resultBound = null;
            this._active = false;
        }

        get active() { return this._active; }

        /**
         * @returns {Promise<{ok:boolean, reason?:string}>} never throws
         */
        async start() {
            if (this._active) return { ok: true };
            if (!this._api) return { ok: false, reason: 'no_bridge' };
            if (!root.navigator?.mediaDevices?.getUserMedia) {
                return { ok: false, reason: 'no_getusermedia' };
            }
            if (typeof root.AudioWorkletNode !== 'function') {
                return { ok: false, reason: 'no_audioworklet' };
            }

            // Make sure the main process has the native engine up before we
            // start pouring audio at it.
            try {
                const st = await this._api.asrStart();
                if (!st || !st.success) {
                    const reason = (st && st.error) || 'engine_unavailable';
                    this._logger.warn?.('[OfflineAsr] engine not ready:', reason);
                    this._onError(reason);
                    return { ok: false, reason };
                }
            } catch (e) {
                this._onError(e.message);
                return { ok: false, reason: e.message };
            }

            try {
                this._media = await root.navigator.mediaDevices.getUserMedia({
                    audio: {
                        channelCount: 1,
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                    },
                });
            } catch (e) {
                // Almost always a denied permission — say so plainly.
                this._logger.warn?.('[OfflineAsr] microphone unavailable:', e.message);
                this._onError('microphone_denied');
                return { ok: false, reason: 'microphone_denied' };
            }

            try {
                const Ctx = root.AudioContext || root.webkitAudioContext;
                this._ctx = new Ctx();
                const blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
                try {
                    await this._ctx.audioWorklet.addModule(blobUrl);
                } finally {
                    URL.revokeObjectURL(blobUrl);
                }

                this._resampler = new (root.PcmUtil?.Resampler || function () {
                    throw new Error('PcmUtil missing');
                })(this._ctx.sampleRate, TARGET_RATE);

                this._source = this._ctx.createMediaStreamSource(this._media);
                this._node = new root.AudioWorkletNode(this._ctx, 'l2d-capture');
                this._node.port.onmessage = (ev) => this._onFrames(ev.data);
                this._source.connect(this._node);
                // Worklets need a path to the destination to be pulled; a zero
                // gain node keeps the microphone out of the speakers.
                const mute = this._ctx.createGain();
                mute.gain.value = 0;
                this._node.connect(mute);
                mute.connect(this._ctx.destination);
            } catch (e) {
                this._logger.warn?.('[OfflineAsr] capture setup failed:', e.message);
                await this._teardown();
                this._onError(e.message);
                return { ok: false, reason: e.message };
            }

            // Recognised text arrives asynchronously from the main process.
            if (this._api.onAsrResult) {
                this._resultBound = (text) => { if (text) this._onText(String(text)); };
                this._api.onAsrResult(this._resultBound);
            }

            this._active = true;
            this._onState('listening');
            this._logger.log?.(`[OfflineAsr] listening @ ${this._ctx.sampleRate} Hz -> ${TARGET_RATE} Hz`);
            return { ok: true };
        }

        /** Audio-thread frames -> resample -> int16 -> IPC. */
        _onFrames(mono) {
            if (!this._active || !mono || !mono.length) return;
            let out;
            try {
                out = this._resampler.process(mono);
            } catch (e) {
                this._logger.warn?.('[OfflineAsr] resample failed:', e.message);
                return;
            }
            if (!out || !out.length) return;

            this._pending.push(out);
            this._pendingLen += out.length;
            while (this._pendingLen >= CHUNK_SAMPLES) {
                const merged = new Float32Array(this._pendingLen);
                let at = 0;
                for (const p of this._pending) { merged.set(p, at); at += p.length; }

                const chunk = merged.subarray(0, CHUNK_SAMPLES);
                const rest = merged.subarray(CHUNK_SAMPLES);
                this._pending = rest.length ? [rest] : [];
                this._pendingLen = rest.length;

                const pcm = root.PcmUtil.floatToInt16(chunk);
                try { this._api.asrFeed(pcm.buffer); } catch (e) {
                    this._logger.warn?.('[OfflineAsr] feed failed:', e.message);
                }
            }
        }

        async _teardown() {
            try { if (this._node) this._node.port.onmessage = null; } catch { /* ignore */ }
            try { if (this._source) this._source.disconnect(); } catch { /* ignore */ }
            try { if (this._node) this._node.disconnect(); } catch { /* ignore */ }
            try { if (this._media) this._media.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
            try { if (this._ctx && this._ctx.state !== 'closed') await this._ctx.close(); } catch { /* ignore */ }
            this._media = null; this._ctx = null; this._node = null; this._source = null;
            this._pending = []; this._pendingLen = 0;
            if (this._resampler) this._resampler.reset();
        }

        async stop() {
            const was = this._active;
            this._active = false;
            await this._teardown();
            try { if (this._api?.asrStop) await this._api.asrStop(); } catch { /* ignore */ }
            this._onState('stopped');
            if (was) this._logger.log?.('[OfflineAsr] stopped');
        }
    }

    const api = { OfflineAsrCapture, TARGET_RATE, CHUNK_SAMPLES, WORKLET_SOURCE };
    root.OfflineAsr = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
