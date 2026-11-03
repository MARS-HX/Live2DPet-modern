/**
 * 端到端验证：模拟渲染进程走完整条识屏链路。
 *
 * 这条脚本验的不是单个函数，而是"桌宠真的能拿到能喂给模型的图"这件事：
 *
 *   screen-observer（会话/节奏）
 *     → pipeline（变化分筛选 + 拼图 + PNG）
 *       → toPayload（data URL）
 *         → vision-client.toContentBlock（OpenAI content 块）
 *
 * 用一个假的 configManager 和不依赖 Electron 的注入点跑，所以它能在
 * 纯 Node 下执行（不需要起 Electron）。
 *
 *     node scripts/vision-e2e.js
 *     node scripts/vision-e2e.js --source=file --file=x.mp4
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const { createScreenObserver, SCENE_OPTS, PACES } = require('../src/core/screen-observer');
const { createVisionClient } = require('../src/renderer/vision-client');

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
    const source = args.source === 'file'
        ? { kind: 'file', path: args.file, realtime: false }
        : { kind: 'screen' };

    console.log('=== 1. 会话层：启动并取第一张 ===');
    const obs = createScreenObserver({ graceSec: 5, log: (m) => console.log('  ' + m) });

    // 冷启动 eager：应该 1~3 秒内拿到"此刻"的一张
    const t0 = Date.now();
    const first = await obs.grab({
        seconds: 20, minFrames: 1, src: source, quality: 'low',
        opts: { fps: 12 }, eagerMs: 4000,
    });
    console.log(`  ok=${first.ok} reason=${first.reason || '-'} waited=${first.waited.toFixed(1)}s`);
    if (!first.ok) {
        console.error('FAIL: 冷启动没拿到图（' + (first.error || first.reason) + '）');
        process.exitCode = 1;
        return;
    }
    assert.ok(first.payload, 'payload 必须有');
    assert.ok(first.payload.dataUrl.startsWith('data:image/png;base64,'), 'dataUrl 格式');
    assert.ok(first.payload.frames.length >= 1, '至少一帧');
    console.log(`  拿到 ${first.payload.frames.length} 帧, ${first.payload.width}x${first.payload.height}, `
        + `${Math.round(first.payload.bytes / 1024)}KB, 耗时 ${Date.now() - t0}ms`);
    console.log(`  帧时刻: ${first.payload.frames.map((f) => f.t.toFixed(1) + 's').join(', ')}`);

    console.log('');
    console.log('=== 2. 客户端层：转成 OpenAI content 块 ===');
    const client = createVisionClient({ electronAPI: null });
    const block = client.toContentBlock(first.payload);
    assert.ok(Array.isArray(block), 'content 块必须是数组');
    assert.strictEqual(block[0].type, 'text');
    assert.strictEqual(block[1].type, 'image_url');
    assert.ok(block[1].image_url.url.startsWith('data:image/png;base64,'), 'image_url 直接可用');
    console.log('  text 块:', JSON.stringify(block[0].text.split('\n')[0]));
    console.log('  image 块: data:image/png;base64,... ' + Math.round(block[1].image_url.url.length / 1024) + 'KB');
    console.log(`  总 content 块数: ${block.length}（多帧拼图 = 1 个 image 块，不是 N 个）`);

    console.log('');
    console.log('=== 3. 第二次取图（管温着，应更快且能拿到攒的） ===');
    const t1 = Date.now();
    const second = await obs.grab({
        seconds: 25, minFrames: 1, src: source, quality: 'low',
        opts: { fps: 12 }, eagerMs: 0,
    });
    console.log(`  ok=${second.ok} reason=${second.reason || '-'} waited=${second.waited.toFixed(1)}s `
        + `frames=${second.payload ? second.payload.frames.length : '-'} 实际 ${Date.now() - t1}ms`);

    console.log('');
    console.log('=== 4. 逐场景模式（一张图 = 一个画面，铺满） ===');
    const scene = await obs.grab({
        seconds: 20, minFrames: 1, src: source, quality: 'low',
        opts: { fps: 12, ...SCENE_OPTS }, eagerMs: 0,
    });
    if (scene.ok) {
        console.log(`  帧数=${scene.payload.frames.length}（应为 1）fill=${(scene.payload.fill * 100).toFixed(0)}%（应接近 100）`);
        assert.strictEqual(scene.payload.frames.length, 1, '逐场景模式一张图只能有一帧');
        assert.ok(scene.payload.fill > 0.95, '单帧必须铺满画布');
    } else {
        console.log(`  未取到（${scene.reason}）—— 静止画面下 maxFrames=1 也要等兜底帧，属正常`);
    }

    console.log('');
    console.log('=== 5. 硬闸：手动停止后不许自动拉起 ===');
    obs.stop({ suppress: true });
    const blocked = await obs.grab({ seconds: 5, src: null, quality: 'low', opts: { fps: 12 } });
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.reason, 'suppressed', `应被硬闸拦下，实际 ${blocked.reason}`);
    console.log('  ✓ 已拦截:', blocked.reason);

    // 显式指定来源应能突破硬闸
    const override = await obs.grab({
        seconds: 15, src: source, quality: 'low', opts: { fps: 12 }, eagerMs: 3000,
    });
    console.log(`  显式来源突破硬闸: ok=${override.ok}（这是设计行为）`);

    console.log('');
    console.log('=== 6. 保存样张供肉眼核对 ===');
    const outDir = path.join(__dirname, '..', '.vision-e2e');
    fs.mkdirSync(outDir, { recursive: true });
    const save = (name, payload) => {
        if (!payload) return;
        const b64 = payload.dataUrl.slice('data:image/png;base64,'.length);
        const file = path.join(outDir, name);
        fs.writeFileSync(file, Buffer.from(b64, 'base64'));
        console.log(`  ${name}  ${payload.frames.length} 帧  ${Math.round(payload.bytes / 1024)}KB`);
    };
    save('01-cold-start.png', first.payload);
    if (second.payload) save('02-second.png', second.payload);
    if (scene.payload) save('03-scene.png', scene.payload);
    if (override.payload) save('04-after-override.png', override.payload);

    console.log('');
    const st = obs.status();
    console.log('=== status ===');
    console.log(`  ffmpeg   : ${st.ffmpeg}`);
    console.log(`  running  : ${st.running}`);
    console.log(`  frames   : ${st.frames}`);
    console.log(`  sheets   : ${st.sheets}`);
    console.log(`  stats    : ${JSON.stringify(st.stats && {
        kept: st.stats.kept, cuts: st.stats.cuts, marks: st.stats.marks,
        floors: st.stats.floors, sheets: st.stats.sheets,
    })}`);
    console.log(`  样张目录 : ${outDir}`);

    obs.dispose();
    console.log('');
    console.log('全部通过 ✓');
}

main().catch((e) => {
    console.error('e2e failed:', e);
    process.exitCode = 1;
});
