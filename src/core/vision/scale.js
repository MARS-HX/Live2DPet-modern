/**
 * scale.js — 把抓到的整幅帧缩进一格。
 *
 * 移植自 dsh-see-now（src/scale.js，Apache-2.0，作者 SAOS-3624）。
 * 见项目根 THIRD-PARTY-NOTICES。
 *
 * 覆盖式（cover）：短边填满、长边居中裁掉，**绝不改画面比例**。
 *
 * 为什么不用 ffmpeg 的 cover 滤镜做这一步：帧已经在内存里了（rawvideo 管道），
 * 为了缩放再 spawn 一次 ffmpeg 等于把省下的进程启动成本又付回去。这里纯 JS 做，
 * 一格几百毫秒都不到。
 *
 * 实现要点是**预计算每一列/每一行对应的源区间**：同一列上所有行共用同一个
 * 横坐标映射，把 `floor()` 提到循环外，内层只剩加法。这在 12fps × 多格的重排
 * 里省下的时间是可观的。
 */

'use strict';

/**
 * @param {Buffer|Uint8Array} src 源 rawvideo rgb24
 * @param {number} sw 源宽
 * @param {number} sh 源高
 * @param {Buffer|Uint8Array} dst 目标（dw*dh*3）
 * @param {number} dw 目标宽
 * @param {number} dh 目标高
 * @returns {Buffer|Uint8Array} dst
 */
function coverInto(src, sw, sh, dst, dw, dh) {
    const f = Math.max(dw / sw, dh / sh);   // 取较大的缩放比 = short side 填满
    const rw = dw / f;                      // 源上的可见宽度
    const rh = dh / f;                      // 源上的可见高度
    const ox = (sw - rw) / 2;               // 居中裁掉的部分
    const oy = (sh - rh) / 2;

    // 目标每一列 → 源上的 [x0, x1) 区间
    const x0s = new Int32Array(dw);
    const x1s = new Int32Array(dw);
    for (let x = 0; x < dw; x += 1) {
        const a = Math.floor(ox + (x * rw) / dw);
        const b = Math.floor(ox + ((x + 1) * rw) / dw);
        x0s[x] = a;
        x1s[x] = b > a ? b : a + 1;
    }
    // 目标每一行 → 源上的 [y0, y1) 区间
    const y0s = new Int32Array(dh);
    const y1s = new Int32Array(dh);
    for (let y = 0; y < dh; y += 1) {
        const a = Math.floor(oy + (y * rh) / dh);
        const b = Math.floor(oy + ((y + 1) * rh) / dh);
        y0s[y] = a;
        y1s[y] = b > a ? b : a + 1;
    }

    // 盒式平均（area resampling）：每一格取源上覆盖区域的平均色。
    // 用平均而不是最近邻，是因为缩小 2~8 倍时最近邻会丢掉细线与小字，
    // 而屏幕上恰恰全是这种东西。
    for (let y = 0; y < dh; y += 1) {
        const y0 = y0s[y];
        const y1 = y1s[y] > sh ? sh : y1s[y];
        const ny = y1 - y0;
        for (let x = 0; x < dw; x += 1) {
            let sx0 = x0s[x];
            let sx1 = x1s[x] > sw ? sw : x1s[x];
            if (sx0 >= sw) sx0 = sw - 1;
            if (sx1 <= sx0) sx1 = sx0 + 1;
            const nx = sx1 - sx0;
            let r = 0;
            let g = 0;
            let b = 0;
            for (let sy = y0; sy < y1; sy += 1) {
                let p = (sy * sw + sx0) * 3;
                for (let k = 0; k < nx; k += 1) {
                    r += src[p];
                    g += src[p + 1];
                    b += src[p + 2];
                    p += 3;
                }
            }
            const n = nx * ny;
            const o = (y * dw + x) * 3;
            dst[o] = r / n;
            dst[o + 1] = g / n;
            dst[o + 2] = b / n;
        }
    }
    return dst;
}

module.exports = { coverInto };
