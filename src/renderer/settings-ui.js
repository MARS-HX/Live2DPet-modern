/**
 * Settings UI Controller
 * Handles all tab interactions, model import, expression management, etc.
 */
let petSystem = null;
let currentModelConfig = {};
let suggestedMapping = null;
let scannedParamIds = [];
let scannedMotions = {};  // {group: [{file}]} from scan-model-info

// ========== i18n System ==========
let currentLang = 'en';

function t(key) {
    return (window.I18N && window.I18N[currentLang] && window.I18N[currentLang][key])
        || (window.I18N && window.I18N['en'] && window.I18N['en'][key])
        || key;
}

function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(el => {
        el.placeholder = t(el.dataset.i18nPh);
    });
}

function setLanguage(lang) {
    currentLang = lang;
    document.getElementById('lang-select').value = lang;
    applyI18n();
    if (window.electronAPI) window.electronAPI.saveConfig({ uiLanguage: lang });
    // Reload character card in new language (for built-in i18n cards)
    if (currentCharacterId) {
        loadCharacterPrompt(currentCharacterId);
        // Also refresh the character list labels (builtin tag is localized)
        loadCharacterList();
    }
    reloadPetPrompt();
}

document.getElementById('lang-select').addEventListener('change', (e) => {
    setLanguage(e.target.value);
});

document.addEventListener('DOMContentLoaded', async () => {
    petSystem = new DesktopPetSystem();
    await petSystem.init();

    // Wire emotion system callbacks to IPC
    petSystem.emotionSystem.onEmotionTriggered = (emotionName) => {
        console.log(`[SettingsUI] onEmotionTriggered → IPC triggerExpression("${emotionName}")`);
        if (window.electronAPI) window.electronAPI.triggerExpression(emotionName);
    };
    petSystem.emotionSystem.onEmotionReverted = () => {
        console.log('[SettingsUI] onEmotionReverted → IPC revertExpression');
        if (window.electronAPI) window.electronAPI.revertExpression();
    };
    petSystem.emotionSystem.onMotionTriggered = (group, index, emotionName) => {
        console.log(`[SettingsUI] onMotionTriggered → IPC triggerMotion("${group}", ${index}, "${emotionName}")`);
        if (window.electronAPI) window.electronAPI.triggerMotion(group, index);
    };

    // Load saved config
    const config = petSystem.aiClient.getConfig();
    document.getElementById('api-url').value = config.baseURL || '';
    document.getElementById('api-key').value = config.apiKey || '';
    document.getElementById('model-name').value = config.modelName || '';

    // Load full config
    if (window.electronAPI && window.electronAPI.loadConfig) {
        const fileConfig = await window.electronAPI.loadConfig();
        // Load UI language
        if (fileConfig.uiLanguage && window.I18N && window.I18N[fileConfig.uiLanguage]) {
            currentLang = fileConfig.uiLanguage;
            document.getElementById('lang-select').value = currentLang;
        }
        applyI18n();
        if (fileConfig.interval) {
            document.getElementById('interval').value = fileConfig.interval;
            petSystem.setInterval(parseInt(fileConfig.interval) * 1000);
        }
        if (fileConfig.chatGap != null) {
            document.getElementById('chat-gap').value = fileConfig.chatGap;
            petSystem.chatGapMs = parseInt(fileConfig.chatGap) * 1000;
        }
        if (fileConfig.screenshotInterval != null) {
            document.getElementById('screenshot-interval').value = fileConfig.screenshotInterval;
            petSystem.screenshotInterval = parseInt(fileConfig.screenshotInterval);
        }
        // Load translation API config
        if (fileConfig.translation) {
            document.getElementById('tl-api-url').value = fileConfig.translation.baseURL || '';
            document.getElementById('tl-api-key').value = fileConfig.translation.apiKey || '';
            document.getElementById('tl-model-name').value = fileConfig.translation.modelName || '';
        }
        // Load model config
        currentModelConfig = fileConfig.model || { type: 'none' };
        loadModelUI();
        loadEmotionUI(fileConfig);
        // Load max_tokens multiplier
        loadTokenMultiplierUI(fileConfig.maxTokensMultiplier || 1.0);
        // Load enhance config
        loadEnhanceToggle(fileConfig.enhance || {});
        // Reload prompt with correct language (after language is set)
        await reloadPetPrompt();
    }
});

// ========== Tab Switching ==========
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
        if (btn.dataset.tab === 'prompt') loadCharacterList();
    });
});

// ========== Status Helper ==========
function showStatus(id, msg, type) {
    const el = document.getElementById(id);
    el.textContent = msg;
    el.className = 'status ' + type;
    if (type !== 'info') setTimeout(() => { el.className = 'status'; }, 5000);
}

// ========== API Settings ==========
document.getElementById('btn-save-api').addEventListener('click', () => {
    const cfg = {
        baseURL: document.getElementById('api-url').value.trim(),
        apiKey: document.getElementById('api-key').value.trim(),
        modelName: document.getElementById('model-name').value.trim()
    };
    petSystem.aiClient.saveConfig(cfg);
    petSystem.systemPrompt = petSystem.promptBuilder.buildSystemPrompt();
    showStatus('api-status', t('status.saved'), 'success');
});

// ========== Translation API Settings ==========
document.getElementById('btn-save-tl').addEventListener('click', () => {
    const tl = {
        baseURL: document.getElementById('tl-api-url').value.trim(),
        apiKey: document.getElementById('tl-api-key').value.trim(),
        modelName: document.getElementById('tl-model-name').value.trim()
    };
    if (window.electronAPI) window.electronAPI.saveConfig({ translation: tl });
    showStatus('tl-status', t('status.saved'), 'success');
});

document.getElementById('btn-test-api').addEventListener('click', async () => {
    showStatus('api-status', t('status.testing'), 'info');
    const result = await petSystem.aiClient.testConnection();
    if (result.success) {
        showStatus('api-status', t('status.connected') + result.response, 'success');
    } else {
        showStatus('api-status', t('status.failed') + result.error, 'error');
    }
});

document.getElementById('btn-save-interval').addEventListener('click', () => {
    const seconds = parseInt(document.getElementById('interval').value);
    const chatGap = parseInt(document.getElementById('chat-gap').value);
    const shotInterval = parseInt(document.getElementById('screenshot-interval').value) || 0;
    if (window.electronAPI) window.electronAPI.saveConfig({ interval: seconds, chatGap, screenshotInterval: shotInterval });
    petSystem.setInterval(seconds * 1000);
    petSystem.chatGapMs = chatGap * 1000;
    petSystem.screenshotInterval = shotInterval;
});

// ========== Start/Stop ==========
document.getElementById('btn-start').addEventListener('click', () => petSystem.start());
document.getElementById('btn-stop').addEventListener('click', () => petSystem.stop());
document.getElementById('link-github').addEventListener('click', (e) => {
    e.preventDefault();
    if (window.electronAPI) window.electronAPI.openExternal('https://github.com/x380kkm/Live2DPet');
});

