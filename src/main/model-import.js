/**
 * ModelImport — Model scanning, parameter mapping, file selection.
 * Extracted from main.js lines 1334-1665.
 */
const { isValidUUID } = require('./validators');

const PARAM_FUZZY_MAP = {
    angleX:     ['ParamAngleX', 'ParamX', 'Angle_X', 'PARAM_ANGLE_X', 'AngleX'],
    angleY:     ['ParamAngleY', 'ParamY', 'Angle_Y', 'PARAM_ANGLE_Y', 'AngleY'],
    angleZ:     ['ParamAngleZ', 'ParamZ', 'Angle_Z', 'PARAM_ANGLE_Z', 'AngleZ'],
    bodyAngleX: ['ParamBodyAngleX', 'BodyAngleX', 'PARAM_BODY_ANGLE_X', 'ParamBodyX'],
    eyeBallX:   ['ParamEyeBallX', 'EyeBallX', 'PARAM_EYE_BALL_X', 'ParamEyeX'],
    eyeBallY:   ['ParamEyeBallY', 'EyeBallY', 'PARAM_EYE_BALL_Y', 'ParamEyeY']
};

function suggestParamMapping(parameterIds) {
    const suggested = {};
    for (const [key, candidates] of Object.entries(PARAM_FUZZY_MAP)) {
        const match = candidates.find(c =>
            parameterIds.some(p => p.toLowerCase() === c.toLowerCase())
        );
        if (match) {
            suggested[key] = parameterIds.find(p => p.toLowerCase() === match.toLowerCase());
        } else {
            suggested[key] = null;
        }
    }
    return suggested;
}

