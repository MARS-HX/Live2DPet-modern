/**
 * Tests for the vision pipeline ported from dsh-see-now (Apache-2.0, SAOS-3624).
 * Run with: node --test tests/test-vision.js
 *
 * 这些测试盯的是**移植过程中最容易被改坏的东西**：
 *  - 变化分的刻度（cutAbs=12 这个数字只有在刻度对的时候才有意义）
 *  - 切点/积分两条判据的独立性（只有一条就会漏或会碎）
 *  - 装箱的"单箱不变量"（多箱会画出一张糊图，而且不报错）
 *  - PNG 的行滤波字节（忘了就会出现"看起来像图但内容是斜的"）
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');

const cuts = require('../src/core/vision/cuts');
const tiersMod = require('../src/core/vision/tiers');
const pack = require('../src/core/vision/pack');
const scale = require('../src/core/vision/scale');
const sheet = require('../src/core/vision/sheet');
const png = require('../src/core/vision/png');
const { createPipeline, DEFAULTS, REF_SCORE } = require('../src/core/vision/pipeline');
const capture = require('../src/core/vision/capture');

/* ---------------------------------------------------------------- helpers */

/** 造一张纯色 rgb24 帧 */
function solid(width, height, [r, g, b]) {
    const buf = Buffer.alloc(width * height * 3);
    for (let i = 0; i < buf.length; i += 3) {
        buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
    }
    return buf;
}

/** 造一张左右两色（有结构，不会和纯色混淆） */
function halves(width, height, c1, c2) {
    const buf = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const c = x < width / 2 ? c1 : c2;
            const i = (y * width + x) * 3;
            buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
        }
    }
    return buf;
}

/** 解析自己编码出来的 PNG，返回 {width,height,rgb} */
function decodePng(buf) {
    assert.strictEqual(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
    let off = 8;
    let ihdr = null;
    const idat = [];
    while (off < buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.subarray(off + 4, off + 8).toString('ascii');
        const data = buf.subarray(off + 8, off + 8 + len);
        if (type === 'IHDR') {
            ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9] };
        }
        if (type === 'IDAT') idat.push(data);
        off += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = ihdr.w * 3 + 1;
    assert.strictEqual(raw.length, stride * ihdr.h, 'scanline payload size');
    const rgb = Buffer.alloc(ihdr.w * ihdr.h * 3);
    for (let y = 0; y < ihdr.h; y++) {
        assert.strictEqual(raw[y * stride], 0, `row ${y} filter byte must be 0`);
        raw.copy(rgb, y * ihdr.w * 3, y * stride + 1, y * stride + 1 + ihdr.w * 3);
    }
    return { width: ihdr.w, height: ihdr.h, rgb, depth: ihdr.depth, color: ihdr.color };
}

/* ---------------------------------------------------------------- cuts.js */

