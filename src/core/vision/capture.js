/**
 * capture.js — 唯一 spawn ffmpeg 的地方。**一根 rawvideo 管道**。
 *
 * 移植自 dsh-see-now（src/capture.js，Apache-2.0，作者 SAOS-3624）。
 * 见项目根 THIRD-PARTY-NOTICES。
 *
 * ## 为什么不是「2 秒一片 + 回抓」
 *
 * 分片必须关闭文件才能 seek，光这一条就是 2 秒固定延迟；每抓一帧还要 spawn 一次
 * ffmpeg（实测 135ms）。实时场景要的是「帧到手就判、判完就留」，
 * 所以直接 `-f rawvideo` 吐 rgb24，帧在内存里，留帧零成本。
 *
 * ## 三种源的实测（Windows / 12fps → 800×450）
 *
 * | 源 | 首帧 | CPU | 备注 |
 * |---|---|---|---|
 * | `ddagrab`（桌面复制 API） | 370 ms | **0.28 核** | 走 GPU，屏幕的原生路子 |
 * | `gdigrab`（GDI 抓屏） | 310 ms | 0.45 核 | 每帧先从 GDI 拷整屏 BGRA 再缩 |
 * | `obs`（OBS 虚拟摄像头） | 575 ms | 0.13 核 | 设备侧已经缩好了，最省 |
 * | `camera`（USB 摄像头） | **1450 ms** | 0.14 核 | 首帧慢是**硬件唤醒**，参数救不了 |
 *
 * 结论：屏幕源**默认用 ddagrab**，跑不起来退回 gdigrab；设备源别停进程 ——
 * 首帧延迟只能靠常驻摊掉。
 *
 * ## 两条会伪装成"插件坏了"的坑
 *
 * ① **`-framerate` 在 avfoundation 屏幕源上不压速**。实测 `-frames:v 30` 只用
 *    0.73 秒（≈40fps），必须靠输出侧 `-r` 把速度压回来。少了这一条，管道会被
 *    帧灌满 —— 上游开发时真被灌出过 240GB / 几十分钟的 raw 文件。
 *    Windows 的 ddagrab/gdigrab 已经按 fps 抓了，再挂 `-r` 是白跑一趟。
 *
 * ② **没有屏幕录制权限时它不报错，只给你一片纯黑**。exit code 还是 0，
 *    帧数正常、字节数正常。所以探针除了看"有没有帧"，还要看"帧里有没有东西"。
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** 屏幕采集引擎。macOS 只有 avfoundation；Windows 走 ddagrab/gdigrab。 */
const ENGINES = Object.freeze(['auto', 'ddagrab', 'gdigrab', 'avfoundation']);

/** macOS 上屏幕设备的默认名字。`-list_devices` 里它永远是英文，相机才是本地化的。 */
const DEFAULT_SCREEN_DEVICE = 'Capture screen 0';

/**
 * 纯黑帧的提示语。macOS 不会告诉你"权限没给"，只会默默给黑屏 ——
 * 这句是唯一能把人从"插件坏了"领到"系统设置"的路标。
 */
const SCREEN_PERMISSION_HINT =
    'ffmpeg 没有「屏幕录制」权限：系统设置 → 隐私与安全性 → 屏幕录制，勾上跑本应用的那个 App（或终端），重启它再试。';

