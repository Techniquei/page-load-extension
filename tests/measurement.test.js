const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const context = vm.createContext({ URL });
vm.runInContext(`${fs.readFileSync(path.join(__dirname, '../measurement.js'), 'utf8')}\nthis.measurement = LoadMeasurement;`, context);
const m = context.measurement;
const config = () => ({ scope: 'module', name: 'Модуль', codePatterns: ['/module/'], resourcePatterns: [], ready: { kind: 'mark', value: 'ready' } });
const report = (rows, overrides = {}) => ({ version: 1, timeOrigin: 100000, origin: 'https://example.com', startedAt: 0, readyAt: 500, finishedAt: 700, status: 'complete', config: config(), rows, ...overrides });
const row = (url, start, extra = {}) => ({ url, start, end: start + 10, dur: 10, bytes: null, encodedBytes: null, ...extra });
const har = (url, start, extra = {}) => ({ startedDateTime: new Date(100000 + start).toISOString(), time: 10, request: { url, method: extra.method || 'GET' }, response: { status: extra.status || 200, bodySize: extra.bodySize ?? 10, content: { size: extra.decoded ?? 20 } }, ...(extra.cached ? { _fromCache: 'disk' } : {}) });

test('config trims and deduplicates URL fragments and rejects invalid conditions', () => {
    const result = m.normalizeConfig({ ...config(), name: '  модуль  ', codePatterns: [' /module/ ', '/module/'], ready: { kind: 'selector', value: ' #app ' } });
    assert.equal(result.name, 'модуль');
    assert.deepEqual(Array.from(result.codePatterns), ['/module/']);
    assert.equal(result.ready.value, '#app');
    for (const invalid of [{ ...config(), codePatterns: [] }, { ...config(), ready: { kind: 'mark', value: ' ' } }, { ...config(), scope: 'unknown' }, { ...config(), codePatterns: ['x'.repeat(501)] }, { ...config(), resourcePatterns: Array(31).fill('x') }]) assert.throws(() => m.normalizeConfig(invalid));
});

test('module starts at earliest request, independent of row order, and ignores code after readiness', () => {
    const result = m.buildModel(report([row('https://example.com/module/later.js', 200), row('https://example.com/module/first.js', 50)]));
    assert.equal(result.moduleStart, 50);
    assert.equal(result.moduleMs, 450);
    const late = m.buildModel(report([row('https://example.com/module/late.js', 600)]));
    assert.equal(late.moduleStart, null);
    assert.equal(late.moduleMs, null);
    const timeout = m.buildModel(report([row('https://example.com/module/a.js', 50)], { readyAt: null, status: 'timeout' }));
    assert.equal(timeout.moduleMs, null);
});

test('cached resources have zero network bytes while retaining known decoded sizes', () => {
    const model = m.buildModel(report([row('https://example.com/module/a.js', 10, { cached: true, bytes: 100 }), row('https://example.com/module/b.js', 20, { cached: true, bytes: 200 })]));
    assert.equal(model.summary.encodedBytes, 0);
    assert.equal(model.summary.encodedKnown, 2);
    assert.equal(model.summary.decodedBytes, 300);
    assert.equal(model.summary.decodedKnown, 2);
    assert.equal(model.summary.cachedFiles, 2);
});

test('304 does not replace a known decoded resource size with an empty HAR body', () => {
    const url = 'https://example.com/module/a.js';
    const model = m.buildModel(report([row(url, 10, { bytes: 1234 })]), [har(url, 10, { status: 304, decoded: 0, bodySize: 0 })]);
    assert.equal(model.rows[0].bytes, 1234);
    assert.equal(model.rows[0].encodedBytes, 0);
    assert.equal(model.rows[0].cached, true);
});

test('HAR matches repeated URLs one-to-one by nearest start and excludes previous document', () => {
    const url = 'https://example.com/module/a.js';
    const input = report([row(url, 300), row(url, 100)]);
    const entries = [har(url, -1, { decoded: 999 }), har(url, 105, { decoded: 101 }), har(url, 295, { decoded: 202 })];
    const before = JSON.stringify([input, entries]);
    const model = m.buildModel(input, entries);
    assert.deepEqual(Array.from(model.rows, (item) => item.bytes), [202, 101]);
    assert.equal(JSON.stringify([input, entries]), before);
});

test('duplicate groups distinguish methods and only include GET or HEAD', () => {
    const url = 'https://example.com/api';
    const entries = [har(url, 10), har(url, 20), har(url, 30, { method: 'POST' }), har(url, 40, { method: 'POST' })];
    const model = m.buildModel(report([]), entries);
    assert.equal(model.duplicates.length, 1);
    assert.equal(model.duplicates[0].key, `GET ${url}`);
    assert.equal(model.duplicates[0].rows.length, 2);
});

test('pending requests retain unknown end and duration', () => {
    const model = m.buildModel(report([row('https://example.com/module/a.js', 10, { end: null, dur: null })]));
    assert.equal(model.rows[0].end, null);
    assert.equal(model.rows[0].dur, null);
});

