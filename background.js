// background.js
// Minimal service worker. The real work happens in content.js, which lives
// inside your TMS page. This just resets the log/status on install so you
// start from a clean slate.

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ log: [], status: 'idle' });
});