describe('cuts: grid + HSV scoring', () => {
    it('identical frames score exactly 0', () => {
        const w = 320, h = 180;
        const score = cuts.createScorer({ width: w, height: h });
        const frame = halves(w, h, [255, 0, 0], [0, 0, 255]);
        score(frame);
        const r = score(frame);
        assert.strictEqual(r.score.toFixed(6), '0.000000');
    });

    it('the very first frame has no score (nothing to compare against)', () => {
        const score = cuts.createScorer({ width: 64, height: 36 });
        assert.strictEqual(score(solid(64, 36, [10, 20, 30])).score, null);
    });

    it('black → white scores high, and pure-brightness changes cap at 85', () => {
        // 只有 V 通道变化（色相/饱和度都是 0），所以上限就是 255/3 = 85。
        // 这个数字值得记住：单通道变化**到不了** 200 分，别拿全通道的量级去估它。
        const score = cuts.createScorer({ width: 64, height: 36 });
        score(solid(64, 36, [0, 0, 0]));
        const r = score(solid(64, 36, [255, 255, 255]));
        assert.ok(Math.abs(r.score - 85) < 0.5, `expected ~85, got ${r.score}`);
    });

    it('same-luminance hue change still scores (this is why HSV is used)', () => {
        // 这是 scdet 的失明点：亮度几乎一致，只是颜色换了。
        // 屏幕内容大量属于这一类（白底 PPT 换一页），必须能测出来。
        // 红→绿（色相差约 60°）实测 24 分，稳稳越过 cutAbs=12。
        const score = cuts.createScorer({ width: 64, height: 36 });
        score(solid(64, 36, [200, 30, 30]));      // 红
        const r = score(solid(64, 36, [30, 200, 30])); // 绿，明度接近
        assert.ok(r.score > 20, `hue-only change should clear cutAbs, got ${r.score}`);
        assert.ok(r.score >= DEFAULTS.cutAbs, 'must be detectable as a cut');
    });

    it('a pure hue swap scores in the documented "different photo" band', () => {
        // 上游标定：两张完全不同的照片切换 = 46~63；
        // 纯色互换只有色相在变，落在 28 附近，仍远高于门槛
        const score = cuts.createScorer({ width: 64, height: 36 });
        score(solid(64, 36, [255, 0, 0]));
        const r = score(solid(64, 36, [0, 0, 255]));
        assert.ok(r.score > 25 && r.score < 40, `expected 25~40, got ${r.score}`);
    });

    it('hue is circular: 350° → 10° is a small change, not a huge one', () => {
        const score = cuts.createScorer({ width: 64, height: 36 });
        score(solid(64, 36, [255, 20, 20]));       // 略微偏品红
        const r = score(solid(64, 36, [255, 40, 20])); // 略微偏橙
        // 线性相减会把这两个色相算成接近满幅差异；环形处理后应该很小
        assert.ok(r.score < 30, `circular hue should keep this small, got ${r.score}`);
    });

    it('low-saturation pixels have their hue difference weighted down', () => {
        // 灰白像素的色相是噪声：两帧接近灰色时，不该因为色相乱跳而报巨大差异
        const score = cuts.createScorer({ width: 64, height: 36 });
        score(solid(64, 36, [128, 129, 128]));     // 几乎纯灰（饱和度≈0）
        const r = score(solid(64, 36, [128, 132, 128]));
        assert.ok(r.score < 10, `near-grey frames should differ little, got ${r.score}`);
    });

    it('gridRgb averages the source into exactly 64×36 cells', () => {
        const out = new Float32Array(cuts.SCAN_W * cuts.SCAN_H * 3);
        cuts.gridRgb(halves(800, 450, [255, 0, 0], [0, 0, 255]), 800, 450, out);
        assert.strictEqual(out.length, 64 * 36 * 3);
        // 左半格应该是红、右半格应该是蓝
        const left = out[(10 * 64 + 5) * 3];
        const right = out[(10 * 64 + 60) * 3 + 2];
        assert.strictEqual(left, 255);
        assert.strictEqual(right, 255);
    });

    it('scorePair is symmetric', () => {
        const n = cuts.SCAN_W * cuts.SCAN_H * 3;
        const a = new Float32Array(n).fill(10);
        const b = new Float32Array(n).fill(200);
        assert.strictEqual(cuts.scorePair(a, b), cuts.scorePair(b, a));
    });
});

/* --------------------------------------------------------------- tiers.js */

describe('tiers: density → grid size', () => {
    it('starts at level 1 and stays there when nothing is marked', () => {
        const t = tiersMod.createTiers({ fps: 12 });
        for (let i = 0; i < 200; i++) t.tick(i / 12);
        assert.strictEqual(t.levelAt(), 1);
    });

    it('climbs when frames are marked densely', () => {
        const t = tiersMod.createTiers({ fps: 12, smoothFrames: 1 });
        for (let i = 0; i < 400; i++) {
            const sec = i / 12;
            t.mark(sec);              // 每一帧都留 = 12 帧/秒，远超最高档阈值
            t.tick(sec);
        }
        assert.ok(t.levelAt() >= 6, `dense stream should reach a small cell, got ${t.levelAt()}`);
    });

    it('falls back down when the stream goes quiet', () => {
        const t = tiersMod.createTiers({ fps: 12, smoothFrames: 1 });
        for (let i = 0; i < 400; i++) {
            const sec = i / 12;
            t.mark(sec);
            t.tick(sec);
        }
        const peak = t.levelAt();
        // 之后 5 秒什么都不留
        for (let i = 400; i < 460; i++) t.tick(i / 12);
        assert.ok(t.levelAt() < peak, `should relax from ${peak}, got ${t.levelAt()}`);
    });

    it('thresholds are fps-normalised, so 12fps and 30fps agree on rate', () => {
        // 同为 3 帧/秒：两边都应该落在同一个档位附近
        const run = (fps) => {
            const t = tiersMod.createTiers({ fps, smoothFrames: 1 });
            for (let sec = 0; sec < 10; sec += 1 / fps) {
                t.tick(sec);
            }
            // 手工按 3 帧/秒 的节奏 mark
            for (let k = 0; k < 30; k++) t.mark(k / 3);
            for (let i = 0; i < 60; i++) t.tick(10 + i / fps);
            return t.levelAt();
        };
        assert.strictEqual(run(12), run(30));
    });

    it('level never leaves 1..8', () => {
        const t = tiersMod.createTiers({ fps: 12, smoothFrames: 1 });
        for (let i = 0; i < 2000; i++) {
            t.mark(i / 12);
            const lv = t.tick(i / 12);
            assert.ok(lv >= 1 && lv <= 8, `level ${lv} out of range`);
        }
    });

    it('single strategy pins every non-free cell to level 1', () => {
        assert.deepStrictEqual(tiersMod.applyStrategy([1, 2, 5, 8], 'single'), [1, 1, 1, 1]);
        // 0 = 自由尺寸的补位帧，不是档位，必须原样保留
        assert.deepStrictEqual(tiersMod.applyStrategy([0, 3], 'single'), [0, 1]);
    });

    it('native / full / compact shift by one and clamp', () => {
        assert.deepStrictEqual(tiersMod.applyStrategy([2, 4, 8], 'native'), [2, 4, 8]);
        assert.deepStrictEqual(tiersMod.applyStrategy([2, 4, 8], 'full'), [1, 3, 7]);
        assert.deepStrictEqual(tiersMod.applyStrategy([1, 4, 8], 'compact'), [2, 5, 8]);
    });
});

