/* Presentation of the shared measurement model. */
const LoadView = (() => {
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    const selectorLabel = (selector) => {
        let start = 0;
        for (let i = 1; i < selector.length - 1; i += 1) {
            if (selector[i] !== '>' || selector[i - 1] !== ' ' || selector[i + 1] !== ' ') continue;
            let backslashes = 0;
            for (let j = i - 2; j >= 0 && selector[j] === '\\'; j -= 1) backslashes += 1;
            if (backslashes % 2 === 0) start = i + 2;
        }
        return selector.slice(start);
    };
    const selectorCaption = (selector) => {
        const full = selector || 'Селектор недоступен';
        return `<span class="mono lcp-selector" title="${esc(full)}">${esc(selectorLabel(full))}</span>`;
    };
    const ms = (value) => Number.isFinite(value) ? `${Math.round(value * 10) / 10} мс` : 'Нет данных';
    const bytes = (value) => {
        if (!Number.isFinite(value)) return 'Нет данных';
        if (value < 1024) return `${value} Б`;
        if (value < 1024 * 1024) return `${Math.round(value / 102.4) / 10} КБ`;
        return `${Math.round(value / (1024 * 102.4)) / 10} МБ`;
    };
    const sourceLink = (url, line, column, label) => url ? `
        <button type="button" data-source-url="${esc(url)}"
            data-source-line="${Number.isFinite(line) ? line : 0}"
            data-source-column="${Number.isFinite(column) ? column : 0}">${esc(label || LoadMeasurement.shortName(url))}</button>`
        : esc(label || 'Без имени');
    const metric = (label, value, note = '', caption = '', selector = false) => `
        <div class="metric"><span>${esc(label)}</span><strong>${esc(value)}</strong>
            ${caption ? `<small>${selector ? selectorCaption(caption) : esc(caption)}</small>` : ''}
            ${note ? `<details class="metric-details"><summary>Подробнее</summary><small>${esc(note)}</small></details>` : ''}
        </div>`;
    const sizeSummary = (summary) => `${summary.encodedBytes !== null && summary.encodedKnown < summary.files ? '≥ ' : ''}${bytes(summary.encodedBytes)}`;
    const sizeNote = (summary) => `Передано известно для ${summary.encodedKnown} из ${summary.files}; из кэша ${summary.cachedFiles}. `
        + (summary.declaredFiles ? `По Content-Length: ${summary.declaredFiles}. ` : '')
        + `Распаковано: ${summary.decodedBytes !== null && summary.decodedKnown < summary.files ? '≥ ' : ''}${bytes(summary.decodedBytes)} `
        + `(известно ${summary.decodedKnown} из ${summary.files}, включая кэш).`;
    const ownerClass = (id) => ['target', 'other', 'unknown', 'extension', 'browser'].includes(id) ? id : 'unknown';
    // All marker times use the document clock.
    const timeline = (model, showAfter, showBefore) => {
        const { report } = model;
        const start = report.config.scope === 'module' && !showBefore && Number.isFinite(model.moduleStart)
            ? model.moduleStart : model.start;
        const finish = Number.isFinite(report.finishedAt) ? report.finishedAt : model.end;
        const lcp = report.mode !== 'manual' && Number.isFinite(report.lcp?.at)
            && report.lcp.at >= start && report.lcp.at <= finish ? report.lcp.at : null;
        const end = Math.max(start + 0.001, showAfter ? finish : model.end, lcp ?? start);
        const points = [
            ...(model.moduleStart !== null ? [{ id: 'module', label: 'Первый файл модуля', at: model.moduleStart }] : []),
            ...(Number.isFinite(report.readyAt) ? [{ id: 'ready', label: 'Готовность', at: report.readyAt }] : []),
            ...(lcp !== null ? [{ id: 'lcp', label: 'LCP', at: lcp }] : []),
            ...(showAfter ? [{ id: 'end', label: 'Конец снимка', at: finish }] : []),
        ].filter((point) => Number.isFinite(point.at) && point.at >= start && point.at <= end);
        return { start, end, points };
    };
    const markerLines = (scale) => scale.points.map((point) => `
        <span class="timeline-marker marker-${point.id}" style="left:${(point.at - scale.start) / (scale.end - scale.start) * 100}%"></span>`).join('');
    const markerLegend = (scale) => `<div class="marker-legend" aria-label="Отметки на шкале">
        ${scale.points.map((point) => `<span><i class="marker-key marker-${point.id}" aria-hidden="true"></i>${esc(point.label)}: ${ms(point.at - scale.start)}</span>`).join('')}
    </div>`;
    const renderReport = (model) => {
        const { report } = model;
        const { config } = report;
        const ready = Number.isFinite(report.readyAt) ? report.readyAt - report.startedAt : null;
        const status = { complete: 'Готово', timeout: 'Время ожидания истекло', cancelled: 'Отменено' }[report.status] || 'Не завершено';
        const taskTime = (report.diagnostics?.tasks || []).reduce((sum, task) => (
            sum + Math.max(0, Math.min(model.end, task.end) - Math.max(model.start, task.start))), 0);
        const condition = config.ready.kind === 'mark' ? `performance.mark: ${config.ready.value}`
            : `CSS-селектор: ${config.ready.value} (проверка каждые 10 мс)`;
        const lcp = report.mode !== 'manual' ? (Number.isFinite(report.lcp?.at) ? ms(report.lcp.at) : 'Нет данных') : null;
        const firstFile = model.moduleStart === null ? null : model.moduleStart - model.start;
        const targetRows = model.rows.filter((row) => row.beforeReady && row.owner.id === 'target');
        const moduleTrafficIsCode = config.scope === 'module' && targetRows.length > 0
            && targetRows.every((row) => row.type === 'code');
        return `<div class="card dashboard-card">
            <h2>${esc(config.name)} <span class="badge">Обычное измерение</span></h2>
            <div class="metrics">
                ${metric('До готовности', ms(ready))}
                ${config.scope === 'module' ? metric('Модуль до готовности', ms(model.moduleMs), `Первый файл через ${ms(firstFile)} от начала замера`) : ''}
                ${metric('Трафик страницы', sizeSummary(model.summary), sizeNote(model.summary))}
                ${config.scope === 'module' ? metric(moduleTrafficIsCode ? 'Трафик модуля (код и стили)' : 'Трафик модуля', sizeSummary(model.targetSummary), `${moduleTrafficIsCode ? 'Трафик состоит из кода и стилей. ' : ''}${sizeNote(model.targetSummary)}`) : ''}
                ${!moduleTrafficIsCode ? metric(config.scope === 'module' ? 'Код модуля' : 'Код страницы', sizeSummary(model.codeSummary), sizeNote(model.codeSummary)) : ''}
                ${report.mode !== 'manual' ? `<div class="metric"><span>LCP</span><strong>${esc(lcp)}</strong><small>Элемент: ${selectorCaption(report.lcp?.selector)}</small><details class="metric-details"><summary>Подробнее</summary><small>От начала документа; значение на момент снимка.</small></details></div>` : ''}
            </div>
            <p class="mono">${esc(report.url)}</p><span class="badge">${esc(status)}</span>
            ${report.error ? `<p class="error">${esc(report.error)}</p>` : ''}
            <p class="muted">Условие готовности: ${esc(condition)}.</p>
            <p class="muted">Известные долгие задачи: ${report.diagnostics?.longTasksSupported ? ms(taskTime) : 'Нет данных'}. Только наблюдаемые долгие задачи, не всё время CPU.</p>
        </div>`;
    };
    const renderFindings = (model) => {
        const findings = LoadMeasurement.findings(model);
        if (!findings.length) return '';
        return `<section class="card findings"><h2>Наблюдения</h2><ul>${findings.map((item) => {
            const text = `<b>${esc(item.title)}</b>: ${esc(item.text)}`;
            return `<li>${item.rows?.length
                ? `<button class="finding-link" type="button" data-request-id="${esc(item.rows[0])}">${text}</button>`
                : text}</li>`;
        }).join('')}</ul></section>`;
    };
    const renderRequest = (row, scale, duplicates) => {
        const axisEnd = scale.end;
        const span = axisEnd - scale.start;
        const left = Math.max(0, Math.min(100, (row.start - scale.start) / span * 100));
        const right = Math.max(left, Math.min(100, ((row.end ?? axisEnd) - scale.start) / span * 100));
        const network = row.network || {};
        const frames = LoadMeasurement.stackFrames(row.initiator).slice(0, 20);
        const timings = network.timings && typeof network.timings === 'object'
            ? Object.entries(network.timings).filter(([, value]) => Number.isFinite(value) && value >= 0)
                .map(([key, value]) => `<li>${esc(key)}: ${ms(value)}</li>`).join('') : '';
        const attribution = { url: 'По URL ресурса', stack: 'По стеку инициатора', page: 'Страница', unknown: 'Не определена' };
        const sizeSource = { 'har-body': 'Network HAR', observed: 'измерение браузера', cache: 'кэш',
            'no-body': 'ответ без тела', 'har-compression': 'размер и сжатие из HAR',
            'content-length': 'заголовок Content-Length', identity: 'размер ответа без сжатия' };
        return `<details class="timeline-row" id="request-${row.id}">
            <summary>
                <span><span>${esc(row.name)}</span> <span class="badge owner-${ownerClass(row.owner.id)}">${esc(row.owner.title)}</span>
                    ${duplicates.has(row.id) ? '<span class="badge">Повторный запрос</span>' : ''}
                    ${row.cached ? '<span class="badge">Кэш</span>' : ''}
                    ${!row.beforeReady ? '<span class="badge">После готовности</span>' : ''}</span>
                <span>${ms(row.dur)} · ${row.cached ? 'из кэша' : bytes(row.encodedBytes)}</span>
                <span class="track"><span class="request-bar owner-${ownerClass(row.owner.id)}" style="left:${left}%;width:${right - left}%"></span><span class="marker-layer" aria-hidden="true">${markerLines(scale)}</span></span>
            </summary>
            <div class="request-details">
                <p class="mono">${esc(row.url)}</p>
                <p>${esc(network.method || row.method || 'Метод неизвестен')} · ${esc(network.status ?? row.status ?? 'Статус неизвестен')}
                    ${network.protocol ? `· ${esc(network.protocol)}` : ''}</p>
                <p>Принадлежность: ${esc(attribution[row.attribution])}. Распаковано: ${bytes(row.bytes)}; передано: ${row.cached ? '0 Б (кэш)' : bytes(row.encodedBytes)}.</p>
                ${row.encodedSizeSource ? `<p class="muted">Источник размера тела: ${esc(sizeSource[row.encodedSizeSource] || row.encodedSizeSource)}.</p>` : ''}
                ${row.end == null ? '<p>Запрос не завершён на момент снимка.</p>' : ''}
                ${timings ? `<ul class="phases">${timings}</ul>` : ''}
                ${frames.length ? `<div class="stack"><p>Стек инициатора:</p><ul>${frames.map((frame) => `
                    <li>${sourceLink(frame.url || frame.ownerUrl, frame.lineNumber, frame.columnNumber, frame.functionName || frame.url || frame.ownerUrl)}</li>`).join('')}</ul></div>` : ''}
            </div>
        </details>`;
    };
    const renderRequests = (model, showAfter, scale, series = false) => {
        const visible = [...model.rows].sort((a, b) => a.start - b.start);
        const duplicates = new Set(model.duplicates.flatMap((group) => group.rows));
        const typeTitles = { code: 'Код и стили', data: 'Данные', image: 'Изображения', font: 'Шрифты', document: 'Документы', other: 'Прочее' };
        const groups = Object.entries(typeTitles).map(([type, title]) => {
            const rows = visible.filter((row) => row.type === type);
            return rows.length ? `<section><h3>${title} · ${rows.length}</h3>
                ${rows.map((row) => renderRequest(row, scale, duplicates)).join('')}</section>` : '';
        }).join('');
        return `<section class="card"><h2>Запросы</h2>
            ${series ? '<p class="muted">Последний завершённый замер серии.</p>' : ''}
            ${model.report.config.scope === 'module' && model.moduleStart === null ? '<p class="muted">Начало загрузки модуля не определено; показан весь замер.</p>' : ''}
            <p class="muted">Шкала ${scale.start === model.moduleStart ? 'от первого файла модуля' : 'от начала измерения'} · ${ms(scale.end - scale.start)}${!showAfter && scale.end > model.end ? ' · продлена до LCP' : ''}</p>
            ${markerLegend(scale)}
            ${groups}${visible.length ? '' : '<p class="muted">Запросов нет.</p>'}
        </section>`;
    };
    const aggregateMetric = (label, value, format, caption = '', selector = false) => {
        const prefix = value.lowerBound && Number.isFinite(value.mean) ? '≥ ' : '';
        const coverage = value.known < value.total ? `Известно ${value.known} из ${value.total}. ` : '';
        const range = value.known > 1 ? `Диапазон: ${format(value.min)} — ${format(value.max)}.` : '';
        return metric(label, `${prefix}${format(value.mean)}`, `${coverage}${range}`.trim(), caption, selector);
    };
    const renderAverage = (state) => {
        const samples = state.samples;
        const stats = LoadSeries.summarize(samples);
        const module = state.config?.scope === 'module';
        const moduleTrafficIsCode = module && samples.every((sample) => sample.moduleTrafficIsCode === true);
        const sharedLcpSelector = samples.every((sample) => sample.lcpSelector && sample.lcpSelector === samples[0].lcpSelector)
            ? samples[0].lcpSelector : '';
        return `<div class="card dashboard-card"><h2>Среднее из ${samples.length} / 10 обновлений <span class="badge">Обычные измерения</span></h2>
            <div class="metrics">
                ${aggregateMetric('До готовности', stats.readyMs, ms)}
                ${module ? aggregateMetric('Первый файл', stats.firstFileMs, ms) : ''}
                ${module ? aggregateMetric('Модуль до готовности', stats.moduleMs, ms) : ''}
                ${aggregateMetric('Трафик страницы', stats.trafficBytes, bytes)}
                ${module ? aggregateMetric(moduleTrafficIsCode ? 'Трафик модуля (код и стили)' : 'Трафик модуля', stats.moduleTrafficBytes, bytes) : ''}
                ${!moduleTrafficIsCode ? aggregateMetric(module ? 'Код модуля' : 'Код страницы', stats.codeBytes, bytes) : ''}
                ${aggregateMetric('LCP', stats.lcpMs, ms, sharedLcpSelector || 'LCP-элементы указаны в замерах серии', Boolean(sharedLcpSelector))}
            </div><p class="muted">${esc(state.config?.name)} · Среднее рассчитано по доступным значениям. Знак ≥ означает неполные данные о размере.</p>
            <p class="mono">${esc(state.url)}</p>
        </div>`;
    };
    const sampleSize = (summary) => summary ? sizeSummary(summary) : 'Нет данных';
    const renderSeries = (state) => {
        const module = state.config?.scope === 'module';
        return `<div class="card"><details open><summary>Замеры серии · ${state.samples.length} из 10</summary>
            <table class="series-table"><thead><tr><th>№</th><th>До готовности</th>${module ? '<th>Модуль</th>' : ''}<th>Трафик</th><th>Код</th><th>LCP</th></tr></thead>
            <tbody>${state.samples.map((sample, index) => `<tr>
                <th scope="row" data-label="Замер">${index + 1}</th>
                <td data-label="До готовности">${ms(sample.readyMs)}</td>
                ${module ? `<td data-label="Модуль">${ms(sample.moduleMs)}</td>` : ''}
                <td data-label="Трафик">${sampleSize(sample.traffic)}</td>
                <td data-label="Код">${sampleSize(sample.code)}</td>
                <td data-label="LCP"><span>${ms(sample.lcpMs)}<br><small>${selectorCaption(sample.lcpSelector)}</small></span></td>
            </tr>`).join('')}</tbody></table>
        </details></div>`;
    };
    const render = (report, harEntries, { showAfter = false, showBefore = false } = {}, seriesState = null, sourcesReport = null) => {
        const results = document.getElementById('results');
        const dashboard = document.getElementById('dashboard');
        const seriesResults = document.getElementById('seriesResults');
        const mainModel = report ? LoadMeasurement.buildModel(report, harEntries) : null;
        const model = sourcesReport ? LoadMeasurement.buildModel(sourcesReport, []) : mainModel;
        const showSeries = Boolean(seriesState?.samples?.length);
        dashboard.innerHTML = showSeries ? renderAverage(seriesState) : mainModel ? renderReport(mainModel) : '';
        seriesResults.hidden = !showSeries;
        seriesResults.innerHTML = showSeries ? renderSeries(seriesState) : '';
        if (!model) {
            results.innerHTML = '<p class="muted">Нет данных измерения.</p>';
            return { model: null };
        }
        const scale = timeline(model, showAfter, showBefore);
        const rows = model.rows.filter((row) => row.start >= scale.start && (showAfter || row.beforeReady));
        const visibleIds = new Set(rows.map((row) => row.id));
        const visibleModel = { ...model, rows, duplicates: model.duplicates
            .map((group) => ({ ...group, rows: group.rows.filter((id) => visibleIds.has(id)) }))
            .filter((group) => group.rows.length > 1) };
        results.innerHTML = (sourcesReport ? '<p class="muted">Уточнённые запросы из отдельного прогона. Шкала и отметки относятся к нему; главные показатели — к основному замеру.</p>' : '')
            + renderFindings(visibleModel) + renderRequests(visibleModel, showAfter, scale, showSeries && !sourcesReport);
        return { model };
    };
    return { render };
})();
