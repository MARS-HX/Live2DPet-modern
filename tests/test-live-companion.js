/**
 * Unit tests for the live (danmaku) companion reply policy.
 * Run with: node --test tests/test-live-companion.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');

const { LiveCompanion } = require('../src/core/live-companion');

function make(config = {}) {
    return new LiveCompanion({ lang: 'zh', config: { enabled: true, replyIntervalMs: 10000, userCooldownMs: 60000, ...config } });
}

describe('LiveCompanion.configure', () => {
    it('defaults to question mode and stays disabled until enabled', () => {
        const c = new LiveCompanion();
        assert.strictEqual(c.enabled, false);
        assert.strictEqual(c.mode, 'question');
        assert.deepStrictEqual(c.replyTypes, ['danmaku', 'superchat']);
    });

    it('clamps the reply interval to the minimum', () => {
        const c = make({ replyIntervalMs: 10 });
        assert.strictEqual(c.replyIntervalMs, LiveCompanion.MIN_REPLY_INTERVAL_MS);
    });

    it('ignores an unknown mode', () => {
        const c = make({ mode: 'nonsense' });
        assert.strictEqual(c.mode, 'question');
    });

    it('trims ignore list and mentions', () => {
        const c = make({ ignoreList: [' 广告 ', ''], mentions: [' 猫猫 ', ''] });
        assert.deepStrictEqual(c.ignoreList, ['广告']);
        assert.deepStrictEqual(c.mentions, ['猫猫']);
    });
});

describe('LiveCompanion.isNoise', () => {
    it('rejects low-information danmaku', () => {
        const c = make();
        for (const t of ['666', '666666', '哈哈哈', '2333', '打卡', '来了', '。。。', '?']) {
            assert.strictEqual(c.isNoise(t), true, `should be noise: ${t}`);
        }
    });

    it('rejects commands and @-mentions of others', () => {
        const c = make();
        assert.strictEqual(c.isNoise('/help'), true);
        assert.strictEqual(c.isNoise('@某人 你好'), true);
    });

    it('rejects text outside the length window', () => {
        const c = make({ minLength: 2, maxLength: 20 });
        assert.strictEqual(c.isNoise('好'), true);
        assert.strictEqual(c.isNoise('好'.repeat(30)), true);
    });

    it('honours a custom ignore list', () => {
        const c = make({ ignoreList: ['广告', 'spam'] });
        assert.strictEqual(c.isNoise('这是广告内容'), true);
        assert.strictEqual(c.isNoise('SPAM here'), true);
        assert.strictEqual(c.isNoise('正常聊天'), false);
    });

    it('accepts ordinary chat', () => {
        const c = make();
        assert.strictEqual(c.isNoise('主播今天玩什么'), false);
    });

    it('treats empty input as noise', () => {
        assert.strictEqual(make().isNoise(''), true);
        assert.strictEqual(make().isNoise(null), true);
    });
});

describe('LiveCompanion.isQuestion', () => {
    it('detects Chinese question forms', () => {
        assert.strictEqual(LiveCompanion.isQuestion('这个boss怎么打？'), true);
        assert.strictEqual(LiveCompanion.isQuestion('主播吃了吗'), true);
        assert.strictEqual(LiveCompanion.isQuestion('为什么选这个'), true);
    });
    it('detects English question forms', () => {
        assert.strictEqual(LiveCompanion.isQuestion('what is this'), true);
        assert.strictEqual(LiveCompanion.isQuestion('how do I beat it'), true);
    });
    it('returns false for statements', () => {
        assert.strictEqual(LiveCompanion.isQuestion('这波操作很秀'), false);
    });
});

describe('LiveCompanion.mentionsPet', () => {
    it('matches configured names case-insensitively', () => {
        const c = make({ mentions: ['猫猫', 'Mimi'] });
        assert.strictEqual(c.mentionsPet('猫猫在吗'), true);
        assert.strictEqual(c.mentionsPet('mimi hello'), true);
        assert.strictEqual(c.mentionsPet('你好'), false);
    });
});

describe('LiveCompanion.shouldReply', () => {
    it('never replies when disabled', () => {
        const c = make({ enabled: false });
        assert.strictEqual(c.shouldReply({ text: '主播怎么打' }, 100000), false);
    });

    it('never replies in mode none', () => {
        const c = make({ mode: 'none' });
        assert.strictEqual(c.shouldReply({ text: '主播怎么打' }, 100000), false);
    });

    it('rate limits globally', () => {
        const c = make({ mode: 'all', replyIntervalMs: 10000 });
        assert.strictEqual(c.shouldReply({ text: '第一条消息', uid: 1 }, 100000), true);
        assert.strictEqual(c.shouldReply({ text: '第二条消息', uid: 2 }, 105000), false, 'too soon');
        assert.strictEqual(c.shouldReply({ text: '第三条消息', uid: 3 }, 111000), true);
    });

    it('enforces a per-user cooldown', () => {
        // The reply interval floor is 3000ms, so space the timestamps accordingly.
        const c = make({ mode: 'all', replyIntervalMs: 3000, userCooldownMs: 60000 });
        assert.strictEqual(c.shouldReply({ text: '甲说话', uid: 7 }, 100000), true);
        // Different user, past the global interval -> allowed
        assert.strictEqual(c.shouldReply({ text: '乙说话', uid: 8 }, 104000), true);
        // Same first user again -> blocked by the per-user cooldown
        assert.strictEqual(c.shouldReply({ text: '甲又说', uid: 7 }, 108000), false);
    });

    it('still answers a few viewers who repeat the same line', () => {
        // A blanket "same text" dedupe used to swallow almost everything; only a
        // real crowd flood should be suppressed.
        const c = make({ mode: 'all', replyIntervalMs: 3000, userCooldownMs: 0, floodUserThreshold: 4 });
        assert.strictEqual(c.shouldReply({ text: '测试', uid: 1 }, 100000), true, '第一遍应该回应');
        assert.strictEqual(c.shouldReply({ text: '测试', uid: 2 }, 104000), true, '第二个观众重复也应该回应');
        assert.strictEqual(c.shouldReply({ text: '测试', uid: 3 }, 108000), true, '第三个观众仍然回应');
    });

    it('suppresses the same line once a real crowd floods it', () => {
        const c = make({ mode: 'all', replyIntervalMs: 1000, userCooldownMs: 0, floodWindowMs: 8000, floodUserThreshold: 4 });
        assert.strictEqual(c.shouldReply({ text: '积分', uid: 1 }, 100000), true);
        assert.strictEqual(c.shouldReply({ text: '积分', uid: 2 }, 100500), false);
        assert.strictEqual(c.shouldReply({ text: '积分', uid: 3 }, 101000), false);
        assert.strictEqual(c.shouldReply({ text: '积分', uid: 4 }, 101500), false, '第四个不同观众 → 判定为刷屏');
        assert.strictEqual(c.shouldReply({ text: '积分', uid: 5 }, 102000), false);
    });

    it('a flood of one line does not block a different line', () => {
        const c = make({ mode: 'all', replyIntervalMs: 3000, userCooldownMs: 0, floodUserThreshold: 4 });
        for (const uid of [1, 2, 3, 4]) c.shouldReply({ text: '积分', uid }, 100000 + uid);
        assert.strictEqual(c.shouldReply({ text: '主播这个怎么打？', uid: 9 }, 104000), true, '换一句就该回应');
    });

    it('lets the same line through again after the burst window', () => {
        // Note: avoid '6666' here — the built-in spam filter drops it as noise.
        const c = make({ mode: 'all', replyIntervalMs: 3000, userCooldownMs: 0, floodWindowMs: 5000, floodUserThreshold: 3 });
        assert.strictEqual(c.shouldReply({ text: '这波很秀', uid: 1 }, 100000), true);
        c.shouldReply({ text: '这波很秀', uid: 2 }, 100100);
        assert.strictEqual(c.shouldReply({ text: '这波很秀', uid: 3 }, 100200), false, '窗口内达到阈值 → 抑制');
        assert.strictEqual(c.shouldReply({ text: '这波很秀', uid: 4 }, 110000), true, '窗口过后重新放行');
    });

    it('mode question only answers questions or name mentions', () => {
        const c = make({ mode: 'question', mentions: ['猫猫'], replyIntervalMs: 3000, userCooldownMs: 0 });
        assert.strictEqual(c.shouldReply({ text: '这波操作很秀', uid: 1 }, 100000), false);
        assert.strictEqual(c.shouldReply({ text: '这个怎么打？', uid: 2 }, 104000), true);
        assert.strictEqual(c.shouldReply({ text: '猫猫说句话', uid: 3 }, 108000), true);
    });

    it('mode mention only answers when called by name', () => {
        const c = make({ mode: 'mention', mentions: ['猫猫'], replyIntervalMs: 1000, userCooldownMs: 0 });
        assert.strictEqual(c.shouldReply({ text: '这是什么？', uid: 1 }, 100000), false);
        assert.strictEqual(c.shouldReply({ text: '猫猫你好', uid: 2 }, 102000), true);
    });

    it('always considers super chats even in question mode', () => {
        const c = make({ mode: 'question', replyIntervalMs: 1000 });
        assert.strictEqual(c.shouldReply({ type: 'superchat', text: '加油', uid: 5 }, 100000), true);
    });

    it('ignores message types outside replyTypes', () => {
        const c = make({ mode: 'all', replyTypes: ['danmaku'] });
        assert.strictEqual(c.shouldReply({ type: 'gift', text: '送了礼物', uid: 1 }, 100000), false);
    });

    it('counts replies but not rejections', () => {
        const c = make({ mode: 'all', replyIntervalMs: 1000, userCooldownMs: 0 });
        c.shouldReply({ text: '第一条', uid: 1 }, 100000);
        c.shouldReply({ text: '666', uid: 2 }, 102000);
        assert.strictEqual(c.stats().replies, 1);
        assert.strictEqual(c.stats().seen, 2);
    });
});

describe('LiveCompanion.buildReplyPrompt', () => {
    it('carries the viewer name, text and room title', () => {
        const c = make();
        const p = c.buildReplyPrompt({ type: 'danmaku', user: '小明', text: '这关怎么过' }, { roomTitle: '测试直播间' });
        assert.ok(p.includes('小明'));
        assert.ok(p.includes('这关怎么过'));
        assert.ok(p.includes('测试直播间'));
    });

    it('labels a super chat differently', () => {
        const c = make();
        const p = c.buildReplyPrompt({ type: 'superchat', user: '老板', text: '加油' }, {});
        assert.ok(p.includes('醒目留言'));
    });

    it('falls back to a generic viewer name', () => {
        const c = make();
        const p = c.buildReplyPrompt({ type: 'danmaku', text: '你好' }, {});
        assert.ok(p.includes('观众'));
    });

    it('builds an English prompt', () => {
        const c = new LiveCompanion({ lang: 'en', config: { enabled: true } });
        const p = c.buildReplyPrompt({ type: 'danmaku', user: 'Bob', text: 'how do I beat it' }, { roomTitle: 'Test' });
        assert.match(p, /Bob/);
        assert.match(p, /1-2 sentences/);
    });
});

describe('LiveCompanion.reset', () => {
    it('clears the rate limiter and counters', () => {
        const c = make({ mode: 'all', replyIntervalMs: 10000 });
        assert.strictEqual(c.shouldReply({ text: '第一条', uid: 1 }, 100000), true);
        c.reset();
        assert.strictEqual(c.stats().replies, 0);
        assert.strictEqual(c.shouldReply({ text: '重置后立刻可以', uid: 1 }, 100500), true);
    });
});
