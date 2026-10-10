/**
 * DefaultAudioIPC — Generate and load pre-synthesized audio clips.
 * Extracted from main.js lines 1275-1332.
 */
function registerDefaultAudioIPC(ctx, ipcMain, deps) {
    // deps: { app, fs, path, configManager }
    const { app, fs, path, configManager } = deps;

    // Two concurrent runs would interleave the styleId save/restore below and
    // leave the service on whichever value the other run happened to set.
    let generating = false;

    ipcMain.handle('generate-default-audio', async (event, phrases, styleId) => {
        try {
            if (!ctx.ttsService || !ctx.ttsService.isAvailable()) {
                return { success: false, error: 'TTS not available' };
            }
            if (!Array.isArray(phrases) || phrases.length === 0) {
                return { success: false, error: 'no phrases' };
            }
            if (generating) return { success: false, error: 'already generating' };
            generating = true;

            const audioDir = path.join(app.getPath('userData'), 'default-audio');
            if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

            const oldStyleId = ctx.ttsService.styleId;
            const synthesized = [];
            const results = [];
            try {
                if (styleId !== undefined) ctx.ttsService.styleId = styleId;
                for (let i = 0; i < phrases.length; i++) {
                    try {
                        const wavBuf = ctx.ttsService.synthesize(phrases[i]);
                        if (wavBuf) {
                            synthesized.push({ index: i, buf: wavBuf });
                            results.push({ phrase: phrases[i], file: `default_${i}.wav`, success: true });
                        } else {
                            results.push({ phrase: phrases[i], success: false });
                        }
                    } catch (e) {
                        results.push({ phrase: phrases[i], success: false, error: e.message });
                    }
                }
            } finally {
                // Restore even if synthesis throws: the old code only restored on
                // the happy path, so one failure left styleId stuck on whatever
                // this call was asked to use.
                ctx.ttsService.styleId = oldStyleId;
            }

            // Only touch the existing clips once there is something to replace them
            // with. The old code wiped the directory first, so a TTS backend that
            // was down destroyed the user's entire default-audio set and had
            // nothing to put back.
            if (synthesized.length === 0) {
                return { success: false, error: 'synthesis failed', results };
            }
            for (const f of fs.readdirSync(audioDir)) {
                if (f.endsWith('.wav')) fs.unlinkSync(path.join(audioDir, f));
            }
            for (const item of synthesized) {
                fs.writeFileSync(path.join(audioDir, `default_${item.index}.wav`), item.buf);
            }
            await configManager.saveConfigFile({ tts: { defaultPhrases: phrases } });
            return { success: true, results };
        } catch (error) {
            return { success: false, error: error.message };
        } finally {
            generating = false;
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
