const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const config = () => ({ scope: 'module', name: 'Модуль', codePatterns: ['/module/'], resourcePatterns: [], actionSelector: '', ready: { kind: 'mark', value: 'ready' } });
const store = () => {
    const data = {};
    return { data, local: {
        async get(key) { await Promise.resolve(); return { [key]: structuredClone(data[key]) }; },
        async set(values) { await Promise.resolve(); Object.assign(data, structuredClone(values)); },
    } };
};
const load = (storage) => {
    const context = vm.createContext({ URL, chrome: { storage }, crypto: { randomUUID } });
    for (const file of ['measurement.js', 'presets.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
    return vm.runInContext('LoadPresets', context);
};

test('presets persist across worker contexts and support create, update and delete', async () => {
    const storage = store(), api = load(storage);
    const first = await api.save({ name: '  Рабочий  ', config: config() });
    assert.equal(first.name, 'Рабочий');
    const secondWorker = load(storage);
    assert.equal((await secondWorker.list())[0].id, first.id);
    await secondWorker.save({ id: first.id, name: 'Другой', config: config() });
    assert.equal((await api.list())[0].name, 'Другой');
    await api.remove(first.id);
    assert.equal((await api.list()).length, 0);
    await assert.rejects(api.remove(first.id), /не найден/);
});

test('invalid updates, duplicates and malformed libraries do not overwrite stored data', async () => {
    const storage = store(), api = load(storage);
    const first = await api.save({ name: 'Рабочий', config: config() });
    const before = JSON.stringify(storage.data);
    await assert.rejects(api.save({ name: 'рабочий', config: config() }), /уже существует/);
    await assert.rejects(api.save({ id: first.id, name: 'X', config: { ...config(), codePatterns: [] } }));
    await assert.rejects(api.save({ id: 'missing', name: 'X', config: config() }), /не найден/);
    assert.equal(JSON.stringify(storage.data), before);
    storage.data['page-load-presets:v1'] = { version: 99, presets: [] };
    await assert.rejects(api.save({ name: 'X', config: config() }), /формат/);
    assert.equal(storage.data['page-load-presets:v1'].version, 99);
});

test('concurrent saves are serialized without losing either preset', async () => {
    const storage = store(), api = load(storage);
    await Promise.all([api.save({ name: 'Один', config: config() }), api.save({ name: 'Два', config: config() })]);
    const list = await api.list();
    assert.deepEqual(Array.from(list, (item) => item.name).sort(), ['Два', 'Один']);
    list[0].config.ready.value = 'changed';
    assert.equal((await api.list()).some((item) => item.config.ready.value === 'changed'), false);
});
