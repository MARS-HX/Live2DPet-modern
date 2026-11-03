/**
 * pipeline.js — 采集帧进来，出图出去。整个识屏流水线唯一有状态的地方。
 *
 * 移植自 dsh-see-now（src/pipeline.js，Apache-2.0，作者 SAOS-3624）。
 * 见项目根 THIRD-PARTY-NOTICES。
 *
 * 一条链：
 *
 *   帧 → 打分 →（延迟一帧）切点判定 → 积分/兜底 → 留帧 → 档位 → pack.solve → 截断 → 出图
 *
 * ## 三个刻意的设计
 *
 * ① **只延迟一帧**。切点判据要看"这一帧的分是不是尖峰"，需要前后各一个分，
 *    所以第 k 帧要到第 k+1 帧到手才判 —— 83ms，换来的是把"一拍二/手抖/粒子"挡在门外。
 *
 * ② **截断在采集侧，不在模型侧**。模型来问的时候图已经在队列里，模型思考 3 秒
 *    只是让队列多一张，不是延迟。
 *
 * ③ **档位数所有边界**（切点 + 积分 + 兜底），不是只数切点。一镜到底的素材没有切点，
 *    只数切点会让档位永远 1 档、一张图只放 4 帧。
 *
 * ## 关于两条判据（这是整套东西的核心，别只留一条）
 *
 * **① 切点** —— 这一帧的分数跳得又高又孤立：
 *     score ≥ cutAbs           绝对地板：变化够不够大
 *     score > 2.5 × 前后帧      尖峰：是不是"一下子"
 *     距上一刀 ≥ 0.4 秒         不应期
 *
 * **② 积分** —— 分不高但一直有，攒够才录一帧：
 *     need = 4分 × fps × 3秒 = 144   固定的绝对阈值，不跟着画面一起涨
 *
 * 为什么两个都要：**尖峰是相对的**，在低分区也会成立。实测缓慢放大（持续运动）有帧
 * `s=13.6`、前后邻居只有 1.1/1.3，尖峰判据完全放行 —— 没有绝对地板，它就会被切成
 * 一块块。反过来只有地板也不行：一镜到底的视频每帧 4 分，永远不会"跳"。
 */

'use strict';

const { createScorer, scorePair } = require('./cuts');
const { createTiers, applyStrategy } = require('./tiers');
const { solve, toRects, splitOneBin } = require('./pack');
const { composePacked, SEAM } = require('./sheet');
const { coverInto } = require('./scale');
const { encodePng } = require('./png');

