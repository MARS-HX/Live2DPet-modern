/**
 * PetSayIPC — 让宠物说出指定文案，并把口型开合度分发给宠物窗与 OBS 浏览器源。
 *
 * 两条通道：
 *   pet-say        —— 主进程合成语音 → 交给宠物窗播放（宠物窗自己用 lip-sync 驱动口型）。
 *                     这个 send 会被 obs-browser-ipc 的镜像自动转发给 OBS 浏览器源，
 *                     所以 OBS 里同一段音频会同样播放、同样有口型。
 *   set-mouth-level—— 给"在别的窗口里播音频"的场景用（比如 index.html 里放 AI 回复）：
 *                     播放方每帧上报开合度，这里转发给宠物窗（同样被镜像到 OBS）。
 *
 * 合成逻辑与 tts-synthesize 完全一致（同一套分句 + WAV 拼接），直接复用它的工具函数，
 * 不复制一份出来各自漂移。
 */
const { splitForTTS, concatWavBuffers } = require('./tts-ipc');

/** 一句"指定文案"的长度上限：太长会把整段音频塞进一次 IPC，还会让宠物说很久。 */
const MAX_SAY_CHARS = 500;

function registerPetSayIPC(ctx, ipcMain, deps = {}) {
    const logger = deps.logger || console;

    /** 把文本合成为一段 WAV（base64）。失败返回 null。 */
    async function synthesizeWav(text) {
        const chunks = splitForTTS(text);
        const wavBufs = [];
        for (const chunk of chunks) {
            if (!chunk) continue;
            // tts() 是应用里正常说话用的那条路径；个别后端只实现了 synthesize()
            const buf = typeof ctx.ttsService.tts === 'function'
                ? await ctx.ttsService.tts(chunk)
                : ctx.ttsService.synthesize(chunk);
            if (buf) wavBufs.push(buf);
        }
        if (!wavBufs.length) return null;
        return (wavBufs.length === 1 ? wavBufs[0] : concatWavBuffers(wavBufs)).toString('base64');
    }

    function petWindowAlive() {
        const win = ctx.petWindow;
        if (!win) return false;
        try {
            return typeof win.isDestroyed === 'function' ? !win.isDestroyed() : true;
        } catch (e) {
            return false;
        }
    }

    ipcMain.handle('pet-say', async (event, rawText, options = {}) => {
        try {
            const text = String(rawText === undefined || rawText === null ? '' : rawText).trim();
            if (!text) return { success: false, error: 'empty_text' };
            if (text.length > MAX_SAY_CHARS) {
                return { success: false, error: 'too_long', maxChars: MAX_SAY_CHARS };
            }
            if (!ctx.ttsService || (typeof ctx.ttsService.isAvailable === 'function' && !ctx.ttsService.isAvailable())) {
                return { success: false, error: 'tts_unavailable' };
            }
            if (!petWindowAlive()) return { success: false, error: 'no_pet_window' };

            const wav = await synthesizeWav(text);
            if (!wav) return { success: false, error: 'synthesis_failed' };

            // 再检查一次：合成可能是秒级的，期间窗口可能已经关了
            if (!petWindowAlive()) return { success: false, error: 'no_pet_window' };

            const payload = {
                text,
                wav,
                mime: 'audio/wav',
                audible: options.audible !== false,
                showBubble: options.showBubble !== false,
            };
            ctx.petWindow.webContents.send('pet-say', payload);
            logger.log?.(`[PetSay] → 宠物窗（${text.length} 字，${wav.length} 字节 base64）`);
            return { success: true, chars: text.length, bytes: wav.length };
        } catch (error) {
            return { success: false, error: (error && error.message) || 'pet_say_failed' };
        }
    });

    ipcMain.handle('pet-say-stop', async () => {
        try {
            if (petWindowAlive()) {
                ctx.petWindow.webContents.send('pet-say-stop');
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: (error && error.message) || 'pet_say_stop_failed' };
        }
    });

    ipcMain.handle('set-mouth-level', async (event, rawLevel) => {
        try {
            const v = Number(rawLevel);
            const level = Number.isFinite(v) ? (v < 0 ? 0 : (v > 1 ? 1 : v)) : 0;
            if (petWindowAlive()) {
                ctx.petWindow.webContents.send('mouth-level', level);
            }
            return { success: true, level };
        } catch (error) {
            return { success: false, error: (error && error.message) || 'mouth_level_failed' };
        }
    });
}

module.exports = { registerPetSayIPC, MAX_SAY_CHARS };
