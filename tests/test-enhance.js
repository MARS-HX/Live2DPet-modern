/**
 * Unit tests for v1.8.0 Enhancement System
 * Run with: node --test tests/test-enhance.js
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const enhanceDir = path.join(__dirname, '..', 'src', 'core', 'enhance');

/** Load enhance modules into global.window (simulates browser script loading order) */
function loadEnhanceModules(...files) {
    global.window = {
        I18N: { en: {
            'sys.screenContent': 'Screen Content', 'sys.todayActivity': "Today's Activity",
            'sys.usageHistory': 'Usage History', 'sys.relatedInfo': 'Related Info', 'sys.knowledge': 'Knowledge',
            'sys.knowledgePrompt': 'Summarize in max 150 chars. Output in {0}.',
            'sys.vlmPrompt': 'Extract keywords. Output in {0}.',
            'sys.kbTopicPrompt': 'Extract topics from: {0}',
            'sys.kbTermsPrompt': 'Search terms for "{0}". Time: {1}',
            'sys.searchQueryPrompt': 'Extract 1-3 search keywords from this window title. Return JSON array.',
            'sys.emotionPrompt': 'Pick emotion from [{0}].',
            'sys.secsAgo': 's ago', 'sys.minsAgo': 'min ago',
            'sys.backgroundInfo': 'Background Info (no reaction needed)',
            'sys.situationHistory': 'Recent context (continuity reference only, avoid repeating)'
        } }
    };
    global.window._enhanceLang = 'en';
    for (const file of files) {
        const src = fs.readFileSync(path.join(enhanceDir, file), 'utf-8');
        eval(src);
    }
    // Expose window globals to eval scope (modules reference each other by name)
    const w = global.window;
    if (w.STOP_WORDS) global.STOP_WORDS = w.STOP_WORDS;
    if (w.tokenizeTitle) global.tokenizeTitle = w.tokenizeTitle;
    if (w.enhanceT) global.enhanceT = w.enhanceT;
    if (w.enhanceLang) global.enhanceLang = w.enhanceLang;
    if (w.enhanceLangName) global.enhanceLangName = w.enhanceLangName;
    if (w.isNoiseTitle) global.isNoiseTitle = w.isNoiseTitle;
    if (w.sanitizeSecrets) global.sanitizeSecrets = w.sanitizeSecrets;
    if (w.compactTitle) global.compactTitle = w.compactTitle;
    if (w.ShortTermPool) global.ShortTermPool = w.ShortTermPool;
    if (w.LongTermPool) global.LongTermPool = w.LongTermPool;
    if (w.MemoryTracker) global.MemoryTracker = w.MemoryTracker;
    if (w.SearchService) global.SearchService = w.SearchService;
    if (w.KnowledgeStore) global.KnowledgeStore = w.KnowledgeStore;
    if (w.VLMExtractor) global.VLMExtractor = w.VLMExtractor;
    if (w.EnhancementOrchestrator) global.EnhancementOrchestrator = w.EnhancementOrchestrator;
    if (w.KnowledgeAcquisition) global.KnowledgeAcquisition = w.KnowledgeAcquisition;
}

// ========== Test: ShortTermPool ==========

describe('ShortTermPool', () => {
    let ShortTermPool;

    beforeEach(() => {
        loadEnhanceModules('context-pool.js', 'enhance-utils.js');
        ShortTermPool = global.window.ShortTermPool;
    });

    it('should set and get values', () => {
        const pool = new ShortTermPool();
        pool.set('key1', 'value1');
        assert.strictEqual(pool.get('key1'), 'value1');
    });

    it('should return null for missing keys', () => {
        const pool = new ShortTermPool();
        assert.strictEqual(pool.get('missing'), null);
    });

    it('has returns correct boolean', () => {
        const pool = new ShortTermPool();
        pool.set('exists', true);
        assert.strictEqual(pool.has('exists'), true);
        assert.strictEqual(pool.has('nope'), false);
    });

    it('delete removes entry', () => {
        const pool = new ShortTermPool();
        pool.set('key', 'val');
        pool.delete('key');
        assert.strictEqual(pool.get('key'), null);
    });

    it('clear removes all entries', () => {
        const pool = new ShortTermPool();
        pool.set('a', 1);
        pool.set('b', 2);
        pool.clear();
        assert.strictEqual(pool.get('a'), null);
        assert.strictEqual(pool.get('b'), null);
    });

    it('getAge returns Infinity for missing keys', () => {
        const pool = new ShortTermPool();
        assert.strictEqual(pool.getAge('missing'), Infinity);
    });

    it('getAge returns small value for recent keys', () => {
        const pool = new ShortTermPool();
        pool.set('recent', 'val');
        assert.ok(pool.getAge('recent') < 100);
    });

    it('prune keeps maxEntries most recent', () => {
        const pool = new ShortTermPool();
        for (let i = 0; i < 10; i++) {
            pool.set(`key${i}`, i);
            pool._store[`key${i}`].updatedAt = Date.now() - (10 - i) * 1000;
        }
        pool.prune(5);
        assert.strictEqual(pool.has('key0'), false);
        assert.strictEqual(pool.has('key9'), true);
    });
});

// ========== Test: LongTermPool ==========

describe('LongTermPool', () => {
    let LongTermPool;

    beforeEach(() => {
        loadEnhanceModules('context-pool.js', 'enhance-utils.js');
        LongTermPool = global.window.LongTermPool;
    });

    it('should set and get per-title data', () => {
        const pool = new LongTermPool();
        pool.setForTitle('react tutorial', 'memory', { totalSec: 100 });
        assert.deepStrictEqual(pool.getForTitle('react tutorial', 'memory'), { totalSec: 100 });
    });

    it('returns null for missing title/layer', () => {
        const pool = new LongTermPool();
        assert.strictEqual(pool.getForTitle('missing', 'memory'), null);
    });

    it('marks dirty on set', () => {
        const pool = new LongTermPool();
        assert.strictEqual(pool.isDirty, false);
        pool.setForTitle('test', 'memory', {});
        assert.strictEqual(pool.isDirty, true);
    });

    it('clearForTitle removes title data', () => {
        const pool = new LongTermPool();
        pool.setForTitle('test', 'memory', { x: 1 });
        pool.clearForTitle('test');
        assert.strictEqual(pool.getForTitle('test', 'memory'), null);
    });

    it('titleCount returns correct count', () => {
        const pool = new LongTermPool();
        pool.setForTitle('a', 'memory', {});
        pool.setForTitle('b', 'memory', {});
        assert.strictEqual(pool.titleCount, 2);
    });

    it('query returns matching titles by Jaccard similarity', () => {
        const pool = new LongTermPool();
        pool.setForTitle('react tutorial basics', 'knowledge', { summary: 'React basics' });
        pool.setForTitle('python machine learning', 'knowledge', { summary: 'ML stuff' });
        pool.setForTitle('advanced react hooks', 'knowledge', { summary: 'Hooks deep dive' });

        const results = pool.query('react hooks tutorial', { layer: 'knowledge', minConfidence: 0.1 });
        assert.ok(results.length >= 1);
        // react tutorial basics and advanced react hooks should match
        const titles = results.map(r => r.title);
        assert.ok(titles.some(t => t.includes('react')));
    });

    it('query returns empty for no matches', () => {
        const pool = new LongTermPool();
        pool.setForTitle('python flask', 'knowledge', { summary: 'Flask web' });
        const results = pool.query('java spring boot', { layer: 'knowledge', minConfidence: 0.3 });
        assert.strictEqual(results.length, 0);
    });

    it('query respects maxResults', () => {
        const pool = new LongTermPool();
        for (let i = 0; i < 10; i++) {
            pool.setForTitle(`react topic ${i}`, 'knowledge', { summary: `Topic ${i}` });
        }
        const results = pool.query('react topic', { layer: 'knowledge', maxResults: 3, minConfidence: 0.1 });
        assert.ok(results.length <= 3);
    });

    it('_tokenize handles CJK and special chars', () => {
        const pool = new LongTermPool();
        const tokens = pool._tokenize('React - Tutorial | 教程');
        assert.ok(tokens.includes('react'));
        assert.ok(tokens.includes('tutorial'));
        assert.ok(tokens.includes('教程'));
    });

    it('_jaccardSimilarity computes correctly', () => {
        const pool = new LongTermPool();
        assert.strictEqual(pool._jaccardSimilarity(['a', 'b'], ['a', 'b']), 1);
        assert.strictEqual(pool._jaccardSimilarity(['a', 'b'], ['c', 'd']), 0);
        assert.strictEqual(pool._jaccardSimilarity(['a', 'b', 'c'], ['b', 'c', 'd']), 0.5);
        assert.strictEqual(pool._jaccardSimilarity([], []), 0);
    });

    it('query uses VLM keywords for enriched matching', () => {
        const pool = new LongTermPool();
        // Store a title with VLM keywords that differ from the title itself
        pool.setForTitle('some app window', 'vlm', { summary: 'react, hooks, useState', enrichedTitle: 'React Hooks Tutorial' });
        pool.setForTitle('some app window', 'knowledge', { summary: 'React info' });
        // Query by VLM keywords — should match even though title tokens don't overlap
        const results = pool.query('react hooks guide', { layer: 'knowledge', minConfidence: 0.1 });
        assert.ok(results.length >= 1);
        assert.strictEqual(results[0].title, 'some app window');
    });
});