/* ---------------------------------------------------------------- pack.js */

describe('pack: DP bin packing', () => {
    it('two big cells fit side by side in ONE bin', () => {
        const p = pack.solve([1, 1], { binCost: 1000 });
        assert.strictEqual(p.bins, 1);
        assert.strictEqual(p.cells.length, 2);
        // 并排：同 y、x 相差 0.5
        assert.strictEqual(p.cells[0].y, p.cells[1].y);
        assert.ok(Math.abs(p.cells[1].x - 0.5) < 1e-9);
    });

    it('expresses the bin cost: a real binCost splits, a huge one never does', () => {
        // binCost=1.02 时两个 1 档帧排成两张各 100% 反而更"划算"（上游实测过）
        const cheap = pack.solve([1, 1], { binCost: 1.02 });
        const dear = pack.solve([1, 1], { binCost: 1000 });
        assert.strictEqual(dear.bins, 1);
        assert.ok(cheap.bins >= 1);
    });

    it('every cell stays inside the canvas', () => {
        for (const seq of [[1], [1, 1], [1, 2], [3, 3, 3], [2, 4, 6], [1, 8, 8, 8]]) {
            const p = pack.solve(seq, { binCost: 1000 });
            for (const c of p.cells) {
                assert.ok(c.x >= -1e-9 && c.x + c.w <= 1 + 1e-9, `x out of range in ${seq}`);
                assert.ok(c.y >= -1e-9 && c.y + c.h <= 1 + 1e-9, `y out of range in ${seq}`);
            }
        }
    });

    it('preserves frame order (cell i is frame i)', () => {
        const p = pack.solve([3, 1, 5, 2], { binCost: 1000 });
        // seq 字段就是时序，必须严格递增
        p.cells.forEach((c, i) => assert.strictEqual(c.seq, i));
    });

    it('splitOneBin guarantees the single-bin invariant', () => {
        // 这是防糊图的核心不变量：送进 flush 的批次必须 bins===1
        const seqs = [
            [1, 1, 1, 1, 1, 1, 1, 1],
            [1, 1, 1, 1, 1],
            [2, 2, 2, 2, 2, 2],
            [8, 8, 8, 8, 8, 8, 8, 8],
            [1, 2, 3, 4, 5, 6, 7, 8],
        ];
        for (const seq of seqs) {
            const segs = pack.splitOneBin(seq, { binCost: 1000 });
            assert.ok(segs.length >= 1);
            // 保序、不丢帧、不重帧
            assert.deepStrictEqual(segs.flat(), seq);
            for (const seg of segs) {
                assert.strictEqual(pack.solve(seg, { binCost: 1000 }).bins, 1,
                    `segment must fit in one bin: ${JSON.stringify(seg)}`);
            }
        }
    });

    it('splitOneBin keeps a single frame as one segment', () => {
        assert.deepStrictEqual(pack.splitOneBin([3]), [[3]]);
        assert.deepStrictEqual(pack.splitOneBin([]), []);
    });

    it('toRects produces integer pixels with no 1px gaps between neighbours', () => {
        const p = pack.solve([1, 1], { binCost: 1000 });
        const rects = pack.toRects(p.cells, { width: 800, height: 450 });
        assert.strictEqual(rects.length, 2);
        for (const r of rects) {
            assert.ok(Number.isInteger(r.px) && Number.isInteger(r.py));
            assert.ok(Number.isInteger(r.pw) && Number.isInteger(r.ph));
            assert.ok(r.px + r.pw <= 800);
            assert.ok(r.py + r.ph <= 450);
        }
        // 相邻格必须严丝合缝
        assert.strictEqual(rects[0].px + rects[0].pw, rects[1].px);
    });

    it('cell indices are global (continuous across sheets)', () => {
        const p = pack.solve([1, 1]);
        const rects = pack.toRects(p.cells, { width: 800, height: 450 });
        assert.strictEqual(rects[0].index, 1);
        assert.strictEqual(rects[1].index, 2);
    });
});

/* --------------------------------------------------------------- scale.js */

