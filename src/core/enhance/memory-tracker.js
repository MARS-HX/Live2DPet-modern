/**
 * Memory Tracker — Records window focus activity
 * Pure in-memory recording with periodic batch flush to LongTermPool
 */
/**
 * Local date key, YYYY-MM-DD.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC day: east of Greenwich the
 * activity between local midnight and the UTC offset is filed under the previous
 * day (in UTC+8 everything before 08:00), so "today"/"yesterday" counts and the
 * 7-day window were both shifted by a day.
 */
function localDayKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

class MemoryTracker {
    constructor(shortPool, longPool) {
        this.shortPool = shortPool;
        this.longPool = longPool;
        this.enabled = true;
        this.retentionDays = 30;
        this._sessionCounts = {};  // {title: seconds} — pure memory
        this._flushTimer = null;
        this._flushIntervalMs = 300000; // 5 minutes
    }

    configure(config) {
        if (config.enabled !== undefined) this.enabled = config.enabled;
        if (config.retentionDays) this.retentionDays = config.retentionDays;
    }

    start() {
        this.stop();
        this._flushTimer = setInterval(() => this.flush(), this._flushIntervalMs);
        console.log('[Enhance:Memory] Started');
    }

    stop() {
        if (this._flushTimer) {
            clearInterval(this._flushTimer);
            this._flushTimer = null;
        }
        this.flush();
    }

    recordFocus(title) {
        if (!this.enabled || !title) return;
        if (!this._sessionCounts[title]) this._sessionCounts[title] = 0;
        this._sessionCounts[title] += 1;
    }

    publishToShortPool() {
        this.shortPool.set('memory.today', { ...this._sessionCounts });
    }

    flush() {
        if (!this.enabled) return;
        const today = localDayKey();

        // Snapshot current counts, then reset — new ticks during flush go to fresh map
        const snapshot = this._sessionCounts;
        this._sessionCounts = {};

        for (const [title, seconds] of Object.entries(snapshot)) {
            if (seconds === 0) continue;
            const existing = this.longPool.getForTitle(title, 'memory') || {
                totalSec: 0, lastSeen: today, dayCount: 0, recentDays: {}
            };
            existing.totalSec += seconds;
            existing.lastSeen = today;
            if (!existing.recentDays[today]) {
                existing.dayCount += 1;
            }
            existing.recentDays[today] = (existing.recentDays[today] || 0) + seconds;

            // Prune recentDays to last 7 days
            const dayKeys = Object.keys(existing.recentDays).sort().reverse();
            if (dayKeys.length > 7) {
                for (let i = 7; i < dayKeys.length; i++) {
                    delete existing.recentDays[dayKeys[i]];
                }
            }

            this.longPool.setForTitle(title, 'memory', existing);
        }

        // Publish merged view (snapshot + any new ticks) to short pool
        const merged = { ...snapshot };
        for (const [t, s] of Object.entries(this._sessionCounts)) {
            merged[t] = (merged[t] || 0) + s;
        }
        this.shortPool.set('memory.today', merged);

        // Prune old titles
        this._pruneOldTitles(today);

        console.log('[Enhance:Memory] Flushed');
    }

    _pruneOldTitles(today) {
        // Work in the same (local) calendar frame as the day keys above.
        const cutoff = new Date(today + 'T00:00:00');
        cutoff.setDate(cutoff.getDate() - this.retentionDays);
        const cutoffStr = localDayKey(cutoff);

        for (const title of this.longPool.getAllTitles()) {
            const mem = this.longPool.getForTitle(title, 'memory');
            if (mem && mem.lastSeen < cutoffStr) {
                this.longPool.clearForTitle(title);
            }
        }
    }

    getSessionCounts() { return { ...this._sessionCounts }; }
}

if (typeof window !== 'undefined') {
    window.MemoryTracker = MemoryTracker;
    window.localDayKey = localDayKey;
}
