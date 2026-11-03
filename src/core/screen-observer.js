/**
 * screen-observer.js — 常驻屏幕观察会话：start / watch / peek / stop（主进程侧）。
 *
 * 移植自 dsh-see-now（src/runner.js，Apache-2.0，作者 SAOS-3624）。
 * 见项目根 THIRD-PARTY-NOTICES。
 *
 * 和 pipeline.js 的分工：pipeline 只管「帧进、图出」，不碰进程；这里管**进程生命周期**
 * 和**取图语义**（阻塞到有图 / 立刻要 / 保持温热）。
 *
 * ## 与上游 runner.js 的差异（为 Electron 宿主做的适配）
 *
 * 上游是 DSH 插件，`watch` 阻塞在工具调用里，还顺带管理 Tk 悬浮窗和聊天插话。
 * 本项目没有这些概念，所以：
 *
 * - **去掉**悬浮窗（`window.js`）、聊天轮询（`chat.js`）、插话（`interject.js`）
 *   —— 桌宠有自己的气泡和 ChatWindow，不需要另开窗口
 * - **去掉** `hungUp` / `endedSource` 那两个硬闸的 UI 起因，但保留等价语义：
 *   用户手动停止后不能被弹幕/游戏陪伴悄悄拉起来（对应 `_suppressAutoStart`）
 * - **保留** ①出图由采集侧攒 ②停采集留宽限期 ③取图永远走队列 这三条设计
 * - **新增** `waitForSheet()`：Electron 侧不阻塞工具调用，而是给渲染进程一个
 *   可 await 的取图 Promise（带超时与取消），语义等价于上游的阻塞 `watch`
 *
 * ## 三条刻意的设计（沿用上游）
 *
 * ① **出图由采集侧自己攒、自己截**，取图只是"取队列里那一张"。
 *    所以模型思考三秒不是延迟，只是让队列多一张。
 *
 * ② **停采集要留宽限期**。冷启动一次 400ms（屏幕）/ 1.7s（摄像头硬件唤醒），
 *    每次都要停掉的话，连续看就是每次重付这笔钱。所以看完留 `graceSec` 秒，
 *    期间再来取立刻就有帧；超时没人来才自己收工。
 *
 * ③ **取图永远走队列，不新建**。两张图同时在飞的时候，取的是最早那张
 *    （时间顺序不能乱），新图挤掉旧图由 pipeline 的 queueDepth 负责。
 */

'use strict';

const {
    spawnFrames, pickScreenEngine, screenEngineWarning, resetScreenEngineCache,
    resolveFfmpegPath,
} = require('./vision/capture');
const { createPipeline } = require('./vision/pipeline');
const { pngToDataUrl } = require('./vision/png');

/**
 * 四档清晰度。数字是画布像素，token 约等于按 patch 网格算出来的值
 * （800×450 ≈ 233 token；一张图塞 4 帧还是 8 帧价格一样 —— 所以"多留一帧"
 * 几乎免费，"漏掉一帧"才贵）。
 */
const SIZES = Object.freeze({
    low: [800, 450],
    standard: [1066, 600],
    high: [1280, 720],
    ultra: [1600, 900],
});
const DEFAULT_QUALITY = 'low';

/**
 * 「逐场景」模式的管线参数。
 *
 * - `maxFrames: 1` —— 留下 1 帧就立刻封箱，所以一张图永远只有一个画面
 * - `strategy: 'single'` —— 档位固定压到 1，让这一帧**铺满整张画布**
 *
 * 这两个必须成对出现：只改 maxFrames 会得到"小格子 + 大片留白"，
 * 只改 strategy 会得到"一张图里好几幅满幅图，装不下就被切开"。
 */
const SCENE_OPTS = Object.freeze({ maxFrames: 1, strategy: 'single' });

/**
 * 四档节奏。**只影响"多久算一次画面变了"和"多久唤一次"**，不改出图口径。
 *
 * | 档 | cutAbs | 唤醒间隔 | 适合 |
 * |---|---|---|---|
 * | calm | 20 | 30s | 日常挂着看，只想知道"大场面变了没" |
 * | normal | 12 | 15s | 默认。滚网页/切窗口不会每下都留帧 |
 * | dense | 7 | 8s | 幻灯片、逐帧播报 —— 贵，别常开 |
 * | action | 80 | 20s | 全屏游戏 / 高速运动，靠积分阈值一起抬高 |
 *
 * 7 是能给的最低值（再低只有"只改亮度"那种肉眼都看不出的变化），
 * 但它对日常屏幕太敏感 —— 光标一停、窗口一换都能过线，所以不做默认。
 *
 * 80 看着离谱，其实是被内容逼的：动作游戏里每帧都有大位移，正常切点淹没在运动里。
 * 这一档同时把积分阈值从 144 抬到 1440（`integralSeconds` 3 → 30）。
 */
