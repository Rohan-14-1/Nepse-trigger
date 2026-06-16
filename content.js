// content.js — auto-detecting. No hardcoded selectors, no console setup needed.
// It locates the HIGH price by its on-screen label and the Order Book by its
// column headers, so it adapts to the page on its own. Runs only inside the TMS
// tab you logged into; never logs in, never touches your password.

const STATE = {
  armed: false, symbol: null, quantity: 0, capPrice: 0, chaseOnly: false,
  placed: false, orderPrice: 0, lastModify: 0, busy: false, timer: null,
};
const POLL_MS = 300, MODIFY_COOLDOWN_MS = 800, PRICE_STEP = 0.01, POST_MODIFY_SETTLE_MS = 6000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// If an older copy of this script is still ticking in this page, stop it.
if (window.__NEPSE_TRIGGER_TIMER__) { try { clearInterval(window.__NEPSE_TRIGGER_TIMER__); } catch (e) {} }

function alive() { return !!(chrome.runtime && chrome.runtime.id); }
function log(msg, level = 'info') {
  console.log('[NEPSE-TRIGGER] ' + msg);
  if (!alive()) return;
  try {
    chrome.storage.local.get({ log: [] }, (d) => {
      try { chrome.storage.local.set({ log: [...d.log, { t: Date.now(), level, msg }].slice(-50) }); } catch (e) {}
    });
  } catch (e) {}
}
function setStatus(s) { if (!alive()) return; try { chrome.storage.local.set({ status: s }); } catch (e) {} }

const textOf = (el) => ((el && el.textContent) || '').trim();
const num = (s) => { const n = parseFloat(String(s).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : null; };
const attrText = (el) => {
  try {
    const g = (a) => (el.getAttribute && el.getAttribute(a)) || '';
    return (g('class') + ' ' + g('title') + ' ' + g('aria-label')).toLowerCase();
  } catch (e) { return ''; }
};
const visible = (el) => el && el.offsetParent !== null;

function setNativeValue(el, value) {
  // Step 1: focus so Angular marks the field as touched
  try { el.focus(); } catch (e) {}

  // Step 2: use the native setter to bypass Angular's value accessor
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const d = Object.getOwnPropertyDescriptor(proto, 'value');
  if (d && d.set) d.set.call(el, value); else el.value = value;

  // Step 3: fire the full Angular event sequence.
  // Angular listens to 'input' to update ngModel/formControl, then 'change'
  // and 'blur' to mark dirty/touched. KeyboardEvent with key='Enter' is also
  // needed for some Angular Material inputs that validate on keyup.
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: value, keyCode: 13 }));
  el.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true, key: value, keyCode: 13 }));
  el.dispatchEvent(new Event('blur',   { bubbles: true }));

  // Step 4: for Angular reactive forms, also try direct ngModel / __ngContext__
  // patching so the control's internal value matches what we set on the DOM.
  try {
    // Angular Ivy stores component context on __ngContext__
    const ctx = el.__ngContext__;
    if (ctx) {
      // Walk the context array looking for a control with .setValue()
      const arr = Array.isArray(ctx) ? ctx : Object.values(ctx);
      for (const item of arr) {
        if (item && typeof item.setValue === 'function') {
          item.setValue(value, { emitEvent: true, emitModelToViewChange: true });
          break;
        }
      }
    }
  } catch (e) {}
}

// ---------- PRICE: find a stat value by its exact label (e.g. "HIGH") ----------
function leafLabels(label) {
  const want = label.toUpperCase();
  return [...document.querySelectorAll('th,td,div,span,label,p,b,strong')]
    .filter((el) => el.children.length === 0 && textOf(el).toUpperCase() === want);
}
function valueForLabel(label) {
  for (const el of leafLabels(label)) {
    const sib = el.nextElementSibling;                       // A) value right after label
    if (sib) { const v = num(textOf(sib)); if (v != null) return v; }
    const p = el.parentElement;                              // B) labels row + values row
    if (p) {
      const idx = [...p.children].indexOf(el);
      const prow = p.nextElementSibling;
      if (prow && prow.children[idx]) { const v = num(textOf(prow.children[idx])); if (v != null) return v; }
    }
    let w = el;                                              // C) scan following siblings
    for (let i = 0; i < 6 && w; i++) { w = w.nextElementSibling; if (w) { const v = num(textOf(w)); if (v != null) return v; } }
  }
  return null;
}
function readTargetPrice() { return valueForLabel('HIGH'); }

