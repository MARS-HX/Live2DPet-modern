/**
 * DshBridge — drive DeepSeek Harness (DSH) from the desktop pet.
 *
 * Integration surface: the `dsh` launcher's one-shot headless profile
 *
 *     dsh --profile headless "<task>"
 *
 * which boots a fresh persisted agent session inside the invoking directory,
 * submits the task as an ordinary user message, writes the final assistant
 * answer to stdout, and exits 0 when a turn completed (non-zero otherwise).
 * It opens no listening port, so the bridge is a plain child process — there
 * is no HTTP/WebSocket protocol to reverse-engineer.
 *
 * Launch strategy (most robust first):
 *   1. Resolve the launcher script `@deepseek-ai/dsh/lib/bin.js`. When found we
 *      run it with the Electron binary in Node mode (ELECTRON_RUN_AS_NODE=1),
 *      so the task travels as a real argv entry and never meets shell quoting.
 *   2. Otherwise fall back to the `dsh` command on PATH through a shell, with
 *      the task single-quoted for the platform shell.
 *
 * Everything process-facing is injectable so the logic stays unit-testable
 * without spawning a real agent.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_PROFILE = 'headless';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CAPTURE_CHARS = 512 * 1024;     // cap retained stdout/stderr

/** Candidate locations of the dsh launcher script, most specific first. */
function candidateScriptPaths(env = process.env, platform = process.platform) {
    const out = [];
    const push = (p) => { if (p) out.push(p); };
    if (env.DSH_SCRIPT) push(env.DSH_SCRIPT);
    if (platform === 'win32') {
        push(path.join(env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
        push(path.join(env.ProgramFiles || '', 'nodejs', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
        push(path.join(env['ProgramFiles(x86)'] || '', 'nodejs', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
        push(path.join(env.LOCALAPPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
    } else {
        push('/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js');
        push('/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js');
        push(path.join(env.HOME || '', '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
    }
    return out.filter(Boolean);
}

/**
 * Resolve the dsh launcher script path.
 * @returns {{ script: string|null, checked: string[] }}
 */
function resolveDshScript(options = {}) {
    const env = options.env || process.env;
    const exists = options.exists || ((p) => { try { return fs.existsSync(p); } catch { return false; } });
    const checked = [];
    const explicit = options.explicitPath;
    if (explicit) {
        checked.push(explicit);
        if (exists(explicit)) return { script: explicit, checked };
    }
    for (const cand of candidateScriptPaths(env, options.platform || process.platform)) {
        checked.push(cand);
        if (exists(cand)) return { script: cand, checked };
    }
    return { script: null, checked };
}

/** Single-quote a value for POSIX shells. */
function shQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Quote a value for cmd.exe. */
function cmdQuote(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

/** True when the value would be split or reinterpreted by a shell. */
function needsShellQuote(value) {
    return !/^[A-Za-z0-9_@%+=:,.\/-]+$/.test(String(value));
}

/**
 * Build the child-process launch plan for one headless task.
 *
 * `via: 'script'` is the robust path: the launcher script is executed by the
 * Electron binary in Node mode with the task as a real argv entry, so no shell
 * ever parses user text. `via: 'path'` falls back to the `dsh` command and is
 * therefore shell-quoted; prefer the script path (or set config `dsh.script`).
 *
 * @returns {{ command: string, args: string[], options: object, via: 'script'|'path' }}
 */
function buildLaunchPlan(options) {
    const {
        task,
        profile = DEFAULT_PROFILE,
        extraArgs = [],
        workspace,
        script = null,
        execPath = process.execPath,
        env = process.env,
        platform = process.platform,
    } = options;

    const launcherArgs = ['--profile', profile, task, ...extraArgs];
    const baseOptions = {
        cwd: workspace || process.cwd(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    };

    if (script) {
        return {
            via: 'script',
            command: execPath,
            args: [script, ...launcherArgs],
            options: {
                ...baseOptions,
                // Electron's own binary doubles as Node when this is set, so
                // the child needs no separate Node installation on PATH.
                env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
            },
        };
    }

    const quote = platform === 'win32' ? cmdQuote : shQuote;
    // shell:true joins argv with spaces verbatim, so pre-quote the entries that
    // a shell would otherwise split. Plain flags stay readable.
    return {
        via: 'path',
        command: ['dsh', ...launcherArgs.map((a) => (needsShellQuote(a) ? quote(a) : a))].join(' '),
        args: [],
        options: { ...baseOptions, shell: true, env },
    };
}

/** Kill a child and its descendants (Windows needs taskkill for the tree). */
function killTree(child, platform = process.platform) {
    if (!child || child.killed) return;
    try {
        if (platform === 'win32' && child.pid) {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
            child.kill('SIGTERM');
        }
    } catch {
        try { child.kill(); } catch { /* already gone */ }
    }
}

class DshBridge {
    constructor(options = {}) {
        this._spawn = options.spawn || spawn;
        this._fs = options.fs || fs;
        this._execPath = options.execPath || process.execPath;
        this._env = options.env || process.env;
        this._platform = options.platform || process.platform;
        this._logger = options.logger || console;
        this._now = options.now || (() => Date.now());
        this._killTree = options.killTree || killTree;

        this._child = null;
        this._task = '';
        this._startedAt = 0;
        this._listeners = new Map();
    }

    on(event, cb) {
        if (!this._listeners.has(event)) this._listeners.set(event, []);
        this._listeners.get(event).push(cb);
        return () => {
            const list = this._listeners.get(event) || [];
            const i = list.indexOf(cb);
            if (i >= 0) list.splice(i, 1);
        };
    }

    _emit(event, payload) {
        for (const cb of this._listeners.get(event) || []) {
            try { cb(payload); } catch (e) { this._logger.warn?.(`[DSH] listener error: ${e.message}`); }
        }
    }

    isRunning() { return !!this._child; }

    status() {
        return {
            running: this.isRunning(),
            task: this._task,
            startedAt: this._startedAt,
            elapsedMs: this._startedAt ? this._now() - this._startedAt : 0,
        };
    }

    /** Whether the launcher can be located. */
    availability(explicitPath) {
        const { script, checked } = resolveDshScript({
            env: this._env, exists: (p) => { try { return this._fs.existsSync(p); } catch { return false; } },
            explicitPath, platform: this._platform,
        });
        return { available: !!script, script, checked, via: script ? 'script' : 'path' };
    }

    /**
     * Run one task. Resolves with a result object; never rejects.
     * @returns {Promise<{ok:boolean, answer:string, error:string|null, exitCode:number|null, durationMs:number, stderr:string}>}
     */
    run(task, options = {}) {
        const {
            profile = DEFAULT_PROFILE,
            extraArgs = [],
            workspace,
            timeoutMs = DEFAULT_TIMEOUT_MS,
            explicitPath,
        } = options;

        const text = typeof task === 'string' ? task.trim() : '';
        if (!text) return Promise.resolve(this._result(false, '', 'empty_task', null, 0, ''));
        if (this.isRunning()) return Promise.resolve(this._result(false, '', 'busy', null, 0, ''));

        const { script } = resolveDshScript({
            env: this._env,
            exists: (p) => { try { return this._fs.existsSync(p); } catch { return false; } },
            explicitPath,
            platform: this._platform,
        });

        const plan = buildLaunchPlan({
            task: text, profile, extraArgs, workspace, script,
            execPath: this._execPath, env: this._env, platform: this._platform,
        });

        return new Promise((resolve) => {
            let child;
            try {
                child = this._spawn(plan.command, plan.args, plan.options);
            } catch (e) {
                resolve(this._result(false, '', `spawn_failed: ${e.message}`, null, 0, ''));
                return;
            }

            this._child = child;
            this._task = text;
            this._startedAt = this._now();
            const startedAt = this._startedAt;

            let stdout = '';
            let stderr = '';
            let settled = false;
            let timedOut = false;

            const capture = (name, current, chunk) => {
                const s = chunk.toString('utf8');
                this._emit('output', { stream: name, text: s });
                return (current + s).slice(-MAX_CAPTURE_CHARS);
            };

            child.stdout?.on('data', (c) => { stdout = capture('stdout', stdout, c); });
            child.stderr?.on('data', (c) => { stderr = capture('stderr', stderr, c); });
            child.stdout?.on('error', () => {});
            child.stderr?.on('error', () => {});

            const timer = timeoutMs > 0 ? setTimeout(() => {
                timedOut = true;
                this._logger.warn?.(`[DSH] task timed out after ${timeoutMs}ms`);
                this._killTree(child, this._platform);
                // Settle now rather than waiting for 'close': a process that
                // ignores the kill must not be able to hang the bridge.
                finish(false, '', 'timeout', null);
            }, timeoutMs) : null;

            const finish = (ok, answer, error, exitCode) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                this._child = null;
                this._task = '';
                this._startedAt = 0;
                const result = this._result(ok, answer, error, exitCode, this._now() - startedAt, stderr.slice(-4000));
                this._emit('done', result);
                resolve(result);
            };

            child.on('error', (e) => {
                finish(false, '', timedOut ? 'timeout' : `spawn_error: ${e.message}`, null);
            });

            child.on('close', (code) => {
                if (timedOut) { finish(false, '', 'timeout', code); return; }
                const answer = stdout.trim();
                if (code === 0 && answer) { finish(true, answer, null, code); return; }
                if (code === 0 && !answer) { finish(false, '', 'empty_answer', code); return; }
                finish(false, '', this._errorFrom(stderr) || `exit_${code}`, code);
            });
        });
    }

    _result(ok, answer, error, exitCode, durationMs, stderr) {
        return { ok, answer, error, exitCode, durationMs, stderr };
    }

    /** Pick the most useful line out of the launcher's stderr diagnostics. */
    _errorFrom(stderr) {
        const lines = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (!lines.length) return '';
        const meaningful = lines.filter((l) => !/^\s*at\s/.test(l) && !/^node:internal/.test(l));
        return (meaningful[meaningful.length - 1] || lines[lines.length - 1]).slice(0, 500);
    }

    /** Cancel the running task. Returns true when something was running. */
    cancel() {
        if (!this._child) return false;
        this._killTree(this._child, this._platform);
        return true;
    }
}

module.exports = {
    DshBridge,
    resolveDshScript,
    candidateScriptPaths,
    buildLaunchPlan,
    killTree,
    needsShellQuote,
    shQuote,
    cmdQuote,
    DEFAULT_PROFILE,
    DEFAULT_TIMEOUT_MS,
    MAX_CAPTURE_CHARS,
};
