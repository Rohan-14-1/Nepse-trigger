# NEPSE Order Trigger — starter extension

A small Manifest V3 Chrome/Edge/Brave extension that runs **inside the TMS tab you
log into yourself**. You enter a symbol, quantity, and a price cap, hit **ARM**, and
it watches the live price on the page and fires a buy order the instant the price is
at or below your cap. No automated login, no password handling — it only acts inside
the session you already opened.

This is a **skeleton**. It will not place orders until you fill in three broker-specific
spots, because those live behind your login and differ for every broker.

---

## The edits you must make

### 1. Point it at your broker (`manifest.json`)
Both occurrences already use `tms35.nepsetms.com.np`. If your broker number
changes, update both to match the URL in your address bar when logged in.

### 2. Read the max / upper-circuit price (`content.js` → TODO #1)
Right-click the number on the page that shows the highest allowed buy price for a
symbol → **Inspect** → put a unique selector in `readMaxPrice()`. Leave the
Max-price box in the panel blank and the bot bids this value; fill it to set a
lower safety cap.

### 3. Fill the order form + submit (`content.js` → TODO #2)
Inspect each control on the order-entry form and fill in the selectors for the
Symbol box, Quantity box, Price box, and the BUY/submit button.

### 4. Read the order status (`content.js` → TODO #3)
Point `readOrderStatus()` at the status cell of your order in the Order Book so the
bot knows when it's filled and can stop chasing.

### 5. Modify the order (`content.js` → TODO #4)
Fill in the Modify/Edit button, the modify price field, and the Save button so the
bot can raise the order's price as the market rises.

## How the chase works
1. On ARM it places one buy order at the price it reads.
2. It then watches the Order Book. If the order is fully filled, it stops.
3. If the price rises, it modifies the open order up to the new price, and repeats
   until the order is completed.

Guards built in: it only modifies when the price rises by at least `PRICE_STEP`,
waits `MODIFY_COOLDOWN_MS` between modifications, never bids above your cap, and
won't run two actions at once.

**Trade-off to know:** on most exchanges, changing an order's price moves it to the
**back of the queue** at the new price — so chasing keeps you matchable at a higher
price but can cost you the time-priority you had. It also only triggers if the price
you read in TODO #1 actually moves; a fixed daily upper-circuit ceiling never does.

---

## Load it

1. Go to `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Log into your TMS, then click the extension icon to open the panel.

---

## Notes before you trust it with money

- **Test small.** Use the smallest possible quantity until you've seen it fire
  correctly several times. A bug here places real orders fast.
- **The price cap is your safety line.** It never buys above the number you set.
- **`POLL_MS`** in `content.js` controls how often it checks the price. Faster reaction
  means more page load and more automated-looking traffic.
- **Reality check.** Your speed edge ends at the network. During big rushes the TMS
  itself often overloads, and then no client is fast — a bot improves your odds, it
  doesn't guarantee a fill.
- **Terms.** Automating order placement is a grey area under SEBON and is very likely
  against your broker's TMS terms of use. The realistic risk is the broker freezing
  the account if they notice. Decide if that trade-off is worth it before you rely on it.