// ---------- ORDER BOOK: find table(s) by headers, read rows by column ----------
// Angular TMS renders the order book as a <table> with <th> headers but the
// actual <tr>/<td> data rows are injected inside custom Angular component tags
// (e.g. <cdk-row>, <ng-container>) that sit as siblings to the <table> or
// inside a wrapper <div>. So we look for headers in <th> elements anywhere on
// the page, then walk UP to a common container and scan ALL <tr>/<td> rows in
// that container — not just inside the <table> tag itself.
function findOrderTables() {
  return [...document.querySelectorAll('table')].filter((t) => {
    const h = [...t.querySelectorAll('th')].map((x) => textOf(x).toUpperCase());
    return h.some((x) => x.includes('STATUS')) && h.some((x) => x.includes('SYMBOL'));
  });
}
function findOrderTable() { return findOrderTables()[0]; }
function headerMap(table) {
  const m = {};
  [...table.querySelectorAll('th')].forEach((h, i) => {
    const t = textOf(h).toUpperCase();
    if (t.includes('ACTION') && m.action == null) m.action = i;
    if (t.includes('STATUS') && m.status == null) m.status = i;
    if (t.includes('SYMBOL') && m.symbol == null) m.symbol = i;
    if (t.includes('PRICE') && m.price == null) m.price = i;
  });
  return m;
}
// Returns data rows from the order book table. Handles:
// 1) Standard HTML tables with <tbody><tr><td>
// 2) Angular Material/CDK tables where <td mat-cell> elements share a parent
//    element (tr/div/custom) with no standard tbody structure.
// Strategy: find all <td> cells in/around the table, group by their immediate
// parent — each unique parent with 2+ cells is one data row.
function tableContainer(table) {
  // Walk up to find a container that holds the actual cell elements
  let el = table;
  for (let i = 0; i < 8; i++) {
    if (el.querySelectorAll('td').length > 0) return el;
    if (el.querySelectorAll('[role="cell"],[role="gridcell"]').length > 0) return el;
    if (!el.parentElement) break;
    el = el.parentElement;
  }
  return table.parentElement || table;
}
const bodyRows = (table) => {
  const container = tableContainer(table);

  // 1) Standard: <tbody tr> with <td> children
  let rows = [...container.querySelectorAll('tbody tr')].filter(r => r.querySelectorAll('td').length > 1);
  if (rows.length) return rows;

  // 2) Any <tr> with <td> children (no tbody)
  rows = [...container.querySelectorAll('tr')].filter(r => r.querySelectorAll('td').length > 1);
  if (rows.length) return rows;

  // 3) Angular Material mat-table: <td mat-cell> elements share a <tr mat-row> parent.
  //    Group all <td> cells by their immediate parent element — each parent = one row.
  const allCells = [...container.querySelectorAll('td')];
  if (allCells.length) {
    const parentMap = new Map();
    allCells.forEach(td => {
      const p = td.parentElement;
      if (!p) return;
      if (!parentMap.has(p)) parentMap.set(p, []);
      parentMap.get(p).push(td);
    });
    rows = [...parentMap.entries()]
      .filter(([, cells]) => cells.length > 1)
      .map(([parent]) => parent);
    if (rows.length) return rows;
  }

  // 4) Angular CDK role="row" elements
  rows = [...container.querySelectorAll('[role="row"]')]
    .filter(r => r.querySelectorAll('[role="cell"],[role="gridcell"],td').length > 0);
  if (rows.length) return rows;

  return [];
};
const cellText = (row, idx) => {
  // Support standard <td>, Angular CDK role="cell"/"gridcell", cdk-cell, mat-cell
  const cells = [...row.querySelectorAll('td,[role="cell"],[role="gridcell"],cdk-cell,mat-cell')];
  const td = cells[idx];
  return td ? textOf(td) : '';
};
function rowOpen(row, m) {
  const s = (cellText(row, m.status) || '').toLowerCase();
  return !(s.includes('complet') || s.includes('fill') || s.includes('cancel') || s.includes('reject'));
}
function findOrderRow(symbol) {
  // Always target the FIRST (topmost) open order matching the symbol.
  // If multiple open orders exist for the same symbol, only row #1 is chased.
  // This prevents duplicate modifies when old test orders are still in the book.
  for (const table of findOrderTables()) {
    const m = headerMap(table);
    const rows = bodyRows(table);
    if (!rows.length) continue;
    for (const row of rows) {
      if (!rowOpen(row, m)) continue;
      const rowSym = (cellText(row, m.symbol) || '').toUpperCase();
      if (symbol && !rowSym.includes(symbol)) continue;
      return { row, m }; // return the very first matching open row and stop
    }
  }
  return null;
}
// One-shot diagnostic: describe every candidate table so a failure is debuggable
// from the log alone (headers, row counts, and the first row's cell values).
function diagnoseOrderBook() {
  const tables = findOrderTables();
  if (!tables.length) {
    const all = [...document.querySelectorAll('table')].map((t) =>
      '[' + [...t.querySelectorAll('th')].map(textOf).join(',') + ']');
    return 'no STATUS+SYMBOL table among ' + tables.length + '/' + all.length + ' tables: ' + all.join(' ');
  }
  return tables.map((t, i) => {
    const h = [...t.querySelectorAll('th')].map(textOf);
    const rows = bodyRows(t);
    const container = tableContainer(t);
    const tbodyOnly = [...t.querySelectorAll('tbody tr')].filter((r) => r.querySelectorAll('td').length > 1).length;
    const containerTag = container.tagName + (container.id ? '#' + container.id : '');
    let row0 = '';
    if (rows.length) row0 = ' row0=[' + [...rows[0].querySelectorAll('td,[role="cell"],[role="gridcell"]')].map(textOf).join('|') + ']';
    return `#${i} h=[${h}] rows=${rows.length}(tbody=${tbodyOnly}) container=${containerTag}${row0}`;
  }).join(' || ');
}
function readOrder(o) {
  return { price: num(cellText(o.row, o.m.price)), status: (cellText(o.row, o.m.status) || '').toLowerCase() };
}

