/* Shared, side-effect-free measurement model. */
const LoadMeasurement = (() => {
    const defaultConfig = () => ({ scope: 'page', name: 'Страница', codePatterns: [], resourcePatterns: [], actionSelector: '', ready: { kind: 'selector', value: '' } });
    const normalizeConfig = (raw) => {
        if (!raw || typeof raw !== 'object') throw new Error('Некорректная конфигурация измерения');
        if (!['page', 'module'].includes(raw.scope)) throw new Error('Выберите область: страница или модуль');
        if (!raw.ready || !['selector', 'mark'].includes(raw.ready.kind)) throw new Error('Некорректный способ определения готовности');
        const name = typeof raw.name === 'string' ? raw.name.trim() : '';
        if (name.length > 80) throw new Error('Название должно содержать не более 80 символов');
        const value = typeof raw.ready.value === 'string' ? raw.ready.value.trim() : '';
        if (!value) throw new Error('Укажите условие готовности');
        if (value.length > 1000) throw new Error('Условие готовности должно содержать не более 1000 символов');
        const patterns = (items) => {
            if (!Array.isArray(items)) throw new Error('Шаблоны URL должны быть массивом строк');
            if (items.length > 30) throw new Error('Допустимо не более 30 шаблонов URL');
            const result = [];
            for (const item of items) {
                if (typeof item !== 'string') throw new Error('Шаблон URL должен быть строкой');
                const pattern = item.trim();
                if (pattern.length > 500) throw new Error('Шаблон URL должен содержать не более 500 символов');
                if (pattern && !result.includes(pattern)) result.push(pattern);
            }
            return result;
        };
        const actionSelector = typeof raw.actionSelector === 'string' ? raw.actionSelector.trim() : '';
        if (actionSelector.length > 1000) throw new Error('Селектор действия должен содержать не более 1000 символов');
        const codePatterns = patterns(raw.codePatterns);
        const resourcePatterns = patterns(raw.resourcePatterns);
        if (raw.scope === 'module' && !codePatterns.length) throw new Error('Укажите хотя бы один фрагмент URL кода модуля');
        return { scope: raw.scope, name: name || (raw.scope === 'page' ? 'Страница' : 'Модуль'), codePatterns, resourcePatterns, actionSelector, ready: { kind: raw.ready.kind, value } };
    };
    const parse = (url) => { try { return new URL(url); } catch { return null; } };
    const shortName = (rawUrl) => {
        const url = parse(rawUrl);
        if (!url) return rawUrl;
        const parts = url.pathname.split('/').filter(Boolean);
        const last = parts[parts.length - 1] || url.hostname;
        const name = last.includes('.') || parts.length < 2 ? last : parts.slice(-2).join('/');
        return name.length > 80 ? `${name.slice(0, 77)}...` : name;
    };
    const isCodeUrl = (url) => /\.(?:m?js|css)$/i.test(parse(url)?.pathname || '');
    const typeOf = (row = {}) => {
        const network = { script: 'code', stylesheet: 'code', fetch: 'data', xhr: 'data', image: 'image', media: 'image', font: 'font', document: 'document' };
        const type = network[String(row.resourceType || '').toLowerCase()];
        if (type) return type;
        const mime = String(row.mimeType || '').toLowerCase();
        if (/javascript|ecmascript|text\/css/.test(mime)) return 'code';
        if (/text\/html|application\/xhtml/.test(mime)) return 'document';
        if (/json|xml|text\/plain|protobuf/.test(mime)) return 'data';
        if (/^image\//.test(mime)) return 'image';
        if (/font|woff/.test(mime)) return 'font';
        const path = parse(row.url)?.pathname || '';
        if (isCodeUrl(row.url)) return 'code';
        if (/\.(woff2?|ttf|otf|eot)$/i.test(path)) return 'font';
        if (/\.(png|jpe?g|webp|avif|gif|svg|ico)$/i.test(path)) return 'image';
        const initiator = String(row.initiatorType || '').toLowerCase();
        if (['fetch', 'xmlhttprequest', 'xhr', 'beacon'].includes(initiator)) return 'data';
        if (['img', 'image'].includes(initiator)) return 'image';
        if (initiator === 'script') return 'code';
        if (['navigation', 'document'].includes(initiator)) return 'document';
        return 'other';
    };
    const stackFrames = (initiator) => {
        const frames = [], seen = new Set();
        for (let stack = initiator?.stack; stack && typeof stack === 'object' && !seen.has(stack) && frames.length < 100; stack = stack.parent) {
            seen.add(stack);
            if (Array.isArray(stack.callFrames)) frames.push(...stack.callFrames.slice(0, 100 - frames.length));
        }
        return frames;
    };
    const matches = (url, patterns) => typeof url === 'string' && Array.isArray(patterns) && patterns.some((pattern) => typeof pattern === 'string' && pattern && url.includes(pattern));
    const ownerOfUrl = (url, config = {}, pageOrigin) => {
        const parsed = parse(url);
        if (!parsed) return { id: 'unknown', title: 'Не определено' };
        if (parsed.protocol === 'chrome-extension:' || parsed.protocol === 'moz-extension:') return { id: 'extension', title: 'Расширение' };
        if (!['http:', 'https:'].includes(parsed.protocol)) return { id: 'unknown', title: 'Не определено' };
        if (config.scope === 'page') return { id: 'target', title: 'Страница' };
        if (matches(url, config.codePatterns)) return { id: 'target', title: config.name || 'Модуль' };
        return { id: 'other', title: parsed.origin === pageOrigin ? 'Страница' : 'Прочие ресурсы' };
    };
    const validSize = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const encodedSize = (entry, row, cached, complete) => {
        const response = entry.response || {};
        const result = (bytes, source) => ({ encodedBytes: bytes, encodedSizeSource: source });
        if (cached) return result(0, 'cache');
        if (String(entry.request?.method || row?.method).toUpperCase() === 'HEAD'
            || [204, 205].includes(response.status)) return result(0, 'no-body');
        const observed = validSize(response.bodySize) ?? validSize(row?.encodedBytes);
        if (observed !== null) return result(observed, validSize(response.bodySize) !== null ? 'har-body' : row?.encodedSizeSource || 'observed');
        // HAR может не содержать bodySize для HTTP/2. Метаданные пригодны только
        // для завершившегося ответа; _transferSize включает заголовки и здесь не используется.
        if (!complete || response._error || !(response.status >= 200)) return result(null, null);
        const decoded = validSize(response.content?.size) ?? validSize(row?.bytes);
        const compression = response.content?.compression;
        if (decoded !== null && Number.isFinite(compression) && decoded - compression >= 0) {
            return result(decoded - compression, 'har-compression');
        }
        if (!Array.isArray(response.headers)) return result(null, null);
        const values = (name) => response.headers
            .filter((header) => typeof header?.name === 'string' && header.name.toLowerCase() === name)
            .map((header) => typeof header.value === 'string' ? header.value.trim() : '');
        const lengths = values('content-length');
        if (!values('transfer-encoding').some((value) => /\bchunked\b/i.test(value))
            && lengths.length && lengths.every((value) => /^\d+$/.test(value) && value === lengths[0])) {
            const length = Number(lengths[0]);
            if (Number.isSafeInteger(length)) return result(length, 'content-length');
        }
        const encodings = values('content-encoding').filter(Boolean);
        if (decoded !== null && encodings.every((value) => value.toLowerCase() === 'identity')) {
            return result(decoded, 'identity');
        }
        return result(null, null);
    };
    const buildModel = (report, harEntries = []) => {
        const config = report.config || defaultConfig();
        const start = report.startedAt;
        const finish = report.finishedAt;
        const end = report.readyAt ?? finish;
        const entries = (Array.isArray(harEntries) ? harEntries : []).map((entry) => {
            if (!entry || typeof entry !== 'object' || typeof entry.request?.url !== 'string') return null;
            const time = Date.parse(entry.startedDateTime) - report.timeOrigin;
            if (!Number.isFinite(time) || time < start || time > finish) return null;
            return { entry, start: time, end: Number.isFinite(entry.time) && entry.time >= 0 ? time + entry.time : null, used: false };
        }).filter(Boolean);
        const entriesByUrl = new Map();
        for (const item of entries) {
            const url = item.entry.request.url;
            if (!entriesByUrl.has(url)) entriesByUrl.set(url, []);
            entriesByUrl.get(url).push(item);
        }
        const fromHar = (item, row) => {
            const entry = item.entry, response = entry.response || {};
            const cached = Boolean(row?.cached || entry._fromCache || entry._fromMemoryCache || entry._fromDiskCache || response.status === 304);
            const bytes = validSize(response.content?.size);
            const completedAt = row?.end ?? item.end;
            const size = encodedSize(entry, row, cached, Number.isFinite(completedAt) && completedAt <= finish);
            return {
                ...row, url: entry.request.url,
                bytes: cached && validSize(row?.bytes) > 0 ? row.bytes : (bytes ?? validSize(row?.bytes)), ...size, cached,
                resourceType: entry._resourceType || row?.resourceType, mimeType: response.content?.mimeType || row?.mimeType,
                initiator: entry._initiator || row?.initiator,
                network: { method: entry.request.method, status: response.status, protocol: response.httpVersion, timings: response.timings || entry.timings },
            };
        };
        const rawRows = [];
        for (const source of Array.isArray(report.rows) ? report.rows : []) {
            if (!source || typeof source.url !== 'string') continue;
            const rowStart = Number.isFinite(source.start) ? source.start : source.startedAt;
            if (!Number.isFinite(rowStart) || rowStart < start || rowStart > finish) continue;
            const method = typeof source.method === 'string' ? source.method.toUpperCase() : null;
            let best = null, gap = 101;
            for (const item of entriesByUrl.get(source.url) || []) {
                if (item.used || (method && method !== String(item.entry.request.method || 'GET').toUpperCase())) continue;
                const distance = Math.abs(item.start - rowStart);
                if (distance <= 100 && distance < gap) { best = item; gap = distance; }
            }
            const row = { ...source, start: rowStart, end: Number.isFinite(source.end) ? source.end : null, dur: Number.isFinite(source.dur) ? source.dur : null, bytes: validSize(source.bytes), encodedBytes: validSize(source.encodedBytes), cached: Boolean(source.cached) };
            if (best) { best.used = true; rawRows.push(fromHar(best, row)); } else rawRows.push(row);
        }
        for (const item of entries) {
            if (item.used || item.start < start || item.start > finish || item.end === null || item.end > finish) continue;
            rawRows.push(fromHar(item, { start: item.start, end: item.end, dur: item.end - item.start, name: shortName(item.entry.request.url), initiatorType: '' }));
        }
        const rows = rawRows.map((row, index) => {
            const type = typeOf(row);
            let owner = ownerOfUrl(row.url, config, report.origin), attribution = 'url';
            if (config.scope === 'module' && type !== 'code' && (owner.id === 'other' || owner.id === 'target')) {
                if (matches(row.url, config.resourcePatterns)) { owner = { id: 'target', title: config.name || 'Модуль' }; attribution = 'url'; }
                else if (stackFrames(row.initiator).some((frame) => matches(frame?.ownerUrl || frame?.url, config.codePatterns))) { owner = { id: 'target', title: config.name || 'Модуль' }; attribution = 'stack'; }
                else { owner = { id: 'unknown', title: 'Не определено' }; attribution = 'unknown'; }
            } else if (owner.id === 'unknown') attribution = 'unknown';
            else if (config.scope === 'page' && owner.id === 'target') attribution = 'page';
            return { ...row, id: index + 1, name: row.name || shortName(row.url), type, owner, attribution, beforeReady: row.start <= end };
        });
        const targetCode = rows.filter((row) => row.beforeReady && row.type === 'code' && row.owner.id === 'target');
        const moduleStart = config.scope === 'module' && targetCode.length ? Math.min(...targetCode.map((row) => row.start)) : null;
        const total = (items) => {
            const active = items.filter((row) => !row.cached);
            const encoded = items.filter((row) => row.cached || row.encodedBytes !== null);
            const decoded = items.filter((row) => row.bytes !== null);
            return { files: items.length, cachedFiles: items.length - active.length, encodedBytes: encoded.length ? encoded.reduce((sum, row) => sum + (row.cached ? 0 : row.encodedBytes), 0) : null, encodedKnown: encoded.length,
                declaredFiles: items.filter((row) => row.encodedSizeSource === 'content-length').length,
                decodedBytes: decoded.length ? decoded.reduce((sum, row) => sum + row.bytes, 0) : null, decodedKnown: decoded.length };
        };
        const windowRows = rows.filter((row) => row.beforeReady && row.owner.id !== 'extension');
        const groups = new Map();
        for (const row of windowRows) {
            const method = String(row.network?.method || row.method || '').toUpperCase();
            if (row.cached || !['GET', 'HEAD'].includes(method)) continue;
            const key = `${method} ${row.url}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(row);
        }
        const duplicates = Array.from(groups, ([key, items]) => ({ key, rows: items.map((row) => row.id) })).filter((group) => group.rows.length > 1);
        return { report, rows, start, end, moduleStart, moduleMs: moduleStart === null || report.readyAt == null || report.status !== 'complete' ? null : end - moduleStart, summary: total(windowRows), targetSummary: total(windowRows.filter((row) => row.owner.id === 'target')), codeSummary: total(windowRows.filter((row) => row.owner.id === 'target' && row.type === 'code')), duplicates };
    };
    const findings = (model) => {
        const result = [];
        const windowTitle = model.report.readyAt == null ? 'в снимке' : 'до готовности';
        for (const duplicate of model.duplicates) result.push({ id: `duplicate:${duplicate.key}`, title: 'Повторные запросы', text: `${duplicate.key}: ${duplicate.rows.length} запросов ${windowTitle}.`, rows: duplicate.rows });
        for (const row of model.rows.filter((item) => item.beforeReady && item.owner.id !== 'extension' && !item.cached && item.encodedBytes >= 500000).sort((a, b) => b.encodedBytes - a.encodedBytes)) result.push({ id: `large:${row.id}`, title: 'Большой файл', text: `${row.name}: ${row.encodedBytes} байт передано.`, rows: [row.id] });
        for (const row of model.rows.filter((item) => item.beforeReady && item.owner.id !== 'extension' && Number.isFinite(item.network?.timings?.wait) && item.network.timings.wait >= 1000).sort((a, b) => b.network.timings.wait - a.network.timings.wait)) result.push({ id: `wait:${row.id}`, title: 'Долгое ожидание сервера', text: `${row.name}: ожидание ${Math.round(row.network.timings.wait)} мс.`, rows: [row.id] });
        const unknown = model.rows.filter((row) => row.beforeReady && row.owner.id === 'unknown');
        if (unknown.length) result.push({ id: 'unknown', title: 'Не определён источник', text: `Не удалось определить принадлежность ${unknown.length} ресурсов.`, rows: unknown.map((row) => row.id) });
        return result.slice(0, 8);
    };
    return { defaultConfig, normalizeConfig, shortName, isCodeUrl, typeOf, stackFrames, ownerOfUrl, buildModel, findings };
})();
