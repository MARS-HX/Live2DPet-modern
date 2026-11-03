/**
 * 实测 TTS 合成链路：配置 → TTSService → Mimo API → 音频字节。
 *
 *     node scripts/probe-tts.js
 *
 * 会真的打一次网络请求（会消耗额度），但只有一次，用来定位
 * "为什么宠物不出声"到底是配置、网络还是代码问题。
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

async function main() {
    const { TTSService } = require('../src/core/tts-service');

    // 模拟 main.js 的初始化流程
    const cfgPath = path.join(__dirname, '..', 'config.json');
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) {
        console.log('读不到 config.json:', e.message);
        return;
    }
    const t = cfg.tts || {};
    const serviceType = t.serviceType || 'mimo';
    console.log('serviceType:', serviceType);
    console.log('mimo.model :', t.mimo?.model);
    console.log('mimo.baseURL (原始):', JSON.stringify(t.mimo?.baseURL));
    console.log('mimo.apiKey 长度:', (t.mimo?.apiKey || '').length);

    const options = {
        serviceType,
        mimo: {
            // 注意：main.js 里是 `ttsConfig.mimo?.baseURL || '默认值'`
            // 空字符串是 falsy，所以会回落到默认地址 —— 这里照抄同样的逻辑
            baseURL: t.mimo?.baseURL || 'https://api.xiaomimimo.com/v1',
            apiKey: t.mimo?.apiKey || '',
            model: t.mimo?.model || 'mimo-v2.5-tts',
            format: t.mimo?.format || 'wav',
            stylePrompt: t.mimo?.stylePrompt || '自然、流畅、清晰的中文语音',
        },
    };
    console.log('生效 baseURL:', options.mimo.baseURL);
    console.log('生效 stylePrompt:', JSON.stringify(options.mimo.stylePrompt));

    const svc = new TTSService();
    const ok = svc.init(options);
    console.log('');
    console.log('init():', ok);
    console.log('initialized:', svc.initialized);
    console.log('isConfigured():', svc.isConfigured());
    console.log('isAvailable():', svc.isAvailable());

    if (!svc.isConfigured()) {
        console.log('');
        console.log('✗ 未配置 —— 合成会被跳过（这是"没声音"的一个可能原因）');
        return;
    }

    console.log('');
    console.log('正在请求合成…');
    const t0 = Date.now();
    const buf = await svc.synthesize('你好呀，这是一次语音测试。');
    const ms = Date.now() - t0;
    if (!buf) {
        console.log(`✗ 合成返回 null（耗时 ${ms}ms）`);
        console.log('  degraded:', svc.degraded, 'failCount:', svc.failCount);
        return;
    }
    console.log(`✓ 合成成功：${buf.length} 字节，耗时 ${ms}ms`);
    const out = path.join(__dirname, '..', '.vision-smoke', 'tts-probe.wav');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf);
    console.log('  存盘:', out);
    // 嗅探文件头，确认真的是音频而不是错误 JSON
    const head = buf.subarray(0, 12).toString('hex');
    const riff = buf.subarray(0, 4).toString('ascii');
    console.log('  文件头:', head, riff === 'RIFF' ? '(WAV ✓)' : '(不是 WAV)');
}

main().catch((e) => { console.error('异常:', e); process.exitCode = 1; });
