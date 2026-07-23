/**
 * AppContext — Shared mutable state for all main-process modules.
 * Replaces the top-level `let` variables that were in main.js.
 */
class AppContext {
    constructor() {
        this.petWindow = null;
        this.chatBubbleWindow = null;
        this.settingsWindow = null;
        this.tray = null;
        this.isQuitting = false;
        this.characterData = { isLive2DActive: true, live2dModelPath: null };
        this.pathUtils = null;
        this.ttsService = null;
        this._cachedLang = 'en';
    }
}

module.exports = { AppContext };
