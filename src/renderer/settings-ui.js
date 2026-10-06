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

// ========== 主题切换 ==========
function initTheme() {
    const saved = localStorage.getItem('live2dpet_theme');
    if (saved === 'dark') document.body.classList.add('dark');
    // 默认跟随系统
    if (saved === null && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        document.body.classList.add('dark');
    }
}
initTheme();

document.getElementById('theme-toggle')?.addEventListener('click', () => {
    document.body.classList.toggle('dark');
    localStorage.setItem('live2dpet_theme', document.body.classList.contains('dark') ? 'dark' : 'light');
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

// Canvas Y slider（实时同步到宠物窗口）
document.getElementById('canvas-y-slider').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    document.getElementById('canvas-y-val').textContent = val.toFixed(2);
    currentModelConfig.canvasYRatio = val;
    // 实时同步到宠物窗口
    if (window.electronAPI) {
        window.electronAPI.setCanvasY(val);
    }
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

    // The editor can render empty lists (e.g. before a model is scanned). Saving
    // that emptiness would silently wipe a good configuration, so an empty form
    // keeps whatever was already stored.
    const hadMotions = Array.isArray(currentModelConfig.motionEmotions) && currentModelConfig.motionEmotions.length > 0;
    if (motionEmotions.length === 0 && hadMotions) {
        console.warn('[SettingsUI] motion list is empty; keeping the saved motions instead of wiping them');
    } else {
        currentModelConfig.motionEmotions = motionEmotions;
        currentModelConfig.motionDurations = motionDurations;
    }

    const hadExpressions = Array.isArray(currentModelConfig.expressions) && currentModelConfig.expressions.length > 0;
    if (expressions.length === 0 && hadExpressions) {
        console.warn('[SettingsUI] expression list is empty; keeping the saved expressions instead of wiping them');
    } else {
        currentModelConfig.expressions = expressions;
        currentModelConfig.expressionDurations = expressionDurations;
        currentModelConfig.hasExpressions = expressions.length > 0;
    }
    currentModelConfig.defaultExpressionDuration = defaultDur;
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
    const providerNames = { mimo: 'Mimo', aliyun: 'Aliyun', local: 'Local VITS2' };
    const providerLabel = providerNames[status.serviceType] || status.serviceType || 'Mimo';
    if (status.initialized) {
        if (status.degraded) {
            const elapsed = Date.now() - status.degradedAt;
            const remaining = Math.max(0, Math.ceil((status.retryInterval - elapsed) / 1000));
            el.textContent = t('tts.circuitBreak').replace('{0}', remaining);
            el.className = 'status error';
            if (restartBtn) restartBtn.style.display = '';
        } else if (!status.configured) {
            el.textContent = t('tts.notConfigured');
            el.className = 'status error';
            if (restartBtn) restartBtn.style.display = '';
        } else {
            el.textContent = t('tts.ready') + ' (' + providerLabel + ')';
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
    const mimoModelEl = document.getElementById('mimo-model');
    if (mimoModelEl) mimoModelEl.value = mimo.model || 'mimo-v2.5-tts';
    
    // 阿里云配置
    const aliyun = ttsCfg.aliyun || {};
    const aliDiv = document.getElementById('aliyun-api-key');
    if (aliDiv) {
        aliDiv.value = aliyun.apiKey || '';
        document.getElementById('aliyun-voice-prompt').value = aliyun.voicePrompt || '一个活泼可爱的少女声音，语调轻快，甜美自然。';
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
            model: (document.getElementById('mimo-model')?.value || '').trim() || 'mimo-v2.5-tts',
        }
    };
    // 阿里云配置
    const aliDiv = document.getElementById('aliyun-api-key');
    if (aliDiv) {
        ttsConfig.aliyun = {
            apiKey: aliDiv.value.trim(),
            voicePrompt: document.getElementById('aliyun-voice-prompt').value.trim()
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
    const providerNames = { mimo: 'Mimo', aliyun: 'Aliyun', local: 'Local VITS2' };
    showStatus('tts-save-status', '[' + (providerNames[provider] || provider) + '] ' + t('status.saved'), 'success');
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
            'Service: ' + (diag.serviceExists ? 'OK' : 'N/A'),
            'Backend: ' + (diag.serviceType || 'N/A'),
            'Init: ' + (diag.initialized ? 'Yes' : 'No'),
            'Circuit: ' + (diag.degraded ? 'Broken' : 'Normal'),
            'Fails: ' + diag.failCount + '/' + diag.maxFails,
            'Configured: ' + (diag.configured ? 'Yes' : 'No (API key missing)'),
            'Available: ' + (diag.isAvailable ? 'Yes' : 'No')
        ];
        el.innerHTML = 'TTS Diagnosis:<br>' + lines.join('<br>');
        el.className = diag.isAvailable ? 'status success' : 'status error';
    } catch(e) {
        el.textContent = '诊断失败: ' + e.message;
        el.className = 'status error';
    }
});

// ========== DSH (DeepSeek Harness) 设置 ==========

async function loadDshSettings() {
    if (!window.electronAPI || !window.electronAPI.dshStatus) return;
    let cfg = {};
    try { cfg = (await window.electronAPI.loadConfig()).dsh || {}; } catch (e) {}
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const check = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
    check('dsh-enabled', cfg.enabled !== false);
    check('dsh-speak', cfg.speakResult !== false);
    set('dsh-profile', cfg.profile || 'headless');
    set('dsh-workspace', cfg.workspace || '');
    set('dsh-script', cfg.script || '');
    set('dsh-timeout', Math.round((cfg.timeoutMs || 600000) / 1000));

    // 环境检测
    const el = document.getElementById('dsh-status-line');
    if (!el) return;
    try {
        const st = await window.electronAPI.dshStatus();
        if (st.available) {
            el.textContent = '✅ ' + t('dsh.found') + ': ' + (st.script || '');
            el.className = 'status success';
        } else {
            el.textContent = '⚠️ ' + t('dsh.notFound');
            el.className = 'status error';
        }
    } catch (e) {
        el.textContent = t('dsh.probeFailed') + e.message;
        el.className = 'status error';
    }
}

async function saveDshSettings() {
    const status = document.getElementById('dsh-save-status');
    const timeoutSec = parseInt(document.getElementById('dsh-timeout').value, 10);
    const patch = {
        enabled: document.getElementById('dsh-enabled').checked,
        speakResult: document.getElementById('dsh-speak').checked,
        profile: document.getElementById('dsh-profile').value.trim() || 'headless',
        workspace: document.getElementById('dsh-workspace').value.trim(),
        script: document.getElementById('dsh-script').value.trim(),
        timeoutMs: (Number.isFinite(timeoutSec) && timeoutSec >= 30 ? timeoutSec : 600) * 1000
    };
    const res = await window.electronAPI.dshConfig(patch);
    if (res && res.success) {
        status.textContent = t('dsh.saved') + (res.available ? '' : ' · ' + t('dsh.notFound'));
        status.className = res.available ? 'status success' : 'status error';
    } else {
        status.textContent = (res && res.error) || t('dsh.saveFailed');
        status.className = 'status error';
    }
    await loadDshSettings();
}

document.getElementById('btn-save-dsh')?.addEventListener('click', saveDshSettings);

document.getElementById('btn-probe-dsh')?.addEventListener('click', async () => {
    const el = document.getElementById('dsh-save-status');
    el.textContent = t('dsh.probing');
    el.className = 'status info';
    try {
        const probe = await window.electronAPI.dshProbe();
        if (probe && probe.available) {
            el.textContent = '✅ ' + t('dsh.found') + ': ' + probe.script;
            el.className = 'status success';
        } else {
            el.textContent = '⚠️ ' + t('dsh.notFound') + ' — ' + t('dsh.installHint');
            el.className = 'status error';
        }
    } catch (e) {
        el.textContent = t('dsh.probeFailed') + e.message;
        el.className = 'status error';
    }
});

// ========== 游戏陪伴设置 ==========

async function loadCompanionSettings() {
    if (!window.electronAPI || !window.electronAPI.loadConfig) return;
    let cfg = {};
    try { cfg = (await window.electronAPI.loadConfig()).companion || {}; } catch (e) {}
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const check = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
    check('companion-enabled', cfg.enabled);
    check('companion-game-only', cfg.gameOnly !== false);
    check('companion-dsh', cfg.offerDshHelp !== false);
    check('companion-voice', cfg.voiceInput !== false);
    check('companion-screenshots', cfg.useScreenshots !== false);
    set('companion-interval', Math.round((cfg.commentIntervalMs || 120000) / 1000));
    set('companion-patterns', Array.isArray(cfg.gamePatterns) ? cfg.gamePatterns.join(', ') : '');
}

/**
 * Persist the whole companion block from the DOM.
 * Shared by the 保存陪伴设置 button and by the hands-free toggle in the
 * offline-voice card, so the two can never disagree about what was saved.
 */
async function saveCompanionSettings() {
    const secs = parseInt(document.getElementById('companion-interval').value, 10);
    const patterns = document.getElementById('companion-patterns').value
        .split(',').map(s => s.trim()).filter(Boolean);
    await window.electronAPI.saveConfig({
        companion: {
            enabled: document.getElementById('companion-enabled').checked,
            gameOnly: document.getElementById('companion-game-only').checked,
            offerDshHelp: document.getElementById('companion-dsh').checked,
            voiceInput: document.getElementById('companion-voice').checked,
            useScreenshots: document.getElementById('companion-screenshots').checked,
            commentIntervalMs: (Number.isFinite(secs) && secs >= 30 ? secs : 120) * 1000,
            gamePatterns: patterns
        }
    });
}

document.getElementById('btn-save-companion')?.addEventListener('click', async () => {
    const status = document.getElementById('companion-save-status');
    await saveCompanionSettings();
    status.textContent = t('companion.saved');
    status.className = 'status success';
    await loadCompanionSettings();
});

// ========== 哔哩哔哩直播间弹幕设置 ==========

async function loadBiliSettings() {
    if (!window.electronAPI || !window.electronAPI.biliStatus) return;
    let cfg = {};
    try { cfg = (await window.electronAPI.loadConfig()).bilibili || {}; } catch (e) {}
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const check = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
    check('bili-enabled', cfg.enabled === true);
    set('bili-room', cfg.roomId || '');
    set('bili-cookie', cfg.cookie || '');
    set('bili-mode', cfg.mode || 'question');
    set('bili-mentions', Array.isArray(cfg.mentions) ? cfg.mentions.join(', ') : '');
    set('bili-ignore', Array.isArray(cfg.ignoreList) ? cfg.ignoreList.join(', ') : '');
    set('bili-interval', Math.max(3, Math.round((cfg.replyIntervalMs || 15000) / 1000)));
    set('bili-cooldown', Math.max(0, Math.round((cfg.userCooldownMs || 60000) / 1000)));

    const el = document.getElementById('bili-status-line');
    if (!el) return;
    try {
        const st = await window.electronAPI.biliStatus();
        if (st.connected) {
            el.textContent = '🟢 ' + t('bili.connected')
                + (st.loggedIn ? ' · ' + t('bili.loggedIn') : '')
                + ' · ' + (st.realRoomId || st.roomId)
                + (st.received ? ` · ${st.received} ` + t('bili.received') : '');
            el.className = 'status success';
        } else if (st.waitingForLive) {
            el.textContent = '⏳ ' + t('bili.notLive') + (st.roomTitle ? ' · ' + st.roomTitle : '');
            el.className = 'status';
        } else if (st.lastError) {
            el.textContent = '⚠️ ' + t('bili.notConnected') + ' · ' + st.lastError;
            el.className = 'status error';
        } else {
            el.textContent = t('bili.notConnected');
            el.className = 'status';
        }
    } catch (e) {
        el.textContent = t('bili.statusFailed') + e.message;
        el.className = 'status error';
    }
}

function readBiliForm() {
    const secs = parseInt(document.getElementById('bili-interval').value, 10);
    const cd = parseInt(document.getElementById('bili-cooldown').value, 10);
    const list = (id) => document.getElementById(id).value
        .split(',').map(s => s.trim()).filter(Boolean);
    return {
        enabled: document.getElementById('bili-enabled').checked,
        roomId: document.getElementById('bili-room').value.trim(),
        cookie: (document.getElementById('bili-cookie')?.value || '').trim(),
        mode: document.getElementById('bili-mode').value || 'question',
        mentions: list('bili-mentions'),
        ignoreList: list('bili-ignore'),
        replyIntervalMs: (Number.isFinite(secs) && secs >= 3 ? secs : 15) * 1000,
        userCooldownMs: (Number.isFinite(cd) && cd >= 0 ? cd : 60) * 1000
    };
}

document.getElementById('btn-save-bili')?.addEventListener('click', async () => {
    const status = document.getElementById('bili-save-status');
    const patch = readBiliForm();
    const res = await window.electronAPI.biliConfig(patch);
    // The running pet keeps its own copy of these settings; refresh it so the
    // switch takes effect without restarting.
    if (petSystem && petSystem.reloadLiveCompanionConfig) {
        await petSystem.reloadLiveCompanionConfig();
    }
    if (res && res.success) {
        status.textContent = t('bili.saved');
        status.className = 'status success';
        // 打开开关且填了房间号 → 立刻连接
        if (patch.enabled && patch.roomId) {
            const conn = await window.electronAPI.biliStart(patch.roomId);
            if (conn && conn.success) {
                status.textContent = t('bili.saved') + ' · ' + t('bili.connected');
            } else if (conn) {
                status.textContent = t('bili.saved') + ' · ' + (conn.error || t('bili.connectFailed'));
                status.className = 'status error';
            }
        }
    } else {
        status.textContent = (res && res.error) || t('bili.saveFailed');
        status.className = 'status error';
    }
    await loadBiliSettings();
});

document.getElementById('btn-connect-bili')?.addEventListener('click', async () => {
    const status = document.getElementById('bili-save-status');
    const room = document.getElementById('bili-room').value.trim();
    if (!room) {
        status.textContent = t('bili.needRoom');
        status.className = 'status error';
        return;
    }
    status.textContent = t('bili.connecting');
    status.className = 'status';
    await window.electronAPI.biliConfig({ roomId: room, enabled: true });
    const res = await window.electronAPI.biliStart(room);
    if (res && res.success) {
        status.textContent = t('bili.connected') + (res.room?.title ? ' · ' + res.room.title : '');
        status.className = 'status success';
    } else {
        status.textContent = (res && res.error) || t('bili.connectFailed');
        status.className = 'status error';
    }
    await loadBiliSettings();
});

document.getElementById('btn-disconnect-bili')?.addEventListener('click', async () => {
    await window.electronAPI.biliStop();
    const status = document.getElementById('bili-save-status');
    status.textContent = t('bili.disconnected');
    status.className = 'status';
    await loadBiliSettings();
});

// ========== OBS 兼容模式 + 浏览器源 ==========

async function loadObsBrowserSource() {
    if (!window.electronAPI || !window.electronAPI.obsServerGet) return;
    const line = document.getElementById('obs-bs-status');
    const input = document.getElementById('obs-bs-url');
    const btn = document.getElementById('btn-obs-bs-toggle');
    try {
        const st = await window.electronAPI.obsServerGet();
        if (input) input.value = st.url || '';
        if (btn) btn.textContent = t(st.running ? 'obs.bsDisable' : 'obs.bsEnable');
        // Reflect the saved in-frame transform (percent for the user).
        const tr = st.transform || { scale: 1, x: 0, y: 0 };
        const s = document.getElementById('obs-fit-scale');
        if (s && document.activeElement !== s) s.value = Math.round(tr.scale * 100);
        const xi = document.getElementById('obs-fit-x');
        if (xi && document.activeElement !== xi) xi.value = tr.x;
        const yi = document.getElementById('obs-fit-y');
        if (yi && document.activeElement !== yi) yi.value = tr.y;
        if (!line) return;
        if (st.running) {
            line.textContent = '🟢 ' + t('obs.bsRunning') + ' · ' + st.url
                + (st.clients ? ` · ${st.clients} ` + t('obs.bsClients') : '');
            line.className = 'status success';
        } else {
            line.textContent = t('obs.bsStopped');
            line.className = 'status';
        }
    } catch (e) {
        if (line) { line.textContent = t('obs.statusFailed') + e.message; line.className = 'status error'; }
    }
}

async function applyObsFit(reset = false) {
    const msg = document.getElementById('obs-fit-msg');
    const scalePct = reset ? 100 : parseInt(document.getElementById('obs-fit-scale').value, 10);
    const x = reset ? 0 : parseInt(document.getElementById('obs-fit-x').value, 10);
    const y = reset ? 0 : parseInt(document.getElementById('obs-fit-y').value, 10);
    const res = await window.electronAPI.obsTransformSet({
        scale: (Number.isFinite(scalePct) ? Math.min(500, Math.max(10, scalePct)) : 100) / 100,
        x: Number.isFinite(x) ? x : 0,
        y: Number.isFinite(y) ? y : 0,
    });
    if (msg) {
        msg.textContent = res && res.success ? t('obs.fitApplied') : ((res && res.error) || t('obs.saveFailed'));
        msg.className = res && res.success ? 'status success' : 'status error';
    }
    await loadObsBrowserSource();
}

document.getElementById('btn-obs-fit-apply')?.addEventListener('click', () => applyObsFit(false));
document.getElementById('btn-obs-fit-reset')?.addEventListener('click', () => applyObsFit(true));

document.getElementById('btn-obs-bs-toggle')?.addEventListener('click', async () => {
    const msg = document.getElementById('obs-bs-msg');
    const btn = document.getElementById('btn-obs-bs-toggle');
    try {
        const cur = await window.electronAPI.obsServerGet();
        const res = cur.running
            ? await window.electronAPI.obsServerStop()
            : await window.electronAPI.obsServerStart({ port: cur.preferredPort || 0 });
        if (msg) {
            msg.textContent = res && res.success
                ? (res.running ? t('obs.bsStarted') + ' ' + res.url : t('obs.bsStoppedMsg'))
                : ((res && res.error) || t('obs.saveFailed'));
            msg.className = res && res.success ? 'status success' : 'status error';
        }
    } catch (e) {
        if (msg) { msg.textContent = e.message; msg.className = 'status error'; }
    }
    await loadObsBrowserSource();
});

document.getElementById('btn-obs-bs-copy')?.addEventListener('click', async () => {
    const msg = document.getElementById('obs-bs-msg');
    const url = document.getElementById('obs-bs-url')?.value || '';
    if (!url) return;
    try {
        await navigator.clipboard.writeText(url);
        if (msg) { msg.textContent = t('obs.bsCopied'); msg.className = 'status success'; }
    } catch {
        const input = document.getElementById('obs-bs-url');
        input?.select();
        if (msg) { msg.textContent = t('obs.bsCopyManual'); msg.className = 'status'; }
    }
});

async function loadObsMode() {
    if (!window.electronAPI || !window.electronAPI.obsModeGet) return;
    const line = document.getElementById('obs-mode-status');
    try {
        const st = await window.electronAPI.obsModeGet();
        const box = document.getElementById('obs-compatible');
        if (box) box.checked = !!st.compatible;
        if (!line) return;
        if (st.active) {
            line.textContent = '🟢 ' + t('obs.on') + ' · ' + (st.switches || []).join(', ');
            line.className = 'status success';
        } else if (st.compatible) {
            line.textContent = '⚠️ ' + t('obs.needsRestart');
            line.className = 'status error';
        } else {
            line.textContent = t('obs.off');
            line.className = 'status';
        }
    } catch (e) {
        if (line) { line.textContent = t('obs.statusFailed') + e.message; line.className = 'status error'; }
    }
}

document.getElementById('btn-obs-save')?.addEventListener('click', async () => {
    const status = document.getElementById('obs-save-status');
    const compatible = !!document.getElementById('obs-compatible')?.checked;
    const res = await window.electronAPI.obsModeSet({ compatible });
    if (res && res.success) {
        status.textContent = res.restartRequired ? t('obs.savedRestart') : t('obs.saved');
        status.className = 'status success';
    } else {
        status.textContent = (res && res.error) || t('obs.saveFailed');
        status.className = 'status error';
    }
    await loadObsMode();
});

document.getElementById('btn-obs-restart')?.addEventListener('click', async () => {
    const status = document.getElementById('obs-save-status');
    status.textContent = t('obs.restarting');
    status.className = 'status';
    await window.electronAPI.appRestart();
});

// ========== 离线语音识别（原生 libvosk） ==========

function renderAsrStatus(st) {
    const line = document.getElementById('asr-status-line');
    const installBtn = document.getElementById('btn-asr-install');
    if (!line) return;
    const ready = st.nativeInstalled && st.modelInstalled;
    if (!st.platformSupported) {
        line.textContent = t('asr.unsupported');
        line.className = 'status error';
    } else if (ready) {
        line.textContent = '🟢 ' + t('asr.ready')
            + (st.engineLoaded ? ' · ' + t('asr.engineLoaded') : '')
            + (st.listening ? ' · ' + t('asr.listening') : '');
        line.className = 'status success';
    } else {
        const parts = [];
        if (!st.nativeInstalled) parts.push(t('asr.needNative'));
        if (!st.modelInstalled) parts.push(t('asr.needModel'));
        line.textContent = '⚠️ ' + parts.join(' · ');
        line.className = 'status error';
    }
    if (installBtn) {
        installBtn.disabled = ready;
        installBtn.textContent = ready ? t('asr.installed') : t('asr.install');
    }
}

async function loadAsrStatus() {
    if (!window.electronAPI || !window.electronAPI.asrStatus) return;
    try {
        renderAsrStatus(await window.electronAPI.asrStatus());
    } catch (e) {
        const line = document.getElementById('asr-status-line');
        if (line) { line.textContent = t('asr.statusFailed') + e.message; line.className = 'status error'; }
    }
}

// The hands-free toggle lives in this card (that is where people look for it),
// but it belongs to the companion config — so save on change rather than making
// the user hunt for a save button in another card.
document.getElementById('companion-voice')?.addEventListener('change', async () => {
    const msg = document.getElementById('asr-msg');
    const on = document.getElementById('companion-voice').checked;
    try {
        await saveCompanionSettings();
        if (msg) {
            msg.textContent = on ? t('asr.handsFreeOn') : t('asr.handsFreeOff');
            msg.className = 'status success';
        }
    } catch (e) {
        if (msg) { msg.textContent = t('asr.saveFailed') + e.message; msg.className = 'status error'; }
    }
});

document.getElementById('btn-asr-install')?.addEventListener('click', async () => {
    const msg = document.getElementById('asr-msg');
    const prog = document.getElementById('asr-progress');
    const btn = document.getElementById('btn-asr-install');
    if (btn) btn.disabled = true;
    if (msg) { msg.textContent = t('asr.downloading'); msg.className = 'status'; }
    if (prog) { prog.style.display = 'block'; prog.textContent = ''; }
    try {
        const res = await window.electronAPI.asrInstall();
        if (msg) {
            msg.textContent = res && res.success ? t('asr.installed') : ((res && res.error) || t('asr.installFailed'));
            msg.className = res && res.success ? 'status success' : 'status error';
        }
    } catch (e) {
        if (msg) { msg.textContent = e.message; msg.className = 'status error'; }
    }
    if (prog) prog.style.display = 'none';
    await loadAsrStatus();
});

// One test at a time. A stale 15 s timer from an earlier click must never be
// able to stop the capture a later click started.
let asrTestCapture = null;
let asrTestToken = 0;

document.getElementById('btn-asr-test')?.addEventListener('click', async () => {
    const msg = document.getElementById('asr-msg');
    const say = (text, cls) => { if (msg) { msg.textContent = text; msg.className = cls || 'status'; } };
    if (!window.electronAPI?.asrStatus) return;

    const st = await window.electronAPI.asrStatus().catch(() => null);
    if (!st || !st.nativeInstalled || !st.modelInstalled) { say(t('asr.needInstall'), 'status error'); return; }
    if (!window.OfflineAsr?.OfflineAsrCapture) { say(t('asr.captureUnavailable'), 'status error'); return; }

    // Drop anything still running from a previous click.
    const token = ++asrTestToken;
    if (asrTestCapture) { const old = asrTestCapture; asrTestCapture = null; old.stop().catch(() => {}); }

    say(t('asr.testing'));
    let done = false;
    const finish = async (text, cls) => {
        if (done || token !== asrTestToken) return;
        done = true;
        const cap = asrTestCapture;
        asrTestCapture = null;
        try { if (cap) await cap.stop(); else await window.electronAPI.asrStop(); } catch { /* ignore */ }
        say(text, cls);
    };

    // Exercising the REAL capture path matters: this is the same
    // microphone -> 16 kHz PCM -> engine chain the pet uses while playing,
    // so a pass here means hands-free input will work too.
    const cap = new window.OfflineAsr.OfflineAsrCapture({
        onText: (text) => { if (text) finish(t('asr.heard') + ' ' + text, 'status success'); },
        onError: (reason) => finish(t('asr.error') + ' ' + reason, 'status error'),
    });
    asrTestCapture = cap;

    const res = await cap.start();
    if (!res.ok) { await finish(t('asr.error') + ' ' + res.reason, 'status error'); return; }
    setTimeout(() => finish(t('asr.heardNothing'), 'status error'), 15000);
});

// Progress pushes from the main process while downloading.
if (window.electronAPI?.onAsrInstallProgress) {
    window.electronAPI.onAsrInstallProgress((info) => {
        const prog = document.getElementById('asr-progress');
        if (!prog) return;
        const label = info.stage === 'native' ? t('asr.stageNative') : t('asr.stageModel');
        prog.style.display = 'block';
        prog.textContent = `${label} ${Math.round((info.fraction || 0) * 100)}%`;
    });
}

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

// ========== 酒馆预设管理 ==========
const BUILTIN_PRESETS = ['fantasy-tavern', 'cyber-bar', 'xianxia-tavern'];

function loadPresetList() {
    const sel = document.getElementById('preset-selector');
    if (!sel) return;
    sel.innerHTML = '<option value="">-- 选择预设 --</option>';
    
    // 内置预设
    for (const name of BUILTIN_PRESETS) {
        const opt = document.createElement('option');
        opt.value = '__builtin__' + name;
        opt.textContent = '📦 ' + name;
        sel.appendChild(opt);
    }
    // 用户预设
    try {
        const userPresets = JSON.parse(localStorage.getItem('live2dpet_presets') || '[]');
        for (const p of userPresets) {
            if (p && p.name) {
                const opt = document.createElement('option');
                opt.value = '__user__' + p.name;
                opt.textContent = '⭐ ' + p.name;
                sel.appendChild(opt);
            }
        }
    } catch(e) {}
}

// 获取预设数据
async function getPresetData(value) {
    if (value.startsWith('__builtin__')) {
        const name = value.replace('__builtin__', '');
        try {
            const res = await fetch('presets/' + name + '.json');
            if (res.ok) return await res.json();
        } catch(e) {}
        return null;
    }
    if (value.startsWith('__user__')) {
        const name = value.replace('__user__', '');
        const userPresets = JSON.parse(localStorage.getItem('live2dpet_presets') || '[]');
        return userPresets.find(p => p.name === name) || null;
    }
    return null;
}

// 选择预设
document.getElementById('preset-selector')?.addEventListener('change', async (e) => {
    if (!e.target.value) return;
    const preset = await getPresetData(e.target.value);
    if (!preset) return;
    fillPresetEditor(preset);
    document.getElementById('preset-editor').style.display = 'block';
});

function fillPresetEditor(preset) {
    document.getElementById('pe-name').value = preset.name || '';
    document.getElementById('pe-desc').value = preset.description || '';
    document.getElementById('pe-user-role').value = preset.userRole || '冒险者';
    document.getElementById('pe-ai-role').value = preset.aiRole || '酒馆老板';
    document.getElementById('pe-greeting').value = preset.greeting || '';
    document.getElementById('pe-system-prompt').value = preset.systemPrompt || '';
    document.getElementById('pe-world').value = preset.worldBuilding || '';
    document.getElementById('pe-diary-prompt').value = preset.diaryPrompt || '';
}

function readPresetFromForm() {
    return {
        name: document.getElementById('pe-name').value || '未命名',
        description: document.getElementById('pe-desc').value || '',
        version: 1,
        author: '用户自定义',
        systemPrompt: document.getElementById('pe-system-prompt').value || '',
        userRole: document.getElementById('pe-user-role').value || '冒险者',
        aiRole: document.getElementById('pe-ai-role').value || '酒馆老板',
        greeting: document.getElementById('pe-greeting').value || '',
        diaryPrompt: document.getElementById('pe-diary-prompt').value || '',
        worldBuilding: document.getElementById('pe-world').value || ''
    };
}

// 新建预设
document.getElementById('btn-preset-new')?.addEventListener('click', () => {
    fillPresetEditor({ name: '', description: '', userRole: '冒险者', aiRole: '酒馆老板', greeting: '', systemPrompt: '', worldBuilding: '', diaryPrompt: '' });
    document.getElementById('preset-editor').style.display = 'block';
});

// 保存预设
document.getElementById('btn-preset-save')?.addEventListener('click', () => {
    const preset = readPresetFromForm();
    if (!preset.name) { showStatus('preset-status', '请输入预设名称', 'error'); return; }
    try {
        const userPresets = JSON.parse(localStorage.getItem('live2dpet_presets') || '[]');
        const idx = userPresets.findIndex(p => p.name === preset.name);
        if (idx >= 0) userPresets[idx] = preset;
        else userPresets.push(preset);
        localStorage.setItem('live2dpet_presets', JSON.stringify(userPresets));
        showStatus('preset-status', t('tavern.savedMsg'), 'success');
        loadPresetList();

// ========== 音频设备管理 ==========
async function enumerateAudioDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputSel = document.getElementById('audio-input-device');
        const outputSel = document.getElementById('audio-output-device');
        if (!inputSel || !outputSel) return;
        
        inputSel.innerHTML = '<option value="default">默认设备</option>';
        outputSel.innerHTML = '<option value="default">默认设备</option>';
        
        for (const d of devices) {
            if (d.kind === 'audioinput' && d.deviceId) {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || '麦克风 (' + d.deviceId.slice(0,8) + '...)';
                inputSel.appendChild(opt);
            }
            if (d.kind === 'audiooutput' && d.deviceId) {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || '扬声器 (' + d.deviceId.slice(0,8) + '...)';
                outputSel.appendChild(opt);
            }
        }
    } catch(e) { console.warn('[Audio] 枚举设备失败:', e.message); }
}

// 加载保存的音频设置
try {
    const saved = JSON.parse(localStorage.getItem('live2dpet_audio') || '{}');
    if (saved.inputDevice) document.getElementById('audio-input-device').value = saved.inputDevice;
    if (saved.outputDevice) document.getElementById('audio-output-device').value = saved.outputDevice;
    if (saved.volume !== undefined) {
        document.getElementById('audio-volume').value = saved.volume;
        document.getElementById('audio-volume-label').textContent = saved.volume + '%';
    }
} catch(e) {}

// 音量滑块联动
document.getElementById('audio-volume')?.addEventListener('input', (e) => {
    document.getElementById('audio-volume-label').textContent = e.target.value + '%';
});

// 保存音频设置
document.getElementById('btn-save-audio')?.addEventListener('click', () => {
    const settings = {
        inputDevice: document.getElementById('audio-input-device').value,
        outputDevice: document.getElementById('audio-output-device').value,
        volume: parseInt(document.getElementById('audio-volume').value)
    };
    localStorage.setItem('live2dpet_audio', JSON.stringify(settings));
    showStatus('audio-status', '音频设置已保存', 'success');
});

// 页面加载时枚举设备
if (navigator.mediaDevices?.enumerateDevices) {
    enumerateAudioDevices();
    navigator.mediaDevices.addEventListener('devicechange', enumerateAudioDevices);
}
    } catch(e) { showStatus('preset-status', '保存失败: ' + e.message, 'error'); }
});

