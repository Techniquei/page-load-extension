const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const config = () => ({ scope: 'module', name: 'Модуль', codePatterns: ['/module/'], resourcePatterns: [], actionSelector: '', ready: { kind: 'mark', value: 'ready' } });
const report = (i, extra = {}) => ({ id: `id-${i}`, timeOrigin: i, url: 'https://example.com/', mode: 'reload', status: 'complete', config: config(), startedAt: 0, readyAt: 100, finishedAt: 120, rows: [], ...extra });
const setup = (overrides = {}) => {
    const timers = new Map(); let nextTimer = 0, reloads = 0;
    const context = vm.createContext({ URL, setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; }, clearTimeout: (id) => timers.delete(id) });
    for (const file of ['measurement.js', 'series.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
    const api = vm.runInContext('LoadSeries', context);
    const changes = [];
    const controller = api.create({ getHar: overrides.getHar || (async () => []), reload: overrides.reload || (async () => { reloads += 1; }), onChange: (state) => changes.push(state), onSample: overrides.onSample });
    return { api, controller, changes, timers, get reloads() { return reloads; } };
};
const begin = (controller) => controller.start({ url: 'https://example.com/', config: config(), ignoreTimeOrigin: 0 });

test('ten distinct measurements require exactly ten reloads; duplicates and old document are ignored', async () => {
    const env = setup(); await begin(env.controller);
    await env.controller.accept(report(0));
    assert.equal(env.controller.state.samples.length, 0);
    for (let i = 1; i <= 10; i++) {
        await env.controller.accept(report(i));
        await env.controller.accept(report(i));
    }
    assert.equal(env.reloads, 10);
    assert.equal(env.controller.state.samples.length, 10);
    assert.equal(env.controller.state.running, false);
    assert.equal(env.timers.size, 0);
    const snapshot = env.controller.state; snapshot.samples.pop();
    assert.equal(env.controller.state.samples.length, 10);
});

test('summary includes cached zero, skips unknowns and flags incomplete traffic coverage', () => {
    const { api } = setup();
    const samples = [
        { readyMs: 100, firstFileMs: null, traffic: { encodedBytes: 0, encodedKnown: 1, files: 1 } },
        { readyMs: 200, firstFileMs: 20, traffic: { encodedBytes: 100, encodedKnown: 1, files: 2 } },
        { readyMs: null, firstFileMs: null, traffic: { encodedBytes: null, encodedKnown: 0, files: 1 } },
    ];
    const result = api.summarize(samples);
    assert.equal(result.readyMs.mean, 150);
    assert.equal(result.readyMs.known, 2);
    assert.equal(result.firstFileMs.mean, 20);
    assert.equal(result.firstFileMs.total, 3);
    assert.equal(result.trafficBytes.mean, 50);
    assert.equal(result.trafficBytes.lowerBound, true);
});

test('cancelling during HAR collection discards the late result and never reloads again', async () => {
    let resolveHar; const committed = []; const env = setup({ onSample: (model) => committed.push(model), getHar: () => new Promise((resolve) => { resolveHar = resolve; }) });
    await begin(env.controller);
    const accepting = env.controller.accept(report(1));
    env.controller.cancel('Остановлено');
    resolveHar([]); await accepting;
    assert.equal(env.controller.state.samples.length, 0);
    assert.equal(committed.length, 0);
    assert.equal(env.controller.state.error, 'Остановлено');
    assert.equal(env.reloads, 1);
    assert.equal(env.timers.size, 0);
});

test('foreign URL, configuration and failed reports stop with partial results', async () => {
    const invalid = [report(2, { url: 'https://other.example/' }), report(2, { config: { ...config(), ready: { kind: 'mark', value: 'other' } } }), report(2, { status: 'timeout' }), report(2, { mode: 'manual' })];
    for (const next of invalid) {
        const env = setup(); await begin(env.controller); await env.controller.accept(report(1)); await env.controller.accept(next);
        assert.equal(env.controller.state.samples.length, 1);
        assert.equal(env.controller.state.running, false);
        assert.ok(env.controller.state.error);
        assert.equal(env.timers.size, 0);
    }
});

test('deadline stops series and clears the timer', async () => {
    const env = setup(); await begin(env.controller);
    const deadline = [...env.timers.values()][0];
    assert.equal(deadline.delay, 140000);
    deadline.fn();
    assert.equal(env.controller.state.running, false);
    assert.match(env.controller.state.error, /время ожидания/);
    assert.equal(env.timers.size, 0);
});


test('accepted samples freeze enriched requests and retain LCP selectors', async () => {
    const committed = [];
    const env = setup({ onSample: (model) => committed.push(model) });
    await begin(env.controller);
    await env.controller.accept(report(1, { origin: 'https://example.com', lcp: { at: 70, selector: '#hero' },
        rows: [{ url: 'https://example.com/module/main.js', start: 10, end: 20, encodedBytes: 100, bytes: 200 }] }));
    assert.equal(committed.length, 1);
    assert.equal(committed[0].rows[0].encodedBytes, 100);
    assert.equal(env.controller.state.samples[0].moduleTrafficIsCode, true);
    assert.equal(env.controller.state.samples[0].lcpSelector, '#hero');
    env.controller.cancel();
});