/** 源描述 → 输入参数。纯函数，可单测。 */
function sourceArgs(
    source = { kind: 'screen' },
    { engine = 'auto', fps = 12, platform = process.platform, pixelFormat = null } = {},
) {
    const s = source ?? {};
    const mac = platform === 'darwin';

    switch (s.kind) {
        case 'obs':
        case 'camera': {
            const fallback = s.kind === 'obs' ? 'OBS Virtual Camera' : 'HD Webcam';
            const device = s.device ?? fallback;
            if (mac) {
                // macOS 没有 dshow；两种情况都以设备身份出现在 avfoundation 里。
                // `-framerate` 在这里是**设备侧采样率**，必须给。
                return ['-f', 'avfoundation', '-framerate', String(fps), '-i', `${device}:none`];
            }
            return ['-rtbufsize', '256M', '-thread_queue_size', '512',
                '-f', 'dshow', '-i', `video=${device}`];
        }
        case 'screen': {
            if (mac || s.engine === 'avfoundation' || engine === 'avfoundation') {
                // ① 屏幕合成不走 GPU 路径，只能靠 AVFoundation 推流；
                // ② `-capture_cursor` 必须显式给（默认值随系统版本变，不能靠）；
                // ③ 音频写 `none`，否则某些系统会去开麦克风，触发额外权限弹窗；
                // ④ `-pixel_format` 不给就默认 yuv420p，而屏幕输入**不支持** yuv420p ——
                //    每进程刷一行 "not supported" 到 stderr。探针会挑一个设备真收的格式。
                const pf = s.pixelFormat ?? pixelFormat;
                return ['-f', 'avfoundation', '-framerate', String(fps),
                    ...(pf ? ['-pixel_format', pf] : []),
                    '-capture_cursor', s.mouse ? '1' : '0',
                    '-i', `${s.device ?? DEFAULT_SCREEN_DEVICE}:none`];
            }
            const useDda = s.engine === 'ddagrab' || (s.engine !== 'gdigrab' && engine !== 'gdigrab');
            if (!useDda) {
                // gdigrab 的 -framerate 是**设备侧**采样率，必须给，否则默认 29.97 白解码
                const region = s.region
                    ? ['-offset_x', String(s.region.x), '-offset_y', String(s.region.y),
                        '-video_size', `${s.region.w}x${s.region.h}`]
                    : [];
                return ['-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', '0', ...region,
                    '-i', s.desktop ?? 'desktop'];
            }
            // ddagrab 是 filter source，输入侧没有帧率参数
            return ['-f', 'lavfi', '-i', `ddagrab=framerate=${fps}:draw_mouse=${s.mouse ? 1 : 0}`];
        }
        case 'file':
            // `realtime` 才加 -re；离线跑要看的是「管线本身多快」，不能被播放速度骗了
            return [...(s.realtime ? ['-re'] : []), '-i', String(s.path)];
        default:
            throw new RangeError(`unknown source kind: ${s.kind}`);
    }
}

/** ddagrab 出来的帧还在 GPU 上，得先 hwdownload 再缩。 */
function isDda(source, engine, platform = process.platform) {
    if (source?.kind !== 'screen') return false;
    const e = source?.engine ?? engine;
    if (e === 'ddagrab') return true;
    // `auto` 在 Windows 上默认就是 ddagrab；macOS 上它不是候选，别给它套 hwdownload
    return e === 'auto' && platform !== 'darwin';
}

/**
 * 完整的采集命令。
 *
 * **`-r` 只在需要压速时才挂**：gdigrab/ddagrab 已经按 fps 抓了，再串一个 fps 滤镜
 * 是白跑一趟（实测 12fps 下省 3–5% CPU）。但 avfoundation 的屏幕源不认 `-framerate`
 * 当节流阀，必须靠输出侧 `-r` 压回来 —— 见文件头坑 ①。
 */
