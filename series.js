/* A series keeps only scalar snapshots, not full request lists. */
const LoadSeries = (() => {
    const copy = (value) => JSON.parse(JSON.stringify(value));
    const target = 10;
    const duration = (value) => Number.isFinite(value) ? value : null;
    const summarize = (samples) => {
        const aggregate = (getValue, getCoverage) => {
            const values = samples.map(getValue).filter(Number.isFinite);
            return {
                mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
                min: values.length ? Math.min(...values) : null,
                max: values.length ? Math.max(...values) : null,
                known: values.length,
                total: samples.length,
                lowerBound: getCoverage ? samples.some(getCoverage) : false,
            };
        };
        const traffic = (key) => aggregate((sample) => sample[key]?.encodedBytes,
            (sample) => sample[key] && sample[key].encodedKnown < sample[key].files);
        return {
            readyMs: aggregate((sample) => sample.readyMs),
            firstFileMs: aggregate((sample) => sample.firstFileMs),
            moduleMs: aggregate((sample) => sample.moduleMs),
            lcpMs: aggregate((sample) => sample.lcpMs),
            trafficBytes: traffic('traffic'), moduleTrafficBytes: traffic('moduleTraffic'), codeBytes: traffic('code'),
        };
    };
    const create = ({ getHar, reload, onChange, onSample = () => {} }) => {
        let state = { running: false, samples: [], target, error: '', url: '', config: null };
        let generation = 0, timer = null, pending = false;
        let seenIds = new Set(), seenOrigins = new Set();
        const notify = () => onChange(copy(state));
        const clearDeadline = () => { if (timer !== null) clearTimeout(timer); timer = null; };
        const stop = (error = '') => {
            generation += 1;
            clearDeadline();
            pending = false;
            state.running = false;
            state.error = error;
            notify();
        };
        const next = async (token) => {
            clearDeadline();
            timer = setTimeout(() => {
                if (state.running && token === generation) stop('Истекло время ожидания измерения в серии');
            }, 140000);
            try { await reload(); }
            catch (error) {
                if (token === generation && state.running) stop(`Не удалось обновить страницу: ${error?.message || error}`);
                throw error;
            }
        };
        const start = async ({ url, config, ignoreTimeOrigin } = {}) => {
            if (state.running) throw new Error('Серия уже запущена');
            if (typeof url !== 'string' || !url) throw new Error('Не указан URL страницы');
            const normalized = LoadMeasurement.normalizeConfig(config);
            const token = ++generation;
            seenIds = new Set();
            seenOrigins = new Set(Number.isFinite(ignoreTimeOrigin) ? [ignoreTimeOrigin] : []);
            pending = false;
            state = { running: true, samples: [], target, error: '', url, config: copy(normalized) };
            notify();
            await next(token);
        };
        const accept = async (report) => {
            if (!state.running || !report) return;
            if (seenIds.has(report.id) || seenOrigins.has(report.timeOrigin)) return;
            if (report.url !== state.url) { stop('Страница изменилась: URL не совпадает с началом серии'); return; }
            let normalized;
            try { normalized = LoadMeasurement.normalizeConfig(report.config); }
            catch { stop('Конфигурация измерения в серии изменилась или некорректна'); return; }
            if (JSON.stringify(normalized) !== JSON.stringify(state.config)) { stop('Конфигурация измерения в серии изменилась'); return; }
            if (!['navigate', 'reload'].includes(report.mode)) { stop('В серии получен ручной замер вместо обновления страницы'); return; }
            if (report.status !== 'complete' || !Number.isFinite(report.readyAt)) { stop(report.error || 'Измерение серии не завершилось успешно'); return; }
            if (typeof report.id !== 'string' || !report.id || !Number.isFinite(report.timeOrigin)) { stop('У измерения отсутствует идентификатор документа'); return; }
            if (pending) return;
            seenIds.add(report.id);
            seenOrigins.add(report.timeOrigin);
            pending = true;
            const token = generation;
            try {
                const entries = await getHar();
                if (token !== generation || !state.running) return;
                const model = LoadMeasurement.buildModel(report, entries);
                state.samples.push({
                    id: report.id, timeOrigin: report.timeOrigin, url: report.url,
                    readyMs: duration(report.readyAt - report.startedAt),
                    firstFileMs: model.moduleStart === null ? null : duration(model.moduleStart - model.start),
                    moduleMs: duration(model.moduleMs), lcpMs: duration(report.lcp?.at),
                    lcpSelector: report.lcp?.selector || null,
                    moduleTrafficIsCode: model.targetSummary.files > 0 && model.targetSummary.files === model.codeSummary.files,
                    traffic: copy(model.summary), moduleTraffic: copy(model.targetSummary), code: copy(model.codeSummary),
                });
                onSample(model);
                clearDeadline();
                pending = false;
                if (state.samples.length >= target) { stop(); return; }
                notify();
                await next(token);
            } catch (error) {
                if (token === generation && state.running) stop(`Не удалось завершить измерение серии: ${error?.message || error}`);
            }
        };
        return { start, accept, cancel: (reason = '') => { if (state.running) stop(reason); }, get state() { return copy(state); } };
    };
    return { create, summarize };
})();