// ========== Test: MemoryTracker ==========

describe('MemoryTracker', () => {
    let MemoryTracker, ShortTermPool, LongTermPool;

    beforeEach(() => {
        loadEnhanceModules('context-pool.js', 'enhance-utils.js', 'memory-tracker.js');
        ShortTermPool = global.window.ShortTermPool;
        LongTermPool = global.window.LongTermPool;
        MemoryTracker = global.window.MemoryTracker;
    });

    it('should instantiate with defaults', () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const mt = new MemoryTracker(sp, lp);
        assert.strictEqual(mt.enabled, true);
        assert.strictEqual(mt.retentionDays, 30);
    });

    it('recordFocus accumulates counts', () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const mt = new MemoryTracker(sp, lp);
        mt.recordFocus('Chrome');
        mt.recordFocus('Chrome');
        mt.recordFocus('VSCode');
        const counts = mt.getSessionCounts();
        assert.strictEqual(counts['Chrome'], 2);
        assert.strictEqual(counts['VSCode'], 1);
    });

    it('recordFocus does nothing when disabled', () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const mt = new MemoryTracker(sp, lp);
        mt.enabled = false;
        mt.recordFocus('Chrome');
        assert.deepStrictEqual(mt.getSessionCounts(), {});
    });

    it('flush writes to long pool and resets session', () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const mt = new MemoryTracker(sp, lp);
        mt.recordFocus('Chrome');
        mt.recordFocus('Chrome');
        mt.flush();
        const mem = lp.getForTitle('Chrome', 'memory');
        assert.ok(mem);
        assert.strictEqual(mem.totalSec, 2);
        assert.strictEqual(mem.dayCount, 1);
        assert.deepStrictEqual(mt.getSessionCounts(), {});
    });

    it('flush accumulates across multiple flushes', () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const mt = new MemoryTracker(sp, lp);
        mt.recordFocus('Chrome');
        mt.flush();
        mt.recordFocus('Chrome');
        mt.recordFocus('Chrome');
        mt.flush();
        const mem = lp.getForTitle('Chrome', 'memory');
        assert.strictEqual(mem.totalSec, 3);
    });

    it('publishToShortPool updates short pool', () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const mt = new MemoryTracker(sp, lp);
        mt.recordFocus('Chrome');
        mt.publishToShortPool();
        const today = sp.get('memory.today');
        assert.strictEqual(today['Chrome'], 1);
    });

    it('configure updates settings', () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const mt = new MemoryTracker(sp, lp);
        mt.configure({ enabled: false, retentionDays: 7 });
        assert.strictEqual(mt.enabled, false);
        assert.strictEqual(mt.retentionDays, 7);
    });
});

// ========== Test: SearchService ==========

describe('SearchService', () => {
    let SearchService;

    beforeEach(() => {
        loadEnhanceModules('search-service.js');
        SearchService = global.window.SearchService;
    });

    it('should instantiate with defaults', () => {
        const ss = new SearchService();
        assert.strictEqual(ss.enabled, false);
        assert.strictEqual(ss.provider, 'custom');
    });

    it('configure updates settings', () => {
        const ss = new SearchService();
        ss.configure({ enabled: true, provider: 'duckduckgo', customUrl: 'http://test' });
        assert.strictEqual(ss.enabled, true);
        assert.strictEqual(ss.provider, 'duckduckgo');
        assert.strictEqual(ss.customUrl, 'http://test');
    });

    it('search returns disabled when not enabled', async () => {
        const ss = new SearchService();
        const result = await ss.search('test');
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'disabled');
    });

    it('search returns no_ipc when no electronAPI', async () => {
        const ss = new SearchService();
        ss.enabled = true;
        const result = await ss.search('test');
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'no_ipc');
    });

    it('search calls webSearch IPC', async () => {
        const ss = new SearchService();
        ss.enabled = true;
        ss.provider = 'custom';
        ss.customUrl = 'https://api.example.com/search';
        let capturedArgs = null;
        global.window.electronAPI = {
            webSearch: async (q, p, o) => {
                capturedArgs = { q, p, o };
                return { success: true, results: 'test results' };
            }
        };
        const result = await ss.search('react hooks');
        assert.strictEqual(result.success, true);
        assert.strictEqual(capturedArgs.q, 'react hooks');
        assert.strictEqual(capturedArgs.p, 'custom');
        assert.strictEqual(capturedArgs.o.customUrl, 'https://api.example.com/search');
    });
});

// ========== Test: KnowledgeStore ==========

describe('KnowledgeStore', () => {
    let KnowledgeStore, ShortTermPool, LongTermPool;

    beforeEach(() => {
        loadEnhanceModules('context-pool.js', 'enhance-utils.js', 'knowledge-store.js');
        ShortTermPool = global.window.ShortTermPool;
        LongTermPool = global.window.LongTermPool;
        KnowledgeStore = global.window.KnowledgeStore;
    });

    it('should instantiate with defaults', () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const ks = new KnowledgeStore(sp, lp, null);
        assert.strictEqual(ks.enabled, false);
        assert.strictEqual(ks.minIntervalMs, 60000);
    });

    it('configure updates settings', () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const ks = new KnowledgeStore(sp, lp, null);
        ks.configure({ enabled: true, minIntervalMs: 30000 });
        assert.strictEqual(ks.enabled, true);
        assert.strictEqual(ks.minIntervalMs, 30000);
    });

    it('maybeUpdate does nothing when disabled', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const ks = new KnowledgeStore(sp, lp, null);
        await ks.maybeUpdate('test', 'search results');
        assert.strictEqual(lp.getForTitle('test', 'knowledge'), null);
    });

    it('maybeUpdate stores knowledge from LLM', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const mockAI = {
            callAPI: async () => '[React] A JavaScript library for building UIs'
        };
        const ks = new KnowledgeStore(sp, lp, mockAI);
        ks.enabled = true;
        await ks.maybeUpdate('React Tutorial', 'React is a JS library...');
        const knowledge = lp.getForTitle('React Tutorial', 'knowledge');
        assert.ok(knowledge);
        assert.ok(knowledge.summary.includes('React'));
        assert.strictEqual(knowledge.updateCount, 1);
    });

    it('maybeUpdate respects interval backoff', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        let callCount = 0;
        const mockAI = {
            callAPI: async () => { callCount++; return 'summary'; }
        };
        const ks = new KnowledgeStore(sp, lp, mockAI);
        ks.enabled = true;
        ks.minIntervalMs = 60000;
        await ks.maybeUpdate('test', 'data');
        assert.strictEqual(callCount, 1);
        // Second call within interval should be skipped
        await ks.maybeUpdate('test', 'data');
        assert.strictEqual(callCount, 1);
    });

    it('resetInterval clears backoff', () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const ks = new KnowledgeStore(sp, lp, null);
        ks._intervals['test'] = 120000;
        ks._lastUpdateTime['test'] = Date.now();
        ks.resetInterval('test');
        assert.strictEqual(ks._intervals['test'], undefined);
        assert.strictEqual(ks._lastUpdateTime['test'], undefined);
    });
});

// ========== Test: EnhancementOrchestrator ==========