// ---------- MODIFY: click the row's edit icon, set price in the dialog, save ----------
function findEditControl(cell) {
  const clicks = [...cell.querySelectorAll('button,a,i,span,svg,img,[role="button"]')];
  // 1) Attributes (class / title / aria-label) contain an edit-like word
  let e = clicks.find((c) => /edit|modif|pencil|pen/.test(attrText(c)));
  if (e) return e;
  // 2) Text content is an icon name (Material Icons: <span class="material-icons">edit</span>)
  e = clicks.find((c) => /^(edit|create|mode_edit|pencil|modify)$/.test((c.textContent || '').trim().toLowerCase()));
  if (e) return e;
  // 3) Fallback: first clickable that is NOT a cancel / delete icon
  e = clicks.find((c) => {
    const combined = attrText(c) + ' ' + (c.textContent || '').toLowerCase();
    return !/cancel|delet|reject|trash|close|ban|remove|block/.test(combined);
  });
  return e || clicks[0];
}
// True once the page shows the "Modifying Order # N" badge (i.e. the BUY
// button is now acting as Save-modify, not Place-new-order).
function inModifyMode() {
  // 1) Real TMS: the URL changes to include mode=Modify when editing an order.
  if (/mode=Modify/i.test(location.href)) return true;
  // 2) Test page (a.html): mod-strip element shown via "show" class.
  const strip = document.getElementById('mod-strip');
  if (strip && strip.classList && strip.classList.contains('show')) return true;
  // 3) Generic fallback: any visible element whose text contains "Modifying Order".
  return [...document.querySelectorAll('div,span,p,b,strong,button,a')]
    .some((el) => visible(el) && /modifying order/i.test(el.textContent || ''));
}

