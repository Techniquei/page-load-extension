const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const config = { scope: 'module', name: 'Brands', codePatterns: ['/brands/'], resourcePatterns: [], ready: { kind: 'selector', value: '#ready' } };
const report = (timeOrigin = 100000) => ({ version: 1, id: String(timeOrigin), timeOrigin,
    url: 'https://example.com/', origin: 'https://example.com', pathname: '/',
    status: 'complete', mode: 'reload', config, startedAt: 0, readyAt: 500, finishedAt: 2500,
    diagnostics: { tasks: [] }, rows: [] });
const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup(options = {}) {
    const data = new Map(), session = {}, messages = [], commands = [], timers = new Map();
    let event, detach, connect, message, attached = false, attachAttempts = 0, nextTimer = 0;
    const db = { createObjectStore() {}, close() {}, transaction() {
        const tx = { objectStore() { return {
            get(key) { return { result: structuredClone(data.get(key)) }; },
            put(value, key) { data.set(key, structuredClone(value)); return {}; },
            delete(key) { data.delete(key); return {}; },
        }; } };
        queueMicrotask(() => tx.oncomplete());
        return tx;
    } };
    const context = vm.createContext({
        URL, Date, structuredClone, atob, crypto: { randomUUID },
        setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        indexedDB: { open() { const request = {}; queueMicrotask(() => { request.result = db; request.onupgradeneeded(); request.onsuccess(); }); return request; }, deleteDatabase() { data.clear(); } },
        chrome: {
            permissions: { contains: async () => true },
            tabs: { get: async () => ({ url: 'https://example.com/' }), onRemoved: { addListener() {} } },
            storage: { session: {
                async set(value) { Object.assign(session, structuredClone(value)); },
                async get(key) { return { [key]: structuredClone(session[key]) }; },
                async remove(key) { delete session[key]; },
            } },
            debugger: {
                onEvent: { addListener(fn) { event = fn; } }, onDetach: { addListener(fn) { detach = fn; } },
                async attach() {
                    if (options.wait && attachAttempts++ === 0) throw new Error('Another debugger is already attached');
                    if (options.attach) await options.attach();
                    attached = true;
                },
                async detach() { attached = false; detach({ tabId: 7 }); },
                async sendCommand(target, command, params) {
                    commands.push({ command, params });
                    if (command === 'Debugger.getStackTrace') {
                        if (options.resolveStack) return options.resolveStack(params);
                        return { stackTrace: { callFrames: [{ scriptId: 'brands', url: 'webpack-internal:///42', functionName: 'loadBrands', lineNumber: 1, columnNumber: 2 }] } };
                    }
                    return {};
                },
            },
            runtime: { id: 'extension', getURL: (file) => `chrome-extension://extension/${file}`,
                sendMessage: async (value) => { messages.push(structuredClone(value)); },
                onMessage: { addListener(fn) { message = fn; } }, onConnect: { addListener(fn) { connect = fn; } },
                onStartup: { addListener() {} }, onInstalled: { addListener() {} },
            },
        },
    });
    for (const file of ['measurement.js', 'sources.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
    const api = vm.runInContext('({ startSources, readSources, cancelSources, clearSources, acceptSourcesReport, buildModel: LoadMeasurement.buildModel })', context);
    return { api, data, session, messages, commands, timers, get attached() { return attached; },
        emit(method, params) { event({ tabId: 7 }, method, params); },
        closeDevtools() { let disconnect; connect({ sender: { id: 'extension' }, name: 'page-load-devtools:7', onDisconnect: { addListener(fn) { disconnect = fn; } } }); disconnect(); },
        async finish(value) { await api.acceptSourcesReport({ report: value }, { tab: { id: 7 }, frameId: 0 }); },
        send(value, sender) { let reply; const result = message(value, sender, (response) => { reply = response; }); return { result, get reply() { return reply; } }; },
    };
}

function request(env, id, url, start = 200010, initiator = { type: 'script', stack: { callFrames: [{ url: 'https://example.com/shared.js' }], parentId: { id: 'async' } } }) {
    env.emit('Network.requestWillBeSent', { requestId: id, wallTime: start / 1000, timestamp: start / 1000,
        type: 'Fetch', request: { url, method: 'GET' }, initiator });
}
function response(env, id, start = 200010) {
    env.emit('Network.responseReceived', { requestId: id, type: 'Fetch', response: { status: 200, mimeType: 'application/json', protocol: 'h2', headers: { 'Content-Length': '70' } } });
    env.emit('Network.loadingFinished', { requestId: id, timestamp: (start + 20) / 1000 });
}
function parsed(env) {
    env.emit('Debugger.scriptParsed', { scriptId: 'brands', url: 'webpack-internal:///42', stackTrace: { callFrames: [{ url: 'https://example.com/brands/chunk.js' }] } });
}

test('async initiator and webpack chunk ownership refine requests without CPU profiling', async () => {
    const env = setup(), baseline = report(), captured = report(200000);
    const url = 'https://example.com/api/brands';
    captured.rows = [{ url, start: 10, end: 30, dur: 20, encodedBytes: 70, bytes: 200, initiatorType: 'fetch' }];
    assert.equal(env.api.buildModel(captured).rows[0].owner.id, 'unknown');
    await env.api.startSources(7, baseline); await settle();
    parsed(env); request(env, '1', url); response(env, '1');
    await env.finish(captured);
    const state = await env.api.readSources(7);
    assert.equal(state.phase, 'done');
    assert.equal(state.report.rows[0].owner.id, 'target');
    assert.equal(state.report.rows[0].attribution, 'stack');
    assert.equal(state.report.rows[0].initiator.stack.callFrames[1].ownerUrl, 'https://example.com/brands/chunk.js');
    assert.equal(state.report.timeOrigin, 200000);
    assert.deepEqual(structuredClone(state.baseline), baseline);
    assert.equal(env.attached, false);
    assert.equal(env.timers.size, 0);
    assert.ok(env.commands.some(({ command }) => command === 'Debugger.setAsyncCallStackDepth'));
    assert.ok(env.commands.every(({ command }) => !/Tracing|Profiler/.test(command)));
});

test('repeated URLs match one-to-one; missing stack data stays unknown', async () => {
    const env = setup({ resolveStack: async () => { throw new Error('Stack unavailable'); } });
    await env.api.startSources(7, report()); await settle();
    const url = 'https://example.com/api/repeat';
    request(env, '1', url, 200010, { type: 'script', stack: { callFrames: [{ url: 'https://example.com/brands/chunk.js' }] } }); response(env, '1', 200010);
    request(env, '2', url, 200200); response(env, '2', 200200);
    const captured = report(200000);
    captured.rows = [10, 200].map((start) => ({ url, start, end: start + 20, dur: 20, initiatorType: 'fetch' }));
    await env.finish(captured);
    const state = await env.api.readSources(7);
    assert.equal(state.report.rows.length, 2);
    assert.equal(state.report.rows[0].owner.id, 'target');
    assert.equal(state.report.rows[1].owner.id, 'unknown');
});

test('a failed response cannot turn Content-Length into observed traffic', async () => {
    const env = setup(); await env.api.startSources(7, report()); await settle();
    const url = 'https://example.com/api/failed';
    request(env, '1', url);
    env.emit('Network.responseReceived', { requestId: '1', response: { status: 200, headers: { 'Content-Length': '9000' } } });
    env.emit('Network.loadingFailed', { requestId: '1', errorText: 'net::ERR_CONNECTION_RESET' });
    const captured = report(200000);
    captured.rows = [{ url, start: 10, end: 30, dur: 20, initiatorType: 'fetch', encodedBytes: null, bytes: null }];
    await env.finish(captured);
    const state = await env.api.readSources(7);
    assert.equal(state.report.rows[0].encodedBytes, null);
});

test('cancelling while resolving stacks cannot restore a cleared report', async () => {
    let resolveStack;
    const env = setup({ resolveStack: () => new Promise((resolve) => { resolveStack = resolve; }) });
    await env.api.startSources(7, report()); await settle();
    request(env, '1', 'https://example.com/api/brands'); response(env, '1');
    const finishing = env.finish(report(200000)); await settle();
    assert.equal(typeof resolveStack, 'function');
    await env.api.clearSources(7);
    resolveStack({ stackTrace: { callFrames: [] } }); await finishing;
    assert.equal(await env.api.readSources(7), null);
    assert.equal(env.data.size, 0);
    assert.equal(env.attached, false);
    assert.equal(env.timers.size, 0);
});

test('DevTools conflict waits for disconnect and resumes the extra reload', async () => {
    const env = setup({ wait: true });
    await env.api.startSources(7, report()); await settle();
    assert.equal((await env.api.readSources(7)).phase, 'waiting');
    assert.ok(!env.commands.some(({ command }) => command === 'Page.reload'));
    env.closeDevtools(); await settle();
    [...env.timers.values()].find(({ delay }) => delay === 500).fn(); await settle();
    assert.equal((await env.api.readSources(7)).phase, 'recording');
    assert.equal(env.commands.filter(({ command }) => command === 'Page.reload').length, 1);
    await env.api.cancelSources(7);
    assert.deepEqual(structuredClone((await env.api.readSources(7)).baseline), report());
    assert.equal(env.attached, false);
});

test('cancellation during attach detaches before allowing another run', async () => {
    let resolveAttach;
    const attaching = new Promise((resolve) => { resolveAttach = resolve; });
    const env = setup({ attach: () => attaching });
    await env.api.startSources(7, report()); await settle();
    const cancelling = env.api.cancelSources(7);
    await assert.rejects(env.api.startSources(7, report()), /уже выполняется/);
    resolveAttach();
    await cancelling; await settle();
    assert.equal(env.attached, false);
    assert.equal((await env.api.readSources(7)).phase, 'error');
    assert.ok(!env.commands.some(({ command }) => command === 'Page.reload'));
    assert.equal(env.timers.size, 0);
});

test('foreign document and incomplete readiness preserve the main report', async () => {
    for (const extra of [{ url: 'https://example.com/other' }, { status: 'timeout', readyAt: null }]) {
        const env = setup(); await env.api.startSources(7, report()); await settle();
        await env.finish({ ...report(200000), ...extra });
        const state = await env.api.readSources(7);
        assert.equal(state.phase, 'error');
        assert.deepEqual(structuredClone(state.baseline), report());
        assert.equal(state.report, null);
        assert.equal(env.attached, false);
        assert.equal(env.timers.size, 0);
    }
});

test('panel commands reject unrelated senders', async () => {
    const env = setup();
    const value = { source: 'page-load-extension', type: 'sources-start', tabId: 7, baseline: report() };
    assert.equal(env.send(value, { id: 'extension', tab: { id: 7 } }).result, undefined);
    assert.equal(env.send(value, { id: 'other', url: 'chrome-extension://extension/panel.html' }).result, undefined);
    assert.equal(env.send(value, { id: 'extension', url: 'chrome-extension://extension/panel.html.evil' }).result, undefined);
    assert.equal(env.commands.length, 0);
});
