(() => {
    const SOURCE = 'page-load-extension';
    const tabId = chrome.devtools.inspectedWindow.tabId;
    const $ = (id) => document.getElementById(id);
    let currentReport = null;
    let harEntries = [];
    let sourcesState = null;
    let pagePhase = 'idle';
    let source = 'main';
    let origin = '';
    let pending = true;
    let ignoreSources = false;
    let pageRequest = false;
    let model = null;
    let networkTimer = null;
    let revision = 0;
    let presets = [];
    let selectedPresetId = '';
    let seriesState = { running: false, samples: [], target: 10, error: '' };
    let showSeries = false;
    let preparingMeasurement = false;
    let seriesIgnoreOrigin = null;

    document.documentElement.dataset.theme = chrome.devtools.panels.themeName;
    chrome.devtools.panels.onThemeChanged?.addListener((theme) => { document.documentElement.dataset.theme = theme; });
    const request = (type, extra = {}) => new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ source: SOURCE, type, tabId, ...extra }, (response) => {
            if (chrome.runtime.lastError || response?.error) reject(new Error(chrome.runtime.lastError?.message || response.error));
            else resolve(response?.result);
        });
    });
    const pageCommand = async (type, extra = {}) => {
        const response = await request(type, extra);
        if (response?.error) throw new Error(response.error);
        return response?.state;
    };
    const busySources = () => ['attaching', 'waiting', 'recording', 'stopping'].includes(sourcesState?.phase);
    const hasSources = () => sourcesState?.phase === 'done' && Boolean(sourcesState.report);
    const busyPage = () => ['armed', 'running', 'settling'].includes(pagePhase);
    const readHar = () => new Promise((resolve, reject) => chrome.devtools.network.getHAR((har) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(har?.entries || []);
    }));
    const series = LoadSeries.create({
        getHar: readHar,
        onSample: (sampleModel) => {
            currentReport = { ...sampleModel.report, rows: sampleModel.rows };
            harEntries = [];
            source = 'main';
        },
        reload: () => {
            pagePhase = 'running';
            chrome.devtools.inspectedWindow.reload();
        },
        onChange: (state) => {
            seriesState = state;
            if (!state.running) pagePhase = 'done';
            if (state.error) setStatus(state.error, true);
            else if (state.running) setStatus(`Замер ${state.samples.length + 1} из ${state.target}. Не кликай и не прокручивай страницу.`);
            else {
                pagePhase = 'done';
                setStatus(state.samples.length === state.target ? 'Серия завершена: 10 замеров.' : `Серия остановлена. Сохранено замеров: ${state.samples.length}.`);
            }
            render();
        },
    });
    const setStatus = (text, failed = false) => {
        $('status').textContent = text;
        $('status').classList.toggle('error', failed);
    };
    const toggleSettings = (open) => {
        $('settings').hidden = !open;
        $('settingsToggle').setAttribute('aria-expanded', String(open));
    };
    const updateForm = () => {
        $('moduleFields').hidden = $('scope').value !== 'module';
    };
    const fillForm = (config) => {
        $('scope').value = config.scope;
        $('configName').value = config.name;
        $('codePatterns').value = config.codePatterns.join('\n');
        $('resourcePatterns').value = config.resourcePatterns.join('\n');
        $('actionSelector').value = config.actionSelector || '';
        $('readyValue').value = config.ready.kind === 'selector' ? config.ready.value : '';
        updateForm();
    };
    const readConfig = () => LoadMeasurement.normalizeConfig({
        scope: $('scope').value, name: $('configName').value,
        codePatterns: $('codePatterns').value.split('\n'), resourcePatterns: $('resourcePatterns').value.split('\n'),
        actionSelector: $('actionSelector').value,
        ready: { kind: 'selector', value: $('readyValue').value },
    });
    const updateControls = () => {
        const sourcesBusy = busySources();
        const blocked = pending || sourcesBusy || seriesState.running || !origin;
        for (const id of ['saveMeasure', 'repeatMeasure', 'manualMeasure', 'measureSeries', 'presetSelect', 'presetName', 'savePreset', 'newPreset']) $(id).disabled = blocked;
        $('deletePreset').disabled = blocked || !selectedPresetId;
        for (const field of $('configForm').querySelectorAll('input,select,textarea')) field.disabled = blocked;
        $('stopMeasure').hidden = !busyPage() || sourcesBusy || seriesState.running;
        $('stopMeasure').disabled = pending;
        $('sourcesControls').hidden = !currentReport;
        $('startSources').disabled = blocked || busyPage() || currentReport?.status !== 'complete';
        $('cancelSources').hidden = !sourcesBusy;
        $('viewControls').hidden = !currentReport;
        $('showBeforeControl').hidden = model?.report.config.scope !== 'module';
        $('showBefore').disabled = !Number.isFinite(model?.moduleStart);
        $('sourceDetails').disabled = !hasSources();
        $('sourceMain').setAttribute('aria-pressed', String(source === 'main'));
        $('sourceDetails').setAttribute('aria-pressed', String(source === 'sources'));
        $('exportReport').disabled = !model || pending;
        $('exportReport').textContent = source === 'sources' ? 'Скачать отчёт с источниками' : 'Скачать отчёт';
        $('cancelSeries').hidden = !seriesState.running;
        $('cancelSeries').disabled = pending;
        $('exportSeries').hidden = !seriesState.samples.length;
        $('exportSeries').disabled = pending;
        const statuses = {
            attaching: 'Подключаем сбор источников запросов…',
            waiting: 'Закрой DevTools. Уточнение источников начнётся автоматически после закрытия; открой DevTools снова через несколько секунд после готовности страницы.',
            recording: 'Уточняем источники в отдельном прогоне. Открытие DevTools может прервать сбор.',
            stopping: 'Дополняем стеки инициаторов…',
            done: 'Источники уточнены. Запросы показаны из отдельного прогона; главные показатели — из основного замера.',
        };
        $('sourcesStatus').textContent = sourcesState?.error || statuses[sourcesState?.phase] || '';
        $('sourcesStatus').classList.toggle('error', Boolean(sourcesState?.error));
    };
    const render = () => {
        if (source === 'sources' && !hasSources()) source = 'main';
        $('results').hidden = !currentReport;
        $('dashboard').hidden = !currentReport;
        if (currentReport) model = LoadView.render(currentReport, harEntries, {
            showAfter: $('showAfter').checked, showBefore: $('showBefore').checked,
        }, showSeries ? seriesState : null, source === 'sources' ? sourcesState.report : null).model;
        else { model = null; $('seriesResults').hidden = true; }
        updateControls();
    };
    const refreshHar = async () => {
        if (!currentReport || source !== 'main' || sourcesState?.baseline || seriesState.running || showSeries) return;
        const reportId = currentReport.id;
        let entries;
        try { entries = await readHar(); }
        catch (cause) { setStatus(`Не удалось дополнить размеры из Network: ${cause.message}`, true); return; }
        if (currentReport?.id !== reportId || sourcesState?.baseline || seriesState.running || showSeries) return;
        harEntries = entries;
        render();
    };
    const acceptReport = (report) => {
        if (!report || report.version !== 1 || !Array.isArray(report.rows) || preparingMeasurement) return;
        if (showSeries && !seriesState.running) return;
        if (seriesState.running) {
            if (report.timeOrigin === seriesIgnoreOrigin) return;
            if (report.timeOrigin === currentReport?.timeOrigin && report.id === currentReport.id) return;
            void series.accept(report);
            return;
        }
        currentReport = report;
        pagePhase = 'done';
        source = 'main';
        harEntries = [];
        setStatus(report.status === 'complete' ? 'Сигнал готовности получен. Замер завершён.' : report.error || 'Замер не завершён.', report.status !== 'complete');
        render();
        void refreshHar();
    };
    const acceptPage = (state) => {
        if (!state) return;
        if (sourcesState?.baseline || preparingMeasurement || (showSeries && !seriesState.running)) return;
        const previousPhase = pagePhase;
        pagePhase = state.phase;
        if (state.phase === 'running' && previousPhase !== 'running' && !seriesState.running) {
            currentReport = null;
            harEntries = [];
            source = 'main';
            render();
        }
        if (state.report && state.phase !== 'armed' && currentReport?.id !== state.report.id) acceptReport(state.report);
        else if (state.error) setStatus(state.error, true);
        else if (state.phase === 'armed') setStatus('Ждём клик или Enter/пробел на исследуемой странице. Время ожидания в замер не входит.');
        else if (state.phase === 'running') setStatus('Ждём заданный сигнал готовности…');
        else if (state.phase === 'settling') setStatus('Готовность подтверждена. Дописываем завершившиеся запросы…');
        else if (!currentReport) setStatus('Укажи сигнал готовности и нажми «Сохранить и обновить».');
        if (seriesState.running) setStatus(`Замер ${seriesState.samples.length + 1} из ${seriesState.target}. Не кликай и не прокручивай страницу.`);
        updateControls();
    };
    const acceptSources = (state) => {
        if (!state || ignoreSources) return;
        const order = { attaching: 0, waiting: 1, recording: 2, stopping: 3, done: 4, error: 5 };
        if (sourcesState?.id === state.id && order[state.phase] < order[sourcesState.phase]) return;
        const newlyDone = state.phase === 'done' && sourcesState?.phase !== 'done';
        sourcesState = state;
        if (state.baseline) { currentReport = state.baseline; harEntries = []; }
        if (newlyDone && hasSources()) source = 'sources';
        render();
    };
    const clearSources = async () => {
        ignoreSources = true;
        try { await request('sources-clear'); sourcesState = null; }
        finally { ignoreSources = false; }
    };
    const setPresetStatus = (text, failed = false) => {
        $('presetStatus').textContent = text;
        $('presetStatus').classList.toggle('error', failed);
    };
    const renderPresets = () => {
        const select = $('presetSelect');
        select.replaceChildren(new Option('Текущие настройки', ''));
        for (const preset of presets) select.add(new Option(preset.name, preset.id));
        if (!presets.some((preset) => preset.id === selectedPresetId)) selectedPresetId = '';
        select.value = selectedPresetId;
        $('savePreset').textContent = selectedPresetId ? 'Сохранить изменения' : 'Сохранить пресет';
        updateControls();
    };
    const loadPresets = async () => {
        presets = await request('preset-list');
        renderPresets();
    };
    const applyPreset = (id) => {
        const preset = presets.find((item) => item.id === id);
        selectedPresetId = preset?.id || '';
        $('presetName').value = preset?.name || '';
        if (preset) fillForm(preset.config);
        renderPresets();
        setPresetStatus('');
    };
    const saveActiveConfig = async () => {
        const config = readConfig();
        const tab = await request('page-info');
        if (new URL(tab.url).origin !== origin) throw new Error('Открыт другой сайт. Дождись обновления настроек панели.');
        await chrome.storage.local.set({ [`page-load-config:${origin}`]: config,
            [`page-load-active-preset:${origin}`]: selectedPresetId });
        return { config, url: tab.url };
    };
    const measure = async (mode) => {
        if (pending || busySources() || seriesState.running) return;
        pending = true;
        updateControls();
        try {
            const { config } = await saveActiveConfig();
            showSeries = false;
            if (mode === 'action') {
                await pageCommand('page-arm', { config });
                await clearSources();
                acceptPage(await pageCommand('page-get'));
            } else {
                await clearSources();
                currentReport = null;
                harEntries = [];
                pagePhase = 'running';
                chrome.devtools.inspectedWindow.reload();
                setStatus('Обновляем страницу и ждём сигнал готовности…');
            }
            toggleSettings(false);
        } catch (cause) { setStatus(cause.message, true); }
        finally { pending = false; render(); }
    };
    const startSeries = () => runAction(async () => {
        if (seriesState.running || busySources()) return;
        preparingMeasurement = true;
        try {
            const { config, url } = await saveActiveConfig();
            const state = await pageCommand('page-get');
            seriesIgnoreOrigin = state.timeOrigin;
            if (['armed', 'running', 'settling'].includes(state.phase)) await pageCommand('page-cancel');
            await clearSources();
            currentReport = null;
            harEntries = [];
            source = 'main';
            showSeries = true;
            preparingMeasurement = false;
            toggleSettings(false);
            await series.start({ url, config, ignoreTimeOrigin: seriesIgnoreOrigin });
        } finally { preparingMeasurement = false; }
    });
    const syncContext = async () => {
        const token = ++revision;
        try {
            const tab = await request('page-info');
            if (token !== revision) return;
            $('pageUrl').textContent = tab.url || '';
            $('pageUrl').title = tab.url || '';
            const nextOrigin = /^https?:\/\//.test(tab.url || '') ? new URL(tab.url).origin : '';
            if (!nextOrigin) throw new Error('Открой обычную HTTP- или HTTPS-страницу. Служебные страницы Chrome не поддерживаются.');
            if (nextOrigin !== origin) {
                origin = nextOrigin;
                const saved = await chrome.storage.local.get([`page-load-config:${origin}`, `page-load-active-preset:${origin}`]);
                if (token !== revision) return;
                fillForm(saved[`page-load-config:${origin}`] || LoadMeasurement.defaultConfig());
                selectedPresetId = saved[`page-load-active-preset:${origin}`] || '';
                const preset = presets.find((item) => item.id === selectedPresetId);
                $('presetName').value = preset?.name || '';
                renderPresets();
                toggleSettings(!saved[`page-load-config:${origin}`]);
            }
            try { const state = await pageCommand('page-get'); if (token === revision) acceptPage(state); }
            catch { if (!sourcesState?.baseline) setStatus('Для подключения расширения обнови вкладку. Сначала можно сохранить настройки готовности.'); }
        } catch (cause) { origin = ''; setStatus(cause.message, true); }
        finally { if (token === revision) { pending = false; updateControls(); } }
    };
    const download = (value, name) => {
        const url = URL.createObjectURL(new Blob([value], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const runAction = async (action, onError = setStatus) => {
        if (pending) return;
        pending = true;
        updateControls();
        try { await action(); }
        catch (cause) { onError(cause.message, true); }
        finally { pending = false; render(); }
    };

    $('configForm').addEventListener('submit', (event) => { event.preventDefault(); void measure('reload'); });
    $('repeatMeasure').addEventListener('click', () => { void measure('reload'); });
    $('manualMeasure').addEventListener('click', () => { void measure('action'); });
    $('measureSeries').addEventListener('click', () => { void startSeries(); });
    $('cancelSeries').addEventListener('click', () => { void runAction(async () => {
        series.cancel();
        const state = await pageCommand('page-cancel');
        pagePhase = state.phase;
    }); });
    $('exportSeries').addEventListener('click', () => download(JSON.stringify({ version: 1, ...seriesState,
        summary: LoadSeries.summarize(seriesState.samples) }, null, 2), 'page-load-series.json'));
    $('stopMeasure').addEventListener('click', () => { void runAction(async () => acceptPage(await pageCommand('page-cancel'))); });
    $('settingsToggle').addEventListener('click', () => toggleSettings($('settings').hidden));
    $('scope').addEventListener('change', updateForm);
    $('configForm').addEventListener('input', () => setPresetStatus(''));
    $('configForm').addEventListener('change', () => setPresetStatus(''));
    $('presetSelect').addEventListener('change', () => applyPreset($('presetSelect').value));
    $('newPreset').addEventListener('click', () => applyPreset(''));
    $('savePreset').addEventListener('click', () => { void runAction(async () => {
        const preset = await request('preset-save', { preset: { ...(selectedPresetId && { id: selectedPresetId }),
            name: $('presetName').value, config: readConfig() } });
        selectedPresetId = preset.id;
        $('presetName').value = preset.name;
        await loadPresets();
        setPresetStatus('Пресет сохранён.');
    }, setPresetStatus); });
    $('deletePreset').addEventListener('click', () => { void runAction(async () => {
        await request('preset-delete', { id: selectedPresetId });
        selectedPresetId = '';
        $('presetName').value = '';
        await loadPresets();
        setPresetStatus('Пресет удалён.');
    }, setPresetStatus); });
    $('startSources').addEventListener('click', () => { void runAction(async () => {
        preparingMeasurement = true;
        try {
            // Freeze the main report before a separate reload with initiator collection.
            await refreshHar();
            const baseline = structuredClone(currentReport);
            baseline.rows = LoadMeasurement.buildModel(currentReport, harEntries).rows;
            acceptSources(await request('sources-start', { baseline }));
        } finally { preparingMeasurement = false; }
    }); });
    $('cancelSources').addEventListener('click', () => { void runAction(async () => acceptSources(await request('sources-cancel'))); });
    $('exportReport').addEventListener('click', () => {
        if (model) download(JSON.stringify({ version: 1, source, ...model.report, rows: model.rows }, null, 2), source === 'sources' ? 'page-load-sources-report.json' : 'page-load-report.json');
    });
    $('sourceMain').addEventListener('click', () => { source = 'main'; render(); });
    $('sourceDetails').addEventListener('click', () => { if (hasSources()) { source = 'sources'; render(); } });
    $('showAfter').addEventListener('change', render);
    $('showBefore').addEventListener('change', render);
    $('results').addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button) return;
        if (button.dataset.sourceUrl) {
            chrome.devtools.panels.openResource(button.dataset.sourceUrl, Number(button.dataset.sourceLine) || 0, Number(button.dataset.sourceColumn) || 0, () => { void chrome.runtime.lastError; });
        } else if (button.dataset.requestId) {
            const target = document.getElementById(`request-${button.dataset.requestId}`);
            if (target) { target.open = true; target.scrollIntoView({ block: 'center' }); }
        }
    });
    chrome.runtime.onMessage.addListener((message, sender) => {
        if (message?.source !== SOURCE) return;
        if (message.type === 'sources-state' && sender.id === chrome.runtime.id && !sender.tab && message.state?.tabId === tabId) {
            acceptSources(message.state);
        } else if (sender.tab?.id === tabId && sender.frameId === 0 && !sourcesState?.baseline) {
            if (message.report) acceptReport(message.report);
            else if (message.type === 'measurement-state') acceptPage({ phase: message.phase, error: message.error });
        }
    });
    chrome.devtools.network.onNavigated.addListener((url) => {
        if (seriesState.running && url !== seriesState.url) series.cancel('Открылась другая страница. Серия остановлена.');
        if (!sourcesState?.baseline) {
            if (!showSeries) { currentReport = null; harEntries = []; }
            pagePhase = showSeries && !seriesState.running ? 'done' : 'running';
            render();
        }
        void syncContext();
    });
    chrome.devtools.network.onRequestFinished.addListener(() => {
        if (!currentReport || sourcesState?.baseline || seriesState.running || showSeries || networkTimer !== null) return;
        networkTimer = setTimeout(() => { networkTimer = null; void refreshHar(); }, 200);
    });
    setInterval(() => {
        if (pending || pageRequest) return;
        if (busySources()) { void request('sources-get').then(acceptSources, () => undefined); return; }
        if (sourcesState?.baseline || (!busyPage() && currentReport)) return;
        pageRequest = true;
        pageCommand('page-get').then(acceptPage, () => undefined).finally(() => { pageRequest = false; });
    }, 1000);
    fillForm(LoadMeasurement.defaultConfig());
    Promise.allSettled([request('sources-get').then(acceptSources), loadPresets().catch((cause) => setPresetStatus(cause.message, true))])
        .finally(() => { void syncContext(); });
})();