if (window.electronAPI) {
    window.electronAPI.onPetWindowClosed(() => {
        petSystem.isActive = false;
        petSystem.stopDetection();
    });
}

// ========== Hover State ==========
if (window.electronAPI && window.electronAPI.onPetHoverState) {
    window.electronAPI.onPetHoverState((isHovering) => {
        if (petSystem && petSystem.emotionSystem) {
            petSystem.emotionSystem.setHoverState(isHovering);
        }
    });
}

// ========== Model Tab ==========
const PARAM_LABELS = {
    angleX: 'param.angleX', angleY: 'param.angleY', angleZ: 'param.angleZ',
    bodyAngleX: 'param.bodyAngleX', eyeBallX: 'param.eyeBallX', eyeBallY: 'param.eyeBallY'
};

function loadModelUI() {
    const typeSelect = document.getElementById('model-type');
    typeSelect.value = currentModelConfig.type || 'none';
    updateModelCards();

    // Load existing values
    if (currentModelConfig.type === 'live2d') {
        document.getElementById('l2d-info').textContent =
            currentModelConfig.modelJsonFile ? `${t('status.modelInfo')}${currentModelConfig.modelJsonFile}` : '';
        document.getElementById('canvas-y-slider').value = currentModelConfig.canvasYRatio || 0.60;
        document.getElementById('canvas-y-val').textContent = (currentModelConfig.canvasYRatio || 0.60).toFixed(2);
        renderParamMapping();
    }
    if (currentModelConfig.type === 'image') {
        // Restore folder mode
        if (currentModelConfig.imageFolderPath) {
            document.getElementById('folder-info').textContent =
                `${t('status.folderInfo')}${currentModelConfig.imageFolderPath}`;
            document.getElementById('image-list-container').style.display = '';
            // Restore crop slider
            const cropScale = currentModelConfig.imageCropScale || 1.0;
            document.getElementById('image-crop-slider').value = cropScale;
            document.getElementById('image-crop-val').textContent = cropScale.toFixed(2);
            // Restore image list from saved config
            renderImageListFromConfig(currentModelConfig);
        }
    }
}

function updateModelCards() {
    const type = document.getElementById('model-type').value;
    document.getElementById('card-live2d').style.display = type === 'live2d' ? '' : 'none';
    document.getElementById('card-param-mapping').style.display = type === 'live2d' ? '' : 'none';
    document.getElementById('card-canvas-y').style.display = type === 'live2d' ? '' : 'none';
    document.getElementById('card-image').style.display = type === 'image' ? '' : 'none';
}

document.getElementById('model-type').addEventListener('change', () => {
    currentModelConfig.type = document.getElementById('model-type').value;
    updateModelCards();
});

// Canvas Y slider
document.getElementById('canvas-y-slider').addEventListener('input', (e) => {
    document.getElementById('canvas-y-val').textContent = parseFloat(e.target.value).toFixed(2);
    currentModelConfig.canvasYRatio = parseFloat(e.target.value);
});

// Image crop slider
document.getElementById('image-crop-slider').addEventListener('input', (e) => {
    document.getElementById('image-crop-val').textContent = parseFloat(e.target.value).toFixed(2);
    currentModelConfig.imageCropScale = parseFloat(e.target.value);
});

// Import Live2D
document.getElementById('btn-import-l2d').addEventListener('click', async () => {
    const result = await window.electronAPI.selectModelFolder();
    if (!result.success) {
        if (result.error !== 'cancelled') showStatus('model-status', result.error, 'error');
        return;
    }
    const folderPath = result.folderPath;
    const modelFile = result.modelFiles[0]; // Use first found

    // Scan model info
    showStatus('model-status', t('status.scanning'), 'info');
    const scanResult = await window.electronAPI.scanModelInfo(folderPath, modelFile);
    if (!scanResult.success) {
        showStatus('model-status', scanResult.error, 'error');
        return;
    }

    currentModelConfig.folderPath = folderPath;
    currentModelConfig.modelJsonFile = modelFile;
    currentModelConfig.type = 'live2d';
    document.getElementById('model-type').value = 'live2d';
    updateModelCards();

    // Store scan results
    scannedParamIds = scanResult.parameterIds || [];
    suggestedMapping = scanResult.suggestedMapping || {};

    // Show info
    const motionCount = Object.values(scanResult.motions || {}).reduce((sum, arr) => sum + arr.length, 0);
    const info = [`${t('status.modelInfo')}${scanResult.modelName}`,
        `${scannedParamIds.length} params`,
        `${scanResult.expressions.length} expr`,
        `${motionCount} motions`,
        `Moc: ${scanResult.validation.mocValid ? '✓' : '✗'}`,
        `Tex: ${scanResult.validation.texturesValid ? '✓' : '✗'}`
    ].join(' | ');
    document.getElementById('l2d-info').textContent = info;

    // Clear old expression/motion data for new model
    currentModelConfig.expressions = [];
    currentModelConfig.motionEmotions = [];
    currentModelConfig.expressionDurations = {};
    currentModelConfig.motionDurations = {};
    currentModelConfig.hasExpressions = false;

    // Auto-populate expressions
    if (scanResult.expressions.length > 0) {
        currentModelConfig.hasExpressions = true;
        currentModelConfig.expressions = scanResult.expressions.map(e => ({
            name: e.name, label: e.name, file: e.file
        }));
    }

    // Auto-populate motions
    scannedMotions = scanResult.motions || {};
    if (Object.keys(scannedMotions).length > 0) {
        const motionEmotions = [];
        for (const [group, entries] of Object.entries(scannedMotions)) {
            entries.forEach((entry, idx) => {
                const fileName = (entry.file || '').replace(/^.*[\\/]/, '').replace('.motion3.json', '');
                motionEmotions.push({
                    name: fileName || `${group}_${idx}`,
                    group, index: idx
                });
            });
        }
        currentModelConfig.motionEmotions = motionEmotions;
    }

    renderParamMapping();
    renderExpressionList(currentModelConfig);
    renderMotionList(currentModelConfig);

    // Copy to userData if checked
    if (document.getElementById('copy-to-userdata').checked) {
        showStatus('model-status', t('status.copyingModel'), 'info');
        const copyResult = await window.electronAPI.copyModelToUserdata(folderPath, scanResult.modelName);
        if (copyResult.success) {
            currentModelConfig.userDataModelPath = copyResult.userDataModelPath;
            showStatus('model-status', t('status.modelImported'), 'success');
        } else {
            showStatus('model-status', t('status.copyFailed') + copyResult.error, 'error');
        }
    } else {
        showStatus('model-status', t('status.modelSelected'), 'success');
    }
});