describe('scale: cover resampling', () => {
    it('fills the whole target with a solid colour', () => {
        const src = solid(100, 100, [12, 34, 56]);
        const dst = Buffer.alloc(40 * 30 * 3);
        scale.coverInto(src, 100, 100, dst, 40, 30);
        for (let i = 0; i < dst.length; i += 3) {
            assert.strictEqual(dst[i], 12);
            assert.strictEqual(dst[i + 1], 34);
            assert.strictEqual(dst[i + 2], 56);
        }
    });

    it('never distorts aspect ratio (crops instead)', () => {
        // 源是左侧红、右侧蓝的竖分。目标很宽 → 上下会被裁，但左右两色仍在
        const src = halves(100, 100, [255, 0, 0], [0, 0, 255]);
        const dst = Buffer.alloc(80 * 20 * 3);
        scale.coverInto(src, 100, 100, dst, 80, 20);
        const at = (x, y) => {
            const o = (y * 80 + x) * 3;
            return [dst[o], dst[o + 1], dst[o + 2]];
        };
        assert.ok(at(2, 10)[0] > 200, 'left edge should be red');
        assert.ok(at(77, 10)[2] > 200, 'right edge should be blue');
    });
});

/* --------------------------------------------------------------- sheet.js */

describe('sheet: glyphs + compose', () => {
    it('encodes digits and punctuation at integer scale', () => {
        const buf = Buffer.alloc(200 * 40 * 3);
        const r = sheet.drawGlyphs(buf, 200, 40, '0123456789 :/-', 0, 0, 3, [255, 0, 0]);
        assert.ok(r.width > 0);
        assert.strictEqual(r.height, 7 * 3);
    });

    it('badge scale never goes below 3 (86 must not read as 88)', () => {
        assert.strictEqual(sheet.badgeScale(320), 3);
        assert.strictEqual(sheet.badgeScale(800), 3);
        assert.strictEqual(sheet.badgeScale(2000), 5);
    });

    it('composed canvas has the requested dimensions and a dark background', () => {
        const p = pack.solve([2], { binCost: 1000 });
        const rects = pack.toRects(p.cells, { width: 200, height: 100 });
        const frame = { buffer: solid(rects[0].pw - 1, rects[0].ph - 1, [255, 255, 0]), w: rects[0].pw - 1, h: rects[0].ph - 1 };
        const out = sheet.composePacked({ frames: [frame], rects, width: 200, height: 100 });
        assert.strictEqual(out.width, 200);
        assert.strictEqual(out.height, 100);
        assert.strictEqual(out.buffer.length, 200 * 100 * 3);
    });

    it('unfilled area is padded grey, never left black', () => {
        // 半张图：下半部分应该铺灰条（42,42,46），而不是纯黑
        const p = pack.solve([1, 1], { binCost: 1000 });
        const rects = pack.toRects(p.cells, { width: 200, height: 100 });
        const frames = rects.map((r) => ({
            buffer: solid(r.pw - 1, r.ph - 1, [255, 0, 0]), w: r.pw - 1, h: r.ph - 1,
        }));
        const out = sheet.composePacked({ frames, rects, width: 200, height: 100 });
        // 底部中间
        const o = (95 * 200 + 100) * 3;
        const px = [out.buffer[o], out.buffer[o + 1], out.buffer[o + 2]];
        assert.deepStrictEqual(px, sheet.PAD_FILL, 'empty area must be padded, not black');
    });

    it('a null frame becomes a grey pad cell', () => {
        const p = pack.solve([2, 2], { binCost: 1000 });
        const rects = pack.toRects(p.cells, { width: 200, height: 100 });
        const frames = rects.map(() => null);
        const out = sheet.composePacked({ frames, rects, width: 200, height: 100 });
        const r = rects[0];
        // 取左上角附近：中心画的是"横杠"字形（PAD_GLYPH），不是底色
        const o = ((r.py + 3) * 200 + (r.px + 3)) * 3;
        assert.deepStrictEqual([out.buffer[o], out.buffer[o + 1], out.buffer[o + 2]], sheet.PAD_FILL);
        // 中心那道横杠用的是更亮的 PAD_GLYPH
        const co = ((r.py + (r.ph >> 1)) * 200 + (r.px + (r.pw >> 1))) * 3;
        assert.deepStrictEqual([out.buffer[co], out.buffer[co + 1], out.buffer[co + 2]], sheet.PAD_GLYPH);
    });
});

/* ----------------------------------------------------------------- png.js */

