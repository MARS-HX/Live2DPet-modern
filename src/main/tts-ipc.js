/**
 * TTS IPC — TTS synthesis using Mimo API only.
 * Removed VOICEVOX and translation, ensuring Chinese output.
 * Uses voicedesign model for optimal voice quality.
 */

/**
 * Split Chinese/Japanese text at sentence-ending punctuation for chunked TTS.
 * Keeps consecutive punctuation + decorative chars (……♡～) as a unit.
 */
function splitForTTS(text, maxLen = 80) {
    if (!text || text.length <= maxLen) return [text];
    const parts = [];
    let last = 0;
    // Works for both Chinese and Japanese
    const re = /[。！？]+[…♡♪～☆]*/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        parts.push(text.slice(last, m.index + m[0].length));
        last = m.index + m[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));

    // Merge short segments so each chunk is reasonably sized
    const chunks = [];
    let buf = '';
    for (const seg of parts) {
        if (buf.length + seg.length > maxLen && buf.length > 0) {
            chunks.push(buf);
            buf = '';
        }
        buf += seg;
    }
    if (buf) chunks.push(buf);
    return chunks;
}

/**
 * Concatenate multiple WAV buffers (same format) into one.
 * Strips headers, merges PCM data, writes new header.
 */
function concatWavBuffers(buffers) {
    if (buffers.length === 0) return null;
    if (buffers.length === 1) return buffers[0];

    const hdr = buffers[0];
    const numChannels = hdr.readUInt16LE(22);
    const sampleRate = hdr.readUInt32LE(24);
    const bitsPerSample = hdr.readUInt16LE(34);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const byteRate = sampleRate * blockAlign;

    const pcmParts = buffers.map(b => b.slice(44));
    const totalPcmLen = pcmParts.reduce((sum, p) => sum + p.length, 0);

    const out = Buffer.alloc(44 + totalPcmLen);
    out.write('RIFF', 0);
    out.writeUInt32LE(36 + totalPcmLen, 4);
    out.write('WAVE', 8);
    out.write('fmt ', 12);
    out.writeUInt32LE(16, 16);
    out.writeUInt16LE(1, 20);
    out.writeUInt16LE(numChannels, 22);
    out.writeUInt32LE(sampleRate, 24);
    out.writeUInt32LE(byteRate, 28);
    out.writeUInt16LE(blockAlign, 32);
    out.writeUInt16LE(bitsPerSample, 34);
    out.write('data', 36);
    out.writeUInt32LE(totalPcmLen, 40);

    let offset = 44;
    for (const pcm of pcmParts) {
        pcm.copy(out, offset);
        offset += pcm.length;
    }
    return out;
}

function registerTTSIPC(ctx, ipcMain, deps) {
    const { configManager, fs, path, app, mt } = deps;

    // Reinitialize TTS using Mimo (only backend)
    async function reinitTTS(ttsConfig) {
        if (ctx.ttsService) ctx.ttsService.destroy();
        // Force serviceType to 'mimo'
        const mimo = ttsConfig?.mimo || {};
        const mimoOptions = {
            serviceType: 'mimo',
            mimo: {
                baseURL: mimo.baseURL || 'https://api.xiaomimimo.com/v1',
                apiKey: mimo.apiKey || '',
                voice: mimo.voice || 'Chloe',
                model: mimo.model || 'mimo-v2.5-tts-voicedesign',  // 使用 voicedesign 模型
                format: mimo.format || 'wav',
                speed: mimo.speed ?? 1.0,
                pitch: mimo.pitch ?? 1.0,
                stylePrompt: mimo.stylePrompt || '小女孩、活泼、开朗、充满好奇心'
            }
        };
        const initSuccess = ctx.ttsService.init(mimoOptions);
        if (initSuccess && mimo) {
            ctx.ttsService.setConfig({ mimo });
        }
        return initSuccess;
    }

    // ========== IPC Handlers ==========

    // TTS synthesis (direct Chinese -> speech, no translation)
    ipcMain.handle('tts-synthesize', async (event, text) => {
        try {
            if (!ctx.ttsService || !ctx.ttsService.isAvailable()) {
                return { success: false, error: 'TTS not available' };
            }
            // Use the original text (Chinese) directly
            console.log(`[TTS] Synthesizing: ${text}`);

            const chunks = splitForTTS(text);
            const rss0 = Math.round(process.memoryUsage().rss / 1024 / 1024);

            const wavBufs = [];
            for (const chunk of chunks) {
                const buf = await ctx.ttsService.tts(chunk);
                if (buf) wavBufs.push(buf);
            }
            if (wavBufs.length === 0) return { success: false, error: 'synthesis failed' };

            const combined = concatWavBuffers(wavBufs);
            const rss1 = Math.round(process.memoryUsage().rss / 1024 / 1024);
            console.log(`[TTS] ${chunks.length} chunk(s), RSS: ${rss0}→${rss1} MB`);

            return { success: true, wav: combined.toString('base64'), jaText: text };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('tts-get-status', async () => {
        const svc = ctx.ttsService;
        return {
            initialized: svc?.initialized || false,
            available: svc?.isAvailable ? svc.isAvailable() : false,
            degraded: svc?.degraded || false,
            degradedAt: svc?.degradedAt || 0,
            retryInterval: svc?.retryInterval || 60000,
            serviceType: 'mimo',
            translationConfigured: false   // translation is removed
        };
    });

    ipcMain.handle('tts-reinit', async (event, ttsConfig) => {
        try {
            const ok = await reinitTTS(ttsConfig);
            return { success: ok, error: ok ? undefined : 'reinit failed' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('tts-restart', async () => {
        try {
            const config = await configManager.loadConfigFile();
            const ttsConfig = config.tts || {};
            const ok = await reinitTTS(ttsConfig);
            return { success: ok, error: ok ? undefined : 'restart failed' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('app-relaunch', async () => {
        if (app.isPackaged) {
            const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
            app.relaunch({ execPath: exePath, args: [] });
        } else {
            app.relaunch();
        }
        app.exit(0);
    });

    // TTS metadata (only Mimo voices)
    ipcMain.handle('tts-get-metas', async () => {
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
    });

    ipcMain.handle('tts-set-config', async (event, config) => {
        if (ctx.ttsService && config) {
            ctx.ttsService.setConfig(config);
            const fullConfig = await configManager.loadConfigFile();
            fullConfig.tts = { ...fullConfig.tts, ...config };
            // Ensure serviceType is always 'mimo'
            fullConfig.tts.serviceType = 'mimo';
            await configManager.saveConfigFile(fullConfig);
        }
        return { success: true };
    });

    // Optional: add a dummy handler for methods that might be called from frontend
    ipcMain.handle('tts-get-available-vvms', async () => []);
    ipcMain.handle('download-vvm', async () => ({ success: false, error: 'Not supported' }));
    ipcMain.handle('setup-voicevox', async () => ({ success: false, error: 'VOICEVOX is removed' }));
}

module.exports = { registerTTSIPC };