/**
 * vision-client.js — 渲染进程侧的识屏客户端（运行在桌宠/聊天窗里）。
 *
 * 它把主进程 vision-ipc 的能力包成"给 AI 用的画面素材"，语义上和旧的
 * `getScreenCaptureHQ()` 一一对应，但带三件旧接口做不到的事：
 *
 * ① **多帧**：一次给 4~8 帧拼好的图，而不是孤零零一张；
 * ② **只给变化过的**：静止屏幕不出图，省 token；
 * ③ **知道时间跨度**：附带每帧的时刻，模型能说"刚才/这一会儿"而不是"现在"。
 *
 * 旧接口 `getScreenCaptureHQ` 保留不动 —— 它是"就要此刻这一张"的正确工具
 * （比如用户主动问"我屏幕上是什么"），两者互补而不是替代。
 *
 * 依赖：window.electronAPI.vision*
 */

'use strict';

(function (root) {
    /**
     * @param {{electronAPI?:object}} deps
     */
    function createVisionClient(deps = {}) {
        const api = deps.electronAPI || (root.electronAPI || null);

        /** @type {{enabled:boolean, quality:string, pace:string, scene:boolean}} */
        let settings = { enabled: true, quality: 'low', pace: 'normal', scene: false };
        let lastPayload = null;
        let lastAt = 0;
        let statusCache = null;

        function available() {
            return !!(api && api.visionGrab);
        }

        async function refreshSettings() {
            if (!available()) return settings;
            try {
                const st = await api.visionStatus();
                statusCache = st;
                if (st && st.settings) settings = { ...settings, ...st.settings };
            } catch { /* 主进程还没准备好 */ }
            return settings;
        }

        function getSettings() { return { ...settings }; }
        function getStatus() { return statusCache; }

        /**
         * 取一张"最近发生了什么"的拼图。
         *
         * @param {{seconds?:number, minFrames?:number, quality?:string, scene?:boolean}} o
         * @returns {Promise<{ok:boolean, dataUrl?:string, frames?:Array, from?:number, to?:number,
         *                    reason?:string, error?:string}|null>}
         */
        async function grab(o = {}) {
            if (!available() || !settings.enabled) return null;
            try {
                const res = await api.visionGrab({
                    seconds: o.seconds ?? 20,
                    minFrames: o.minFrames ?? 1,
                    quality: o.quality ?? settings.quality,
                    scene: o.scene ?? settings.scene,
                });
                if (!res || !res.ok || !res.payload) return { ok: false, reason: (res && res.reason) || 'no-sheet' };
                lastPayload = res.payload;
                lastAt = Date.now();
                return { ok: true, ...res.payload };
            } catch (e) {
                return { ok: false, reason: 'ipc-error', error: e.message };
            }
        }

        /** 立刻取队列里已经拼好的那张（不等待）。 */
        async function peek() {
            if (!available()) return null;
            try {
                const res = await api.visionPeek();
                return res && res.ok ? res.payload : null;
            } catch { return null; }
        }

        /** 拿"此刻"的一张（冷启动专用：立刻出图，不攒）。 */
        async function grabNow(o = {}) {
            return grab({ seconds: o.seconds ?? 5, minFrames: 1, scene: true, ...o });
        }

        /** 订阅后台推送的新图（常驻挂机模式）。 */
        function onSheet(cb) {
            if (!api || !api.onVisionSheet) return () => {};
            api.onVisionSheet((payload) => { try { cb(payload); } catch { /* ignore */ } });
            return () => {};
        }

        async function startWatcher(o = {}) {
            if (!api || !api.visionWatchStart) return { success: false };
            try { return await api.visionWatchStart(o); } catch (e) { return { success: false, error: e.message }; }
        }

        async function stopWatcher() {
            if (!api || !api.visionWatchStop) return { success: false };
            try { return await api.visionWatchStop(); } catch (e) { return { success: false, error: e.message }; }
        }

        async function stop() {
            if (!api || !api.visionStop) return { success: false };
            try { return await api.visionStop({ suppress: true }); } catch (e) { return { success: false, error: e.message }; }
        }

        async function configure(patch) {
            if (!api || !api.visionConfig) return { success: false };
            try {
                const r = await api.visionConfig(patch);
                if (r && r.settings) settings = { ...settings, ...r.settings };
                return r;
            } catch (e) { return { success: false, error: e.message }; }
        }

        /**
         * 把一张 sheet 转成 OpenAI 兼容的 content 块（text + image）。
         *
         * 这是替换旧 `screenshots.forEach(s => push(image_url))` 的那一步：
         * 以前 N 张图 = N 个 image 块 = N 份固定开销；现在一张拼图 = 1 个块。
         */
        function toContentBlock(sheet, label = '') {
            if (!sheet || !sheet.dataUrl) return null;
            const span = sheet.frames && sheet.frames.length
                ? `${sheet.frames.length} 帧，${sheet.from.toFixed(1)}s–${sheet.to.toFixed(1)}s`
                : '1 帧';
            const lines = label ? [label] : [];
            lines.push(`[屏幕画面] ${span}，按时间顺序编号；未编号的是连续变化的采样点。`);
            if (sheet.frames && sheet.frames.length) {
                const list = sheet.frames
                    .map((f, i) => `${i + 1}: ${f.t.toFixed(1)}s`)
                    .join('  ');
                lines.push(`帧时刻：${list}`);
            }
            return [
                { type: 'text', text: lines.join('\n') },
                { type: 'image_url', image_url: { url: sheet.dataUrl } },
            ];
        }

        return {
            available,
            refreshSettings,
            getSettings,
            getStatus,
            grab,
            grabNow,
            peek,
            onSheet,
            startWatcher,
            stopWatcher,
            stop,
            configure,
            toContentBlock,
            get lastPayload() { return lastPayload; },
            get lastAt() { return lastAt; },
        };
    }

    root.VisionClient = { createVisionClient };
    if (typeof module !== 'undefined' && module.exports) module.exports = { createVisionClient };
})(typeof window !== 'undefined' ? window : globalThis);