async function modifyOrderRow(o, newPrice) {
  const cell = [...o.row.querySelectorAll('td,[role="cell"],[role="gridcell"],cdk-cell,mat-cell')][o.m.action];
  if (!cell) throw new Error('action cell not found');
  const edit = findEditControl(cell);
  if (!edit) throw new Error('Modify icon not found in action cell');
  clickEl(edit);  // clicking the pencil loads the order into the form

  // Wait up to ~1.5 s for the page to enter "Modifying Order # N" mode AND
  // for the price field to appear and be populated (SPA re-render).
  let pr = null;
  for (let i = 0; i < 10; i++) {
    await sleep(150);
    pr = inputForLabel('PRICE');
    if (inModifyMode() && pr && num(pr.value) != null && num(pr.value) > 0) break;
  }
  if (!inModifyMode()) throw new Error('did not enter Modifying-Order mode — edit icon may be wrong');
  if (!pr) throw new Error('price box not found after clicking Edit');

  // Try setting the price up to 3 times — Angular reactive forms sometimes
  // need a moment to attach their value accessor before setNativeValue works.
  let stuck = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    setNativeValue(pr, String(newPrice));
    await sleep(200);
    if (num(pr.value) && num(pr.value) > 0) { stuck = true; break; }
    // Field still shows 0 — click into it first, then retry
    try { pr.click(); pr.focus(); } catch (e) {}
    await sleep(150);
  }
  if (!stuck) throw new Error('modify price did not stick: ' + pr.value);

  // Re-check we're still in modify mode right before submitting (guards against
  // the form resetting back to "new order" between the checks above and now).
  if (!inModifyMode()) throw new Error('left Modifying-Order mode before submit — aborting to avoid a new order');

  // In modify mode the BUY button itself acts as Save; prefer an explicit
  // update/save/modify button if the page has one, else fall back to BUY —
  // but ONLY because we've verified inModifyMode() above.
  const submit = findSubmitButton('update|modif|save|confirm') || findBuyButton();
  if (!submit) throw new Error('update/save button not found');
  clickEl(submit);
}

// Re-load a symbol into the form so the HIGH price is readable (placing/modifying
// clears the form). No-op if it's already loaded.
async function ensureSymbolLoaded(symbol) {
  if (!symbol) return;
  symbol = symbol.toUpperCase();
  const sym = inputForLabel('SYMBOL');
  const current = sym ? (sym.value || '').trim().toUpperCase() : '';
  if (sym && current !== symbol) {
    setNativeValue(sym, symbol);
    sym.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
    await selectSymbolSuggestion(symbol);
    await sleep(300);
  }
}

