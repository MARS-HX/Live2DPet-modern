/**
 * 真机冒烟：本机屏幕 → ffmpeg → 变化分 → 流水线 → sheet PNG。
 *
 * 不是单元测试（依赖真实屏幕和 ffmpeg），是一个手动跑的诊断脚本：
 *
 *     node scripts/vision-smoke.js                 # 看真实屏幕 8 秒
 *     node scripts/vision-smoke.js --seconds=20
 *     node scripts/vision-smoke.js --source=file --file=x.mp4 --realtime=1
 *     node scripts/vision-smoke.js --quality=standard
 *
 * 输出落在 .vision-smoke/ 下：每张 sheet 一个 PNG + 一份 JSON 清单。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
    spawnFrames, pickScreenEngine, screenEngineWarning, resolveFfmpegPath, resetScreenEngineCache,
} = require('../src/core/vision/capture');
const { createPipeline } = require('../src/core/vision/pipeline');

const SIZES = {
    low: [800, 450],
    standard: [1066, 600],
    high: [1280, 720],
    ultra: [1600, 900],
};

function parseArgs(argv) {
    const out = {};
    for (const a of argv.slice(2)) {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        if (!m) continue;
        out[m[1]] = m[2] === undefined ? true : m[2];
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv);
    const seconds = Number(args.seconds ?? 8);
    const quality = args.quality ?? 'low';
    const fps = Number(args.fps ?? 12);
    const [width, height] = SIZES[quality] ?? SIZES.low;
    const source = args.source === 'file'
        ? { kind: 'file', path: args.file, realtime: args.realtime !== '0' && args.realtime !== false }
        : { kind: 'screen' };

    const outDir = path.join(__dirname, '..', '.vision-smoke');
    fs.mkdirSync(outDir, { recursive: true });

    const ffmpegPath = resolveFfmpegPath();
    console.log(`ffmpeg: ${ffmpegPath}`);
    console.log(`source: ${source.kind}${source.path ? ` (${source.path})` : ''} @ ${width}x${height} ${fps}fps, ${seconds}s`);

    resetScreenEngineCache();
    let engine = 'auto';
    if (source.kind === 'screen') {
        engine = await pickScreenEngine({ ffmpegPath, fps });
        console.log(`engine: ${engine}`);
        const warn = screenEngineWarning();
        if (warn) console.log(`⚠️  ${warn}`);
    }

    const p = createPipeline({ width, height, fps, queueDepth: 0 });
    const sheets = [];
    const scores = [];
    let firstFrameMs = null;

    const run = spawnFrames({
        source, width, height, fps, ffmpegPath, engine,
        onFirst: (ms) => { firstFrameMs = ms; },
        onFrame: (f) => {
            p.push(f);
            const s = p.stats;
            scores.push(s.scoreN ? s.scoreSum / s.scoreN : 0);
            // 立刻把已经攒好的图取走
            let sh;
            while ((sh = p.take())) sheets.push(sh);
        },
        onStderr: (s) => { if (args.verbose) process.stderr.write(s); },
    });

    const timer = setTimeout(() => run.stop(), seconds * 1000);
    const res = await run.done.catch((e) => ({ error: e }));
    clearTimeout(timer);

    // 收尾：把最后半张发出来
    const fin = p.finish();
    for (const sh of [...sheets, ...fin.sheets]) {
        const file = path.join(outDir, `sheet-${String(sh.at.toFixed(2)).replace('.', '_')}.png`);
        fs.writeFileSync(file, sh.png);
        console.log(`  sheet  ${path.basename(file)}  frames=${sh.frames.length}  `
            + `t=${sh.from.toFixed(1)}..${sh.to.toFixed(1)}s  fill=${(sh.fill * 100).toFixed(0)}%  `
            + `why=${sh.why}  ${Math.round(sh.png.length / 1024)}KB`);
    }

    const st = p.stats;
    const dur = res.ms ? res.ms / 1000 : 0;
    console.log('');
    console.log('--- stats ---');
    console.log(`frames decoded : ${st.frames}  (${dur ? (st.frames / dur).toFixed(1) : '?'} fps)`);
    console.log(`first frame    : ${firstFrameMs === null ? 'n/a' : firstFrameMs + 'ms'}`);
    console.log(`kept           : ${st.kept}  (cut=${st.cuts} mark=${st.marks} floor=${st.floors} dupSkipped=${st.dupSkipped})`);
    console.log(`sheets         : ${st.sheets}`);
    console.log(`score mean/max : ${(st.scoreN ? st.scoreSum / st.scoreN : 0).toFixed(2)} / ${st.scoreMax.toFixed(2)}`);
    console.log(`overflow       : ${st.overflow}`);
    if (res.error) console.log(`error          : ${res.error.message}`);
    console.log(`output         : ${outDir}`);

    // 退出码：拿到至少一张图 + 解到帧，才算整条链路通
    if (st.frames === 0) {
        console.error('FAIL: 一帧都没解到（ffmpeg 参数或权限问题）');
        process.exitCode = 1;
    } else if (st.sheets === 0) {
        console.error('FAIL: 解到帧但没出图');
        process.exitCode = 1;
    }
}

main().catch((e) => {
    console.error('smoke failed:', e);
    process.exitCode = 1;
});
