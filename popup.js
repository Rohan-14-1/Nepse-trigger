// popup.js — the control panel. It sends ARM/DISARM commands to the content
// script in your active tab and shows the live status/log it writes back.

const $ = (id) => document.getElementById(id);
let armed = false;

// Find the TMS tab by URL so commands always reach it, even if the popup's
// "current window" is something else. Falls back to the active tab.
async function activeTab() {
  try {
    const matches = await chrome.tabs.query({ url: 'https://tms35.nepsetms.com.np/*' });
    if (matches && matches.length) return matches.find((t) => t.active) || matches[0];
  } catch (e) { /* fall through */ }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(type, payload) {
  const tab = await activeTab();
  try {
    await chrome.tabs.sendMessage(tab.id, { type, payload });
    hideBanner();
    return true;
  } catch (e) {
    showBanner('Open your broker TMS tab first, then reopen this.');
    return false;
  }
}

function showBanner(text) {
  const b = $('banner');
  b.textContent = text;
  b.hidden = false;
}
function hideBanner() { $('banner').hidden = true; }

async function arm() {
  const symbol = $('symbol').value.trim().toUpperCase();
  const quantity = parseInt($('quantity').value, 10);
  const maxPrice = parseFloat($('maxPrice').value) || 0; // 0 = auto (page max)

  if (!symbol || !quantity) {
    showBanner('Fill in symbol and quantity. Max price is optional.');
    return;
  }
  const ok = await send('ARM', { symbol, quantity, maxPrice });
  if (ok) { armed = true; render(); }
}

async function disarm() {
  await send('DISARM');
  armed = false;
  render();
}

function render() {
  const btn = $('armBtn');
  btn.classList.toggle('is-armed', armed);
  btn.textContent = armed ? 'DISARM' : 'ARM';
  ['symbol', 'quantity', 'maxPrice'].forEach((id) => { $(id).disabled = armed; });
}

function paint({ log, status }) {
  $('status').textContent = status || 'idle';

  const dot = $('dot');
  if (armed) dot.dataset.state = 'armed';
  else if (/error/i.test(status)) dot.dataset.state = 'error';
  else if (/placed/i.test(status)) dot.dataset.state = 'placed';
  else dot.dataset.state = 'idle';

  const list = $('logList');
  list.innerHTML = '';
  (log || []).slice().reverse().forEach((e) => {
    const li = document.createElement('li');
    li.className = e.level || 'info';
    const ts = new Date(e.t).toLocaleTimeString([], { hour12: false });
    li.innerHTML = `<span class="ts">${ts}</span>${e.msg}`;
    list.appendChild(li);
  });
}

function poll() {
  chrome.storage.local.get({ log: [], status: 'idle' }, paint);
}

$('armBtn').addEventListener('click', () => (armed ? disarm() : arm()));
$('clearBtn').addEventListener('click', () => chrome.storage.local.set({ log: [] }));

setInterval(poll, 500);
poll();

// Sync the armed state from the content script when the popup opens.
(async () => {
  const tab = await activeTab();
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
    armed = !!(r && r.armed);
  } catch (e) { /* content script not present on this tab */ }
  render();
})();