const DEFAULTS = Object.freeze({
    width: 800,
    height: 450,
    fps: 12,

    /**
     * 切点：绝对值门槛 + 尖峰比 + 不应期。
     *
     * **25 → 15 → 7 → 12。** 25 是影视剪辑的口径（硬切镜头），实时屏幕这边差了
     * 一个数量级。同一条 12fps 链路上量"每 2 秒硬切一张照片"，门槛与命中数：
     *
     * | 素材 | 换图那一帧的分 | 该有几刀 | 25 | 15 | **7** | 5 |
     * |---|---|---|---|---|---|---|
     * | 差异明显的照片 | 46.6~63.4 | 6 | 5 | 5 | 5 | 5 |
     * | 色调接近的照片 | 16.0~17.9 | 6 | **0** | 5 | 5 | 5 |
     * | 极相似（裁切差 8px） | 7.3~8.2 | 6 | **0** | **0** | 5 | 5 |
     * | 只改亮度 | 5.3 | 6 | 0 | 0 | 0 | 2 |
     * | 连续运动（合成片） | 峰值 11.7 / 中位 3.7 | 0 | 0 | 0 | **0** | 0 |
     * | 缓慢缩放 | 峰值 13.6 | 0 | 0 | 2 | 2 | 2 |
     * | 滚动网页 | 30~42 | — | 5 | 5 | 5 | 5 |
     * | 光标在静止画面移动 | 峰值 **0.7** | 0 | 0 | 0 | 0 | 0 |
     *
     * ## 默认取 12，而不是 7
     *
     * 7 能清掉全部 7 分以上的漏判，但那是**为了最难的素材**（7.3 分的极相似照片）定出来的。
     * 对日常屏幕它太敏感：切窗口、滚网页、点菜单都能过线，于是"每 8 秒叫一次"——
     * 用户实报"回复太密集、太烧钱"。所以 7 改成**可选项**（`pace:'dense'`），
     * 默认回到 12：幻灯片的正常切换（16 分以上）照抓，日常操作不再碎。
     *
     * ## 漏判为什么不只是"少一帧"
     *
     * 判不出切点就落到积分，而积分是给**连续运动**标定的
     * （中等运动 4 分/帧 × 12fps × 3 秒 = 144）。幻灯片是"1 帧有值 + 23 帧归零"，
     * 每 2 秒只进账十几分 —— 要换 8~9 张照片才攒够一帧，看着就像"根本没反应"。
     */
    cutAbs: 12,
    cutSpike: 2.5,
    /**
     * 尖峰判据的**绝对地板**：`s` 除了要比前后两帧高 2.5 倍，还得够到这个数。
     *
     * 默认 0 = 不额外要求。给 `action` 档用：那一档把倍率降到 1.5
     * （动作游戏里"前后两帧"本身就很高，2.5 倍根本凑不出来），倍率一松就必须靠
     * 绝对地板兜住噪声，否则满屏都是切点。
     */
    cutSpikeAbs: 0,
    cutMinGap: 0.4,

    /**
     * 积分取帧（伪切点）：沿时间**累加画面变化量**，累够就录一帧、清零。
     *
     * 这不是等间隔抽样。区别在于**阈值是固定的绝对值**：
     *
     *     need = REF_SCORE × fps × integralSeconds
     *
     * 画面动得快 → 每帧分高 → 很快累够 → 密集出帧；
     * 画面静止   → 每帧分趋近 0 → 永远累不够 → 一帧都不出。
     *
     * 早先这里是 `阈值 ∝ 平均变化量`，那样阈值永远跟着画面一起涨，结果**不管画面
     * 动得多快都是固定 N 秒一帧** —— 等于把积分退化成等间隔抽样。
     *
     * `integralSeconds` 的语义：**一段"中等强度"画面，攒够这么多秒才算一个采样点**。
     * 不是"每 N 秒取一帧"。
     */
    integralSeconds: 3,
    /** 两帧之间至少隔这么久 —— "最快不超过半秒一帧"的硬上限，不是出帧节奏。 */
    markMinGap: 0.5,
    /** 画面完全静止时的兜底：这么久都没出帧就给一张，否则模型会一直拿到"没更新"。 */
    silentFloorSec: 20,
    /**
     * **按出帧节奏自适应**兜底：兜底 = clamp(k × 近期出帧间隔, floorMin, floorMax)。
     *
     * 为什么按间隔而不是按活跃度：分数高的地方本来就会连续出帧，低谷期才需要兜底；
     * 而"平时 2 秒一张、突然 8 秒没动静"正是该补一张的信号。
     * 静态画面下近期间隔会被拉长到 floorMax，等价于固定兜底。
     * 0 = 关闭（用固定 silentFloorSec）。
     */
    floorGapK: 0,
    floorMin: 2,
    floorMax: 20,
    /** 和上一张留下的帧差小于这个分就不留（0–255 刻度）。 */
    dupMin: 8,

    // 档位
    dtFrames: 12,
    smoothFrames: 6,
    strategy: 'native',
    /**
     * **积分假切点的档位加成**（加了帧数门槛）。
     *
     * 真切点是"换镜头"，假切点是"这一段一直在变、攒够了才切"——后者没有硬边界，
     * 一帧代表不了多久，所以给**更小的格子**（档位越大格子越小，1/k²）。
     *
     * ## 为什么不能无条件加
     *
     * 批量出图压小档位还有补位帧兜着；实时是逐帧追加，压小就散。实测同一段 30 秒素材：
     *
     * | 帧密度 | boost=2 | boost=0 |
     * |---|---|---|
     * | 稀（4.5 帧/张） | fill 63% | **fill 94%** |
     * | 密（5 帧/张）   | **1296 token/分 · 43/帧** | 1728 token/分 · 58/帧 |
     *
     * 帧稀的时候压档是白扔画布；帧密的时候压档才真的多塞帧、省 token。
     * 所以加成只在"这张图有 boostMinFrames 帧以上"时才生效 —— 判断放在 `flush()` 里。
     */
    markBoost: 2,
    /** 兜底帧也压一档：它是"实在没东西可看，凑一张"，不该占大格子。 */
    floorBoost: 1,
    /** 满这么多帧才应用上面两项加成（帧太少时压档只会浪费画布）。 */
    boostMinFrames: 4,

    // 截断
    maxWaitSec: 15,
    flushGain: 0.015,
    maxFrames: 40,
    /**
     * 箱子代价。**实时场景必须远大于 1**：
     * 批量出图多开一张只是多花一份固定图像开销；实时一次只发一张，
     * 「排成两张」等于把半张图扔掉。默认 1.02 会让「两个 1 档帧」直接判成两张各 100%
     * （实测：25 秒素材出 9 张，每张 1 帧）。给到 1000，DP 就只会往一个箱子里压。
     */
    binCost: 1000,
    /** 出图队列深度。0 = 不丢（离线跑用），线上是 1：宁可丢老画面，不给模型看十几秒前的事。 */
    queueDepth: 1,
    /** 只发一帧就截断。刚开/刚换清晰度时用：让模型马上拿到"现在是什么"。 */
    oneShot: false,
    /** PNG 压缩级别。3 = 实时够快，体积也压得下去。 */
    pngLevel: 3,
});

