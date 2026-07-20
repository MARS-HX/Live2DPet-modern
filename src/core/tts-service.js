/**
 * TTS Service — 仅支持小米 Mimo API (云端)
 * 
 * 主进程中使用。统一使用 Mimo HTTP API 进行中文语音合成。
 * 支持 voicedesign 模型，通过 chat.completions 端点生成音频。
 *
 * 电路保护：连续 3 次失败 → 降级静默，60 秒后重试
 */

const axios = require('axios');

class TTSService {
    constructor() {
        // 通用状态
        this.initialized = false;
        this.serviceType = 'mimo';   // 固定为 'mimo'

        // 小米 Mimo 配置（符合官方 API）
        this.mimoConfig = {
            baseURL: 'https://api.xiaomimimo.com/v1',
            apiKey: '',
            model: 'mimo-v2.5-tts-voicedesign', // 使用 voicedesign 模型
            format: 'wav',
            stylePrompt: '自然、流畅、清晰的中文语音，中性语调，速度适中。'
        };

        // 电路保护
        this.failCount = 0;
        this.maxFails = 3;
        this.degraded = false;
        this.degradedAt = 0;
        this.retryInterval = 60000;
    }

    /**
     * 初始化 TTS 后端（仅 Mimo）
     * @param {object} options
     * @param {object} options.mimo - 小米 Mimo 配置 { baseURL, apiKey, model, format, stylePrompt }
     * @returns {boolean}
     */
    init(options = {}) {
        if (this.initialized) return true;
        const { mimo } = options;
        try {
            if (mimo) this._updateMimoConfig(mimo);
            this.initialized = true;
            console.log('[TTS] Mimo backend initialized');
            return true;
        } catch (err) {
            console.error('[TTS] Init failed:', err.message);
            this.initialized = false;
            return false;
        }
    }

    // 更新 Mimo 配置
    _updateMimoConfig(config) {
        if (config.baseURL) this.mimoConfig.baseURL = config.baseURL;
        if (config.apiKey) this.mimoConfig.apiKey = config.apiKey;
        if (config.model) this.mimoConfig.model = config.model;
        if (config.format) this.mimoConfig.format = config.format;
        if (config.stylePrompt !== undefined) this.mimoConfig.stylePrompt = config.stylePrompt;
        // 忽略旧字段 voice, speed, pitch
    }

    // 调用 Mimo API 进行 TTS（严格遵循官方示例）
    async _requestMimoTTS(text) {
        const { baseURL, apiKey, model, format, stylePrompt } = this.mimoConfig;

        // 构建消息：user 为风格描述，assistant 为待合成文本
        const messages = [
            {
                role: "user",
                content: stylePrompt || "自然、流畅、清晰的中文语音，中性语调，速度适中。"
            },
            {
                role: "assistant",
                content: text
            }
        ];

        const requestBody = {
            model: model || "mimo-v2.5-tts-voicedesign",
            messages: messages,
            audio: {
                format: format || "wav",
                optimize_text_preview: true   // 官方示例中的参数
            }
        };

        // 注意：不要添加 voice、speed、pitch 等额外字段，否则 API 会返回 400

        const response = await axios({
            method: 'post',
            url: `${baseURL}/chat/completions`,
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            data: requestBody,
            timeout: 30000,
        });

        if (response.status !== 200) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const audioBase64 = response.data?.choices?.[0]?.message?.audio?.data;
        if (!audioBase64) {
            throw new Error("No audio data in response");
        }
        return Buffer.from(audioBase64, 'base64');
    }

    // ==================== 公开合成接口（全部异步） ====================
    /**
     * 合成 WAV 音频（与 tts 相同，仅为兼容旧接口）
     * @param {string} text
     * @param {number} [styleId] 忽略
     * @returns {Promise<Buffer|null>}
     */
    async synthesize(text, styleId) {
        return this.tts(text, styleId);
    }

    /**
     * 简单 TTS 合成（直接中文 -> 语音）
     * @param {string} text
     * @param {number} [styleId] 忽略
     * @returns {Promise<Buffer|null>}
     */
    async tts(text, styleId) {
        if (!this.initialized || this._checkDegraded()) return null;
        return this._ttsMimo(text);
    }

    // Mimo 实现
    async _ttsMimo(text) {
        try {
            const buf = await this._requestMimoTTS(text);
            this._onSuccess();
            return buf;
        } catch (err) {
            console.error('[TTS] Mimo TTS failed:', err.message);
            this._onFailure();
            return null;
        }
    }

    // 电路保护
    _checkDegraded() {
        if (!this.degraded) return false;
        if (Date.now() - this.degradedAt >= this.retryInterval) {
            console.log('[TTS] Circuit breaker: attempting recovery');
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
            console.warn(`[TTS] Circuit breaker: degraded after ${this.failCount} failures`);
            this.degraded = true;
            this.degradedAt = Date.now();
        }
    }

    /**
     * 更新配置（仅 Mimo 参数）
     */
    setConfig(config = {}) {
        if (config.serviceType) this.serviceType = config.serviceType;
        if (config.mimo) this._updateMimoConfig(config.mimo);
        // 兼容旧的 voicevox 参数，忽略
    }

    isAvailable() { return this.initialized && !this._checkDegraded(); }

    // 以下方法为了兼容前端调用而保留
    getAvailableVvms() { return []; }
    getMetas() {
        // 返回预设的 Mimo 音色列表（仅为兼容，实际 API 不区分音色）
        return [{
            name: 'MiMo 音色库',
            styles: [
                { id: 'Chloe', name: 'Chloe (活泼女声)' },
                { id: 'Mia', name: 'Mia (温柔女声)' },
                { id: 'Milo', name: 'Milo (沉稳男声)' },
                { id: 'Dean', name: 'Dean (成熟男声)' },
                { id: 'mimo_default', name: '默认音色' }
            ]
        }];
    }

    destroy() {
        this.initialized = false;
        console.log('[TTS] Destroyed');
    }
}

module.exports = { TTSService };