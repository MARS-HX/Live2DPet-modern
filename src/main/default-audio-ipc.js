/**
 * DefaultAudioIPC — Generate and load pre-synthesized audio clips.
 * Extracted from main.js lines 1275-1332.
 */
function registerDefaultAudioIPC(ctx, ipcMain, deps) {
    // deps: { app, fs, path, configManager }
    const { app, fs, path, configManager } = deps;

    ipcMain.handle('generate-default-audio', async (event, phrases, styleId) => {
        try {
            if (!ctx.ttsService || !ctx.ttsService.isAvailable()) {
                return { success: false, error: 'TTS not available' };
            }
            const audioDir = path.join(app.getPath('userData'), 'default-audio');
            if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
            for (const f of fs.readdirSync(audioDir)) {
                if (f.endsWith('.wav')) fs.unlinkSync(path.join(audioDir, f));
            }
            const oldStyleId = ctx.ttsService.styleId;
            if (styleId !== undefined) ctx.ttsService.styleId = styleId;
            const results = [];
            for (let i = 0; i < phrases.length; i++) {
                try {
                    const wavBuf = ctx.ttsService.synthesize(phrases[i]);
                    if (wavBuf) {
                        const filePath = path.join(audioDir, `default_${i}.wav`);
                        fs.writeFileSync(filePath, wavBuf);
                        results.push({ phrase: phrases[i], file: `default_${i}.wav`, success: true });
                    } else {
                        results.push({ phrase: phrases[i], success: false });
                    }
                } catch (e) {
                    results.push({ phrase: phrases[i], success: false, error: e.message });
                }
            }
            ctx.ttsService.styleId = oldStyleId;
            await configManager.saveConfigFile({ tts: { defaultPhrases: phrases } });
            return { success: true, results };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('load-default-audio', async () => {
        try {
            const audioDir = path.join(app.getPath('userData'), 'default-audio');
            if (!fs.existsSync(audioDir)) return { success: true, files: [] };
            const files = fs.readdirSync(audioDir)
                .filter(f => f.endsWith('.wav'))
                .map(f => {
                    const data = fs.readFileSync(path.join(audioDir, f));
                    return { name: f, base64: data.toString('base64') };
                });
            return { success: true, files };
        } catch (error) {
            return { success: false, error: error.message, files: [] };
        }
    });
}

module.exports = { registerDefaultAudioIPC };