function captureArgs({
    source, width, height, fps, ffmpegPath = 'ffmpeg', engine = 'auto',
    fast = true, sws = 'area', platform = process.platform, pixelFormat = null,
} = {}) {
    const args = [ffmpegPath, '-hide_banner', '-v', 'error', '-nostdin'];
    const engineUsed = source?.engine ?? engine;
    if (fast) {
        // `-fflags nobuffer` 只对**直播式**输入有意义，而且它会把 `-re` 的文件回放
        // 直接堵死（实测：加上它、配上 -re，4 秒一个字节都不出）。
        if (source?.kind !== 'file') args.push('-fflags', 'nobuffer');
        args.push('-flags', 'low_delay');
        if (source?.kind === 'obs' || source?.kind === 'camera') {
            args.push('-probesize', '32', '-analyzeduration', '0');
        }
    }
    args.push(...sourceArgs(source, {
        engine, fps, platform,
        pixelFormat: source?.pixelFormat !== undefined
            ? source.pixelFormat
            : (platform === 'darwin' && source?.kind === 'screen' ? (pixelFormat ?? cachedFormat) : null),
    }));
    args.push('-an', '-sn');

    const filters = [];
    if (isDda(source, engine, platform)) filters.push('hwdownload', 'format=bgra');
    // avfoundation 没有 gdigrab 那种 `-video_size` 局部抓取，裁剪只能在滤镜里做。
    // 坐标按**采集分辨率**算（Retina 上是逻辑分辨率的 2 倍），不做自动换算。
    if (source?.kind === 'screen' && (platform === 'darwin' || engineUsed === 'avfoundation') && source?.region) {
        const r = source.region;
        filters.push(`crop=${r.w}:${r.h}:${r.x}:${r.y}`);
    }
    filters.push(`scale=${width}:${height}:flags=${sws}`);
    args.push('-vf', filters.join(','));

    if (source?.kind !== 'screen' || (platform === 'darwin' || engineUsed === 'avfoundation')) {
        args.push('-r', String(fps));
    }
    args.push('-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');
    return args;
}

/**
 * 逐帧读，**同步回调**。回调里做的事会直接变成对 ffmpeg 的背压 —— 这是刻意的：
 * 判帧、留帧、重排都在回调里跑完，绝不让帧在内存里越堆越多。
 *
 * @returns {{stop:()=>void, done:Promise<{frames:number, ms:number, code:number|null}>}}
 */
function spawnFrames({
    source, width, height, fps, ffmpegPath = 'ffmpeg', engine = 'auto',
    onFrame, onStderr = null, onFirst = null,
} = {}) {
    const args = captureArgs({ source, width, height, fps, ffmpegPath, engine, platform: process.platform }).slice(1);
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const need = width * height * 3;
    let pending = null;
    let n = 0;
    const t0 = Date.now();
    let err = '';

    const done = new Promise((resolve, reject) => {
        child.stdout.on('data', (chunk) => {
            pending = pending?.length ? Buffer.concat([pending, chunk]) : chunk;
            while (pending.length >= need) {
                const buf = pending.subarray(0, need);
                pending = pending.subarray(need);
                const i = n;
                n += 1;
                if (i === 0) onFirst?.(Date.now() - t0);
                onFrame?.({ i, t: i / fps, buf });
            }
            if (pending.length === 0) pending = null;
        });
        child.stderr.on('data', (d) => {
            err = `${err}${d}`.slice(-4000);
            onStderr?.(String(d));
        });
        child.on('error', reject);
        child.on('close', (code) => {
            // `code === null` = 被我们自己 kill 的（stop / 换清晰度 / 收工）。
            // 那是正常收尾，不是失败 —— 否则每次 stop 都往 lastError 里写一条假错误。
            if (code !== 0 && code !== null && err.trim()) {
                reject(new Error(`ffmpeg exit ${code}: ${err.trim().slice(-300)}`));
                return;
            }
            resolve({ frames: n, ms: Date.now() - t0, code });
        });
    });

    return {
        done,
        stop() {
            try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
        },
    };
}

/* ---------------------------------------------------------------- 引擎探测 */

