/**
 * 渲染层安全护栏 —— 源码级静态检查 + 一处真实行为验证。
 *
 * 起因：`pet-chat-window.html` 的日记弹窗曾把模型返回的文本用字符串拼进
 * `innerHTML`。那扇窗是 `webSecurity: false`，而 `preload.js` 又向渲染层暴露了
 * `dshRun()` / `saveConfig()` / `openExternal()`，于是
 * 「一次提示注入 → 一段脚本 → 本机任意命令」这条链是通的。
 *
 * 这些用例不启动浏览器，只做结构化断言，防止同一个坑被重新踩回去。
 * 运行：node --test tests/test-renderer-safety.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LF = String.fromCharCode(10);
const BS = String.fromCharCode(92); // 反斜杠：一律用码位构造，免去本文自身被转义层数污染

const HTML_FILES = fs
    .readdirSync(ROOT)
    .filter((name) => name.endsWith('.html'))
    .map((name) => path.join(ROOT, name))
    .sort();

const CHAT_WINDOW = path.join(ROOT, 'pet-chat-window.html');

const read = (p) => fs.readFileSync(p, 'utf8');
const rel = (p) => path.relative(ROOT, p);
const linesOf = (src) => src.split(LF);
const lineAt = (src, index) => src.slice(0, index).split(LF).length;

/** 需要同样对待的源码范围：HTML + 主/渲染进程 JS（不含 tests）。 */
function sourceFiles() {
    const out = HTML_FILES.slice();
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (['node_modules', '.git', 'dist', 'libs', 'tests'].includes(e.name)) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (p.endsWith('.js')) out.push(p);
        }
    };
    walk(path.join(ROOT, 'src'));
    for (const f of ['main.js', 'preload.js', 'launch.js', 'debug.js']) {
        const p = path.join(ROOT, f);
        if (fs.existsSync(p)) out.push(p);
    }
    return out.sort();
}

/**
 * 从源码里取出一个具名函数的完整文本（大括号配对，会跳过字符串与模板串）。
 * 用于把 HTML 内联脚本里的函数拎出来单独跑。
 */
function extractFunction(src, name) {
    const start = src.indexOf('function ' + name + '(');
    if (start === -1) return null;
    let i = src.indexOf('{', start);
    if (i === -1) return null;
    let depth = 0;
    for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === "'" || ch === '"' || ch === '`') {
            i++;
            while (i < src.length && src[i] !== ch) {
                if (src[i] === BS) i++;
                i++;
            }
            continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    return null;
}

// ========== 「外部字符串未转义就拼进 HTML」的检测器 ==========
//
// 抽成模块级函数是为了能被正向对照用例单独验证：护栏自己错掉的话，
// 它会一边放过真实注入、一边让人以为项目是安全的。

/** 取出一行里所有 ${...} 的内部表达式与起始下标（含嵌套大括号）。 */
function interpolationsOf(line) {
    const out = [];
    for (let i = 0; i < line.length - 1; i++) {
        if (line[i] !== '$' || line[i + 1] !== '{') continue;
        let depth = 0;
        let j = i + 1;
        for (; j < line.length; j++) {
            if (line[j] === '{') depth++;
            else if (line[j] === '}') {
                depth--;
                if (depth === 0) break;
            }
        }
        out.push({ expr: line.slice(i + 2, j), at: i });
        i = j;
    }
    return out;
}

/**
 * 这个插值是不是落在「会解析成标记」的位置？
 *   - 属性值：`="${` / `='${` / 未加引号的 `=${`
 *   - 文本节点：`>${`
 *   - 所在模板串里已经出现过 `<`，或同一行在拼 innerHTML 且含标签
 * （局限：HTML 标签与插值分散在不同行时会漏检；本项目的模板都是一行一个。）
 */
