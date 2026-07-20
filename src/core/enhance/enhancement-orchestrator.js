/**
 * Enhancement Orchestrator — Keyframe visual memory
 *
 * v2.0: Text pipeline (search, knowledge, memory, VLM situation) is SUSPENDED.
 * Only keyframe capture + LLM selection is active.
 * The skeleton for search/knowledge/memory is preserved for future reactivation.
 *
 * v2.1: Memory tracker reactivated, _gatherLongTermContext added.
 */
class EnhancementOrchestrator {
    constructor(aiClient) {
        this.aiClient = aiClient;
        this.shortPool = new ShortTermPool();
        this.longPool = new LongTermPool();
        this.vlmExtractor = new VLMExtractor(this.shortPool, this.longPool, aiClient);

        // [REACTIVATED v2.1] 重新激活记忆追踪 — 记录窗口使用习惯
        this.memoryTracker = new MemoryTracker(this.shortPool, this.longPool);
        // [SUSPENDED] 搜索和知识获取仍保持暂停
        // this.searchService = new SearchService();
        // this.knowledgeStore = new KnowledgeStore(this.shortPool, this.longPool, aiClient);
        // this.knowledgeAcq = typeof KnowledgeAcquisition !== 'undefined'
        //     ? new KnowledgeAcquisition(this.shortPool, this.longPool, aiClient, this.searchService)
        //     : null;
    }

    async init() {
        try {
            // Start memory tracker
            if (this.memoryTracker) {
                this.memoryTracker.start();
            }
            // Force VLM enabled for keyframe selection
            this.vlmExtractor.enabled = true;
            this.vlmExtractor.startCapture();
            console.log('[Enhance:Orchestrator] Initialized — keyframe + memory mode');
        } catch (e) {
            console.warn('[Enhance:Orchestrator] Init error:', e.message);
        }
    }

    async beforeRequest(title, screenshotBase64 = null) {
        if (!title) return '';
        // [REACTIVATED] 收集长期记忆上下文（窗口使用习惯 + VLM总结）
        const memoryContext = this._gatherLongTermContext(title);
        
        // 同时把 VLM 视觉记忆投喂给 ConversationStore（共享记忆）
        if (memoryContext && window.__chatStore && window.__chatStore.addVisualMemory) {
            const vlmHits = this.longPool.query(title, { layer: 'vlm', maxResults: 1, minConfidence: 0.3 });
            if (vlmHits.length > 0) {
                window.__chatStore.addVisualMemory(vlmHits[0].data.summary, title);
            }
        }
        
        return memoryContext;
    }

    async stop() {
        if (this.memoryTracker) {
            this.memoryTracker.stop();
        }
        this.vlmExtractor.stopCapture();
        console.log('[Enhance:Orchestrator] Stopped');
    }

    async reloadConfig() {
        // Keyframe mode — no config to reload
    }

    // [REACTIVATED v2.1] 窗口焦点追踪
    onFocusTick(title) {
        if (this.memoryTracker) {
            this.memoryTracker.recordFocus(title);
        }
    }

    // [REACTIVATED v2.1] 收集长期记忆上下文
    _gatherLongTermContext(title) {
        const parts = [];
        const today = this.shortPool.get('memory.today');
        if (today && Object.keys(today).length > 0) {
            const top = Object.entries(today)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([t, s]) => `${t.replace(/^[^:]*:\s*/, '').slice(0, 20)}: ${s}s`)
                .join(', ');
            if (top) parts.push(`窗口活动: ${top}`);
        }
        // 从 longPool 获取 VLM 视觉记忆
        const vlmHits = this.longPool.query(title, { layer: 'vlm', maxResults: 2, minConfidence: 0.4 });
        if (vlmHits.length > 0) {
            const vlmText = vlmHits.map(h => h.data.summary).join('; ').slice(0, 300);
            if (vlmText) parts.push(`视觉记忆: ${vlmText}`);
        }
        return parts.length > 0 ? parts.join('\n') : '';
    }
}

if (typeof window !== 'undefined') window.EnhancementOrchestrator = EnhancementOrchestrator;
