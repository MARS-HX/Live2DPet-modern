/**
 * EnhanceIPC — Enhancement data persistence and web search.
 * Extracted from main.js lines 1157-1273.
 */
function registerEnhanceIPC(ctx, ipcMain, deps) {
    // deps: { app, fs, https, http }
    const { app, fs, https, http } = deps;

    const enhanceDataPath = app.isPackaged
        ? require('path').join(app.getPath('userData'), 'enhance-data.json')
        : require('path').join(app.getAppPath(), 'enhance-data.json');

    ipcMain.handle('save-enhance-data', async (event, data) => {
        try {
            fs.writeFileSync(enhanceDataPath, JSON.stringify(data, null, 2), 'utf-8');
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('load-enhance-data', async () => {
        try {
            if (fs.existsSync(enhanceDataPath)) {
                return { success: true, data: JSON.parse(fs.readFileSync(enhanceDataPath, 'utf-8')) };
            }
            return { success: true, data: {} };
        } catch (e) {
            return { success: true, data: {} };
        }
    });

    function httpGet(url, timeout = 10000, extraHeaders = {}) {
        return new Promise((resolve, reject) => {
            const mod = url.startsWith('https') ? https : http;
            const req = mod.get(url, { timeout, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', ...extraHeaders } }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({ status: res.statusCode, data }));
            });
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            req.on('error', reject);
        });
    }

    function parseDDGResults(html) {
        const results = [];
        const regex = /class="result__snippet"[^>]*>([\s\S]*?)<\//gi;
        let match;
        while ((match = regex.exec(html)) !== null && results.length < 3) {
            const text = match[1].replace(/<[^>]+>/g, '').trim();
            if (text.length > 10) results.push(text);
        }
        if (results.length > 0) return results.join(' | ');
        const pRegex = /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/gi;
        while ((match = pRegex.exec(html)) !== null && results.length < 3) {
            const text = match[1].replace(/<[^>]+>/g, '').trim();
            if (text.length > 5) results.push(text);
        }
        return results.length > 0 ? results.join(' | ') : null;
    }

    ipcMain.handle('web-search', async (event, query, provider, options = {}) => {
        try {
            query = query.replace(/[A-Za-z0-9_-]{20,}/g, '').trim();
            if (!query) return { success: false, error: 'empty_query' };

            if (provider === 'custom' && options.customUrl) {
                const url = new URL(options.customUrl);
                url.searchParams.set('q', query);
                const headers = { 'User-Agent': 'Live2DPet/1.8.0' };
                if (options.customApiKey) headers['Authorization'] = `Bearer ${options.customApiKey}`;
                if (options.customHeaders) Object.assign(headers, options.customHeaders);
                const mod = url.protocol === 'https:' ? https : http;
                const result = await new Promise((resolve, reject) => {
                    const req = mod.get(url.toString(), { timeout: 10000, headers }, (res) => {
                        let data = '';
                        res.on('data', chunk => data += chunk);
                        res.on('end', () => resolve({ status: res.statusCode, data }));
                    });
                    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                    req.on('error', reject);
                });
                if (result.status !== 200) return { success: false, error: `HTTP ${result.status}` };
                try {
                    const json = JSON.parse(result.data);
                    const snippets = (json.webPages?.value || json.results || [])
                        .slice(0, 3)
                        .map(p => p.snippet || p.content || p.description || p.name || '')
                        .filter(s => s.length > 10);
                    if (snippets.length > 0) return { success: true, results: snippets.join(' | ') };
                    const fallback = json.abstract || JSON.stringify(json).slice(0, 300);
                    return { success: true, results: fallback };
                } catch {
                    return { success: true, results: result.data.slice(0, 300) };
                }
            }

            if (provider === 'duckduckgo') {
                const encodedQuery = encodeURIComponent(query);
                const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;
                const result = await httpGet(url);
                if (result.status !== 200) return { success: false, error: `HTTP ${result.status}` };
                const parsed = parseDDGResults(result.data);
                if (!parsed) {
                    console.log(`[Enhance:Search] Parse failed for duckduckgo, query: ${query}`);
                    return { success: false, error: 'parse_failed' };
                }
                console.log(`[Enhance:Search] duckduckgo success for: ${query}`);
                return { success: true, results: parsed };
            }

            return { success: false, error: 'unknown_provider' };
        } catch (e) {
            console.error(`[Enhance:Search] Error:`, e.message);
            return { success: false, error: e.message };
        }
    });
}

module.exports = { registerEnhanceIPC };
