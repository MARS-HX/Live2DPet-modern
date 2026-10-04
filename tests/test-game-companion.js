/**
 * Unit tests for the game companion.
 * Run with: node --test tests/test-game-companion.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');

const { GameCompanion } = require('../src/core/game-companion');

describe('GameCompanion.configure', () => {
    it('applies defaults', () => {
        const c = new GameCompanion();
        assert.strictEqual(c.enabled, false);
        assert.strictEqual(c.gameOnly, true);
        assert.strictEqual(c.offerDshHelp, true);
        assert.strictEqual(c.useScreenshots, true, 'screenshot awareness is on by default');
    });

    it('lets screenshot awareness be turned off', () => {
        const c = new GameCompanion({ config: { useScreenshots: false } });
        assert.strictEqual(c.useScreenshots, false);
    });

    it('clamps the comment interval to the minimum', () => {
        const c = new GameCompanion({ config: { commentIntervalMs: 1000 } });
        assert.strictEqual(c.commentIntervalMs, GameCompanion.MIN_COMMENT_INTERVAL_MS);
    });

    it('keeps a valid interval', () => {
        const c = new GameCompanion({ config: { commentIntervalMs: 90000 } });
        assert.strictEqual(c.commentIntervalMs, 90000);
    });

    it('trims custom patterns and drops blanks', () => {
        const c = new GameCompanion({ config: { gamePatterns: ['  Foo ', '', 'Bar'] } });
        assert.deepStrictEqual(c.gamePatterns, ['Foo', 'Bar']);
    });
});

describe('GameCompanion.isGameWindow', () => {
    const c = new GameCompanion();

    it('matches built-in titles in several languages', () => {
        assert.strictEqual(c.isGameWindow({ title: 'Genshin Impact' }), true);
        assert.strictEqual(c.isGameWindow({ title: '原神', process: 'YuanShen.exe' }), true);
        assert.strictEqual(c.isGameWindow({ title: 'Hollow Knight' }), true);
    });

    it('matches launchers', () => {
        assert.strictEqual(c.isGameWindow({ title: 'Steam' }), true);
    });

    it('rejects ordinary work windows', () => {
        assert.strictEqual(c.isGameWindow({ title: 'main.js - Visual Studio Code', process: 'Code.exe' }), false);
        assert.strictEqual(c.isGameWindow({ title: 'New Tab', process: 'chrome.exe' }), false);
        assert.strictEqual(c.isGameWindow({ title: 'PowerShell' }), false);
    });

    it('does not treat a wiki page about a game as a game', () => {
        // Title mentions a game but the process is a browser.
        assert.strictEqual(c.isGameWindow({ title: 'Genshin Impact Wiki - Chrome', process: 'chrome.exe' }), false);
    });

    it('honours user patterns over the non-game guard', () => {
        const custom = new GameCompanion({ config: { gamePatterns: ['mytool'] } });
        assert.strictEqual(custom.isGameWindow({ title: 'mytool', process: 'chrome.exe' }), true);
    });

    it('is case insensitive', () => {
        assert.strictEqual(c.isGameWindow({ title: 'VALORANT' }), true);
        assert.strictEqual(c.isGameWindow({ title: 'valorant' }), true);
    });

    it('returns false for empty input', () => {
        assert.strictEqual(c.isGameWindow({}), false);
        assert.strictEqual(c.isGameWindow(), false);
    });
});

describe('GameCompanion session tracking', () => {
    it('starts a session on the first game focus and reports minutes', () => {
        const c = new GameCompanion();
        const t0 = 1_000_000;
        assert.strictEqual(c.noteFocus({ title: 'Genshin' }, t0), 0);
        assert.strictEqual(c.noteFocus({ title: 'Genshin' }, t0 + 5 * 60000), 5 * 60000);
        assert.strictEqual(c.sessionMinutes(t0 + 5 * 60000), 5);
    });

    it('clears the session when focus leaves games', () => {
        const c = new GameCompanion();
        c.noteFocus({ title: 'Genshin' }, 1000);
        assert.strictEqual(c.noteFocus({ title: 'Code', process: 'Code.exe' }, 2000), 0);
        assert.strictEqual(c.sessionMinutes(5000), 0);
    });

    it('restarts the clock when the game changes', () => {
        const c = new GameCompanion();
        c.noteFocus({ title: 'Genshin' }, 1000);
        const elapsed = c.noteFocus({ title: 'Hades' }, 90000);
        assert.strictEqual(elapsed, 0);
    });
});

describe('GameCompanion.shouldComment', () => {
    it('never comments while disabled', () => {
        const c = new GameCompanion({ config: { enabled: false, commentIntervalMs: 30000 } });
        assert.strictEqual(c.shouldComment({ title: 'Genshin' }, 0), false);
        assert.strictEqual(c.shouldComment({ title: 'Genshin' }, 999999), false);
    });

    it('arms on the first eligible call and comments after one interval', () => {
        const c = new GameCompanion({ config: { enabled: true, commentIntervalMs: 60000 } });
        const t0 = 500_000;
        assert.strictEqual(c.shouldComment({ title: 'Genshin' }, t0), false, 'first call only arms');
        assert.strictEqual(c.shouldComment({ title: 'Genshin' }, t0 + 30000), false, 'too early');
        assert.strictEqual(c.shouldComment({ title: 'Genshin' }, t0 + 60000), true, 'due');
        assert.strictEqual(c.shouldComment({ title: 'Genshin' }, t0 + 90000), false, 'interval restarted');
    });

    it('respects gameOnly', () => {
        const c = new GameCompanion({ config: { enabled: true, gameOnly: true, commentIntervalMs: 30000 } });
        assert.strictEqual(c.shouldComment({ title: 'Code', process: 'Code.exe' }, 0), false);
    });

    it('comments outside games when gameOnly is off', () => {
        const c = new GameCompanion({ config: { enabled: true, gameOnly: false, commentIntervalMs: 30000 } });
        const t0 = 1_000_000;
        assert.strictEqual(c.shouldComment({ title: 'Docs' }, t0), false);
        assert.strictEqual(c.shouldComment({ title: 'Docs' }, t0 + 30000), true);
    });

    it('counts comments in stats', () => {
        const c = new GameCompanion({ config: { enabled: true, commentIntervalMs: 30000 } });
        const t0 = 2_000_000;
        c.shouldComment({ title: 'Genshin' }, t0);
        c.shouldComment({ title: 'Genshin' }, t0 + 30000);
        assert.strictEqual(c.getStats().commentsMade, 1);
    });
});

describe('GameCompanion.dayPhase', () => {
    it('buckets the hours sensibly', () => {
        const at = (h) => GameCompanion.dayPhase(new Date(2026, 0, 1, h, 0, 0));
        assert.strictEqual(at(2), 'lateNight');
        assert.strictEqual(at(8), 'morning');
        assert.strictEqual(at(12), 'noon');
        assert.strictEqual(at(15), 'afternoon');
        assert.strictEqual(at(20), 'evening');
        assert.strictEqual(at(23), 'night');
    });
});

describe('GameCompanion prompts', () => {
    it('builds a Chinese game prompt mentioning title and minutes', () => {
        const c = new GameCompanion({ lang: 'zh' });
        c.noteFocus({ title: 'Genshin' }, 0);
        const p = c.buildGamePrompt({ title: 'Genshin' }, 3 * 60000);
        assert.match(p, /Genshin/);
        assert.match(p, /3 分钟/);
        assert.match(p, /1-2 句/);
    });

    it('builds an English game prompt', () => {
        const c = new GameCompanion({ lang: 'en' });
        const p = c.buildGamePrompt({ title: 'Hades' }, 0);
        assert.match(p, /Hades/);
        assert.match(p, /1-2 short sentences/);
    });

    it('builds a daily prompt with the day phase', () => {
        const c = new GameCompanion({ lang: 'en' });
        const p = c.buildDailyPrompt({ title: 'Code', focusMinutes: 42 });
        assert.match(p, /Code/);
        assert.match(p, /42 minutes/);
    });

    it('builds a DSH task when help is offered', () => {
        const c = new GameCompanion({ config: { offerDshHelp: true } });
        const task = c.buildDshTask({ title: 'Hades' }, '卡在第二关boss');
        assert.ok(task.includes('Hades'));
        assert.ok(task.includes('卡在第二关boss'));
    });

    it('returns null for a DSH task when help is disabled', () => {
        const c = new GameCompanion({ config: { offerDshHelp: false } });
        assert.strictEqual(c.buildDshTask({ title: 'Hades' }, 'help'), null);
    });

    it('builds a Chinese voice reply prompt carrying what was said', () => {
        const c = new GameCompanion({ lang: 'zh' });
        const p = c.buildVoiceReplyPrompt('这个boss怎么打', { title: 'Hades' });
        assert.match(p, /Hades/);
        assert.ok(p.includes('这个boss怎么打'));
        assert.match(p, /屏幕截图/);
    });

    it('builds an English voice reply prompt', () => {
        const c = new GameCompanion({ lang: 'en' });
        const p = c.buildVoiceReplyPrompt('what is this item', { title: 'Hades' });
        assert.match(p, /what is this item/);
        assert.match(p, /screenshot/i);
    });

    it('returns empty for an empty voice transcript', () => {
        const c = new GameCompanion();
        assert.strictEqual(c.buildVoiceReplyPrompt('', { title: 'X' }), '');
        assert.strictEqual(c.buildVoiceReplyPrompt('   '), '');
    });
});

describe('GameCompanion.reset', () => {
    it('clears counters and session', () => {
        const c = new GameCompanion({ config: { enabled: true, commentIntervalMs: 30000 } });
        c.shouldComment({ title: 'Genshin' }, 0);
        c.shouldComment({ title: 'Genshin' }, 30000);
        c.noteFocus({ title: 'Genshin' }, 0);
        c.reset();
        assert.strictEqual(c.getStats().commentsMade, 0);
        assert.strictEqual(c.getStats().sessionMinutes, 0);
    });
});
