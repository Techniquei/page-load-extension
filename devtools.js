chrome.devtools.panels.create('page load extension', '', 'panel.html');
const connection = chrome.runtime.connect({ name: `page-load-devtools:${chrome.devtools.inspectedWindow.tabId}` });
connection.onDisconnect.addListener(() => { void chrome.runtime.lastError; });
