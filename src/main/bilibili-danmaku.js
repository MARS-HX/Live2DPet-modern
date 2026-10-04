/**
 * BilibiliDanmaku — read a live room's danmaku (chat) so the pet can react.
 *
 * Bilibili's live chat has no public REST API; the browser connects to a
 * danmaku WebSocket. This module reproduces that flow, which was verified
 * against the real service:
 *
 *   1. `x/frontend/finger/spi`            → buvid3/buvid4 cookie (risk control)
 *   2. `x/web-interface/nav`              → WBI keys (img_url / sub_url)
 *   3. `xlive/.../getDanmuInfo` (WBI-signed) → token + WebSocket host list
 *   4. `wss://<host>:<port>/sub`          → auth packet, then 30s heartbeats
 *
 * Wire format (16-byte header, big-endian):
 *   u32 packetLen | u16 headerLen | u16 protoVer | u32 operation | u32 sequence
 * Operations: 2 heartbeat, 3 heartbeat reply, 5 message, 7 auth, 8 auth reply.
 * protoVer 2 bodies are zlib-deflated, 3 are brotli; both carry nested packets.
 *
 * Everything network-facing is injectable so the codec and the signing stay
 * unit-testable without touching the network.
 */
'use strict';

const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Bilibili's fixed WBI permutation table.
const MIXIN_KEY_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52,
];

const OP_HEARTBEAT = 2;
const OP_HEARTBEAT_REPLY = 3;
const OP_MESSAGE = 5;
const OP_AUTH = 7;
const OP_AUTH_REPLY = 8;

const HEARTBEAT_MS = 30000;

// ========== Pure helpers (unit-tested) ==========

/** Derive the 32-char WBI mixin key from the nav endpoints' keys. */
function mixinKey(imgKey, subKey) {
    const raw = String(imgKey || '') + String(subKey || '');
    if (!raw) return '';
    return MIXIN_KEY_TAB.map((i) => raw[i] === undefined ? '' : raw[i]).join('').slice(0, 32);
}

/** Pull the key out of a wbi_img URL like `.../7d1f...png`. */
function keyFromWbiUrl(url) {
    return String(url || '').split('/').pop().split('.')[0] || '';
}

/**
 * Sign query params the WBI way: sorted, filtered, plus wts + w_rid.
 * `nowSec` is injectable so the signature is deterministic in tests.
 */
