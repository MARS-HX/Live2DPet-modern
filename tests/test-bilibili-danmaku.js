/**
 * Unit tests for the Bilibili danmaku client.
 * Run with: node --test tests/test-bilibili-danmaku.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { EventEmitter } = require('events');

const {
    BilibiliDanmakuClient,
    mixinKey,
    keyFromWbiUrl,
    wbiSign,
    encodePacket,
    decodePackets,
    inflatePackets,
    expandFrame,
    parseMessage,
    normalizeRoomId,
    OP_HEARTBEAT,
    OP_MESSAGE,
    OP_AUTH,
    OP_AUTH_REPLY,
} = require('../src/main/bilibili-danmaku');

// ========== WBI signing ==========

describe('mixinKey', () => {
    it('produces a 32 character key', () => {
        const k = mixinKey('a'.repeat(32), 'b'.repeat(32));
        assert.strictEqual(k.length, 32);
    });

    it('changes when either input key changes', () => {
        const a = mixinKey('a'.repeat(32), 'b'.repeat(32));
        const b = mixinKey('c'.repeat(32), 'b'.repeat(32));
        assert.notStrictEqual(a, b);
    });

    it('returns empty for empty inputs', () => {
        assert.strictEqual(mixinKey('', ''), '');
    });
});

describe('keyFromWbiUrl', () => {
    it('extracts the filename stem', () => {
        assert.strictEqual(keyFromWbiUrl('https://i0.hdslb.com/bfs/wbi/7d1f1234abcd.png'), '7d1f1234abcd');
    });
    it('handles empty input', () => {
        assert.strictEqual(keyFromWbiUrl(''), '');
        assert.strictEqual(keyFromWbiUrl(undefined), '');
    });
});

describe('wbiSign', () => {
    const key = mixinKey('a'.repeat(32), 'b'.repeat(32));

    it('is deterministic for a fixed timestamp', () => {
        const a = wbiSign({ id: 5440, type: 0 }, key, 1700000000);
        const b = wbiSign({ id: 5440, type: 0 }, key, 1700000000);
        assert.strictEqual(a, b);
    });

    it('includes wts and a 32-char w_rid', () => {
        const q = wbiSign({ id: 1 }, key, 1700000000);
        assert.match(q, /wts=1700000000/);
        assert.match(q, /w_rid=[0-9a-f]{32}/);
    });

    it('sorts parameters alphabetically', () => {
        const q = wbiSign({ type: 0, id: 5 }, key, 1700000000);
        assert.ok(q.indexOf('id=') < q.indexOf('type='), 'id should precede type');
    });

    it('changes with the mixin key', () => {
        const other = mixinKey('c'.repeat(32), 'd'.repeat(32));
        assert.notStrictEqual(wbiSign({ id: 1 }, key, 1700000000), wbiSign({ id: 1 }, other, 1700000000));
    });
});

// ========== Wire codec ==========

describe('encodePacket / decodePackets', () => {
    it('round-trips a packet with correct header fields', () => {
        const buf = encodePacket(OP_AUTH, '{"a":1}');
        assert.strictEqual(buf.readUInt32BE(0), buf.length, 'packetLen covers the whole packet');
        assert.strictEqual(buf.readUInt16BE(4), 16, 'headerLen is 16');
        assert.strictEqual(buf.readUInt16BE(6), 1, 'protoVer defaults to 1');
        assert.strictEqual(buf.readUInt32BE(8), OP_AUTH);
        assert.strictEqual(buf.readUInt32BE(12), 1, 'sequence is 1');

        const packets = decodePackets(buf);
        assert.strictEqual(packets.length, 1);
        assert.strictEqual(packets[0].operation, OP_AUTH);
        assert.strictEqual(packets[0].body.toString('utf8'), '{"a":1}');
    });

    it('decodes several concatenated packets', () => {
        const buf = Buffer.concat([encodePacket(OP_AUTH, 'x'), encodePacket(OP_MESSAGE, 'y')]);
        const packets = decodePackets(buf);
        assert.strictEqual(packets.length, 2);
        assert.deepStrictEqual(packets.map(p => p.body.toString('utf8')), ['x', 'y']);
    });

    it('ignores a truncated trailing packet instead of throwing', () => {
        const full = encodePacket(OP_MESSAGE, 'hello');
        const packets = decodePackets(full.subarray(0, full.length - 2));
        assert.strictEqual(packets.length, 0);
    });

    it('ignores a bogus length field', () => {
        const bad = Buffer.alloc(16);
        bad.writeUInt32BE(9999, 0);   // claims more than the buffer holds
        bad.writeUInt16BE(16, 4);
        assert.strictEqual(decodePackets(bad).length, 0);
    });

    it('accepts an empty body', () => {
        assert.strictEqual(decodePackets(encodePacket(OP_HEARTBEAT))[0].body.length, 0);
    });
});

describe('inflatePackets', () => {
    function wrap(innerPackets, protoVer) {
        const raw = Buffer.concat(innerPackets);
        const body = protoVer === 3 ? zlib.brotliCompressSync(raw) : zlib.deflateSync(raw);
        return { operation: OP_MESSAGE, protoVer, body };
    }

    it('unwraps zlib (protoVer 2) nested packets', () => {
        const inner = encodePacket(OP_MESSAGE, '{"cmd":"DANMU_MSG"}');
        const out = inflatePackets(wrap([inner], 2));
        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].operation, OP_MESSAGE);
        assert.strictEqual(out[0].body.toString('utf8'), '{"cmd":"DANMU_MSG"}');
    });

    it('unwraps brotli (protoVer 3) nested packets', () => {
        const inner = encodePacket(OP_MESSAGE, '{"cmd":"DANMU_MSG"}');
        const out = inflatePackets(wrap([inner], 3));
        assert.strictEqual(out[0].body.toString('utf8'), '{"cmd":"DANMU_MSG"}');
    });

    it('handles multiple messages inside one compressed body', () => {
        const inner = [
            encodePacket(OP_MESSAGE, 'a'),
            encodePacket(OP_MESSAGE, 'b'),
            encodePacket(OP_MESSAGE, 'c'),
        ];
        const out = inflatePackets(wrap(inner, 3));
        assert.deepStrictEqual(out.map(p => p.body.toString('utf8')), ['a', 'b', 'c']);
    });

    it('keeps an uncompressed packet as-is', () => {
        const p = { operation: OP_MESSAGE, protoVer: 1, body: Buffer.from('{"x":1}') };
        assert.strictEqual(inflatePackets(p).length, 1);
    });

    it('survives a corrupt compressed body without throwing', () => {
        const out = inflatePackets({ operation: OP_MESSAGE, protoVer: 3, body: Buffer.from('not brotli') });
        assert.strictEqual(out.length, 1, 'falls back to the original packet');
    });
});

describe('expandFrame', () => {
    it('decodes a brotli frame carrying a danmaku', () => {
        const inner = encodePacket(OP_MESSAGE, JSON.stringify({ cmd: 'DANMU_MSG', info: [] }));
        const body = zlib.brotliCompressSync(inner);
        const frame = encodePacket(OP_MESSAGE, body, 3);
        const out = expandFrame(frame);
        assert.strictEqual(out.length, 1);
        assert.match(out[0].body.toString('utf8'), /DANMU_MSG/);
    });
});

// ========== Message parsing ==========

describe('parseMessage', () => {
    it('parses a DANMU_MSG with user, uid and text', () => {
        const msg = parseMessage({
            cmd: 'DANMU_MSG:4:0:2:2:2:0',
            info: [
                [0, 1, 25, 16777215, 1700000000, 0, 0, '', 0, 0, 0, '', 0, 0, 0, 0],
                '你好呀',
                [12345678, '测试用户', 0, 0, 0, 10000, 1, ''],
                [21, '粉丝牌', '主播', 1234],
            ],
        });
        assert.strictEqual(msg.type, 'danmaku');
        assert.strictEqual(msg.text, '你好呀');
        assert.strictEqual(msg.user, '测试用户');
        assert.strictEqual(msg.uid, 12345678);
        assert.deepStrictEqual(msg.medal, { name: '粉丝牌', level: 21 });
    });

    it('drops a DANMU_MSG with empty text', () => {
        assert.strictEqual(parseMessage({ cmd: 'DANMU_MSG', info: [[], '', [1, 'u']] }), null);
    });

    it('parses a super chat', () => {
        const msg = parseMessage({
            cmd: 'SUPER_CHAT_MESSAGE',
            data: { message: '加油！', uid: 42, price: 30, user_info: { uname: '老板' } },
        });
        assert.strictEqual(msg.type, 'superchat');
        assert.strictEqual(msg.user, '老板');
        assert.strictEqual(msg.text, '加油！');
        assert.strictEqual(msg.extra.price, 30);
    });

    it('parses a gift', () => {
        const msg = parseMessage({ cmd: 'SEND_GIFT', data: { uname: '甲', uid: 7, giftName: '小心心', num: 3 } });
        assert.strictEqual(msg.type, 'gift');
        assert.match(msg.text, /小心心/);
        assert.match(msg.text, /3/);
    });

    it('parses an enter-room event', () => {
        const msg = parseMessage({ cmd: 'INTERACT_WORD', data: { uname: '路人', uid: 9 } });
        assert.strictEqual(msg.type, 'enter');
        assert.match(msg.text, /路人/);
    });

    it('returns null for unrelated or malformed commands', () => {
        assert.strictEqual(parseMessage({ cmd: 'ONLINE_RANK_COUNT', data: {} }), null);
        assert.strictEqual(parseMessage(null), null);
        assert.strictEqual(parseMessage('nope'), null);
    });
});

// ========== Room id normalization ==========

describe('normalizeRoomId', () => {
    it('accepts a bare number', () => {
        assert.strictEqual(normalizeRoomId(5440), 5440);
        assert.strictEqual(normalizeRoomId('5440'), 5440);
    });
    it('accepts a live room URL', () => {
        assert.strictEqual(normalizeRoomId('https://live.bilibili.com/5440'), 5440);
        assert.strictEqual(normalizeRoomId('https://live.bilibili.com/blanc/5440?x=1'), 5440);
    });
    it('rejects garbage', () => {
        assert.strictEqual(normalizeRoomId('abc'), null);
        assert.strictEqual(normalizeRoomId(''), null);
        assert.strictEqual(normalizeRoomId(null), null);
        assert.strictEqual(normalizeRoomId('0'), null);
    });
});

// ========== Client lifecycle ==========

class FakeWs extends EventEmitter {
    constructor() {
        super();
        this.readyState = 1;
        this.sent = [];
    }
    send(buf) { this.sent.push(buf); }
    close() { this.readyState = 3; this.emit('close'); }
}

function makeGetJson(overrides = {}) {
    return async (url) => {
        if (url.includes('/x/frontend/finger/spi')) return { data: { b_3: 'BUV3', b_4: 'BUV4' } };
        if (url.includes('/x/web-interface/nav')) {
            return { data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png' } } };
        }
        if (url.includes('/room/v1/Room/get_info')) {
            return { code: 0, data: { room_id: 5440, title: '测试直播间', live_status: 1, online: 100, uname: '主播', ...overrides.roomInfo } };
        }
        if (url.includes('/getDanmuInfo')) {
            return { code: 0, data: { token: 'TOKEN', host_list: [{ host: 'bd-test.chat.bilibili.com', wss_port: 443 }] } };
        }
        return null;
    };
}

function makeClient(extra = {}) {
    let ws = null;
    const client = new BilibiliDanmakuClient({
        httpGetJson: makeGetJson(extra),
        wsFactory: () => { ws = new FakeWs(); return ws; },
        logger: { log() {}, warn() {}, error() {} },
        ...extra.options,
    });
    return { client, getWs: () => ws };
}

describe('BilibiliDanmakuClient', () => {
    it('resolves a room and reports live status', async () => {
        const { client } = makeClient();
        const room = await client.resolveRoom('https://live.bilibili.com/5440');
        assert.strictEqual(room.realRoomId, 5440);
        assert.strictEqual(room.liveStatus, 1);
        assert.strictEqual(room.title, '测试直播间');
    });

    it('fails cleanly on an invalid room id', async () => {
        const { client } = makeClient();
        await assert.rejects(() => client.resolveRoom('nope'), /invalid_room_id/);
    });

    it('connects, authenticates and reports status', async () => {
        const { client, getWs } = makeClient();
        const res = await client.start(5440);
        assert.strictEqual(res.success, true);

        const ws = getWs();
        const statuses = [];
        client.on('status', (s) => statuses.push(s));

        ws.emit('open');
        assert.strictEqual(ws.sent.length, 1, 'auth packet sent on open');
        const authPacket = decodePackets(ws.sent[0])[0];
        assert.strictEqual(authPacket.operation, OP_AUTH);
        const auth = JSON.parse(authPacket.body.toString('utf8'));
        assert.strictEqual(auth.roomid, 5440);
        assert.strictEqual(auth.key, 'TOKEN');
        assert.strictEqual(auth.protover, 3);

        ws.emit('message', encodePacket(OP_AUTH_REPLY, JSON.stringify({ code: 0 })));
        assert.strictEqual(client.status().connected, true);
        assert.strictEqual(client.status().lastError, null);
        assert.ok(statuses.length >= 1);
        client.stop();
    });

    it('emits parsed danmaku from a brotli frame', async () => {
        const { client, getWs } = makeClient();
        await client.start(5440);
        const ws = getWs();
        ws.emit('open');
        ws.emit('message', encodePacket(OP_AUTH_REPLY, JSON.stringify({ code: 0 })));

        const seen = [];
        client.on('message', (m) => seen.push(m));

        const danmaku = JSON.stringify({ cmd: 'DANMU_MSG', info: [[], '好耶', [1, '观众']] });
        const inner = encodePacket(OP_MESSAGE, danmaku);
        const frame = encodePacket(OP_MESSAGE, zlib.brotliCompressSync(inner), 3);
        ws.emit('message', frame);

        assert.strictEqual(seen.length, 1);
        assert.strictEqual(seen[0].text, '好耶');
        assert.strictEqual(seen[0].user, '观众');
        assert.strictEqual(client.status().received, 1);
        client.stop();
    });

    it('does not emit for non-danmaku commands', async () => {
        const { client, getWs } = makeClient();
        await client.start(5440);
        const ws = getWs();
        ws.emit('message', encodePacket(OP_AUTH_REPLY, JSON.stringify({ code: 0 })));
        const seen = [];
        client.on('message', (m) => seen.push(m));
        ws.emit('message', encodePacket(OP_MESSAGE, JSON.stringify({ cmd: 'ONLINE_RANK_COUNT', data: {} })));
        assert.strictEqual(seen.length, 0);
        client.stop();
    });

    it('records an auth failure', async () => {
        const { client, getWs } = makeClient();
        await client.start(5440);
        const ws = getWs();
        ws.emit('message', encodePacket(OP_AUTH_REPLY, JSON.stringify({ code: -101 })));
        assert.strictEqual(client.status().connected, false);
        assert.match(client.status().lastError, /auth_failed/);
        client.stop();
    });

    it('falls back to the default host list instead of failing outright', async () => {
        // blivedm degrades the same way: a transient API failure must not kill
        // danmaku completely.
        const client = new BilibiliDanmakuClient({
            httpGetJson: async (url) => {
                if (url.includes('/room/v1/Room/get_info')) return { code: 0, data: { room_id: 1, live_status: 1 } };
                if (url.includes('/getDanmuInfo')) return { code: -352 };
                return { data: { b_3: 'x', b_4: 'y', wbi_img: { img_url: 'a.png', sub_url: 'b.png' } } };
            },
            wsFactory: () => new FakeWs(),
            logger: { log() {}, warn() {}, error() {} },
        });
        const res = await client.start(1);
        assert.strictEqual(res.success, true, 'degrades to the default host list');
    });

    it('sends buvid in the auth packet, like blivedm', async () => {
        const { client, getWs } = makeClient();
        await client.start(5440);
        const ws = getWs();
        ws.emit('open');
        const auth = JSON.parse(decodePackets(ws.sent[0])[0].body.toString('utf8'));
        assert.strictEqual(auth.buvid, 'BUV3', 'the device id must accompany the handshake');
        assert.strictEqual(auth.roomid, 5440);
        assert.strictEqual(auth.protover, 3);
        client.stop();
    });

    it('rotates through the host list on each attempt', async () => {
        const seen = [];
        const client = new BilibiliDanmakuClient({
            httpGetJson: async (url) => {
                if (url.includes('/x/frontend/finger/spi')) return { data: { b_3: 'B', b_4: 'C' } };
                if (url.includes('/x/web-interface/nav')) {
                    return { data: { wbi_img: {
                        img_url: `https://i0.hdslb.com/bfs/wbi/${'a'.repeat(32)}.png`,
                        sub_url: `https://i0.hdslb.com/bfs/wbi/${'b'.repeat(32)}.png`,
                    } } };
                }
                if (url.includes('/room/v1/Room/get_info')) return { code: 0, data: { room_id: 5440, title: 'T', live_status: 1 } };
                if (url.includes('/getDanmuInfo')) {
                    return { code: 0, data: { token: 'TOK', host_list: [{ host: 'host-a', wss_port: 443 }, { host: 'host-b', wss_port: 443 }] } };
                }
                return null;
            },
            wsFactory: (url) => { seen.push(url); return new FakeWs(); },
            logger: { log() {}, warn() {}, error() {} },
        });
        await client.start(5440);
        await client._connectOnce();
        await client._connectOnce();
        assert.match(seen[0], /host-a/);
        assert.match(seen[1], /host-b/, 'a reconnect must not reuse the same host');
        assert.match(seen[2], /host-a/, 'the rotation wraps around');
        client.stop();
    });

    it('retries once with a fresh WBI key when the signature is rejected', async () => {
        let danmuCalls = 0;
        const client = new BilibiliDanmakuClient({
            httpGetJson: async (url) => {
                if (url.includes('/x/frontend/finger/spi')) return { data: { b_3: 'B', b_4: 'C' } };
                if (url.includes('/x/web-interface/nav')) {
                    return { data: { wbi_img: {
                        img_url: `https://i0.hdslb.com/bfs/wbi/${'a'.repeat(32)}.png`,
                        sub_url: `https://i0.hdslb.com/bfs/wbi/${'b'.repeat(32)}.png`,
                    } } };
                }
                if (url.includes('/room/v1/Room/get_info')) return { code: 0, data: { room_id: 5440, title: 'T', live_status: 1 } };
                if (url.includes('/getDanmuInfo')) {
                    danmuCalls += 1;
                    if (danmuCalls === 1) return { code: -352 };        // stale signature
                    return { code: 0, data: { token: 'TOK', host_list: [{ host: 'ok-host', wss_port: 443 }] } };
                }
                return null;
            },
            wsFactory: () => new FakeWs(),
            logger: { log() {}, warn() {}, error() {} },
        });
        await client.start(5440);
        assert.strictEqual(danmuCalls, 2, 'the request is retried after refreshing the key');
        assert.strictEqual(client.status().lastError, null);
        client.stop();
    });

    it('stops cleanly and forgets the socket', async () => {
        const { client, getWs } = makeClient();
        await client.start(5440);
        const ws = getWs();
        ws.emit('open');
        client.stop();
        assert.strictEqual(client.status().connected, false);
        assert.strictEqual(client.status().roomId, 5440, 'room id retained for status');
    });
});

describe('BilibiliDanmakuClient offline rooms', () => {
    function makeOfflineHarness(state) {
        let wsCount = 0;
        let ws = null;
        const client = new BilibiliDanmakuClient({
            httpGetJson: async (url) => {
                if (url.includes('/x/frontend/finger/spi')) return { data: { b_3: 'BUV3', b_4: 'BUV4' } };
                if (url.includes('/x/web-interface/nav')) {
                    return { data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png' } } };
                }
                if (url.includes('/room/v1/Room/get_info')) {
                    return { code: 0, data: { room_id: 5440, title: '测试直播间', live_status: state.live, online: 0, uname: '主播' } };
                }
                if (url.includes('/getDanmuInfo')) {
                    return { code: 0, data: { token: 'TOKEN', host_list: [{ host: 'h', wss_port: 443 }] } };
                }
                return null;
            },
            wsFactory: () => { wsCount++; ws = new FakeWs(); return ws; },
            logger: { log() {}, warn() {}, error() {} },
        });
        return { client, wsCount: () => wsCount, getWs: () => ws };
    }

    it('does not open a socket while the room is offline', async () => {
        const state = { live: 0 };
        const h = makeOfflineHarness(state);
        const res = await h.client.start(5440);
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.waitingForLive, true);
        assert.strictEqual(h.wsCount(), 0, 'no websocket for an offline room');
        assert.strictEqual(h.client.status().waitingForLive, true);
        assert.strictEqual(h.client.status().liveStatus, 0);
        assert.strictEqual(h.client.status().lastError, 'not_live');
        h.client.stop();
    });

    it('connects once the room goes live, then stops watching', async () => {
        const state = { live: 0 };
        const h = makeOfflineHarness(state);
        await h.client.start(5440);
        assert.strictEqual(h.wsCount(), 0);

        // Still offline on the next check.
        assert.strictEqual(await h.client._checkLiveAndConnect(), false);
        assert.strictEqual(h.wsCount(), 0);

        // Room goes live.
        state.live = 1;
        assert.strictEqual(await h.client._checkLiveAndConnect(), true);
        assert.strictEqual(h.wsCount(), 1, 'connects exactly once');
        assert.strictEqual(h.client.status().lastError, null);
        h.client.stop();
    });

    it('is idempotent for the room it is already connected to', async () => {
        const state = { live: 1 };
        const h = makeOfflineHarness(state);
        await h.client.start(5440);
        const ws = h.getWs();
        ws.emit('message', encodePacket(OP_AUTH_REPLY, JSON.stringify({ code: 0 })));
        assert.strictEqual(h.client.status().connected, true);

        const again = await h.client.start(5440);
        assert.strictEqual(again.reused, true);
        assert.strictEqual(h.wsCount(), 1, 'repeated start does not rebuild the socket');
        h.client.stop();
    });

    it('reuses the live watch for repeated start calls', async () => {
        const state = { live: 0 };
        const h = makeOfflineHarness(state);
        await h.client.start(5440);
        const again = await h.client.start(5440);
        assert.strictEqual(again.waitingForLive, true);
        assert.strictEqual(again.reused, true);
        assert.strictEqual(h.wsCount(), 0);
        h.client.stop();
    });
});

describe('BilibiliDanmakuClient reconnect backoff', () => {
    /** Build a client with a controllable clock and a capturing logger. */
    function makeBackoffClient() {
        let clock = 1_000_000;
        const logs = [];
        let ws = null;
        const client = new BilibiliDanmakuClient({
            httpGetJson: makeGetJson(),
            wsFactory: () => { ws = new FakeWs(); return ws; },
            now: () => clock,
            logger: { log: (m) => logs.push(String(m)), warn() {}, error() {} },
        });
        return {
            client,
            logs,
            getWs: () => ws,
            advance: (ms) => { clock += ms; },
            delayOf: (msg) => {
                const m = /reconnecting in (\d+)s/.exec(msg);
                return m ? Number(m[1]) * 1000 : null;
            },
        };
    }

    it('grows the delay when the server hangs up right after auth', async () => {
        const { client, logs, getWs, delayOf } = makeBackoffClient();
        await client.start(5440);
        const ws = getWs();
        ws.emit('open');
        ws.emit('message', encodePacket(OP_AUTH_REPLY, JSON.stringify({ code: 0 })));

        // The room is offline: the socket dies immediately after handshaking.
        ws.emit('close');
        const first = logs.filter(l => l.includes('reconnecting in')).map(delayOf).pop();
        assert.strictEqual(first, 3000, 'first retry is quick');

        // Repeat: the delay must keep growing instead of looping at 3s forever.
        const seen = [];
        for (let i = 0; i < 3; i++) {
            client._reconnectTimer = null;   // pretend the previous timer fired
            client._scheduleReconnect();
            seen.push(logs.filter(l => l.includes('reconnecting in')).map(delayOf).pop());
        }
        assert.deepStrictEqual(seen, [6000, 12000, 24000], 'backoff doubles each time');
    });

    it('resets the backoff only after a connection has been stable', async () => {
        const { client, logs, getWs, advance, delayOf } = makeBackoffClient();
        await client.start(5440);
        const ws = getWs();
        ws.emit('open');
        ws.emit('message', encodePacket(OP_AUTH_REPLY, JSON.stringify({ code: 0 })));

        // Pretend several short-lived attempts already pushed the delay up.
        client._reconnectDelay = 48000;
        advance(45000);                      // this connection actually lived
        ws.emit('close');

        const last = logs.filter(l => l.includes('reconnecting in')).map(delayOf).pop();
        assert.strictEqual(last, 3000, 'a healthy connection resets the delay to the base');
    });

    it('does not reset the delay for a connection that dies quickly', async () => {
        const { client, logs, getWs, advance, delayOf } = makeBackoffClient();
        await client.start(5440);
        const ws = getWs();
        ws.emit('open');
        ws.emit('message', encodePacket(OP_AUTH_REPLY, JSON.stringify({ code: 0 })));

        client._reconnectDelay = 48000;
        advance(1000);                       // died almost immediately
        ws.emit('close');

        const last = logs.filter(l => l.includes('reconnecting in')).map(delayOf).pop();
        assert.strictEqual(last, 48000, 'a flapping connection keeps backing off');
    });
});

