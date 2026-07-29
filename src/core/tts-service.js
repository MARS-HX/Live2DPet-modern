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
        this.config = { apiKey: '', voice: 'zhiyue' };
    }
    init(c) { if (!c) return; if (c.apiKey) this.config.apiKey = c.apiKey; if (c.voice) this.config.voice = c.voice; }
    
    async synthesize(text) {
        if (!this.config.apiKey) throw new Error('No API Key configured');
        const WebSocket = require('ws');
        const uuid = require('crypto').randomUUID();
        const token = this.config.apiKey;
        const voice = this.config.voice || 'zhiyue';
        
        return new Promise((resolve, reject) => {
            const ws = new (require('ws'))('wss://dashscope.aliyuncs.com/api/v1/services/tts/text-to-speech/ws', {
                rejectUnauthorized: false,
                headers: { 'Authorization': 'Bearer ' + token }
            });
            const chunks = [];
            let hasAudio = false;
            const t = setTimeout(() => { ws.close(); reject(new Error('Timeout')); }, 25000);
            
            ws.on('open', () => {
                ws.send(JSON.stringify({
                    header: { action: 'run-task', task_id: uuid, streaming: 'out' },
                    payload: { model: 'sambert-zhiyue-v1', task: { text, voice, format: 'wav', sample_rate: 48000 } }
                }));
            });
            ws.on('message', (data, isBinary) => {
                if (isBinary) { chunks.push(data); hasAudio = true; }
                else {
                    const m = JSON.parse(data.toString());
                    if (['task-stopped', 'completed'].includes(m.header?.action)) ws.close();
                }
            });
            ws.on('close', (code, reason) => {
                clearTimeout(t);
                if (hasAudio) resolve(Buffer.concat(chunks));
                else reject(new Error('WS close=' + (code || ws._closeCode) + ' reason=' + (reason || '').toString()));
            });
            ws.on('error', (err) => { clearTimeout(t); reject(err); });
        });
    }
    
    getMetas() {
        return [{ name: '\\u963f\\u91cc\\u4e91 TTS', styles: [
            { id:'zhiyue', name:'\\u77e5\\u8d8a' }, { id:'zhimiao', name:'\\u77e5\\u5999' },
            { id:'zhiling', name:'\\u77e5\\u7075' }, { id:'zhixia', name:'\\u77e5\\u590f' }
        ]}];
    }
}class LocalProvider {
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
        try {
            const { serviceType, mimo, aliyun, local } = options;
            if (serviceType && this.providers[serviceType]) {
                this.serviceType = serviceType;
                this.activeProvider = this.providers[serviceType];
            }
            if (mimo) this.providers.mimo.init(mimo);
            if (aliyun) this.providers.aliyun.init(aliyun);
            if (local) this.providers.local.init(local);
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