function wbiSign(params, mixKey, nowSec = Math.floor(Date.now() / 1000)) {
    const merged = { ...params, wts: nowSec };
    const query = Object.keys(merged).sort()
        .map((k) => {
            const v = String(merged[k]).replace(/[!'()*]/g, '');
            return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
        })
        .join('&');
    return `${query}&w_rid=${crypto.createHash('md5').update(query + mixKey).digest('hex')}`;
}

/** Build one wire packet. */
function encodePacket(operation, body, protoVer = 1) {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body == null ? '' : String(body), 'utf8');
    const buf = Buffer.alloc(16 + payload.length);
    buf.writeUInt32BE(16 + payload.length, 0);
    buf.writeUInt16BE(16, 4);
    buf.writeUInt16BE(protoVer, 6);
    buf.writeUInt32BE(operation, 8);
    buf.writeUInt32BE(1, 12);
    payload.copy(buf, 16);
    return buf;
}

/** Split a buffer into packets. Malformed tails are dropped rather than throwing. */
function decodePackets(buffer) {
    const out = [];
    let offset = 0;
    while (offset + 16 <= buffer.length) {
        const packetLen = buffer.readUInt32BE(offset);
        const headerLen = buffer.readUInt16BE(offset + 4);
        const protoVer = buffer.readUInt16BE(offset + 6);
        const operation = buffer.readUInt32BE(offset + 8);
        if (headerLen < 16 || packetLen < headerLen || offset + packetLen > buffer.length) break;
        out.push({ operation, protoVer, body: buffer.subarray(offset + headerLen, offset + packetLen) });
        offset += packetLen;
    }
    return out;
}

/**
 * Flatten compressed message packets. protoVer 2 = zlib, 3 = brotli, and the
 * decompressed body is itself a packet stream (which may compress again).
 */
function inflatePackets(packet, maxDepth = 4) {
    const out = [];
    const walk = (pkt, depth) => {
        if (depth > maxDepth) { out.push(pkt); return; }
        if (pkt.operation === OP_MESSAGE && (pkt.protoVer === 2 || pkt.protoVer === 3)) {
            try {
                const raw = pkt.protoVer === 3 ? zlib.brotliDecompressSync(pkt.body) : zlib.inflateSync(pkt.body);
                for (const inner of decodePackets(raw)) walk(inner, depth + 1);
                return;
            } catch { /* fall through: keep the compressed packet */ }
        }
        out.push(pkt);
    };
    walk(packet, 0);
    return out;
}

/** Decode a whole frame into leaf packets. */
function expandFrame(buffer, maxDepth = 4) {
    const out = [];
    for (const pkt of decodePackets(buffer)) out.push(...inflatePackets(pkt, maxDepth));
    return out;
}

/**
 * Normalize one decoded JSON message.
 * @returns {{type:string,user:string,uid:number,text:string,extra?:object}|null}
 */
function parseMessage(json) {
    if (!json || typeof json !== 'object') return null;
    const cmd = String(json.cmd || '');

    if (cmd.startsWith('DANMU_MSG')) {
        const info = json.info || [];
        const text = typeof info[1] === 'string' ? info[1] : '';
        const userInfo = info[2] || [];
        const user = typeof userInfo[1] === 'string' ? userInfo[1] : '';
        const uid = Number(userInfo[0]) || 0;
        if (!text) return null;
        const medal = Array.isArray(info[3]) && info[3].length ? { name: info[3][1], level: info[3][0] } : null;
        return { type: 'danmaku', user, uid, text, medal, raw: json };
    }

    if (cmd === 'SUPER_CHAT_MESSAGE' || cmd === 'SUPER_CHAT_MESSAGE_JPN') {
        const d = json.data || {};
        const text = d.message || '';
        if (!text) return null;
        return {
            type: 'superchat', user: d.user_info?.uname || '', uid: Number(d.uid) || 0,
            text, extra: { price: d.price }, raw: json,
        };
    }

    if (cmd === 'SEND_GIFT') {
        const d = json.data || {};
        const text = `${d.uname || ''} 投喂 ${d.giftName || ''} x${d.num || 0}`;
        return { type: 'gift', user: d.uname || '', uid: Number(d.uid) || 0, text, raw: json };
    }

    if (cmd === 'INTERACT_WORD') {
        const d = json.data || {};
        const text = `${d.uname || ''} 进入了直播间`;
        return { type: 'enter', user: d.uname || '', uid: Number(d.uid) || 0, text, raw: json };
    }

    return null;
}

/** Accept a room URL, a bare number, or a short id, and return the numeric id. */
function normalizeRoomId(input) {
    const s = String(input == null ? '' : input).trim();
    if (!s) return null;
    const fromUrl = s.match(/live\.bilibili\.com\/(?:blanc\/)?(\d+)/i);
    const numeric = fromUrl ? fromUrl[1] : (s.match(/\d+/) || [])[0];
    if (!numeric) return null;
    const n = Number(numeric);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Simple HTTPS JSON GET with a browser-ish header set. */
function httpGetJson(url, options = {}) {
    const { cookie = '', timeoutMs = 12000, ua = DEFAULT_UA } = options;
    return new Promise((resolve) => {
        const headers = { 'User-Agent': ua, Referer: 'https://live.bilibili.com/' };
        if (cookie) headers.Cookie = cookie;
        let req;
        try {
            req = https.get(url, { headers, timeout: timeoutMs }, (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch { resolve(null); }
                });
            });
        } catch { resolve(null); return; }
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
    });
}

// ========== Client ==========

const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60000;
/**
 * A connection that survives this long counts as healthy and resets the
 * backoff. Resetting on auth alone caused a tight 3s loop against rooms the
 * server drops right after handshaking (e.g. a room that is not live).
 */