describe('EnhancementOrchestrator', { skip: 'v2.0 停用文本流水线,对应实现见 enhancement-orchestrator.js 注释块,重启该功能时一并恢复' }, () => {
    let EnhancementOrchestrator, ShortTermPool, LongTermPool, MemoryTracker, SearchService, KnowledgeStore, VLMExtractor;

    beforeEach(() => {
        loadEnhanceModules('context-pool.js', 'enhance-utils.js', 'memory-tracker.js', 'search-service.js', 'knowledge-store.js', 'vlm-extractor.js', 'enhancement-orchestrator.js');
        ShortTermPool = global.window.ShortTermPool;
        LongTermPool = global.window.LongTermPool;
        MemoryTracker = global.window.MemoryTracker;
        SearchService = global.window.SearchService;
        KnowledgeStore = global.window.KnowledgeStore;
        VLMExtractor = global.window.VLMExtractor;
        EnhancementOrchestrator = global.window.EnhancementOrchestrator;
    });

    it('should instantiate with all sub-modules', () => {
        const eo = new EnhancementOrchestrator(null);
        assert.ok(eo.shortPool instanceof ShortTermPool);
        assert.ok(eo.longPool instanceof LongTermPool);
        assert.ok(eo.memoryTracker instanceof MemoryTracker);
        assert.ok(eo.searchService instanceof SearchService);
        assert.ok(eo.knowledgeStore instanceof KnowledgeStore);
        assert.ok(eo.vlmExtractor instanceof VLMExtractor);
    });

    it('onFocusTick delegates to memoryTracker', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.onFocusTick('Chrome');
        eo.onFocusTick('Chrome');
        const counts = eo.memoryTracker.getSessionCounts();
        assert.strictEqual(counts['Chrome'], 2);
    });

    it('isNoiseTitle filters noise', () => {
        assert.strictEqual(isNoiseTitle('New Tab'), true);
        assert.strictEqual(isNoiseTitle('Desktop'), true);
        assert.strictEqual(isNoiseTitle('ab'), true);
        assert.strictEqual(isNoiseTitle(''), true);
        assert.strictEqual(isNoiseTitle(null), true);
        assert.strictEqual(isNoiseTitle('React Tutorial'), false);
    });

    it('sanitizeSecrets masks long alphanumeric sequences', () => {
        assert.strictEqual(sanitizeSecrets('key=sk-abc123def456ghi789jkl'), 'key=[***]');
        assert.strictEqual(sanitizeSecrets('short ok'), 'short ok');
        assert.strictEqual(sanitizeSecrets(null), null);
        assert.strictEqual(sanitizeSecrets(''), '');
        assert.strictEqual(sanitizeSecrets('normal text React Tutorial'), 'normal text React Tutorial');
        // 20+ chars get masked
        assert.strictEqual(sanitizeSecrets('a'.repeat(20)), '[***]');
        assert.strictEqual(sanitizeSecrets('a'.repeat(19)), 'a'.repeat(19));
    });

    it('_shouldSearch returns false when search disabled', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.searchService.enabled = false;
        assert.strictEqual(eo._shouldSearch('React'), false);
    });

    it('_shouldSearch returns false for noise titles', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.searchService.enabled = true;
        assert.strictEqual(eo._shouldSearch('New Tab'), false);
    });

    it('_shouldSearch returns false when focus time too low', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.searchService.enabled = true;
        eo._minFocusSeconds = 10;
        // No focus data in short pool
        assert.strictEqual(eo._shouldSearch('React Tutorial'), false);
    });

    it('_shouldSearch returns true when all conditions met', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.searchService.enabled = true;
        eo._minFocusSeconds = 5;
        eo._maxSearchFrequencyMs = 0;
        eo.shortPool.set('memory.today', { 'React Tutorial': 15 });
        assert.strictEqual(eo._shouldSearch('React Tutorial'), true);
    });

    it('_shouldSearch returns false for IDE titles', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.searchService.enabled = true;
        eo._minFocusSeconds = 0;
        eo._maxSearchFrequencyMs = 0;
        eo.shortPool.set('memory.today', { 'live2dpet - Cursor': 100 });
        assert.strictEqual(eo._shouldSearch('live2dpet - Cursor'), false);
    });

    it('_isIDETitle detects various IDE suffixes', () => {
        const eo = new EnhancementOrchestrator(null);
        assert.strictEqual(eo._isIDETitle('live2dpet - Cursor'), true);
        assert.strictEqual(eo._isIDETitle('project - VS Code'), true);
        assert.strictEqual(eo._isIDETitle('app - IntelliJ'), true);
        assert.strictEqual(eo._isIDETitle('React Tutorial'), false);
        assert.strictEqual(eo._isIDETitle('Cursor Settings'), false);
    });

    it('_shouldSearch respects per-title cooldown', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.searchService.enabled = true;
        eo._minFocusSeconds = 0;
        eo._maxSearchFrequencyMs = 0;
        eo.shortPool.set('memory.today', { 'React Tutorial': 100 });
        // First search should be allowed
        assert.strictEqual(eo._shouldSearch('React Tutorial'), true);
        // Mark as recently searched
        eo._searchedTitles['React Tutorial'] = Date.now();
        // Should be blocked by per-title cooldown
        assert.strictEqual(eo._shouldSearch('React Tutorial'), false);
        // Different title should still be allowed
        eo.shortPool.set('memory.today', { 'React Tutorial': 100, 'Vue Guide': 50 });
        assert.strictEqual(eo._shouldSearch('Vue Guide'), true);
    });

    it('_shouldSearch respects failure cooldown', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.searchService.enabled = true;
        eo._minFocusSeconds = 0;
        eo._maxSearchFrequencyMs = 0;
        eo.shortPool.set('memory.today', { 'React Tutorial': 100 });
        // Simulate failure cooldown
        eo._searchFailCooldownMs = 60000;
        eo._lastSearchTime = Date.now();
        assert.strictEqual(eo._shouldSearch('React Tutorial'), false);
        // After cooldown expires
        eo._lastSearchTime = Date.now() - 61000;
        assert.strictEqual(eo._shouldSearch('React Tutorial'), true);
    });

    it('buildEnhancedContext returns empty when no data', () => {
        const eo = new EnhancementOrchestrator(null);
        const ctx = eo.buildEnhancedContext('test');
        assert.strictEqual(ctx, '');
    });

    it('buildEnhancedContext uses dynamic label for age <= 30s', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.vlmExtractor.situationMap['React Tutorial'] = {
            situation: 'User is reading React hooks documentation',
            timestamp: Date.now() - 15000,
            focusSec: 30
        };
        const ctx = eo.buildEnhancedContext('React Tutorial');
        assert.ok(ctx.includes('Screen Content'));
        assert.ok(ctx.includes('React hooks documentation'));
        assert.ok(ctx.includes('15'));
    });

    it('buildEnhancedContext uses background label for age > 30s', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.vlmExtractor.situationMap['React Tutorial'] = {
            situation: 'User is reading React hooks documentation',
            timestamp: Date.now() - 120000,
            focusSec: 30
        };
        const ctx = eo.buildEnhancedContext('React Tutorial');
        assert.ok(ctx.includes('Background Info'));
        assert.ok(!ctx.includes('Screen Content'));
    });

    it('buildEnhancedContext returns empty for UNCHANGED situation', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.vlmExtractor.situationMap['Test'] = {
            situation: 'UNCHANGED', timestamp: Date.now(), focusSec: 20
        };
        const ctx = eo.buildEnhancedContext('Test');
        assert.strictEqual(ctx, '');
    });

    it('buildEnhancedContext appends situation history', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.vlmExtractor.situationMap['Current'] = {
            situation: 'Current activity', timestamp: Date.now() - 5000, focusSec: 30
        };
        eo.vlmExtractor._situationHistory = [
            { situation: 'Previous activity', timestamp: Date.now() - 60000, title: 'OldApp' }
        ];
        const ctx = eo.buildEnhancedContext('Current');
        assert.ok(ctx.includes('Recent context'));
        assert.ok(ctx.includes('Previous activity'));
    });

    it('buildEnhancedContext deduplicates history against current', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.vlmExtractor.situationMap['Current'] = {
            situation: 'Same text', timestamp: Date.now() - 5000, focusSec: 30
        };
        eo.vlmExtractor._situationHistory = [
            { situation: 'Same text', timestamp: Date.now() - 60000, title: 'OldApp' }
        ];
        const ctx = eo.buildEnhancedContext('Current');
        assert.ok(!ctx.includes('Recent context'));
    });

    it('buildEnhancedContext falls back to most recent when low focus', () => {
        const eo = new EnhancementOrchestrator(null);
        // No situation for 'Notification', but VSCode has one
        eo.vlmExtractor.situationMap['VSCode'] = {
            situation: 'User is editing main.js',
            timestamp: Date.now() - 5000,
            focusSec: 60
        };
        // 'Notification' has 0 focus and no situation → should fall back
        const ctx = eo.buildEnhancedContext('Notification');
        assert.ok(ctx.includes('editing main.js'));
    });

    it('buildEnhancedContext returns empty when no VLM situation', () => {
        const eo = new EnhancementOrchestrator(null);
        const ctx = eo.buildEnhancedContext('unknown title');
        assert.strictEqual(ctx, '');
    });

    it('stop flushes and cleans up', async () => {
        const eo = new EnhancementOrchestrator(null);
        eo.memoryTracker.recordFocus('test');
        await eo.stop();
        // After stop, session counts should be flushed
        assert.deepStrictEqual(eo.memoryTracker.getSessionCounts(), {});
    });
});

// ========== Test: VLMExtractor ==========

