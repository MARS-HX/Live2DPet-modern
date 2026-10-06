/**
 * PCM helpers for offline speech recognition.
 *
 * The microphone runs at the audio device's rate (usually 48 kHz) in 32-bit
 * floats, while Vosk wants 16 kHz mono signed 16-bit. This module does that
 * conversion and nothing else, so it can be tested without a microphone.
 *
 * Uses linear interpolation rather than naive decimation: dropping samples
 * without filtering folds high frequencies down and audibly degrades the
 * transcript, and the ratio is not always an integer (44.1 kHz -> 16 kHz).
 *
 * Loads as a plain <script> in the renderer and as a CommonJS module in tests.
 */
(function (root) {
    'use strict';

    /** Streaming resampler: feed arbitrary chunk sizes, get resampled output. */
    class Resampler {
        constructor(inputRate, outputRate) {
            if (!(inputRate > 0) || !(outputRate > 0)) throw new Error('invalid_sample_rate');
            this.inputRate = inputRate;
            this.outputRate = outputRate;
            this.ratio = inputRate / outputRate;
            this._carry = new Float32Array(0);
            this._pos = 0;
        }

        get passthrough() { return this.ratio === 1; }

        /**
         * @param {Float32Array} chunk mono input at `inputRate`
         * @returns {Float32Array} mono output at `outputRate`
         */
        process(chunk) {
            if (!chunk || !chunk.length) return new Float32Array(0);
            if (this.passthrough) return chunk;

            // Keep one sample of history across calls so interpolation is
            // continuous at chunk boundaries (no clicks, no dropped samples).
            const buf = new Float32Array(this._carry.length + chunk.length);
            buf.set(this._carry, 0);
            buf.set(chunk, this._carry.length);

            const out = new Float32Array(Math.ceil(buf.length / this.ratio) + 1);
            let produced = 0;
            let pos = this._pos;
            while (pos + 1 < buf.length) {
                const i = Math.floor(pos);
                const f = pos - i;
                out[produced++] = buf[i] * (1 - f) + buf[i + 1] * f;
                pos += this.ratio;
            }

            const consumed = Math.min(Math.floor(pos), buf.length);
            this._carry = buf.slice(consumed);
            this._pos = pos - consumed;
            return out.subarray(0, produced);
        }

        reset() {
            this._carry = new Float32Array(0);
            this._pos = 0;
        }
    }

    /** Downmix interleaved multi-channel float samples to mono. */
    function downmixToMono(input, channels) {
        if (!input || !input.length) return new Float32Array(0);
        if (!channels || channels <= 1) return input;
        const frames = Math.floor(input.length / channels);
        const out = new Float32Array(frames);
        for (let f = 0; f < frames; f++) {
            let sum = 0;
            for (let c = 0; c < channels; c++) sum += input[f * channels + c];
            out[f] = sum / channels;
        }
        return out;
    }

    /** Float samples in [-1, 1] to little-endian int16. Out-of-range is clamped. */
    function floatToInt16(samples) {
        const out = new Int16Array(samples.length);
        for (let i = 0; i < samples.length; i++) {
            const v = samples[i];
            const clamped = v > 1 ? 1 : (v < -1 ? -1 : v);
            // 32767 (not 32768) so +1.0 cannot overflow into -32768.
            out[i] = Math.round(clamped * 32767);
        }
        return out;
    }

    const api = { Resampler, downmixToMono, floatToInt16 };

    root.PcmUtil = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
