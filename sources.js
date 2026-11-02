// Отдельный диагностический прогон. Основной отчёт хранится вместе с состоянием.
let sourcesJob = null;
const sourcesKey = (tabId) => `page-load-sources:${tabId}`;
const activeSourcesPhases = new Set(['attaching', 'waiting', 'recording', 'stopping']);
const isSupportedUrl = (url = '') => /^https?:\/\//.test(url);
const sourcesMessage = (state) => chrome.runtime.sendMessage({ source: 'page-load-extension', type: 'sources-state', state })
    .catch(() => undefined);

const sourcesStore = async (mode, tabId, value) => {
    const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('page-load-sources', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('reports');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction('reports', mode === 'get' ? 'readonly' : 'readwrite');
            const store = transaction.objectStore('reports');
            const request = mode === 'get' ? store.get(tabId) : mode === 'delete' ? store.delete(tabId) : store.put(value, tabId);
            transaction.oncomplete = () => resolve(request.result);
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
        });
    } finally {
        db.close();
    }
};

const reportKey = (tabId) => `report:${tabId}`;
const baselineKey = (tabId) => `baseline:${tabId}`;

// Все операции с состоянием одной вкладки идут по очереди. Токен не даёт
// старой записи восстановить данные после очистки или начала нового прогона.
const storageQueues = new Map();
const latestSources = new Map();
const queueStorage = (tabId, action) => {
    const previous = storageQueues.get(tabId) || Promise.resolve();
    const result = previous.catch(() => undefined).then(action);
    storageQueues.set(tabId, result);
    result.finally(() => { if (storageQueues.get(tabId) === result) storageQueues.delete(tabId); }).catch(() => undefined);
    return result;
};
const currentJob = (job) => latestSources.get(job.state.tabId) === job && !job.cancelled;
const jobStorage = (job, action, allowCancelled = false) => queueStorage(job.state.tabId, () => {
    if (latestSources.get(job.state.tabId) !== job || (job.cancelled && !allowCancelled)) return;
    return action();
});
const saveSources = async (job, allowCancelled = false) => {
    const state = { ...job.state, capturedReport: null };
    await jobStorage(job, () => chrome.storage.session.set({ [sourcesKey(state.tabId)]: { ...state, report: null, baseline: null } }), allowCancelled);
    if (latestSources.get(state.tabId) === job && (!job.cancelled || allowCancelled)) await sourcesMessage(state);
    return state;
};

// После завершения освобождаем сетевые данные и стеки в памяти worker.
const releaseJob = (job) => {
    job.requests.clear();
    job.scripts.clear();
    job.activeRequests.clear();
    job.state.report = null;
    job.state.capturedReport = null;
    if (latestSources.get(job.state.tabId) === job) latestSources.set(job.state.tabId, {});
};

const sourcesCommand = (job, command, params = {}) => job.cancelled
    ? Promise.reject(new Error('Уточнение источников отменено.')) : chrome.debugger.sendCommand({ tabId: job.state.tabId }, command, params);
const releaseDebugger = async (job) => {
    if (job.detaching) return job.detaching;
    if (!job.attached) return;
    job.attached = false;
    job.detaching = chrome.debugger.detach({ tabId: job.state.tabId }).catch(() => undefined);
    await job.detaching;
};

const completeInitiator = async (job, initiator) => {
    const resolveStack = async (stack, depth, seen) => {
        if (!stack || depth >= 8 || job.cancelled) return stack;
        let parent = stack.parent;
        if (!parent && stack.parentId) {
            const key = JSON.stringify(stack.parentId);
            if (seen.has(key)) return stack;
            seen.add(key);
            try {
                parent = (await sourcesCommand(job, 'Debugger.getStackTrace', { stackTraceId: stack.parentId })).stackTrace;
            } catch { return stack; }
        }
        return parent ? { ...stack, parent: await resolveStack(parent, depth + 1, seen) } : stack;
    };
    if (!initiator?.stack) return initiator ? { type: initiator.type, url: initiator.url } : null;
    const stack = await resolveStack(initiator.stack, 0, new Set());
    // Для состояния хватает плоского стека: описания async-границ панель не использует.
    const callFrames = [];
    for (let item = stack; item && callFrames.length < 40; item = item.parent) {
        for (const frame of item.callFrames || []) callFrames.push({ functionName: frame.functionName, url: frame.url,
            lineNumber: frame.lineNumber, columnNumber: frame.columnNumber, ...job.scripts.get(String(frame.scriptId)) });
    }
    return { type: initiator.type, url: initiator.url, stack: { callFrames: callFrames.slice(0, 40) } };
};