function renderParamMapping() {
    const container = document.getElementById('param-mapping-list');
    container.innerHTML = '';
    const pm = currentModelConfig.paramMapping || {};
    for (const [key, labelKey] of Object.entries(PARAM_LABELS)) {
        const mapped = pm[key];
        const suggested = suggestedMapping ? suggestedMapping[key] : null;
        // Sort: suggested first, then rest alphabetically
        const sorted = [...scannedParamIds].sort((a, b) => {
            if (a === suggested) return -1;
            if (b === suggested) return 1;
            return a.localeCompare(b);
        });
        const row = document.createElement('div');
        row.className = 'param-row';
        row.innerHTML = `
            <span class="param-label">${t(labelKey)}</span>
            <select class="param-select" data-key="${key}" style="flex:1;padding:4px;font-size:12px;border-radius:4px;">
                <option value="">${t('status.unmapped')}</option>
                ${sorted.map(id =>
                    `<option value="${id}" ${id === mapped ? 'selected' : ''}>${id}${id === suggested ? ' ★' : ''}</option>`
                ).join('')}
            </select>
        `;
        container.appendChild(row);
    }
    // Listen for manual changes
    container.querySelectorAll('.param-select').forEach(sel => {
        sel.addEventListener('change', () => {
            if (!currentModelConfig.paramMapping) currentModelConfig.paramMapping = {};
            currentModelConfig.paramMapping[sel.dataset.key] = sel.value || null;
        });
    });
}

document.getElementById('btn-apply-suggested').addEventListener('click', () => {
    if (!suggestedMapping) return;
    if (!currentModelConfig.paramMapping) currentModelConfig.paramMapping = {};
    for (const [key, val] of Object.entries(suggestedMapping)) {
        if (val) currentModelConfig.paramMapping[key] = val;
    }
    renderParamMapping();
    showStatus('model-status', t('status.suggestedApplied'), 'success');
});

// Import image folder
document.getElementById('btn-select-image-folder').addEventListener('click', async () => {
    const result = await window.electronAPI.selectImageFolder();
    if (!result.success) {
        if (result.error !== 'cancelled') showStatus('model-status', result.error, 'error');
        return;
    }
    const folderPath = result.folderPath;
    currentModelConfig.imageFolderPath = folderPath;
    currentModelConfig.type = 'image';
    document.getElementById('model-type').value = 'image';
    updateModelCards();

    // Scan folder for images
    showStatus('model-status', t('status.scanningImages'), 'info');
    const scanResult = await window.electronAPI.scanImageFolder(folderPath);
    if (!scanResult.success) {
        showStatus('model-status', scanResult.error, 'error');
        return;
    }

    document.getElementById('folder-info').textContent =
        `${t('status.folderInfo')}${folderPath} (${scanResult.images.length})`;
    document.getElementById('image-list-container').style.display = '';

    // Build imageFiles from scan, preserving existing config if same folder
    const existingFiles = currentModelConfig.imageFiles || [];
    const existingMap = {};
    for (const f of existingFiles) existingMap[f.file] = f;

    currentModelConfig.imageFiles = scanResult.images.map(img => {
        const existing = existingMap[img.filename];
        return existing || { file: img.filename, idle: false, talking: false, emotionName: '' };
    });

    renderImageList(currentModelConfig);
    showStatus('model-status', t('status.imagesScanned').replace('{0}', scanResult.images.length), 'success');
});

function renderImageList(modelConfig) {
    const container = document.getElementById('image-list');
    container.innerHTML = '';
    const files = modelConfig.imageFiles || [];
    const folderPath = (modelConfig.imageFolderPath || '').replace(/\\/g, '/');

    files.forEach((f, i) => {
        const row = document.createElement('div');
        row.className = 'image-item';
        row.dataset.index = i;

        const emotionDisplay = f.emotionName ? '' : 'display:none;';
        row.innerHTML = `
            <img class="image-thumb" src="file:///${folderPath}/${encodeURIComponent(f.file)}" alt="${f.file}">
            <span style="flex:1;min-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${f.file}">${f.file}</span>
            <div class="cats">
                <label><input type="checkbox" class="cat-idle" ${f.idle ? 'checked' : ''}> ${t('img.idle')}</label>
                <label><input type="checkbox" class="cat-talking" ${f.talking ? 'checked' : ''}> ${t('img.talking')}</label>
                <label><input type="checkbox" class="cat-emotion" ${f.emotionName ? 'checked' : ''}> ${t('img.emotion')}</label>
                <input type="text" class="emotion-name" value="${f.emotionName || ''}" placeholder="${t('img.emotionPh')}" style="${emotionDisplay}">
            </div>
        `;

        // Toggle emotion name input visibility
        const emotionCb = row.querySelector('.cat-emotion');
        const emotionInput = row.querySelector('.emotion-name');
        emotionCb.addEventListener('change', () => {
            emotionInput.style.display = emotionCb.checked ? '' : 'none';
            if (!emotionCb.checked) emotionInput.value = '';
        });

        container.appendChild(row);
    });
}

function renderImageListFromConfig(modelConfig) {
    // Re-render from saved config (used on load)
    renderImageList(modelConfig);
}

function collectImageFiles() {
    const items = document.querySelectorAll('#image-list .image-item');
    const files = currentModelConfig.imageFiles || [];
    items.forEach((item, i) => {
        if (!files[i]) return;
        files[i].idle = item.querySelector('.cat-idle').checked;
        files[i].talking = item.querySelector('.cat-talking').checked;
        const emotionCb = item.querySelector('.cat-emotion');
        files[i].emotionName = emotionCb.checked
            ? (item.querySelector('.emotion-name').value.trim() || '')
            : '';
    });
    return files;
}

// Bubble frame
document.getElementById('btn-select-bubble').addEventListener('click', async () => {
    const result = await window.electronAPI.selectBubbleImage();
    if (!result.success) return;
    document.getElementById('bubble-info').textContent = `${t('status.bubbleInfo')}${result.filePath}`;
    // Save to config
    await window.electronAPI.saveConfig({ bubble: { frameImagePath: result.filePath } });
});

document.getElementById('btn-clear-bubble').addEventListener('click', async () => {
    document.getElementById('bubble-info').textContent = '';
    await window.electronAPI.saveConfig({ bubble: { frameImagePath: null } });
});

// App icon
document.getElementById('btn-select-icon').addEventListener('click', async () => {
    const result = await window.electronAPI.selectAppIcon();
    if (!result.success) return;
    document.getElementById('icon-preview').src = result.iconPath;
    document.getElementById('icon-preview').style.display = '';
    document.getElementById('icon-info').textContent = `${t('status.iconInfo')}${result.iconPath}`;
    await window.electronAPI.saveConfig({ appIcon: result.iconPath });
});

// Save model config
document.getElementById('btn-save-model').addEventListener('click', async () => {
    // Collect image folder data if in image mode
    if (currentModelConfig.type === 'image' && currentModelConfig.imageFolderPath) {
        currentModelConfig.imageFiles = collectImageFiles();
        currentModelConfig.imageCropScale = parseFloat(
            document.getElementById('image-crop-slider').value
        ) || 1.0;

        // Auto-generate expressions from emotion names for the emotion system
        const emotionNames = new Set();
        for (const f of currentModelConfig.imageFiles) {
            if (f.emotionName) emotionNames.add(f.emotionName);
        }
        if (emotionNames.size > 0) {
            currentModelConfig.hasExpressions = true;
            currentModelConfig.expressions = [...emotionNames].map(name => ({
                name, label: name, file: ''
            }));
        } else {
            currentModelConfig.hasExpressions = false;
            currentModelConfig.expressions = [];
        }
    }

    await window.electronAPI.saveConfig({ model: currentModelConfig });
    showStatus('model-status', t('status.modelSaved'), 'success');
});

