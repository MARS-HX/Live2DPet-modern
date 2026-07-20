/**
 * TTS Service — 多后端语音合成
 * 支持 Mimo / Aliyun 等后端
 */

const axios = require('axios');
const crypto = require('crypto');

// ========== 各后端实现 ==========

class MimoProvider {
    constructor() {
        this.config = {
            baseURL: 'https://api.xiaomimimo.com/v1',
            apiKey: '',
            model: 'mimo-v2.5-tts-voicedesign',
            format: 'wav',
            stylePrompt: '自然、流畅、清晰的中文语音'
        };
    }

    init(config) {
        if (config) {
            if (config.baseURL) this.config.baseURL = config.baseURL;
            if (config.apiKey) this.config.apiKey = config.apiKey;
            if (config.model) this.config.model = config.model;
            if (config.format) this.config.format = config.format;
            if (config.stylePrompt !== undefined) this.config.stylePrompt = config.stylePrompt;
        }
    }

    async synthesize(text) {
        const { baseURL, apiKey, model, format, stylePrompt } = this.config;
        const messages = [
            { role: "user", content: stylePrompt },
            { role: "assistant", content: text }
        ];
        const body = {
            model: model,
            messages: messages,
            audio: { format: format }
        };
        if (model && model.includes('voicedesign')) {
            body.audio.optimize_text_preview = true;
        }
        const res = await axios({
            method: 'post',
            url: `${baseURL}/chat/completions`,
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            data: body,
            timeout: 30000
        });
        const b64 = res.data?.choices?.[0]?.message?.audio?.data;
        if (!b64) throw new Error("No audio data");
        return Buffer.from(b64, 'base64');
    }

    getMetas() {
        return [{ name: 'MiMo 音色库', styles: [
            { id: 'Chloe', name: 'Chloe (活泼女声)' },
            { id: 'Mia', name: 'Mia (温柔女声)' },
            { id: 'Milo', name: 'Milo (沉稳男声)' },
            { id: 'Dean', name: 'Dean (成熟男声)' },
            { id: 'mimo_default', name: '默认音色' }
        ]}];
    }
}

class AliyunProvider {
    constructor() {
        this.config = {
            accessKeyId: '',
            accessKeySecret: '',
            appKey: '',
            voice: 'xiaoyun',       // 可选: xiaoyun, zhimiao, etc.
            format: 'wav',
            sampleRate: 16000,
            region: 'cn-shanghai'   // 地域
        };
        this._token = null;
        this._tokenExpire = 0;
    }

    init(config) {
        if (config) {
            if (config.accessKeyId) this.config.accessKeyId = config.accessKeyId;
            if (config.accessKeySecret) this.config.accessKeySecret = config.accessKeySecret;
            if (config.appKey) this.config.appKey = config.appKey;
            if (config.voice) this.config.voice = config.voice;
            if (config.format) this.config.format = config.format;
            if (config.sampleRate) this.config.sampleRate = config.sampleRate;
            if (config.region) this.config.region = config.region;
        }
    }

    async _getToken() {
        if (this._token && Date.now() < this._tokenExpire) return this._token;
        // 阿里云 Token 认证
        const host = `nls-meta.${this.config.region}.aliyuncs.com`;
        const date = new Date().toUTCString();
        const body = JSON.stringify({});
        
        const signStr = `POST\n/rest/v1/tts/token\n\n${date}\n${body}`;
        const signature = crypto.createHmac('sha1', this.config.accessKeySecret)
            .update(signStr, 'utf-8').digest().toString('base64');
        
        const res = await axios({
            method: 'post',
            url: `https://${host}/rest/v1/tts/token`,
            headers: {
                'Content-Type': 'application/json',
                'Date': date,
                'Authorization': `Dataplus ${this.config.accessKeyId}:${signature}`
            },
            data: body,
            timeout: 10000
        });
        this._token = res.data?.token;
        this._tokenExpire = Date.now() + (res.data?.expire_time || 3600) * 1000;
        return this._token;
    }

    async synthesize(text) {
        const token = await this._getToken();
        const host = `nls-gateway.${this.config.region}.aliyuncs.com`;
        
        const res = await axios({
            method: 'post',
            url: `https://${host}/rest/v1/tts/sync`,
            headers: {
                'Content-Type': 'application/json',
                'X-NLS-Token': token
            },
            data: {
                appkey: this.config.appKey,
                text: text,
                format: this.config.format,
                sample_rate: this.config.sampleRate,
                voice: this.config.voice,
                volume: 50,
                speech_rate: 0,
                pitch_rate: 0
            },
            responseType: 'arraybuffer',
            timeout: 30000
        });
        
        // 检查返回的是音频还是错误
        const contentType = res.headers['content-type'] || '';
        if (contentType.includes('audio') || contentType.includes('octet-stream')) {
            return Buffer.from(res.data);
        }
        // 可能是 JSON 错误
        const json = JSON.parse(Buffer.from(res.data).toString());
        throw new Error(json.message || 'Aliyun TTS failed');
    }

    getMetas() {
        return [{ name: '阿里云 TTS', styles: [
            { id: 'xiaoyun', name: '小云 (标准女声)' },
            { id: 'zhimiao', name: '知妙 (温柔女声)' },
            { id: 'xiaogang', name: '小刚 (标准男声)' },
            { id: 'aixia', name: '艾霞 (情感女声)' },
            { id: 'sijing', name: '思静 (情感女声)' }
        ]}];
    }
}

