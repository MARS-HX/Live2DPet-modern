/**
 * sheet.js — 拼图：把已经抓好的帧按**可变矩形**贴到画布上，再烧编号。
 *
 * 移植自 dsh-see-now（src/sheet.js，Apache-2.0，作者 SAOS-3624）。
 * 见项目根 THIRD-PARTY-NOTICES。
 *
 * 零图像库：全部在 rawvideo RGB 缓冲上做。
 *
 * ## 为什么不用 ffmpeg 的 tile + drawtext
 *
 * - `drawtext` 需要字体文件 + fontconfig + 平台相关路径转义，装到别人机器上就炸；
 * - 我们只需要画 0-9 和几个标点，内置 5×7 点阵更可控，且在低分辨率压缩后更抗糊
 *   （模型看到的是被 patch 网格切碎过的图，锐利的点阵数字比抗锯齿字体更可靠）。
 *
 * ## 布局约定
 *
 * - 每格按 cover 方式缩放裁切（不变形，溢出部分裁掉）—— 缩放发生在**取帧那一步**，
 *   这里只做搬运：抓回来的 buffer 尺寸就等于格子尺寸
 * - 格子之间留 1px 缝（画布底色透出来），否则小格子会连成一片
 */

'use strict';

const BACKGROUND = [18, 18, 20];
const PAD_FILL = [42, 42, 46];
const PAD_GLYPH = [110, 110, 116];
const BADGE_FG = [255, 235, 59];
/** 格子之间的缝（像素）。1px 就够把相邻小格分开，再宽就吃掉画面。 */
const SEAM = 1;

/** 5×7 点阵，只有 0-9 与时间码要用的 `:` `/`。scale 必须是整数，保证放大后边缘锐利。 */
const DIGITS = {
    0: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
    4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
    7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
    ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
    '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
};

const DIGIT_W = 5;
const DIGIT_H = 7;

/**
 * 顶部时间抬头的高度（像素）。只跟图宽有关 —— 字号是点阵整数倍，宽了就该更高。
 * `layoutCanvas` 会按同一个公式**预留**这条带子，`addSheetHeader` 按实际宽度画。
 */