// 取消编辑
document.getElementById('btn-preset-cancel')?.addEventListener('click', () => {
    document.getElementById('preset-editor').style.display = 'none';
});

// 导出预设
document.getElementById('btn-preset-export')?.addEventListener('click', async () => {
    const sel = document.getElementById('preset-selector');
    if (!sel.value) return;
    const preset = await getPresetData(sel.value);
    if (!preset) return;
    const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (preset.name || 'tavern-preset') + '.json';
    a.click();
    URL.revokeObjectURL(url);
});

// 导入预设
document.getElementById('btn-preset-import')?.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const preset = JSON.parse(text);
            if (!preset.name || !preset.systemPrompt) {
                showStatus('preset-status', '无效的预设文件！', 'error');
                return;
            }
            const userPresets = JSON.parse(localStorage.getItem('live2dpet_presets') || '[]');
            userPresets.push(preset);
            localStorage.setItem('live2dpet_presets', JSON.stringify(userPresets));
            loadPresetList();

// ========== 音频设备管理 ==========
async function enumerateAudioDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputSel = document.getElementById('audio-input-device');
        const outputSel = document.getElementById('audio-output-device');
        if (!inputSel || !outputSel) return;
        
        inputSel.innerHTML = '<option value="default">默认设备</option>';
        outputSel.innerHTML = '<option value="default">默认设备</option>';
        
        for (const d of devices) {
            if (d.kind === 'audioinput' && d.deviceId) {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || '麦克风 (' + d.deviceId.slice(0,8) + '...)';
                inputSel.appendChild(opt);
            }
            if (d.kind === 'audiooutput' && d.deviceId) {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || '扬声器 (' + d.deviceId.slice(0,8) + '...)';
                outputSel.appendChild(opt);
            }
        }
    } catch(e) { console.warn('[Audio] 枚举设备失败:', e.message); }
}