describe('optional login (SESSDATA), blivedm-style', () => {
    const WBI = {
        img_url: `https://i0.hdslb.com/bfs/wbi/${'a'.repeat(32)}.png`,
        sub_url: `https://i0.hdslb.com/bfs/wbi/${'b'.repeat(32)}.png`,
    };

    function loginClient({ isLogin = true, mid = 12345, onNav, onSpi } = {}) {
        let ws = null;
        const client = new BilibiliDanmakuClient({
            httpGetJson: async (url, opts) => {
                if (url.includes('/x/frontend/finger/spi')) { if (onSpi) onSpi(); return { data: { b_3: 'FRESH3', b_4: 'FRESH4' } }; }
                if (url.includes('/x/web-interface/nav')) { if (onNav) onNav(opts); return { data: { isLogin, mid, wbi_img: WBI } }; }
                if (url.includes('/room/v1/Room/get_info')) return { code: 0, data: { room_id: 5440, title: 'T', live_status: 1 } };
                if (url.includes('/getDanmuInfo')) return { code: 0, data: { token: 'TOK', host_list: [{ host: 'h', wss_port: 443 }] } };
                return null;
            },
            wsFactory: () => { ws = new FakeWs(); return ws; },
            logger: { log() {}, warn() {}, error() {} },
        });
        return { client, getWs: () => ws };
    }

    it('setCookie reports whether the value actually changed', () => {
        const { client } = loginClient();
        assert.strictEqual(client.setCookie('SESSDATA=abc'), true);
        assert.strictEqual(client.setCookie('SESSDATA=abc'), false, 'the same value is a no-op');
        assert.strictEqual(client.setCookie(''), true);
        assert.strictEqual(client.isLoggedIn, false);
    });

    it('forwards the cookie to bilibili and carries the real uid in auth', async () => {
        let navCookie = null;
        const { client, getWs } = loginClient({ onNav: (opts) => { navCookie = opts.cookie; } });
        client.setCookie('SESSDATA=abc; bili_jct=xyz');
        await client.start(5440);
        assert.match(navCookie, /SESSDATA=abc/, 'the cookie must reach bilibili');
        const ws = getWs();
        ws.emit('open');
        const auth = JSON.parse(decodePackets(ws.sent[0])[0].body.toString('utf8'));
        assert.strictEqual(auth.uid, 12345, 'a logged-in handshake carries the real uid');
        assert.strictEqual(client.isLoggedIn, true);
        client.stop();
    });

    it('reuses a buvid from the pasted cookie instead of fetching a new one', async () => {
        let spiCalls = 0;
        const { client, getWs } = loginClient({ onSpi: () => { spiCalls += 1; } });
        client.setCookie('SESSDATA=abc; buvid3=PASTED3');
        await client.start(5440);
        assert.strictEqual(spiCalls, 0, 'no need to fetch a buvid when the cookie has one');
        const ws = getWs();
        ws.emit('open');
        const auth = JSON.parse(decodePackets(ws.sent[0])[0].body.toString('utf8'));
        assert.strictEqual(auth.buvid, 'PASTED3');
        client.stop();
    });

    it('stays anonymous when the supplied cookie is expired', async () => {
        const { client, getWs } = loginClient({ isLogin: false });
        client.setCookie('SESSDATA=stale');
        await client.start(5440);
        const ws = getWs();
        ws.emit('open');
        const auth = JSON.parse(decodePackets(ws.sent[0])[0].body.toString('utf8'));
        assert.strictEqual(auth.uid, 0, 'an expired cookie must not fake a login');
        assert.strictEqual(client.isLoggedIn, false);
        client.stop();
    });
});
