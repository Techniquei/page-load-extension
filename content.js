(() => {
    const SOURCE = 'page-load-extension';
    const LIMIT = 5000;
    const TIMEOUT_MS = 120000;
    const TAIL_MS = 2000;
    const key = `page-load-config:${location.origin}`;
    let run = null;
    let lastReport = null;
    let error = '';

    const state = () => ({ url: location.href, timeOrigin: performance.timeOrigin,
        phase: run?.phase || (lastReport ? 'done' : 'idle'), report: lastReport, error });
    const send = (payload) => {
        try { chrome.runtime.sendMessage({ source: SOURCE, ...payload }, () => { void chrome.runtime.lastError; }); }
        catch { stop(); }
    };
    const stop = () => {
        if (!run) return;
        for (const observer of run.observers || []) observer.disconnect();
        if (run.actionHandler) {
            document.removeEventListener('click', run.actionHandler, true);
            document.removeEventListener('keydown', run.actionHandler, true);
        }
        run.mutationObserver?.disconnect();
        clearInterval(run.poll);
        clearTimeout(run.deadline);
        clearTimeout(run.tail);
        clearTimeout(run.limitTimer);
        run = null;
    };
    // Capture the actual LCP node while it is still attached to the document.
    const elementSelector = (element) => {
        if (!element?.tagName || (element.getRootNode && element.getRootNode() !== document)) return '';
        const parts = [];
        const escape = globalThis.CSS?.escape;
        for (let node = element; node?.tagName; node = node.parentElement) {
            const tag = node.tagName.toLowerCase();
            let part = tag;
            if (escape && node.id && document.querySelectorAll(`#${escape(node.id)}`).length === 1) {
                parts.unshift(`#${escape(node.id)}`);
                return parts.join(' > ');
            }
            if (escape && node.classList?.length) part += [...node.classList].slice(0, 3).map((name) => `.${escape(name)}`).join('');
            const siblings = node.parentElement ? [...node.parentElement.children].filter((item) => item.tagName === node.tagName) : [];
            if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
            parts.unshift(part);
            const selector = parts.join(' > ');
            if (document.querySelectorAll(selector).length === 1) return selector;
        }
        return '';
    };
    const visibleElements = (selector) => [...document.querySelectorAll(selector)].filter((element) => {
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.visibility !== 'collapse' && element.getClientRects().length > 0;
    });
    const visible = (selector) => visibleElements(selector).length > 0;
    const publish = (status, reason = '') => {
        const job = run;
        if (!job) return;
        for (const observer of job.observers) job.collect(observer.takeRecords(), observer.kind);
        const finishedAt = performance.now();
        const rows = [...job.resources.values()].map((entry) => ({
            url: entry.name, name: LoadMeasurement.shortName(entry.name),
            startedAt: entry.startTime, start: entry.startTime, end: entry.responseEnd,
            dur: entry.duration, initiatorType: entry.initiatorType,
            bytes: entry.decodedBodySize > 0 ? entry.decodedBodySize : null,
            encodedBytes: entry.encodedBodySize > 0 ? entry.encodedBodySize : null,
            cached: entry.transferSize === 0 && entry.decodedBodySize > 0,
            blocking: entry.renderBlockingStatus === 'blocking',
        }));
        lastReport = { version: 1, id: job.id, timeOrigin: performance.timeOrigin,
            origin: location.origin, url: job.readyAt === null ? location.href : job.url,
            startUrl: job.startUrl, pathname: new URL(job.readyAt === null ? location.href : job.url).pathname,
            mode: job.mode, config: job.config, startedAt: job.startedAt, readyAt: job.readyAt,
            ...(job.action && { action: job.action }),
            finishedAt, status, error: reason, rows,
            diagnostics: { longTasksSupported: job.longTasksSupported, tasks: job.tasks },
            lcp: job.mode === 'manual' ? null : job.lcp };
        stop();
        send({ report: lastReport });
    };
    const ready = (at) => {
        if (!run || run.phase !== 'running' || at < run.startedAt) return;
        run.readyAt = at;
        run.url = location.href;
        run.phase = 'settling';
        clearInterval(run.poll);
        clearTimeout(run.deadline);
        run.mutationObserver?.disconnect();
        run.tail = setTimeout(() => publish('complete'), TAIL_MS);
        send({ type: 'measurement-state', phase: 'settling' });
    };
    const begin = (rawConfig, mode, action = null, startedAt = null, initialVisible = null) => {
        const config = LoadMeasurement.normalizeConfig(rawConfig);
        if (config.ready.kind === 'selector') {
            document.querySelector(config.ready.value);
            if (mode === 'manual' && !action && visible(config.ready.value)) {
                throw new Error('Селектор уже виден. Для перехода укажи селектор нового состояния.');
            }
        }
        stop();
        error = '';
        lastReport = null;
        const job = { id: crypto.randomUUID(), config, mode, url: location.href, startUrl: location.href,
            startedAt: mode === 'manual' ? (startedAt ?? performance.now()) : 0, readyAt: null, action,
            phase: 'running', observers: [], resources: new Map(), tasks: [], lcp: null,
            longTasksSupported: PerformanceObserver.supportedEntryTypes.includes('longtask') };
        run = job;
        job.collect = (entries, kind) => {
            if (run !== job) return;
            for (const entry of entries) {
                if (job.resources.size >= LIMIT || job.tasks.length >= LIMIT) break;
                if (kind === 'resource' && entry.startTime >= job.startedAt) {
                    job.resources.set(`${entry.startTime}:${entry.name}`, entry);
                } else if (kind === 'longtask' && entry.startTime + entry.duration > job.startedAt) {
                    job.tasks.push({ start: entry.startTime, end: entry.startTime + entry.duration });
                } else if (kind === 'mark' && entry.name === config.ready.value && entry.startTime >= job.startedAt) {
                    ready(entry.startTime);
                } else if (kind === 'largest-contentful-paint') {
                    job.lcp = { at: entry.startTime, url: entry.url || '', element: entry.element?.tagName?.toLowerCase() || '', selector: elementSelector(entry.element) };
                }
            }
            if ((job.resources.size >= LIMIT || job.tasks.length >= LIMIT) && !job.limitTimer) {
                job.limitTimer = setTimeout(() => { if (run === job) publish('cancelled', 'Достигнут лимит 5000 записей. Сузь измеряемый переход.'); }, 0);
            }
        };
        const observe = (kind) => {
            if (!PerformanceObserver.supportedEntryTypes.includes(kind)) return;
            const observer = new PerformanceObserver((list) => job.collect(list.getEntries(), kind));
            observer.kind = kind;
            job.observers.push(observer);
            observer.observe({ type: kind, buffered: true });
        };
        observe('resource');
        observe('longtask');
        if (mode !== 'manual') observe('largest-contentful-paint');
        if (config.ready.kind === 'mark') observe('mark');
        else {
            let previous = initialVisible ? new Set(initialVisible) : null;
            const check = () => {
                if (run !== job || job.phase !== 'running') return;
                const current = visibleElements(config.ready.value);
                if (previous) {
                    for (const element of previous) if (!current.includes(element)) previous.delete(element);
                }
                if (current.length && (!previous || current.some((element) => !previous.has(element)))) ready(performance.now());
            };
            job.poll = setInterval(check, 10);
            if (typeof MutationObserver !== 'undefined') {
                job.mutationObserver = new MutationObserver(check);
                job.mutationObserver.observe(document, { subtree: true, childList: true, attributes: true });
            }
            check();
        }
        if (job.phase === 'running') {
            job.deadline = setTimeout(() => publish('timeout', initialVisible?.length
                ? 'За 120 секунд элемент готовности не скрылся и не изменился.'
                : 'За 120 секунд сигнал готовности не получен.'), TIMEOUT_MS);
        }
        send({ type: 'measurement-state', phase: job.phase });
    };

    const arm = (rawConfig) => {
        const config = LoadMeasurement.normalizeConfig(rawConfig);
        if (config.actionSelector) document.querySelector(config.actionSelector);
        if (config.ready.kind === 'selector') document.querySelector(config.ready.value);
        stop();
        error = '';
        const job = { phase: 'armed', observers: [] };
        run = job;
        job.actionHandler = (event) => {
            if (run !== job || !event.isTrusted) return;
            if (event.type === 'click' && event.button !== 0) return;
            if (event.type === 'keydown' && (event.repeat || !['Enter', ' '].includes(event.key))) return;
            const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
            if (config.actionSelector && !target?.closest(config.actionSelector)) return;
            const now = performance.now();
            const started = Number.isFinite(event.timeStamp) && event.timeStamp >= 0 && event.timeStamp <= now
                ? event.timeStamp : now;
            const initialVisible = config.ready.kind === 'selector' ? visibleElements(config.ready.value) : null;
            const action = event.type === 'keydown' ? { type: 'keydown', key: event.key } : { type: 'click' };
            begin(config, 'manual', action, started, initialVisible);
        };
        document.addEventListener('click', job.actionHandler, true);
        document.addEventListener('keydown', job.actionHandler, true);
        job.deadline = setTimeout(() => {
            if (run !== job) return;
            stop();
            error = 'За 120 секунд действие не выполнено.';
            send({ type: 'measurement-state', phase: 'idle', error });
        }, TIMEOUT_MS);
        send({ type: 'measurement-state', phase: 'armed' });
    };

    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (message?.source !== SOURCE || sender.id !== chrome.runtime.id) return;
        try {
            if (message.type === 'page-start') begin(message.config, 'manual');
            else if (message.type === 'page-arm') arm(message.config);
            else if (message.type === 'page-cancel') {
                if (run?.phase === 'armed') { stop(); error = ''; send({ type: 'measurement-state', phase: lastReport ? 'done' : 'idle' }); }
                else publish('cancelled', 'Замер остановлен пользователем.');
            }
            else if (message.type !== 'page-get') return;
            respond({ state: state() });
        } catch (cause) { respond({ error: cause.message }); }
    });
    window.addEventListener('pagehide', stop);
    window.addEventListener('pageshow', (event) => {
        if (!event.persisted) return;
        stop();
        lastReport = null;
        error = 'Страница восстановлена из back/forward cache. Для полного замера обнови её.';
    });
    chrome.storage.local.get(key).then((saved) => {
        if (!saved[key] || run || lastReport) return;
        const navigation = performance.getEntriesByType('navigation')[0];
        try { begin(saved[key], navigation?.type === 'reload' ? 'reload' : 'navigate'); }
        catch (cause) { error = cause.message; }
    }).catch((cause) => { error = cause.message; });
})();