function isDangerousPosition(line, at) {
    const before = line.slice(0, at);
    if (/[=][ \t]*['"][ \t]*$/.test(before)) return true;
    if (/[=][ \t]*$/.test(before)) return true;
    if (/>[ \t]*$/.test(before)) return true;
    const tick = before.lastIndexOf('`');
    if ((tick >= 0 ? before.slice(tick) : before).includes('<')) return true;
    return line.includes('innerHTML') && line.includes('<');
}

/** `${cond ? 'checked' : ''}` 这类三元：两个分支都是字面量，条件本身的值不进 HTML。 */
function isLiteralTernary(expr) {
    const q = expr.indexOf('?');
    if (q < 0) return false;
    const colon = expr.lastIndexOf(':');
    if (colon < q) return false;
    const literal = (s) => {
        const t = s.trim();
        if (!t) return false;
        if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return true;
        return /^-?\d+(\.\d+)?$/.test(t) || t === 'true' || t === 'false';
    };
    return literal(expr.slice(q + 1, colon)) && literal(expr.slice(colon + 1));
}

/** 返回 [{line, name, expr}]：risky 变量未经 safeWrappers 包裹就进了危险位置。 */
function findUnsafeInterpolations(source, risky, safeWrappers) {
    const offenders = [];
    source.split(LF).forEach((line, idx) => {
        for (const { expr, at } of interpolationsOf(line)) {
            if (!isDangerousPosition(line, at)) continue;
            if (isLiteralTernary(expr)) continue;
            for (const name of risky) {
                if (!expr.includes(name)) continue;
                if (safeWrappers.some((w) => expr.includes(w))) continue;
                offenders.push({ line: idx + 1, name, expr });
            }
        }
    });
    return offenders;
}

/**
 * 拼接式注入：`el.innerHTML = '前缀' + 外部字符串 + '后缀'`。
 *
 * 这条单独一路是必要的：「innerHTML 只能赋值为单个字符串字面量」那条只扫 HTML 文件，
 * 而本检测的插值分支只认 `${...}`，两者都看不见 `'a' + x` 这种写法
 * （当年日记弹窗正是栽在这里）。
 */
function findUnsafeConcatenation(source, risky, safeWrappers) {
    const offenders = [];
    source.split(LF).forEach((line, idx) => {
        if (!line.includes('.innerHTML')) return;
        const eq = line.indexOf('=');
        if (eq < 0) return;
        const rhs = line.slice(eq + 1);
        if (!rhs.includes('+')) return;   // 单个字面量直接赋值不在此列
        for (const name of risky) {
            if (!rhs.includes(name)) continue;
            if (safeWrappers.some((w) => rhs.includes(w))) continue;
            offenders.push({ line: idx + 1, name, expr: rhs.trim().slice(0, 60) });
        }
    });
    return offenders;
}

describe('渲染层安全护栏', () => {
    it('扫描范围合理', () => {
        assert.ok(HTML_FILES.length >= 4, `至少应有 4 个 HTML，实际 ${HTML_FILES.length}`);
        assert.ok(sourceFiles().length > 40, '应覆盖主/渲染进程的 JS');
    });

    it('innerHTML 只能赋值为单个字符串字面量', () => {
        const offenders = [];
        for (const file of HTML_FILES) {
            const src = read(file);
            const re = /[.]innerHTML[ \t]*=[ \t]*([^;]*)/g;
            let m;
            while ((m = re.exec(src)) !== null) {
                const first = m[1].split(LF)[0].trim();
                const quoted =
                    first.length >= 2 &&
                    ((first.startsWith("'") && first.endsWith("'")) ||
                        (first.startsWith('"') && first.endsWith('"')));
                const interpolated = first.includes('+') || first.includes('${') || first.startsWith('`');
                if (!quoted || interpolated) {
                    offenders.push(`${rel(file)}:${lineAt(src, m.index)}  innerHTML = ${first.slice(0, 70)}`);
                }
            }
        }
        assert.deepStrictEqual(
            offenders,
            [],
            `innerHTML 不允许拼接/插值——那会把不可信文本变成可执行的 HTML：\n  ${offenders.join('\n  ')}`
        );
    });

    it('没有其它 HTML 注入通道', () => {
        const forbidden = ['insertAdjacentHTML', 'outerHTML', 'document.write'];
        const offenders = [];
        for (const file of HTML_FILES) {
            const src = read(file);
            for (const needle of forbidden) {
                let at = src.indexOf(needle);
                while (at !== -1) {
                    offenders.push(`${rel(file)}:${lineAt(src, at)}  ${needle}`);
                    at = src.indexOf(needle, at + needle.length);
                }
            }
        }
        assert.deepStrictEqual(
            offenders,
            [],
            `改用 createElement / textContent / append：\n  ${offenders.join('\n  ')}`
        );
    });

    it('内联 <script> 都必须是合法 JS（能通过语法解析）', () => {
        const scriptRe = new RegExp('<script(?![^>]*src=)[^>]*>([^]*?)</script>', 'gi');
        const offenders = [];
        let checked = 0;
        for (const file of HTML_FILES) {
            const src = read(file);
            let m;
            while ((m = scriptRe.exec(src)) !== null) {
                const code = m[1];
                if (!code.trim()) continue;
                checked++;
                try {
                    // 只解析，不执行
                    new Function(code);
                } catch (e) {
                    offenders.push(`${rel(file)}: ${e.message}`);
                }
            }
        }
        assert.ok(checked >= 3, `应检查到多个内联脚本，实际 ${checked}`);
        assert.deepStrictEqual(offenders, [], `内联脚本语法错误：\n  ${offenders.join('\n  ')}`);
    });

    it('没有把换行写成双反斜杠的字面量（split/join/replace 三处高发）', () => {
        const doubled = BS + BS + 'n';
        const needles = [
            "split('" + doubled + "')",
            'split("' + doubled + '")',
            "join('" + doubled + "')",
            'join("' + doubled + '")',
            'replace(/' + doubled,
        ];
        const offenders = [];
        for (const file of sourceFiles()) {
            const src = read(file);
            const lines = linesOf(src);
            for (const needle of needles) {
                let at = src.indexOf(needle);
                while (at !== -1) {
                    const lineNo = lineAt(src, at);
                    const lineText = (lines[lineNo - 1] || '').trim();
                    // 注释里出现这个写法是好事——那是在解释这个坑，不是在踩它
                    const inComment =
                        lineText.startsWith('//') || lineText.startsWith('*') || lineText.startsWith('/*');
                    if (!inComment) offenders.push(`${rel(file)}:${lineNo}  ${needle}`);
                    at = src.indexOf(needle, at + needle.length);
                }
            }
        }
        assert.deepStrictEqual(
            offenders,
            [],
            `这些写法切分/匹配的是字面量「反斜杠+n」，不是换行：\n  ${offenders.join('\n  ')}`
        );
    });

    it('日记正文确实经由 appendPlainText 渲染（回归：曾经拼 innerHTML）', () => {
        const src = read(CHAT_WINDOW);
        assert.ok(
            linesOf(src).some((l) => l.includes('appendPlainText(diaryBody, diary)')),
            '日记正文必须通过 appendPlainText 渲染'
        );
        const bad = linesOf(src).filter((l) => l.includes('.innerHTML') && l.includes('diary'));
        assert.deepStrictEqual(bad, [], '日记不得再进入 innerHTML');
    });

    it('外部来源的字符串拼进 HTML 时必须转义（回归：模型素材名可闭合属性注入）', () => {
        // 这些值都来自本应用之外：Live2D 模型 JSON 里的表情/动作/参数名、用户选的
        // 图片文件名与目录。Windows 文件名不能带双引号，但 macOS/Linux 可以，
        // 而 `${name}` 落在 value="..." 里就会闭合属性并注入标记。设置窗暴露了整条
        // preload 桥（saveConfig / openExternal / dshRun），CSP 又允许内联处理器。
        const RISKY = ['f.file', 'f.emotionName', 'expr.name', 'expr.file', 'm.name', 'm.group', 'folderPath', 'diag.serviceType'];
        const SAFE_WRAPPERS = ['escapeHtml(', 'encodeURIComponent('];
        const targets = HTML_FILES.concat(
            fs.readdirSync(path.join(ROOT, 'src', 'renderer'))
                .filter((f) => f.endsWith('.js'))
                .map((f) => path.join(ROOT, 'src', 'renderer', f)));

        const offenders = [];
        for (const file of targets) {
            const src = read(file);
            for (const hit of findUnsafeInterpolations(src, RISKY, SAFE_WRAPPERS)) {
                offenders.push(`${rel(file)}:${hit.line}  未转义地插值 ${hit.name} → \${${hit.expr.slice(0, 50)}}`);
            }
            for (const hit of findUnsafeConcatenation(src, RISKY, SAFE_WRAPPERS)) {
                offenders.push(`${rel(file)}:${hit.line}  拼接进 innerHTML 的 ${hit.name} → ${hit.expr}`);
            }
        }
        assert.deepStrictEqual(offenders, [],
            `这些值来自模型素材/文件名，必须先过 escapeHtml() 再拼进 HTML：\n  ${offenders.join('\n  ')}`);
    });

    it('转义护栏自身要能检出样例、且不误报（正向对照）', () => {
        // 护栏自己写错的话最糟：它会放过真实注入，同时让人以为项目是安全的。
        // 所以拿构造样例把判据钉死。
        const RISKY = ['f.file', 'expr.name'];
        const SAFE = ['escapeHtml(', 'encodeURIComponent('];

        const mustCatch = [
            ['属性值位置 value="${…}"', 'row.innerHTML = `<input value="${expr.name}">`;'],
            ['属性值位置 alt="${…}"', 'row.innerHTML = `<img alt="${f.file}">`;'],
            ['数据属性 data-name="${…}"', 'row.innerHTML = `<i data-name="${expr.name}">x</i>`;'],
            ['属性值里带空格', 'row.innerHTML = `<i title="${ f.file }">x</i>`;'],
            ['文本节点位置 >${…}', 'row.innerHTML = `<span>${f.file}</span>`;'],
            ['插值在标签之前', 'row.innerHTML = `${f.file}<span>x</span>`;'],
            ['三元分支里带变量', 'row.innerHTML = `<i data-x="${f.idle ? expr.name : 0}">`;'],
        ];
        for (const [why, src] of mustCatch) {
            assert.ok(findUnsafeInterpolations(src, RISKY, SAFE).length > 0,
                `护栏漏检（${why}）：${src}`);
        }

        const mustNotCatch = [
            ['已转义', 'row.innerHTML = `<input value="${escapeHtml(expr.name)}">`;'],
            ['已 encodeURIComponent', 'row.innerHTML = `<img src="${encodeURIComponent(f.file)}">`;'],
            ['两个分支都是字面量的三元', 'row.innerHTML = `<input ${f.idle ? 1 : 0}>`;'],
            ['textContent 不解析 HTML', 'el.textContent = `${f.file} 已处理`;'],
            ['与 HTML 无关的普通代码', 'const p = `${f.file}/x`;'],
        ];
        for (const [why, src] of mustNotCatch) {
            assert.deepStrictEqual(findUnsafeInterpolations(src, RISKY, SAFE), [],
                `护栏误报（${why}）：${src}`);
        }

        // 拼接式注入单独一路：`innerHTML = '前缀' + 外部值`
        const CONCAT_RISKY = ['f.file', 'expr.name', 'diary', 'diag.serviceType'];
        const mustCatchConcat = [
            ['拼接的日记正文', "box.innerHTML = '<div>' + diary + '</div>';"],
            ['拼接的模型名', "el.innerHTML = 'Backend: ' + diag.serviceType + '<br>';"],
        ];
        for (const [why, src] of mustCatchConcat) {
            assert.ok(findUnsafeConcatenation(src, CONCAT_RISKY, SAFE).length > 0,
                `护栏漏检拼接注入（${why}）：${src}`);
        }
        const mustNotCatchConcat = [
            ['已转义', "el.innerHTML = 'Backend: ' + escapeHtml(diag.serviceType) + '<br>';"],
            ['整行已转义', "el.innerHTML = 'TTS:<br>' + lines.map(escapeHtml).join('<br>');"],
            ['纯字面量', "el.innerHTML = '<b>ok</b>';"],
            ['textContent', "el.textContent = 'Backend: ' + diag.serviceType;"],
        ];
        for (const [why, src] of mustNotCatchConcat) {
            assert.deepStrictEqual(findUnsafeConcatenation(src, CONCAT_RISKY, SAFE), [],
                `护栏误报（${why}）：${src}`);
        }
    });

    it('appendPlainText：模型输出里的 HTML 只会变成文本节点，换行变成 <br>', () => {
        const src = read(CHAT_WINDOW);
        const fnSource = extractFunction(src, 'appendPlainText');
        assert.ok(fnSource, 'pet-chat-window.html 里应能取出 appendPlainText');

        const docStub = {
            createElement: (tag) => ({ nodeType: 1, tagName: tag }),
            createTextNode: (text) => ({ nodeType: 3, text }),
        };
        // 只把 document 传进去，不执行 HTML 里的其它任何代码
        const appendPlainText = new Function('document', fnSource + LF + 'return appendPlainText;')(docStub);

        const makeContainer = () => ({
            children: [],
            appendChild(c) {
                this.children.push(c);
                return c;
            },
        });
        const shape = (c) => c.children.map((n) => (n.nodeType === 3 ? 'text:' + n.text : 'el:' + n.tagName));

        // 1) 注入载荷必须是文本，不能被解析成元素
        const c1 = makeContainer();
        appendPlainText(c1, ['a', '<img src=x onerror=alert(1)>', 'b'].join(LF));
        assert.deepStrictEqual(shape(c1), [
            'text:a',
            'el:br',
            'text:<img src=x onerror=alert(1)>',
            'el:br',
            'text:b',
        ]);

        // 2) CRLF 与单独的 CR 同样只产生一个换行
        const CR = String.fromCharCode(13);
        const c2 = makeContainer();
        appendPlainText(c2, 'a' + CR + LF + 'b' + CR + 'c');
        assert.deepStrictEqual(shape(c2), ['text:a', 'el:br', 'text:b', 'el:br', 'text:c']);

        // 3) null / undefined 不该抛
        const c3 = makeContainer();
        assert.doesNotThrow(() => appendPlainText(c3, null));
        assert.deepStrictEqual(shape(c3), []);
    });
});