const sizedHar = (url, options = {}) => ({
    startedDateTime: new Date(100010).toISOString(),
    time: 10,
    request: { url, method: options.method || 'GET' },
    response: {
        status: options.status || 200,
        bodySize: options.bodySize ?? -1,
        headers: options.headers ?? [],
        content: { size: options.size ?? 1000, ...(options.compression === undefined ? {} : { compression: options.compression }) },
        ...(options.error ? { _error: options.error } : {}),
        ...(options.transferSize === undefined ? {} : { _transferSize: options.transferSize }),
    },
    ...(options.cached ? { _fromCache: 'disk' } : {}),
});
const sizeModel = (options = {}, resource = {}) => {
    const url = 'https://example.com/product/dev/dist/main.js';
    return m.buildModel(report([row(url, 10, resource)]), [sizedHar(url, options)]).rows[0];
};

test('HTTP/2 HAR uses case-insensitive Content-Length when bodySize is unknown', () => {
    const actual = sizeModel({ headers: [{ name: 'cOnTeNt-LeNgTh', value: '250' }, { name: 'CONTENT-ENCODING', value: 'br' }] });
    assert.equal(actual.encodedBytes, 250);
    assert.equal(actual.encodedSizeSource, 'content-length');
    assert.equal(actual.bytes, 1000);
});

test('observed Resource Timing encoded size takes precedence over Content-Length', () => {
    const actual = sizeModel({ headers: [{ name: 'Content-Length', value: '250' }, { name: 'Content-Encoding', value: 'br' }] }, { encodedBytes: 200 });
    assert.equal(actual.encodedBytes, 200);
});

test('HAR compression can derive a positive body size, including negative compression', () => {
    for (const [compression, encoded] of [[700, 300], [-100, 1100]]) {
        const actual = sizeModel({ headers: [{ name: 'Content-Encoding', value: 'br' }], compression });
        assert.equal(actual.encodedBytes, encoded);
        assert.equal(actual.encodedSizeSource, 'har-compression');
    }
});

test('HEAD, bodyless statuses, cached and 304 responses have zero transferred body', () => {
    const headers = [{ name: 'Content-Length', value: '1000' }, { name: 'Content-Encoding', value: 'br' }];
    for (const options of [{ method: 'HEAD' }, { status: 204 }, { status: 205 }, { status: 304 }, { cached: true }]) {
        assert.equal(sizeModel({ ...options, headers }).encodedBytes, 0, JSON.stringify(options));
    }
});

test('invalid, conflicting and chunked Content-Length values do not determine body size', () => {
    const encoding = { name: 'Content-Encoding', value: 'br' };
    for (const headers of [
        [encoding, { name: 'Content-Length', value: '-2' }],
        [encoding, { name: 'Content-Length', value: '12x' }],
        [encoding, { name: 'Content-Length', value: '100' }, { name: 'content-length', value: '200' }],
        [encoding, { name: 'Content-Length', value: '100' }, { name: 'tRaNsFeR-EnCoDiNg', value: 'chunked' }],
    ]) assert.equal(sizeModel({ headers }).encodedBytes, null, JSON.stringify(headers));
});

test('failed HAR responses do not derive a body size from metadata', () => {
    const cases = [
        { headers: [{ name: 'Content-Length', value: '250' }, { name: 'Content-Encoding', value: 'br' }] },
        { headers: [{ name: 'Content-Encoding', value: 'br' }], compression: 700 },
        { headers: [] },
    ];
    for (const options of cases) assert.equal(sizeModel({ ...options, error: 'net::ERR_FAILED' }).encodedBytes, null);
});

test('identity response can use decoded size, but transfer size does not stand in for compressed body', () => {
    const identity = sizeModel({ headers: [] });
    assert.equal(identity.encodedBytes, 1000);
    assert.equal(identity.encodedSizeSource, 'identity');
    const compressed = sizeModel({ headers: [{ name: 'Content-Encoding', value: 'br' }], transferSize: 1200 });
    assert.equal(compressed.encodedBytes, null);
});

test('HTTP/2 fallback covers remoteEntry and 24 module chunks', () => {
    const urls = ['https://example.com/product/dev/dist/remoteEntry.js', ...Array.from({ length: 24 }, (_, i) => `https://example.com/product/dev/dist/chunk-${i}.js`)];
    const input = report(urls.map((url, index) => row(url, 10 + index)), { config: { ...config(), codePatterns: ['/product/dev/dist/'] } });
    const entries = urls.map((url, index) => ({ ...sizedHar(url, { headers: [{ name: 'Content-Length', value: '250' }, { name: 'Content-Encoding', value: 'br' }] }), startedDateTime: new Date(100010 + index).toISOString() }));
    const model = m.buildModel(input, entries);
    assert.equal(model.codeSummary.files, 25);
    assert.equal(model.codeSummary.encodedKnown, 25);
    assert.equal(model.codeSummary.encodedBytes, 6250);
    assert.equal(model.targetSummary.encodedKnown, 25);
});