// Clear model
document.getElementById('btn-clear-model').addEventListener('click', async () => {
    currentModelConfig = {
        type: 'none', folderPath: null, modelJsonFile: null,
        copyToUserData: true, userDataModelPath: null,
        staticImagePath: null, bottomAlignOffset: 0.5,
        gifExpressions: {},
        imageFolderPath: null, imageFiles: [], imageCropScale: 1.0,
        paramMapping: { angleX: null, angleY: null, angleZ: null, bodyAngleX: null, eyeBallX: null, eyeBallY: null },
        hasExpressions: false, expressions: [],
        expressionDurations: {}, defaultExpressionDuration: 5000,
        motionEmotions: [], motionDurations: {}, defaultMotionDuration: 3000,
        canvasYRatio: 0.60
    };
    await window.electronAPI.saveConfig({ model: currentModelConfig });
    document.getElementById('model-type').value = 'none';
    document.getElementById('image-list').innerHTML = '';
    document.getElementById('image-list-container').style.display = 'none';
    document.getElementById('folder-info').textContent = '';
    updateModelCards();
    showStatus('model-status', t('status.modelCleared'), 'success');
});

// ========== Emotion Tab ==========
function loadEmotionUI(fileConfig) {
    if (!fileConfig) return;
    if (fileConfig.emotionFrequency) {
        document.getElementById('emotion-frequency').value = fileConfig.emotionFrequency;
    }
    if (fileConfig.allowSimultaneous) {
        document.getElementById('allow-simultaneous').checked = true;
    }
    if (fileConfig.model && fileConfig.model.defaultExpressionDuration) {
        document.getElementById('default-expr-duration').value = fileConfig.model.defaultExpressionDuration / 1000;
    }
    if (fileConfig.model && fileConfig.model.defaultMotionDuration) {
        document.getElementById('default-motion-duration').value = fileConfig.model.defaultMotionDuration / 1000;
    }
    renderExpressionList(fileConfig.model);
    renderMotionList(fileConfig.model);
}

function renderExpressionList(modelConfig) {
    const container = document.getElementById('expression-list');
    container.innerHTML = '';
    const expressions = (modelConfig && modelConfig.expressions) || [];
    const durations = (modelConfig && modelConfig.expressionDurations) || {};
    const enabledList = [];

    if (expressions.length === 0) {
        document.getElementById('expr-hint').style.display = '';
        return;
    }
    document.getElementById('expr-hint').style.display = 'none';

    expressions.forEach((expr, i) => {
        const durMs = durations[expr.name];
        const durSec = durMs ? (durMs / 1000) : '';
        const row = document.createElement('div');
        row.className = 'expr-item';
        row.innerHTML = `
            <input type="checkbox" class="expr-enabled" data-name="${expr.name}" checked>
            <input type="text" class="expr-name" value="${expr.name}" style="width:80px;padding:2px 4px;font-size:12px;" data-index="${i}">
            <span style="color:#888;font-size:11px;">${expr.file || ''}</span>
            <input type="number" class="expr-dur" value="${durSec}" placeholder="${t('status.default')}" step="0.5" min="0" style="width:60px;padding:2px 4px;font-size:12px;" data-name="${expr.name}">
            <span style="color:#888;font-size:11px;">${t('sec')}</span>
            <button class="btn btn-danger btn-sm expr-del" data-index="${i}" style="padding:2px 8px;">✕</button>
        `;
        container.appendChild(row);
    });

    // Delete expression
    container.querySelectorAll('.expr-del').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.index);
            currentModelConfig.expressions.splice(idx, 1);
            renderExpressionList(currentModelConfig);
        });
    });
}

document.getElementById('btn-add-expr').addEventListener('click', () => {
    if (!currentModelConfig.expressions) currentModelConfig.expressions = [];
    currentModelConfig.expressions.push({ name: t('status.newExpr'), label: t('status.newExpr'), file: '' });
    currentModelConfig.hasExpressions = true;
    renderExpressionList(currentModelConfig);
});

// ========== Motion List ==========
function renderMotionList(modelConfig) {
    const container = document.getElementById('motion-list');
    container.innerHTML = '';
    const motionEmotions = (modelConfig && modelConfig.motionEmotions) || [];
    const durations = (modelConfig && modelConfig.motionDurations) || {};

    if (motionEmotions.length === 0) {
        document.getElementById('motion-hint').style.display = '';
        return;
    }
    document.getElementById('motion-hint').style.display = 'none';

    // Build group options from scanned motions
    const groupOptions = Object.keys(scannedMotions);

    motionEmotions.forEach((m, i) => {
        const durMs = durations[m.name];
        const durSec = durMs ? (durMs / 1000) : '';
        const maxIdx = scannedMotions[m.group] ? scannedMotions[m.group].length - 1 : 99;
        const row = document.createElement('div');
        row.className = 'expr-item';
        row.innerHTML = `
            <input type="checkbox" class="motion-enabled" data-name="${m.name}" checked>
            <input type="text" class="motion-name" value="${m.name}" style="width:80px;padding:2px 4px;font-size:12px;" data-index="${i}">
            <select class="motion-group" data-index="${i}" style="width:80px;padding:2px 4px;font-size:12px;">
                ${groupOptions.map(g => `<option value="${g}" ${g === m.group ? 'selected' : ''}>${g}</option>`).join('')}
                ${!groupOptions.includes(m.group) ? `<option value="${m.group}" selected>${m.group}</option>` : ''}
            </select>
            <input type="number" class="motion-index" value="${m.index}" min="0" max="${maxIdx}" style="width:45px;padding:2px 4px;font-size:12px;" data-index="${i}">
            <input type="number" class="motion-dur" value="${durSec}" placeholder="${t('status.default')}" step="0.5" min="0" style="width:60px;padding:2px 4px;font-size:12px;" data-name="${m.name}">
            <span style="color:#888;font-size:11px;">${t('sec')}</span>
            <button class="btn btn-danger btn-sm motion-del" data-index="${i}" style="padding:2px 8px;">✕</button>
        `;
        container.appendChild(row);
    });

    // Delete motion
    container.querySelectorAll('.motion-del').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.index);
            currentModelConfig.motionEmotions.splice(idx, 1);
            renderMotionList(currentModelConfig);
        });
    });
}

document.getElementById('btn-add-motion').addEventListener('click', () => {
    if (!currentModelConfig.motionEmotions) currentModelConfig.motionEmotions = [];
    const firstGroup = Object.keys(scannedMotions)[0] || 'Default';
    currentModelConfig.motionEmotions.push({ name: t('status.newMotion'), group: firstGroup, index: 0 });
    renderMotionList(currentModelConfig);
});

