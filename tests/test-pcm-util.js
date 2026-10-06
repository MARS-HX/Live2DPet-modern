/**
 * Tests for the PCM conversion used between the microphone and Vosk.
 * Run with: node --test tests/test-pcm-util.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');

const { Resampler, downmixToMono, floatToInt16 } = require('../src/core/pcm-util');

const sine = (n, freq, rate) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.sin(2 * Math.PI * freq * i / rate);
    return out;
};

describe('Resampler', () => {
    it('passes samples straight through at matching rates', () => {
        const r = new Resampler(16000, 16000);
        const input = sine(100, 440, 16000);
        assert.strictEqual(r.process(input), input);
    });

    it('produces the right number of samples for an integer ratio', () => {
        const r = new Resampler(48000, 16000);          // 3:1
        const out = r.process(sine(48000, 440, 48000));
        assert.ok(Math.abs(out.length - 16000) <= 2, `got ${out.length}, expected ~16000`);
    });

    it('produces the right count for a non-integer ratio (44.1 kHz)', () => {
        const r = new Resampler(44100, 16000);          // 2.75625:1
        const out = r.process(sine(44100, 440, 44100));
        assert.ok(Math.abs(out.length - 16000) <= 3, `got ${out.length}, expected ~16000`);
    });

    it('is continuous across chunk boundaries', () => {
        // A resampler that drops the boundary sample produces a different
        // total than one fed the whole buffer at once.
        const rate = 48000;
        const whole = new Resampler(rate, 16000).process(sine(rate, 440, rate));

        const chunked = new Resampler(rate, 16000);
        const parts = [];
        const src = sine(rate, 440, rate);
        for (let off = 0; off < src.length; off += 128) {
            parts.push(chunked.process(src.subarray(off, off + 128)));
        }
        const total = parts.reduce((n, p) => n + p.length, 0);
        assert.ok(Math.abs(total - whole.length) <= 2,
            `chunked ${total} vs whole ${whole.length} — boundary samples are being lost`);
    });

    it('keeps a 440 Hz tone at 440 Hz after 48k -> 16k', () => {
        // Crude but effective: count zero crossings over one second.
        const out = new Resampler(48000, 16000).process(sine(48000, 440, 48000));
        let crossings = 0;
        for (let i = 1; i < out.length; i++) if ((out[i - 1] < 0) !== (out[i] < 0)) crossings++;
        const hz = crossings / 2;
        assert.ok(Math.abs(hz - 440) <= 3, `measured ${hz} Hz`);
    });

    it('handles empty input and rejects bad rates', () => {
        const r = new Resampler(48000, 16000);
        assert.strictEqual(r.process(null).length, 0);
        assert.strictEqual(r.process(new Float32Array(0)).length, 0);
        assert.throws(() => new Resampler(0, 16000), /invalid_sample_rate/);
    });

    it('reset() clears the interpolation state', () => {
        const r = new Resampler(48000, 16000);
        r.process(sine(1000, 440, 48000));
        r.reset();
        assert.strictEqual(r.process(new Float32Array(0)).length, 0);
    });
});

describe('downmixToMono', () => {
    it('passes mono through untouched', () => {
        const mono = sine(10, 440, 16000);
        assert.strictEqual(downmixToMono(mono, 1), mono);
    });

    it('averages stereo frames', () => {
        const stereo = new Float32Array([1, 0, 0, 1, -1, -1]);
        assert.deepStrictEqual(Array.from(downmixToMono(stereo, 2)), [0.5, 0.5, -1]);
    });

    it('ignores a trailing partial frame', () => {
        const stereo = new Float32Array([1, 1, 1]);   // 1.5 frames
        assert.strictEqual(downmixToMono(stereo, 2).length, 1);
    });

    it('returns empty for empty input', () => {
        assert.strictEqual(downmixToMono(null, 2).length, 0);
    });
});

describe('floatToInt16', () => {
    it('scales and rounds', () => {
        const out = floatToInt16(new Float32Array([0, 1, -1, 0.5]));
        assert.deepStrictEqual(Array.from(out), [0, 32767, -32767, 16384]);
    });

    it('clamps instead of wrapping — this is what stops loud audio becoming noise', () => {
        const out = floatToInt16(new Float32Array([2, -2, 1.5]));
        assert.deepStrictEqual(Array.from(out), [32767, -32767, 32767]);
    });

    it('never produces -32768 for +1.0', () => {
        const out = floatToInt16(new Float32Array([1]));
        assert.notStrictEqual(out[0], -32768);
    });

    it('handles empty input', () => {
        assert.strictEqual(floatToInt16(new Float32Array(0)).length, 0);
    });
});
