/**
 * OBS Browser Source server.
 *
 * Why this exists: OBS cannot read the pet window at all. Window Capture and
 * Game Capture both return black because the window is (a) transparent, which
 * makes it a layered window, and (b) rendered by Chromium through a path that
 * bypasses the Windows GDI. Neither can be fixed from the OBS side.
 *
 * A Browser Source has neither problem: OBS renders the page in its own
 * Chromium and composites it with real alpha. So instead of trying to capture
 * the window, we serve the same pet over loopback and let OBS draw it.
 *
 * Security: binds to 127.0.0.1 only, serves a fixed allow-list of directories
 * with traversal protection, and never exposes credentials (`/api/config` is
 * sanitized).
 */
'use strict';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.moc3': 'application/octet-stream',
    '.bin': 'application/octet-stream',
    '.wasm': 'application/wasm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
};

/** Fields that must never reach a browser source. */
const SECRET_KEY_RE = /apikey|api_key|cookie|sessdata|token|secret|password/i;

/** Deep-copy a config with every credential-shaped value blanked. */
function sanitizeConfig(value, depth = 0) {
    if (depth > 8 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((v) => sanitizeConfig(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = SECRET_KEY_RE.test(k) ? '' : sanitizeConfig(v, depth + 1);
    }
    return out;
}

/**
 * Resolve a request path inside a root directory, refusing anything that
 * escapes it. Returns null when the path is not safe.
 */
function resolveWithin(root, urlPath) {
    const path = require('path');
    const decoded = decodeURIComponent(urlPath.split('?')[0]);
    const rel = decoded.replace(/^\/+/, '');
    const full = path.resolve(root, rel);
    const rootResolved = path.resolve(root);
    if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) return null;
    return full;
}

function createObsServer(deps = {}) {
    const { http, fs, path, ws, rootDir, getConfig, getModelDir, logger = console } = deps;
    const WebSocketServer = ws && (ws.WebSocketServer || ws.Server);
    let server = null;
    let wss = null;
    let port = 0;
    const clients = new Set();

    function sendJson(res, code, obj) {
        const body = JSON.stringify(obj);
        res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
        res.end(body);
    }

    function serveFile(res, file) {
        fs.readFile(file, (err, data) => {
            if (err) { res.writeHead(404); res.end('not found'); return; }
            const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
            res.end(data);
        });
    }

    /**
     * Serve the REAL pet page, with the IPC shim injected as the first script
     * in <body>. Reusing desktop-pet.html means the OBS copy can never drift
     * from the desktop one.
     */
    function servePetPage(res) {
        fs.readFile(path.join(rootDir, 'desktop-pet.html'), 'utf8', (err, html) => {
            if (err) { res.writeHead(500); res.end('desktop-pet.html not found'); return; }
            const tag = '<script src="/src/renderer/obs-shim.js"></script>';
            const out = html.includes('<body>')
                ? html.replace('<body>', `<body>\n${tag}`)
                : tag + html;   // no body tag: still run the shim first
            res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
            res.end(out);
        });
    }

    function handle(req, res) {
        const url = req.url || '/';
        const pathOnly = url.split('?')[0];

        // Never let another origin poke at this server.
        const host = req.headers.host || '';
        if (host && !/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host)) {
            res.writeHead(403); res.end('forbidden'); return;
        }

        if (pathOnly === '/' || pathOnly === '/obs' || pathOnly === '/index.html') {
            servePetPage(res);
            return;
        }
        if (pathOnly === '/api/config') {
            let cfg = {};
            try { cfg = getConfig ? getConfig() : {}; } catch { /* defaults */ }
            sendJson(res, 200, sanitizeConfig(cfg));
            return;
        }
        if (pathOnly.startsWith('/model/')) {
            const dir = getModelDir ? getModelDir() : null;
            if (!dir) { res.writeHead(404); res.end('no model'); return; }
            const file = resolveWithin(dir, pathOnly.slice('/model/'.length));
            if (!file) { res.writeHead(403); res.end('forbidden'); return; }
            serveFile(res, file);
            return;
        }
        // App assets: only these three trees, nothing else on disk.
        for (const prefix of ['/src/', '/libs/', '/assets/']) {
            if (pathOnly.startsWith(prefix)) {
                const file = resolveWithin(rootDir, pathOnly);
                if (!file) { res.writeHead(403); res.end('forbidden'); return; }
                serveFile(res, file);
                return;
            }
        }
        res.writeHead(404);
        res.end('not found');
    }

    function broadcast(channel, args) {
        if (!clients.size) return;
        const payload = JSON.stringify({ channel, args: Array.isArray(args) ? args : [args] });
        for (const c of clients) {
            try { if (c.readyState === 1) c.send(payload); } catch { /* dropped */ }
        }
    }

    function start(preferredPort = 0) {
        if (server) return Promise.resolve({ port, url: url() });
        server = http.createServer(handle);
        if (WebSocketServer) {
            wss = new WebSocketServer({ server, path: '/ws' });
            wss.on('connection', (sock) => {
                clients.add(sock);
                logger.log?.(`[OBS] browser source connected (${clients.size} active)`);
                // Push current state so a late client is not stuck on defaults.
                try {
                    const cfg = getConfig ? getConfig() : {};
                    sock.send(JSON.stringify({ channel: 'init', args: [sanitizeConfig(cfg)] }));
                } catch { /* ignore */ }
                sock.on('close', () => {
                    clients.delete(sock);
                    logger.log?.(`[OBS] browser source disconnected (${clients.size} active)`);
                });
                sock.on('error', () => clients.delete(sock));
            });
        }
        return new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(preferredPort, '127.0.0.1', () => {
                port = server.address().port;
                logger.log?.(`[OBS] browser source ready at ${url()}`);
                resolve({ port, url: url() });
            });
        });
    }

    function close() {
        for (const c of clients) { try { c.close(); } catch { /* ignore */ } }
        clients.clear();
        if (wss) { try { wss.close(); } catch { /* ignore */ } wss = null; }
        if (server) { try { server.close(); } catch { /* ignore */ } server = null; }
        port = 0;
    }

    function url() {
        return port ? `http://127.0.0.1:${port}/obs` : '';
    }

    return {
        start, close, broadcast, url,
        get port() { return port; },
        get clients() { return clients.size; },
        get running() { return !!server; },
    };
}

module.exports = { createObsServer, sanitizeConfig, resolveWithin, MIME, SECRET_KEY_RE };