const STABLE_CONNECTION_MS = 30000;
/** How often an offline room is re-checked for going live. */
const NOT_LIVE_POLL_MS = 60000;
/**
 * Fallback danmaku servers used when the API cannot hand us a host list.
 * blivedm degrades the same way rather than giving up on the connection.
 */
const DEFAULT_HOST_LIST = [
    { host: 'broadcastlv.chat.bilibili.com', wss_port: 443, ws_port: 2244, port: 2243 },
];
/** Re-fetch token/host list after this many failed attempts (blivedm does this). */
const HOST_LIST_REFRESH_EVERY = 3;

class BilibiliDanmakuClient {
    constructor(options = {}) {
        this._getJson = options.httpGetJson || httpGetJson;
        this._wsFactory = options.wsFactory || ((url, opts) => {
            const WebSocket = require('ws');
            return new WebSocket(url, opts);
        });
        this._logger = options.logger || console;
        this._now = options.now || (() => Date.now());
        this._ua = options.ua || DEFAULT_UA;

        this._ws = null;
        this._heartbeat = null;
        this._reconnectTimer = null;
        this._reconnectDelay = RECONNECT_BASE_MS;
        this._stopping = false;
        this._roomId = null;
        this._realRoomId = null;
        this._cookie = '';
        this._userCookie = '';      // optional SESSDATA/Cookie supplied by the user
        this._wbi = null;
        this._buvid = '';
        this._uid = 0;              // 0 = anonymous (set a real uid via config to log in)
        this._hosts = null;
        this._hostIndex = 0;
        this._token = null;
        this._attempts = 0;
        this._listeners = new Map();
        this._connected = false;
        this._connectedAt = 0;
        this._room = null;
        this._liveTimer = null;
        this._received = 0;
        this._lastError = null;
    }

    on(event, cb) {
        if (!this._listeners.has(event)) this._listeners.set(event, []);
        this._listeners.get(event).push(cb);
        return () => {
            const l = this._listeners.get(event) || [];
            const i = l.indexOf(cb);
            if (i >= 0) l.splice(i, 1);
        };
    }

    _emit(event, payload) {
        for (const cb of this._listeners.get(event) || []) {
            try { cb(payload); } catch (e) { this._logger.warn?.(`[Bili] listener error: ${e.message}`); }
        }
    }

    _emitStatus(extra = {}) {
        this._emit('status', { ...this.status(), ...extra });
    }

    status() {
        return {
            connected: this._connected,
            waitingForLive: !!this._liveTimer,
            liveStatus: this._room ? this._room.liveStatus : null,
            roomTitle: this._room ? this._room.title : '',
            roomId: this._roomId,
            realRoomId: this._realRoomId,
            received: this._received,
            lastError: this._lastError,
        };
    }