// ---------- PLACE: fill the order form by labels, click BUY ----------
function inputForLabel(label) {
  const want = label.toUpperCase();
  const labels = [...document.querySelectorAll('th,td,div,span,label,p,b,strong')]
    .filter((el) => el.children.length === 0 && textOf(el).toUpperCase().startsWith(want));
  for (const el of labels) {
    let scope = el.parentElement;
    for (let i = 0; i < 4 && scope; i++) {
      const inp = scope.querySelector('input, select');
      if (inp) return inp;
      scope = scope.parentElement;
    }
  }
  return null;
}
function findBuyButton() {
  return [...document.querySelectorAll('button')].filter(visible).find((b) => textOf(b).toUpperCase() === 'BUY');
}
function findSubmitButton(pattern) {
  const re = new RegExp(pattern, 'i');
  return [...document.querySelectorAll('button,input[type=submit]')].filter(visible)
    .find((b) => re.test(textOf(b) || b.value || ''));
}
// The form only shows a BUY submit button after the SELL/BUY toggle is on BUY.
function buyLabels() {
  return [...document.querySelectorAll('span,label,div,p,b,strong')].filter(visible)
    .filter((e) => e.children.length === 0 && textOf(e).toUpperCase() === 'BUY');
}
function fireMouse(el, type) {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, view: window,
    clientX: r.left + r.width * 0.75, clientY: r.top + r.height / 2,
  }));
}
function clickEl(el) {
  if (!el) return;
  // Only mousedown/mouseup here — do NOT also dispatch a synthetic 'click'
  // MouseEvent. el.click() below already dispatches one real 'click' event,
  // which is what triggers onclick="..." handlers. Dispatching both would
  // call onclick handlers TWICE per "click" (e.g. submitOrder() running
  // twice — once to save a modify, once more as a brand-new order with the
  // still-populated form fields).
  fireMouse(el, 'mousedown'); fireMouse(el, 'mouseup');
  try { el.click(); } catch (e) {}
}
// The SELL/BUY toggle sits visually between the SELL and BUY labels. Find it by
// position (robust to whatever class names the page uses) and click its BUY side.
function findSellBuyToggle() {
  const leaves = [...document.querySelectorAll('span,label,div,p,b,strong')].filter(visible);
  const sell = leaves.find((e) => e.children.length === 0 && textOf(e).toUpperCase() === 'SELL');
  const buy = leaves.find((e) => e.children.length === 0 && textOf(e).toUpperCase() === 'BUY');
  if (!sell || !buy) return null;
  const sr = sell.getBoundingClientRect(), br = buy.getBoundingClientRect();
  if (Math.abs((sr.top + sr.bottom) / 2 - (br.top + br.bottom) / 2) > 30) return null;
  const x = (sr.right + br.left) / 2;
  const y = (sr.top + sr.bottom + br.top + br.bottom) / 4;
  return document.elementFromPoint(x, y);
}
async function ensureBuySide() {
  if (findBuyButton()) return true;            // already on BUY — BUY button present
  const toggle = findSellBuyToggle();          // click the slider between SELL and BUY
  if (toggle) { clickEl(toggle); await sleep(350); if (findBuyButton()) return true; }
  clickEl(buyLabels()[0]); await sleep(350);   // last resort: click the BUY label
  return !!findBuyButton();
}
// The SYMBOL box is a typeahead — after typing we must click the suggestion.
async function selectSymbolSuggestion(symbol) {
  await sleep(450); // wait for the dropdown to appear
  const re = new RegExp('^' + symbol + '\\b', 'i');
  const opt = [...document.querySelectorAll('li,[role="option"],.dropdown-item,a,span,div,td')]
    .filter(visible)
    .filter((e) => { const t = textOf(e); return t.length < 80 && re.test(t); })
    .sort((a, b) => textOf(a).length - textOf(b).length)[0];
  if (opt) { clickEl(opt); await sleep(150); return true; }
  return false;
}
async function placeOrder(symbol, quantity, capPrice) {
  // 1) Load the symbol FIRST — this is what makes the HIGH price appear.
  const sym = inputForLabel('SYMBOL');
  const current = sym ? (sym.value || '').trim().toUpperCase() : '';
  if (sym && symbol && current !== symbol) {
    setNativeValue(sym, symbol);
    sym.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
    const picked = await selectSymbolSuggestion(symbol);
    if (!picked) throw new Error('could not pick ' + symbol + ' from the dropdown');
  }
  // 2) Wait for HIGH to load for this symbol, then read it.
  let high = null;
  for (let i = 0; i < 12 && high == null; i++) { high = readTargetPrice(); if (high == null) await sleep(150); }
  if (high == null) throw new Error('HIGH not showing — is the symbol loaded?');
  let price = high;
  if (capPrice > 0) price = Math.min(high, capPrice);
  // 3) Switch to the BUY side so the BUY button (and active fields) appear.
  if (!(await ensureBuySide())) throw new Error('no BUY button — flip the toggle to BUY');
  // 4) Fill quantity and price AFTER switching side, so nothing resets them.
  const qty = inputForLabel('QTY'); if (qty) setNativeValue(qty, String(quantity));
  const pr = inputForLabel('PRICE'); if (pr) setNativeValue(pr, String(price));
  await sleep(120);
  // 5) Verify they actually stuck — never fire a zero-price order.
  const gotPrice = pr ? num(pr.value) : null;
  const gotQty = qty ? num(qty.value) : null;
  if (!gotPrice || gotPrice <= 0) throw new Error('price box stayed ' + (pr ? pr.value : 'missing'));
  if (!gotQty || gotQty <= 0) throw new Error('quantity box not set');
  // 6) Click BUY.
  const buy = findBuyButton();
  if (!buy) throw new Error('BUY button not found');
  buy.click();
  return price;
}