// 加载保存的音频设置
try {
    const saved = JSON.parse(localStorage.getItem('live2dpet_audio') || '{}');
    if (saved.inputDevice) document.getElementById('audio-input-device').value = saved.inputDevice;
    if (saved.outputDevice) document.getElementById('audio-output-device').value = saved.outputDevice;
    if (saved.volume !== undefined) {
        document.getElementById('audio-volume').value = saved.volume;
        document.getElementById('audio-volume-label').textContent = saved.volume + '%';
    }
} catch(e) {}

// 音量滑块联动
document.getElementById('audio-volume')?.addEventListener('input', (e) => {
    document.getElementById('audio-volume-label').textContent = e.target.value + '%';
});

// 保存音频设置
document.getElementById('btn-save-audio')?.addEventListener('click', () => {
    const settings = {
        inputDevice: document.getElementById('audio-input-device').value,
        outputDevice: document.getElementById('audio-output-device').value,
        volume: parseInt(document.getElementById('audio-volume').value)
    };
    localStorage.setItem('live2dpet_audio', JSON.stringify(settings));
    showStatus('audio-status', '音频设置已保存', 'success');
});

// 页面加载时枚举设备
if (navigator.mediaDevices?.enumerateDevices) {
    enumerateAudioDevices();
    navigator.mediaDevices.addEventListener('devicechange', enumerateAudioDevices);
}
            fillPresetEditor(preset);
            document.getElementById('preset-editor').style.display = 'block';
            showStatus('preset-status', '预设 "' + preset.name + '" 已导入！', 'success');
        } catch(err) {
            showStatus('preset-status', '导入失败: ' + err.message, 'error');
        }
    };
    input.click();
});