const PACES = Object.freeze({
    calm: { cutAbs: 20, wakeGapSec: 30, pipeline: { floorGapK: 3, floorMin: 3, floorMax: 30 } },
    normal: { cutAbs: 12, wakeGapSec: 15, pipeline: { floorGapK: 2, floorMin: 2, floorMax: 20 } },
    dense: { cutAbs: 7, wakeGapSec: 8, pipeline: { floorGapK: 1.5, floorMin: 2, floorMax: 20 } },
    action: {
        cutAbs: 80,
        wakeGapSec: 20,
        pipeline: {
            integralSeconds: 30,
            maxFrames: 8,
            maxWaitSec: 60,
            silentFloorSec: 40,
            cutSpike: 1.5,
            cutSpikeAbs: 30,
            floorGapK: 2,
            floorMin: 2,
            floorMax: 20,
        },
    },
});
const DEFAULT_PACE = 'normal';

/** 参数签名：key 排序后拼串，`{a:1,b:2}` 与 `{b:2,a:1}` 视为同一个。 */
function optsSig(o) {
    return Object.keys(o ?? {}).sort().map((k) => `${k}=${JSON.stringify(o[k])}`).join('|');
}

/**
 * 决定"这根管线的出图口径"的签名。
 *
 * 必须**同时**剔除 `oneShot` 和 `fps`：
 *  - `oneShot` 是每次取图的临时开关（换清晰度时才 true），不是管线口径；
 *    把它算进签名会让"换清晰度那一次"和之后每一次都签名不符。
 *  - `fps` 在 `start()` 里已被折进 `pipeline.constants`，不参与"模式是否变了"。
 *
 * **两边必须用同一个函数**。早先 `start()` 用 `delete runOpts.fps` 而 `watch()`
 * 用 `{...opts, fps: undefined}`，于是签名永远不相等 —— 每一次取图都判成"换模式"
 * 而重启采集：白付 400ms 冷启动，还把刚攒的帧全丢掉。真机跑第二次取图就能看见。
 */
function pipelineSig(o) {
    const c = { ...(o || {}) };
    delete c.oneShot;
    delete c.fps;
    return optsSig(c);
}

/**
 * 「这一条取图该不该被硬闸拦下」的**纯函数**（好测，也好读）。
 *
 * 用户主动停过硬闸 → 除非显式指定来源（弹幕/用户明确要求），否则不自动重开。
 */
function guardReason({ suppressed = false, fileEnded = false, explicitSrc = false } = {}) {
    if (explicitSrc) return null;
    if (suppressed) return 'suppressed';
    if (fileEnded) return 'file-ended';
    return null;
}

/**
 * @param {{ffmpegPath?:string, log?:Function, graceSec?:number, userDataPath?:string}} cfg
 */