function registerModelImport(ctx, ipcMain, deps) {
    // deps: { app, fs, path, dialog, mt, configManager }
    const { app, fs, path, dialog, mt, configManager } = deps;

    ipcMain.handle('select-model-folder', async () => {
        try {
            const result = await dialog.showOpenDialog(ctx.settingsWindow || deps.BrowserWindow.getFocusedWindow(), {
                properties: ['openDirectory'],
                title: mt('main.selectL2d')
            });
            if (result.canceled || !result.filePaths.length) {
                return { success: false, error: 'cancelled' };
            }
            const folderPath = result.filePaths[0];
            let files = fs.readdirSync(folderPath);
            let modelFiles = files.filter(f => f.endsWith('.model3.json'));
            let actualFolder = folderPath;
            if (modelFiles.length === 0) {
                for (const sub of files) {
                    const subPath = path.join(folderPath, sub);
                    try {
                        if (fs.statSync(subPath).isDirectory()) {
                            const subFiles = fs.readdirSync(subPath);
                            const subModels = subFiles.filter(f => f.endsWith('.model3.json'));
                            if (subModels.length > 0) {
                                modelFiles = subModels;
                                actualFolder = subPath;
                                break;
                            }
                        }
                    } catch {}
                }
            }
            if (modelFiles.length === 0) {
                return { success: false, error: mt('main.noModel3Json') };
            }
            return { success: true, folderPath: actualFolder, modelFiles };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('scan-model-info', async (event, folderPath, modelJsonFile) => {
        try {
            const modelJsonPath = path.join(folderPath, modelJsonFile);
            if (!fs.existsSync(modelJsonPath)) {
                return { success: false, error: mt('main.model3NotExist') };
            }
            const modelJson = JSON.parse(fs.readFileSync(modelJsonPath, 'utf-8'));

            let parameterIds = [];
            if (modelJson.Groups) {
                modelJson.Groups.forEach(g => { if (g.Ids) parameterIds.push(...g.Ids); });
            }
            if (modelJson.FileReferences) {
                const cdiFile = modelJson.FileReferences.DisplayInfo;
                if (cdiFile) {
                    const cdiPath = path.join(folderPath, cdiFile);
                    try {
                        if (fs.existsSync(cdiPath)) {
                            const cdiJson = JSON.parse(fs.readFileSync(cdiPath, 'utf-8'));
                            if (cdiJson.Parameters && Array.isArray(cdiJson.Parameters)) {
                                parameterIds.push(...cdiJson.Parameters.map(p => p.Id));
                            }
                        }
                    } catch {}
                }
            }
            parameterIds = [...new Set(parameterIds)];

            const hitAreas = modelJson.HitAreas || [];

            let expressions = [];
            if (modelJson.FileReferences && modelJson.FileReferences.Expressions) {
                expressions = modelJson.FileReferences.Expressions.map(e => ({ name: e.Name, file: e.File }));
            }
            if (expressions.length === 0) {
                try {
                    const folderFiles = fs.readdirSync(folderPath);
                    expressions = folderFiles.filter(f => f.endsWith('.exp3.json')).map(f => ({
                        name: f.replace('.exp3.json', ''), file: f
                    }));
                } catch {}
            }

            let motions = {};
            if (modelJson.FileReferences && modelJson.FileReferences.Motions) {
                const raw = modelJson.FileReferences.Motions;
                for (const [group, entries] of Object.entries(raw)) {
                    motions[group] = (entries || []).map(e => ({ file: e.File }));
                }
            }
            if (Object.keys(motions).length === 0) {
                try {
                    const folderFiles = fs.readdirSync(folderPath);
                    const motionFiles = folderFiles.filter(f => f.endsWith('.motion3.json'));
                    if (motionFiles.length > 0) motions['Default'] = motionFiles.map(f => ({ file: f }));
                } catch {}
            }

            let mocValid = false;
            if (modelJson.FileReferences && modelJson.FileReferences.Moc) {
                mocValid = fs.existsSync(path.join(folderPath, modelJson.FileReferences.Moc));
            }

            let texturesValid = false;
            if (modelJson.FileReferences && modelJson.FileReferences.Textures) {
                texturesValid = modelJson.FileReferences.Textures.every(t =>
                    fs.existsSync(path.join(folderPath, t))
                );
            }

            return {
                success: true,
                modelName: modelJsonFile.replace('.model3.json', ''),
                parameterIds, suggestedMapping: suggestParamMapping(parameterIds),
                expressions, motions, hitAreas,
                validation: { mocValid, texturesValid }
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('select-static-image', async () => {
        try {
            const result = await dialog.showOpenDialog(ctx.settingsWindow || deps.BrowserWindow.getFocusedWindow(), {
                properties: ['openFile'],
                title: mt('main.selectImage'),
                filters: [{ name: mt('main.filterImage'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }]
            });
            if (result.canceled || !result.filePaths.length) return { success: false, error: 'cancelled' };
            return { success: true, filePath: result.filePaths[0] };
        } catch (error) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('select-image-folder', async () => {
        try {
            const result = await dialog.showOpenDialog(ctx.settingsWindow || deps.BrowserWindow.getFocusedWindow(), {
                properties: ['openDirectory'],
                title: mt('main.selectImageFolder')
            });
            if (result.canceled || !result.filePaths.length) return { success: false, error: 'cancelled' };
            return { success: true, folderPath: result.filePaths[0] };
        } catch (error) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('scan-image-folder', async (event, folderPath) => {
        try {
            const files = fs.readdirSync(folderPath);
            const imageExts = ['.png', '.jpg', '.jpeg', '.webp'];
            const images = files
                .filter(f => imageExts.includes(path.extname(f).toLowerCase()))
                .map(f => ({ filename: f, path: path.join(folderPath, f) }));
            return { success: true, images };
        } catch (error) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('select-bubble-image', async () => {
        try {
            const result = await dialog.showOpenDialog(ctx.settingsWindow || deps.BrowserWindow.getFocusedWindow(), {
                properties: ['openFile'],
                title: mt('main.selectBubble'),
                filters: [{ name: mt('main.filterImage'), extensions: ['png', 'jpg', 'jpeg', 'svg'] }]
            });
            if (result.canceled || !result.filePaths.length) return { success: false, error: 'cancelled' };
            return { success: true, filePath: result.filePaths[0] };
        } catch (error) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('select-app-icon', async () => {
        try {
            const result = await dialog.showOpenDialog(ctx.settingsWindow || deps.BrowserWindow.getFocusedWindow(), {
                properties: ['openFile'],
                title: mt('main.selectIcon'),
                filters: [{ name: mt('main.filterIcon'), extensions: ['png', 'ico', 'jpg'] }]
            });
            if (result.canceled || !result.filePaths.length) return { success: false, error: 'cancelled' };
            const srcPath = result.filePaths[0];
            const ext = path.extname(srcPath);
            const destPath = path.join(app.getPath('userData'), 'app-icon' + ext);
            fs.copyFileSync(srcPath, destPath);
            return { success: true, iconPath: destPath };
        } catch (error) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('copy-model-to-userdata', async (event, folderPath, modelName) => {
        try {
            const dirName = modelName || path.basename(folderPath);
            const destDir = path.join(app.getPath('userData'), 'models', dirName);
            fs.cpSync(folderPath, destDir, { recursive: true });
            const relPath = path.join('models', dirName);
            return { success: true, userDataModelPath: relPath, absolutePath: destDir };
        } catch (error) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('validate-model-paths', async () => {
        try {
            const config = await configManager.loadConfigFile();
            const model = config.model || {};
            if (model.type === 'none') return { success: true, valid: true, type: 'none' };

            if (model.type === 'live2d') {
                let modelDir;
                if (model.userDataModelPath) {
                    modelDir = path.join(app.getPath('userData'), model.userDataModelPath);
                } else {
                    modelDir = model.folderPath;
                }
                if (!modelDir || !fs.existsSync(modelDir)) {
                    return { success: true, valid: false, error: mt('main.modelFolderNotExist') };
                }
                if (model.modelJsonFile) {
                    const jsonPath = path.join(modelDir, model.modelJsonFile);
                    if (!fs.existsSync(jsonPath)) {
                        return { success: true, valid: false, error: mt('main.model3NotExist') };
                    }
                    try { JSON.parse(fs.readFileSync(jsonPath, 'utf-8')); }
                    catch { return { success: true, valid: false, error: mt('main.model3ParseFail') }; }
                }
                return { success: true, valid: true, type: 'live2d', modelDir };
            }

            if (model.type === 'image') {
                if (model.imageFolderPath) {
                    if (!fs.existsSync(model.imageFolderPath)) {
                        return { success: true, valid: false, error: mt('main.imageNotExist') };
                    }
                    return { success: true, valid: true, type: 'image' };
                }
                if (!model.staticImagePath || !fs.existsSync(model.staticImagePath)) {
                    return { success: true, valid: false, error: mt('main.imageNotExist') };
                }
                return { success: true, valid: true, type: 'image' };
            }

            return { success: true, valid: true, type: model.type };
        } catch (error) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('delete-profile', async (event, profileId) => {
        try {
            if (!profileId || !isValidUUID(profileId)) return { success: false, error: 'invalid profile ID' };
            const profileDir = path.join(app.getPath('userData'), 'profiles', profileId);
            if (fs.existsSync(profileDir)) {
                fs.rmSync(profileDir, { recursive: true, force: true });
            }
            return { success: true };
        } catch (error) { return { success: false, error: error.message }; }
    });
}

module.exports = { registerModelImport, suggestParamMapping, PARAM_FUZZY_MAP };