class LocalProvider {
    constructor() {
        this.config = {
            baseURL: 'http://localhost:7860',
            ttsEndpoint: '/run/tts',
            method: 'get',            // get 或 post
            params: {                 // 固定参数
                speaker: '0',
                language: 'zh'
            },
            textParam: 'text',        // 文本参数名
            responseType: 'json',     // json 或 blob
            audioPath: 'audio'        // json 响应中音频的路径，如 'audio' 或 'data.audio'
        };
    }

    init(config) {
        if (config) {
            if (config.baseURL) this.config.baseURL = config.baseURL;
            if (config.ttsEndpoint) this.config.ttsEndpoint = config.ttsEndpoint;
            if (config.method) this.config.method = config.method;
            if (config.textParam) this.config.textParam = config.textParam;
            if (config.responseType) this.config.responseType = config.responseType;
            if (config.audioPath) this.config.audioPath = config.audioPath;
            if (config.params) this.config.params = { ...this.config.params, ...config.params };
            // 兼容旧字段名
            if (config.speaker) this.config.params.speaker = config.speaker;
            if (config.language) this.config.params.language = config.language;
        }
    }

    async synthesize(text) {
        const { baseURL, ttsEndpoint, method, params, textParam, responseType, audioPath } = this.config;
        
        // 构建请求
        const queryParams = { ...params, [textParam]: text };
        const url = `${baseURL.replace(/\/$/, '')}${ttsEndpoint}`;
        
        let response;
        if (method === 'get') {
            response = await axios.get(url, {
                params: queryParams,
                responseType: responseType === 'blob' ? 'arraybuffer' : 'json',
                timeout: 30000
            });
        } else {
            response = await axios.post(url, queryParams, {
                responseType: responseType === 'blob' ? 'arraybuffer' : 'json',
                timeout: 30000
            });
        }

        if (responseType === 'blob' || responseType === 'arraybuffer') {
            return Buffer.from(response.data);
        }

        // JSON 响应，从 audioPath 提取音频数据
        let audioData = response.data;
        for (const key of audioPath.split('.')) {
            audioData = audioData?.[key];
            if (!audioData) break;
        }
        if (!audioData) {
            throw new Error('No audio in response, path: ' + audioPath);
        }

        // 可能是 base64 或直接二进制
        if (typeof audioData === 'string') {
            // base64
            const base64Str = audioData.replace(/^data:audio\/\w+;base64,/, '');
            return Buffer.from(base64Str, 'base64');
        }
        // 已经是 Buffer
        return Buffer.from(audioData);
    }

    getMetas() {
        return [{ name: '本地 TTS', styles: [
            { id: 'default', name: '默认音色' }
        ]}];
    }
}

// ========== TTS 服务主类 ==========

class TTSService {
    constructor() {
        this.initialized = false;
        this.serviceType = 'mimo';
        this.providers = {
            mimo: new MimoProvider(),
            aliyun: new AliyunProvider(),
            local: new LocalProvider()
        };
        this.activeProvider = this.providers.mimo;

        // 电路保护
        this.failCount = 0;
        this.maxFails = 3;
        this.degraded = false;
        this.degradedAt = 0;
        this.retryInterval = 60000;
    }

    init(options = {}) {
        if (this.initialized) return true;
        try {
            const { serviceType, mimo, aliyun } = options;
            if (serviceType && this.providers[serviceType]) {
                this.serviceType = serviceType;
                this.activeProvider = this.providers[serviceType];
            }
            if (mimo) this.providers.mimo.init(mimo);
            if (aliyun) this.providers.aliyun.init(aliyun);
            this.initialized = true;
            console.log(`[TTS] Initialized with backend: ${this.serviceType}`);
            return true;
        } catch (err) {
            console.error('[TTS] Init failed:', err.message);
            this.initialized = false;
            return false;
        }
    }

    async synthesize(text, styleId) {
        return this.tts(text, styleId);
    }

    async tts(text, styleId) {
        if (!this.initialized || this._checkDegraded()) return null;
        try {
            const buf = await this.activeProvider.synthesize(text);
            this._onSuccess();
            return buf;
        } catch (err) {
            console.error(`[TTS] ${this.serviceType} failed:`, err.message);
            this._onFailure();
            return null;
        }
    }

    setConfig(config = {}) {
        if (config.serviceType && this.providers[config.serviceType]) {
            this.serviceType = config.serviceType;
            this.activeProvider = this.providers[config.serviceType];
        }
        if (config.mimo) this.providers.mimo.init(config.mimo);
        if (config.aliyun) this.providers.aliyun.init(config.aliyun);
    }

    isAvailable() { return this.initialized && !this._checkDegraded(); }

    getMetas() { return this.activeProvider.getMetas(); }
    getAvailableVvms() { return []; }

    _checkDegraded() {
        if (!this.degraded) return false;
        if (Date.now() - this.degradedAt >= this.retryInterval) {
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

    destroy() {
        this.initialized = false;
        console.log('[TTS] Destroyed');
    }
}

module.exports = { TTSService };
