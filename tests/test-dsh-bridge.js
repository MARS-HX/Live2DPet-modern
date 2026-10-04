/**
 * Unit tests for the DeepSeek Harness (DSH) bridge.
 * Run with: node --test tests/test-dsh-bridge.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const {
    DshBridge,
    resolveDshScript,
    candidateScriptPaths,
    buildLaunchPlan,
    shQuote,
    cmdQuote,
    DEFAULT_PROFILE,
    DEFAULT_TIMEOUT_MS,
} = require('../src/main/dsh-bridge');

// ========== Launch planning ==========

describe('buildLaunchPlan', () => {
    it('runs the launcher script through the Electron binary in Node mode', () => {
        const plan = buildLaunchPlan({
            task: 'run the tests',
            script: 'C:/npm/node_modules/@deepseek-ai/dsh/lib/bin.js',
            execPath: 'C:/app/electron.exe',
            profile: 'headless',
            workspace: 'C:/work',
            env: { PATH: '/usr/bin' },
            platform: 'win32',
        });
        assert.strictEqual(plan.via, 'script');
        assert.strictEqual(plan.command, 'C:/app/electron.exe');
        assert.deepStrictEqual(plan.args.slice(0, 3), [
            'C:/npm/node_modules/@deepseek-ai/dsh/lib/bin.js', '--profile', 'headless',
        ]);
        assert.strictEqual(plan.args[3], 'run the tests');
        assert.strictEqual(plan.options.cwd, 'C:/work');
        assert.strictEqual(plan.options.env.ELECTRON_RUN_AS_NODE, '1');
        assert.ok(!plan.options.shell, 'script path must not use a shell');
    });

    it('passes the task as one argv entry even with spaces and quotes', () => {
        const task = 'fix "auth.js" and run the tests';
        const plan = buildLaunchPlan({ task, script: '/dsh/bin.js', execPath: '/node', env: {} });
        assert.strictEqual(plan.args[plan.args.length - 1], task);
    });

    it('appends extra launcher args after the task', () => {
        const plan = buildLaunchPlan({
            task: 'hello', script: '/dsh/bin.js', execPath: '/node', env: {},
            extraArgs: ['--resume', 'abc'],
        });
        assert.deepStrictEqual(plan.args.slice(-3), ['hello', '--resume', 'abc']);
    });

    it('falls back to a shell-quoted dsh command when no script is found', () => {
        const plan = buildLaunchPlan({
            task: 'run the tests', script: null, platform: 'linux', env: {}, workspace: '/w',
        });
        assert.strictEqual(plan.via, 'path');
        assert.deepStrictEqual(plan.args, []);
        assert.strictEqual(plan.options.shell, true);
        assert.match(plan.command, /^dsh --profile headless /);
        assert.ok(plan.command.includes(`'run the tests'`), 'task must be single-quoted');
    });

    it('uses cmd quoting on Windows fallback', () => {
        const plan = buildLaunchPlan({
            task: 'run the tests', script: null, platform: 'win32', env: {},
        });
        assert.ok(plan.command.includes('"run the tests"'));
    });

    it('defaults to the headless profile and cwd', () => {
        const plan = buildLaunchPlan({ task: 'x', script: '/dsh/bin.js', execPath: '/node', env: {} });
        assert.strictEqual(plan.args[2], DEFAULT_PROFILE);
        assert.ok(plan.options.cwd);
    });
});

describe('quoting helpers', () => {
    it('shQuote escapes embedded single quotes', () => {
        assert.strictEqual(shQuote("it's"), `'it'\\''s'`);
    });
    it('cmdQuote doubles embedded double quotes', () => {
        assert.strictEqual(cmdQuote('say "hi"'), '"say ""hi"""');
    });
});

// ========== Launcher resolution ==========

describe('resolveDshScript', () => {
    it('prefers an explicit existing path', () => {
        const r = resolveDshScript({
            explicitPath: '/custom/bin.js',
            exists: (p) => p === '/custom/bin.js',
            env: {}, platform: 'linux',
        });
        assert.strictEqual(r.script, '/custom/bin.js');
    });

    it('finds the npm global install on Windows', () => {
        const expected = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
        const r = resolveDshScript({
            exists: (p) => p === expected,
            env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
            platform: 'win32',
        });
        assert.strictEqual(r.script, expected);
    });

    it('honours DSH_SCRIPT from the environment', () => {
        const r = resolveDshScript({
            exists: (p) => p === '/env/bin.js',
            env: { DSH_SCRIPT: '/env/bin.js' },
            platform: 'linux',
        });
        assert.strictEqual(r.script, '/env/bin.js');
    });

    it('returns null and reports what it checked when nothing is found', () => {
        const r = resolveDshScript({ exists: () => false, env: {}, platform: 'win32' });
        assert.strictEqual(r.script, null);
        assert.ok(r.checked.length > 0);
    });

    it('candidateScriptPaths includes the npm global location', () => {
        const paths = candidateScriptPaths({ APPDATA: 'C:\\A' }, 'win32');
        assert.ok(paths.some((p) => p.includes('@deepseek-ai')));
    });
});

// ========== Bridge run lifecycle ==========

/** Build a fake spawn whose child emits the given behaviour. */
function makeFakeSpawn(behaviour) {
    const calls = [];
    const spawnFn = (command, args, options) => {
        calls.push({ command, args, options });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = 4242;
        child.killed = false;
        child.kill = () => { child.killed = true; };
        setImmediate(() => {
            if (behaviour === 'ok') {
                child.stdout.emit('data', Buffer.from('All tests pass.\n'));
                child.emit('close', 0);
            } else if (behaviour === 'empty') {
                child.emit('close', 0);
            } else if (behaviour === 'fail') {
                child.stderr.emit('data', Buffer.from('Error: model unavailable\n    at foo\n'));
                child.emit('close', 1);
            } else if (behaviour === 'spawn-error') {
                child.emit('error', new Error('ENOENT'));
            }
            // 'hang' emits nothing, so the timeout path is exercised
        });
        return child;
    };
    spawnFn.calls = calls;
    return spawnFn;
}