/**
 * 参考强度（0–255 刻度）：一段"中等强度"画面每帧的变化分。
 *
 * 标定自真实素材：
 *   屏幕静止        0（完全不动，分数就是 0）
 *   合成动画素材    4.4 / 5.5
 *   网页滚动、视频  8–20
 *   快速切窗口      40+
 *
 * 所以取 4：轻微运动能出帧，完全静止仍然出不了 —— 这才是积分该有的样子。
 * （取 8 时缓慢素材要 4.4 秒才够一个采样点，实测 30 秒只出 3 帧，太稀。）
 */
const REF_SCORE = 4;

function createPipeline(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const { width, height, fps } = o;

    const scorer = createScorer({ width, height });
    const tiers = createTiers({
        fps, dtFrames: o.dtFrames, smoothFrames: o.smoothFrames,
    });

    let q = [];                  // 待判的帧（最多 2）
    let lastScore = null;
    let acc = 0;                 // 积分累加
    let lastCut = -Infinity;
    let lastBound = -Infinity;
    /** 近期"出帧间隔"的滑动平均（按节奏自适应兜底用） */
    let gapEwma = 0;
    let lastKeepT = null;
    let lastSeen = null;         // 最近解出来的一帧（插话时如果本张是空的，拿它兜底）
    let sheetStart = 0;          // 本张第一帧的时刻（maxWaitSec 从这儿算）

    let lastKeptHsv = null;      // 上一张留下来的帧（去重基准）
    let frames = [];             // 本张待发
    let sheets = [];
    let dropped = 0;
    const log = [];              // 每一帧为什么留下（离线标定用）

    const stats = {
        frames: 0, kept: 0, cuts: 0, marks: 0, floors: 0, dupSkipped: 0,
        sheets: 0, msDecode: 0, msTotal: 0,
        scoreSum: 0, scoreN: 0, scoreMax: 0,
        /** 多箱兜底触发次数（>0 说明调用方没切干净，画面会被丢帧而不是糊掉） */
        overflow: 0,
    };

    /**
     * 积分阈值：**固定的绝对值**，不随画面变化。
     *
     *     need = REF_SCORE × fps × integralSeconds
     *
     * 于是一段中等画面要攒 integralSeconds 秒才够一个采样点；画面比它动得快就更快
     * 累够，比它静就永远累不够 —— 这才是"运动多给几帧"，而不是固定 N 秒一帧。
     */
    function integralNeed() {
        return REF_SCORE * fps * o.integralSeconds;
    }

    function keep(entry, via) {
        // 去重：和**上一张留下来的帧**太像就不留。一镜到底的素材没有切点，积分会被
        // 雨点/树叶/传感器噪声推着一直触发，25 秒能留 9 张几乎一样的画面。
        // cut / floor 不过这道闸：切点本来就是新画面，floor 是兜底不能吞。
        let dup = null;
        if (lastKeptHsv && entry.hsv) dup = scorePair(lastKeptHsv, entry.hsv);
        if (dup !== null && dup < o.dupMin && via !== 'cut' && via !== 'floor') {
            stats.dupSkipped += 1;
            return false;
        }
        tiers.mark(entry.t);
        const lv = tiers.levelAt();
        // 这里**只按密度给档位**，不加假切点加成 —— 加成要等出图时按最终帧数决定。
        // keep 阶段用它判断"装不装得下"，用不带加成（更大）的档位是保守的：
        // 判装不下而实际装得下，顶多多开一张，不会丢帧。
        const tier = applyStrategy([lv], o.strategy)[0];
        if (frames.length === 0) sheetStart = entry.t;
        frames.push({ t: entry.t, buf: entry.buf, tier, via, level: lv });
        if (entry.hsv) {
            lastKeptHsv ??= new Float32Array(entry.hsv.length);
            lastKeptHsv.set(entry.hsv);
        }
        log.push({
            t: +entry.t.toFixed(2), via, level: lv, tier, score: +(entry.score ?? 0).toFixed(1),
            dup: dup === null ? null : +dup.toFixed(1),
        });
        lastBound = entry.t;
        if (lastKeepT !== null) {
            const g = entry.t - lastKeepT;
            gapEwma = gapEwma === 0 ? g : gapEwma + (g - gapEwma) * 0.3;
        }
        lastKeepT = entry.t;
        stats.kept += 1;
        if (via === 'cut') stats.cuts += 1;
        else if (via === 'mark') stats.marks += 1;
        else if (via === 'floor') stats.floors += 1;
        // 一次性：留下第一帧就立刻发，不等判据
        if (o.oneShot && frames.length === 1) { o.oneShot = false; flush(entry.t, 'oneshot'); return true; }
        checkFlush(entry.t);
        return true;
    }

    /** 当前这批帧的排布预案。**必须和 `flush()` 用同一个档位口径**（都走 `seqOf`）。 */
    function plan() {
        return solve(seqOf(frames), { binCost: o.binCost });
    }

    function checkFlush(t) {
        if (frames.length === 0) return;
        const p = plan();

        // 硬：装不下了。**从末尾退到真装得下为止**，退出来的留给下一张（保序、不丢帧）。
        if (p.bins > 1) {
            const segs = splitOneBin(seqOf(frames), { binCost: o.binCost });
            const keepN = segs[0].length;
            const carry = frames.slice(keepN);
            if (carry.length === 0) { flush(t, 'full'); return; }   // 兜底：不该发生
            frames = frames.slice(0, keepN);
            flush(t, 'full');
            frames = carry;                  // 下一张的起点
            sheetStart = frames[0].t;
            lastBound = frames[frames.length - 1].t;
            return;
        }

        const last = p.cells[p.cells.length - 1];
        const cellArea = last ? last.w * last.h : 1;

        // 软：这一帧只占得到 1.5% 了（7 档 2.04% / 8 档 1.56%），再塞就是碎格
        if (frames.length >= 2 && cellArea < o.flushGain) {
            flush(t, 'crumb');
            return;
        }

        // 时间：从**这一张的第一帧**算起，不是从上一张算起。
        // 从上一张算的话，一张刚 flush 完 12 秒后来的那一帧会立刻被单独发出去（实测 3 张单帧图）。
        // 只有一帧时不按时间发：静态画面下等于每 15 秒扔一张单帧图（固定 token 换一个没变）。
        // 单帧也有封顶：等满两倍 maxWait 还没等到第二帧，那就是没人来看了，发出去收工。
        //
        // **门槛是 3 帧不是 2 帧**：一张图有固定开销，2 帧等于每帧成本翻倍，
        // 4 帧只有一半 —— 少发一张、等第三帧，性价比直接翻倍。
        if (frames.length >= 3 && t - sheetStart >= o.maxWaitSec) {
            flush(t, 'time');
            return;
        }
        if (frames.length === 1 && t - sheetStart >= o.maxWaitSec * 2) {
            flush(t, 'time');
            return;
        }

        if (frames.length >= o.maxFrames) flush(t, 'cap');
    }

    function flush(t, why) {
        if (!frames.length) return;
        const batch = frames;
        frames = [];
        const seq = seqOf(batch);
        const p = solve(seq, { binCost: o.binCost });
        if (!p.cells.length) return;
        /**
         * **一张图只画一个箱子**。`solve` 允许跨箱（DP 里封箱要付 `binCost`），
         * 而 `cells` 会带上所有箱的格子、只靠 `bin` 区分 —— 不过滤就画，
         * 第二箱的 y 从 0 重新开始，直接盖在第一箱上。
         *
         * 正常情况下调用方已保证单箱，这里是最后一道闸：
         * 宁可少画几帧，也不能交一张糊在一起的图。
         */
        const kept = p.cells.filter((c) => c.bin === 0);
        const used = batch.slice(0, kept.length);
        if (used.length < batch.length) stats.overflow += 1;
        const rects = toRects(kept, { width, height, gutter: 0 });
        const cells = rects.map((r, i) => {
            const cw = Math.max(1, r.pw - SEAM);
            const ch = Math.max(1, r.ph - SEAM);
            const buffer = Buffer.alloc(cw * ch * 3);
            coverInto(used[i].buf, width, height, buffer, cw, ch);
            return { buffer, w: cw, h: ch };
        });
        const img = composePacked({ frames: cells, rects, width, height, burn: 'index' });
        const png = encodePng(img.buffer, width, height, { level: o.pngLevel });
        // 占用率按**这张图上真有的格子**算
        const area = kept.reduce((a, c) => a + c.w * c.h, 0);

        // 队列深度：模型没跟上时丢最旧的 —— 宁可丢老画面，不给模型看十几秒前的事
        if (o.queueDepth > 0 && sheets.length >= o.queueDepth) { sheets.shift(); dropped += 1; }
        sheets.push({
            at: t,
            from: used[0].t,
            to: used[used.length - 1].t,
            png,
            w: width,
            h: height,
            fill: area,
            area,
            bins: 1,
            why,
            frames: used.map((f, i) => ({
                t: +f.t.toFixed(2), tier: seq[i], level: f.level, via: f.via,
            })),
            cells: rects.map((r) => ({ px: r.px, py: r.py, pw: r.pw, ph: r.ph, tier: r.t })),
        });
        stats.sheets += 1;
        return sheets[sheets.length - 1];
    }

    /**
     * 出图时的真实档位序列：**在这里**才应用假切点加成。
     *
     * 为什么拖到这一步：加成该不该生效取决于"这张图最后有几帧"，而 `keep()` 那一刻
     * 根本不知道后面还会不会来帧。帧少时压档只会把画布压空（fill 94% → 63%），
     * 帧多时压档才真的省 token。
     */
    function seqOf(batch) {
        const on = batch.length >= Math.max(1, Number(o.boostMinFrames) || 4);
        // `Number(raw) || 0` 不是多余的：命令行传进来可能是字符串 "0"，
        // `lv + "0"` 会变成 "10" 再被 clamp 成 8 档（实测把整张图打成 64 格碎格）。
        const boostFor = (via) => {
            if (!on) return 0;
            const raw = via === 'mark' ? o.markBoost : via === 'floor' ? o.floorBoost : 0;
            return Math.max(0, Number(raw) || 0);
        };
        return batch.map((f) => applyStrategy([Math.min(8, f.level + boostFor(f.via))], o.strategy)[0]);
    }

    function decide(entry, nextScore) {
        const s = entry.score;
        if (s === null) { keep(entry, 'start'); return; }

        const px = entry.prev ?? 0;
        const nx = nextScore ?? 0;
        const spike = nextScore === null
            || (s > o.cutSpike * Math.max(1, px, nx) && s >= o.cutSpikeAbs);
        if (s >= o.cutAbs && spike && entry.t - lastCut >= o.cutMinGap) {
            lastCut = entry.t;
            acc = 0;                      // 切点之后重新攒（那一帧的分属于跨刀，不算运动）
            keep(entry, 'cut');
            return;
        }

        acc += s;
        if (acc >= integralNeed() && entry.t - lastBound >= o.markMinGap) {
            // 只有**真的录进去**才清零。被去重挡掉时保留累积值 —— 否则这一段的运动量
            // 白攒了，下一个采样点要重新等一整轮（实测会让出帧间隔凭空翻倍）。
            if (keep(entry, 'mark')) acc = 0;
            return;
        }
        let floorSec = o.silentFloorSec;
        if (o.floorGapK > 0 && gapEwma > 0) {
            floorSec = Math.min(o.floorMax, Math.max(o.floorMin, o.floorGapK * gapEwma));
        }
        if (entry.t - lastBound >= floorSec) keep(entry, 'floor');
    }

    return {
        /** 喂一帧。`buf` 必须是 width*height*3 的 rgb24，`t` 是秒（可用帧号/fps）。 */
        push({ t, buf }) {
            stats.frames += 1;
            tiers.tick(t);
            const r = scorer(buf);
            const s = r.score;
            if (s !== null) { stats.scoreSum += s; stats.scoreN += 1; if (s > stats.scoreMax) stats.scoreMax = s; }
            const entry = { t, buf, score: s, prev: lastScore, hsv: Float32Array.from(r.hsv) };
            lastSeen = entry;
            lastScore = s;
            q.push(entry);
            while (q.length >= 2) {
                decide(q[0], q[1].score);
                q.shift();
            }
        },

        /** 流结束：把还剩的那一帧判掉，再把最后一张发出去。 */
        finish() {
            while (q.length) {
                decide(q[0], q.length > 1 ? q[1].score : null);
                q.shift();
            }
            // 收尾这批也要**一段一箱**：多箱多半出现在最后（帧都攒在尾部），
            // 直接发就会把两箱画到一张画布上。
            let guard = 0;
            while (frames.length && guard < 64) {
                guard += 1;
                const segs = splitOneBin(seqOf(frames), { binCost: o.binCost });
                if (segs.length <= 1) { flush(lastBound, 'end'); break; }
                const keepN = segs[0].length;
                const carry = frames.slice(keepN);
                frames = frames.slice(0, keepN);
                flush(frames[frames.length - 1].t, 'end');
                frames = carry;
            }
            return { stats, sheets };
        },

        /**
         * **立刻截断出图**。用户插话走这条：不等判据，也不排队。
         *
         * 本张是空的（刚发完）就把「最近解出来的那一帧」塞进去 —— 用户问的是现在
         * 屏幕上是什么，给一张空图或者十几秒前的图都不对。
         *
         * @returns {object|null} 这一张（同时清空队列，插话永远拿最新的）
         */
        flushNow(t = null, why = 'user') {
            // **永远把「此刻那一帧」补进去**，不只是本张为空时。
            // 用户问的是"现在屏幕上是什么"，只给他攒了半张的旧帧不对
            // （实测插话在 30s，图里最后一帧是 26.5s，差了三秒多）。
            if (lastSeen && (!frames.length || lastSeen.t > frames[frames.length - 1].t + 1e-6)) {
                const lv = tiers.levelAt();
                tiers.mark(lastSeen.t);
                if (!frames.length) sheetStart = lastSeen.t;
                frames.push({
                    t: lastSeen.t, buf: lastSeen.buf, via: why === 'user' ? 'user' : 'now', level: lv,
                    tier: applyStrategy([lv], o.strategy)[0],
                });
            }
            // 装不下就从**最老的**开始丢：插话要的是最新画面，老的让位
            while (frames.length > 1 && plan().bins > 1) {
                frames.shift();
                sheetStart = frames[0].t;
            }
            if (!frames.length) return null;
            const at = t ?? frames[frames.length - 1].t;
            const made = flush(at, why);
            sheets.length = 0;
            return made ?? null;
        },

        /** 取走队列里最老的一张（阻塞语义由调用方实现）。 */
        take() {
            return sheets.shift() ?? null;
        },

        peek() {
            return sheets[0] ?? null;
        },

        /** 手上有没有"最近解出来的那一帧"（插话时先看这个，别急着给空手） */
        get hasFrame() { return lastSeen !== null; },

        /** 本批第一帧到现在多久（唤醒文案要说"这段时间有多长"） */
        get secondsSinceWake() {
            if (!frames.length || lastSeen === null) return null;
            return +(lastSeen.t - sheetStart).toFixed(1);
        },

        get pending() { return sheets.length; },
        get dropped() { return dropped; },
        get log() { return log; },
        get stats() { return stats; },
        get tiers() { return tiers; },
        constants: o,
    };
}

module.exports = { DEFAULTS, REF_SCORE, createPipeline };