describe('VLMExtractor', () => {
    let VLMExtractor, ShortTermPool, LongTermPool;

    beforeEach(() => {
        loadEnhanceModules('context-pool.js', 'enhance-utils.js', 'vlm-extractor.js');
        ShortTermPool = global.window.ShortTermPool;
        LongTermPool = global.window.LongTermPool;
        VLMExtractor = global.window.VLMExtractor;
    });

    it('should instantiate with defaults', () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const vlm = new VLMExtractor(sp, lp, null);
        assert.strictEqual(vlm.enabled, false);
        assert.strictEqual(vlm.baseIntervalMs, 15000);
        assert.strictEqual(vlm.maxIntervalMs, 60000);
    });

    it('configure updates settings', () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const vlm = new VLMExtractor(sp, lp, null);
        vlm.configure({ enabled: true, baseIntervalMs: 5000 });
        assert.strictEqual(vlm.enabled, true);
        assert.strictEqual(vlm.baseIntervalMs, 5000);
    });

    it('maybeExtract does nothing when disabled', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        let called = false;
        const mockAI = { callAPI: async () => { called = true; return 'kw | title'; } };
        const vlm = new VLMExtractor(sp, lp, mockAI);
        await vlm.maybeExtract('React Tutorial', 'base64data');
        assert.strictEqual(called, false);
    });

    it('maybeExtract does nothing for noise titles', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        let called = false;
        const mockAI = { callAPI: async () => { called = true; return 'kw | title'; } };
        const vlm = new VLMExtractor(sp, lp, mockAI);
        vlm.enabled = true;
        await vlm.maybeExtract('New Tab', 'base64data');
        assert.strictEqual(called, false);
    });

    it('maybeExtract skips when focus time too low', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        let called = false;
        const mockAI = { callAPI: async () => { called = true; return 'kw | title'; } };
        const vlm = new VLMExtractor(sp, lp, mockAI);
        vlm.enabled = true;
        sp.set('memory.today', { 'React Tutorial': 2 });
        await vlm.maybeExtract('React Tutorial', 'base64data');
        assert.strictEqual(called, false);
    });

    it('maybeExtract calls API and stores in situationMap', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const mockAI = { callAPI: async () => 'User is learning React hooks from a tutorial page' };
        const vlm = new VLMExtractor(sp, lp, mockAI);
        vlm.enabled = true;
        vlm.minFocusSeconds = 0;
        sp.set('memory.today', { 'React Tutorial': 30 });
        await vlm.maybeExtract('React Tutorial', 'base64data', '');
        const entry = vlm.situationMap['React Tutorial'];
        assert.ok(entry);
        assert.ok(entry.situation.includes('React'));
        assert.strictEqual(entry.focusSec, 30);
    });

    it('second extraction replaces situation', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        let callCount = 0;
        const mockAI = { callAPI: async () => {
            callCount++;
            return callCount === 1 ? 'Old situation' : 'New situation';
        }};
        const vlm = new VLMExtractor(sp, lp, mockAI);
        vlm.enabled = true;
        vlm.minFocusSeconds = 0;
        vlm.baseIntervalMs = 0;
        sp.set('memory.today', { 'Test': 30 });

        await vlm.maybeExtract('Test', 'base64data', '');
        assert.ok(vlm.situationMap['Test'].situation.includes('Old'));

        vlm._extracting = false;
        vlm._lastExtractTime = {};
        vlm._intervals = {};

        await vlm.maybeExtract('Test', 'base64data', '');
        assert.ok(vlm.situationMap['Test'].situation.includes('New'));
        assert.ok(!vlm.situationMap['Test'].situation.includes('Old'));
    });

    it('maybeExtract sends window title, background context and image in API call', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        let capturedMessages = null;
        const mockAI = { callAPI: async (msgs) => { capturedMessages = msgs; return 'Updated situation'; } };
        const vlm = new VLMExtractor(sp, lp, mockAI);
        vlm.enabled = true;
        vlm.minFocusSeconds = 0;
        sp.set('memory.today', { 'Test': 30 });
        await vlm.maybeExtract('Test', 'base64data', 'Recent activity summary');
        const userContent = capturedMessages[1].content;
        // v2.0 关键帧模式:用户消息只含窗口标题、背景上下文与截图,不再注入历史 situation
        assert.strictEqual(userContent[0].text, 'Window: Test\nBackground:\nRecent activity summary');
        assert.ok(userContent[1].image_url.url.includes('base64data'));
    });

    it('getSituation returns from short-term map', () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const vlm = new VLMExtractor(sp, lp, null);
        vlm.situationMap['Test'] = { situation: 'test situation', timestamp: Date.now(), focusSec: 10 };
        assert.strictEqual(vlm.getSituation('Test'), 'test situation');
    });

    it('getSituation falls back to long-term', () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const vlm = new VLMExtractor(sp, lp, null);
        lp.setForTitle('Persisted', 'vlm', { situation: 'persisted situation', lastUpdated: Date.now() });
        assert.strictEqual(vlm.getSituation('Persisted'), 'persisted situation');
    });

    it('getSituationMeta returns entry with timestamp', () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const vlm = new VLMExtractor(sp, lp, null);
        const ts = Date.now() - 5000;
        vlm.situationMap['Test'] = { situation: 'test', timestamp: ts, focusSec: 10 };
        const meta = vlm.getSituationMeta('Test');
        assert.strictEqual(meta.situation, 'test');
        assert.strictEqual(meta.timestamp, ts);
    });

    it('getSituationMeta falls back to long-term', () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const vlm = new VLMExtractor(sp, lp, null);
        const ts = Date.now() - 10000;
        lp.setForTitle('Persisted', 'vlm', { situation: 'persisted', lastUpdated: ts });
        const meta = vlm.getSituationMeta('Persisted');
        assert.strictEqual(meta.situation, 'persisted');
        assert.strictEqual(meta.timestamp, ts);
    });

    it('getMostRecent returns latest entry', () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const vlm = new VLMExtractor(sp, lp, null);
        vlm.situationMap['Old'] = { situation: 'old', timestamp: Date.now() - 10000, focusSec: 10 };
        vlm.situationMap['New'] = { situation: 'new', timestamp: Date.now(), focusSec: 20 };
        const recent = vlm.getMostRecent();
        assert.strictEqual(recent.title, 'New');
        assert.strictEqual(recent.situation, 'new');
    });

    it('promotes to long-term when focus exceeds threshold', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const mockAI = { callAPI: async () => 'Promoted situation' };
        const vlm = new VLMExtractor(sp, lp, mockAI);
        vlm.enabled = true;
        vlm.minFocusSeconds = 0;
        vlm.promotionThreshold = 100;
        sp.set('memory.today', { 'Frequent App': 150 });
        await vlm.maybeExtract('Frequent App', 'base64data', '');
        const persisted = lp.getForTitle('Frequent App', 'vlm');
        assert.ok(persisted);
        assert.ok(persisted.promoted);
        assert.ok(persisted.situation.includes('Promoted'));
    });

    it('evicts oldest when over maxSituations', () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const vlm = new VLMExtractor(sp, lp, null);
        vlm.maxSituations = 3;
        for (let i = 0; i < 5; i++) {
            vlm.situationMap[`title${i}`] = { situation: `s${i}`, timestamp: Date.now() - (5 - i) * 1000, focusSec: 10 };
        }
        vlm._evictShortTerm();
        assert.strictEqual(Object.keys(vlm.situationMap).length, 3);
        // Oldest (title0, title1) should be evicted
        assert.strictEqual(vlm.situationMap['title0'], undefined);
        assert.strictEqual(vlm.situationMap['title1'], undefined);
        assert.ok(vlm.situationMap['title4']);
    });

    it('resetInterval clears tracking', () => {
        const vlm = new VLMExtractor(new ShortTermPool(), new LongTermPool(), null);
        vlm._intervals['test'] = 30000;
        vlm._lastExtractTime['test'] = Date.now();
        vlm.resetInterval('test');
        assert.strictEqual(vlm._intervals['test'], undefined);
        assert.strictEqual(vlm._lastExtractTime['test'], undefined);
    });

    it('startCapture and stopCapture manage lifecycle', () => {
        const vlm = new VLMExtractor(new ShortTermPool(), new LongTermPool(), null);
        vlm.startCapture();
        assert.strictEqual(vlm._captureActive, true);
        vlm.stopCapture();
        assert.strictEqual(vlm._captureActive, false);
        assert.strictEqual(vlm.getBufferSize(), 0);
    });

    it('pushScreenshot adds to mipmap L0', async () => {
        const vlm = new VLMExtractor(new ShortTermPool(), new LongTermPool(), null);
        vlm.startCapture();
        await vlm.pushScreenshot('img1', 'Title1');
        assert.strictEqual(vlm._mipmapLevels[0].entries.length, 1);
        assert.strictEqual(vlm.getBufferSize(), 1);
    });

    it('pushScreenshot cascades overflow from L0 to L1 to L2', async () => {
        const vlm = new VLMExtractor(new ShortTermPool(), new LongTermPool(), null);
        vlm.startCapture();
        // 每级 maxSize=1:推入 3 张后逐级溢出,最新一张留在 L0,最旧的级联到 L2
        await vlm.pushScreenshot('img1', 'T1');
        await vlm.pushScreenshot('img2', 'T2');
        await vlm.pushScreenshot('img3', 'T3');
        assert.strictEqual(vlm._mipmapLevels[0].entries.length, 1);
        assert.strictEqual(vlm._mipmapLevels[1].entries.length, 1);
        assert.strictEqual(vlm._mipmapLevels[2].entries.length, 1);
        assert.strictEqual(vlm.getBufferSize(), 3); // 1+1+1
        assert.strictEqual(vlm._mipmapLevels[0].entries[0].title, 'T3');
        assert.strictEqual(vlm._mipmapLevels[2].entries[0].title, 'T1');
    });

    it('pushScreenshot does nothing when capture inactive', async () => {
        const vlm = new VLMExtractor(new ShortTermPool(), new LongTermPool(), null);
        await vlm.pushScreenshot('img1', 'Title1');
        assert.strictEqual(vlm.getBufferSize(), 0);
    });

    it('_getPreviousScreenshot returns matching title from L1/L2', async () => {
        const vlm = new VLMExtractor(new ShortTermPool(), new LongTermPool(), null);
        vlm.startCapture();
        // Push enough to cascade 'App' into L1
        await vlm.pushScreenshot('img1', 'App');
        await vlm.pushScreenshot('img2', 'Other');
        await vlm.pushScreenshot('img3', 'App'); // img1 cascades to L1
        const prev = vlm._getPreviousScreenshot('App');
        assert.ok(prev);
        assert.strictEqual(prev.title, 'App');
    });

    it('getScreenshotsForMainAI returns time-staggered entries from different levels', async () => {
        const vlm = new VLMExtractor(new ShortTermPool(), new LongTermPool(), null);
        vlm.startCapture();
        // Fill enough to cascade across levels
        for (let i = 0; i < 7; i++) await vlm.pushScreenshot(`img${i}`, `T${i}`);
        // Should have entries in L0, L1, L2
        const shots = vlm.getScreenshotsForMainAI(3);
        assert.ok(shots.length >= 2);
        assert.ok(shots.length <= 3);
    });

    it('getRecentHistory returns recent situation entries', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const mockAI = { callAPI: async () => 'situation text' };
        const vlm = new VLMExtractor(sp, lp, mockAI);
        vlm.enabled = true;
        vlm.minFocusSeconds = 0;
        vlm.baseIntervalMs = 0;
        sp.set('memory.today', { 'App1': 30, 'App2': 30 });

        await vlm.maybeExtract('App1', 'base64', '');
        vlm._extracting = false;
        vlm._lastExtractTime = {};
        vlm._intervals = {};
        await vlm.maybeExtract('App2', 'base64', '');

        const history = vlm.getRecentHistory(5);
        // Both extractions returned same text, but first one creates entry, second is duplicate → only 1
        // Actually they have different titles so both should be stored
        assert.ok(history.length >= 1);
        assert.ok(history[0].situation.length > 0);
    });

    it('UNCHANGED output does not update situationMap', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const mockAI = { callAPI: async () => 'UNCHANGED' };
        const vlm = new VLMExtractor(sp, lp, mockAI);
        vlm.enabled = true;
        vlm.minFocusSeconds = 0;
        sp.set('memory.today', { 'Test': 30 });
        vlm.situationMap['Test'] = { situation: 'old situation', timestamp: 1000, focusSec: 10 };
        await vlm.maybeExtract('Test', 'base64', '');
        assert.strictEqual(vlm.situationMap['Test'].situation, 'old situation');
        assert.strictEqual(vlm.situationMap['Test'].timestamp, 1000);
    });

    it('setContextGatherer stores callback', () => {
        const vlm = new VLMExtractor(new ShortTermPool(), new LongTermPool(), null);
        const fn = () => 'context';
        vlm.setContextGatherer(fn);
        assert.strictEqual(vlm._contextGatherer, fn);
    });

    it('configure accepts captureTimerMs', () => {
        const vlm = new VLMExtractor(new ShortTermPool(), new LongTermPool(), null);
        vlm.configure({ captureTimerMs: 5000 });
        assert.strictEqual(vlm._captureTimerMs, 5000);
    });
});