/**
 * 屏幕源用哪个引擎 —— **测一次、整个进程记住**。
 *
 * 为什么需要探测（Windows）：`ddagrab` 走桌面复制 API，独占全屏的游戏 / 部分远程
 * 桌面会把它挡住（报 "Selected output not supported" 或者干脆不吐帧）。
 * **本机实测就是这种情况**：ddagrab 直接失败、gdigrab 正常。
 * 那种情况下不能哑着 —— 退到 gdigrab 只是多花 0.17 核，画面照样能看。
 *
 * 代价是进程里第一次开屏幕要多 spawn 一次 ffmpeg（~400ms）。所以结果缓存，
 * 之后每次 start 都是 0 成本；本机这两种引擎的可用性不会在一次会话里变。
 *
 * macOS 没有备选引擎，但探针**仍然要跑**：它顺带替我们回答"屏幕录制权限给了没"。
 * 没权限的时候 ffmpeg 照样 exit 0、照样吐帧，只是全黑 —— 只有看平均像素才知道。
 */
let cachedEngine = null;
let cachedFormat = null;            // macOS 屏幕像素格式：'' = 用设备默认
let screenWarning = null;

function resetScreenEngineCache() {
    cachedEngine = null;
    cachedFormat = null;
    screenWarning = null;
}

/** 上一次探测留下的警告（目前只有"没有屏幕录制权限"这一类）。 */
function screenEngineWarning() {
    return screenWarning;
}

/** 抽样求均值就够了，不用全量遍历。 */
function meanOf(buf) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < buf.length; i += 97) {
        sum += buf[i];
        n += 1;
    }
    return n ? sum / n : 0;
}

/**
 * 找 ffmpeg 可执行文件。
 *
 * 打包后的 Electron 应用**没有 PATH 保证**：用户装了 ffmpeg 不等于 GUI 进程能看见
 * （Windows 上 PATH 是登录时快照下来的）。所以按固定顺序自己找，找到就用绝对路径。
 */
function resolveFfmpegPath(env = process.env, deps = {}) {
    const fsMod = deps.fs || fs;
    const pathMod = deps.path || path;
    const isWin = (deps.platform || process.platform) === 'win32';
    const exe = isWin ? 'ffmpeg.exe' : 'ffmpeg';
    const candidates = [];

    // 1) 显式指定（设置里的路径）
    if (env.DSH_FFMPEG_PATH) candidates.push(env.DSH_FFMPEG_PATH);
    if (env.FFMPEG_PATH) candidates.push(env.FFMPEG_PATH);
    // 2) 目录形式
    if (env.DSH_FFMPEG_DIR) candidates.push(pathMod.join(env.DSH_FFMPEG_DIR, exe));
    // 3) 应用自带的工具目录（userData/tools/ffmpeg/bin）
    if (deps.userDataPath) {
        candidates.push(pathMod.join(deps.userDataPath, 'tools', 'ffmpeg', 'bin', exe));
    }
    // 4) 常见安装位置
    if (isWin) {
        candidates.push('C:\\Program Files\\ffmpeg-master-latest-win64-gpl-shared\\bin\\ffmpeg.exe');
        candidates.push('C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe');
        candidates.push(pathMod.join(env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'));
    } else {
        candidates.push('/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg');
    }

    for (const c of candidates) {
        try { if (c && fsMod.existsSync(c)) return c; } catch { /* ignore */ }
    }
    // 5) 最后的希望：交给 PATH（裸命令名）
    return 'ffmpeg';
}

function pickScreenEngine({
    ffmpegPath = 'ffmpeg', fps = 12, timeoutMs = 2500, platform = process.platform,
} = {}) {
    if (cachedEngine) return Promise.resolve(cachedEngine);
    if (platform === 'darwin') return probeAvfoundation({ ffmpegPath, fps, timeoutMs });
    if (platform !== 'win32') {
        return Promise.reject(new RangeError(
            `屏幕采集还没接 ${platform}：Windows 走 ddagrab/gdigrab，macOS 走 avfoundation，`
            + 'Linux 需要 x11grab 或 PipeWire，还没做。',
        ));
    }
    return probeDdagrab({ ffmpegPath, fps, timeoutMs });
}

/**
 * macOS：探一次 avfoundation —— 一次回答三个问题。
 *
 * ① 能不能出帧（ffmpeg 在不在、设备名对不对）；
 * ② **哪个像素格式设备真收**（默认的 yuv420p 屏幕输入不支持，必须自己试）；
 * ③ 画面是不是全黑（= 系统没给「屏幕录制」权限，ffmpeg 自己不会报）。
 *
 * 顺序是**按实测 CPU 从省到费**排的。格式不对时 ffmpeg 会很快报错退出，
 * 所以串行试不会拖慢。
 */
async function probeAvfoundation({ ffmpegPath, fps, timeoutMs }) {
    const W = 64;                      // 探针只取 1 帧，尺寸越小越快
    const H = 36;
    const formats = ['nv12', 'uyvy422', 'bgr0', null];
    for (const pf of formats) {
        const shot = await grabOneFrame({ ffmpegPath, fps, width: W, height: H, pixelFormat: pf, timeoutMs });
        if (!shot.got) continue;
        cachedEngine = 'avfoundation';
        cachedFormat = pf ?? '';
        // 拿到帧但全是黑的 → 有采集会话、没画面，这就是 macOS 的"没权限"的样子。
        screenWarning = meanOf(shot.buf) < 1 ? SCREEN_PERMISSION_HINT : null;
        return 'avfoundation';
    }
    // 一帧都没拿到：启动层面的问题（ffmpeg 不在、设备名不对），留给 start 报错。
    cachedEngine = 'avfoundation';
    cachedFormat = '';
    screenWarning = null;
    return 'avfoundation';
}

/** 单帧探针。拿到满一帧就提前 resolve，不等 close。 */
function grabOneFrame({ ffmpegPath, fps, width, height, pixelFormat, timeoutMs }) {
    const args = captureArgs({
        source: { kind: 'screen', engine: 'avfoundation', pixelFormat: pixelFormat ?? '' },
        width, height, fps, ffmpegPath, engine: 'avfoundation', platform: 'darwin',
    }).slice(1);
    args.splice(args.length - 1, 0, '-frames:v', '1');
    const need = width * height * 3;

    return new Promise((resolve) => {
        const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        let buf = Buffer.alloc(0);
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
            resolve({ got: buf.length >= need, buf: buf.subarray(0, need) });
        };
        const timer = setTimeout(finish, timeoutMs);
        child.stdout.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            if (buf.length >= need) { clearTimeout(timer); finish(); }
        });
        child.on('error', () => { clearTimeout(timer); finish(); });
        child.on('close', () => { clearTimeout(timer); finish(); });
    });
}

