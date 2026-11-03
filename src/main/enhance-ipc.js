/**
 * MemoryIPC — 记忆数据（enhance-data.json）的读写通道。
 *
 * ## 为什么这个文件还叫 "enhance"
 *
 * 这段代码原本属于"增强层"（enhance/*），提供两件事：记忆持久化 + 网络搜索。
 * 增强层已经被 see-now 识屏流水线取代并整体删除（见 CHANGELOG），
 * 但**记忆持久化这一半和视觉无关** —— `conversation-store.js` 用它保存
 * 对话历史、阶段总结、话题与偏好，是仍然在用的核心功能。
 *
 * 只有 `web-search` 是纯增强层的（搜索服务的唯一调用方已被删除），一并移除。
 *
 * ## 为什么文件名保持 enhance-ipc.js
 *
 * `enhance-data.json` 这个名字是**磁盘上的既有格式**，用户数据文件已经这么叫了；
 * 同时这个名字也仍然出现在 preload 的两个方法名里（saveEnhanceData/loadEnhanceData），
 * 那些是渲染进程的 API 表面。改文件名会诱使人顺手改掉磁盘格式与 API，
 * 那会静默丢掉所有用户的长期记忆。所以：**文件名和通道名都不动，只删搜索**。
 */
'use strict';

/**
 * @param {object} ctx AppContext
 * @param {object} ipcMain Electron ipcMain
 * @param {{app:object, fs:object}} deps
 */
function registerEnhanceIPC(ctx, ipcMain, deps) {
    const { app, fs } = deps;
    const path = require('path');

    const enhanceDataPath = app.isPackaged
        ? path.join(app.getPath('userData'), 'enhance-data.json')
        : path.join(app.getAppPath(), 'enhance-data.json');

    ipcMain.handle('save-enhance-data', async (event, data) => {
        try {
            // 覆盖写：ConversationStore 每次保存都会送完整的记忆快照
            fs.writeFileSync(enhanceDataPath, JSON.stringify(data, null, 2), 'utf-8');
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('load-enhance-data', async () => {
        try {
            if (fs.existsSync(enhanceDataPath)) {
                return { success: true, data: JSON.parse(fs.readFileSync(enhanceDataPath, 'utf-8')) };
            }
            return { success: true, data: {} };
        } catch (e) {
            // 文件损坏时返回空对象而不是抛错：宁可让宠物"忘掉过去"，
            // 也不要因为一个坏文件导致整个应用起不来。
            return { success: true, data: {} };
        }
    });
}

module.exports = { registerEnhanceIPC };