// ========== Test: KnowledgeAcquisition ==========

describe('KnowledgeAcquisition', () => {
    let KnowledgeAcquisition, ShortTermPool, LongTermPool, SearchService;

    beforeEach(() => {
        loadEnhanceModules('context-pool.js', 'enhance-utils.js', 'search-service.js', 'knowledge-acquisition.js');
        ShortTermPool = global.window.ShortTermPool;
        LongTermPool = global.window.LongTermPool;
        SearchService = global.window.SearchService;
        KnowledgeAcquisition = global.window.KnowledgeAcquisition;
    });

    it('should instantiate with defaults', () => {
        const ka = new KnowledgeAcquisition(new ShortTermPool(), new LongTermPool(), null, new SearchService());
        assert.strictEqual(ka.enabled, false);
        assert.strictEqual(ka.minFocusSeconds, 60);
        assert.strictEqual(ka._taskQueue.length, 0);
    });

    it('configure updates settings', () => {
        const ka = new KnowledgeAcquisition(new ShortTermPool(), new LongTermPool(), null, new SearchService());
        ka.configure({ enabled: true, minFocusSeconds: 30, maxTermsPerTopic: 5 });
        assert.strictEqual(ka.enabled, true);
        assert.strictEqual(ka.minFocusSeconds, 30);
        assert.strictEqual(ka.maxTermsPerTopic, 5);
    });

    it('maybeAcquire does nothing when disabled', async () => {
        let called = false;
        const mockAI = { callAPI: async () => { called = true; return '["React"]'; } };
        const ka = new KnowledgeAcquisition(new ShortTermPool(), new LongTermPool(), mockAI, new SearchService());
        await ka.maybeAcquire('test', 'react hooks', 120);
        assert.strictEqual(called, false);
    });

    it('maybeAcquire does nothing when search is disabled', async () => {
        let called = false;
        const mockAI = { callAPI: async () => { called = true; return '["React"]'; } };
        const ss = new SearchService();
        ss.enabled = false;
        const ka = new KnowledgeAcquisition(new ShortTermPool(), new LongTermPool(), mockAI, ss);
        ka.enabled = true;
        await ka.maybeAcquire('test', 'react hooks', 120);
        assert.strictEqual(called, false);
        assert.strictEqual(ka._taskQueue.length, 0);
    });

    it('maybeAcquire does nothing when focus time too low', async () => {
        let called = false;
        const mockAI = { callAPI: async () => { called = true; return '["React"]'; } };
        const ss = new SearchService();
        ss.enabled = true;
        const ka = new KnowledgeAcquisition(new ShortTermPool(), new LongTermPool(), mockAI, ss);
        ka.enabled = true;
        await ka.maybeAcquire('test', 'react hooks', 5);
        assert.strictEqual(called, false);
    });

    it('maybeAcquire generates topics and queues tasks', async () => {
        let callCount = 0;
        const mockAI = { callAPI: async () => {
            callCount++;
            if (callCount === 1) return '["React"]';
            return '["react hooks", "react state"]';
        }};
        const ss = new SearchService();
        ss.enabled = true;
        const ka = new KnowledgeAcquisition(new ShortTermPool(), new LongTermPool(), mockAI, ss);
        ka.enabled = true;
        ka.minFocusSeconds = 0;
        await ka.maybeAcquire('test', 'react hooks useState', 120);
        assert.strictEqual(callCount, 2);
        assert.ok(ka._taskQueue.length > 0);
        assert.strictEqual(ka._taskQueue[0].topic, 'React');
        assert.strictEqual(ka._taskQueue[0].status, 'pending');
    });

    it('maybeAcquire sends short user message (not duplicate keywords)', async () => {
        const capturedMessages = [];
        const mockAI = { callAPI: async (msgs) => {
            capturedMessages.push(msgs);
            return '["React"]';
        }};
        const ss = new SearchService();
        ss.enabled = true;
        const ka = new KnowledgeAcquisition(new ShortTermPool(), new LongTermPool(), mockAI, ss);
        ka.enabled = true;
        ka.minFocusSeconds = 0;
        await ka.maybeAcquire('test', 'react hooks', 120);
        assert.strictEqual(capturedMessages[0][1].role, 'user');
        assert.strictEqual(capturedMessages[0][1].content, 'Extract.');
        if (capturedMessages.length > 1) {
            assert.strictEqual(capturedMessages[1][1].content, 'Generate.');
        }
    });

    it('processQueue returns 0 when search disabled', async () => {
        const ss = new SearchService();
        ss.enabled = false;
        const ka = new KnowledgeAcquisition(new ShortTermPool(), new LongTermPool(), null, ss);
        ka.enabled = true;
        ka._taskQueue = [{ topic: 'React', term: 'hooks', status: 'pending', retries: 0 }];
        const result = await ka.processQueue();
        assert.strictEqual(result, 0);
    });

    it('processQueue processes pending tasks', async () => {
        const ss = new SearchService();
        ss.enabled = true;
        global.window.electronAPI = {
            webSearch: async () => ({ success: true, results: 'React is a library for building UIs with components' })
        };
        const ka = new KnowledgeAcquisition(new ShortTermPool(), new LongTermPool(), null, ss);
        ka.enabled = true;
        ka._taskQueue = [
            { topic: 'React', term: 'hooks', status: 'pending', retries: 0, addedAt: Date.now() }
        ];
        const processed = await ka.processQueue(1);
        assert.strictEqual(processed, 1);
        assert.strictEqual(ka._taskQueue[0].status, 'done');
    });

    it('getQueueStatus returns correct counts', () => {
        const ka = new KnowledgeAcquisition(new ShortTermPool(), new LongTermPool(), null, new SearchService());
        ka._taskQueue = [
            { status: 'pending' }, { status: 'pending' },
            { status: 'done' }, { status: 'failed' }
        ];
        const status = ka.getQueueStatus();
        assert.strictEqual(status.pending, 2);
        assert.strictEqual(status.done, 1);
        assert.strictEqual(status.failed, 1);
        assert.strictEqual(status.total, 4);
    });

    it('_parseJSON handles valid JSON array', () => {
        const ka = new KnowledgeAcquisition(new ShortTermPool(), new LongTermPool(), null, new SearchService());
        assert.deepStrictEqual(ka._parseJSON('["a","b"]'), ['a', 'b']);
    });

    it('_parseJSON extracts array from text', () => {
        const ka = new KnowledgeAcquisition(new ShortTermPool(), new LongTermPool(), null, new SearchService());
        assert.deepStrictEqual(ka._parseJSON('Here are topics: ["React","Vue"]'), ['React', 'Vue']);
    });

    it('_parseJSON returns null for invalid input', () => {
        const ka = new KnowledgeAcquisition(new ShortTermPool(), new LongTermPool(), null, new SearchService());
        assert.strictEqual(ka._parseJSON('not json'), null);
        assert.strictEqual(ka._parseJSON(null), null);
        assert.strictEqual(ka._parseJSON(''), null);
    });

    it('decayKnowledge reduces confidence over time', () => {
        const lp = new LongTermPool();
        const ka = new KnowledgeAcquisition(new ShortTermPool(), lp, null, new SearchService());
        const twoWeeksAgo = Date.now() - 14 * 86400000;
        lp.setForTitle('old topic', 'acquired', {
            summary: 'old data', confidence: 0.8, originalConfidence: 0.8, searchedAt: twoWeeksAgo
        });
        ka.decayKnowledge();
        const decayed = lp.getForTitle('old topic', 'acquired');
        assert.ok(decayed);
        assert.ok(decayed.confidence < 0.8);
    });
});