describe('png: hand-rolled encoder', () => {
    it('round-trips a known pixel pattern', () => {
        const w = 4, h = 3;
        const rgb = Buffer.alloc(w * h * 3);
        for (let i = 0; i < w * h; i++) {
            rgb[i * 3] = i * 10;
            rgb[i * 3 + 1] = 255 - i * 10;
            rgb[i * 3 + 2] = 7;
        }
        const out = png.encodePng(rgb, w, h);
        const back = decodePng(out);
        assert.strictEqual(back.width, w);
        assert.strictEqual(back.height, h);
        assert.strictEqual(back.depth, 8);
        assert.strictEqual(back.color, 2);       // truecolor
        assert.deepStrictEqual(Array.from(back.rgb), Array.from(rgb));
    });

    it('rejects a buffer that is too small', () => {
        assert.throws(() => png.encodePng(Buffer.alloc(10), 4, 4), /too small/);
    });

    it('rejects a nonsense size', () => {
        assert.throws(() => png.encodePng(Buffer.alloc(10), 0, 4), /bad size/);
    });

    it('pngToDataUrl produces a decodable data URL', () => {
        const url = png.pngToDataUrl(png.encodePng(solid(2, 2, [1, 2, 3]), 2, 2));
        assert.ok(url.startsWith('data:image/png;base64,'));
        const b64 = url.slice('data:image/png;base64,'.length);
        assert.deepStrictEqual(Buffer.from(b64, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    });

    it('testCard is a 4×4 grid of distinct colours', () => {
        const { rgb, width, height } = png.testCard(160, 90);
        assert.strictEqual(rgb.length, 160 * 90 * 3);
        const at = (x, y) => {
            const o = (y * 160 + x) * 3;
            return [rgb[o], rgb[o + 1], rgb[o + 2]];
        };
        const tl = at(20, 12);
        const br = at(140, 78);
        assert.notDeepStrictEqual(tl, br);
    });
});

/* ------------------------------------------------------------ pipeline.js */

describe('pipeline: the actual selection logic', () => {
    const W = 200, H = 112;
    const frame = (c) => solid(W, H, c);

    it('a perfectly static screen produces no sheets during the run', () => {
        // 这是整套东西存在的理由：静止屏幕不该烧 token
        const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0 });
        const buf = halves(W, H, [30, 60, 90], [200, 100, 50]);
        for (let i = 0; i < 120; i++) p.push({ t: i / 12, buf });   // 10 秒
        assert.strictEqual(p.stats.kept, 1, 'only the first frame is kept');
        assert.strictEqual(p.take(), null, 'nothing flushed yet');
        assert.strictEqual(p.stats.cuts, 0);
    });

    it('hard cuts are detected as cuts (the slideshow case)', () => {
        // 6 段纯色、每段 2 秒 → 应该抓到 5 个切点（第 1 帧算 start）
        const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0, dupMin: 0 });
        const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255]];
        for (let seg = 0; seg < colors.length; seg++) {
            for (let k = 0; k < 24; k++) {
                p.push({ t: seg * 2 + k / 12, buf: frame(colors[seg]) });
            }
        }
        const fin = p.finish();
        assert.ok(fin.stats.cuts >= 4, `expected ~5 cuts, got ${fin.stats.cuts}`);
        assert.ok(fin.stats.cuts <= 6, `too many cuts: ${fin.stats.cuts}`);
        // 至少出一张图，且图里的帧数大于 1（拼起来才有意义）
        assert.ok(fin.sheets.length >= 1);
    });

    it('a hard cut beats a one-off blip (spike criterion needs a real floor)', () => {
        // 静止画面 + 一个微小抖动：不该被当成切点
        const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0, dupMin: 0 });
        const base = solid(W, H, [100, 100, 100]);
        for (let i = 0; i < 24; i++) p.push({ t: i / 12, buf: base });
        p.push({ t: 2, buf: solid(W, H, [104, 100, 100]) });   // 只改一点点
        for (let i = 25; i < 48; i++) p.push({ t: i / 12, buf: base });
        p.finish();
        assert.strictEqual(p.stats.cuts, 0, 'a 4/255 brightness blip is not a cut');
    });

    it('continuous motion is picked up by the integral, not by cuts', () => {
        // 缓慢渐变：每帧分很低，永远构不成尖峰，但积分会攒够。
        // 注意 v 必须夹在 0..255 —— 写进 Buffer 的负数会回绕成 255，
        // 那会变成一次真实的巨大跳变（实测会打出 105 分），把测试意图搞反。
        const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0, dupMin: 0 });
        for (let i = 0; i < 400; i++) {   // 33 秒
            const raw = 50 + Math.round(100 * Math.sin(i / 40));
            const v = Math.max(0, Math.min(255, raw));
            p.push({ t: i / 12, buf: solid(W, H, [v, 128, 128]) });
        }
        const fin = p.finish();
        assert.ok(p.stats.scoreMax < DEFAULTS.cutAbs,
            `a smooth ramp must never reach the cut floor (max was ${p.stats.scoreMax})`);
        assert.strictEqual(fin.stats.cuts, 0, 'no spikes in a smooth ramp');
        assert.ok(fin.stats.marks > 0, 'integral must produce sample points');
    });

    it('the silent floor guarantees a sheet even when nothing changes', () => {
        const p = createPipeline({
            width: W, height: H, fps: 12, queueDepth: 0,
            silentFloorSec: 2, maxWaitSec: 1,
        });
        const buf = solid(W, H, [50, 50, 50]);
        for (let i = 0; i < 120; i++) p.push({ t: i / 12, buf });   // 10 秒静止
        assert.ok(p.stats.floors >= 1, 'the floor must fire for a static screen');
    });

    it('integralNeed scales with fps and integralSeconds', () => {
        // 只有看 stats 不够直观，这里直接验两条管线的相对行为：
        // integralSeconds 越大，同样素材留下的帧越少
        const make = (sec) => {
            const p = createPipeline({
                width: W, height: H, fps: 12, queueDepth: 0, dupMin: 0,
                integralSeconds: sec, silentFloorSec: 999, cutAbs: 999,
            });
            for (let i = 0; i < 240; i++) {
                const v = (i * 2) % 200;
                p.push({ t: i / 12, buf: solid(W, H, [v, 100, 100]) });
            }
            p.finish();
            return p.stats.kept;
        };
        const fast = make(1);
        const slow = make(10);
        assert.ok(fast > slow, `integralSeconds=1 should keep more than 10 (${fast} vs ${slow})`);
    });

    it('flushNow always hands back the freshest frame', () => {
        const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0 });
        const buf = solid(W, H, [10, 200, 10]);
        for (let i = 0; i < 12; i++) p.push({ t: i / 12, buf });
        const s = p.flushNow(null, 'user');
        assert.ok(s, 'flushNow must produce a sheet');
        assert.ok(s.frames.length >= 1);
        // 最后一张图必须包含"此刻"，不是十几秒前
        assert.ok(Math.abs(s.to - 11 / 12) < 1e-6, `stale sheet: to=${s.to}`);
    });

    it('flushNow returns null when no frame has ever arrived', () => {
        const p = createPipeline({ width: W, height: H, fps: 12 });
        assert.strictEqual(p.flushNow(), null);
    });

    it('every emitted sheet carries a decodable PNG', () => {
        const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0, dupMin: 0 });
        const colors = [[255, 0, 0], [0, 0, 255], [0, 255, 0]];
        for (let seg = 0; seg < 3; seg++) {
            for (let k = 0; k < 24; k++) p.push({ t: seg * 2 + k / 12, buf: frame(colors[seg]) });
        }
        const fin = p.finish();
        assert.ok(fin.sheets.length >= 1);
        for (const s of fin.sheets) {
            const img = decodePng(s.png);
            assert.strictEqual(img.width, W);
            assert.strictEqual(img.height, H);
            assert.ok(s.frames.length >= 1);
            assert.ok(s.fill > 0 && s.fill <= 1 + 1e-9);
        }
    });

    it('never emits a sheet whose frames overlap (single-bin invariant)', () => {
        // 多箱会把第二箱画在第一箱上面 → 糊图，且不会报错。
        // 这里用一堆大格子把画布挤爆，验证 pipeline 自己切段。
        const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0, dupMin: 0 });
        const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255]];
        for (let seg = 0; seg < colors.length; seg++) {
            for (let k = 0; k < 6; k++) p.push({ t: seg * 0.5 + k / 12, buf: frame(colors[seg]) });
        }
        const fin = p.finish();
        assert.strictEqual(p.stats.overflow, 0, 'overflow means frames were silently dropped');
        for (const s of fin.sheets) {
            // 格子两两不重叠
            for (let i = 0; i < s.cells.length; i++) {
                for (let j = i + 1; j < s.cells.length; j++) {
                    const a = s.cells[i], b = s.cells[j];
                    const overlap = a.px < b.px + b.pw && b.px < a.px + a.pw
                        && a.py < b.py + b.ph && b.py < a.py + a.ph;
                    assert.ok(!overlap, `cells ${i} and ${j} overlap in sheet ${s.at}`);
                }
            }
        }
    });

    it('oneShot emits the first kept frame without waiting for a full sheet', () => {
        // 管线**故意延迟一帧**做尖峰确认，所以第 1 帧要等第 2 帧到手才判。
        // oneShot 是在"第一帧被留下"的那一刻立刻封箱，不是"第 1 帧就出图"。
        const p = createPipeline({ width: W, height: H, fps: 12, queueDepth: 0, oneShot: true });
        p.push({ t: 0, buf: solid(W, H, [1, 2, 3]) });
        assert.strictEqual(p.pending, 0, 'the one-frame delay is by design');
        p.push({ t: 1 / 12, buf: solid(W, H, [1, 2, 3]) });
        assert.strictEqual(p.pending, 1, 'oneShot should flush as soon as frame 1 is decided');
    });

    it('queueDepth drops the oldest sheet when the consumer lags', () => {
        // maxFrames=1 让每一帧立刻封箱，于是能不 take 就堆出多张
        const p = createPipeline({
            width: W, height: H, fps: 12, queueDepth: 1, dupMin: 0, maxFrames: 1,
        });
        const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255]];
        for (let seg = 0; seg < colors.length; seg++) {
            for (let k = 0; k < 6; k++) {
                p.push({ t: seg * 0.5 + k / 12, buf: frame(colors[seg]) });
            }
        }
        p.finish();
        assert.ok(p.stats.sheets >= 3, `should have produced several sheets, got ${p.stats.sheets}`);
        assert.ok(p.dropped >= 1, 'the older sheets must be dropped');
        assert.strictEqual(p.pending, 1, 'queueDepth=1 leaves exactly one sheet');
    });

    it('defaults match the documented calibration', () => {
        assert.strictEqual(DEFAULTS.cutAbs, 12, 'cutAbs default');
        assert.strictEqual(REF_SCORE, 4, 'REF_SCORE calibration');
        assert.strictEqual(DEFAULTS.integralSeconds, 3);
        assert.strictEqual(DEFAULTS.binCost, 1000, 'real-time bin cost must discourage multi-bin');
        assert.strictEqual(DEFAULTS.queueDepth, 1);
    });
});

