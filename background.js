// DOM и Performance API остаются в isolated content script.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.source !== 'page-load-extension' || sender.id !== chrome.runtime.id
        || sender.tab || sender.url !== chrome.runtime.getURL('panel.html')) return;
    const action = message.type === 'page-info' ? () => chrome.tabs.get(message.tabId)
        : ['page-get', 'page-start', 'page-arm', 'page-cancel'].includes(message.type)
            ? () => chrome.tabs.sendMessage(message.tabId, message, { frameId: 0 })
            : message.type === 'preset-list' ? () => LoadPresets.list()
                : message.type === 'preset-save' ? () => LoadPresets.save(message.preset)
                    : message.type === 'preset-delete' ? () => LoadPresets.remove(message.id) : null;
    if (!action) return;
    Promise.resolve().then(action).then((result) => respond({ result }),
        (cause) => respond({ error: cause.message }));
    return true;
});

importScripts('measurement.js', 'presets.js', 'sources.js');
