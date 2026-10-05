/**
 * obs-shim.js — runs the real desktop-pet.html inside OBS's Browser Source.
 *
 * OBS renders this page in its own Chromium, so the page has no `preload.js`
 * and no IPC. This shim implements the same `window.electronAPI` surface over
 * plain HTTP + WebSocket, which means the pet page itself needs no changes and
 * cannot drift from the desktop version.
 *
 * Injected by obs-server.js as the first script inside <body>.
 */
(function () {
    'use strict';

    const listeners = new Map();     // channel -> Set<handler>
    const pending = [];              // events that arrived before a handler was ready
    let configCache = null;
    let socket = null;
    let ready = false;

    // ---- in-frame size / position ----------------------------------------
    // OBS can move and scale the source rectangle, but the pet's own placement
    // inside that rectangle is ours to control. Applied as a CSS transform on
    // the pet container, so it never has to touch the Live2D adapter.
    function currentTransform() {
        const q = new URLSearchParams(location.search);
        const fromUrl = {
            scale: q.get('scale'),
            x: q.get('x'),
            y: q.get('y'),
        };
        const cfg = (configCache && configCache.obs && configCache.obs.browserSource) || {};
        // URL wins, then saved settings, then identity.
        const pick = (k, fallback) => (fromUrl[k] !== null && fromUrl[k] !== '' ? fromUrl[k] : (cfg[k] !== undefined ? cfg[k] : fallback));
        return {
            scale: Number(pick('scale', 1)) || 1,
            x: Number(pick('x', 0)) || 0,
            y: Number(pick('y', 0)) || 0,
        };
    }

    function applyTransform(t) {
        const el = document.getElementById('pet-container');
        if (!el) return false;
        el.style.transformOrigin = '50% 50%';
        el.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.scale})`;
        return true;
    }

    function refreshTransform() {
        try { applyTransform(currentTransform()); } catch (e) { console.warn('[OBS shim] transform failed:', e.message); }
    }

    function emit(channel, args) {
        const set = listeners.get(channel);
        if (!set || !set.size) {
            // The page subscribes slightly after load; keep the event for replay.
            pending.push({ channel, args });
            if (pending.length > 50) pending.shift();
            return;
        }
        for (const fn of set) {
            try { fn(...args); } catch (e) { console.warn('[OBS shim]', channel, e); }
        }
    }

    function on(channel) {
        return (cb) => {
            if (typeof cb !== 'function') return;
            if (!listeners.has(channel)) listeners.set(channel, new Set());
            listeners.get(channel).add(cb);
            // Replay anything that arrived before this handler existed.
            for (let i = pending.length - 1; i >= 0; i--) {
                if (pending[i].channel !== channel) continue;
                const args = pending[i].args;
                pending.splice(i, 1);
                try { cb(...args); } catch (e) { console.warn('[OBS shim]', channel, e); }
            }
        };
    }

    function connect() {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        try {
            socket = new WebSocket(`${proto}//${location.host}/ws`);
        } catch (e) {
            console.warn('[OBS shim] websocket failed:', e.message);
            return;
        }
        socket.onopen = () => { ready = true; console.log('[OBS shim] connected to the pet'); };
        socket.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            if (!msg || !msg.channel) return;
            if (msg.channel === 'init') {
                configCache = msg.args && msg.args[0];
                refreshTransform();
                return;
            }
            if (msg.channel === 'obs-transform') {
                // Live update from the settings window: changes show up in OBS
                // immediately, with no need to re-paste the URL.
                const t = (msg.args && msg.args[0]) || {};
                applyTransform({
                    scale: Number(t.scale) || 1,
                    x: Number(t.x) || 0,
                    y: Number(t.y) || 0,
                });
                return;
            }
            emit(msg.channel, msg.args || []);
        };
        socket.onclose = () => {
            ready = false;
            setTimeout(connect, 2000);   // OBS reloads sources; reconnect quietly
        };
        socket.onerror = () => { /* onclose handles it */ };
    }
    connect();

    async function api(path) {
        const res = await fetch(path, { cache: 'no-store' });
        if (!res.ok) throw new Error(`${path} -> ${res.status}`);
        return res.json();
    }

    const noop = () => {};
    const api_ = {};

    // ---- config ----
    api_.loadConfig = async () => {
        if (configCache) return configCache;
        configCache = await api('/api/config');
        refreshTransform();
        return configCache;
    };
    api_.saveConfig = async () => ({ success: false, error: 'read_only_browser_source' });

    // The model is served under /model. This must be an ABSOLUTE http URL:
    // model-adapter.js rewrites anything that does not start with file:// or
    // http into a file:/// URL (correct on the desktop, unusable in a browser
    // source), so a bare "/model" would break every expression fetch.
    api_.validateModelPaths = async () => ({ valid: true, modelDir: location.origin + '/model' });

    // ---- cursor / window: keep the pet facing forward, never throw ----
    api_.getWindowBounds = async () => ({ x: 0, y: 0, width: innerWidth, height: innerHeight });
    api_.getCursorPosition = async () => ({ x: innerWidth / 2, y: innerHeight / 2 });

    // ---- event subscriptions (channels match preload.js exactly) ----
    api_.onPlayExpression = on('play-expression');
    api_.onRevertExpression = on('revert-expression');
    api_.onPlayMotion = on('play-motion');
    api_.onTalkingStateChanged = on('talking-state-changed');
    api_.onSetCanvasY = on('set-canvas-y');
    api_.onCharacterUpdate = on('character-update');
    api_.onModelConfigUpdate = on('model-config-update');

    // ---- not applicable inside OBS ----
    api_.rendererLog = (level, args) => { try { console[level === 'error' ? 'error' : 'log']('[pet]', ...(args || [])); } catch { /* ignore */ } };
    api_.reportHit = noop;
    api_.reportHoverState = noop;
    api_.setWindowPosition = noop;
    api_.setWindowSize = noop;
    api_.showPetContextMenu = noop;
    api_.showSettings = noop;
    api_.closePetWindow = noop;
    api_.createChatWindow = noop;

    // The OBS page is a display surface: no dragging, no hover controls.
    api_.isBrowserSource = true;

    window.electronAPI = api_;

    // Re-apply the transform whenever the page re-lays-out, and make sure it
    // lands even if the container is created after this script runs.
    window.addEventListener('resize', refreshTransform);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', refreshTransform);
    } else {
        refreshTransform();
    }
    let tries = 0;
    const settle = setInterval(() => {
        if (applyTransform(currentTransform()) || ++tries > 30) clearInterval(settle);
    }, 250);
})();