const failSources = async (job, message) => {
    if (job.cancelled) return;
    job.cancelled = true;
    clearTimeout(job.timeout);
    job.state = { ...job.state, phase: 'error', error: message };
    // Wait for an in-flight attach before allowing another run on this tab.
    await job.attaching?.catch(() => undefined);
    await releaseDebugger(job);
    if (sourcesJob === job) sourcesJob = null;
    try { await saveSources(job, true); } finally { releaseJob(job); }
};

const finishSources = async (job) => {
    if (job.cancelled || job.state.phase !== 'recording') return;
    clearTimeout(job.timeout);
    job.state = { ...job.state, phase: 'stopping' };
    job.timeout = setTimeout(() => { void failSources(job, 'Не удалось завершить уточнение источников. Основной замер сохранён.'); }, 15000);
    try {
        await saveSources(job);
        if (job.cancelled) return;
        // Resource Timing and Network belong to this same extra reload.
        const entries = await Promise.all([...job.requests.values()].map(async (request) => ({
            startedDateTime: new Date(request.startedAt).toISOString(),
            time: Number.isFinite(request.end) ? request.end - request.startedAt : -1,
            request: { url: request.url, method: request.method },
            response: {
                status: request.response?.status,
                _error: request.error,
                httpVersion: request.response?.protocol,
                bodySize: -1,
                headers: Object.entries(request.response?.headers || {}).map(([name, value]) => ({ name, value: String(value) })),
                content: { mimeType: request.response?.mimeType,
                    size: Number.isFinite(request.end) && request.dataEvents ? request.decodedBytes : -1 },
            },
            _resourceType: request.type,
            _fromCache: request.cached,
            _initiator: await completeInitiator(job, request.initiator),
        })));
        if (!currentJob(job)) return;
        const report = { ...job.state.capturedReport,
            rows: LoadMeasurement.buildModel(job.state.capturedReport, entries).rows };
        await jobStorage(job, () => sourcesStore('put', reportKey(job.state.tabId), report));
        if (!currentJob(job)) return;
        job.state = { ...job.state, phase: 'done', report, finishedAt: Date.now(), capturedReport: null };
        clearTimeout(job.timeout);
        await releaseDebugger(job);
        if (!currentJob(job)) return;
        if (sourcesJob === job) sourcesJob = null;
        await saveSources(job);
        releaseJob(job);
    } catch (error) {
        await failSources(job, error.message || 'Не удалось уточнить источники.');
    }
};

const attachAndCollect = async (job) => {
    if (job.cancelled || job.starting) return;
    job.starting = true;
    job.state = { ...job.state, phase: 'attaching', error: null };
    try {
        await saveSources(job);
        if (job.cancelled) return;
        const tab = await chrome.tabs.get(job.state.tabId);
        if (!currentJob(job)) return;
        if (!isSupportedUrl(tab.url) || tab.url !== job.state.baseline.url) {
            throw new Error('На вкладке уже другая страница. Сделай новый основной замер.');
        }
        job.attaching = chrome.debugger.attach({ tabId: job.state.tabId }, '1.3');
        await job.attaching;
        job.attached = true;
        if (job.cancelled) {
            await releaseDebugger(job);
            return;
        }
    } catch (error) {
        job.starting = false;
        if (job.cancelled) return;
        if (/already attached|another debugger/i.test(error.message)) {
            job.state = { ...job.state, phase: 'waiting' };
            await saveSources(job);
        } else await failSources(job, error.message || 'Chrome не разрешил подключить сбор источников.');
        return;
    }
    try {
        await sourcesCommand(job, 'Page.enable');
        await sourcesCommand(job, 'Network.enable');
        await sourcesCommand(job, 'Debugger.enable');
        await sourcesCommand(job, 'Debugger.setAsyncCallStackDepth', { maxDepth: 8 });
        if (!currentJob(job)) { await releaseDebugger(job); return; }
        job.state = { ...job.state, phase: 'recording', startedAt: Date.now() };
        await saveSources(job);
        if (!currentJob(job)) return;
        job.timeout = setTimeout(() => { void failSources(job, 'Отчёт страницы не получен. Основной замер сохранён.'); }, 190000);
        // Кеш и скорость сети не меняем. Этот reload относится только к доп. прогону.
        await sourcesCommand(job, 'Page.reload', { ignoreCache: false });
    } catch (error) {
        await failSources(job, error.message || 'Не удалось начать уточнение источников.');
    } finally {
        job.starting = false;
    }
};