// 删除预设
document.getElementById('btn-preset-delete')?.addEventListener('click', () => {
    const sel = document.getElementById('preset-selector');
    if (!sel.value || !sel.value.startsWith('__user__')) return;
    const name = sel.value.replace('__user__', '');
    try {
        let userPresets = JSON.parse(localStorage.getItem('live2dpet_presets') || '[]');
        userPresets = userPresets.filter(p => p.name !== name);
        localStorage.setItem('live2dpet_presets', JSON.stringify(userPresets));
        loadPresetList();

// ========== 音频设备管理 ==========
async function enumerateAudioDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputSel = document.getElementById('audio-input-device');
        const outputSel = document.getElementById('audio-output-device');
        if (!inputSel || !outputSel) return;
        
        inputSel.innerHTML = '<option value="default">默认设备</option>';
        outputSel.innerHTML = '<option value="default">默认设备</option>';
        
        for (const d of devices) {
            if (d.kind === 'audioinput' && d.deviceId) {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || '麦克风 (' + d.deviceId.slice(0,8) + '...)';
                inputSel.appendChild(opt);
            }
            if (d.kind === 'audiooutput' && d.deviceId) {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || '扬声器 (' + d.deviceId.slice(0,8) + '...)';
                outputSel.appendChild(opt);
            }
        }
    } catch(e) { console.warn('[Audio] 枚举设备失败:', e.message); }
}

// 加载保存的音频设置
try {
    const saved = JSON.parse(localStorage.getItem('live2dpet_audio') || '{}');
    if (saved.inputDevice) document.getElementById('audio-input-device').value = saved.inputDevice;
    if (saved.outputDevice) document.getElementById('audio-output-device').value = saved.outputDevice;
    if (saved.volume !== undefined) {
        document.getElementById('audio-volume').value = saved.volume;
        document.getElementById('audio-volume-label').textContent = saved.volume + '%';
    }
} catch(e) {}

// 音量滑块联动
document.getElementById('audio-volume')?.addEventListener('input', (e) => {
    document.getElementById('audio-volume-label').textContent = e.target.value + '%';
});

// 保存音频设置
document.getElementById('btn-save-audio')?.addEventListener('click', () => {
    const settings = {
        inputDevice: document.getElementById('audio-input-device').value,
        outputDevice: document.getElementById('audio-output-device').value,
        volume: parseInt(document.getElementById('audio-volume').value)
    };
    localStorage.setItem('live2dpet_audio', JSON.stringify(settings));
    showStatus('audio-status', '音频设置已保存', 'success');
});

// 页面加载时枚举设备
if (navigator.mediaDevices?.enumerateDevices) {
    enumerateAudioDevices();
    navigator.mediaDevices.addEventListener('devicechange', enumerateAudioDevices);
}
        document.getElementById('preset-editor').style.display = 'none';
        showStatus('preset-status', '已删除', 'success');
    } catch(e) { showStatus('preset-status', '删除失败', 'error'); }
});

