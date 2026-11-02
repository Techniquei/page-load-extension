const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const config = (ready = { kind: 'mark', value: 'ready' }) => ({
    scope: 'module', name: 'Module', codePatterns: ['/module/'], resourcePatterns: [], ready,
});

async function browser(savedConfig = config()) {
    let now = 0;
    let nextId = 0;
    let listener;
    const timers = new Map();
    const observers = [];
    const messages = [];
    const elements = [];
    const handlers = new Map();
    const location = { href: 'https://example.com/start', origin: 'https://example.com' };
    const timer = (fn, delay, interval = false) => {
        const id = ++nextId;
        timers.set(id, { fn, at: now + delay, delay, interval });
        return id;
    };
    const context = vm.createContext({
        URL, console, crypto: { randomUUID }, location,
        performance: { timeOrigin: 100000, now: () => now, getEntriesByType: () => [] },
        document: { querySelector: () => elements[0], querySelectorAll: () => elements,
            addEventListener: (type, fn) => handlers.set(type, fn),
            removeEventListener: (type, fn) => { if (handlers.get(type) === fn) handlers.delete(type); } },
        getComputedStyle: (element) => ({ visibility: element.visible ? 'visible' : 'hidden' }),
        window: { addEventListener() {} },
        setTimeout: (fn, delay) => timer(fn, delay), clearTimeout: (id) => timers.delete(id),
        setInterval: (fn, delay) => timer(fn, delay, true), clearInterval: (id) => timers.delete(id),
        PerformanceObserver: class {
            static supportedEntryTypes = ['resource', 'mark', 'longtask', 'largest-contentful-paint'];
            constructor(callback) { this.callback = callback; observers.push(this); }
            observe({ type }) { this.type = type; this.connected = true; }
            disconnect() { this.connected = false; }
            takeRecords() { return []; }
        },
        chrome: {
            runtime: { id: 'extension', onMessage: { addListener: (fn) => { listener = fn; } },
                sendMessage: (message, callback) => { messages.push(structuredClone(message)); callback(); } },
            storage: { local: { get: async () => savedConfig ? { 'page-load-config:https://example.com': savedConfig } : {} } },
        },
    });
    for (const file of ['measurement.js', 'content.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
    await Promise.resolve();
    await Promise.resolve();
    return {
        elements, observers, timers, messages, location, handlers,
        action(type, options = {}) {
            handlers.get(type)?.({ type, isTrusted: true, timeStamp: now, button: 0, key: 'Enter', repeat: false,
                target: { nodeType: 1, closest: () => true }, ...options });
        },
        command(type, extra = {}) {
            let response;
            listener({ source: 'page-load-extension', type, ...extra }, { id: 'extension' }, (value) => { response = value; });
            return structuredClone(response);
        },
        emit(type, entries) {
            for (const observer of observers) if (observer.connected && observer.type === type) {
                observer.callback({ getEntries: () => entries });
            }
        },
        tick(duration) {
            const target = now + duration;
            while (true) {
                const due = [...timers].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                now = due[1].at;
                if (due[1].interval) due[1].at += due[1].delay;
                else timers.delete(due[0]);
                due[1].fn();
            }
            now = target;
        },
    };
}

const resource = (startTime) => ({ name: `https://example.com/module/${startTime}.js`, startTime,
    responseEnd: startTime + 50, duration: 50, decodedBodySize: 100, encodedBodySize: 70, transferSize: 100 });

test('a slow earlier module request sets the final origin without an intermediate guessed zero', async () => {
    const b = await browser();
    b.tick(25000);
    b.emit('resource', [resource(1000)]);
    b.emit('mark', [{ name: 'ready', startTime: 25000 }]);
    b.tick(2000);
    const report = b.command('page-get').state.report;
    assert.equal(report.status, 'complete');
    assert.equal(report.readyAt, 25000);
    assert.equal(report.rows[0].start, 1000);
    assert.equal(b.messages.filter((message) => message.report).length, 1);
});

test('manual SPA keeps the destination at readiness and the completed snapshot is immutable', async () => {
    const b = await browser(null);
    b.tick(1000);
    assert.equal(b.command('page-start', { config: config() }).state.phase, 'running');
    b.emit('mark', [{ name: 'ready', startTime: 500 }]);
    assert.equal(b.command('page-get').state.phase, 'running');
    b.tick(100);
    b.location.href = 'https://example.com/destination?x=1';
    b.emit('mark', [{ name: 'ready', startTime: 1100 }]);
    b.emit('resource', [resource(1050)]);
    b.location.href = 'https://example.com/after';
    b.tick(2000);
    const report = b.command('page-get').state.report;
    assert.equal(report.url, 'https://example.com/destination?x=1');
    assert.equal(report.startUrl, 'https://example.com/start');
    assert.equal(report.pathname, '/destination');
    const original = JSON.stringify(report);
    b.emit('resource', [resource(4000)]);
    b.tick(10000);
    assert.equal(JSON.stringify(b.command('page-get').state.report), original);
    assert.equal(b.timers.size, 0);
    assert.ok(b.observers.every((observer) => !observer.connected));
});

test('timeout leaves readiness unknown and stops collecting', async () => {
    const b = await browser();
    b.tick(120000);
    const report = b.command('page-get').state.report;
    assert.equal(report.status, 'timeout');
    assert.equal(report.readyAt, null);
    assert.equal(b.timers.size, 0);
});

test('manual measurement rejects an already visible selector', async () => {
    const b = await browser(null);
    b.elements.push({ visible: true, getClientRects: () => [{}] });
    const result = b.command('page-start', { config: config({ kind: 'selector', value: '#ready' }) });
    assert.match(result.error, /Селектор уже виден/);
    assert.equal(b.observers.length, 0);
});

test('selector detects a visible match after one hundred hidden matches', async () => {
    const b = await browser(config({ kind: 'selector', value: '.ready' }));
    for (let index = 0; index < 100; index++) b.elements.push({ visible: false, getClientRects: () => [{}] });
    b.elements.push({ visible: true, getClientRects: () => [{}] });
    b.tick(9);
    assert.equal(b.command('page-get').state.phase, 'running');
    b.tick(1);
    assert.equal(b.command('page-get').state.phase, 'settling');
    assert.equal(b.command('page-get').state.report, null);
    b.tick(2000);
    assert.equal(b.command('page-get').state.report.status, 'complete');
    assert.equal(b.command('page-get').state.report.readyAt, 10);
});

test('cancelling a measurement releases observers and timers', async () => {
    const b = await browser();
    b.tick(500);
    const report = b.command('page-cancel').state.report;
    assert.equal(report.status, 'cancelled');
    assert.equal(report.readyAt, null);
    assert.equal(b.timers.size, 0);
    assert.ok(b.observers.every((observer) => !observer.connected));
});

test('hitting the resource limit stops with an explicit incomplete result and bounded storage', async () => {
    const b = await browser();
    b.emit('resource', Array.from({ length: 5100 }, (_, index) => resource(index)));
    b.tick(0);
    const report = b.command('page-get').state.report;
    assert.equal(report.status, 'cancelled');
    assert.match(report.error, /лимит/);
    assert.equal(report.rows.length, 5000);
    assert.equal(b.timers.size, 0);
    assert.ok(b.observers.every((observer) => !observer.connected));
});


test('armed action starts at trusted event time rather than waiting time and ignores stale marks', async () => {
    const b = await browser(null);
    assert.equal(b.command('page-arm', { config: config() }).state.phase, 'armed');
    b.tick(5000);
    b.action('click', { isTrusted: false });
    b.action('click', { button: 1 });
    assert.equal(b.command('page-get').state.phase, 'armed');
    b.action('click', { timeStamp: 4998 });
    assert.equal(b.command('page-get').state.phase, 'running');
    b.emit('mark', [{ name: 'ready', startTime: 4997 }]);
    assert.equal(b.command('page-get').state.phase, 'running');
    b.emit('mark', [{ name: 'ready', startTime: 5001 }]);
    b.tick(2000);
    const report = b.command('page-get').state.report;
    assert.equal(report.startedAt, 4998);
    assert.deepEqual(report.action, { type: 'click' });
});

test('action selector and keyboard rules filter events', async () => {
    const b = await browser(null);
    const cfg = { ...config(), actionSelector: '  .trigger  ' };
    b.command('page-arm', { config: cfg });
    b.action('click', { target: { nodeType: 1, closest: () => null } });
    b.action('keydown', { key: 'Escape' });
    b.action('keydown', { key: 'Enter', repeat: true });
    assert.equal(b.command('page-get').state.phase, 'armed');
    b.action('keydown', { key: ' ' });
    b.emit('mark', [{ name: 'ready', startTime: 1 }]);
    b.tick(2000);
    const report = b.command('page-get').state.report;
    assert.equal(report.config.actionSelector, '.trigger');
    assert.deepEqual(report.action, { type: 'keydown', key: ' ' });
    const c = await browser(null);
    c.command('page-arm', { config: cfg });
    c.action('keydown', { key: 'Enter' });
    c.emit('mark', [{ name: 'ready', startTime: 1 }]);
    c.tick(2000);
    assert.equal(c.command('page-get').state.report.action.key, 'Enter');
});

test('cancel and timeout while armed leave previous report untouched and detach listeners', async () => {
    const b = await browser();
    b.emit('mark', [{ name: 'ready', startTime: 0 }]);
    b.tick(2000);
    const previous = b.command('page-get').state.report;
    b.command('page-arm', { config: config() });
    const cancelled = b.command('page-cancel').state;
    assert.deepEqual(cancelled.report, previous);
    assert.equal(b.handlers.size, 0);
    b.command('page-arm', { config: config() });
    b.tick(120000);
    const timedOut = b.command('page-get').state;
    assert.deepEqual(timedOut.report, previous);
    assert.match(timedOut.error, /действие не выполнено/);
    assert.equal(b.handlers.size, 0);
    assert.equal(b.timers.size, 0);
});

test('existing ready element needs disappearance or replacement after the action', async () => {
    for (const change of ['hide-show', 'replace']) {
        const b = await browser(null);
        const element = { visible: true, getClientRects: () => [{}] };
        b.elements.push(element);
        b.command('page-arm', { config: config({ kind: 'selector', value: '#ready' }) });
        b.action('click');
        b.tick(300);
        assert.equal(b.command('page-get').state.phase, 'running');
        if (change === 'hide-show') {
            element.visible = false;
            b.tick(100);
            element.visible = true;
        } else b.elements.splice(0, 1, { visible: true, getClientRects: () => [{}] });
        b.tick(100);
        assert.equal(b.command('page-get').state.phase, 'settling');
        b.tick(2000);
        assert.equal(b.command('page-get').state.report.status, 'complete');
    }
});

test('unchanged existing ready element ends with explicit timeout', async () => {
    const b = await browser(null);
    b.elements.push({ visible: true, getClientRects: () => [{}] });
    b.command('page-arm', { config: config({ kind: 'selector', value: '#ready' }) });
    b.action('click');
    b.tick(120000);
    const report = b.command('page-get').state.report;
    assert.equal(report.status, 'timeout');
    assert.match(report.error, /не скрылся и не изменился/);
});

test('LCP captures its own element selector independently of the readiness condition', async () => {
    const b = await browser();
    b.elements.push({ tagName: 'IMG', parentElement: null });
    b.emit('largest-contentful-paint', [{ startTime: 450, element: b.elements[0], url: 'https://example.com/hero.png' }]);
    b.tick(1000);
    b.emit('mark', [{ name: 'ready', startTime: 1000 }]);
    b.tick(2000);
    const { lcp } = b.command('page-get').state.report;
    assert.equal(lcp.at, 450);
    assert.equal(lcp.selector, 'img');
    assert.equal(lcp.url, 'https://example.com/hero.png');
});

test('LCP without an exposed DOM element leaves the selector unknown', async () => {
    const b = await browser();
    b.emit('largest-contentful-paint', [{ startTime: 300, element: null }]);
    b.emit('mark', [{ name: 'ready', startTime: 500 }]);
    b.tick(2000);
    assert.equal(b.command('page-get').state.report.lcp.selector, '');
});
