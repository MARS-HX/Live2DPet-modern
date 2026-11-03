/**
 * tiers.js — 档位：这一帧该占多大格子（1..8 档，边长 1/k）。
 *
 * 移植自 dsh-see-now（src/tiers.js，Apache-2.0，作者 SAOS-3624）。
 * 见项目根 THIRD-PARTY-NOTICES。
 *
 * ## 它在解决什么
 *
 * 一张图里塞几帧，决定了一帧占多大格子，也就决定了这一帧能看清多少。
 * 帧密的时候必须缩格子（否则装不下），帧稀的时候必须放大格子（否则浪费画布）。
 * 所以「档位」= 由**当前出帧密度**反推的格子尺寸。
 *
 * 密度 = 每秒留下几帧。档 k 的格子占 1/k²，一张图放 k² 格 → 每秒 F 帧时，
 * 一张图覆盖 k²/F 秒；取 T≈16s 反解 k ≈ sqrt(T·F)：
 *
 *     F=0.25 → k=2      F=1 → k=4      F=4 → k=8
 *
 * 正好落在下面那张阈值表上 —— 不是巧合，原表的阈值本来就是按「每秒几刀」标的。
 *
 * ## 两处「因果化」（批量版都偷看了未来）
 *
 * - 密度窗：居中 `[t-dt/2, t+dt/2]` → **只看过去** `[t-dt, t]`
 * - 平滑：`movmean(50 帧)` → 每帧走一步的一阶 EMA
 *
 * 实时场景不能偷看未来：这一帧一进来就得判，等不了后面 50 帧。
 */

'use strict';

/**
 * 7 道阈值，单位是**帧/秒**。
 *
 * 原始出处把阈值写成「每帧碰上切点的概率」（0.0085 等），那是和 `dt=100帧/30fps`
 * 绑死的：窗宽 3.33s、每 118 帧一刀。直接把 dt 改成 12 帧会让一刀 = 1/12 = 0.083，
 * **一步跨过 5 道阈值**，档位形同虚设。所以整体换算成「帧/秒」（原表 × 30），
 * 跟 fps 脱钩，`dtFrames` 才真的变成「看过去几秒」。
 */
const LEVEL_THRESHOLDS = Object.freeze([0.26, 0.6, 0.9, 1.2, 1.8, 2.4, 3.0]);
/** 滞回：升档要过 阈值×(1+0.05)，降档要低于 阈值×(1-0.05)，防止在边界反复跳 */
const HYSTERESIS = 0.05;
const TIER_MIN = 1;
const TIER_MAX = 8;

/**
 * 四个策略（上游有四个，这里全部保留）：
 * - `native`  原生：完全按密度算出来的档位
 * - `full`    更大：压一档（格子放大），最低 1 档
 * - `compact` 更小：升一档（格子缩小），一图塞更多帧
 * - `single`  整幅：不管密度，统一压到 1 档 —— 一张图只放一个画面时用
 */
const STRATEGIES = Object.freeze({
    native: { bump: 0, label: '原生' },
    full: { bump: -1, floor: 1, label: '更大' },
    compact: { bump: 1, label: '更小' },
    single: { fixed: 1, label: '整幅' },
});

/**
 * 应用策略。0 档（自由尺寸的补位帧）永远原样保留 —— 它不是"档位"。
 * @param {number[]} tiers
 * @param {string} strategy
 * @returns {number[]}
 */
function applyStrategy(tiers, strategy = 'native') {
    const s = STRATEGIES[strategy] ?? STRATEGIES.native;
    if (s.fixed) return tiers.map((t) => (Number(t) === 0 ? 0 : s.fixed));
    return tiers.map((t) => {
        let v = t + s.bump;
        if (s.floor) v = Math.max(s.floor, v);
        return Math.max(TIER_MIN, Math.min(TIER_MAX, v));
    });
}

/**
 * 密度 → 档位的状态机。
 *
 * @param {{fps?:number, dtFrames?:number, smoothFrames?:number,
 *          thresholds?:number[], hysteresis?:number}} o
 * @returns {{mark:(t:number)=>void, tick:(t:number)=>number, levelAt:()=>number,
 *            density:number, bounds:number[], widthSec:number}}
 */
function createTiers({
    fps = 12, dtFrames = 12, smoothFrames = 6,
    thresholds = LEVEL_THRESHOLDS, hysteresis = HYSTERESIS,
} = {}) {
    const W = Math.max(1, dtFrames) / fps;          // 密度窗宽度（秒）
    const alpha = 1 / Math.max(1, smoothFrames);    // 每帧走一步的 EMA 系数
    const up = thresholds.map((v) => v * (1 + hysteresis));
    const down = thresholds.map((v) => v * (1 - hysteresis));

    const bounds = [];      // 已留下的帧的时刻（秒），窗口外的会被裁掉
    let smoothed = 0;
    let level = 1;

    const countAtLeast = (val, arr) => {
        let k = 0;
        for (let i = 0; i < arr.length; i += 1) if (val >= arr[i]) k += 1;
        return k;
    };

    return {
        /** 记一个边界（一帧被留下的时刻）。 */
        mark(t) { bounds.push(t); },

        /**
         * **每帧都要调**（12 次/秒），不能只在留帧时调。
         *
         * 只在留帧时调的话，EMA 的步长会跟着留帧间隔走：两帧留得远就一步跳满，
         * 密度瞬间冲顶，档位一路飙到 8 档（满屏碎格）。这是踩过的坑。
         *
         * 统计时**不含当前帧**（它还没被 mark），所以是严格因果的。
         * @returns {number} 当前档位 1..8
         */
        tick(t) {
            const lo = t - W;
            let i = bounds.length - 1;
            let n = 0;
            while (i >= 0 && bounds[i] > lo) { n += 1; i -= 1; }
            const raw = n / W;
            smoothed += (raw - smoothed) * alpha;

            const val = smoothed;
            if (level < TIER_MAX && val > up[level - 1]) {
                level = 1 + countAtLeast(val, up);
            } else if (level > TIER_MIN && val < down[level - 2]) {
                level = 1 + countAtLeast(val, down);
            }
            level = Math.max(TIER_MIN, Math.min(TIER_MAX, level));

            // 窗口外的边界再也用不到（多留 1s 余量），别让数组无限长
            if (i > 64) bounds.splice(0, i - 1);
            return level;
        },

        levelAt() { return level; },

        get density() { return smoothed; },
        get bounds() { return bounds; },
        get widthSec() { return W; },
    };
}

module.exports = {
    LEVEL_THRESHOLDS,
    HYSTERESIS,
    TIER_MIN,
    TIER_MAX,
    STRATEGIES,
    applyStrategy,
    createTiers,
};