// ---------- self-check: logs what it can see, so you can confirm without console ----------
function selfTest() {
  const high = readTargetPrice();
  const table = findOrderTable();
  const rows = table ? bodyRows(table).length : 0;
  log(`detect: HIGH=${high == null ? '?' : high}, order table=${table ? 'yes' : 'no'}, rows=${rows}`,
      (high != null && table) ? 'go' : 'warn');
}

async function tick() {
  if (!alive()) {                  // extension was reloaded; this copy is dead
    if (STATE.timer) { clearInterval(STATE.timer); STATE.timer = null; }
    STATE.armed = false;
    return;
  }
  if (!STATE.armed || STATE.busy) return;
  STATE.busy = true;
  try {
    if (!STATE.placed) {
      STATE.placed = true;
      setStatus(`placing ${STATE.symbol} x${STATE.quantity}…`);
      try {
        const price = await placeOrder(STATE.symbol, STATE.quantity, STATE.capPrice);
        STATE.orderPrice = price; STATE.placeFails = 0;
        log(`ORDER PLACED ${STATE.symbol} x${STATE.quantity} @ ${price}`, 'go');
        setStatus(`placed @ ${price} — chasing`);
        // Remember that the order is already in the book, so if the page
        // reloads, resume in chase-only mode instead of placing another one.
        if (alive()) {
          try {
            chrome.storage.local.get({ armedState: null }, (d) => {
              if (d.armedState) {
                chrome.storage.local.set({ armedState: { ...d.armedState, chaseOnly: true, hasPlacedOrder: true } });
              }
            });
          } catch (e) {}
        }
      } catch (e) {
        STATE.placed = false;
        STATE.placeFails = (STATE.placeFails || 0) + 1;
        log(`place failed: ${e.message}`, 'error');
        setStatus(`error — ${e.message}`);
        if (STATE.placeFails >= 4) {
          log('stopping — fix setup, then ARM again', 'warn');
          disarm();
        }
      }
      return;
    }

    const o = findOrderRow(STATE.symbol);
    if (!o) {
      setStatus('waiting — order not found in book');
      if (!STATE.diagnosed) { STATE.diagnosed = true; log('diag: ' + diagnoseOrderBook(), 'warn'); }
      return;
    }
    STATE.diagnosed = false; // reset so a future loss of the row logs diagnostics again
    const { price, status } = readOrder(o);
    // Only update orderPrice from the book when not in post-modify settle period,
    // to avoid using stale prices that haven't refreshed yet after a modify.
    const settled = (Date.now() - STATE.lastModify) > MODIFY_COOLDOWN_MS;
    if (price != null && (STATE.orderPrice === 0 || settled)) {
      if (STATE.orderPrice === 0) log(`tracking order @ ${price}`, 'go');
      STATE.orderPrice = price;
    }
    if (status.includes('complet') || status.includes('fill')) {
      log(`ORDER COMPLETED @ ${STATE.orderPrice}`, 'go'); setStatus('completed'); disarm(); return;
    }

    // HIGH needs the symbol loaded in the form (placing clears it) — reload if missing.
    const orderSym = STATE.symbol || cellText(o.row, o.m.symbol);
    let p = readTargetPrice();
    if (p == null) { await ensureSymbolLoaded(orderSym); p = readTargetPrice(); }
    if (p == null) { setStatus('chasing — waiting for HIGH'); return; }

    let target = p; if (STATE.capPrice > 0) target = Math.min(p, STATE.capPrice);
    const base = price != null ? price : STATE.orderPrice;
    setStatus(`chasing ${orderSym} @ ${base} (HIGH ${p})`);
    if (target > base + PRICE_STEP) {
      if (Date.now() - STATE.lastModify < MODIFY_COOLDOWN_MS) return;
      setStatus(`price rose → modifying ${base} → ${target}`);
      try {
        await modifyOrderRow(o, target);
        STATE.orderPrice = target;
        // Use a longer settle time after modify — the TMS page reloads after
        // each modify and the order book briefly shows rows=0 with stale prices.
        // Without this, the next tick fires immediately, reads stale data, and
        // triggers a duplicate modify at price=0 (causing the red TMS error).
        STATE.lastModify = Date.now() + POST_MODIFY_SETTLE_MS - MODIFY_COOLDOWN_MS;
        // Persist lastModify so that if the page reloads (which it does after
        // every modify on the real TMS), the auto-resume won't immediately fire
        // another modify before the settle period has elapsed.
        if (alive()) { try { chrome.storage.local.get({ armedState: null }, (d) => { if (d.armedState) chrome.storage.local.set({ armedState: { ...d.armedState, lastModify: STATE.lastModify } }); }); } catch(e) {} }
        log(`MODIFIED → ${target}`, 'go'); setStatus(`modified @ ${target} — settling`);
      } catch (e) { log(`modify failed: ${e.message}`, 'error'); setStatus(`error — ${e.message}`); }
    }
  } finally { STATE.busy = false; }
}