document.getElementById('btn-save-emotion-freq').addEventListener('click', () => {
    if (!petSystem || !petSystem.emotionSystem) return;
    const freq = parseInt(document.getElementById('emotion-frequency').value);
    const simultaneous = document.getElementById('allow-simultaneous').checked;
    petSystem.emotionSystem.setExpectedFrequency(freq);
    petSystem.emotionSystem.allowSimultaneous = simultaneous;
    if (window.electronAPI) window.electronAPI.saveConfig({ allowSimultaneous: simultaneous });
    showStatus('emotion-status', t('status.saved'), 'success');
});

document.getElementById('btn-save-expressions').addEventListener('click', async () => {
    // Collect expression data from UI
    const container = document.getElementById('expression-list');
    const names = container.querySelectorAll('.expr-name');
    const durs = container.querySelectorAll('.expr-dur');
    const enabled = container.querySelectorAll('.expr-enabled');

    const expressions = [];
    const expressionDurations = {};
    const enabledEmotions = [];

    names.forEach((nameInput, i) => {
        const name = nameInput.value.trim();
        if (!name) return;
        const expr = currentModelConfig.expressions[i] || {};
        expressions.push({ name, label: name, file: expr.file || '' });
        const durSec = parseFloat(durs[i]?.value);
        if (durSec > 0) expressionDurations[name] = Math.round(durSec * 1000);
        if (enabled[i]?.checked) enabledEmotions.push(name);
    });

    // Collect motion data from UI
    const motionContainer = document.getElementById('motion-list');
    const motionNames = motionContainer.querySelectorAll('.motion-name');
    const motionGroups = motionContainer.querySelectorAll('.motion-group');
    const motionIndices = motionContainer.querySelectorAll('.motion-index');
    const motionDurs = motionContainer.querySelectorAll('.motion-dur');
    const motionEnabled = motionContainer.querySelectorAll('.motion-enabled');

    const motionEmotions = [];
    const motionDurations = {};

    motionNames.forEach((nameInput, i) => {
        const name = nameInput.value.trim();
        if (!name) return;
        const group = motionGroups[i]?.value || 'Default';
        const index = parseInt(motionIndices[i]?.value) || 0;
        motionEmotions.push({ name, group, index });
        const durSec = parseFloat(motionDurs[i]?.value);
        if (durSec > 0) motionDurations[name] = Math.round(durSec * 1000);
        if (motionEnabled[i]?.checked) enabledEmotions.push(name);
    });

    const defaultDurSec = parseFloat(document.getElementById('default-expr-duration').value);
    const defaultDur = defaultDurSec > 0 ? Math.round(defaultDurSec * 1000) : 5000;
    const defaultMotionDurSec = parseFloat(document.getElementById('default-motion-duration').value);
    const defaultMotionDur = defaultMotionDurSec > 0 ? Math.round(defaultMotionDurSec * 1000) : 3000;

    currentModelConfig.expressions = expressions;
    currentModelConfig.expressionDurations = expressionDurations;
    currentModelConfig.defaultExpressionDuration = defaultDur;
    currentModelConfig.hasExpressions = expressions.length > 0;
    currentModelConfig.motionEmotions = motionEmotions;
    currentModelConfig.motionDurations = motionDurations;
    currentModelConfig.defaultMotionDuration = defaultMotionDur;

    await window.electronAPI.saveConfig({
        model: currentModelConfig,
        enabledEmotions
    });

    // Update emotion system
    if (petSystem && petSystem.emotionSystem) {
        petSystem.emotionSystem.configureExpressions(expressions, expressionDurations, defaultDur);
        petSystem.emotionSystem.configureMotions(motionEmotions, motionDurations, defaultMotionDur);
        petSystem.emotionSystem.setEnabledEmotions(enabledEmotions);
    }

    showStatus('save-emotion-status', t('status.exprSaved'), 'success');
});

// ========== Character Card Management ==========

let currentCharacterId = null;

function fillPromptFields(data) {
    document.getElementById('prompt-name').value = data.name || '';
    document.getElementById('prompt-user-identity').value = data.userIdentity || '';
    document.getElementById('prompt-user-term').value = data.userTerm || '';
    document.getElementById('prompt-desc').value = data.description || '';
    document.getElementById('prompt-personality').value = data.personality || '';
    document.getElementById('prompt-scenario').value = data.scenario || '';
    document.getElementById('prompt-rules').value = data.rules || '';
    document.getElementById('prompt-language').value = data.language || '';
    const ha = data.hitActions || {};
    document.getElementById('prompt-hit-click').value = ha.click || '';
    document.getElementById('prompt-hit-touch').value = ha.touch || '';
    document.getElementById('prompt-hit-drag').value = ha.drag || '';
    document.getElementById('prompt-hit-swipe').value = ha.swipe || '';
    document.getElementById('prompt-hit-resize').value = ha.resize || '';
}

async function loadCharacterList() {
    if (!window.electronAPI?.listCharacters) return;
    const { characters, activeCharacterId } = await window.electronAPI.listCharacters();
    const select = document.getElementById('character-select');
    select.innerHTML = '';
    for (const c of characters) {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.builtin ? `${c.name} ${t('card.builtin')}` : c.name;
        select.appendChild(opt);
    }
    select.value = activeCharacterId;
    currentCharacterId = activeCharacterId;
    await loadCharacterPrompt(activeCharacterId);
}

async function loadCharacterPrompt(id) {
    if (!window.electronAPI?.loadPrompt) return;
    const result = await window.electronAPI.loadPrompt(id);
    if (result.success) {
        currentCharacterId = result.id || id;
        // Resolve i18n for built-in cards (display in current UI language)
        let data = { ...result.data };
        if (result.i18n && currentLang && result.i18n[currentLang]) {
            Object.assign(data, result.i18n[currentLang]);
        }
        fillPromptFields(data);
    }
}

async function reloadPetPrompt() {
    if (petSystem && petSystem.promptBuilder) {
        await petSystem.promptBuilder.loadCharacterPrompt(currentCharacterId, currentLang);
        petSystem.systemPrompt = petSystem.promptBuilder.buildSystemPrompt();
    }
}

document.getElementById('character-select').addEventListener('change', async (e) => {
    const id = e.target.value;
    await window.electronAPI.setActiveCharacter(id);
    currentCharacterId = id;
    await loadCharacterPrompt(id);
    await reloadPetPrompt();
    showStatus('prompt-status', t('status.switched'), 'success');
});

// Inline name input helper
let _nameAction = null; // 'new' | 'rename'

function showNameInput(defaultValue, action) {
    _nameAction = action;
    const row = document.getElementById('character-name-input-row');
    const input = document.getElementById('character-name-input');
    input.value = defaultValue || '';
    row.style.display = 'flex';
    input.focus();
    input.select();
}

