/**
 * ConversationStore — 对话历史长期记忆（增强版）
 * 将聊天记录持久化到本地 JSON 文件，启动时加载
 * 新增：记忆总结、重要性评分、主动回忆、话题提取
 */
class ConversationStore {
    constructor() {
        this.history = [];           // [{role, content, timestamp}]
        this.maxEntries = 300;       // 最多保留300条（比之前多）
        this._loaded = false;

        // ===== 新增：记忆增强模块 =====
        this.summaries = [];          // [{summary, timestamp, range}] 对话阶段总结
        this.importantTopics = [];    // [{topic, lastMentioned, count, examples}] 重要话题追踪
        this.userPreferences = {      // 用户偏好记忆
            name: '',
            likes: [],
            dislikes: [],
            habits: [],
            lastUpdated: 0
        };
        this.lastSummaryIndex = 0;    // 上次总结到的位置
        this.summaryInterval = 10;    // 每10条对话做一次总结
        this.recallInterval = 60000;  // 主动回忆间隔（1分钟）
        this._recallTimer = null;
        this._onRecallCallback = null; // 回忆触发时的回调

        // ===== 视觉记忆（与文字记忆共享） =====
        this.visualContexts = [];  // [{summary, windowTitle, timestamp}]
    }

    async load() {
        try {
            if (window.electronAPI?.loadEnhanceData) {
                const raw = await window.electronAPI.loadEnhanceData();
                // 兼容新旧格式：新格式在 data.conversation 下，旧格式在顶层
                const data = raw?.conversation || raw || {};
                if (data?.conversationHistory) {
                    this.history = data.conversationHistory;
                    console.log(`[ConversationStore] Loaded ${this.history.length} messages`);
                }
                if (data?.memorySummaries) {
                    this.summaries = data.memorySummaries;
                    console.log(`[ConversationStore] Loaded ${this.summaries.length} summaries`);
                }
                if (data?.importantTopics) {
                    this.importantTopics = data.importantTopics;
                }
                if (data?.userPreferences) {
                    this.userPreferences = { ...this.userPreferences, ...data.userPreferences };
                }
                if (data?.lastSummaryIndex !== undefined) {
                    this.lastSummaryIndex = data.lastSummaryIndex;
                }
                if (data?.visualContexts) {
                    this.visualContexts = data.visualContexts;
                }
            }
        } catch (e) {
            console.warn('[ConversationStore] Load failed:', e.message);
        }
        this._loaded = true;
    }

    async save() {
        try {
            // 裁剪历史（保留最新的）
            const trimmedHistory = this.history.slice(-this.maxEntries);
            // 清理过期的话题（30天前的移除）
            this._pruneOldTopics();

            if (window.electronAPI?.saveEnhanceData) {
                await window.electronAPI.saveEnhanceData({
                    conversationHistory: trimmedHistory,
                    memorySummaries: this.summaries.slice(-50),  // 最多保留50条总结
                    importantTopics: this.importantTopics.slice(-30), // 最多30个话题
                    userPreferences: this.userPreferences,
                    lastSummaryIndex: this.lastSummaryIndex,
                    visualContexts: this.visualContexts.slice(-20)
                });
            }
        } catch (e) {
            console.warn('[ConversationStore] Save failed:', e.message);
        }
    }

    /** ===== 增强版添加消息 ===== */
    async add(role, content) {
        const entry = {
            role,
            content,
            timestamp: Date.now()
        };
        this.history.push(entry);

        // 超出上限时裁剪旧记录
        if (this.history.length > this.maxEntries) {
            this.history = this.history.slice(-this.maxEntries);
            // 调整总结索引
            this.lastSummaryIndex = Math.max(0, this.lastSummaryIndex - (this.history.length - this.maxEntries));
        }

        await this.save();

        // === 自动触发记忆增强处理 ===
        // 1. 提取话题（异步，不阻塞）
        this._extractTopics(entry).catch(() => {});

        // 2. 如果达到总结间隔，做阶段总结
        if (this.history.length - this.lastSummaryIndex >= this.summaryInterval) {
            this._generateSummary().catch(() => {});
        }

        // 3. 学习用户偏好（从用户消息中）
        if (role === 'user') {
            this._learnPreference(content).catch(() => {});
        }
    }