// ========== Test: enhance-utils edge cases ==========

describe('enhance-utils edge cases', () => {
    beforeEach(() => {
        loadEnhanceModules('context-pool.js', 'enhance-utils.js');
    });

    it('compactTitle strips bilibili suffix', () => {
        const result = compactTitle('回来再练练 - 乖离型李华 - 哔哩哔哩直播，二次元弹幕直播平台');
        assert.ok(!result.includes('哔哩哔哩'));
        assert.ok(result.includes('回来再练练'));
    });

    it('compactTitle strips browser suffix', () => {
        assert.ok(!compactTitle('React Docs - Google Chrome').includes('Chrome'));
        assert.ok(!compactTitle('GitHub - Microsoft Edge').includes('Edge'));
    });

    it('compactTitle strips "和另外N个" suffix', () => {
        const result = compactTitle('React Tutorial 和另外 5 个页面');
        assert.ok(!result.includes('和另外'));
    });

    it('compactTitle truncates to maxLen', () => {
        const long = 'A'.repeat(50);
        assert.strictEqual(compactTitle(long, 10).length, 10);
    });

    it('compactTitle returns empty for null/empty', () => {
        assert.strictEqual(compactTitle(null), '');
        assert.strictEqual(compactTitle(''), '');
    });

    it('tokenizeTitle removes stop words', () => {
        const tokens = tokenizeTitle('the React is a great library');
        assert.ok(!tokens.includes('the'));
        assert.ok(!tokens.includes('is'));
        assert.ok(!tokens.includes('a'));
        assert.ok(tokens.includes('react'));
        assert.ok(tokens.includes('great'));
        assert.ok(tokens.includes('library'));
    });

    it('tokenizeTitle removes Edge personal suffix', () => {
        const tokens = tokenizeTitle('React Tutorial - 个人 - Microsoft Edge');
        assert.ok(!tokens.includes('microsoft'));
        assert.ok(!tokens.includes('edge'));
        assert.ok(tokens.includes('react'));
        assert.ok(tokens.includes('tutorial'));
    });

    it('tokenizeTitle removes "和另外N个页面"', () => {
        const tokens = tokenizeTitle('React 和另外 3 个页面');
        assert.ok(tokens.includes('react'));
        assert.ok(!tokens.some(t => t.includes('页面')));
    });

    it('tokenizeTitle filters single-char tokens', () => {
        const tokens = tokenizeTitle('A B React');
        assert.ok(!tokens.includes('a'));
        assert.ok(!tokens.includes('b'));
        assert.ok(tokens.includes('react'));
    });

    it('isNoiseTitle handles edge cases', () => {
        assert.strictEqual(isNoiseTitle('System Tray Overflow'), true);
        assert.strictEqual(isNoiseTitle('系统托盘溢出'), true);
        assert.strictEqual(isNoiseTitle('新标签页'), true);
        assert.strictEqual(isNoiseTitle('Start'), true);
        assert.strictEqual(isNoiseTitle('VSCode - main.js'), false);
    });

    it('isNoiseTitle detects Windows temp paths', () => {
        assert.strictEqual(isNoiseTitle('C:\\Users\\test\\AppData\\Local\\Temp\\file.tmp'), true);
        assert.strictEqual(isNoiseTitle('something \\AppData\\Local\\Temp\\ stuff'), true);
        assert.strictEqual(isNoiseTitle('C:\\Users\\admin\\AppData\\Roaming\\app'), true);
        assert.strictEqual(isNoiseTitle('React Tutorial - Chrome'), false);
    });

    it('sanitizeSecrets preserves normal text with special chars', () => {
        assert.strictEqual(sanitizeSecrets('Hello, World! 你好'), 'Hello, World! 你好');
        assert.strictEqual(sanitizeSecrets('path/to/file.js:42'), 'path/to/file.js:42');
    });

    it('sanitizeSecrets masks tokens and API keys', () => {
        const masked = sanitizeSecrets('Bearer sk_live_abcdefghijklmnopqrst');
        assert.ok(masked.includes('[***]'));
        assert.ok(!masked.includes('abcdefghijklmnopqrst'));
    });
});

// ========== Test: _gatherLongTermContext ==========

describe('_gatherLongTermContext', { skip: 'v2.0 停用文本流水线,对应实现见 enhancement-orchestrator.js 注释块,重启该功能时一并恢复' }, () => {
    let EnhancementOrchestrator;

    beforeEach(() => {
        loadEnhanceModules('context-pool.js', 'enhance-utils.js', 'memory-tracker.js',
            'search-service.js', 'knowledge-store.js', 'vlm-extractor.js', 'enhancement-orchestrator.js');
        EnhancementOrchestrator = global.window.EnhancementOrchestrator;
    });

    it('returns empty string when no data exists', () => {
        const eo = new EnhancementOrchestrator(null);
        assert.strictEqual(eo._gatherLongTermContext('unknown title'), '');
    });

    it('includes activity summary from short pool', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.shortPool.set('memory.today', { 'VSCode': 120, 'Chrome': 60 });
        const ctx = eo._gatherLongTermContext('VSCode');
        assert.ok(ctx.includes('Activity:'));
        assert.ok(ctx.includes('120s'));
    });

    it('activity summary shows top 5 sorted by seconds', () => {
        const eo = new EnhancementOrchestrator(null);
        const data = {};
        for (let i = 0; i < 8; i++) data[`App${i}`] = (i + 1) * 10;
        eo.shortPool.set('memory.today', data);
        const ctx = eo._gatherLongTermContext('App7');
        // Should include top 5 (App7=80, App6=70, App5=60, App4=50, App3=40)
        assert.ok(ctx.includes('80s'));
        assert.ok(!ctx.includes('10s')); // App0=10 should be excluded
    });

    it('includes knowledge RAG hits', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.longPool.setForTitle('react hooks guide', 'knowledge', {
            summary: 'React hooks allow state in functional components'
        });
        const ctx = eo._gatherLongTermContext('react hooks tutorial');
        assert.ok(ctx.includes('Knowledge:'));
        assert.ok(ctx.includes('React hooks'));
    });

    it('includes cached search results from short pool', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.shortPool.set('search.results', 'React is a JavaScript library for building UIs');
        const ctx = eo._gatherLongTermContext('React Tutorial');
        assert.ok(ctx.includes('Search:'));
        assert.ok(ctx.includes('JavaScript library'));
    });

    it('falls back to long pool search when short pool empty', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.longPool.setForTitle('react tutorial', 'search', {
            results: 'Cached: React documentation and guides', cachedAt: Date.now()
        });
        const ctx = eo._gatherLongTermContext('react tutorial');
        assert.ok(ctx.includes('Search:'));
        assert.ok(ctx.includes('Cached: React'));
    });

    it('includes acquired knowledge', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.longPool.setForTitle('react hooks', 'acquired', {
            summary: 'useState and useEffect are the most common hooks',
            confidence: 0.8
        });
        const ctx = eo._gatherLongTermContext('react hooks');
        assert.ok(ctx.includes('Acquired:'));
        assert.ok(ctx.includes('useState'));
    });

    it('combines all sections with newlines', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.shortPool.set('memory.today', { 'react tutorial': 100 });
        eo.shortPool.set('search.results', 'React search results here');
        eo.longPool.setForTitle('react tutorial', 'knowledge', { summary: 'React knowledge' });
        const ctx = eo._gatherLongTermContext('react tutorial');
        const lines = ctx.split('\n');
        assert.ok(lines.length >= 3); // Activity + Knowledge + Search
    });

    it('truncates knowledge hits to 500 chars', () => {
        const eo = new EnhancementOrchestrator(null);
        const longSummary = 'X'.repeat(600);
        eo.longPool.setForTitle('test title', 'knowledge', { summary: longSummary });
        const ctx = eo._gatherLongTermContext('test title');
        const knowledgeLine = ctx.split('\n').find(l => l.startsWith('Knowledge:'));
        assert.ok(knowledgeLine);
        assert.ok(knowledgeLine.length <= 'Knowledge: '.length + 500 + 5);
    });

    it('truncates search results to 500 chars', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.shortPool.set('search.results', 'S'.repeat(700));
        const ctx = eo._gatherLongTermContext('test');
        const searchLine = ctx.split('\n').find(l => l.startsWith('Search:'));
        assert.ok(searchLine);
        assert.ok(searchLine.length <= 'Search: '.length + 500 + 5);
    });

    it('truncates acquired knowledge to 400 chars', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.longPool.setForTitle('test', 'acquired', {
            summary: 'A'.repeat(500), confidence: 0.8
        });
        const ctx = eo._gatherLongTermContext('test');
        const acquiredLine = ctx.split('\n').find(l => l.startsWith('Acquired:'));
        assert.ok(acquiredLine);
        assert.ok(acquiredLine.length <= 'Acquired: '.length + 400 + 5);
    });

    it('filters noise titles from activity summary', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.shortPool.set('memory.today', {
            'VSCode': 100, 'New Tab': 50, '系统托盘溢出': 30, 'Chrome': 20
        });
        const ctx = eo._gatherLongTermContext('VSCode');
        assert.ok(ctx.includes('Activity:'));
        assert.ok(!ctx.includes('New Tab'));
        assert.ok(!ctx.includes('系统托盘溢出'));
        assert.ok(ctx.includes('100s'));
    });

    it('returns empty activity when all titles are noise', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.shortPool.set('memory.today', { 'New Tab': 50, 'Desktop': 30 });
        const ctx = eo._gatherLongTermContext('test');
        assert.ok(!ctx.includes('Activity:'));
    });
});