// 应用预设
document.getElementById('btn-preset-apply')?.addEventListener('click', async () => {
    const sel = document.getElementById('preset-selector');
    if (!sel.value) return;
    const preset = await getPresetData(sel.value);
    if (!preset) return;
    // 保存到 localStorage 作为当前使用的预设
    localStorage.setItem('live2dpet_current_preset', JSON.stringify(preset));
    showStatus('preset-status', t('tavern.appliedMsg'), 'success');
});

// 页面加载时初始化预设列表
loadPresetList();

// 加载酒馆专用模型配置
try {
    const saved = localStorage.getItem('live2dpet_tavern_model');
    if (saved) {
        const cfg = JSON.parse(saved);
        document.getElementById('tavern-model-url').value = cfg.baseURL || '';
        document.getElementById('tavern-model-key').value = cfg.apiKey || '';
        document.getElementById('tavern-model-name').value = cfg.modelName || '';
    }
} catch(e) {}

// 保存酒馆专用模型配置
document.getElementById('btn-save-tavern-model')?.addEventListener('click', () => {
    const cfg = {
        baseURL: document.getElementById('tavern-model-url').value.trim(),
        apiKey: document.getElementById('tavern-model-key').value.trim(),
        modelName: document.getElementById('tavern-model-name').value.trim()
    };
    localStorage.setItem('live2dpet_tavern_model', JSON.stringify(cfg));
    showStatus('tavern-model-status', 'Tavern AI model config saved!', 'success');
});

