// content.js
// Runs INSIDE tms35.nepsetms.com.np (the tab you logged into). It never logs
// in and never touches your password — it only acts in your existing session.
//
// Flow:
//   PHASE 1  On ARM, read the price to bid and place ONE buy order.
//   PHASE 2  Watch the order book; if the order is fully filled, stop.
//   PHASE 3  If the price rises, modify the open order up to the new price.
//            Repeat 2–3 until the order is completed.

const STATE = {
  armed: false,
  symbol: null,
  quantity: 0,
  capPrice: 0,     // optional ceiling; 0 = no cap (bid whatever the page shows)
  placed: false,   // has the initial order gone in?
  orderPrice: 0,   // price the open order currently sits at
  lastModify: 0,   // timestamp of last modify (cooldown)
  busy: false,     // re-entrancy guard
  timer: null,
};

const POLL_MS = 300;            // how often to check
const MODIFY_COOLDOWN_MS = 800; // minimum gap between modifications
const PRICE_STEP = 0.01;        // only modify if the price rises at least this much

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg, level = 'info') {
  console.log(`[NEPSE-TRIGGER] ${msg}`);
  chrome.storage.local.get({ log: [] }, (data) => {
    const next = [...data.log, { t: Date.now(), level, msg }].slice(-50);
    chrome.storage.local.set({ log: next });
  });
}
function setStatus(status) { chrome.storage.local.set({ status }); }

// TMS is a framework app, so set values the way a keystroke would and fire events.
function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, value); else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
}

