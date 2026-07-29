/**
 * Character Card CRUD — extracted from main.js
 * Handles character listing, creation, import, deletion, renaming,
 * prompt loading/saving, and built-in card management.
 */
const { isValidUUID } = require('./validators');

function registerCharacterHandlers(ctx, ipcMain, deps) {
    const { fs, path, crypto, app, dialog, configManager } = deps;
    const { loadConfigFile, saveConfigFile } = configManager;

    const bundledPromptsDir = path.join(app.getAppPath(), 'assets', 'prompts');
    const promptsDir = app.isPackaged
        ? path.join(app.getPath('userData'), 'prompts')
        : path.join(app.getAppPath(), 'assets', 'prompts');

    // ---- Init: copy bundled prompts & auto-update on version change ----

    async function initPrompts() {
        // On first run in packaged mode, copy bundled prompts to userData
        if (app.isPackaged && !fs.existsSync(promptsDir)) {
            fs.mkdirSync(promptsDir, { recursive: true });
            try {
                const files = fs.readdirSync(bundledPromptsDir);
                for (const f of files) {
                    if (f.endsWith('.json')) {
                        fs.copyFileSync(path.join(bundledPromptsDir, f), path.join(promptsDir, f));
                    }
                }
            } catch (e) {
                console.error('[Prompts] Failed to copy bundled prompts:', e.message);
            }
        }

        // Auto-update built-in character cards when app version changes
        if (app.isPackaged) {
            const versionFile = path.join(promptsDir, '.bundled-version');
            const currentVersion = app.getVersion();
            let lastVersion = '';
            try { lastVersion = fs.readFileSync(versionFile, 'utf-8').trim(); } catch {}
            if (lastVersion !== currentVersion) {
                try {
                    const config = await loadConfigFile();
                    const files = fs.readdirSync(bundledPromptsDir);
                    const clonedIds = [];
                    for (const f of files) {
                        if (!f.endsWith('.json')) continue;
                        const destPath = path.join(promptsDir, f);
                        // If user modified the built-in card (builtin flag removed by save-prompt), clone it first
                        if (fs.existsSync(destPath)) {
                            try {
                                const existing = JSON.parse(fs.readFileSync(destPath, 'utf-8'));
                                if (!existing.builtin) {
                                    // User modified this card — clone as new card to preserve their edits
                                    const cloneId = crypto.randomUUID();
                                    const clonePath = path.join(promptsDir, `${cloneId}.json`);
                                    fs.copyFileSync(destPath, clonePath);
                                    clonedIds.push(cloneId);
                                    console.log(`[Prompts] Cloned user-modified card ${f} → ${cloneId}`);
                                }
                            } catch {}
                        }
                        fs.copyFileSync(path.join(bundledPromptsDir, f), destPath);
                    }
                    if (clonedIds.length > 0) {
                        const characters = [...(config.characters || []), ...clonedIds.map(id => ({ id }))];
                        await saveConfigFile({ characters });
                    }
                    fs.writeFileSync(versionFile, currentVersion, 'utf-8');
                    console.log(`[Prompts] Updated bundled cards to v${currentVersion}`);
                } catch (e) {
                    console.error('[Prompts] Failed to update bundled prompts:', e.message);
                }
            }
        }
    }

    // ---- Helper functions ----

    function getCharacterPath(id) {
        return path.join(promptsDir, `${id}.json`);
    }

    async function ensureDefaultCharacters() {
        const config = await loadConfigFile();
        if (config.characters && config.characters.length > 0) return;
        // Migration: create defaults if no characters exist
        const defaults = [
            { id: '2bcf3d8a-85e8-47dd-aa07-792fe91cca26' }
        ];
        await saveConfigFile({
            characters: defaults,
            activeCharacterId: defaults[0].id
        });
    }

    async function syncUnlinkedCards() {
        try {
            const config = await loadConfigFile();
            const knownIds = new Set((config.characters || []).map(c => c.id));
            const files = fs.readdirSync(promptsDir);
            const newCards = [];
            for (const f of files) {
                if (!f.endsWith('.json')) continue;
                const id = f.replace('.json', '');
                if (knownIds.has(id)) continue;
                // Validate it's a real character card
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(promptsDir, f), 'utf-8'));
                    if (data.data || data.name || data.cardName) {
                        newCards.push({ id });
                        console.log(`[Prompts] Auto-linked unlinked card: ${f}`);
                    }
                } catch {}
            }
            if (newCards.length > 0) {
                const characters = [...(config.characters || []), ...newCards];
                await saveConfigFile({ characters });
            }
        } catch (e) {
            console.error('[Prompts] Failed to sync unlinked cards:', e.message);
        }
    }

    function readCardInfo(id) {
        try {
            const filePath = getCharacterPath(id);
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            const d = data.data || data;
            return { name: d.cardName || d.name || id, builtin: !!data.builtin };
        } catch { return { name: id, builtin: false }; }
    }

    // ---- IPC handlers ----

    ipcMain.handle('list-characters', async () => {
        await ensureDefaultCharacters();
        await syncUnlinkedCards();
        const config = await loadConfigFile();
        const characters = (config.characters || []).map(c => {
            const info = readCardInfo(c.id);
            return { id: c.id, name: info.name, builtin: info.builtin };
        });
        return {
            characters,
            activeCharacterId: config.activeCharacterId || ''
        };
    });

    ipcMain.handle('load-prompt', async (event, id) => {
        try {
            if (!id) {
                const config = await loadConfigFile();
                id = config.activeCharacterId;
            }
            if (!isValidUUID(id)) return { success: false, error: 'invalid character ID' };
            const filePath = getCharacterPath(id);
            if (!fs.existsSync(filePath)) return { success: false, error: 'not found' };
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            return { success: true, data: data.data || data, i18n: data.i18n || null, builtin: !!data.builtin, id };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('save-prompt', async (event, id, promptData) => {
        try {
            if (!isValidUUID(id)) return { success: false, error: 'invalid character ID' };
            const filePath = getCharacterPath(id);
            // Preserve builtin and i18n fields if they exist in the original file
            let json = { data: promptData };
            if (fs.existsSync(filePath)) {
                try {
                    const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                    if (existing.builtin) json.builtin = true;
                    if (existing.i18n) json.i18n = existing.i18n;
                } catch {}
            }
            fs.writeFileSync(filePath, JSON.stringify(json, null, 2), 'utf-8');
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('reset-builtin-cards', async () => {
        try {
            const files = fs.readdirSync(bundledPromptsDir);
            let count = 0;
            for (const f of files) {
                if (!f.endsWith('.json')) continue;
                fs.copyFileSync(path.join(bundledPromptsDir, f), path.join(promptsDir, f));
                count++;
            }
            return { success: true, count };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('create-character', async (event, name) => {
        try {
            const id = crypto.randomUUID();
            const cardName = name || 'New Character';
            const blank = {
                data: {
                    cardName,
                    name: cardName,
                    userIdentity: '',
                    userTerm: '',
                    description: '',
                    personality: '',
                    scenario: '',
                    rules: '',
                    language: ''
                }
            };
            fs.writeFileSync(getCharacterPath(id), JSON.stringify(blank, null, 2), 'utf-8');
            const config = await loadConfigFile();
            const characters = [...(config.characters || []), { id }];
            await saveConfigFile({ characters });
            return { success: true, id, name: cardName };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('import-character', async () => {
        try {
            const result = await dialog.showOpenDialog({
                title: 'Import Character Card',
                filters: [{ name: 'JSON', extensions: ['json'] }],
                properties: ['openFile', 'multiSelections']
            });
            if (result.canceled || !result.filePaths.length) return { success: false, error: 'canceled' };
            const imported = [];
            const config = await loadConfigFile();
            const characters = [...(config.characters || [])];
            for (const srcPath of result.filePaths) {
                const data = JSON.parse(fs.readFileSync(srcPath, 'utf-8'));
                if (!data.data && !data.name && !data.cardName) continue;
                const id = crypto.randomUUID();
                // Strip builtin flag from imported cards
                delete data.builtin;
                fs.writeFileSync(getCharacterPath(id), JSON.stringify(data, null, 2), 'utf-8');
                characters.push({ id });
                const d = data.data || data;
                imported.push({ id, name: d.cardName || d.name || id });
            }
            if (imported.length > 0) await saveConfigFile({ characters });
            return { success: true, imported };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('delete-character', async (event, id) => {
        try {
            if (!isValidUUID(id)) return { success: false, error: 'invalid character ID' };
            const config = await loadConfigFile();
            const characters = config.characters || [];
            if (characters.length <= 1) return { success: false, error: 'cannot delete last character' };
            const filtered = characters.filter(c => c.id !== id);
            const update = { characters: filtered };
            if (config.activeCharacterId === id) {
                update.activeCharacterId = filtered[0].id;
            }
            await saveConfigFile(update);
            const filePath = getCharacterPath(id);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            return { success: true, newActiveId: update.activeCharacterId || config.activeCharacterId };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('rename-character', async (event, id, newName) => {
        try {
            if (!isValidUUID(id)) return { success: false, error: 'invalid character ID' };
            const config = await loadConfigFile();
            const characters = (config.characters || []).map(c =>
                c.id === id ? { ...c, name: newName } : c
            );
            await saveConfigFile({ characters });
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('set-active-character', async (event, id) => {
        try {
            if (!isValidUUID(id)) return { success: false, error: 'invalid character ID' };
            await saveConfigFile({ activeCharacterId: id });
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('reset-prompt', async (event, id) => {
        // No-op for now — no per-character defaults stored
        return { success: false, error: 'no default available' };
    });

    initPrompts();
    return { getCharacterPath, readCardInfo };
}

module.exports = { registerCharacterHandlers };
