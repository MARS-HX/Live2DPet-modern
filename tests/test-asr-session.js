/**
 * Tests for the ASR session wrapper (the part between the mic and libvosk).
 * A fake recogniser stands in for the native library, so these run anywhere.
 *
 * Run with: node --test tests/test-asr-session.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');

const { AsrSession } = require('../src/main/asr-ipc');

const QUIET = { log() {}, warn() {}, error() {} };

/** A recogniser that returns `script` one entry per feed() call. */
function fakeRecognizer(script = []) {
    let i = 0;
    return {
        feeds: 0,
        disposed: false,
        flushValue: '',
        feed() { this.feeds++; return i < script.length ? script[i++] : null; },
        flush() { return this.flushValue; },
        dispose() { this.disposed = true; },
    };
}

describe('AsrSession', () => {
    it('starts a recogniser lazily', () => {
        const rec = fakeRecognizer();
        const s = new AsrSession({ createRecognizer: () => rec, logger: QUIET });
        assert.strictEqual(s.active, false);
        s.start();
        assert.strictEqual(s.active, true);
        assert.strictEqual(s.start(), true, 'starting twice is harmless');
    });

    it('ignores audio before start, instead of throwing', () => {
        const s = new AsrSession({ createRecognizer: () => fakeRecognizer(), logger: QUIET });
        assert.strictEqual(s.feed(Buffer.alloc(3200)), null);
    });

    it('emits recognised text exactly once', () => {
        const heard = [];
        const s = new AsrSession({
            createRecognizer: () => fakeRecognizer(['你好', null, '世界']),
            onText: (t) => heard.push(t),
            logger: QUIET,
        });
        s.start();
        assert.strictEqual(s.feed(Buffer.alloc(3200)), '你好');
        assert.strictEqual(s.feed(Buffer.alloc(3200)), null);
        assert.strictEqual(s.feed(Buffer.alloc(3200)), '世界');
        assert.deepStrictEqual(heard, ['你好', '世界']);
        assert.strictEqual(s.stats.utterances, 2);
    });

    it('drops empty transcripts instead of passing them on', () => {
        const heard = [];
        const s = new AsrSession({
            createRecognizer: () => fakeRecognizer(['   ', '']),
            onText: (t) => heard.push(t),
            logger: QUIET,
        });
        s.start();
        assert.strictEqual(s.feed(Buffer.alloc(3200)), null);
        assert.strictEqual(s.feed(Buffer.alloc(3200)), null);
        assert.deepStrictEqual(heard, [], 'whitespace is not a reply trigger');
    });

    it('ignores empty or non-buffer chunks', () => {
        const rec = fakeRecognizer();
        const s = new AsrSession({ createRecognizer: () => rec, logger: QUIET });
        s.start();
        assert.strictEqual(s.feed(null), null);
        assert.strictEqual(s.feed(Buffer.alloc(0)), null);
        assert.strictEqual(rec.feeds, 0, 'no point feeding the native library nothing');
    });

    it('flush() reports what was understood and can trigger a reply', () => {
        const heard = [];
        const rec = fakeRecognizer();
        rec.flushValue = '收尾文本';
        const s = new AsrSession({ createRecognizer: () => rec, onText: (t) => heard.push(t), logger: QUIET });
        s.start();
        assert.strictEqual(s.flush(), '收尾文本');
        assert.deepStrictEqual(heard, ['收尾文本']);
    });

    it('stop() flushes then disposes, and is idempotent', () => {
        const rec = fakeRecognizer();
        rec.flushValue = '最后的字';
        const heard = [];
        const s = new AsrSession({ createRecognizer: () => rec, onText: (t) => heard.push(t), logger: QUIET });
        s.start();
        s.stop();
        assert.strictEqual(rec.disposed, true);
        assert.strictEqual(s.active, false);
        assert.deepStrictEqual(heard, ['最后的字'], 'releasing the mic must not lose the last utterance');
        s.stop();                       // must not throw or double-dispose
        assert.strictEqual(s.active, false);
    });

    it('a native error while feeding does not kill the session state', () => {
        const rec = fakeRecognizer();
        rec.feed = () => { throw new Error('native blew up'); };
        const s = new AsrSession({ createRecognizer: () => rec, logger: QUIET });
        s.start();
        assert.throws(() => s.feed(Buffer.alloc(3200)), /native blew up/);
        // The caller (IPC layer) catches this; the session stays usable.
        assert.strictEqual(s.active, true);
    });
});
