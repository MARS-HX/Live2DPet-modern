/**
 * STT Service — 统一语音识别接口
 * 支持多种后端：Mimo API (云端)、Vosk (本地离线)
 *
 * 主进程中使用。根据配置选择后端，提供统一的 transcribe 方法。
 *
 * 电路保护：连续 3 次失败 → 降级静默，60 秒后重试
 */

const axios = require('axios');
const { Buffer } = require('buffer');
const { PassThrough } = require('stream');

// 尝试加载本地 Vosk（如果已安装且无编译错误）
let vosk = null;
let voskAvailable = false;
try {
    vosk = require('vosk');
    voskAvailable = true;
} catch (err) {
    console.warn('[STT] Vosk not available, local recognition disabled', err.message);
}

class STTService {
    constructor() {
        this.initialized = false;
        this.backend = 'mimo';          // 'mimo' 或 'vosk'
        this.mimoConfig = {
            baseURL: 'https://api.xiaomimimo.com/v1',
            apiKey: '',
            model: 'mimo-v2.5-asr',
            language: 'zh'
        };
        this.voskConfig = {
            modelPath: '',   // 本地模型路径
            sampleRate: 16000
        };
        this.voskRecognizer = null;

        // 电路保护
        this.failCount = 0;
        this.maxFails = 3;
        this.degraded = false;
        this.degradedAt = 0;
        this.retryInterval = 60000;
    }

    /**
     * 初始化 STT 后端
     * @param {object} options - { backend, mimo, vosk }
     * @returns {boolean}
     */
    init(options = {}) {
        if (this.initialized) return true;
        const { backend = 'mimo', mimo, vosk: voskOpt } = options;
        this.backend = backend;

        try {
            if (backend === 'mimo') {
                if (mimo) this._updateMimoConfig(mimo);
                this.initialized = true;
                console.log('[STT] Mimo backend initialized');
                return true;
            } else if (backend === 'vosk') {
                if (!voskAvailable) throw new Error('Vosk library not available');
                if (voskOpt) this._updateVoskConfig(voskOpt);
                const initOk = this._initVosk();
                if (initOk) {
                    this.initialized = true;
                    console.log('[STT] Vosk backend initialized');
                    return true;
                } else {
                    throw new Error('Vosk initialization failed');
                }
            } else {
                throw new Error(`Unknown backend: ${backend}`);
            }
        } catch (err) {
            console.error('[STT] Init failed:', err.message);
            this.initialized = false;
            return false;
        }
    }

    _updateMimoConfig(config) {
        if (config.baseURL) this.mimoConfig.baseURL = config.baseURL;
        if (config.apiKey) this.mimoConfig.apiKey = config.apiKey;
        if (config.model) this.mimoConfig.model = config.model;
        if (config.language) this.mimoConfig.language = config.language;
    }

    _updateVoskConfig(config) {
        if (config.modelPath) this.voskConfig.modelPath = config.modelPath;
        if (config.sampleRate) this.voskConfig.sampleRate = config.sampleRate;
    }

    _initVosk() {
        if (!vosk) return false;
        try {
            const modelPath = this.voskConfig.modelPath;
            if (!modelPath || !require('fs').existsSync(modelPath)) {
                console.error('[STT] Vosk model not found at', modelPath);
                return false;
            }
            vosk.setLogLevel(-1); // 关闭调试日志
            const model = new vosk.Model(modelPath);
            this.voskRecognizer = new vosk.Recognizer({
                model,
                sampleRate: this.voskConfig.sampleRate
            });
            return true;
        } catch (err) {
            console.error('[STT] Vosk recognizer error:', err);
            return false;
        }
    }