// ========== 音频设备管理 ==========
async function enumerateAudioDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputSel = document.getElementById('audio-input-device');
        const outputSel = document.getElementById('audio-output-device');
        if (!inputSel || !outputSel) return;
        
        inputSel.innerHTML = '<option value="default">默认设备</option>';
        outputSel.innerHTML = '<option value="default">默认设备</option>';
        
        for (const d of devices) {
            if (d.kind === 'audioinput' && d.deviceId) {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || '麦克风 (' + d.deviceId.slice(0,8) + '...)';
                inputSel.appendChild(opt);
            }
            if (d.kind === 'audiooutput' && d.deviceId) {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || '扬声器 (' + d.deviceId.slice(0,8) + '...)';
                outputSel.appendChild(opt);
            }
        }
    } catch(e) { console.warn('[Audio] 枚举设备失败:', e.message); }
}

// 加载保存的音频设置
try {
    const saved = JSON.parse(localStorage.getItem('live2dpet_audio') || '{}');
    if (saved.inputDevice) document.getElementById('audio-input-device').value = saved.inputDevice;
    if (saved.outputDevice) document.getElementById('audio-output-device').value = saved.outputDevice;
    if (saved.volume !== undefined) {
        document.getElementById('audio-volume').value = saved.volume;
        document.getElementById('audio-volume-label').textContent = saved.volume + '%';
    }
} catch(e) {}