function hideNameInput() {
    document.getElementById('character-name-input-row').style.display = 'none';
    _nameAction = null;
}

document.getElementById('btn-confirm-name').addEventListener('click', async () => {
    const name = document.getElementById('character-name-input').value.trim();
    if (!name) return;
    if (_nameAction === 'new') {
        const result = await window.electronAPI.createCharacter(name);
        if (result.success) {
            await window.electronAPI.setActiveCharacter(result.id);
            await loadCharacterList();
            showStatus('prompt-status', t('status.created') + name, 'success');
        }
    } else if (_nameAction === 'rename' && currentCharacterId) {
        const result = await window.electronAPI.renameCharacter(currentCharacterId, name);
        if (result.success) {
            await loadCharacterList();
            showStatus('prompt-status', t('status.renamed'), 'success');
        }
    }
    hideNameInput();
});

document.getElementById('btn-cancel-name').addEventListener('click', hideNameInput);

document.getElementById('character-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-confirm-name').click();
    if (e.key === 'Escape') hideNameInput();
});

document.getElementById('btn-new-character').addEventListener('click', () => {
    showNameInput('', 'new');
});

document.getElementById('btn-import-character').addEventListener('click', async () => {
    const result = await window.electronAPI.importCharacter();
    if (result.success && result.imported.length > 0) {
        const last = result.imported[result.imported.length - 1];
        await window.electronAPI.setActiveCharacter(last.id);
        await loadCharacterList();
        showStatus('prompt-status', t('status.created') + last.name, 'success');
    }
});

document.getElementById('btn-rename-character').addEventListener('click', () => {
    if (!currentCharacterId) return;
    const select = document.getElementById('character-select');
    const currentName = select.options[select.selectedIndex]?.textContent || '';
    showNameInput(currentName, 'rename');
});

document.getElementById('btn-delete-character').addEventListener('click', async () => {
    if (!currentCharacterId) return;
    const result = await window.electronAPI.deleteCharacter(currentCharacterId);
    if (result.success) {
        await loadCharacterList();
        await reloadPetPrompt();
        showStatus('prompt-status', t('status.deleted'), 'success');
    } else {
        showStatus('prompt-status', result.error, 'error');
    }
});

document.getElementById('btn-reset-builtin').addEventListener('click', async () => {
    if (!window.electronAPI?.resetBuiltinCards) return;
    const result = await window.electronAPI.resetBuiltinCards();
    if (result.success) {
        await loadCharacterList();
        await loadCharacterPrompt(currentCharacterId);
        await reloadPetPrompt();
        showStatus('prompt-status', t('status.builtinReset'), 'success');
    }
});

document.getElementById('btn-save-prompt').addEventListener('click', async () => {
    if (!currentCharacterId) return;
    const promptData = {
        name: document.getElementById('prompt-name').value,
        userIdentity: document.getElementById('prompt-user-identity').value,
        userTerm: document.getElementById('prompt-user-term').value,
        description: document.getElementById('prompt-desc').value,
        personality: document.getElementById('prompt-personality').value,
        scenario: document.getElementById('prompt-scenario').value,
        rules: document.getElementById('prompt-rules').value,
        language: document.getElementById('prompt-language').value,
        hitActions: {
            click: document.getElementById('prompt-hit-click').value.trim(),
            touch: document.getElementById('prompt-hit-touch').value.trim(),
            drag: document.getElementById('prompt-hit-drag').value.trim(),
            swipe: document.getElementById('prompt-hit-swipe').value.trim(),
            resize: document.getElementById('prompt-hit-resize').value.trim()
        }
    };
    const result = await window.electronAPI.savePrompt(currentCharacterId, promptData);
    if (result.success) {
        showStatus('prompt-status', t('status.saved'), 'success');
        await reloadPetPrompt();
    } else {
        showStatus('prompt-status', t('status.saveFail') + result.error, 'error');
    }
});

// ========== TTS Settings (Only Mimo, 精简版) ==========

// ========== TTS 服务商切换 ==========
function switchTTSProvider(provider) {
    const mimoDiv = document.getElementById('tts-config-mimo');
    const aliyunDiv = document.getElementById('tts-config-aliyun');
    const localDiv = document.getElementById('tts-config-local');
    if (!mimoDiv || !aliyunDiv || !localDiv) return;
    mimoDiv.style.display = provider === 'mimo' ? 'block' : 'none';
    aliyunDiv.style.display = provider === 'aliyun' ? 'block' : 'none';
    localDiv.style.display = provider === 'local' ? 'block' : 'none';
}

// 监听服务商切换
document.addEventListener('DOMContentLoaded', () => {
    const sel = document.getElementById('tts-provider');
    if (sel) {
        sel.addEventListener('change', () => switchTTSProvider(sel.value));
    }
});

async function loadTTSStatus() {
    if (!window.electronAPI || !window.electronAPI.ttsGetStatus) return;
    const status = await window.electronAPI.ttsGetStatus();
    const el = document.getElementById('tts-status');
    const restartBtn = document.getElementById('btn-restart-tts');
    if (status.initialized) {
        if (status.degraded) {
            const elapsed = Date.now() - status.degradedAt;
            const remaining = Math.max(0, Math.ceil((status.retryInterval - elapsed) / 1000));
            el.textContent = t('tts.circuitBreak').replace('{0}', remaining);
            el.className = 'status error';
            if (restartBtn) restartBtn.style.display = '';
        } else {
            el.textContent = t('tts.ready') + ' (Mimo)';
            el.className = 'status success';
            if (restartBtn) restartBtn.style.display = 'none';
        }
        document.getElementById('tts-hint').style.display = 'none';
    } else {
        el.textContent = t('tts.offline');
        el.className = 'status error';
        if (restartBtn) restartBtn.style.display = '';
    }
    const config = await window.electronAPI.loadConfig();
    const ttsCfg = config.tts || {};
    
    // 服务商切换
    const provider = ttsCfg.serviceType || 'mimo';
    const providerSel = document.getElementById('tts-provider');
    if (providerSel) providerSel.value = provider;
    switchTTSProvider(provider);
    
    // Mimo 配置
    const mimo = ttsCfg.mimo || {};
    document.getElementById('mimo-base-url').value = mimo.baseURL || 'https://api.xiaomimimo.com/v1';
    document.getElementById('mimo-api-key').value = mimo.apiKey || '';
    document.getElementById('mimo-style-prompt').value = mimo.stylePrompt || '自然、流畅、清晰的中文语音';
    document.getElementById('mimo-format').value = mimo.format || 'wav';
    
    // 阿里云配置
    const aliyun = ttsCfg.aliyun || {};
    const aliId = document.getElementById('aliyun-access-key-id');
    if (aliId) {
        aliId.value = aliyun.accessKeyId || '';
        document.getElementById('aliyun-access-key-secret').value = aliyun.accessKeySecret || '';
        document.getElementById('aliyun-app-key').value = aliyun.appKey || '';
        document.getElementById('aliyun-voice').value = aliyun.voice || 'xiaoyun';
        document.getElementById('aliyun-region').value = aliyun.region || 'cn-shanghai';
    }
    // 本地 VITS2 配置
    const localCfg = ttsCfg.local || {};
    const localBase = document.getElementById('local-base-url');
    if (localBase) {
        localBase.value = localCfg.baseURL || 'http://localhost:7860';
        document.getElementById('local-tts-endpoint').value = localCfg.ttsEndpoint || '/run/tts';
        document.getElementById('local-method').value = localCfg.method || 'get';
        document.getElementById('local-text-param').value = localCfg.textParam || 'text';
        document.getElementById('local-speaker').value = localCfg.speaker || '0';
        document.getElementById('local-language').value = localCfg.language || 'zh';
        document.getElementById('local-response-type').value = localCfg.responseType || 'json';
        document.getElementById('local-audio-path').value = localCfg.audioPath || 'audio';
    }
    
    // Audio mode
    const audioMode = ttsCfg.audioMode || 'tts';
    const radio = document.querySelector(`input[name="audio-mode"][value="${audioMode}"]`);
    if (radio) radio.checked = true;
}