    /** Resolve a short/spec id to the real room id and report live status. */
    async resolveRoom(input) {
        const id = normalizeRoomId(input);
        if (!id) throw new Error('invalid_room_id');
        const info = await this._getJson(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${id}`, { cookie: this._cookie, ua: this._ua });
        if (!info || info.code !== 0 || !info.data) {
            throw new Error(`room_info_failed:${info && info.code}`);
        }
        return {
            inputId: id,
            realRoomId: Number(info.data.room_id) || id,
            title: info.data.title || '',
            liveStatus: Number(info.data.live_status) || 0,
            online: Number(info.data.online) || 0,
            uname: info.data.uname || '',
        };
    }

    /**
     * Supply an optional Cookie / SESSDATA. blivedm supports logging in this
     * way, and a logged-in handshake carries a real `uid`, which some rooms
     * need before they will deliver danmaku.
     * @returns {boolean} true when the value actually changed
     */
    setCookie(cookie) {
        const next = String(cookie == null ? '' : cookie).trim();
        if (next === this._userCookie) return false;
        this._userCookie = next;
        // Credentials are derived from the cookie, so drop every cache.
        this._cookie = '';
        this._wbi = null;
        this._uid = 0;
        return true;
    }

    get isLoggedIn() { return !!this._uid; }

    /** Step 1+2: risk-control cookie, optional login, and WBI keys. */
    async _ensureCredentials() {
        if (this._cookie && this._wbi) return;
        const userCookie = String(this._userCookie || '').trim();

        // Reuse a buvid3 the user pasted; otherwise fetch a fresh one.
        let buvid = (userCookie.match(/buvid3=([^;]+)/) || [])[1] || '';
        let buvid4 = (userCookie.match(/buvid4=([^;]+)/) || [])[1] || '';
        if (!buvid) {
            const spi = await this._getJson('https://api.bilibili.com/x/frontend/finger/spi', { ua: this._ua });
            buvid = spi?.data?.b_3 || '';
            buvid4 = spi?.data?.b_4 || buvid;
        }

        // Compose the request cookie: the user's own cookie plus a buvid when
        // theirs lacks one.
        const parts = [];
        if (userCookie) parts.push(userCookie.replace(/[;\s]+$/, ''));
        if (buvid && !/buvid3=/.test(userCookie)) parts.push(`buvid3=${buvid}`);
        if (buvid4 && !/buvid4=/.test(userCookie)) parts.push(`buvid4=${buvid4}`);
        this._cookie = parts.length ? parts.join('; ') + ';' : '';
        // blivedm also puts buvid in the auth packet, so the server sees a
        // consistent device identity for this connection.
        this._buvid = buvid;

        const nav = await this._getJson('https://api.bilibili.com/x/web-interface/nav', { cookie: this._cookie, ua: this._ua });
        if (nav?.data?.isLogin && nav.data.mid) {
            this._uid = Number(nav.data.mid) || 0;
            this._logger.log?.(`[Bili] logged in as uid ${this._uid}`);
        } else if (userCookie) {
            this._uid = 0;
            this._logger.warn?.('[Bili] cookie supplied but not logged in — SESSDATA may be expired');
        }

        const img = keyFromWbiUrl(nav?.data?.wbi_img?.img_url);
        const sub = keyFromWbiUrl(nav?.data?.wbi_img?.sub_url);
        if (img && sub) this._wbi = mixinKey(img, sub);
    }

    /**
     * Step 3: token + host list, WBI-signed.
     *
     * Two robustness details borrowed from blivedm:
     *   - `-352` means the WBI signature went stale: drop the cached key and
     *     retry once with a freshly fetched one.
     *   - keep the WHOLE host list so reconnects rotate through it instead of
     *     hammering one host forever.
     */
    async _fetchDanmuInfo(realRoomId) {
        await this._ensureCredentials();
        if (!this._wbi) throw new Error('wbi_key_missing');

        let info = await this._requestDanmuInfo(realRoomId);
        if (info && info.code === -352) {
            this._logger.warn?.('[Bili] wbi signature rejected (-352); refreshing key');
            this._wbi = null;
            this._cookie = '';
            await this._ensureCredentials();
            if (this._wbi) info = await this._requestDanmuInfo(realRoomId);
        }

        if (!info || info.code !== 0 || !info.data) {
            // Degrade like blivedm: fall back to the public server list so a
            // transient API failure does not kill danmaku entirely.
            this._logger.warn?.(`[Bili] getDanmuInfo failed (${info && info.code}); using default hosts`);
            this._hosts = DEFAULT_HOST_LIST.slice();
            this._hostIndex = 0;
            const h = this._hosts[0];
            return { token: this._token, host: h.host, port: h.wss_port };
        }

        const hosts = (info.data.host_list || []).filter((h) => h && h.host);
        if (!hosts.length) throw new Error('no_host');
        this._hosts = hosts;
        this._token = info.data.token;
        // Rotate through the host list on every attempt so one unreachable
        // server cannot pin us in a permanent failure loop.
        const host = hosts[this._hostIndex % hosts.length];
        this._hostIndex += 1;
        return { token: this._token, host: host.host, port: host.wss_port || 443 };
    }

    async _requestDanmuInfo(realRoomId) {
        const qs = wbiSign({ id: realRoomId, type: 0 }, this._wbi, Math.floor(this._now() / 1000));
        return this._getJson(
            `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${qs}`,
            { cookie: this._cookie, ua: this._ua }
        );
    }

    /** Connect (or reconnect) to the room's danmaku stream. */
    async start(roomInput) {
        const requested = normalizeRoomId(roomInput);

        // Idempotent: asking again for the room we are already on is a no-op, so
        // repeated UI clicks cannot tear a healthy socket down and rebuild it.
        if (requested != null && this._connected && this._roomId === requested) {
            return { success: true, room: this._room, reused: true };
        }
        if (requested != null && this._liveTimer && this._roomId === requested) {
            return { success: true, room: this._room, waitingForLive: true, reused: true };
        }

        this.stop();
        this._stopping = false;
        this._reconnectDelay = RECONNECT_BASE_MS;
        try {
            const room = await this.resolveRoom(roomInput);
            this._roomId = room.inputId;
            this._realRoomId = room.realRoomId;
            this._room = room;
            this._emitStatus({ room });

            // An offline room serves no danmaku and the server hangs up right
            // after auth, so watch for it to start instead of reconnecting
            // forever (that used to produce an endless 3-second handshake loop).
            if (room.liveStatus !== 1) {
                this._lastError = 'not_live';
                this._logger.log?.(`[Bili] room ${room.realRoomId} is not live; watching for it to start`);
                this._scheduleLiveWatch();
                return { success: true, room, waitingForLive: true };
            }

            await this._connectOnce();
            return { success: true, room };
        } catch (e) {
            this._lastError = e.message;
            this._emitStatus();
            return { success: false, error: e.message };
        }
    }

    /** Re-check the watched room; connect once it is live. Returns true if so. */
    async _checkLiveAndConnect() {
        if (this._stopping || this._roomId == null) return false;
        try {
            const room = await this.resolveRoom(this._roomId);
            this._room = room;
            this._emitStatus({ room });
            if (room.liveStatus === 1) {
                this._lastError = null;
                this._logger.log?.(`[Bili] room ${room.realRoomId} went live; connecting`);
                await this._connectOnce();
                return true;
            }
            return false;
        } catch (e) {
            this._lastError = e.message;
            this._emitStatus();
            return false;
        }
    }

    /** Re-check an offline room periodically and connect once it goes live. */
    _scheduleLiveWatch() {
        if (this._liveTimer || this._stopping) return;
        this._liveTimer = setTimeout(async () => {
            this._liveTimer = null;
            const connected = await this._checkLiveAndConnect();
            if (!connected && !this._stopping && this._roomId != null) this._scheduleLiveWatch();
        }, NOT_LIVE_POLL_MS);
        if (this._liveTimer.unref) this._liveTimer.unref();
    }

    async _connectOnce() {
        const real = this._realRoomId;
        // Every few attempts, throw away the cached token/host list and fetch a
        // fresh one (blivedm re-inits the room on the same schedule) — tokens do
        // expire, and a stale one would otherwise fail forever.
        this._attempts += 1;
        if (this._attempts > 1 && this._attempts % HOST_LIST_REFRESH_EVERY === 0) {
            this._hosts = null;
            this._token = null;
        }
        const { token, host, port } = await this._fetchDanmuInfo(real);
        const url = `wss://${host}:${port}/sub`;
        this._logger.log?.(`[Bili] connecting ${url} (room ${real})`);

        const ws = this._wsFactory(url, {
            headers: { 'User-Agent': this._ua, Origin: 'https://live.bilibili.com' },
        });
        this._ws = ws;

        ws.on('open', () => {
            // Field set mirrors blivedm's web client: uid, roomid, protover,
            // platform, type, buvid (+ key when we have a token).
            const auth = {
                uid: this._uid || 0,
                roomid: real,
                protover: 3,
                platform: 'web',
                type: 2,
                buvid: this._buvid || '',
            };
            if (token) auth.key = token;
            try { ws.send(encodePacket(OP_AUTH, JSON.stringify(auth))); } catch (e) { this._logger.warn?.(`[Bili] auth send failed: ${e.message}`); }
        });

        ws.on('message', (data) => this._handleFrame(data));

        ws.on('error', (e) => {
            this._lastError = e.message;
            this._logger.warn?.(`[Bili] ws error: ${e.message}`);
        });

        ws.on('close', () => {
            this._connected = false;
            this._clearHeartbeat();
            this._emitStatus();
            if (!this._stopping) this._scheduleReconnect();
        });
    }

    _handleFrame(data) {
        let packets;
        try {
            packets = expandFrame(Buffer.isBuffer(data) ? data : Buffer.from(data));
        } catch (e) {
            this._logger.warn?.(`[Bili] decode failed: ${e.message}`);
            return;
        }
        for (const pkt of packets) {
            if (pkt.operation === OP_AUTH_REPLY) {
                let code = null;
                try { code = JSON.parse(pkt.body.toString('utf8')).code; } catch { /* ignore */ }
                if (code === 0) {
                    this._connected = true;
                    this._connectedAt = this._now();
                    this._attempts = 0;
                    // Deliberately NOT resetting the backoff here: only a
                    // connection that lives a while proves the server is happy.
                    this._lastError = null;
                    this._startHeartbeat();
                    this._logger.log?.('[Bili] authenticated, listening');
                } else {
                    this._lastError = `auth_failed:${code}`;
                }
                this._emitStatus();
            } else if (pkt.operation === OP_HEARTBEAT_REPLY) {
                // popularity counter; nothing to do
            } else if (pkt.operation === OP_MESSAGE) {
                let json;
                try { json = JSON.parse(pkt.body.toString('utf8')); } catch { continue; }
                const msg = parseMessage(json);
                if (!msg) continue;
                this._received += 1;
                this._emit('message', msg);
            }
        }
    }

    _startHeartbeat() {
        this._clearHeartbeat();
        this._heartbeat = setInterval(() => {
            if (!this._ws || this._ws.readyState !== 1) return;
            try { this._ws.send(encodePacket(OP_HEARTBEAT, '[object Object]')); } catch { /* reconnect handles it */ }
        }, HEARTBEAT_MS);
        if (this._heartbeat.unref) this._heartbeat.unref();
    }

    _clearHeartbeat() {
        if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null; }
    }