/* ------------------------------------------------------------- capture.js */

describe('capture: ffmpeg argument construction', () => {
    it('uses gdigrab with an explicit framerate on Windows', () => {
        const args = capture.sourceArgs({ kind: 'screen' }, { engine: 'gdigrab', fps: 12, platform: 'win32' });
        assert.ok(args.includes('-f') && args.includes('gdigrab'));
        assert.strictEqual(args[args.indexOf('-framerate') + 1], '12');
        // 光标不画（否则屏幕上永远有个"正在动"的东西，破坏静止判定）
        assert.strictEqual(args[args.indexOf('-draw_mouse') + 1], '0');
    });

    it('uses ddagrab as a lavfi filter source', () => {
        const args = capture.sourceArgs({ kind: 'screen' }, { engine: 'ddagrab', fps: 12, platform: 'win32' });
        assert.deepStrictEqual(args.slice(0, 3), ['-f', 'lavfi', '-i']);
        assert.match(args[3], /ddagrab=framerate=12/);
    });

    it('downloads ddagrab frames off the GPU before scaling', () => {
        const args = capture.captureArgs({
            source: { kind: 'screen' }, width: 800, height: 450, fps: 12,
            engine: 'ddagrab', platform: 'win32',
        });
        const vf = args[args.indexOf('-vf') + 1];
        assert.match(vf, /hwdownload/);
        assert.match(vf, /scale=800:450/);
    });

    it('gdigrab needs no hwdownload', () => {
        const args = capture.captureArgs({
            source: { kind: 'screen' }, width: 800, height: 450, fps: 12,
            engine: 'gdigrab', platform: 'win32',
        });
        const vf = args[args.indexOf('-vf') + 1];
        assert.ok(!vf.includes('hwdownload'));
    });

    it('does not double-throttle Windows screen sources with -r', () => {
        // gdigrab 已按 fps 抓；再挂 -r 是白跑一趟
        const args = capture.captureArgs({
            source: { kind: 'screen' }, width: 800, height: 450, fps: 12,
            engine: 'gdigrab', platform: 'win32',
        });
        assert.ok(!args.includes('-r'), `unexpected -r in ${args.join(' ')}`);
    });

    it('always emits rawvideo rgb24 on stdout', () => {
        const args = capture.captureArgs({
            source: { kind: 'screen' }, width: 800, height: 450, fps: 12, engine: 'gdigrab', platform: 'win32',
        });
        assert.strictEqual(args[args.indexOf('-f', args.indexOf('-vf')) + 1], 'rawvideo');
        assert.strictEqual(args[args.indexOf('-pix_fmt') + 1], 'rgb24');
        assert.strictEqual(args[args.length - 1], '-');
    });

    it('drops audio and subtitles (they only cost probing time)', () => {
        const args = capture.captureArgs({
            source: { kind: 'screen' }, width: 800, height: 450, fps: 12, engine: 'gdigrab', platform: 'win32',
        });
        assert.ok(args.includes('-an'));
        assert.ok(args.includes('-sn'));
    });

    it('macOS screen source must keep the output-side -r', () => {
        // 坑：avfoundation 屏幕源不认 -framerate 当节流阀，不挂 -r 会灌出巨量数据
        const args = capture.captureArgs({
            source: { kind: 'screen' }, width: 800, height: 450, fps: 12, platform: 'darwin',
        });
        assert.ok(args.includes('-r'), 'missing throttle on macOS screen source');
        assert.strictEqual(args[args.indexOf('-r') + 1], '12');
    });

    it('file sources pass -re only when realtime is requested', () => {
        assert.ok(capture.sourceArgs({ kind: 'file', path: 'x.mp4', realtime: true }).includes('-re'));
        assert.ok(!capture.sourceArgs({ kind: 'file', path: 'x.mp4', realtime: false }).includes('-re'));
    });

    it('rejects an unknown source kind instead of guessing', () => {
        assert.throws(() => capture.sourceArgs({ kind: 'telepathy' }), /unknown source kind/);
    });

    it('meanOf spots an all-black frame (the macOS permission symptom)', () => {
        assert.ok(capture.meanOf(Buffer.alloc(6912)) < 1);
        assert.ok(capture.meanOf(Buffer.alloc(6912, 200)) > 100);
    });
});