    /** ===== 话题提取（优化版：只提取有意义的词组） ===== */
    async _extractTopics(entry) {
        const content = entry.content;
        // 提取至少2个中文字的词组 + 至少3个字母的英文词
        const chineseWords = content.match(/[\u4e00-\u9fff]{2,}/g) || [];
        const englishWords = content.match(/\b[a-zA-Z]{3,}\b/g) || [];
        const words = [...chineseWords, ...englishWords];

        if (words.length === 0) return;

        // 统计词频取前3
        const freq = {};
        for (const w of words) {
            freq[w] = (freq[w] || 0) + 1;
        }
        const topTopics = Object.entries(freq)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([word]) => word);

        // 更新重要话题列表
        const now = Date.now();
        for (const topic of topTopics) {
            const existing = this.importantTopics.find(t => t.topic === topic);
            if (existing) {
                existing.lastMentioned = now;
                existing.count += 1;
            } else {
                this.importantTopics.push({
                    topic,
                    firstMentioned: now,
                    lastMentioned: now,
                    count: 1,
                    examples: [content.slice(0, 50)]
                });
            }
        }
    }

    /** ===== 对话阶段总结（自动） ===== */
    async _generateSummary() {
        const startIdx = this.lastSummaryIndex;
        const segment = this.history.slice(startIdx, this.lastSummaryIndex + this.summaryInterval);
        if (segment.length < 4) return; // 太少不总结

        // 生成简单总结
        const userMsgs = segment.filter(m => m.role === 'user').map(m => m.content);
        const aiMsgs = segment.filter(m => m.role === 'assistant').map(m => m.content);

        // 用LLM总结（如果有配置）
        let summaryText = '';
        if (window.__chatAiClient && window.__chatAiClient.isConfigured()) {
            try {
                const response = await window.__chatAiClient.callAPI([
                    { role: 'system', content: '请用一句话总结以下对话的核心内容和用户兴趣，注意记住用户的偏好。只用中文回答。' },
                    { role: 'user', content: `用户说：${userMsgs.join(' | ')}\nAI说：${aiMsgs.join(' | ')}` }
                ]);
                if (response) summaryText = response;
            } catch (e) {
                // 降级到本地总结
                summaryText = this._localSummary(userMsgs, aiMsgs);
            }
        } else {
            summaryText = this._localSummary(userMsgs, aiMsgs);
        }

        this.summaries.push({
            summary: summaryText,
            timestamp: Date.now(),
            timeLabel: new Date().toLocaleString('zh-CN'),
            range: `${startIdx}-${startIdx + segment.length}`,
            messageCount: segment.length
        });

        this.lastSummaryIndex = startIdx + segment.length;
        await this.save();
        console.log('[ConversationStore] Summary generated:', summaryText.slice(0, 60));
    }

    /** 本地简单总结（备用） */
    _localSummary(userMsgs, aiMsgs) {
        const topics = this.importantTopics.slice(-5).map(t => t.topic).join('、');
        const mood = aiMsgs.join(' ').includes('哈哈') ? '开心' : 
                     aiMsgs.join(' ').includes('抱歉') ? '安抚' : '日常';
        return `聊了${userMsgs.length}轮，话题涉及${topics || '闲聊'}，氛围${mood}`;
    }

    /** ===== 学习用户偏好 ===== */
    async _learnPreference(content) {
        // 检测喜欢/不喜欢
        const likePatterns = /我喜欢|我爱|我超爱|我好爱|最喜欢|好吃|好看|好玩|推荐/g;
        const dislikePatterns = /我不喜欢|我讨厌|我恨|不好吃|不好看|不好玩|很讨厌|最讨厌|别再/g;
        const habitPatterns = /我平时|我经常|我每天|我一般|我习惯|我在用|我玩/g;

        let updated = false;

        let match;
        while ((match = likePatterns.exec(content)) !== null) {
            const after = content.slice(match.index + match[0].length, match.index + match[0].length + 20);
            const item = after.match(/[\u4e00-\u9fff\w]+/g)?.[0];
            if (item && !this.userPreferences.likes.includes(item)) {
                this.userPreferences.likes.push(item);
                updated = true;
            }
        }
        while ((match = dislikePatterns.exec(content)) !== null) {
            const after = content.slice(match.index + match[0].length, match.index + match[0].length + 20);
            const item = after.match(/[\u4e00-\u9fff\w]+/g)?.[0];
            if (item && !this.userPreferences.dislikes.includes(item)) {
                this.userPreferences.dislikes.push(item);
                updated = true;
            }
        }
        while ((match = habitPatterns.exec(content)) !== null) {
            const after = content.slice(match.index + match[0].length, match.index + match[0].length + 30);
            const habit = after.match(/[\u4e00-\u9fff\w]+/g)?.slice(0, 5).join(' ');
            if (habit && !this.userPreferences.habits.includes(habit)) {
                this.userPreferences.habits.push(habit);
                updated = true;
            }
        }

        if (updated) {
            this.userPreferences.lastUpdated = Date.now();
            await this.save();
        }
    }

    /** ===== 获取增强的对话上下文（带记忆总结） ===== */
    getEnhancedContext(maxPairs = 5) {
        const parts = [];

        // 1. 最近的对话（具体记忆）
        const recent = this.history.slice(-maxPairs * 2);
        if (recent.length > 0) {
            const contextLines = recent.map(msg =>
                `${msg.role === 'user' ? '用户' : '你'}: ${msg.content}`
            );
            parts.push('[最近对话]\n' + contextLines.join('\n'));
        }

        // 2. 历史总结（长期记忆）
        if (this.summaries.length > 0) {
            const recentSummaries = this.summaries.slice(-3);
            const summaryText = recentSummaries.map(s => 
                `[${s.timeLabel}] ${s.summary}`
            ).join('\n');
            parts.push('[历史记忆]\n' + summaryText);
        }

        // 3. 话题记忆（用户关心什么）
        if (this.importantTopics.length > 0) {
            const hotTopics = this.importantTopics
                .sort((a, b) => b.count - a.count)
                .slice(0, 5)
                .map(t => `${t.topic}（提到${t.count}次）`);
            parts.push('[用户感兴趣的话题]\n' + hotTopics.join('、'));
        }

        // 4. 视觉记忆（最近看到了什么）
        if (this.visualContexts.length > 0) {
            const recentVisuals = this.visualContexts.slice(-3);
            const visualText = recentVisuals.map(v =>
                `[看${new Date(v.timestamp).toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'})}] ${v.windowTitle}: ${v.summary}`
            ).join('\n');
            parts.push('[视觉记忆]\n' + visualText);
        }

        // 5. 用户偏好
        const prefs = [];
        if (this.userPreferences.likes.length > 0) {
            prefs.push('喜欢：' + this.userPreferences.likes.slice(-3).join('、'));
        }
        if (this.userPreferences.dislikes.length > 0) {
            prefs.push('不喜欢：' + this.userPreferences.dislikes.slice(-3).join('、'));
        }
        if (this.userPreferences.habits.length > 0) {
            prefs.push('习惯：' + this.userPreferences.habits.slice(-2).join('；'));
        }
        if (prefs.length > 0) {
            parts.push('[用户偏好]\n' + prefs.join('\n'));
        }

        return parts.join('\n\n');
    }

    /** ===== 主动回忆机制 ===== */
    startRecall(callback) {
        this._onRecallCallback = callback;
        if (this._recallTimer) clearInterval(this._recallTimer);
        
        // 每30秒检查是否该主动回忆
        this._recallTimer = setInterval(() => {
            this._tryRecall();
        }, 30000);
        
        console.log('[ConversationStore] Recall system started');
    }

    stopRecall() {
        if (this._recallTimer) {
            clearInterval(this._recallTimer);
            this._recallTimer = null;
        }
        this._onRecallCallback = null;
    }

    async _tryRecall() {
        if (!this._onRecallCallback) return;
        
        // 检查是否有记忆可供回忆
        if (this.summaries.length === 0 && this.importantTopics.length === 0) return;

        const now = Date.now();
        
        // 随机选择回忆类型
        const rand = Math.random();
        
        if (rand < 0.4 && this.importantTopics.length > 0) {
            // 回忆重要话题
            const topic = this.importantTopics[Math.floor(Math.random() * this.importantTopics.length)];
            const example = topic.examples[Math.floor(Math.random() * topic.examples.length)];
            if (example) {
                this._onRecallCallback({
                    type: 'topic',
                    text: `我记得你之前聊过${topic.topic}呢！${example.slice(0, 30)}...`,
                    topic: topic.topic
                });
            }
        } else if (rand < 0.7 && this.summaries.length > 0) {
            // 回忆历史总结
            const summary = this.summaries[Math.floor(Math.random() * this.summaries.length)];
            this._onRecallCallback({
                type: 'memory',
                text: `我想起来了，${summary.timeLabel}的时候我们${summary.summary}`,
                summary: summary.summary
            });
        } else if (this.userPreferences.likes.length > 0) {
            // 回忆用户喜好
            const like = this.userPreferences.likes[Math.floor(Math.random() * this.userPreferences.likes.length)];
            this._onRecallCallback({
                type: 'preference',
                text: `你是不是喜欢${like}来着？我记得你之前说过！`,
                preference: like
            });
        }
    }

    /** ===== 清理旧话题 ===== */
    _pruneOldTopics() {
        const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
        this.importantTopics = this.importantTopics.filter(t => 
            t.lastMentioned > thirtyDaysAgo || t.count > 3
        );
    }

    /** 获取今日对话摘要（增强版） */
    getTodaySummary() {
        const today = new Date().toDateString();
        const todayMsgs = this.history.filter(m =>
            new Date(m.timestamp).toDateString() === today
        );
        if (todayMsgs.length === 0) return '今天还没有聊过天～';
        
        const userMsgs = todayMsgs.filter(m => m.role === 'user').length;
        const assistantMsgs = todayMsgs.filter(m => m.role === 'assistant').length;
        
        // 今天的活跃话题
        const todayTopics = this.importantTopics
            .filter(t => t.lastMentioned > Date.now() - 86400000)
            .map(t => t.topic);
        
        let summary = `今天聊了 ${userMsgs + assistantMsgs} 条（我回了${assistantMsgs}条）`;
        if (todayTopics.length > 0) {
            summary += `，聊到了${todayTopics.slice(0, 3).join('、')}`;
        }
        return summary;
    }

    /** 获取最近的 N 条对话（兼容旧接口） */
    getRecentContext(maxPairs = 5) {
        const recent = this.history.slice(-maxPairs * 2);
        const contextLines = recent.map(msg =>
            `${msg.role === 'user' ? '用户' : '你'}: ${msg.content}`
        );
        return contextLines.join('\n');
    }

    /** ===== 添加视觉记忆（与文字记忆共享） ===== */
    addVisualMemory(summary, windowTitle) {
        if (!summary) return;
        this.visualContexts.push({
            summary: summary.slice(0, 300),
            windowTitle: windowTitle || '未知窗口',
            timestamp: Date.now()
        });
        // 最多保留20条最近的视觉记忆
        if (this.visualContexts.length > 20) {
            this.visualContexts = this.visualContexts.slice(-20);
        }
    }

    /** 清空记忆（增强版） */
    async clear() {
        this.history = [];
        this.summaries = [];
        this.importantTopics = [];
        this.userPreferences = { name: '', likes: [], dislikes: [], habits: [], lastUpdated: 0 };
        this.visualContexts = [];
        this.lastSummaryIndex = 0;
        await this.save();
        console.log('[ConversationStore] All memory cleared');
    }

    /** 获取详细统计 */
    getStats() {
        return {
            totalMessages: this.history.length,
            userMessages: this.history.filter(m => m.role === 'user').length,
            assistantMessages: this.history.filter(m => m.role === 'assistant').length,
            summaries: this.summaries.length,
            topics: this.importantTopics.length,
            preferences: {
                likes: this.userPreferences.likes.length,
                dislikes: this.userPreferences.dislikes.length,
                habits: this.userPreferences.habits.length
            },
            loaded: this._loaded
        };
    }
}

window.ConversationStore = ConversationStore;
