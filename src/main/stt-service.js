// src/main/stt-service.js
const vosk = require('vosk');
const { Readable } = require('stream');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

class LocalSTT extends EventEmitter {
    constructor(modelPath) {
        super();
        this.modelPath = modelPath;
        this.rec = null;
        this.isListening = false;
        this.audioStream = null;
    }

    async init() {
        if (!fs.existsSync(this.modelPath)) {
            throw new Error(`Vosk model not found at ${this.modelPath}`);
        }
        vosk.setLogLevel(-1); // 减少日志噪音
        this.model = new vosk.Model(this.modelPath);
        this.rec = new vosk.Recognizer({ model: this.model, sampleRate: 16000 });
        console.log('[LocalSTT] Initialized with model:', this.modelPath);
        return true;
    }

    // 从麦克风流处理音频 (16kHz, 16bit PCM)
    feedAudioChunk(chunk) {
        if (!this.isListening || !this.rec) return;
        if (this.rec.acceptWaveform(chunk)) {
            const result = this.rec.result();
            if (result.text) {
                this.emit('result', result.text);
            }
        }
    }

    start() {
        if (!this.rec) throw new Error('STT not initialized');
        this.isListening = true;
        this.emit('status', 'listening');
    }

    stop() {
        this.isListening = false;
        if (this.rec) {
            const partial = this.rec.partialResult();
            if (partial.partial) {
                this.emit('partial', partial.partial);
            }
        }
        this.emit('status', 'stopped');
    }

    // 可选：释放模型
    destroy() {
        if (this.rec) this.rec.free();
        if (this.model) this.model.free();
    }
}

module.exports = { LocalSTT };