const startSources = async (tabId, baseline) => {
    if (sourcesJob) throw new Error('Уточнение источников уже выполняется.');
    if (!Number.isInteger(tabId) || baseline?.status !== 'complete' || !Number.isFinite(baseline.timeOrigin)
        || !Number.isFinite(baseline.readyAt) || !Number.isFinite(baseline.startedAt)
        || baseline.readyAt < baseline.startedAt || !baseline.diagnostics || !baseline.config || !Array.isArray(baseline.rows)) {
        throw new Error('Сначала дождись полного основного замера.');
    }
    if (!await chrome.permissions.contains({ permissions: ['debugger'] })) throw new Error('Для уточнения источников нужно право Debugger. Перезагрузи расширение в chrome://extensions и переоткрой DevTools.');
    if (sourcesJob) throw new Error('Уточнение источников уже выполняется.');
    bindSourcesDebugger();
    baseline = structuredClone(baseline);
    const job = { state: { tabId, baseline, phase: 'attaching', id: crypto.randomUUID(),
        createdAt: Date.now(), url: null }, scripts: new Map(), requests: new Map(), activeRequests: new Map(), cancelled: false, attached: false };
    sourcesJob = job;
    latestSources.set(tabId, job);
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!currentJob(job)) throw new Error('Уточнение источников отменено.');
        if (!isSupportedUrl(tab.url) || tab.url !== baseline.url) throw new Error('Вкладка не совпадает с основным замером.');
        job.state.url = tab.url;
        await jobStorage(job, () => sourcesStore('put', baselineKey(tabId), baseline));
        if (!currentJob(job)) throw new Error('Уточнение источников отменено.');
        await saveSources(job);
        if (!currentJob(job)) throw new Error('Уточнение источников отменено.');
        await jobStorage(job, () => sourcesStore('delete', reportKey(tabId)));
        if (!currentJob(job)) throw new Error('Уточнение источников отменено.');
        void attachAndCollect(job);
        return job.state;
    } catch (error) {
        await failSources(job, error.message);
        throw error;
    }
};

const readSources = (tabId) => queueStorage(tabId, async () => {
    const state = (await chrome.storage.session.get(sourcesKey(tabId)))[sourcesKey(tabId)] || null;
    if (state && activeSourcesPhases.has(state.phase) && sourcesJob?.state.tabId !== tabId && state.phase !== 'waiting') {
        state.phase = 'error';
        state.error = 'Уточнение источников прервалось при перезапуске расширения. Основной замер сохранён.';
        await chrome.storage.session.set({ [sourcesKey(tabId)]: state });
    }
    if (state) state.baseline = await sourcesStore('get', baselineKey(tabId)).catch(() => null);
    if (state?.phase === 'done') state.report = await sourcesStore('get', reportKey(tabId)).catch(() => null);
    return state;
});