/** Windows：探 ddagrab，不行退 gdigrab。 */
function probeDdagrab({ ffmpegPath, fps, timeoutMs }) {
    const W = 64;
    const H = 36;                     // 探针只取 1 帧，尺寸越小越快
    const args = captureArgs({
        source: { kind: 'screen', engine: 'ddagrab' }, width: W, height: H, fps, ffmpegPath,
        engine: 'ddagrab', platform: 'win32',
    }).slice(1);
    args.splice(args.length - 1, 0, '-frames:v', '1');

    return new Promise((resolve) => {
        const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        let got = 0;
        let settled = false;
        const done = (engine) => {
            if (settled) return;
            settled = true;
            cachedEngine = engine;
            try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
            resolve(engine);
        };
        const timer = setTimeout(() => done('gdigrab'), timeoutMs);
        child.stdout.on('data', (d) => {
            got += d.length;
            if (got >= W * H * 3) { clearTimeout(timer); done('ddagrab'); }
        });
        child.on('error', () => { clearTimeout(timer); done('gdigrab'); });
        child.on('close', () => { clearTimeout(timer); if (!got) done('gdigrab'); });
    });
}

module.exports = {
    ENGINES,
    DEFAULT_SCREEN_DEVICE,
    SCREEN_PERMISSION_HINT,
    sourceArgs,
    isDda,
    captureArgs,
    spawnFrames,
    pickScreenEngine,
    resetScreenEngineCache,
    screenEngineWarning,
    resolveFfmpegPath,
    meanOf,
};
