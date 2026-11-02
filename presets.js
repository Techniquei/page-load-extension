/* Presets are global to the extension, independent of the current origin. */
const LoadPresets = (() => {
    const key = 'page-load-presets:v1';
    let queue = Promise.resolve();
    const copy = (value) => JSON.parse(JSON.stringify(value));
    const serial = (action) => {
        const result = queue.then(action);
        queue = result.catch(() => {});
        return result;
    };
    const read = async () => {
        const stored = (await chrome.storage.local.get(key))[key];
        if (stored === undefined) return [];
        if (!stored || stored.version !== 1 || !Array.isArray(stored.presets) || stored.presets.length > 50) {
            throw new Error('Не удалось прочитать библиотеку пресетов: неизвестный формат');
        }
        const ids = new Set(), names = new Set();
        try {
            return stored.presets.map((preset) => {
                if (!preset || typeof preset.id !== 'string' || !preset.id || typeof preset.name !== 'string'
                    || !preset.name.trim() || preset.name !== preset.name.trim() || preset.name.length > 80
                    || typeof preset.updatedAt !== 'number' || !Number.isFinite(preset.updatedAt)
                    || ids.has(preset.id) || names.has(preset.name.toLowerCase())) throw new Error();
                ids.add(preset.id);
                names.add(preset.name.toLowerCase());
                return { id: preset.id, name: preset.name, config: LoadMeasurement.normalizeConfig(preset.config), updatedAt: preset.updatedAt };
            });
        } catch {
            throw new Error('Не удалось прочитать библиотеку пресетов: повреждённые данные');
        }
    };
    const list = () => serial(async () => copy((await read()).sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))));
    const save = ({ id, name, config } = {}) => serial(async () => {
        const presets = await read();
        const title = typeof name === 'string' ? name.trim() : '';
        if (!title || title.length > 80) throw new Error('Название пресета должно содержать от 1 до 80 символов');
        const normalized = LoadMeasurement.normalizeConfig(config);
        const index = id === undefined ? -1 : presets.findIndex((preset) => preset.id === id);
        if (id !== undefined && index < 0) throw new Error('Пресет не найден');
        if (presets.some((preset) => preset.id !== id && preset.name.toLowerCase() === title.toLowerCase())) throw new Error('Пресет с таким названием уже существует');
        if (index < 0 && presets.length >= 50) throw new Error('Можно сохранить не более 50 пресетов');
        const preset = { id: index < 0 ? crypto.randomUUID() : id, name: title, config: normalized, updatedAt: Date.now() };
        if (index < 0) presets.push(preset); else presets[index] = preset;
        await chrome.storage.local.set({ [key]: { version: 1, presets } });
        return copy(preset);
    });
    const remove = (id) => serial(async () => {
        const presets = await read();
        const index = presets.findIndex((preset) => preset.id === id);
        if (index < 0) throw new Error('Пресет не найден');
        presets.splice(index, 1);
        await chrome.storage.local.set({ [key]: { version: 1, presets } });
    });
    return { list, save, remove };
})();