    _scheduleReconnect() {
        if (this._reconnectTimer || this._stopping) return;
        // Only a connection that actually lived resets the backoff, so a server
        // that hangs up right after auth backs off instead of looping at 3s.
        const lived = this._connectedAt ? this._now() - this._connectedAt : 0;
        if (lived >= STABLE_CONNECTION_MS) this._reconnectDelay = RECONNECT_BASE_MS;
        this._connectedAt = 0;

        const delay = this._reconnectDelay;
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_MS);
        this._logger.log?.(`[Bili] reconnecting in ${Math.round(delay / 1000)}s`);
        this._reconnectTimer = setTimeout(async () => {
            this._reconnectTimer = null;
            if (this._stopping || this._roomId == null) return;
            try { await this._connectOnce(); } catch (e) {
                this._lastError = e.message;
                this._emitStatus();
                this._scheduleReconnect();
            }
        }, delay);
        if (this._reconnectTimer.unref) this._reconnectTimer.unref();
    }

    stop() {
        this._stopping = true;
        this._clearHeartbeat();
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        if (this._liveTimer) { clearTimeout(this._liveTimer); this._liveTimer = null; }
        if (this._ws) {
            try {
                this._ws.removeAllListeners?.('close');
                this._ws.close();
            } catch { /* already gone */ }
            this._ws = null;
        }
        this._connected = false;
        return true;
    }
}

module.exports = {
    BilibiliDanmakuClient,
    // pure helpers, exported for tests and reuse
    mixinKey,
    keyFromWbiUrl,
    wbiSign,
    encodePacket,
    decodePackets,
    inflatePackets,
    expandFrame,
    parseMessage,
    normalizeRoomId,
    httpGetJson,
    MIXIN_KEY_TAB,
    OP_HEARTBEAT,
    OP_HEARTBEAT_REPLY,
    OP_MESSAGE,
    OP_AUTH,
    OP_AUTH_REPLY,
    HEARTBEAT_MS,
    DEFAULT_UA,
    DEFAULT_HOST_LIST,
    HOST_LIST_REFRESH_EVERY,
};
