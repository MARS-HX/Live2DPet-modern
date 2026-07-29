/**
 * Local STT - 本地语音识别
 * 优先使用 Web Speech API（内置在 Electron/Chromium 中）
 * 备用使用 @kutalia/whisper-node-addon（需模型文件）
 */

let whisperAddon = null;
try {
    whisperAddon = require('@kutalia/whisper-node-addon');
} catch (e) {
    // whisper not available
}

class LocalSTT {
    constructor() {
        this.initialized = false;
        this.backend = 'webspeech'; // 'webspeech' | 'whisper'
        this.whisperModelPath = '';
        this.whisperAvailable = !!whisperAddon;
    }

    /**
     * 初始化
     * @param {object} options - { modelPath: '.../ggml-tiny.bin' }
     */
    init(options = {}) {
        if (options.modelPath) {
            this.whisperModelPath = options.modelPath;
            const fs = require('fs');
            if (this.whisperAvailable && fs.existsSync(options.modelPath)) {
                this.backend = 'whisper';
                console.log('[LocalSTT] Using whisper backend');
            }
        }
        this.initialized = true;
        console.log('[LocalSTT] Initialized with backend:', this.backend);
        return true;
    }

    /**
     * 语音识别
     * @param {Buffer} audioBuffer - WAV 音频数据 (16kHz, mono, 16-bit)
     * @returns {Promise<string>}
     */
    async transcribe(audioBuffer) {
        if (this.backend === 'whisper' && this.whisperAvailable) {
            return this._transcribeWhisper(audioBuffer);
        }
        // 如果 whisper 不可用，返回空让前端走 Web Speech API
        return '';
    }

    /**
     * Whisper 本地识别
     */
    async _transcribeWhisper(audioBuffer) {
        try {
            // 将 WAV Buffer 转为 Float32 PCM
            const pcmData = this._wavToFloat32(audioBuffer);
            if (!pcmData || pcmData.length === 0) return '';
            
            const result = await whisperAddon.transcribe({
                model: this.whisperModelPath,
                pcmf32: [Array.from(pcmData)],
                language: 'zh',
                use_gpu: false,
                no_prints: true
            });
            
            if (result && result.text) {
                return result.text.trim();
            }
            return '';
        } catch (e) {
            console.error('[LocalSTT] Whisper error:', e.message);
            return '';
        }
    }

    /**
     * WAV Buffer → Float32Array
     */
    _wavToFloat32(wavBuffer) {
        try {
            // WAV header is 44 bytes, PCM data starts at 44
            const numChannels = wavBuffer.readUInt16LE(22);
            const bitsPerSample = wavBuffer.readUInt16LE(34);
            const dataOffset = 44; // simple WAV, no extra chunks
            const dataLength = wavBuffer.length - dataOffset;
            
            let samples;
            if (bitsPerSample === 16) {
                const sampleCount = Math.floor(dataLength / 2 / numChannels);
                samples = new Float32Array(sampleCount);
                for (let i = 0; i < sampleCount; i++) {
                    let sample = wavBuffer.readInt16LE(dataOffset + i * 2 * numChannels);
                    samples[i] = sample / 32768.0;
                }
            } else if (bitsPerSample === 32) {
                const sampleCount = Math.floor(dataLength / 4 / numChannels);
                samples = new Float32Array(sampleCount);
                for (let i = 0; i < sampleCount; i++) {
                    samples[i] = wavBuffer.readFloatLE(dataOffset + i * 4 * numChannels);
                }
            } else {
                return null;
            }
            return samples;
        } catch (e) {
            console.error('[LocalSTT] Wav parse error:', e.message);
            return null;
        }
    }

    isAvailable() {
        return this.initialized;
    }

    getBackend() {
        return this.backend;
    }

    destroy() {
        this.initialized = false;
        console.log('[LocalSTT] Destroyed');
    }
}

module.exports = { LocalSTT };
