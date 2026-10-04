/**
 * GameCompanion — let the pet keep the user company while they play, and blend
 * into everyday life.
 *
 * The module is deliberately free of DOM and Electron dependencies: it only
 * decides *whether* a moment is worth speaking up about and *what* to ask the
 * model for. The host (desktop-pet-system) owns screenshots, windows, bubbles
 * and TTS, and can escalate a stuck moment to the DSH bridge.
 *
 * Two layers:
 *   - game awareness   : is a game focused, how long, is it time to comment
 *   - daily rhythm     : which part of the day it is, so greetings fit the hour
 */
(function (root) {
    'use strict';

    /** Window/process keywords that identify a game without user configuration. */
    const BUILTIN_GAME_PATTERNS = [
        // storefronts / launchers
        'steam', 'epic games', 'battle.net', 'riot client', 'ubisoft connect', 'gog galaxy',
        // engines / common runtime titles
        'unity', 'unreal',
        // popular titles (EN + ZH + JA)
        'genshin', '原神', 'honkai', '崩坏', 'star rail', '绝区零', 'zenless',
        'league of legends', '英雄联盟', 'valorant', '无畏契约', 'cs2', 'counter-strike',
        'dota', 'minecraft', '我的世界', 'elden ring', '艾尔登法环', 'baldur',
        'stardew', '星露谷', 'terraria', '泰拉瑞亚', 'cyberpunk', '赛博朋克',
        'final fantasy', '最终幻想', 'monster hunter', '怪物猎人', 'pokemon', '宝可梦',
        'apex legends', 'overwatch', '守望先锋', 'pubg', '绝地求生', 'fortnite', '堡垒之夜',
        'hades', 'hollow knight', '空洞骑士', 'slay the spire', '杀戮尖塔',
        'osu', 'muse dash', 'phigros', 'arcaea', 'maimai', 'project sekai',
        '雀魂', 'mahjong soul', 'blue archive', '蔚蓝档案', 'arknights', '明日方舟',
        'fate', 'granblue', 'ウマ娘', 'uma musume', 'パズドラ',
    ];

    /** Process names that are practically never games — guards false positives. */
    const NON_GAME_HINTS = [
        'code', 'devenv', 'explorer', 'chrome', 'msedge', 'firefox', 'electron',
        'terminal', 'powershell', 'cmd', 'word', 'excel', 'powerpnt', 'notepad',
        'photoshop', 'illustrator', 'obs', 'discord', 'telegram', 'wechat', 'qq',
    ];

    const DEFAULT_COMMENT_INTERVAL_MS = 120000;
    const MIN_COMMENT_INTERVAL_MS = 30000;

    function normalize(value) {
        return String(value || '').toLowerCase();
    }

    class GameCompanion {
        constructor(options = {}) {
            this.enabled = false;
            this.gameOnly = true;
            this.commentIntervalMs = DEFAULT_COMMENT_INTERVAL_MS;
            this.gamePatterns = [];
            this.offerDshHelp = true;
            this.useScreenshots = true;
            this.lang = options.lang || 'zh';

            this._lastCommentAt = 0;
            this._sessionStartedAt = null;
            this._sessionTitle = '';
            this._comments = 0;
            if (options.config) this.configure(options.config);
        }

        configure(config = {}) {
            if (config.enabled !== undefined) this.enabled = !!config.enabled;
            if (config.gameOnly !== undefined) this.gameOnly = !!config.gameOnly;
            if (config.offerDshHelp !== undefined) this.offerDshHelp = !!config.offerDshHelp;
            if (config.useScreenshots !== undefined) this.useScreenshots = !!config.useScreenshots;
            if (config.lang) this.lang = config.lang;
            if (Array.isArray(config.gamePatterns)) {
                this.gamePatterns = config.gamePatterns.map((p) => String(p).trim()).filter(Boolean);
            }
            if (Number.isFinite(config.commentIntervalMs)) {
                this.commentIntervalMs = Math.max(MIN_COMMENT_INTERVAL_MS, config.commentIntervalMs);
            }
            return this;
        }

        /**
         * Decide whether a focused window looks like a game.
         * @param {{title?:string, process?:string}} win
         */
        isGameWindow(win = {}) {
            const title = normalize(win.title);
            const process = normalize(win.process);
            const haystack = `${title} ${process}`;
            if (!haystack.trim()) return false;

            // User-supplied patterns always win.
            for (const p of this.gamePatterns) {
                if (haystack.includes(normalize(p))) return true;
            }
            // Editor/browser/chat windows are never games, even if the title
            // happens to mention one (e.g. a wiki page about a game).
            for (const hint of NON_GAME_HINTS) {
                if (process.includes(hint)) return false;
            }
            return BUILTIN_GAME_PATTERNS.some((p) => haystack.includes(p));
        }

        /** Track the current play session; returns its length in ms. */
        noteFocus(win = {}, now = Date.now()) {
            const key = win.title || win.process || '';
            if (!this.isGameWindow(win)) {
                this._sessionStartedAt = null;
                this._sessionTitle = '';
                return 0;
            }
            if (this._sessionStartedAt === null || key !== this._sessionTitle) {
                this._sessionStartedAt = now;
                this._sessionTitle = key;
            }
            return now - this._sessionStartedAt;
        }

        /** True when a companion line is due. */
        shouldComment(win = {}, now = Date.now()) {
            if (!this.enabled) return false;
            const isGame = this.isGameWindow(win);
            if (this.gameOnly && !isGame) return false;
            if (this._lastCommentAt === 0) {
                // First moment: wait one interval so the pet does not pounce
                // the second the user opens a game.
                this._lastCommentAt = now;
                return false;
            }
            if (now - this._lastCommentAt < this.commentIntervalMs) return false;
            this._lastCommentAt = now;
            this._comments += 1;
            return true;
        }

        /** How long the current session has run, in whole minutes. */
        sessionMinutes(now = Date.now()) {
            if (this._sessionStartedAt === null) return 0;
            return Math.floor((now - this._sessionStartedAt) / 60000);
        }

        /** Time-of-day bucket used to make greetings feel natural. */
        static dayPhase(date = new Date()) {
            const h = date.getHours();
            if (h < 5) return 'lateNight';
            if (h < 11) return 'morning';
            if (h < 14) return 'noon';
            if (h < 18) return 'afternoon';
            if (h < 23) return 'evening';
            return 'night';
        }

        /**
         * Instruction handed to the pet's own model for an in-game remark.
         * Kept short: the pet speaks one or two sentences, never a report.
         */
        buildGamePrompt(win = {}, now = Date.now()) {
            const title = win.title || win.process || 'the game';
            const mins = this.sessionMinutes(now);
            const zh = this.lang === 'zh';
            if (zh) {
                return [
                    `用户正在玩「${title}」，已经玩了约 ${mins} 分钟。`,
                    '你可以看到屏幕截图。像坐在旁边的朋友一样，对**画面里真实发生的事**说 1-2 句短评。',
                    '可以说：吐槽、加油、被某个画面逗到、或留意到有趣的变化。',
                    '不要复述游戏教程，不要问问题等回答，不要长篇大论，不要提自己是 AI 或在看截图。',
                ].join('\n');
            }
            return [
                `The user is playing "${title}" and has been at it for about ${mins} minutes.`,
                'You can see the screenshot. Like a friend sitting nearby, react to something that is ACTUALLY happening on screen in 1-2 short sentences.',
                'Tease, cheer, get amused, or notice an interesting change.',
                'Do not narrate tutorials, do not ask questions, do not ramble, and never mention being an AI or reading a screenshot.',
            ].join('\n');
        }

        /** Instruction for a general (non-game) companionship moment. */
        buildDailyPrompt(context = {}) {
            const phase = GameCompanion.dayPhase();
            const zh = this.lang === 'zh';
            const phaseZh = {
                lateNight: '深夜', morning: '早上', noon: '中午',
                afternoon: '下午', evening: '晚上', night: '夜里',
            }[phase];
            const minutes = Number.isFinite(context.focusMinutes) ? context.focusMinutes : 0;
            if (zh) {
                return [
                    `现在是${phaseZh}，用户正在用「${context.title || '电脑'}」，已持续约 ${minutes} 分钟。`,
                    '像陪在旁边的朋友一样说 1-2 句自然的话，可以顺带关心一下作息或状态。',
                    '不要提问等回答，不要长篇大论。',
                ].join('\n');
            }
            return [
                `It is ${phase} and the user has been using "${context.title || 'the computer'}" for about ${minutes} minutes.`,
                'Say 1-2 natural sentences like a friend nearby; a light remark about the hour or their state is welcome.',
                'Do not ask questions or ramble.',
            ].join('\n');
        }

        /**
         * Instruction for answering something the user just said out loud.
         * The host attaches a screenshot so the pet answers about what it sees.
         */
        buildVoiceReplyPrompt(transcript, win = {}) {
            const said = String(transcript || '').trim();
            if (!said) return '';
            const title = win.title || win.process || '';
            const zh = this.lang === 'zh';
            if (zh) {
                return [
                    title ? `用户正在玩「${title}」，刚刚用语音说：「${said}」` : `用户刚刚用语音说：「${said}」`,
                    '你能看到屏幕截图。用 1-2 句话直接回应；如果是在问画面里的东西，就照着画面回答。',
                    '不要反问等回答，不要长篇大论，不要提自己在看截图。',
                ].join('\n');
            }
            return [
                title ? `The user is playing "${title}" and just said out loud: "${said}"` : `The user just said out loud: "${said}"`,
                'You can see the screenshot. Reply directly in 1-2 sentences; if they asked about something on screen, answer from what is visible.',
                'Do not ask questions back, do not ramble, and never mention reading a screenshot.',
            ].join('\n');
        }

        /**
         * Build a DSH task that helps a stuck player. Only offered when enabled,
         * and the screenshot path is passed as context rather than inlined.
         */
        buildDshTask(win = {}, detail = '') {
            if (!this.offerDshHelp) return null;
            const title = win.title || win.process || '';
            const ask = String(detail || '').trim();
            const lines = [
                `玩家正在玩《${title || '某款游戏'}》并卡住了。`,
                ask ? `玩家描述：${ask}` : '请根据游戏名给出当前阶段常见卡点的排查思路。',
                '请用中文给出 3-5 条**具体可执行**的建议，每条一句话，不要泛泛而谈。',
                '不要编造该游戏不存在的机制。',
            ];
            return lines.join('\n');
        }

        getStats() {
            return {
                enabled: this.enabled,
                commentsMade: this._comments,
                sessionMinutes: this.sessionMinutes(),
                sessionTitle: this._sessionTitle,
            };
        }

        reset() {
            this._lastCommentAt = 0;
            this._sessionStartedAt = null;
            this._sessionTitle = '';
            this._comments = 0;
        }
    }

    GameCompanion.BUILTIN_GAME_PATTERNS = BUILTIN_GAME_PATTERNS;
    GameCompanion.NON_GAME_HINTS = NON_GAME_HINTS;
    GameCompanion.DEFAULT_COMMENT_INTERVAL_MS = DEFAULT_COMMENT_INTERVAL_MS;
    GameCompanion.MIN_COMMENT_INTERVAL_MS = MIN_COMMENT_INTERVAL_MS;

    root.GameCompanion = GameCompanion;
    if (typeof module !== 'undefined' && module.exports) module.exports = { GameCompanion };
})(typeof window !== 'undefined' ? window : globalThis);
