/**
 * ConversationStore 历史裁剪 / 阶段总结的回归用例。
 *
 * 旧实现在裁剪历史时这样修正总结下标：
 *
 *     this.history = this.history.slice(-this.maxEntries);
 *     this.lastSummaryIndex = Math.max(0, this.lastSummaryIndex - (this.history.length - this.maxEntries));
 *
 * 第二行执行时 this.history.length 恒等于 maxEntries，减数永远是 0 —— 修正项
 * 是个恒等式。于是 lastSummaryIndex 被钉在 maxEntries 上，
 * `history.length - lastSummaryIndex >= summaryInterval` 再也不成立：
 * 历史一涨到上限（300 条），阶段总结就永久停摆。
 *
 * 运行：node --test tests/test-conversation-store.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'conversation-store.js'), 'utf-8');

function makeStore() {
    global.window = {};
    // conversation-store.js 以 `window.ConversationStore = ...` 收尾，核心逻辑可
    // 由此在纯 Node 下驱动（与 test-core.js 对其它 core 文件的做法一致）。
    eval(SRC);
    const store = new global.window.ConversationStore();
    store.save = async () => {};      // 不打磁盘
    return store;
}

/** 真实 _generateSummary 结束时会推进 lastSummaryIndex（segment 至少 4 条才总结）。 */
function stubSummary(store) {
    const calls = { count: 0 };
    store._generateSummary = async function () {
        calls.count += 1;
        this.lastSummaryIndex = this.history.length;
    };
    return calls;
}

describe('ConversationStore 历史裁剪', () => {
    it('裁剪后索引按真正丢弃的条数推进（回归：修正项恒为 0）', async () => {
        const store = makeStore();
        store.maxEntries = 5;
        store.summaryInterval = 2;
        // 直接用一次裁剪来观察算术，不经过 add() 的副作用
        store.history = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
        store.lastSummaryIndex = 7;
        await store.add('user', 'h');     // 触发裁剪：8 条裁到 5 条，丢 3 条

        assert.strictEqual(store.history.length, 5);
        assert.strictEqual(store.lastSummaryIndex, 4, '7 - 3 = 4；旧实现在这里会留在 7');
    });

    it('历史到达上限后仍会继续产生总结（回归：到上限就永久停摆）', async () => {
        // 这条**不替换 _generateSummary**：之前用替身断言"替身被调用了几次"，
        // 等于测桩件本身。真实实现要求 segment 至少 4 条才总结（src 里 segment.length < 4 直接返回），
        // 所以这里让 summaryInterval=5、maxEntries=8，跑 15 条，看 summaries 是否持续增长。
        const store = makeStore();
        store.maxEntries = 8;
        store.summaryInterval = 5;

        for (let i = 0; i < 15; i++) await store.add('user', 'm' + i);

        assert.strictEqual(store.history.length, 8, '历史应被裁到上限');
        assert.ok(store.summaries.length >= 3,
            `历史到上限后仍必须继续总结；实际只产生了 ${store.summaries.length} 条`);
        const last = store.summaries[store.summaries.length - 1];
        assert.ok(last.summary && last.messageCount >= 4, '总结内容与计数应当有效');
        assert.ok(store.lastSummaryIndex > 0 && store.lastSummaryIndex <= store.history.length,
            'lastSummaryIndex 应停在一个有效位置');
    });

    it('未到上限时索引不受影响', async () => {
        const store = makeStore();
        store.maxEntries = 100;
        store.lastSummaryIndex = 3;
        await store.add('user', '甲');
        assert.strictEqual(store.lastSummaryIndex, 3);
        assert.strictEqual(store.history.length, 1);
    });

    it('历史长度始终不超过上限', async () => {
        const store = makeStore();
        store.maxEntries = 3;
        store.summaryInterval = 1000;   // 不触发总结
        for (let i = 0; i < 10; i++) await store.add('user', 'm' + i);
        assert.strictEqual(store.history.length, 3);
        assert.deepStrictEqual(store.history.map((m) => m.content), ['m7', 'm8', 'm9']);
    });
});
