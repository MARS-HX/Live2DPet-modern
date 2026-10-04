/**
 * LiveCompanion — decide which live-chat messages the pet answers, and how.
 *
 * Bilibili danmaku arrive far faster than a pet can talk, so the interesting
 * work is *restraint*: filter noise, rate-limit, stop one viewer monopolising
 * the pet, and offer sane trigger modes (answer everything / only questions /
 * only when called by name).
 *
 * Pure logic only — the host owns the WebSocket, bubbles and TTS.
 */
(function (root) {
    'use strict';

    /** Low-information danmaku that would make the pet look silly if answered. */
    const BUILTIN_SPAM = [
        /^[6６]+$/, /^[哈h]{3,}$/i, /^[。.、,，!！?？\s]*$/,
        /^(666|233+|hhh+|哈哈+|草|awsl|打卡|签到|来了|前排|沙发)$/i,
    ];

    const QUESTION_HINTS = [
        '?', '？', '吗', '呢', '怎么', '怎样', '为什么', '为啥', '什么', '啥',
        '哪个', '哪里', '能不能', '可不可以', '如何', '多少', '是不是', '有没有',
        'what', 'why', 'how', 'which', 'where', 'when', 'who', 'can you', 'is it',
    ];

    const DEFAULT_REPLY_INTERVAL_MS = 15000;
    const MIN_REPLY_INTERVAL_MS = 3000;
    const DEFAULT_USER_COOLDOWN_MS = 60000;

    function normalize(s) { return String(s == null ? '' : s).trim(); }

    class LiveCompanion {
        constructor(options = {}) {
            this.enabled = false;
            this.mode = 'question';          // all | question | mention | none
            this.replyIntervalMs = DEFAULT_REPLY_INTERVAL_MS;
            this.userCooldownMs = DEFAULT_USER_COOLDOWN_MS;
            this.minLength = 2;
            this.maxLength = 120;            // ignore walls of text
            this.floodWindowMs = 8000;       // burst window for identical text
            this.floodUserThreshold = 4;     // distinct viewers that make it a flood
            this.ignoreList = [];
            this.mentions = [];              // trigger names, e.g. the pet's name
            this.replyTypes = ['danmaku', 'superchat']; // which message kinds to consider
            this.lang = options.lang || 'zh';

            this._lastReplyAt = 0;
            this._lastUserReplyAt = new Map();
            this._bursts = new Map();        // text -> { at, users:Set }
            this._replies = 0;
            this._seen = 0;
            if (options.config) this.configure(options.config);
        }

        configure(config = {}) {
            if (config.enabled !== undefined) this.enabled = !!config.enabled;
            if (typeof config.mode === 'string' && ['all', 'question', 'mention', 'none'].includes(config.mode)) {
                this.mode = config.mode;
            }
            if (config.lang) this.lang = config.lang;
            if (Number.isFinite(config.replyIntervalMs)) {
                this.replyIntervalMs = Math.max(MIN_REPLY_INTERVAL_MS, config.replyIntervalMs);
            }
            if (Number.isFinite(config.userCooldownMs)) {
                this.userCooldownMs = Math.max(0, config.userCooldownMs);
            }
            if (Number.isFinite(config.minLength)) this.minLength = Math.max(1, config.minLength);
            if (Number.isFinite(config.maxLength)) this.maxLength = Math.max(10, config.maxLength);
            if (Number.isFinite(config.floodWindowMs)) this.floodWindowMs = Math.max(0, config.floodWindowMs);
            if (Number.isFinite(config.floodUserThreshold)) this.floodUserThreshold = Math.max(0, config.floodUserThreshold);
            if (Array.isArray(config.ignoreList)) {
                this.ignoreList = config.ignoreList.map(normalize).filter(Boolean);
            }
            if (Array.isArray(config.mentions)) {
                this.mentions = config.mentions.map(normalize).filter(Boolean);
            }
            if (Array.isArray(config.replyTypes)) {
                this.replyTypes = config.replyTypes.filter((t) => typeof t === 'string');
            }
            return this;
        }

        /** Is this text noise the pet should never answer? */
        isNoise(text) {
            const t = normalize(text);
            if (!t) return true;
            if (t.length < this.minLength || t.length > this.maxLength) return true;
            if (t.startsWith('/')) return true;                     // bot-style command
            if (t.startsWith('@')) return true;                     // addressed to someone else
            for (const re of BUILTIN_SPAM) if (re.test(t)) return true;
            const lower = t.toLowerCase();
            for (const word of this.ignoreList) {
                if (word && lower.includes(word.toLowerCase())) return true;
            }
            return false;
        }

        /** Heuristic: does the danmaku ask something? */
        static isQuestion(text) {
            const t = normalize(text).toLowerCase();
            if (!t) return false;
            return QUESTION_HINTS.some((h) => t.includes(h));
        }

        /** Does the danmaku call the pet by name? */
        mentionsPet(text) {
            const t = normalize(text).toLowerCase();
            if (!t) return false;
            return this.mentions.some((m) => t.includes(m.toLowerCase()));
        }

        /**
         * Should the pet reply to this message right now?
         * @param {{type?:string,user?:string,uid?:number,text?:string}} msg
         */
        shouldReply(msg, now = Date.now()) {
            if (!this.enabled || this.mode === 'none') return false;
            this._seen += 1;

            const type = msg.type || 'danmaku';
            if (!this.replyTypes.includes(type)) return false;

            const text = normalize(msg.text);
            if (this.isNoise(text)) return false;

            // Mode gating (superchats are paid and worth answering regardless).
            const isSuperChat = type === 'superchat';
            if (!isSuperChat) {
                if (this.mode === 'question' && !LiveCompanion.isQuestion(text) && !this.mentionsPet(text)) return false;
                if (this.mode === 'mention' && !this.mentionsPet(text)) return false;
            }

            const userKey = String(msg.uid || msg.user || '');

            // A busy room fires the same line from dozens of viewers at once
            // ("积分", "666"...). Suppress that burst — but only once enough
            // DIFFERENT viewers join it. A couple of repeats (testing, or two
            // people joking) must still get an answer: the previous blanket
            // "same text within 30s" rule swallowed almost everything.
            if (this.floodWindowMs > 0 && this.floodUserThreshold > 0) {
                const burst = this._bursts.get(text);
                if (burst && now - burst.at < this.floodWindowMs) {
                    if (userKey) burst.users.add(userKey);
                    burst.at = now;
                    if (burst.users.size >= this.floodUserThreshold) return false;
                } else {
                    this._bursts.set(text, { at: now, users: new Set(userKey ? [userKey] : []) });
                }
            }

            // One viewer must not monopolise the pet.
            if (userKey) {
                const lastUser = this._lastUserReplyAt.get(userKey);
                if (lastUser && now - lastUser < this.userCooldownMs) return false;
            }

            // Global pacing.
            if (now - this._lastReplyAt < this.replyIntervalMs) return false;

            // Accept: record bookkeeping.
            this._lastReplyAt = now;
            if (userKey) this._lastUserReplyAt.set(userKey, now);
            this._prune(now);
            this._replies += 1;
            return true;
        }

        _prune(now) {
            // Keep the maps from growing without bound in a long stream.
            const burstTtl = Math.max(this.floodWindowMs, 10000) * 3;
            for (const [k, b] of this._bursts) if (now - b.at > burstTtl) this._bursts.delete(k);
            for (const [k, t] of this._lastUserReplyAt) if (now - t > 600000) this._lastUserReplyAt.delete(k);
        }

        /** Instruction the pet answers with. */
        buildReplyPrompt(msg, context = {}) {
            const text = normalize(msg.text);
            const user = normalize(msg.user) || (this.lang === 'zh' ? '观众' : 'a viewer');
            const room = normalize(context.roomTitle);
            const zh = this.lang === 'zh';
            const kind = msg.type === 'superchat' ? (zh ? '醒目留言' : 'super chat') : (zh ? '弹幕' : 'danmaku');

            if (zh) {
                return [
                    `你正在陪主播/观众一起看 B 站直播${room ? `（直播间：${room}）` : ''}。`,
                    `${kind}来自「${user}」：${text}`,
                    '用 1-2 句话自然回应这条弹幕，像直播间的常驻观众一样，可以接梗、调侃、认真回答。',
                    '如果对方在提问就正面回答；不要复述弹幕原文，不要问问题等回复，不要提自己是 AI。',
                ].join('\n');
            }
            return [
                `You are watching a Bilibili live stream with the room${room ? ` (${room})` : ''}.`,
                `${kind} from "${user}": ${text}`,
                'Reply naturally in 1-2 sentences like a regular viewer — riff on it, tease, or answer it properly.',
                'Answer directly if it is a question. Do not repeat the message, do not ask questions back, never mention being an AI.',
            ].join('\n');
        }

        stats() {
            return { seen: this._seen, replies: this._replies, mode: this.mode, enabled: this.enabled };
        }

        reset() {
            this._lastReplyAt = 0;
            this._lastUserReplyAt.clear();
            this._bursts.clear();
            this._replies = 0;
            this._seen = 0;
        }
    }

    LiveCompanion.BUILTIN_SPAM = BUILTIN_SPAM;
    LiveCompanion.QUESTION_HINTS = QUESTION_HINTS;
    LiveCompanion.DEFAULT_REPLY_INTERVAL_MS = DEFAULT_REPLY_INTERVAL_MS;
    LiveCompanion.MIN_REPLY_INTERVAL_MS = MIN_REPLY_INTERVAL_MS;

    root.LiveCompanion = LiveCompanion;
    if (typeof module !== 'undefined' && module.exports) module.exports = { LiveCompanion };
})(typeof window !== 'undefined' ? window : globalThis);
