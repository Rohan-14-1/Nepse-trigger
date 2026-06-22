// popup.js — the control panel. Two actions:
//   ARM             → place an order, then chase the price up until filled
//   MODIFY EXISTING → don't place; just scan the Order Book and chase an
//                     order that's already there (placed by you)
// Commands go to the content script in your TMS tab; status/log come back via storage.

const $ = (id) => document.getElementById(id);
let armedMode = null; // null | 'place' | 'modify'

// Find the TMS tab by URL so commands always reach it. Falls back to active tab.
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
    showBanner('Reload the TMS page (the extension was updated), then try again.');
    return false;
  }
}

function showBanner(text) { const b = $('banner'); b.textContent = text; b.hidden = false; }
function hideBanner() { $('banner').hidden = true; }

async function start(mode) {
  const symbol = $('symbol').value.trim().toUpperCase();
  const quantity = parseInt($('quantity').value, 10) || 0;
  const maxPrice = parseFloat($('maxPrice').value) || 0; // 0 = auto (page max)

  if (mode === 'place') {
    if (!symbol) return showBanner('Enter a symbol.');
    if (!quantity) return showBanner('Enter a quantity.');
  }
  // 'modify' mode: symbol optional (blank = first open order in the book)

  const chaseOnly = mode === 'modify';
  const ok = await send('ARM', { symbol, quantity, maxPrice, chaseOnly });
  if (ok) { armedMode = mode; render(); }
}

async function stop() {
  await send('DISARM');
  armedMode = null;
  render();
}

function render() {
  const armBtn = $('armBtn');
  const modBtn = $('modifyBtn');

  armBtn.classList.toggle('is-armed', armedMode === 'place');
  modBtn.classList.toggle('is-armed', armedMode === 'modify');

  armBtn.textContent = armedMode === 'place' ? 'DISARM' : 'ARM';
  modBtn.textContent = armedMode === 'modify' ? 'STOP' : 'MODIFY EXISTING';

  // while one action runs, disable the other and lock the inputs
  armBtn.disabled = armedMode === 'modify';
  modBtn.disabled = armedMode === 'place';
  ['symbol', 'quantity', 'maxPrice'].forEach((id) => { $(id).disabled = !!armedMode; });
}

function paint({ log, status }) {
  $('status').textContent = status || 'idle';

  const dot = $('dot');
  if (armedMode) dot.dataset.state = 'armed';
  else if (/error/i.test(status)) dot.dataset.state = 'error';
  else if (/placed|modified|completed/i.test(status)) dot.dataset.state = 'placed';
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

$('armBtn').addEventListener('click', () => (armedMode === 'place' ? stop() : start('place')));
$('modifyBtn').addEventListener('click', () => (armedMode === 'modify' ? stop() : start('modify')));
$('clearBtn').addEventListener('click', () => chrome.storage.local.set({ log: [] }));

// ── Persist symbol, quantity, maxPrice across popup opens and page reloads ──
// Save whenever the user changes a field
['symbol', 'quantity', 'maxPrice'].forEach((id) => {
  $(id).addEventListener('input', () => {
    chrome.storage.local.set({
      savedInputs: {
        symbol:   $('symbol').value,
        quantity: $('quantity').value,
        maxPrice: $('maxPrice').value,
      }
    });
  });
});

// Restore saved values when popup opens
chrome.storage.local.get({ savedInputs: null }, (d) => {
  if (!d.savedInputs) return;
  if (d.savedInputs.symbol)   $('symbol').value   = d.savedInputs.symbol;
  if (d.savedInputs.quantity) $('quantity').value = d.savedInputs.quantity;
  if (d.savedInputs.maxPrice) $('maxPrice').value = d.savedInputs.maxPrice;
});

setInterval(poll, 500);
poll();

// Restore button state when the popup opens.
(async () => {
  const tab = await activeTab();
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
    if (r && r.armed) armedMode = r.chaseOnly ? 'modify' : 'place';
  } catch (e) { /* content script not on this tab */ }
  render();
})();