const clearSources = async (tabId) => {
    const token = {};
    latestSources.set(tabId, token);
    if (sourcesJob?.state.tabId === tabId) void failSources(sourcesJob, 'Уточнение источников отменено.');
    await queueStorage(tabId, async () => {
        if (latestSources.get(tabId) !== token) return;
        await chrome.storage.session.remove(sourcesKey(tabId));
        await sourcesStore('delete', reportKey(tabId));
        await sourcesStore('delete', baselineKey(tabId));
    });
    return token;
};

const cancelSources = async (tabId) => {
    if (sourcesJob?.state.tabId === tabId) await failSources(sourcesJob, 'Уточнение источников отменено.');
    else {
        const token = {};
        latestSources.set(tabId, token);
        await queueStorage(tabId, async () => {
            if (latestSources.get(tabId) !== token) return;
            const state = (await chrome.storage.session.get(sourcesKey(tabId)))[sourcesKey(tabId)];
            if (state && sourcesJob?.state.tabId !== tabId) await chrome.storage.session.set({ [sourcesKey(tabId)]: { ...state, report: null, baseline: null, phase: 'error', error: 'Уточнение источников отменено.' } });
        });
    }
    return readSources(tabId);
};

const moduleName = (sourceMapURL) => {
    const data = /^data:application\/json[^,]*;base64,(.+)$/.exec(sourceMapURL || '')?.[1];
    if (!data) return null;
    try {
        const source = /"sources":\["([^"]+)"/.exec(atob(data))?.[1];
        return source?.replace(/^webpack:\/\/[^/]*\//, '').replace(/^(\.\.?\/)+/, '') || null;
    } catch {
        return null;
    }
};

const onSourcesEvent = (source, method, params) => {
    const job = sourcesJob;
    if (!job || job.cancelled || source.tabId !== job.state.tabId) return;
    // Dev-сборка выполняет модули через eval с адресом webpack-internal:///<id>: владельца даёт чанк, вызвавший eval.
    if (method === 'Debugger.scriptParsed' && params.url?.startsWith('webpack-internal:')) {
        if (job.scripts.size >= 20000) { void failSources(job, 'Превышен лимит скриптов. Основной замер сохранён.'); return; }
        job.scripts.set(String(params.scriptId), { ownerUrl: params.stackTrace?.callFrames?.[0]?.url || null, module: moduleName(params.sourceMapURL) });
    }
    if (job.state.phase !== 'recording') return;
    if (method === 'Network.requestWillBeSent') {
        if (!Number.isFinite(params.wallTime) || !Number.isFinite(params.timestamp) || !isSupportedUrl(params.request?.url)) return;
        if (job.requests.size >= 5000) { void failSources(job, 'Превышен лимит 5000 запросов. Основной замер сохранён.'); return; }
        const previous = job.activeRequests.get(params.requestId);
        if (previous && params.redirectResponse) {
            previous.response = params.redirectResponse;
            previous.end = previous.startedAt + (params.timestamp - previous.timestamp) * 1000;
        }
        const request = { url: params.request.url, method: params.request.method,
            initiator: params.initiator, type: params.type, startedAt: params.wallTime * 1000,
            timestamp: params.timestamp, decodedBytes: 0, dataEvents: false, cached: false };
        job.requests.set(`${params.requestId}:${job.requests.size}`, request);
        job.activeRequests.set(params.requestId, request);
    } else {
        const request = job.activeRequests.get(params.requestId);
        if (!request) return;
        if (method === 'Network.responseReceived') {
            request.response = params.response;
            request.type = params.type || request.type;
            request.cached ||= Boolean(params.response?.fromDiskCache || params.response?.fromServiceWorker);
        } else if (method === 'Network.requestServedFromCache') request.cached = true;
        else if (method === 'Network.dataReceived' && Number.isFinite(params.dataLength) && params.dataLength >= 0) {
            request.decodedBytes += params.dataLength;
            request.dataEvents = true;
        } else if (method === 'Network.loadingFinished' && Number.isFinite(params.timestamp)) {
            request.end = request.startedAt + (params.timestamp - request.timestamp) * 1000;
        } else if (method === 'Network.loadingFailed') request.error = params.errorText || 'Network request failed';
    }
};