function arm(p, resumed) {
  STATE.symbol = (p.symbol || '').toUpperCase();
  STATE.quantity = p.quantity || 0;
  STATE.capPrice = p.maxPrice || 0;
  STATE.chaseOnly = !!p.chaseOnly;
  STATE.placed = STATE.chaseOnly;
  STATE.orderPrice = 0; STATE.lastModify = p._lastModify || 0; STATE.busy = false; STATE.placeFails = 0; STATE.diagnosed = false; STATE.armed = true;
  const mode = STATE.chaseOnly ? 'CHASE-ONLY' : 'PLACE+CHASE';
  const capTxt = STATE.capPrice > 0 ? `cap ${STATE.capPrice}` : 'no cap';
  log(`${resumed ? 'RE-ARMED after reload' : 'ARMED'} [${mode}] ${STATE.symbol || '(any)'} ${STATE.chaseOnly ? '' : 'x' + STATE.quantity + ', '}${capTxt}`, 'go');
  // Persist so a page reload (e.g. the TMS reloading itself after an action)
  // can automatically resume the chase instead of silently going idle.
  if (alive()) {
    try {
      chrome.storage.local.set({
        armedState: {
          symbol: p.symbol || '', quantity: p.quantity || 0,
          maxPrice: p.maxPrice || 0, chaseOnly: !!p.chaseOnly,
        },
      });
    } catch (e) {}
  }
  selfTest();
  setStatus(STATE.chaseOnly ? 'armed — finding your order' : 'armed — placing');
  if (STATE.timer) clearInterval(STATE.timer);
  STATE.timer = setInterval(tick, POLL_MS);
  window.__NEPSE_TRIGGER_TIMER__ = STATE.timer;
}
function disarm() {
  STATE.armed = false;
  if (STATE.timer) clearInterval(STATE.timer);
  STATE.timer = null;
  window.__NEPSE_TRIGGER_TIMER__ = null;
  if (alive()) { try { chrome.storage.local.remove('armedState'); } catch (e) {} }
  log('DISARMED', 'warn'); setStatus('disarmed');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ARM') arm(msg.payload);
  else if (msg.type === 'DISARM') disarm();
  else if (msg.type === 'PING') { sendResponse({ ok: true, armed: STATE.armed, chaseOnly: STATE.chaseOnly }); return; }
  return true;
});

log('loaded on ' + location.host);
setTimeout(selfTest, 1500); // give the page a moment, then report what it sees
setStatus('idle');

// ---------- RESUME AFTER RELOAD ----------
// If the page reloaded (or you reloaded it) while armed, the in-memory STATE
// above was wiped. Check storage for a saved armedState and, if present,
// automatically re-arm so the chase keeps going without manual intervention.
// If an order was already placed before the reload, force chase-only so we
// don't place a second order.
if (alive()) {
  try {
    chrome.storage.local.get({ armedState: null }, (d) => {
      const a = d.armedState;
      if (!a) return;
      // Give the SPA a moment to finish rendering the order book / form
      // before we start reading prices and clicking things.
      setTimeout(() => {
        arm({
          symbol: a.symbol, quantity: a.quantity, maxPrice: a.maxPrice,
          chaseOnly: a.chaseOnly || a.hasPlacedOrder,
          // Restore the lastModify timestamp so the settle cooldown survives reload
          _lastModify: a.lastModify || 0,
        }, true);
      }, 1200);
    });
  } catch (e) {}
}