// 音量滑块联动
document.getElementById('audio-volume')?.addEventListener('input', (e) => {
    document.getElementById('audio-volume-label').textContent = e.target.value + '%';
});

// 保存音频设置
document.getElementById('btn-save-audio')?.addEventListener('click', () => {
    const settings = {
        inputDevice: document.getElementById('audio-input-device').value,
        outputDevice: document.getElementById('audio-output-device').value,
        volume: parseInt(document.getElementById('audio-volume').value)
    };
    localStorage.setItem('live2dpet_audio', JSON.stringify(settings));
    showStatus('audio-status', '音频设置已保存', 'success');
});

// 页面加载时枚举设备
if (navigator.mediaDevices?.enumerateDevices) {
    enumerateAudioDevices();
    navigator.mediaDevices.addEventListener('devicechange', enumerateAudioDevices);
}

// ========== 集成面板：打开设置窗口时主动刷新各卡片状态 ==========
// 这些面板原本只在「保存」时刷新，初始化时没人拉一次，卡片就一直显示空状态。
// 对离线语音识别尤其要紧：状态决定「一键下载」按钮是否可用。
// 各 loadX 都是幂等的读操作，重复调用无副作用。
if (window.electronAPI) {
    loadDshSettings();
    loadCompanionSettings();
    loadBiliSettings();
    loadObsMode();
    loadObsBrowserSource();
    loadAsrStatus();
}