const onSourcesDetach = (source) => {
    const job = sourcesJob;
    if (!job || source.tabId !== job.state.tabId || !job.attached || job.cancelled) return;
    job.attached = false;
    void failSources(job, 'Chrome отключил сбор источников. Если открывались DevTools, повтори прогон и открой их после завершения.');
};

let sourcesDebuggerBound = false;
const bindSourcesDebugger = () => {
    // Если Chrome ещё использует старый manifest, основной замер работает без API.
    if (sourcesDebuggerBound || !chrome.debugger) return;
    chrome.debugger.onEvent.addListener(onSourcesEvent);
    chrome.debugger.onDetach.addListener(onSourcesDetach);
    sourcesDebuggerBound = true;
};
bindSourcesDebugger();

const acceptSourcesReport = async (message, sender) => {
    const job = sourcesJob;
    const data = message.report;
    if (!job || job.cancelled || job.state.phase !== 'recording' || sender.tab?.id !== job.state.tabId
        || sender.frameId !== 0 || !Number.isFinite(data?.timeOrigin)
        || data.timeOrigin === job.state.baseline.timeOrigin || job.marked) return;
    if (data.version !== 1 || !Array.isArray(data.rows) || data.status !== 'complete'
        || !Number.isFinite(data.finishedAt) || !Number.isFinite(data.readyAt) || !Number.isFinite(data.startedAt)
        || data.readyAt < data.startedAt || data.finishedAt < data.readyAt) {
        await failSources(job, 'Готовность страницы не подтверждена. Основной замер сохранён.');
        return;
    }
    const baseline = job.state.baseline;
    if (data.origin !== baseline.origin || data.pathname !== baseline.pathname || data.url !== baseline.url
        || JSON.stringify(data.config) !== JSON.stringify(baseline.config)) {
        await failSources(job, 'Во время уточнения источников изменились страница или настройки. Основной замер сохранён.');
        return;
    }
    job.marked = true;
    job.state = { ...job.state, capturedReport: structuredClone(data) };
    await finishSources(job);
};

chrome.runtime.onConnect.addListener((port) => {
    if (port.sender?.id !== chrome.runtime.id || !/^page-load-devtools:\d+$/.test(port.name)) return;
    const tabId = Number(port.name.split(':')[1]);
    port.onDisconnect.addListener(() => {
        void (async () => {
            const token = latestSources.get(tabId);
            const state = await readSources(tabId);
            if (latestSources.get(tabId) !== token || state?.phase !== 'waiting') return;
            let job = sourcesJob;
            if (!job) {
                job = { state, scripts: new Map(), requests: new Map(), activeRequests: new Map(), cancelled: false, attached: false };
                sourcesJob = job;
                latestSources.set(tabId, job);
            }
            if (job.state.tabId === tabId) setTimeout(() => { void attachAndCollect(job); }, 500);
        })();
    });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.source !== 'page-load-extension') return;
    if (message.report) {
        void acceptSourcesReport(message, sender).catch((error) => {
            if (sourcesJob) void failSources(sourcesJob, error.message);
        });
        return;
    }
    if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL('panel.html')) return;
    const action = message.type === 'sources-start' ? () => startSources(message.tabId, message.baseline)
        : message.type === 'sources-get' ? () => readSources(message.tabId)
            : message.type === 'sources-cancel' ? () => cancelSources(message.tabId)
            : message.type === 'sources-clear' ? () => clearSources(message.tabId)
                : null;
    if (!action) return;
    Promise.resolve().then(action).then((state) => sendResponse({ result: state }), (error) => sendResponse({ error: error.message }));
    return true;
});

// После перезапуска браузера session сброшена; сохранённые отчёты больше не нужны.
chrome.runtime.onStartup.addListener(() => { indexedDB.deleteDatabase('page-load-sources'); });
chrome.runtime.onInstalled.addListener(() => { indexedDB.deleteDatabase('page-load-performance'); });
chrome.tabs.onRemoved.addListener((tabId) => {
    void clearSources(tabId).then((token) => { if (latestSources.get(tabId) === token) latestSources.delete(tabId); });
});