function createScreenObserver({ ffmpegPath = null, log = () => {}, graceSec = 60, userDataPath = null } = {}) {
    let pipeline = null;   // 当前（或刚停的）引擎 —— 停采集后仍留着，好把队列里剩的图发完
    let running = false;
    let run = null;
    let source = null;
    let startedAt = 0;
    let frames = 0;
    let lastError = null;
    let stoppedAt = 0;
    let graceTimer = null;
    let busy = false;
    let quality = DEFAULT_QUALITY;

    /**
     * 建当前管线时用的**调用方参数**（不含 oneShot）。
     *
     * 分辨率换了可以看 `quality`，但"逐场景模式"换的是管线参数
     * （`maxFrames` / `strategy`）—— 那些是建管线时定死的，运行中改不了。
     * 于是取图每次比一下签名，变了就重开。
     */
    let runOpts = {};

    /** 用户主动停止过（等价于上游的 hungUp 硬闸） */
    let suppressed = false;
    /** 最近一次的采集源（teardown 会清空 `source`，但事后判断还需要它） */
    let lastSource = null;
    /** 已经放完的文件源。**文件回放是一次性的**：放完就结束，不能自动重播。 */
    let endedSource = null;

    /** 正在等图的 Promise 的唤醒器（有新图立即通知，不靠轮询） */
    let waiters = new Set();

    const ff = ffmpegPath || resolveFfmpegPath();

    function notify() {
        for (const w of waiters) {
            try { w(); } catch { /* ignore */ }
        }
    }

    function teardown(why) {
        if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
        run?.stop();
        run = null;
        running = false;
        source = null;
        stoppedAt = Date.now();
        if (why) log(`[Vision] 收工：${why}`);
    }

    /** 停采集，但留一个宽限期 —— 这期间再来取图不用重新热启动 */
    function armGrace() {
        if (graceTimer) clearTimeout(graceTimer);
        if (graceSec <= 0) { teardown('grace=0'); return; }
        graceTimer = setTimeout(() => teardown(`${graceSec}s 没人来`), graceSec * 1000);
        if (graceTimer.unref) graceTimer.unref();
    }

    /**
     * 续命。
     *
     * **不加这个，常驻挂机会被宽限期饿死**：一次取图结束后留 60 秒宽限，
     * 时间一到采集收工，而静止屏幕上 60 秒内又不会出新图 —— 下一次检查看到
     * `!running && !pending` 就判定"采集自己停了"。用户安安静静看文档时，
     * 这个"常驻"最多活 60 秒。
     *
     * 只续"还在跑"的采集：ffmpeg 真死了不能靠它诈尸。
     */
    function touch() {
        if (!running) return false;
        armGrace();
        return true;
    }

    async function start({ src = { kind: 'screen' }, opts = {}, quality: q = null } = {}) {
        if (running) return { already: true, source };
        // 走到这里就是"明确要开始看"（取图的自动重启已经在前面被硬闸挡住了）。
        suppressed = false;
        endedSource = null;
        let engine = src.engine ?? 'auto';
        if (src.kind === 'screen' && engine === 'auto') engine = await pickScreenEngine({ ffmpegPath: ff });
        const size = SIZES[q] ?? SIZES[DEFAULT_QUALITY];
        // `oneShot` 由调用方决定：**只有换清晰度**时置 true
        // （缓冲区刚扔，等攒满等于白等一个窗口）
        const p = createPipeline({ ...opts, width: size[0], height: size[1], fps: opts.fps ?? 12 });
        // 记下"这次建管线用的调用方参数"（原样保存，比较时统一走 pipelineSig）
        runOpts = { ...opts };
        const s = { ...src, engine };
        quality = q ?? DEFAULT_QUALITY;
        frames = 0;
        lastError = null;
        pipeline = p;
        running = true;
        source = s;
        lastSource = s;
        startedAt = Date.now();
        run = spawnFrames({
            source: s,
            width: p.constants.width,
            height: p.constants.height,
            fps: p.constants.fps,
            ffmpegPath: ff,
            engine,
            onFrame: (f) => {
                frames += 1;
                // 一帧解码就抛 = 整条管线停摆，这里必须兜住：宁可少一帧，不能让采集线程炸掉
                try {
                    p.push(f);
                    // 新图落格就立刻通知等在 Promise 上的人
                    if (p.pending > 0) notify();
                } catch (e) {
                    lastError = `push: ${e?.message ?? e}`;
                }
            },
            onStderr: (s2) => { if (process.env.DSH_SEE_NOW_DEBUG) log(s2.trim()); },
        });
        run.done.then((r) => {
            if (pipeline === p) {
                lastError ??= r.frames ? null : `ffmpeg 退出（0 帧）`;
                // 文件源放完 = 这一次看完了。记下来，别让下一次取图又从头放一遍。
                if (s.kind === 'file') endedSource = s;
                teardown('ffmpeg-exit');
            }
        }).catch((e) => {
            lastError = `ffmpeg: ${e?.message ?? e}`;
            if (pipeline === p) teardown('ffmpeg-error');
            notify();
        });
        log(`[Vision] 开始看 ${s.kind}${engine && engine !== 'auto' ? `/${engine}` : ''} @${size[0]}×${size[1]}`);
        // macOS 没给屏幕录制权限时，采集本身是"成功"的，只是画面全黑 ——
        // 探针已经试出来了，这里把它带回去，让调用方知道该去系统设置。
        const warning = s.kind === 'screen' ? screenEngineWarning() : null;
        if (warning) log(`[Vision] ⚠️ ${warning}`);
        return { started: true, source: s, engine, quality, params: p.constants, warning };
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    /**
     * 取一张图 —— 这是给渲染进程用的核心接口。
     *
     * 语义等价于上游的阻塞 `watch`，但用 Promise 实现（Electron 里不能阻塞主进程）。
     * 返回前会处理：硬闸 → 必要时启动/重启采集 → 冷启动 eager → 等待 → 截断。
     *
     * @param {{seconds?:number, minFrames?:number, src?:object, quality?:string, opts?:object,
     *          eagerMs?:number, signal?:{aborted:boolean}|null}} o
     * @returns {Promise<{ok:boolean, reason?:string, sheet?:object, waited:number}>}
     */
    async function watch({
        seconds = 300, minFrames = 1, src = null, quality: q = null, opts = {},
        eagerMs = 3000,
        signal = null,
    } = {}) {
        /**
         * 两个"不许自动重开"的硬闸（来自上游的社区实报）：
         * 关过窗的用户体感是"我刚关掉它又弹出来了，只能卸载插件"。
         * 所以：只有**显式传了来源**才允许清闸重开。
         */
        const explicitSrc = Boolean(src && src.kind);
        const blocked = guardReason({ suppressed, fileEnded: Boolean(endedSource), explicitSrc });
        if (blocked === 'suppressed') return { ok: false, reason: 'suppressed', waited: 0 };
        if (blocked === 'file-ended') {
            return { ok: false, reason: 'file-ended', waited: 0, path: endedSource?.path };
        }
        if (explicitSrc) { suppressed = false; endedSource = null; }

        if (busy) return { ok: false, reason: 'busy', waited: 0 };
        busy = true;
        const t0 = Date.now();
        try {
            const prevSrc = source ?? lastSource;
            const switching = Boolean(pipeline) && q && SIZES[q] && q !== quality;
            // 管线参数变了（常规 ↔ 逐场景）：两套口径建管线时就定死了，只能重开
            const modeChanged = Boolean(pipeline) && pipelineSig(runOpts) !== pipelineSig(opts);
            /**
             * **要不要重开采集**：`pipeline` 不为空**不等于**采集还在跑。
             *
             * `teardown()` 故意留着 `pipeline`（好把队列里剩下的图发完），于是宽限期
             * 到点之后 `pipeline` 还在但 `running` 已经是 false —— 只看 `!pipeline`
             * 就会"跳过启动、直接等一张永远不会来的图"，等到封顶才回一句"没看成"。
             */
            const stopped = Boolean(pipeline) && !running;
            const cold = !pipeline || stopped;
            if (!pipeline || stopped || switching || modeChanged) {
                if (pipeline) {
                    teardown(stopped ? '采集已停，重开'
                        : switching ? `换清晰度 ${quality} → ${q}` : '换模式（逐场景 / 常规）');
                }
                if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
                await start({
                    src: src ?? prevSrc ?? { kind: 'screen' },
                    // 只有**换清晰度**才 oneShot：那一下缓冲区刚被扔掉，等攒满等于白等一整个窗口。
                    // 普通的第一次取图不 oneShot —— 调用方要的是"这 20 秒"，不是"此刻"。
                    opts: { ...opts, oneShot: switching },
                    quality: q,
                });
            } else if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }

            const deadline = t0 + Math.max(2, seconds) * 1000;

            /**
             * **冷启动先给此刻**。
             *
             * 静止屏幕上第一张要等 30~60 秒（兜底帧 20 秒一个，攒 3 帧才封箱）——
             * 用户说"看看我屏幕"，等一分钟才回话，体感就是"它没反应"。
             * 所以冷启动时第一帧到手就发，多花一张图，换"1 秒内给反应"。
             * 只在冷启动生效：管温着的时候再 eager，就退化成"每帧一张图"了。
             */
            if (cold && minFrames <= 1 && eagerMs > 0) {
                const eagerUntil = Date.now() + eagerMs;
                while (Date.now() < eagerUntil && !signal?.aborted) {
                    if (pipeline?.hasFrame) {
                        const first = pipeline.flushNow(null, 'first');
                        if (first) {
                            return {
                                ok: true, sheet: first, waited: (Date.now() - t0) / 1000,
                                quality, first: true,
                            };
                        }
                    }
                    await sleep(60);
                }
            }

            // 正常等待：队列有图就取，否则等 notify（或轮询兜底）
            while (Date.now() < deadline) {
                if (signal?.aborted) {
                    return { ok: false, reason: 'cancelled', waited: (Date.now() - t0) / 1000 };
                }
                const s = pipeline?.take();
                if (s) {
                    // **正常返回也要过 minFrames**：否则 `minFrames: 5` 在队列先到的
                    // 路径上会被无视，照样交一张 1 帧的图。
                    if (s.frames.length >= minFrames) {
                        return { ok: true, sheet: s, waited: (Date.now() - t0) / 1000, quality };
                    }
                }
                if (!running && !pipeline?.pending) break;   // 采集停了，队列也空了
                // 等到"有新图"或被 120ms 超时叫醒 —— 两条路都要走，因为
                // notify 只在落格时触发，而 deadline 也要能到点。
                await Promise.race([
                    new Promise((r) => { waiters.add(r); setTimeout(() => { waiters.delete(r); r(); }, 120); }),
                    sleep(120),
                ]);
            }

            // 到点了：手上攒的半张也算数（调用方已经在等），但不够 minFrames 就不给
            const last = pipeline?.flushNow(null, 'timeout');
            if (last && last.frames.length >= minFrames) {
                return { ok: true, sheet: last, waited: (Date.now() - t0) / 1000, partial: true, quality };
            }
            return {
                ok: false,
                reason: signal?.aborted ? 'cancelled' : (frames ? 'no-change' : 'capture-stopped'),
                waited: (Date.now() - t0) / 1000,
                error: lastError,
            };
        } finally {
            busy = false;
            if (pipeline) armGrace();
        }
    }

    /**
     * 取走**已经拼好的那一张**（后台唤醒走这条）。
     *
     * 语义是 "grab the sheet that already piled up" —— 需要的就是那张攒好的图，
     * 不该再等、也不该换一张。
     *
     * **不能走 `flushNow()`**：那是"立刻要看"用的，会把队列清空、再把"此刻那一帧"
     * 塞成一张新图。结果是队列里攒好的多帧摘要被一张单帧替换掉
     * （上游复现：`queued [0,2,4]` → 调完 peek 变成 `[5.92]`、`pending 0`）。
     * 队列空就老实返回 null，想看"此刻"请走 `watch`。
     */
    function peek() {
        const queued = pipeline?.take() ?? null;
        if (running) armGrace();
        return queued;
    }

    /** 把 pipeline 的 sheet 转成渲染进程能直接吃的形态（data URL） */
    function toPayload(sheet) {
        if (!sheet) return null;
        return {
            dataUrl: pngToDataUrl(sheet.png),
            at: sheet.at,
            from: sheet.from,
            to: sheet.to,
            width: sheet.w,
            height: sheet.h,
            fill: sheet.fill,
            why: sheet.why,
            frames: sheet.frames,
            bytes: sheet.png.length,
        };
    }

    return {
        start,
        /** 用户主动停止：立硬闸，不许自动拉起（等价于上游 hangUp） */
        stop({ suppress = true } = {}) {
            if (suppress) suppressed = true;
            teardown('手动');
            notify();
            return { stopped: true, suppressed };
        },
        isSuppressed() { return suppressed; },
        endedFile() { return endedSource ? { ...endedSource } : null; },

        /** 取一张图并转成 payload（渲染进程用这条） */
        async grab(options = {}) {
            const res = await watch(options);
            if (!res.ok) return res;
            return { ...res, payload: toPayload(res.sheet), sheet: undefined };
        },

        /** 队列里已有的那张（不等待） */
        grabPeek() {
            return toPayload(peek());
        },

        touch,
        peek,
        toPayload,

        status() {
            return {
                running,
                source,
                lastSource,
                suppressed,
                endedFile: endedSource?.path ?? null,
                quality,
                size: SIZES[quality],
                frames,
                since: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
                lastError,
                idleSec: stoppedAt ? Math.round((Date.now() - stoppedAt) / 1000) : 0,
                stats: pipeline?.stats ?? null,
                pending: pipeline?.pending ?? 0,
                // 出图序号（单调递增）：后台唤醒靠它保证"同一张图只叫醒一次"
                sheets: pipeline?.stats?.sheets ?? 0,
                secondsSinceWake: pipeline?.secondsSinceWake ?? null,
                ffmpeg: ff,
            };
        },

        /** 清掉引擎缓存（换机 / 排查时用） */
        resetEngineCache: resetScreenEngineCache,
        /** 释放 */
        dispose() {
            if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
            teardown('dispose');
            pipeline = null;
            waiters.clear();
        },
    };
}

module.exports = {
    SIZES,
    DEFAULT_QUALITY,
    SCENE_OPTS,
    PACES,
    DEFAULT_PACE,
    guardReason,
    optsSig,
    pipelineSig,
    createScreenObserver,
};