    // 确保音频转为 16kHz 单声道 PCM (Int16)
    _convertToPcm16(audioBuffer, originalSampleRate = 48000) {
        // 简单实现：如果已经是 16kHz 直接返回 Int16
        // 更复杂的重采样可用 'audio-resample' 库，这里假设前端已提供 16kHz
        // 直接读取 Buffer 为 Int16
        return new Int16Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.byteLength / 2);
    }

    /**
     * 语音识别主方法
     * @param {Buffer} audioBuffer - WAV 或 PCM 数据（16kHz 单声道）
     * @returns {Promise<string>}
     */
    async transcribe(audioBuffer) {
        if (!this.initialized || this._checkDegraded()) return '';
        if (this.backend === 'mimo') {
            return this._transcribeMimo(audioBuffer);
        } else if (this.backend === 'vosk') {
            return this._transcribeVosk(audioBuffer);
        } else {
            return '';
        }
    }

    // ---------- Mimo 后端 ----------
    async _transcribeMimo(audioBuffer) {
        try {
            // 转换为 base64 data URL
            const base64 = audioBuffer.toString('base64');
            const audioDataUrl = `data:audio/wav;base64,${base64}`;

            const requestBody = {
                model: this.mimoConfig.model,
                messages: [{
                    role: "user",
                    content: [{
                        type: "input_audio",
                        input_audio: { data: audioDataUrl }
                    }]
                }],
                asr_options: { language: this.mimoConfig.language }
            };

            const url = `${this.mimoConfig.baseURL.replace(/\/$/, '')}/chat/completions`;
            const response = await axios.post(url, requestBody, {
                headers: {
                    'Authorization': `Bearer ${this.mimoConfig.apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });

            const text = response.data?.choices?.[0]?.message?.content;
            if (text) {
                this._onSuccess();
                return text.trim();
            }
            throw new Error('No text in response');
        } catch (err) {
            console.error('[STT] Mimo error:', err.message);
            this._onFailure();
            return '';
        }
    }

    // ---------- Vosk 后端 ----------
    async _transcribeVosk(audioBuffer) {
        if (!this.voskRecognizer) {
            console.error('[STT] Vosk recognizer not ready');
            return '';
        }
        try {
            // Vosk 期望 Int16 PCM 数据
            const pcmData = this._convertToPcm16(audioBuffer);
            if (this.voskRecognizer.acceptWaveform(pcmData.buffer)) {
                const result = this.voskRecognizer.result();
                const text = result.text || '';
                this._onSuccess();
                return text.trim();
            } else {
                // 部分结果（未完成句子）可以暂不返回
                const partial = this.voskRecognizer.partialResult();
                if (partial && partial.partial) {
                    // 可选：返回部分结果，这里简化直接返回空
                    return '';
                }
                return '';
            }
        } catch (err) {
            console.error('[STT] Vosk error:', err);
            this._onFailure();
            return '';
        }
    }

    // 电路保护
    _checkDegraded() {
        if (!this.degraded) return false;
        if (Date.now() - this.degradedAt >= this.retryInterval) {
            console.log('[STT] Circuit breaker: attempting recovery');
            this.degraded = false;
            this.failCount = 0;
            return false;
        }
        return true;
    }

    _onSuccess() { this.failCount = 0; }

    _onFailure() {
        this.failCount++;
        if (this.failCount >= this.maxFails) {
            console.warn(`[STT] Circuit breaker: degraded after ${this.failCount} failures`);
            this.degraded = true;
            this.degradedAt = Date.now();
        }
    }

    /**
     * 更新配置（后端切换或参数调整）
     * @param {object} config
     */
    setConfig(config = {}) {
        if (config.backend) this.backend = config.backend;
        if (config.mimo) this._updateMimoConfig(config.mimo);
        if (config.vosk) this._updateVoskConfig(config.vosk);
        // 重新初始化后端（如果已初始化且后端变更）
        if (this.initialized && (config.backend || config.mimo || config.vosk)) {
            this.destroy();
            this.init({ backend: this.backend, mimo: this.mimoConfig, vosk: this.voskConfig });
        }
    }

    isAvailable() { return this.initialized && !this._checkDegraded(); }

    destroy() {
        if (this.voskRecognizer) {
            this.voskRecognizer.free();
            this.voskRecognizer = null;
        }
        this.initialized = false;
        console.log('[STT] Destroyed');
    }
}

module.exports = { STTService };