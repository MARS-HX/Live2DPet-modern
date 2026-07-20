/**
 * Enhancement Orchestrator — Keyframe visual memory
 *
 * v2.0: Text pipeline (search, knowledge, memory, VLM situation) is SUSPENDED.
 * Only keyframe capture + LLM selection is active.
 * The skeleton for search/knowledge/memory is preserved for future reactivation.
 */
class EnhancementOrchestrator {
    constructor(aiClient) {
        this.aiClient = aiClient;
        this.shortPool = new ShortTermPool();
        this.longPool = new LongTermPool();
        this.vlmExtractor = new VLMExtractor(this.shortPool, this.longPool, aiClient);

        // [SUSPENDED] Text pipeline modules — skeleton preserved
        // this.memoryTracker = new MemoryTracker(this.shortPool, this.longPool);
        // this.searchService = new SearchService();
        // this.knowledgeStore = new KnowledgeStore(this.shortPool, this.longPool, aiClient);
        // this.knowledgeAcq = typeof KnowledgeAcquisition !== 'undefined'
        //     ? new KnowledgeAcquisition(this.shortPool, this.longPool, aiClient, this.searchService)
        //     : null;
    }

    async init() {
        try {
            // Force VLM enabled for keyframe selection
            this.vlmExtractor.enabled = true;
            this.vlmExtractor.startCapture();
            console.log('[Enhance:Orchestrator] Initialized — keyframe mode');
        } catch (e) {
            console.warn('[Enhance:Orchestrator] Init error:', e.message);
        }
    }

    async beforeRequest(title, screenshotBase64 = null) {
        if (!title) return '';
        // [SUSPENDED] Search, knowledge acquisition, memory — text pipeline disabled
        return '';
    }

    async stop() {
        this.vlmExtractor.stopCapture();
        console.log('[Enhance:Orchestrator] Stopped');
    }

    async reloadConfig() {
        // Keyframe mode — no config to reload
    }
}

/* ========== [SUSPENDED] Text Pipeline Methods ==========
 * The following methods are preserved for future reactivation.
 * They were part of the search/knowledge/memory/VLM-situation pipeline
 * that fed text context to the VLM and main AI.
 * Suspended in v2.0 because the text output was not consumed by main AI.
 *

    onFocusTick(title) {
        this.memoryTracker.recordFocus(title);
    }

    _gatherLongTermContext(title) {
        const parts = [];
        const today = this.shortPool.get('memory.today');
        if (today && Object.keys(today).length > 0) {
            const top = Object.entries(today)
                .filter(([t]) => !isNoiseTitle(t))
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([t, s]) => `${compactTitle(t)}: ${s}s`)
                .join(', ');
            if (top) parts.push(`Activity: ${top}`);
        }
        const knowledgeHits = this.longPool.query(title, { layer: 'knowledge', maxResults: 3, minConfidence: 0.5 });
        if (knowledgeHits.length > 0) {
            const kText = knowledgeHits.map(h => h.data.summary).join('; ').slice(0, 500);
            parts.push(`Knowledge: ${kText}`);
        }
        const searchResults = this.shortPool.get('search.results');
        if (searchResults) {
            parts.push(`Search: ${searchResults.slice(0, 500)}`);
        } else {
            const cachedHits = this.longPool.query(title, { layer: 'search', maxResults: 1, minConfidence: 0.5 });
            if (cachedHits.length > 0) {
                parts.push(`Search: ${cachedHits[0].data.results.slice(0, 500)}`);
            }
        }
        const acquiredHits = this.longPool.query(title, { layer: 'acquired', maxResults: 3, minConfidence: 0.5 });
        if (acquiredHits.length > 0) {
            const aText = acquiredHits.map(h => h.data.summary).join('; ').slice(0, 400);
            parts.push(`Acquired: ${aText}`);
        }
        return parts.length > 0 ? parts.join('\n') : '';
    }

    _shouldSearch(title) { ... }
    _isIDETitle(title) { ... }
    _optimizeSearchQuery(title) { ... }
    _parseJSON(text) { ... }
    buildEnhancedContext(title) { ... }

*/

if (typeof window !== 'undefined') window.EnhancementOrchestrator = EnhancementOrchestrator;