// Save TTS config (多后端)
document.getElementById('btn-save-tts').addEventListener('click', async () => {
    const provider = document.getElementById('tts-provider')?.value || 'mimo';
    const ttsConfig = {
        serviceType: provider,
        audioMode: document.querySelector('input[name="audio-mode"]:checked')?.value || 'tts',
        mimo: {
            baseURL: document.getElementById('mimo-base-url').value.trim(),
            apiKey: document.getElementById('mimo-api-key').value.trim(),
            stylePrompt: document.getElementById('mimo-style-prompt').value.trim(),
            format: document.getElementById('mimo-format').value,
        }
    };
    // 阿里云配置
    const aliId = document.getElementById('aliyun-access-key-id');
    if (aliId) {
        ttsConfig.aliyun = {
            accessKeyId: aliId.value.trim(),
            accessKeySecret: document.getElementById('aliyun-access-key-secret').value.trim(),
            appKey: document.getElementById('aliyun-app-key').value.trim(),
            voice: document.getElementById('aliyun-voice').value,
            region: document.getElementById('aliyun-region').value.trim() || 'cn-shanghai'
        };
    }
    // 本地 VITS2 配置
    const localBase = document.getElementById('local-base-url');
    if (localBase) {
        ttsConfig.local = {
            baseURL: localBase.value.trim() || 'http://localhost:7860',
            ttsEndpoint: document.getElementById('local-tts-endpoint').value.trim() || '/run/tts',
            method: document.getElementById('local-method').value || 'get',
            textParam: document.getElementById('local-text-param').value.trim() || 'text',
            speaker: document.getElementById('local-speaker').value.trim() || '0',
            language: document.getElementById('local-language').value.trim() || 'zh',
            responseType: document.getElementById('local-response-type').value || 'json',
            audioPath: document.getElementById('local-audio-path').value.trim() || 'audio'
        };
    }
    await window.electronAPI.saveConfig({ tts: ttsConfig });
    if (window.electronAPI.ttsReinit) {
        await window.electronAPI.ttsReinit(ttsConfig);
    }
    showStatus('tts-save-status', t('status.saved'), 'success');
    await loadTTSStatus();
});

// Test TTS button
document.getElementById('btn-test-tts').addEventListener('click', async () => {
    const text = document.getElementById('tts-test-text').value.trim();
    if (!text) return;
    showStatus('tts-test-status', t('tts.synthesizing'), '');
    const result = await window.electronAPI.ttsSynthesize(text);
    if (result.success) {
        showStatus('tts-test-status', t('tts.synthSuccess'), 'success');
        const wavBytes = Uint8Array.from(atob(result.wav), c => c.charCodeAt(0));
        const blob = new Blob([wavBytes], { type: 'audio/wav' });
        const audio = new Audio(URL.createObjectURL(blob));
        audio.play();
    } else {
        showStatus('tts-test-status', t('tts.synthFailed') + result.error, 'error');
    }
});

// Restart TTS button
document.getElementById('btn-restart-tts')?.addEventListener('click', async () => {
    const el = document.getElementById('tts-status');
    el.textContent = t('tts.restarting');
    el.className = 'status';
    const result = await window.electronAPI.ttsRestart();
    if (result.success) {
        await loadTTSStatus();
    } else {
        el.textContent = t('tts.restartFailed') + (result.error || t('tts.unknownError'));
        el.className = 'status error';
    }
});

// ========== TTS 诊断 ==========
document.getElementById('btn-diagnose-tts')?.addEventListener('click', async () => {
    const el = document.getElementById('tts-diagnose-status');
    el.textContent = '正在诊断...';
    el.className = 'status info';
    try {
        const diag = await window.electronAPI.ttsDiagnose();
        if (!diag) throw new Error('IPC无响应');
        const lines = [
            'TTS服务: ' + (diag.serviceExists ? '存在' : '不存在'),
            '已初始化: ' + (diag.initialized ? '是' : '否'),
            '熔断: ' + (diag.degraded ? '已熔断' : '正常'),
            '失败率: ' + diag.failCount + '/' + diag.maxFails,
            'API Key: ' + (diag.config?.hasApiKey ? '已设置' : '未设置'),
            '模型: ' + (diag.config?.model || '无'),
            '可用: ' + (diag.isAvailable ? '是' : '否')
        ];
        el.innerHTML = 'TTS诊断:<br>' + lines.join('<br>');
        el.className = diag.isAvailable ? 'status success' : 'status error';
    } catch(e) {
        el.textContent = '诊断失败: ' + e.message;
        el.className = 'status error';
    }
});

// ========== Max Tokens Multiplier ==========

function loadTokenMultiplierUI(multiplier) {
    updateTokenButtons(multiplier);
    updateTokenInfo(multiplier);
}

function updateTokenButtons(multiplier) {
    document.querySelectorAll('.token-mult-btn').forEach(btn => {
        const val = parseFloat(btn.dataset.mult);
        btn.className = val === multiplier
            ? 'btn btn-primary btn-sm token-mult-btn'
            : 'btn btn-secondary btn-sm token-mult-btn';
    });
}

function updateTokenInfo(multiplier) {
    const el = document.getElementById('token-info');
    if (el) {
        const tokens = Math.round(2048 * multiplier);
        el.textContent = t('enhance.tokens.info').replace('{0}', tokens).replace('{1}', multiplier);
    }
}

document.querySelectorAll('.token-mult-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const mult = parseFloat(btn.dataset.mult);
        if (petSystem && petSystem.aiClient) {
            petSystem.aiClient.maxTokensMultiplier = mult;
            petSystem.aiClient.saveConfig({ maxTokensMultiplier: mult });
        }
        updateTokenButtons(mult);
        updateTokenInfo(mult);
    });
});

// ========== Enhance Master Toggle ==========

function loadEnhanceToggle(enhance) {
    document.getElementById('enhance-enabled').checked = enhance.enabled || false;
}

