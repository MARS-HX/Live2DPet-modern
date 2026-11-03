/**
 * cuts.js — 逐帧画面变化分（0–255）。**因果**，不看未来（除了一帧的尖峰确认）。
 *
 * 移植自 dsh-see-now（src/cuts.js，Apache-2.0，作者 SAOS-3624）。
 * 见项目根 THIRD-PARTY-NOTICES。改动仅限：ESM→CJS、注释补中文说明。
 *
 * ## 为什么是 HSV 而不是亮度差
 *
 * 常见的场景检测（包括 ffmpeg 自带的 `scdet`）算的是亮度类 MAFD，对
 * **「同亮度换色」** 失明 —— 一页白底黑字的 PPT 换成另一页白底黑字，亮度
 * 分布几乎一致，分数接近 0。屏幕内容恰恰大量属于这一类。
 *
 * 这里用 HSV 三通道加权绝对差，同一段测试素材 9/9 命中，而 `scdet` 只有 4/9。
 *
 * ## 为什么先降到 64×36
 *
 * 打分要在**每一帧**上跑（12fps）。800×450 全图 36 万像素做 HSV 转换太重。
 * 降到 64×36 = 2304 格、每格取 4 个采样点求平均（顺带降噪），一共约 9k 次读，
 * 实测约 0.2ms —— 这才是能挂在每帧上的成本。
 *
 * 降采样和打分一起做还有个好处：网格平均本身就抹掉了光标、抗锯齿边缘这类
 * 单像素级差异，正是我们不想当真的东西。
 */

'use strict';

/** 评分网格尺寸。改它会让历史标定值（cutAbs 等等）全部失效，别乱动。 */
const SCAN_W = 64;
const SCAN_H = 36;

/**
 * 把整幅 RGB 降到 64×36 并归一化到 0–255 的 Float32。
 *
 * 每格取 (0.25, 0.25) 与 (0.75, 0.75) 四个采样点平均。偏移到 1/4 和 3/4 而不是
 * 取四角，是为了避开格子的边界像素（那里多半是缩放插值出来的过渡色）。
 *
 * @param {Buffer|Uint8Array} rgb 源 rgb24 缓冲
 * @param {number} width 源宽
 * @param {number} height 源高
 * @param {Float32Array} out 目标（长度 SCAN_W*SCAN_H*3），会被就地覆盖
 * @returns {Float32Array} out
 */
function gridRgb(rgb, width, height, out) {
    const sx = width / SCAN_W;
    const sy = height / SCAN_H;
    for (let gy = 0; gy < SCAN_H; gy += 1) {
        const y0 = ((gy + 0.25) * sy) | 0;
        const y1 = ((gy + 0.75) * sy) | 0;
        const r0 = y0 * width;
        const r1 = y1 * width;
        for (let gx = 0; gx < SCAN_W; gx += 1) {
            const x0 = ((gx + 0.25) * sx) | 0;
            const x1 = ((gx + 0.75) * sx) | 0;
            const a = (r0 + x0) * 3;
            const b = (r0 + x1) * 3;
            const c = (r1 + x0) * 3;
            const d = (r1 + x1) * 3;
            const i = gy * SCAN_W + gx;
            out[i * 3] = (rgb[a] + rgb[b] + rgb[c] + rgb[d]) * 0.25;
            out[i * 3 + 1] = (rgb[a + 1] + rgb[b + 1] + rgb[c + 1] + rgb[d + 1]) * 0.25;
            out[i * 3 + 2] = (rgb[a + 2] + rgb[b + 2] + rgb[c + 2] + rgb[d + 2]) * 0.25;
        }
    }
    return out;
}

/**
 * RGB → HSV，三个通道都归一到 0–255（H 由角度 ×255/360 缩放）。
 * 就地写进 out，不分配新数组 —— 这个函数每帧都跑。
 */
function rgbToHsv(rgb, out) {
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 3) {
        const rn = rgb[i] / 255;
        const gn = rgb[i + 1] / 255;
        const bn = rgb[i + 2] / 255;
        // 手写 min/max 而不用 Math.max/min：这个函数每次打分都跑 2304 遍，
        // 避免 ArgumentAdaptor 的开销是有意义的（沿用上游写法）
        const max = rn > gn ? (rn > bn ? rn : bn) : (gn > bn ? gn : bn);
        const min = rn < gn ? (rn < bn ? rn : bn) : (gn < bn ? gn : bn);
        const d = max - min;
        let h = 0;
        if (d !== 0) {
            if (max === rn) h = ((gn - bn) / d) % 6;
            else if (max === gn) h = (bn - rn) / d + 2;
            else h = (rn - gn) / d + 4;
            h *= 60;
            if (h < 0) h += 360;
        }
        out[j] = (h / 360) * 255;
        out[j + 1] = max === 0 ? 0 : (d / max) * 255;
        out[j + 2] = max * 255;
    }
    return out;
}

/**
 * 两帧 HSV 的加权绝对差均值，0–255。
 *
 * 三个通道各自的权重是**内容驱动**的，不是拍脑袋：
 *  - 色相差：按环形算（`min(dh, 255-dh)`，否则红绕回红会被当成满幅差异），
 *    并且按两帧中**较低的那个饱和度**降权 —— 灰白色像素的色相是噪声，
 *    它随亮度抖动乱跳，不能让"白底变灰底"被算成"换了个颜色"。
 *  - 饱和度、明度：直接取绝对差，等权。
 *
 * 除以 `(格数 × 3)` 而不是 `格数`：这是让三个通道平均，刻度才落在 0–255 上，
 * 标定出来的 cutAbs=12 才有意义。
 *
 * @param {Float32Array} prev 上一帧 HSV
 * @param {Float32Array} cur 当前帧 HSV
 * @returns {number} 0–255 的变化分
 */
function scorePair(prev, cur) {
    let sum = 0;
    for (let i = 0; i < cur.length; i += 3) {
        const dh = Math.abs(cur[i] - prev[i]);
        const hueDiff = Math.min(dh, 255 - dh);
        const hueWeight = Math.min(cur[i + 1], prev[i + 1]) / 255;
        sum += hueDiff * hueWeight
            + Math.abs(cur[i + 1] - prev[i + 1])
            + Math.abs(cur[i + 2] - prev[i + 2]);
    }
    return sum / ((cur.length / 3) * 3);
}

/**
 * 打分器：内部维护上一帧的 HSV。
 *
 * 返回 `{ score, hsv }`，`score === null` 表示这是第一帧（没有前帧可比）。
 * **`hsv` 是复用的缓冲** —— 要留就自己拷走（pipeline 里就是这么做的）。
 *
 * @param {{width:number, height:number}} size 输入帧的像素尺寸
 * @returns {(frame: Buffer|Uint8Array) => {score: number|null, hsv: Float32Array}}
 */
function createScorer({ width, height }) {
    const n = SCAN_W * SCAN_H;
    const rgb = new Float32Array(n * 3);
    let prev = null;
    const cur = new Float32Array(n * 3);

    return function score(frame) {
        gridRgb(frame, width, height, rgb);
        rgbToHsv(rgb, cur);
        let s = null;
        if (prev) s = scorePair(prev, cur);
        // 双缓冲交换：上一帧的缓冲回收给这一帧用，避免每帧 new 两块数组
        const tmp = prev ?? new Float32Array(n * 3);
        tmp.set(cur);
        prev = tmp;
        return { score: s, hsv: cur };
    };
}

module.exports = {
    SCAN_W,
    SCAN_H,
    gridRgb,
    rgbToHsv,
    scorePair,
    createScorer,
};