// ========== Test: VLM message construction ==========

describe('VLM message construction', () => {
    let VLMExtractor, ShortTermPool, LongTermPool;

    beforeEach(() => {
        loadEnhanceModules('context-pool.js', 'enhance-utils.js', 'vlm-extractor.js');
        ShortTermPool = global.window.ShortTermPool;
        LongTermPool = global.window.LongTermPool;
        VLMExtractor = global.window.VLMExtractor;
    });

    it('message includes window title', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        let capturedMsgs = null;
        const mockAI = { callAPI: async (msgs) => { capturedMsgs = msgs; return 'situation'; } };
        const vlm = new VLMExtractor(sp, lp, mockAI);
        vlm.enabled = true;
        vlm.minFocusSeconds = 0;
        sp.set('memory.today', { 'React Tutorial': 30 });
        await vlm.maybeExtract('React Tutorial', 'base64data', '');
        assert.ok(capturedMsgs[1].content[0].text.includes('Window: React Tutorial'));
    });

    it('message includes background context when provided', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        let capturedMsgs = null;
        const mockAI = { callAPI: async (msgs) => { capturedMsgs = msgs; return 'situation'; } };
        const vlm = new VLMExtractor(sp, lp, mockAI);
        vlm.enabled = true;
        vlm.minFocusSeconds = 0;
        sp.set('memory.today', { 'Test': 30 });
        await vlm.maybeExtract('Test', 'base64data', 'Activity: VSCode: 120s\nKnowledge: React hooks');
        const userText = capturedMsgs[1].content[0].text;
        assert.ok(userText.includes('Background:'));
        assert.ok(userText.includes('Activity: VSCode: 120s'));
        assert.ok(userText.includes('Knowledge: React hooks'));
    });

    it('message omits Background when longTermContext is empty', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        let capturedMsgs = null;
        const mockAI = { callAPI: async (msgs) => { capturedMsgs = msgs; return 'situation'; } };
        const vlm = new VLMExtractor(sp, lp, mockAI);
        vlm.enabled = true;
        vlm.minFocusSeconds = 0;
        sp.set('memory.today', { 'Test': 30 });
        await vlm.maybeExtract('Test', 'base64data', '');
        const userText = capturedMsgs[1].content[0].text;
        assert.ok(!userText.includes('Background:'));
    });

    it('message omits Previous when no prior situation', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        let capturedMsgs = null;
        const mockAI = { callAPI: async (msgs) => { capturedMsgs = msgs; return 'situation'; } };
        const vlm = new VLMExtractor(sp, lp, mockAI);
        vlm.enabled = true;
        vlm.minFocusSeconds = 0;
        sp.set('memory.today', { 'NewApp': 30 });
        await vlm.maybeExtract('NewApp', 'base64data', '');
        const userText = capturedMsgs[1].content[0].text;
        assert.ok(!userText.includes('Previous:'));
    });

    it('system prompt uses vlmSituationPrompt with language', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        let capturedMsgs = null;
        const mockAI = { callAPI: async (msgs) => { capturedMsgs = msgs; return 'situation'; } };
        const vlm = new VLMExtractor(sp, lp, mockAI);
        vlm.enabled = true;
        vlm.minFocusSeconds = 0;
        sp.set('memory.today', { 'Test': 30 });
        await vlm.maybeExtract('Test', 'base64data', '');
        assert.strictEqual(capturedMsgs[0].role, 'system');
        // Should contain the vlmSituationPrompt key (since I18N mock doesn't have it, returns key)
        assert.ok(capturedMsgs[0].content.includes('sys.vlmSituationPrompt') ||
                  capturedMsgs[0].content.includes('context compressor'));
    });

    it('image is sent as image_url in user message', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        let capturedMsgs = null;
        const mockAI = { callAPI: async (msgs) => { capturedMsgs = msgs; return 'situation'; } };
        const vlm = new VLMExtractor(sp, lp, mockAI);
        vlm.enabled = true;
        vlm.minFocusSeconds = 0;
        sp.set('memory.today', { 'Test': 30 });
        await vlm.maybeExtract('Test', 'SCREENSHOT_DATA', '');
        const imageContent = capturedMsgs[1].content[1];
        assert.strictEqual(imageContent.type, 'image_url');
        assert.ok(imageContent.image_url.url.includes('data:image/jpeg;base64,SCREENSHOT_DATA'));
    });

    it('situation output is truncated to 800 chars', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const longOutput = 'X'.repeat(1000);
        const mockAI = { callAPI: async () => longOutput };
        const vlm = new VLMExtractor(sp, lp, mockAI);
        vlm.enabled = true;
        vlm.minFocusSeconds = 0;
        sp.set('memory.today', { 'Test': 30 });
        await vlm.maybeExtract('Test', 'base64data', '');
        assert.strictEqual(vlm.situationMap['Test'].situation.length, 800);
    });

    it('promoted situation summary is truncated to 600 chars', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const longOutput = 'Y'.repeat(900);
        const mockAI = { callAPI: async () => longOutput };
        const vlm = new VLMExtractor(sp, lp, mockAI);
        vlm.enabled = true;
        vlm.minFocusSeconds = 0;
        vlm.promotionThreshold = 0;
        sp.set('memory.today', { 'Test': 500 });
        await vlm.maybeExtract('Test', 'base64data', '');
        const persisted = lp.getForTitle('Test', 'vlm');
        assert.ok(persisted);
        assert.strictEqual(persisted.summary.length, 600);
        assert.strictEqual(persisted.situation.length, 800);
    });

    it('duplicate output does not update timestamp', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const mockAI = { callAPI: async () => 'Same situation text' };
        const vlm = new VLMExtractor(sp, lp, mockAI);
        vlm.enabled = true;
        vlm.minFocusSeconds = 0;
        vlm.baseIntervalMs = 0;
        sp.set('memory.today', { 'Test': 30 });

        // First extraction — sets initial situation
        await vlm.maybeExtract('Test', 'base64data', '');
        const firstTimestamp = vlm.situationMap['Test'].timestamp;
        assert.strictEqual(vlm.situationMap['Test'].situation, 'Same situation text');

        // Reset extraction state for second call
        vlm._extracting = false;
        vlm._lastExtractTime = {};
        vlm._intervals = {};

        // Wait a bit so timestamp would differ
        await new Promise(r => setTimeout(r, 20));

        // Second extraction — same output, should NOT update timestamp
        await vlm.maybeExtract('Test', 'base64data', '');
        assert.strictEqual(vlm.situationMap['Test'].timestamp, firstTimestamp);
        assert.strictEqual(vlm.situationMap['Test'].situation, 'Same situation text');
    });

    it('different output updates timestamp normally', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        let callCount = 0;
        const mockAI = { callAPI: async () => {
            callCount++;
            return callCount === 1 ? 'First situation' : 'Different situation';
        }};
        const vlm = new VLMExtractor(sp, lp, mockAI);
        vlm.enabled = true;
        vlm.minFocusSeconds = 0;
        vlm.baseIntervalMs = 0;
        sp.set('memory.today', { 'Test': 30 });

        await vlm.maybeExtract('Test', 'base64data', '');
        const firstTimestamp = vlm.situationMap['Test'].timestamp;

        vlm._extracting = false;
        vlm._lastExtractTime = {};
        vlm._intervals = {};
        await new Promise(r => setTimeout(r, 20));

        await vlm.maybeExtract('Test', 'base64data', '');
        assert.ok(vlm.situationMap['Test'].timestamp > firstTimestamp);
        assert.strictEqual(vlm.situationMap['Test'].situation, 'Different situation');
    });
});