// ============================================================
// TODO #1 — READ THE PRICE TO BID RIGHT NOW
// For chasing to do anything, point this at the LIVE price that
// actually moves (best ask / current price), NOT the fixed daily
// upper-circuit ceiling — a fixed ceiling never changes, so the
// chase would never trigger.
// ============================================================
function readTargetPrice() {
  const el = document.querySelector('SELECTOR_FOR_PRICE'); // <-- EDIT
  if (!el) return null;
  const n = parseFloat((el.textContent || el.value || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ============================================================
// TODO #2 — FILL THE ORDER FORM AND SUBMIT THE INITIAL BUY
// ============================================================
async function placeOrder(symbol, quantity, price) {
  const symEl = document.querySelector('SELECTOR_FOR_SYMBOL_INPUT'); // <-- EDIT
  if (symEl) setNativeValue(symEl, symbol);
  const qtyEl = document.querySelector('SELECTOR_FOR_QTY_INPUT'); // <-- EDIT
  if (qtyEl) setNativeValue(qtyEl, String(quantity));
  const priceEl = document.querySelector('SELECTOR_FOR_PRICE_INPUT'); // <-- EDIT
  if (priceEl) setNativeValue(priceEl, String(price));
  const submitBtn = document.querySelector('SELECTOR_FOR_BUY_SUBMIT'); // <-- EDIT
  if (!submitBtn) throw new Error('submit button not found');
  submitBtn.click();
}

// ============================================================
// TODO #3 — READ THE ORDER'S STATUS FROM THE ORDER BOOK
// Return 'filled' when complete, 'partial'/'open' while still
// working, or null if the row isn't found.
// ============================================================
function readOrderStatus() {
  const el = document.querySelector('SELECTOR_FOR_ORDER_STATUS'); // <-- EDIT
  if (!el) return null;
  const s = (el.textContent || '').trim().toLowerCase();
  if (s.includes('complet') || s.includes('fill')) return 'filled';
  if (s.includes('partial')) return 'partial';
  if (s.includes('open') || s.includes('pending')) return 'open';
  return s || null;
}

// ============================================================
// TODO #4 — MODIFY THE OPEN ORDER'S PRICE
// On most TMS this is: find the order row → click Modify/Edit →
// set the new price → submit. Fill in those selectors/steps.
// ============================================================
async function modifyOrder(newPrice) {
  const editBtn = document.querySelector('SELECTOR_FOR_MODIFY_BUTTON'); // <-- EDIT
  if (!editBtn) throw new Error('modify button not found');
  editBtn.click();
  await sleep(150); // let the modify form/modal open

  const priceEl = document.querySelector('SELECTOR_FOR_MODIFY_PRICE_INPUT'); // <-- EDIT
  if (!priceEl) throw new Error('modify price field not found');
  setNativeValue(priceEl, String(newPrice));

  const saveBtn = document.querySelector('SELECTOR_FOR_MODIFY_SAVE'); // <-- EDIT
  if (!saveBtn) throw new Error('modify save button not found');
  saveBtn.click();
}

async function tick() {
  if (!STATE.armed || STATE.busy) return;
  STATE.busy = true;
  try {
    // PHASE 1 — place once
    if (!STATE.placed) {
      const p = readTargetPrice();
      if (p == null) { setStatus('waiting — no price on page'); return; }
      let price = p;
      if (STATE.capPrice > 0) price = Math.min(p, STATE.capPrice);
      STATE.placed = true; // guard against double-placing
      setStatus(`placing ${STATE.symbol} x${STATE.quantity} @ ${price}`);
      try {
        await placeOrder(STATE.symbol, STATE.quantity, price);
        STATE.orderPrice = price;
        log(`ORDER PLACED ${STATE.symbol} x${STATE.quantity} @ ${price}`, 'go');
        setStatus(`placed @ ${price} — chasing`);
      } catch (e) {
        STATE.placed = false;
        log(`place failed: ${e.message}`, 'error');
        setStatus(`error — ${e.message}`);
      }
      return;
    }

    // PHASE 2 — completed?
    const status = readOrderStatus();
    if (status === 'filled') {
      log(`ORDER COMPLETED ${STATE.symbol} @ ${STATE.orderPrice}`, 'go');
      setStatus('completed');
      disarm();
      return;
    }

    // PHASE 3 — chase up if the price rose (and stay under the cap)
    const p = readTargetPrice();
    if (p == null) return;
    let target = p;
    if (STATE.capPrice > 0) target = Math.min(p, STATE.capPrice);

    if (target > STATE.orderPrice + PRICE_STEP) {
      if (Date.now() - STATE.lastModify < MODIFY_COOLDOWN_MS) return;
      setStatus(`price rose → modifying ${STATE.orderPrice} → ${target}`);
      try {
        await modifyOrder(target);
        STATE.orderPrice = target;
        STATE.lastModify = Date.now();
        log(`MODIFIED ${STATE.symbol} → ${target}`, 'go');
        setStatus(`modified @ ${target} — chasing`);
      } catch (e) {
        log(`modify failed: ${e.message}`, 'error');
        setStatus(`error — ${e.message}`);
      }
    }
  } finally {
    STATE.busy = false;
  }
}

function arm(p) {
  STATE.symbol = p.symbol;
  STATE.quantity = p.quantity;
  STATE.capPrice = p.maxPrice || 0;
  STATE.placed = false;
  STATE.orderPrice = 0;
  STATE.lastModify = 0;
  STATE.busy = false;
  STATE.armed = true;
  const capTxt = STATE.capPrice > 0 ? `cap ${STATE.capPrice}` : 'no cap';
  log(`ARMED ${STATE.symbol} x${STATE.quantity}, ${capTxt}`, 'go');
  setStatus('armed — placing');
  if (STATE.timer) clearInterval(STATE.timer);
  STATE.timer = setInterval(tick, POLL_MS);
}

function disarm() {
  STATE.armed = false;
  if (STATE.timer) clearInterval(STATE.timer);
  STATE.timer = null;
  log('DISARMED', 'warn');
  setStatus('disarmed');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ARM') arm(msg.payload);
  else if (msg.type === 'DISARM') disarm();
  else if (msg.type === 'PING') { sendResponse({ ok: true, armed: STATE.armed }); return; }
  return true;
});

log('loaded on ' + location.host);
setStatus('idle');
