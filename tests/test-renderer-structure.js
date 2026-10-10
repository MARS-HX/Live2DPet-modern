/**
 * 渲染层结构护栏 —— 按花括号深度断言代码所处的层级。
 *
 * 起因：settings-ui.js 里「音频设备管理」整段被复制了四份，其中三份被误关进了
 * 「保存预设 / 导入预设 / 删除预设」三个回调的 try 块内（花括号深度 2~3，而不是 0）。
 * 后果：
 *   - 每做一次预设操作，就多挂一套 audio-volume / btn-save-audio / devicechange
 *     监听器（第 N 次保存预设后，保存音频设置按钮会同时跑 N 遍）；
 *   - 这些副本里抛出的异常会被外层的 catch 报成「保存失败 / 导入失败 / 删除失败」，
 *     与真实原因毫无关系。
 * 纯文本 diff 和 lint 都看不出这种「层级错位」，所以要断言深度。
 *
 * 运行：node --test tests/test-renderer-structure.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BACKSLASH = 92;   // 用码位比较，免得本文件自己踩转义坑

/**
 * 逐字符扫描源码，返回每行起始处的花括号深度与最终深度。
 * 会跳过行注释、块注释、字符串、模板串（含其中的转义）以及**正则字面量**。
 *
 * 正则那段不是洁癖：`escapeHtml` 里的 `/"/g` 这类含引号的正则，会让不认识正则的
 * 扫描器把那个引号当成字符串开头，从此深度全歪 —— 护栏会开始误报。
 */
function scanDepths(src) {
    const depthAt = [];
    let depth = 0;
    let i = 0;
    let line = 1;
    let last = '';   // 最近一个「有意义的字符」，用来判断 / 是正则还是除号
    // 这些字符之后出现的 / 只可能是正则字面量（标准启发式）。
    // 刻意**不含** < 和 > —— 本文件里 HTML 闭合标签 `</div>` 遍地都是，把紧跟 < 的 /
    // 当正则会把整段模板吞掉；而「小于号后面跟正则」这种写法现实中不存在。
    const regexCanFollow = (ch) => ch === '' || '([{,;:=!&|?+-*%~^'.includes(ch);
    while (i < src.length) {
        const c = src[i];
        const n = src[i + 1];
        if (i === 0 || src[i - 1] === '\n') depthAt[line] = depth;
        if (c === '/' && n === '/') {
            while (i < src.length && src[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && n === '*') {
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
                if (src[i] === '\n') { line++; depthAt[line] = depth; }
                i++;
            }
            i += 2;
            continue;
        }
        if (c === '/' && regexCanFollow(last)) {
            i++;
            let inClass = false;
            while (i < src.length && src[i] !== '\n') {
                const ch = src[i];
                if (ch.charCodeAt(0) === BACKSLASH) { i += 2; continue; }
                if (ch === '[') inClass = true;
                else if (ch === ']') inClass = false;
                else if (ch === '/' && !inClass) break;
                i++;
            }
            i++;   // 跳过收尾的 /
            while (i < src.length && /[a-z]/i.test(src[i])) i++;   // 标志位
            last = '/';
            continue;
        }
        if (c === "'" || c === '"' || c === '`') {
            const quote = c;
            i++;
            while (i < src.length && src[i] !== quote) {
                if (src.charCodeAt(i) === BACKSLASH) i++;
                if (src[i] === '\n') { line++; depthAt[line] = depth; }
                i++;
            }
            i++;
            last = quote;
            continue;
        }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        if (c === '\n') { line++; depthAt[line] = depth; }
        if (c !== ' ' && c !== '\t') last = c;
        i++;
    }
    return { depthAt, finalDepth: depth };
}

function collectSources() {
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (['node_modules', '.git', 'dist', 'libs', 'tests'].includes(e.name)) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (p.endsWith('.js')) out.push(p);
        }
    };
    walk(path.join(ROOT, 'src'));
    for (const f of ['main.js', 'preload.js', 'launch.js']) {
        const p = path.join(ROOT, f);
        if (fs.existsSync(p)) out.push(p);
    }
    return out.sort();
}

const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n');

describe('渲染层结构护栏', () => {
    it('扫描范围合理', () => {
        const files = collectSources();
        assert.ok(files.length > 40, `应覆盖主/渲染进程的 JS，实际 ${files.length}`);
    });

    it('音频设备管理只有一份，且位于模块顶层', () => {
        const file = path.join(ROOT, 'src', 'renderer', 'settings-ui.js');
        const src = fs.readFileSync(file, 'utf8');
        const { depthAt, finalDepth } = scanDepths(src);
        assert.strictEqual(finalDepth, 0, '花括号必须配平');

        const lines = readLines(file);
        const decls = [];
        lines.forEach((l, i) => {
            if (l.includes('function enumerateAudioDevices(')) decls.push(i + 1);
        });
        assert.strictEqual(decls.length, 1,
            `enumerateAudioDevices 只能声明一次，实际 ${decls.length} 次（行 ${decls.join(', ')}）`);
        assert.strictEqual(depthAt[decls[0]], 0,
            '它必须位于模块顶层（深度 0）—— 被关进某个回调的 try 里就只有用户点过那个按钮才会执行');

        const marks = [];
        lines.forEach((l, i) => {
            if (l.includes('========== 音频设备管理 ==========')) marks.push(i + 1);
        });
        assert.strictEqual(marks.length, 1, `音频段只能有一份，实际 ${marks.length} 份（行 ${marks.join(', ')}）`);
        assert.strictEqual(depthAt[marks[0]], 0, '音频段必须在模块顶层，否则设备枚举/音量恢复不会在页面加载时执行');
    });

    it('同一文件、同一深度下不得重复声明同名函数', () => {
        const offenders = [];
        for (const file of collectSources()) {
            const src = fs.readFileSync(file, 'utf8');
            const { depthAt } = scanDepths(src);
            const seen = new Map();
            src.split('\n').forEach((l, i) => {
                const m = l.match(/^[ \t]*(async[ \t]+)?function[ \t]+([A-Za-z_$][A-Za-z0-9_$]*)[ \t]*\(/);
                if (!m) return;
                const depth = depthAt[i + 1] || 0;
                const key = m[2] + '@' + depth;
                const where = path.relative(ROOT, file) + ':' + (i + 1);
                if (seen.has(key)) {
                    offenders.push(`${where} 与 ${seen.get(key)} 在同一深度重复声明 ${m[2]}（深度 ${depth}）`);
                } else {
                    seen.set(key, where);
                }
            });
        }
        assert.deepStrictEqual(offenders, [],
            `重复声明通常是复制粘贴事故：后者会静默覆盖前者，而重复挂上的监听器会叠加执行：\n  ${offenders.join('\n  ')}`);
    });
});