// ========== Test: KnowledgeStore prompt construction ==========

describe('KnowledgeStore prompt construction', () => {
    let KnowledgeStore, ShortTermPool, LongTermPool;

    beforeEach(() => {
        loadEnhanceModules('context-pool.js', 'enhance-utils.js', 'knowledge-store.js');
        ShortTermPool = global.window.ShortTermPool;
        LongTermPool = global.window.LongTermPool;
        KnowledgeStore = global.window.KnowledgeStore;
    });

    it('message includes window title and search results', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        let capturedMsgs = null;
        const mockAI = { callAPI: async (msgs) => { capturedMsgs = msgs; return '[Topic] summary'; } };
        const ks = new KnowledgeStore(sp, lp, mockAI);
        ks.enabled = true;
        await ks.maybeUpdate('React Tutorial', 'React is a JS library for building UIs');
        const userContent = capturedMsgs[1].content;
        assert.ok(userContent.includes('Window: React Tutorial'));
        assert.ok(userContent.includes('Search: React is a JS library'));
    });

    it('message includes RAG context from related knowledge', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        let capturedMsgs = null;
        const mockAI = { callAPI: async (msgs) => { capturedMsgs = msgs; return '[Topic] summary'; } };
        const ks = new KnowledgeStore(sp, lp, mockAI);
        ks.enabled = true;
        // Pre-populate related knowledge
        lp.setForTitle('react hooks guide', 'knowledge', { summary: 'Hooks are functions for state' });
        await ks.maybeUpdate('react hooks tutorial', 'New search results about hooks');
        const userContent = capturedMsgs[1].content;
        assert.ok(userContent.includes('Related knowledge:'));
        assert.ok(userContent.includes('Hooks are functions'));
    });

    it('summary is truncated to 200 chars when stored', async () => {
        const sp = new ShortTermPool();
        const lp = new LongTermPool();
        const longSummary = 'Z'.repeat(300);
        const mockAI = { callAPI: async () => longSummary };
        const ks = new KnowledgeStore(sp, lp, mockAI);
        ks.enabled = true;
        await ks.maybeUpdate('Test', 'search data');
        const stored = lp.getForTitle('Test', 'knowledge');
        assert.strictEqual(stored.summary.length, 200);
    });
});

// ========== Test: PetPromptBuilder ==========

describe('PetPromptBuilder', () => {
    let PetPromptBuilder;

    beforeEach(() => {
        global.window = {
            I18N: { en: {
                'sys.responseMode': 'Respond quickly and naturally.',
                'sys.importantReminder': 'IMPORTANT: Stay in character.',
                'sys.useLanguage': 'Respond in {0}.',
                'sys.screenContent': 'Screen Content',
                'sys.secsAgo': 's ago',
                'sys.minsAgo': 'min ago',
                'sys.backgroundInfo': 'Background Info (no reaction needed)',
                'sys.situationHistory': 'Recent context (continuity reference only, avoid repeating)'
            } }
        };
        const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'prompt-builder.js'), 'utf-8');
        eval(src);
        PetPromptBuilder = global.window.PetPromptBuilder;
    });

    it('returns fallback when no character loaded', () => {
        const pb = new PetPromptBuilder();
        const prompt = pb.buildSystemPrompt('');
        assert.ok(prompt.includes('desktop pet'));
    });

    it('builds prompt with character sections in correct order', () => {
        const pb = new PetPromptBuilder();
        pb.lang = 'en';
        pb.characterPrompt = {
            name: 'Yuki',
            description: 'You are Yuki, a desktop companion.',
            personality: 'Warm and friendly.',
            scenario: 'Keep responses short.',
            rules: 'Never break character.',
            language: 'English'
        };
        const prompt = pb.buildSystemPrompt('');
        // Check order: responseMode → description → personality → scenario → rules → language
        const idxResponse = prompt.indexOf('Respond quickly');
        const idxDesc = prompt.indexOf('You are Yuki');
        const idxPersonality = prompt.indexOf('Warm and friendly');
        const idxScenario = prompt.indexOf('Keep responses short');
        const idxRules = prompt.indexOf('Never break character');
        const idxLang = prompt.indexOf('Respond in English');
        assert.ok(idxResponse < idxDesc, 'responseMode before description');
        assert.ok(idxDesc < idxPersonality, 'description before personality');
        assert.ok(idxPersonality < idxScenario, 'personality before scenario');
        assert.ok(idxScenario < idxRules, 'scenario before rules');
        assert.ok(idxRules < idxLang, 'rules before language');
    });

    it('injects dynamic context after rules separator', () => {
        const pb = new PetPromptBuilder();
        pb.lang = 'en';
        pb.characterPrompt = {
            name: 'Yuki',
            description: 'You are Yuki.',
            rules: 'Stay in character.',
            language: 'English'
        };
        const dynamicCtx = '[Screen Content (5s ago)] User is coding in VSCode';
        const prompt = pb.buildSystemPrompt(dynamicCtx);
        assert.ok(prompt.includes(dynamicCtx));
        // Dynamic context should be after rules
        const idxRules = prompt.indexOf('Stay in character');
        const idxDynamic = prompt.indexOf('User is coding');
        assert.ok(idxDynamic > idxRules, 'dynamic context after rules');
        // Dynamic context should be before language
        const idxLang = prompt.indexOf('Respond in English');
        assert.ok(idxDynamic < idxLang, 'dynamic context before language');
    });

    it('resolves template variables', () => {
        const pb = new PetPromptBuilder();
        pb.characterPrompt = {
            name: 'Miku',
            userIdentity: 'master',
            userTerm: 'you',
            description: 'You are {{petName}}, {{userIdentity}}\'s companion.'
        };
        const resolved = pb.resolveTemplate(pb.characterPrompt.description);
        assert.ok(resolved.includes('Miku'));
        assert.ok(resolved.includes('master'));
        assert.ok(!resolved.includes('{{petName}}'));
    });

    it('separates sections with --- dividers', () => {
        const pb = new PetPromptBuilder();
        pb.lang = 'en';
        pb.characterPrompt = {
            description: 'Desc.',
            rules: 'Rules here.'
        };
        const prompt = pb.buildSystemPrompt('dynamic context');
        const separators = prompt.split('---').length - 1;
        assert.ok(separators >= 2, 'at least 2 --- separators (rules + dynamic)');
    });
});

// ========== Test: buildEnhancedContext timestamp formatting ==========

describe('buildEnhancedContext timestamp formatting', { skip: 'v2.0 停用文本流水线,对应实现见 enhancement-orchestrator.js 注释块,重启该功能时一并恢复' }, () => {
    let EnhancementOrchestrator;

    beforeEach(() => {
        loadEnhanceModules('context-pool.js', 'enhance-utils.js', 'memory-tracker.js',
            'search-service.js', 'knowledge-store.js', 'vlm-extractor.js', 'enhancement-orchestrator.js');
        EnhancementOrchestrator = global.window.EnhancementOrchestrator;
    });

    it('shows seconds for age < 60s', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.vlmExtractor.situationMap['Test'] = {
            situation: 'User is coding', timestamp: Date.now() - 30000, focusSec: 20
        };
        const ctx = eo.buildEnhancedContext('Test');
        assert.ok(ctx.includes('30'));
        assert.ok(!ctx.includes('min'));
    });

    it('shows minutes for age >= 60s', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.vlmExtractor.situationMap['Test'] = {
            situation: 'User is coding', timestamp: Date.now() - 120000, focusSec: 20
        };
        const ctx = eo.buildEnhancedContext('Test');
        assert.ok(ctx.includes('2'));
    });

    it('sanitizes secrets in output', () => {
        const eo = new EnhancementOrchestrator(null);
        eo.vlmExtractor.situationMap['Test'] = {
            situation: 'User has token sk_live_abcdefghijklmnopqrst visible',
            timestamp: Date.now(), focusSec: 20
        };
        const ctx = eo.buildEnhancedContext('Test');
        assert.ok(ctx.includes('[***]'));
        assert.ok(!ctx.includes('abcdefghijklmnopqrst'));
    });

    it('does not fall back when current title has sufficient focus', () => {
        const eo = new EnhancementOrchestrator(null);
        eo._minFocusSeconds = 10;
        eo.shortPool.set('memory.today', { 'Current': 30 });
        // No situation for 'Current', but has focus → should NOT fall back
        eo.vlmExtractor.situationMap['Other'] = {
            situation: 'Other app', timestamp: Date.now(), focusSec: 60
        };
        const ctx = eo.buildEnhancedContext('Current');
        // No situation for Current and focus >= minFocus → empty (no fallback)
        assert.strictEqual(ctx, '');
    });
});