document.getElementById('enhance-enabled').addEventListener('change', async () => {
    const enabled = document.getElementById('enhance-enabled').checked;
    await window.electronAPI.saveConfig({ enhance: { enabled } });
});

// ========== 语音识别 - 使用云端 STT（Mimo API，通过主进程 IPC） ==========
let cloudSTTActive = false;
let mediaStream = null;
let audioContext = null;
let scriptProcessor = null;
let sourceNode = null;

// 辅助函数：Float32 PCM 转 16-bit Int PCM（小端）
function float32ToInt16(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        let s = Math.max(-1, Math.min(1, float32Array[i]));
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16Array;
}

// 启动云端语音识别（通过 Mimo API）
async function startCloudSTT() {
    if (cloudSTTActive) return;

    // 1. 请求麦克风权限（同时获取流）
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: {
            channelCount: 1,
            sampleRate: 16000,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
        } });
        mediaStream = stream;
    } catch (err) {
        console.error('[STT] Microphone permission error:', err);
        showStatus('voice-status', '麦克风权限被拒绝，请在系统设置中允许', 'error');
        return;
    }

    // 2. 确保主进程 STT 已初始化（会读取配置中的 stt.baseURL 等）
    if (window.electronAPI && window.electronAPI.sttInitialize) {
        const initOk = await window.electronAPI.sttInitialize();
        if (!initOk) {
            showStatus('voice-status', '云端 STT 初始化失败，请检查配置文件中的 stt 字段（baseURL/apiKey）', 'error');
            if (mediaStream) {
                mediaStream.getTracks().forEach(t => t.stop());
                mediaStream = null;
            }
            return;
        }
    } else {
        showStatus('voice-status', '当前 Electron 版本不支持 STT IPC', 'error');
        if (mediaStream) {
            mediaStream.getTracks().forEach(t => t.stop());
            mediaStream = null;
        }
        return;
    }

    // 3. 创建 AudioContext (采样率强制 16000)
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        await audioContext.resume();
    } catch (err) {
        console.error('[STT] AudioContext error:', err);
        showStatus('voice-status', '无法创建音频上下文', 'error');
        if (mediaStream) {
            mediaStream.getTracks().forEach(t => t.stop());
            mediaStream = null;
        }
        return;
    }

    sourceNode = audioContext.createMediaStreamSource(stream);
    scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
    scriptProcessor.onaudioprocess = (event) => {
        if (!cloudSTTActive) return;
        const inputData = event.inputBuffer.getChannelData(0);
        const int16Data = float32ToInt16(inputData);
        // 发送给主进程
        if (window.electronAPI && window.electronAPI.sttFeedAudio) {
            window.electronAPI.sttFeedAudio(int16Data.buffer);
        }
    };
    sourceNode.connect(scriptProcessor);
    scriptProcessor.connect(audioContext.destination);

    // 4. 通知主进程开始识别
    if (window.electronAPI.sttStart) {
        await window.electronAPI.sttStart();
    }
    cloudSTTActive = true;

    // 更新 UI
    const btn = document.getElementById('btn-voice-toggle');
    if (btn) {
        btn.textContent = '⏹️ 停止语音对话';
        btn.classList.add('recording-btn');
    }
    const statusEl = document.getElementById('voice-status');
    statusEl.textContent = '云端语音识别已开启，正在监听...';
    statusEl.className = 'status success';
    console.log('[STT] Cloud STT session started');
}

// 停止云端语音识别
async function stopCloudSTT() {
    if (!cloudSTTActive) return;
    cloudSTTActive = false;

    // 通知主进程停止识别
    if (window.electronAPI && window.electronAPI.sttStop) {
        await window.electronAPI.sttStop();
    }

    // 关闭音频处理链
    if (scriptProcessor) {
        scriptProcessor.disconnect();
        scriptProcessor.onaudioprocess = null;
        scriptProcessor = null;
    }
    if (sourceNode) {
        sourceNode.disconnect();
        sourceNode = null;
    }
    if (audioContext) {
        await audioContext.close();
        audioContext = null;
    }
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }

    // 更新 UI
    const btn = document.getElementById('btn-voice-toggle');
    if (btn) {
        btn.textContent = '🎤 开始语音对话';
        btn.classList.remove('recording-btn');
    }
    const statusEl = document.getElementById('voice-status');
    statusEl.textContent = '语音对话已关闭';
    statusEl.className = 'status';
    setTimeout(() => {
        if (statusEl.className === 'status') statusEl.className = 'status';
    }, 2000);
    console.log('[STT] Cloud STT session stopped');
}

// 监听主进程返回的识别结果和状态
if (window.electronAPI) {
    if (window.electronAPI.onSttResult) {
        window.electronAPI.onSttResult((text) => {
            if (text && text.trim()) {
                console.log('[STT] Result:', text);
                const statusEl = document.getElementById('voice-status');
                statusEl.textContent = `识别结果: ${text}`;
                statusEl.className = 'status success';
                // 将文本发送给宠物 AI
                if (petSystem && typeof petSystem.handleUserText === 'function') {
                    petSystem.handleUserText(text);
                }
            }
        });
    }
    if (window.electronAPI.onSttStatus) {
        window.electronAPI.onSttStatus((status) => {
            // 可选：显示 listening 等状态
            if (status === 'listening') {
                const statusEl = document.getElementById('voice-status');
                if (statusEl && statusEl.textContent.includes('监听')) {
                    // 保持原有文字
                }
            }
        });
    }
}

// 绑定语音开关按钮（确保只绑定一次）
const voiceToggleBtn = document.getElementById('btn-voice-toggle');
if (voiceToggleBtn) {
    const newBtn = voiceToggleBtn.cloneNode(true);
    voiceToggleBtn.parentNode.replaceChild(newBtn, voiceToggleBtn);
    newBtn.addEventListener('click', () => {
        if (cloudSTTActive) {
            stopCloudSTT();
        } else {
            startCloudSTT();
        }
    });
}

// 页面关闭时清理
window.addEventListener('beforeunload', () => {
    if (cloudSTTActive) {
        if (window.electronAPI && window.electronAPI.sttStop) {
            window.electronAPI.sttStop();
        }
        if (mediaStream) {
            mediaStream.getTracks().forEach(t => t.stop());
        }
        if (audioContext) {
            audioContext.close();
        }
    }
});

// ========== 兼容旧 STT 配置（保留空实现，避免报错） ==========
async function loadSTTConfig() {
    // 此函数仅用于兼容，无实际作用
    try {
        if (window.electronAPI?.loadConfig) {
            await window.electronAPI.loadConfig();
        }
    } catch (e) {}
}
const saveAsrBtn = document.getElementById('btn-save-asr');
if (saveAsrBtn) {
    saveAsrBtn.addEventListener('click', async () => {
        showStatus('asr-status', '云端 STT 配置已在 config.json 的 stt 字段中设置', 'success');
    });
}
loadSTTConfig();

// Final: load TTS status after all DOM is ready
loadTTSStatus();