/* --------------------------------------------------------- screen-observer */

describe('screen-observer: pacing + guards', () => {
    const obs = require('../src/core/screen-observer');

    it('exposes four paces with sensible ordering', () => {
        assert.deepStrictEqual(Object.keys(obs.PACES), ['calm', 'normal', 'dense', 'action']);
        // 越省电的档门槛越高
        assert.ok(obs.PACES.calm.cutAbs > obs.PACES.normal.cutAbs);
        assert.ok(obs.PACES.normal.cutAbs > obs.PACES.dense.cutAbs);
        // action 档门槛最高（全屏游戏每帧都在动）
        assert.ok(obs.PACES.action.cutAbs > obs.PACES.calm.cutAbs);
    });

    it('action pace also raises the integral and frame cap together', () => {
        // 只抬切点门槛而不抬积分，出帧密度不会降下来
        assert.ok(obs.PACES.action.pipeline.integralSeconds > 3);
        assert.strictEqual(obs.PACES.action.pipeline.cutSpike, 1.5);
        assert.ok(obs.PACES.action.pipeline.cutSpikeAbs > 0);
    });

    it('scene mode pins maxFrames=1 and strategy=single together', () => {
        // 只改一个会得到"小格子 + 大片留白"或"多重满幅被切开"
        assert.strictEqual(obs.SCENE_OPTS.maxFrames, 1);
        assert.strictEqual(obs.SCENE_OPTS.strategy, 'single');
    });

    it('guard blocks auto-restart after a manual stop', () => {
        assert.strictEqual(obs.guardReason({ suppressed: true }), 'suppressed');
        assert.strictEqual(obs.guardReason({ suppressed: false }), null);
    });

    it('guard blocks replaying a finished file', () => {
        assert.strictEqual(obs.guardReason({ fileEnded: true }), 'file-ended');
    });

    it('an explicit source overrides every guard', () => {
        assert.strictEqual(obs.guardReason({ suppressed: true, explicitSrc: true }), null);
        assert.strictEqual(obs.guardReason({ fileEnded: true, explicitSrc: true }), null);
    });

    it('optsSig is order-independent', () => {
        assert.strictEqual(obs.optsSig({ a: 1, b: 2 }), obs.optsSig({ b: 2, a: 1 }));
        assert.notStrictEqual(obs.optsSig({ a: 1 }), obs.optsSig({ a: 2 }));
    });

    it('pipelineSig ignores the per-call switches, so repeated grabs do not restart capture', () => {
        // 回归：早先 start() 用 delete runOpts.fps，而 watch() 用 {...opts, fps: undefined}，
        // 两边签名永远不相等 → 每一次取图都判成"换模式"而重启采集。
        // 真机表现：第二次取图白付 400ms 冷启动，并把刚攒的帧全丢掉。
        const stored = { cutAbs: 12, floorGapK: 2 };                 // start() 存下的原样参数
        const sameCall = { cutAbs: 12, floorGapK: 2, oneShot: false };// watch() 传进来的
        assert.strictEqual(obs.pipelineSig(stored), obs.pipelineSig(sameCall),
            'oneShot must not affect the pipeline signature');
        // fps 只影响采集，不参与"出图口径"比较
        assert.strictEqual(obs.pipelineSig({ cutAbs: 12 }), obs.pipelineSig({ cutAbs: 12, fps: 12 }));
        // 但真正的模式变化必须能被看出来
        assert.notStrictEqual(
            obs.pipelineSig({ cutAbs: 12 }),
            obs.pipelineSig({ cutAbs: 12, maxFrames: 1, strategy: 'single' }),
            'scene mode must be detected as a mode change',
        );
        // 换清晰度那一次会带 oneShot:true，也不该被当成模式变化
        assert.strictEqual(obs.pipelineSig(stored), obs.pipelineSig({ ...stored, oneShot: true }));
    });

    it('the scene preset really does change the signature (so the guard above is meaningful)', () => {
        const normal = { cutAbs: 12, floorGapK: 2 };
        const scene = { ...normal, ...obs.SCENE_OPTS };
        assert.notStrictEqual(obs.pipelineSig(normal), obs.pipelineSig(scene));
    });

    it('quality tiers are ordered and the default is the cheapest', () => {
        const names = Object.keys(obs.SIZES);
        assert.deepStrictEqual(names, ['low', 'standard', 'high', 'ultra']);
        assert.strictEqual(obs.DEFAULT_QUALITY, 'low');
        // 像素面积必须单调递增
        let prev = 0;
        for (const n of names) {
            const [w, h] = obs.SIZES[n];
            assert.ok(w * h > prev, `${n} should be bigger than the previous tier`);
            prev = w * h;
        }
    });
});
