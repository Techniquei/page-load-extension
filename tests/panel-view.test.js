const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function render(report, model, options = {}) {
    const nodes = Object.fromEntries(['results', 'dashboard', 'seriesResults'].map((id) => [id, {}]));
    const context = {
        document: { getElementById: (id) => nodes[id] },
        LoadMeasurement: {
            buildModel: (current) => ({ ...model, report: current }), findings: () => [],
            shortName: (url) => url, stackFrames: () => [],
        },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'panel-view.js'), 'utf8') + '\nthis.view = LoadView;', context);
    context.view.render(report, [], options);
    return { html: nodes.results.innerHTML };
}

const baseReport = {
    startedAt: 100, readyAt: 300, finishedAt: 500, mode: 'manual', status: 'complete',
    config: { name: 'Test', scope: 'module', ready: { kind: 'mark', value: 'ready' } },
};
const summary = { encodedBytes: 0, encodedKnown: 0, files: 0, cachedFiles: 0, decodedBytes: 0, decodedKnown: 0 };
const beforeRow = { id: 2, name: 'before', type: 'code', owner: { id: 'target', title: 'Модуль' }, beforeReady: true, start: 150, end: 160 };
const baseModel = { start: 100, end: 300, moduleStart: 150, rows: [beforeRow], duplicates: [], summary, targetSummary: summary, codeSummary: summary };

test('showing earlier requests restores manual marker positions relative to measurement start', () => {
    const { html } = render(baseReport, baseModel, { showBefore: true });
    assert.match(html, /Первый файл модуля: 50 мс/);
    assert.equal((html.match(/marker-module" style="left:25%/g) || []).length, 1);
    assert.match(html, /marker-ready" style="left:100%/);
    assert.doesNotMatch(html, /marker-lcp/);
});

test('LCP after readiness extends scale but does not reveal later requests', () => {
    const report = { ...baseReport, startedAt: 0, readyAt: 200, finishedAt: 400, mode: 'reload', lcp: { at: 300 } };
    const row = { id: 1, name: 'later', type: 'code', owner: { id: 'target' }, beforeReady: false, start: 250, end: 260 };
    const model = { ...baseModel, start: 0, end: 200, moduleStart: null, rows: [beforeRow, row] };
    const { html } = render(report, model);
    assert.match(html, /marker-ready" style="left:66\.666/);
    assert.match(html, /marker-lcp" style="left:100%/);
    assert.match(html, /продлена до LCP/);
    assert.doesNotMatch(html, /request-1/);
    const { html: expanded } = render(report, model, { showAfter: true });
    assert.match(expanded, /marker-lcp" style="left:75%/);
    assert.match(expanded, /marker-end" style="left:100%/);
    assert.match(expanded, /request-1/);
});

test('series summary and samples use the last measurement timeline', () => {
    const nodes = Object.fromEntries(['results', 'dashboard', 'seriesResults'].map((id) => [id, {}]));
    const context = vm.createContext({
        URL, document: { getElementById: (id) => nodes[id] },
    });
    for (const file of ['measurement.js', 'series.js', 'panel-view.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
    }
    vm.runInContext('this.view = LoadView;', context);
    const config = { scope: 'page', name: 'Страница', codePatterns: [], resourcePatterns: [], ready: { kind: 'mark', value: 'ready' } };
    const main = { ...baseReport, config, mode: 'reload', timeOrigin: 100000, origin: 'https://example.com', url: 'https://example.com', startedAt: 0, readyAt: 200, finishedAt: 500, lcp: { at: 300 }, rows: [] };
    context.view.render(main, [], {});
    assert.match(nodes.dashboard.innerHTML, /200 мс/);
    assert.match(nodes.dashboard.innerHTML, /300 мс/);
    assert.match(nodes.results.innerHTML, /LCP: 300 мс/);

    const series = { config, url: main.url, samples: [{ readyMs: 123, lcpMs: 234 }] };
    context.view.render(main, [], {}, series);
    assert.equal(nodes.seriesResults.hidden, false);
    assert.match(nodes.dashboard.innerHTML, /123 мс/);
    assert.match(nodes.seriesResults.innerHTML, /Замеры серии/);
    assert.match(nodes.results.innerHTML, /LCP: 300 мс/);
});

test('refined sources use their own requests and clock while preserving dashboard and series', () => {
    const nodes = Object.fromEntries(['results', 'dashboard', 'seriesResults'].map((id) => [id, {}]));
    const context = vm.createContext({ URL, document: { getElementById: (id) => nodes[id] } });
    for (const file of ['measurement.js', 'series.js', 'panel-view.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
    }
    const view = vm.runInContext('LoadView', context);
    const config = { scope: 'module', name: 'Brands', codePatterns: ['/brands/'], resourcePatterns: [], ready: { kind: 'selector', value: '#ready' } };
    const main = { ...baseReport, config, mode: 'reload', timeOrigin: 100000, origin: 'https://example.com', url: 'https://example.com/', startedAt: 0, readyAt: 200, finishedAt: 500, lcp: { at: 300 }, rows: [] };
    const sources = { ...main, timeOrigin: 200000, readyAt: 500, finishedAt: 800, lcp: { at: 700 },
        rows: [{ url: 'https://example.com/api/data', start: 10, end: 20, dur: 10, initiatorType: 'fetch',
            initiator: { stack: { callFrames: [{ url: 'webpack-internal:///42', ownerUrl: 'https://example.com/brands/chunk.js' }] } } }] };
    view.render(main, [], {});
    const dashboard = nodes.dashboard.innerHTML;
    const selected = view.render(main, [], {}, null, sources);
    assert.equal(nodes.dashboard.innerHTML, dashboard);
    assert.equal(selected.model.report.timeOrigin, sources.timeOrigin);
    assert.equal(selected.model.rows[0].owner.id, 'target');
    assert.match(nodes.results.innerHTML, /LCP: 700 мс/);
    assert.match(nodes.results.innerHTML, /Уточнённые запросы из отдельного прогона/);
    assert.doesNotMatch(nodes.results.innerHTML, /Запись главного потока/);

    const series = { config, url: main.url, samples: [{ readyMs: 123, lcpMs: 234 }] };
    view.render(main, [], {}, series);
    const average = nodes.dashboard.innerHTML;
    const samples = nodes.seriesResults.innerHTML;
    view.render(main, [], {}, series, sources);
    assert.equal(nodes.dashboard.innerHTML, average);
    assert.equal(nodes.seriesResults.innerHTML, samples);
});