function makeBridge(spawnFn) {
    return new DshBridge({
        spawn: spawnFn,
        killTree: () => {},                 // never touch a real process tree
        logger: { warn() {}, log() {}, error() {} },
        env: {},
        platform: 'linux',
        execPath: '/node',
    });
}

describe('DshBridge.run', () => {
    it('resolves the final answer on a successful run', async () => {
        const spawnFn = makeFakeSpawn('ok');
        const bridge = makeBridge(spawnFn);
        const res = await bridge.run('say hi', { script: '/dsh/bin.js', workspace: '/w' });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.answer, 'All tests pass.');
        assert.strictEqual(res.exitCode, 0);
        assert.strictEqual(res.error, null);
        assert.strictEqual(spawnFn.calls[0].options.cwd, '/w');
    });

    it('rejects an empty or whitespace task without spawning', async () => {
        const spawnFn = makeFakeSpawn('ok');
        const bridge = makeBridge(spawnFn);
        const res = await bridge.run('   ');
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.error, 'empty_task');
        assert.strictEqual(spawnFn.calls.length, 0);
    });

    it('reports a non-zero exit with the stderr diagnostic', async () => {
        const bridge = makeBridge(makeFakeSpawn('fail'));
        const res = await bridge.run('do work', { script: '/dsh/bin.js' });
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.exitCode, 1);
        assert.match(res.error, /model unavailable/);
        assert.ok(!res.error.includes('    at foo'), 'stack frames are filtered out');
    });

    it('treats an empty answer as a failure', async () => {
        const bridge = makeBridge(makeFakeSpawn('empty'));
        const res = await bridge.run('do work', { script: '/dsh/bin.js' });
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.error, 'empty_answer');
    });

    it('surfaces spawn errors', async () => {
        const bridge = makeBridge(makeFakeSpawn('spawn-error'));
        const res = await bridge.run('do work', { script: '/dsh/bin.js' });
        assert.strictEqual(res.ok, false);
        assert.match(res.error, /ENOENT/);
    });

    it('times out and reports timeout', async () => {
        const bridge = makeBridge(makeFakeSpawn('hang'));
        const res = await bridge.run('slow work', { script: '/dsh/bin.js', timeoutMs: 20 });
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.error, 'timeout');
    });

    it('refuses a second task while one is running', async () => {
        const bridge = makeBridge(makeFakeSpawn('hang'));
        const first = bridge.run('first', { script: '/dsh/bin.js', timeoutMs: 30 });
        assert.strictEqual(bridge.isRunning(), true);
        const second = await bridge.run('second', { script: '/dsh/bin.js' });
        assert.strictEqual(second.ok, false);
        assert.strictEqual(second.error, 'busy');
        const firstResult = await first;
        assert.strictEqual(firstResult.error, 'timeout');
    });

    it('emits output and done events', async () => {
        const bridge = makeBridge(makeFakeSpawn('ok'));
        const chunks = [];
        let done = null;
        bridge.on('output', (p) => chunks.push(p.text));
        bridge.on('done', (p) => { done = p; });
        await bridge.run('stream', { script: '/dsh/bin.js' });
        assert.ok(chunks.join('').includes('All tests pass.'));
        assert.strictEqual(done.ok, true);
    });

    it('cancel returns false when nothing is running', () => {
        const bridge = makeBridge(makeFakeSpawn('ok'));
        assert.strictEqual(bridge.cancel(), false);
    });

    it('reports status transitions', async () => {
        const bridge = makeBridge(makeFakeSpawn('hang'));
        assert.strictEqual(bridge.status().running, false);
        const p = bridge.run('work', { script: '/dsh/bin.js', timeoutMs: 20 });
        assert.strictEqual(bridge.status().running, true);
        assert.strictEqual(bridge.status().task, 'work');
        await p;
        assert.strictEqual(bridge.status().running, false);
    });
});

describe('DshBridge.availability', () => {
    it('reports availability through the injected fs', () => {
        const bridge = new DshBridge({
            env: {}, platform: 'linux',
            fs: { existsSync: (p) => p === '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js' },
        });
        const a = bridge.availability();
        assert.strictEqual(a.available, true);
        assert.strictEqual(a.via, 'script');
    });

    it('falls back to the path strategy when nothing is found', () => {
        const bridge = new DshBridge({ env: {}, platform: 'linux', fs: { existsSync: () => false } });
        const a = bridge.availability();
        assert.strictEqual(a.available, false);
        assert.strictEqual(a.via, 'path');
    });
});

describe('module constants', () => {
    it('exposes sane defaults', () => {
        assert.strictEqual(DEFAULT_PROFILE, 'headless');
        assert.ok(DEFAULT_TIMEOUT_MS >= 60000);
    });
});
