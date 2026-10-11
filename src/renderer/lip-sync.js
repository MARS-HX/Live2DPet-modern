/**
 * LipSync — 把正在播放的 TTS 音频变成 0..1 的口型值。
 *
 * 为什么不用 `<audio>` + MediaElementSource：data: URL 对 Web Audio 来说是跨源，
 * createMediaElementSource 会直接抛 SecurityError。这里改成把 base64 WAV 解码成
 * AudioBuffer 再播，既绕开跨源，也拿得到干净的时域样本。
 *
 * 三层职责分得很清（前两层是纯函数，能单独测）：
 *   1. rmsToLevel   —— 底噪压掉、放大量化到 0..1
 *   2. smoothLevel  —— 张开快、闭合慢（否则嘴会一帧一帧地抖）
 *   3. LipSyncPlayer—— 播放 + 每帧回调；Web Audio 不可用时退回定时节奏
 */
(function (root) {
    const DEFAULTS = {
        gain: 3.2,      // 语音 RMS 大约 0.05~0.3，放大到接近满开
        floor: 0.012,   // 静音/底噪门限
        attack: 0.55,   // 每帧向目标逼近的比例：张嘴
        release: 0.18,  // 闭嘴（慢一点，避免锯齿）
        reference: 0.08 // 自适应参考音量：本应用有 mimo/aliyun/本地三个 TTS 后端，
                        // 输出电平差很多，固定增益会让"小声的那次嘴几乎不动"
    };

    const clamp01 = (v) => (v < 0 ? 0 : (v > 1 ? 1 : v));

    /** 时域 RMS → 0..1 口型值。静音、NaN、非正数一律 0。 */
    function rmsToLevel(rms, opts = {}) {
        const floor = opts.floor === undefined ? DEFAULTS.floor : opts.floor;
        const gain = opts.gain === undefined ? DEFAULTS.gain : opts.gain;
        const v = Number(rms);
        if (!Number.isFinite(v) || v <= floor) return 0;
        return clamp01((v - floor) * gain);
    }

    /**
     * 自适应参考音量：只跟着"更大"走（快），回落很慢。
     * 这样一句话内部不会忽大忽小，而不同后端/不同句子的电平差异也会被吸收掉。
     */
    function adaptReference(prev, rms, opts = {}) {
        const start = opts.reference === undefined ? DEFAULTS.reference : opts.reference;
        const min = opts.referenceMin === undefined ? 0.03 : opts.referenceMin;
        const p = Number.isFinite(prev) && prev > 0 ? prev : start;
        const v = Number(rms);
        if (!Number.isFinite(v) || v <= 0) return p;
        if (v > p) return v;
        return Math.max(min, p * (opts.decay === undefined ? 0.999 : opts.decay));
    }

    /**
     * 由参考音量推出放大倍数：让"这句话的一般音量"正好铺满开合区间。
     * 注意要减掉 floor —— rmsToLevel 里也减了一次，不减这里参考点就永远差一截
     * （实测 0.05 的参考只能开到 0.89，看起来就是"说话时嘴张不满"）。
     */
    function gainForReference(reference, opts = {}) {
        const min = opts.referenceMin === undefined ? 0.03 : opts.referenceMin;
        const headroom = opts.headroom === undefined ? 0.85 : opts.headroom;
        const floor = opts.floor === undefined ? DEFAULTS.floor : opts.floor;
        const ref = Math.max(min, Number(reference) || min);
        const span = Math.max(ref - floor, min * 0.5);
        return 1 / (span * headroom);
    }

    /** 非对称平滑。两个入参都会被夹到 0..1，输出也一定在 0..1。 */
    function smoothLevel(prev, next, opts = {}) {
        const attack = opts.attack === undefined ? DEFAULTS.attack : opts.attack;
        const release = opts.release === undefined ? DEFAULTS.release : opts.release;
        const p = clamp01(Number(prev) || 0);
        const n = clamp01(Number(next) || 0);
        const k = n > p ? attack : release;
        return clamp01(p + (n - p) * k);
    }

    /**
     * 拿不到 Web Audio（或解码失败）时的退路：给一个像说话的开合节奏。
     * 两个不同频率的正弦相乘 → 有音节感、也有换气停顿，且完全确定（可测）。
     */
    function fallbackLevel(elapsedMs, opts = {}) {
        const speed = opts.speed === undefined ? 11 : opts.speed;
        const t = (Number(elapsedMs) || 0) / 1000;
        const syllable = 0.5 + 0.5 * Math.sin(t * speed);
        const breath = 0.45 + 0.55 * Math.sin(t * speed * 0.37 + 1.1);
        return clamp01(syllable * breath);
    }

    /** 时域样本 → RMS。样本是 -1..1 的归一化浮点。 */
    function rmsOf(samples) {
        if (!samples || !samples.length) return 0;
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
            const s = samples[i];
            sum += s * s;
        }
        return Math.sqrt(sum / samples.length);
    }

    /** base64 → ArrayBuffer（不依赖 atob 之外的东西，Node 下用 Buffer 兜底）。 */
    function base64ToArrayBuffer(b64) {
        const clean = String(b64 || '').replace(/^data:[^,]*,/, '');
        if (typeof atob === 'function') {
            const bin = atob(clean);
            const out = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
            return out.buffer;
        }
        const buf = Buffer.from(clean, 'base64');
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }

    class LipSyncPlayer {
        constructor(deps = {}) {
            this._logger = deps.logger || console;
            const Ctx = root.AudioContext || root.webkitAudioContext;
            this._ctxFactory = deps.audioContextFactory
                || (Ctx ? () => new Ctx() : null);
            this._audioFactory = deps.audioFactory
                || (typeof root.Audio === 'function' ? (url) => new root.Audio(url) : null);
            this._now = deps.now
                || (() => (root.performance && root.performance.now ? root.performance.now() : Date.now()));
            this._raf = deps.raf
                || ((cb) => root.setTimeout(() => cb(), 16));
            this._cancelRaf = deps.cancelRaf
                || ((id) => root.clearTimeout(id));
            this._ctx = null;
            this._active = false;
            this._stopRequested = false;
            this._resolveEnd = null;
            this._level = 0;
            this._timer = null;
            this._source = null;
            this._reference = DEFAULTS.reference;
        }

        get level() { return this._level; }
        get playing() { return this._active; }

        /**
         * 播一段 base64 WAV，并按帧回调口型值。
         * @returns {Promise<{ok:boolean, reason?:string}>} 播放结束（或被 stop）时 resolve，不抛。
         */
        async play(base64Wav, handlers = {}) {
            this.stop();
            const onLevel = handlers.onLevel || (() => {});
            const onEnd = handlers.onEnd || (() => {});
            this._active = true;
            this._stopRequested = false;
            this._reference = DEFAULTS.reference;   // 每句话重新估计音量

            const done = (reason) => {
                this._active = false;
                this._level = 0;
                onLevel(0);              // 收尾一定要闭嘴，否则停在张开状态
                onEnd(reason);
            };

            // 先试 Web Audio（能拿到真实音量）
            if (this._ctxFactory) {
                try {
                    const res = await this._playWebAudio(base64Wav, onLevel, handlers);
                    done(res && res.reason ? res.reason : 'ended');
                    return { ok: true };
                } catch (e) {
                    this._logger.warn?.('[LipSync] Web Audio 不可用，退回定时节奏:', e && e.message);
                    this._closeCtx();
                }
            }

            // 退路：还能播就用 <audio>，口型按时间走
            if (this._stopRequested) { done('stopped'); return { ok: true }; }
            try {
                await this._playFallback(base64Wav, onLevel, handlers);
                done('ended');
                return { ok: true };
            } catch (e) {
                done('error');
                return { ok: false, reason: (e && e.message) || 'playback_failed' };
            }
        }

        /** Web Audio：解码 → 播放 → 每帧取时域 RMS。 */
        _playWebAudio(base64Wav, onLevel, handlers) {
            const ctx = this._ctx || this._ctxFactory();
            this._ctx = ctx;
            const data = base64ToArrayBuffer(base64Wav);

            return new Promise((resolve, reject) => {
                const onDecoded = (audioBuffer) => {
                    if (this._stopRequested) { resolve({ reason: 'stopped' }); return; }
                    try {
                        const analyser = ctx.createAnalyser();
                        analyser.fftSize = 1024;
                        const gain = ctx.createGain();
                        // 静音时增益置 0，但整条图仍然跑着 —— 这样 OBS 端可以选择
                        // 只同步口型、不出声，而不影响分析。
                        gain.gain.value = handlers.audible === false ? 0 : 1;
                        const src = ctx.createBufferSource();
                        src.buffer = audioBuffer;
                        src.connect(analyser);
                        analyser.connect(gain);
                        gain.connect(ctx.destination);
                        this._source = src;

                        const view = new Float32Array(analyser.fftSize);
                        const release = (reason) => {
                            if (this._rafId !== undefined && this._rafId !== null) {
                                this._cancelRaf(this._rafId);
                                this._rafId = null;
                            }
                            try { src.disconnect(); } catch (e) { /* 已断开 */ }
                            try { analyser.disconnect(); } catch (e) { /* 已断开 */ }
                            try { gain.disconnect(); } catch (e) { /* 已断开 */ }
                            this._source = null;
                            resolve({ reason });
                        };
                        src.onended = () => release('ended');

                        const tick = () => {
                            if (this._stopRequested) { try { src.stop(); } catch (e) { /* 已停 */ } release('stopped'); return; }
                            let rms = 0;
                            try {
                                analyser.getFloatTimeDomainData(view);
                                rms = rmsOf(view);
                            } catch (e) {
                                this._logger.warn?.('[LipSync] 读取时域样本失败:', e && e.message);
                                release('ended');
                                return;
                            }
                            // 自适应增益：同一句话内部稳定，不同后端/不同句子的电平差异也能吸收
                            this._reference = adaptReference(this._reference, rms, handlers);
                            const levelOpts = Object.assign({}, handlers, {
                                gain: gainForReference(this._reference, handlers),
                            });
                            this._level = smoothLevel(this._level, rmsToLevel(rms, levelOpts), handlers);
                            onLevel(this._level);
                            this._rafId = this._raf(tick);
                        };

                        try { src.start(); } catch (e) { /* start() 极少失败 */ }
                        // 挂起的 AudioContext 会让 getFloatTimeDomainData 恒返回 0 ——
                        // 表现就是"在说话但嘴一动不动"。这里先把它恢复起来。
                        if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
                            try {
                                const p = ctx.resume();
                                if (p && typeof p.catch === 'function') p.catch(() => {});
                            } catch (e) { /* 恢复失败也继续跑，最坏是这次没声音 */ }
                        }
                        this._rafId = this._raf(tick);
                    } catch (e) {
                        reject(e);
                    }
                };

                try {
                    const maybe = ctx.decodeAudioData(data, onDecoded, reject);
                    if (maybe && typeof maybe.then === 'function') maybe.then(onDecoded, reject);
                } catch (e) {
                    reject(e);
                }
            });
        }

        /** 退路：<audio> 播放 + 定时节奏驱动口型。 */
        _playFallback(base64Wav, onLevel, handlers) {
            if (!this._audioFactory) return Promise.reject(new Error('no_audio_support'));
            return new Promise((resolve, reject) => {
                let el;
                try {
                    el = this._audioFactory('data:audio/wav;base64,' + String(base64Wav || ''));
                } catch (e) {
                    reject(e);
                    return;
                }
                this._fallbackEl = el;
                if (handlers.audible === false) el.muted = true;
                let startMs = null;
                const finish = (reason) => {
                    if (this._timer !== null) { this._cancelRaf(this._timer); this._timer = null; }
                    try { el.onended = null; el.onerror = null; } catch (e) { /* ignore */ }
                    this._fallbackEl = null;
                    resolve({ reason });
                };
                el.onended = () => finish('ended');
                el.onerror = () => finish('ended');   // 播不了也让流程收尾，不要让宠物一直张着嘴
                const tick = () => {
                    if (this._stopRequested) {
                        try { el.pause(); } catch (e) { /* ignore */ }
                        finish('stopped');
                        return;
                    }
                    if (startMs === null) startMs = this._now();
                    this._level = fallbackLevel(this._now() - startMs, handlers);
                    onLevel(this._level);
                    this._timer = this._raf(tick);
                };
                try {
                    const p = el.play();
                    if (p && typeof p.catch === 'function') p.catch(() => finish('blocked'));
                } catch (e) {
                    finish('blocked');
                    return;
                }
                this._timer = this._raf(tick);
            });
        }

        _closeCtx() {
            try {
                if (this._ctx && typeof this._ctx.close === 'function') this._ctx.close();
            } catch (e) { /* 已经关了 */ }
            this._ctx = null;
        }

        /** 停止播放并立刻闭嘴。 */
        stop() {
            this._stopRequested = true;
            if (this._source) {
                try { this._source.stop(); } catch (e) { /* 还没 start 或已停 */ }
            }
            if (this._fallbackEl) {
                try { this._fallbackEl.pause(); } catch (e) { /* ignore */ }
            }
            if (this._rafId !== undefined && this._rafId !== null) {
                this._cancelRaf(this._rafId);
                this._rafId = null;
            }
            if (this._timer !== null) {
                this._cancelRaf(this._timer);
                this._timer = null;
            }
            this._active = false;
            this._level = 0;
        }

        /** 释放 AudioContext（窗口卸载时用）。 */
        dispose() {
            this.stop();
            this._closeCtx();
        }
    }

    const api = {
        LipSyncPlayer, rmsToLevel, smoothLevel, fallbackLevel, rmsOf,
        adaptReference, gainForReference, base64ToArrayBuffer, DEFAULTS,
    };
    root.LipSync = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
