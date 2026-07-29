#!/usr/bin/env node
// Debug launcher: spawns Live2DPet.exe with --enable-logging
// Usage:
//   node debug.js                  — show all logs (filter DXGI noise)
//   node debug.js enhance          — only show [Enhance:*] logs
//   node debug.js prompt           — only show [Prompt*] / [AIChatClient] logs
//   node debug.js enhance,prompt   — combine multiple filters
const { spawn } = require('child_process');
const path = require('path');

const NOISE = ['dxgi_', 'DxgiDuplicatorController'];

const FILTERS = {
    enhance: ['[Enhance:', '[VLM', '[ContextPool', '[Knowledge', '[Memory', '[Search'],
    prompt:  ['[PromptBuilder', '[AIChatClient', '[DesktopPetSystem] Enhanced context'],
    tts:     ['[TTS', '[Translation', 'voicevox', 'VOICEVOX'],
    emotion: ['[Emotion', 'setExpression', 'playMotion'],
    all:     [],
};

const arg = process.argv[2] || '';
const activeFilters = arg ? arg.split(',').flatMap(k => FILTERS[k.trim()] || [k.trim()]) : [];

const exe = path.join(__dirname, 'dist', 'Live2DPet.exe');
const child = spawn(exe, ['--enable-logging'], {
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: false
});

const filter = (stream, out) => {
    let buf = '';
    stream.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
            if (NOISE.some(n => line.includes(n))) continue;
            if (activeFilters.length && !activeFilters.some(f => line.includes(f))) continue;
            out.write(line + '\n');
        }
    });
    stream.on('end', () => { if (buf.trim()) out.write(buf + '\n'); });
};

filter(child.stdout, process.stdout);
filter(child.stderr, process.stderr);

child.on('close', (code) => process.exit(code ?? 1));