function headerHeight(width) {
    return Math.max(18, Math.round(width * 0.024));
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** 在 RGB 画布上填一块矩形（支持 alpha 混合） */
function fillRect(buf, width, height, x, y, w, h, color, alpha = 1) {
    const [r, g, b] = color;
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(width, x + w);
    const y1 = Math.min(height, y + h);
    for (let py = y0; py < y1; py++) {
        let idx = (py * width + x0) * 3;
        for (let px = x0; px < x1; px++) {
            if (alpha >= 1) {
                buf[idx] = r; buf[idx + 1] = g; buf[idx + 2] = b;
            } else {
                buf[idx] = clamp255(buf[idx] * (1 - alpha) + r * alpha);
                buf[idx + 1] = clamp255(buf[idx + 1] * (1 - alpha) + g * alpha);
                buf[idx + 2] = clamp255(buf[idx + 2] * (1 - alpha) + b * alpha);
            }
            idx += 3;
        }
    }
}

/** 用点阵字形画一个字符串（0-9 与 `-` `:` `/`，空格只走位），返回实际占用尺寸 */
function drawGlyphs(buf, width, height, text, x, y, scale, color) {
    let cursor = x;
    for (const ch of String(text)) {
        if (ch === ' ') { cursor += (DIGIT_W + 1) * scale; continue; }
        if (ch === '-') {
            fillRect(buf, width, height, cursor, y + Math.floor(DIGIT_H * scale * 0.6),
                DIGIT_W * scale, Math.max(1, scale), color);
            cursor += (DIGIT_W + 1) * scale;
            continue;
        }
        const glyph = DIGITS[ch];
        if (!glyph) continue;
        for (let row = 0; row < DIGIT_H; row++) {
            for (let col = 0; col < DIGIT_W; col++) {
                if (glyph[row][col] === '1') {
                    fillRect(buf, width, height, cursor + col * scale, y + row * scale, scale, scale, color);
                }
            }
        }
        cursor += (DIGIT_W + 1) * scale;
    }
    return { width: cursor - x, height: DIGIT_H * scale };
}

/**
 * 编号的字号（点阵整数倍）。
 *
 * 盲测结论：**scale 3 是可靠下限**，scale 2 会把 86 读成 88
 * （内置 5×7 点阵里 6 和 8 只差两个像素）。所以画布 800 宽也保底 3。
 * 上限 5 —— 再大就在小格上喧宾夺主。
 */
function badgeScale(width) {
    return Math.max(3, Math.min(5, Math.round(width / 280)));
}

/**
 * 带描边的点阵字：先在 8 个方向画深色，再叠彩色，保证在亮/暗画面上都看得清。
 * 用于"小格子不画黑底"的编号 —— 黑底在小格上视觉噪音太大，但纯黄字在亮画面上会瞎。
 */
function drawGlyphsOutlined(buf, width, height, text, x, y, scale, fg, outline = [0, 0, 0], dist = 1) {
    for (const [dx, dy] of [[-dist, 0], [dist, 0], [0, -dist], [0, dist],
        [-dist, -dist], [dist, -dist], [-dist, dist], [dist, dist]]) {
        drawGlyphs(buf, width, height, text, x + dx, y + dy, scale, outline);
    }
    drawGlyphs(buf, width, height, text, x, y, scale, fg);
}

/** 无底版编号：只有描边数字，不画黑框 */
function drawBadgePlain(buf, width, height, x, y, label, scale) {
    const text = String(label);
    drawGlyphsOutlined(buf, width, height, text, x, y, scale, BADGE_FG, [0, 0, 0], Math.max(1, Math.round(scale / 2)));
    return { w: text.length * (DIGIT_W + 1) * scale, h: DIGIT_H * scale };
}

/** 空位：灰底 + 居中横杠，且绝对不编号 */
function drawPadding(buf, width, height, x, y, cellW, cellH) {
    fillRect(buf, width, height, x, y, cellW, cellH, PAD_FILL);
    const barW = Math.max(6, Math.round(cellW * 0.32));
    const barH = Math.max(2, Math.round(cellH * 0.03));
    fillRect(buf, width, height,
        x + Math.round((cellW - barW) / 2), y + Math.round((cellH - barH) / 2),
        barW, barH, PAD_GLYPH);
}

/**
 * 把一张 RGB 图贴到目标缓冲区的 (x,y)，占 cellW×cellH。
 *
 * `srcW` 是**源图自己的行宽**。黑场格会取一张只占半格的小图（buffer 宽度就是 cellW/2），
 * 靠它才能按小图的行宽正确拷贝 —— 否则每行都会错位成斜的。
 */
function blit(dst, dstW, dstH, x, y, cellW, cellH, src, srcW = cellW) {
    const need = srcW * cellH * 3;
    if (src.length < need) throw new RangeError(`frame buffer too small: ${src.length} < ${need}`);
    for (let row = 0; row < cellH; row++) {
        const dy = y + row;
        if (dy < 0 || dy >= dstH) continue;
        const sStart = row * srcW * 3;
        const dStart = (dy * dstW + x) * 3;
        if (src.copy) src.copy(dst, dStart, sStart, sStart + cellW * 3);
        else dst.set(src.subarray(sStart, sStart + cellW * 3), dStart);
    }
}

/**
 * 把已经抓好的帧按**可变矩形**拼成一张画布。
 *
 * 矩形来自 `pack.toRects()`（归一化 → 像素），每格大小可以不同，格子之间留 1px 缝。
 * 帧的 buffer 尺寸必须**正好等于该格**（pw×ph）—— 缩放已经在取帧那一步做完。
 *
 * @param {{frames:Array<{buffer:Buffer,w:number,h:number}|null>, rects:Array,
 *          width:number, height:number, burn?:'index'|'none', seam?:number}} opts
 * @returns {{buffer:Buffer, width:number, height:number}}
 */
function composePacked({
    frames, rects, width, height, burn = 'index', seam = SEAM,
}) {
    if (!Array.isArray(rects)) throw new TypeError('rects must be an array');
    const buf = Buffer.alloc(width * height * 3);
    for (let i = 0; i < buf.length; i += 3) {
        buf[i] = BACKGROUND[0]; buf[i + 1] = BACKGROUND[1]; buf[i + 2] = BACKGROUND[2];
    }

    // 第一轮：贴画面。留 1px 缝（右/下），底色透出来就是分隔线。
    // 同时记一张**覆盖掩码**（整格算覆盖，含缝），后面用它找真正的空洞。
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < rects.length; i += 1) {
        const r = rects[i];
        const frame = frames[i];
        const cw = Math.max(1, r.pw - seam);
        const ch = Math.max(1, r.ph - seam);
        const yEnd = Math.min(height, r.py + r.ph);
        const xEnd = Math.min(width, r.px + r.pw);
        for (let y = Math.max(0, r.py); y < yEnd; y += 1) {
            mask.fill(1, y * width + Math.max(0, r.px), y * width + xEnd);
        }
        if (!frame) {
            drawPadding(buf, width, height, r.px, r.py, cw, ch);
            continue;
        }
        blit(buf, width, height, r.px, r.py, cw, ch, frame.buffer, frame.w ?? cw);
    }

    // **空洞铺灰条**：纯黑的空白看起来像渲染失败（"这图是不是没画完"）。
    //
    // 旧写法是"每一行最后一个格子的右边 + 画布底部"，只在**行是齐的**时候对。
    // 档位混排时会出现真空洞（一行里 1 档 225 高、3 档 113 高，右下角空出一块黑），
    // 那种洞旧逻辑一条都盖不到。所以改成扫掩码：把**连续的、形状一致的**未覆盖段
    // 合成矩形再铺，横竖都对得上。
    let prevRuns = null;
    let prevY = 0;
    const flushRuns = (runs, y) => {
        if (!prevRuns) return;
        for (let k = 0; k < prevRuns.length; k += 1) {
            const [x, w] = prevRuns[k];
            drawPadding(buf, width, height, x, prevY, w, y - prevY);
        }
    };
    for (let y = 0; y < height; y += 1) {
        const runs = [];
        let x = 0;
        while (x < width) {
            if (mask[y * width + x]) { x += 1; continue; }
            const start = x;
            while (x < width && !mask[y * width + x]) x += 1;
            if (x - start > 8) runs.push([start, x - start]);   // 细缝不铺，免得整张全是噪点
        }
        const same = prevRuns && runs.length === prevRuns.length
            && runs.every((r, k) => r[0] === prevRuns[k][0] && r[1] === prevRuns[k][1]);
        if (!same) {
            flushRuns(prevRuns, y);
            prevRuns = runs;
            prevY = y;
        }
    }
    flushRuns(prevRuns, height);

    // 第二轮：编号。**单独一轮**，否则后画的格子会盖掉前一格伸出来的描边。
    //
    // 两条规则：
    //   1. **6 档及以上（1/6…1/8）用 scale 2**：格子只有 100px 宽，scale 3 的两位数要占 1/3，
    //      缩到 2 才不压画面（大格仍用 3，保证盲测的"86 不会被读成 88"）。
    //   2. **积分假切点的格子不编号**：它不是"换镜头"，只是"这一段一直在变"，
    //      编号会让模型以为那是独立镜头。图上编号因此会跳号，清单里的 k= 和时间才是准的。
    if (burn !== 'none') {
        const base = badgeScale(width);
        for (let i = 0; i < rects.length; i += 1) {
            const r = rects[i];
            if (!frames[i]) continue;
            if (r.via === 'mark') continue;
            const scale = Number(r.t) >= 6 ? Math.min(2, base) : base;
            drawBadgePlain(buf, width, height, r.px + 2, r.py + 1, r.index, scale);
        }
    }
    return { buffer: buf, width, height };
}

module.exports = {
    BACKGROUND,
    PAD_FILL,
    PAD_GLYPH,
    BADGE_FG,
    SEAM,
    DIGITS,
    DIGIT_W,
    DIGIT_H,
    headerHeight,
    fillRect,
    drawGlyphs,
    drawGlyphsOutlined,
    drawBadgePlain,
    drawPadding,
    badgeScale,
    blit,
    composePacked,
};
