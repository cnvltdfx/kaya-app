// Sales dashboard view for the report-dashboard Lambda.
//   select(ds, state)               the figures every sales visual shows, for one period and market
//   renderSales / renderInventory   those figures as HTML
//   boot(document)                  in the browser: redraws the sales sheet when a filter changes, adds tooltips
// The same file runs in the Lambda, which writes the page's first view (dashboard.mjs), and in the browser,
// inlined into that page. So it has no imports and only touches the DOM inside boot(). dashboard.mjs checks
// that it never contains a closing script tag or an HTML comment opener, either of which would break the page.

const MINUTE = 6e4;
const HOUR = 36e5;
export const DAY = 864e5;
const SGT = 8 * HOUR; // Asia/Singapore is UTC+8 all year

export const MAX_DAYS = 90; // the longest period; the dataset covers twice this, for its comparison
export const PERIODS = [['today', 'Today'], [7, '7 days'], [30, '30 days'], [90, '90 days']];
export const DEFAULT_STATE = { sheet: 'sales', period: 30, market: 'ALL' };

// In pipeline order: the order-status bar and its colour ramp follow it.
export const STATUS_LABELS = { pending_payment: 'Awaiting payment', processing: 'Processing', ready_for_pickup: 'Ready for pickup', shipped: 'Shipped', delivered: 'Delivered' };
const PAYMENT_LABELS = { card: 'Card', paynow: 'PayNow', applepay: 'Apple Pay' };
const FULFILMENT_LABELS = { delivery: 'Delivery', pickup: 'Self pick-up' };
const STOCK_LABELS = { ok: 'In stock', low: 'Low', out: 'Out of stock' };
const SYMBOLS = { SGD: 'S$', MYR: 'RM', THB: '฿', HKD: 'HK$' }; // as the storefront (frontend/app.js)
const TOP_PRODUCTS = 8;
const COVER_DAYS = 30; // days of cover use the average daily units sold over this many days

// ---- Dataset

// The dataset arrives packed (data.mjs): orders as arrays, names as indexes into lists. Expand it once.
export function decode(data) {
  return {
    ...data,
    orders: data.orders.map(([minute, market, pay, ful, status, sgd, local, buyer, promo, items]) => ({
      at: data.start + minute * MINUTE, market: data.markets[market][0], pay, ful, status, sgd, local, buyer, promo,
      items: items.map(([product, qty, lineSgd]) => ({ product, qty, sgd: lineSgd })),
    })),
  };
}

// ---- Formatting

const NUM = [0, 1, 2].map((dp) => new Intl.NumberFormat('en-SG', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const num = (n, dp = 0) => NUM[dp].format(n);
const r2 = (n) => Math.round(n * 100) / 100;
const share = (part, whole) => (whole ? (part / whole) * 100 : 0);
const fmtPct = (p) => `${num(p, p > 0 && p < 9.95 ? 1 : 0)}%`;
const plural = (n, word) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;
const titleCase = (s) => String(s).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function money(n, currency = 'SGD', dp = currency === 'THB' ? 0 : 2) {
  return `${n < 0 ? '−' : ''}${SYMBOLS[currency] ?? `${currency} `}${num(Math.abs(n), dp)}`;
}

// Stat tiles and heat cells: whole numbers below 10,000, compact above (12.9K, 4.2M).
function short(n, prefix = '') {
  const a = Math.abs(n);
  const s = a >= 1e6 ? `${num(a / 1e6, 1)}M` : a >= 1e4 ? `${num(a / 1e3, 1)}K` : num(a);
  return `${n < 0 ? '−' : ''}${prefix}${s}`;
}

// ---- Singapore time, from epoch milliseconds

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const wall = (ms) => new Date(ms + SGT); // read with the getUTC*() methods
const pad = (n) => String(n).padStart(2, '0');
export const sgtDayStart = (ms) => Math.floor((ms + SGT) / DAY) * DAY - SGT;

export function fmtDate(ms, { weekday = false, year = true } = {}) {
  const d = wall(ms);
  return `${weekday ? `${WEEKDAYS[d.getUTCDay()]} ` : ''}${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year ? ` ${d.getUTCFullYear()}` : ''}`;
}

export const fmtTime = (ms) => `${pad(wall(ms).getUTCHours())}:${pad(wall(ms).getUTCMinutes())}`;

// Two days, both included: "9 Oct – 7 Nov 2026", "3 – 9 Nov 2026".
function fmtRange(a, b) {
  const [x, y] = [wall(a), wall(b)];
  if (x.getUTCFullYear() !== y.getUTCFullYear()) return `${fmtDate(a)} – ${fmtDate(b)}`;
  if (x.getUTCMonth() !== y.getUTCMonth()) return `${fmtDate(a, { year: false })} – ${fmtDate(b)}`;
  return a === b ? fmtDate(a) : `${x.getUTCDate()} – ${fmtDate(b)}`;
}

// ---- Periods

// N days: the N full Singapore days before today, against the N days before those.
// Today: midnight until the page was generated, against the same hours yesterday.
export function windows(ds, period) {
  const today = ds.todayStart;
  if (period === 'today') {
    const elapsed = Math.max(0, ds.generatedAt - today);
    return { cur: [today, today + elapsed], prev: [today - DAY, today - DAY + elapsed], unit: HOUR, n: Math.max(1, Math.ceil(elapsed / HOUR)), curName: 'Today', prevName: 'Yesterday' };
  }
  return { cur: [today - period * DAY, today], prev: [today - 2 * period * DAY, today - period * DAY], unit: DAY, n: period, curName: `Last ${period} days`, prevName: `Previous ${period} days` };
}

// ---- Figures

function totals(orders) {
  let revenue = 0;
  let units = 0;
  const buyers = new Set();
  for (const o of orders) {
    revenue += o.sgd;
    buyers.add(o.buyer);
    for (const it of o.items) units += it.qty;
  }
  return { revenue: r2(revenue), orders: orders.length, aov: orders.length ? r2(revenue / orders.length) : null, units, customers: buyers.size };
}

function buckets(orders, start, unit, n) {
  const groups = Array.from({ length: n }, () => []);
  for (const o of orders) {
    const i = Math.floor((o.at - start) / unit);
    if (i >= 0 && i < n) groups[i].push(o);
  }
  return groups.map(totals);
}

// Every market, whatever the market filter: the chart highlights the selected one against the rest.
function byMarket(ds, orders) {
  const rows = ds.markets.map(([code, name, currency]) => ({ code, name, currency, revenue: 0, local: 0, orders: 0 }));
  const index = new Map(rows.map((r, i) => [r.code, i]));
  for (const o of orders) {
    const r = rows[index.get(o.market)];
    r.revenue += o.sgd;
    r.local += o.local;
    r.orders += 1;
  }
  const total = rows.reduce((s, r) => s + r.revenue, 0);
  return rows.map((r) => ({ ...r, revenue: r2(r.revenue), local: r2(r.local), share: share(r.revenue, total) })).sort((a, b) => b.revenue - a.revenue);
}

function byProduct(ds, orders) {
  const rows = new Map();
  for (const o of orders) {
    for (const it of o.items) {
      if (!rows.has(it.product)) rows.set(it.product, { name: ds.products[it.product][0], units: 0, sales: 0 });
      const p = rows.get(it.product);
      p.units += it.qty;
      p.sales += it.sgd;
    }
  }
  const list = [...rows.values()].map((p) => ({ ...p, sales: r2(p.sales) }));
  const total = list.reduce((s, p) => s + p.sales, 0);
  return list.map((p) => ({ ...p, share: share(p.sales, total) })).sort((a, b) => b.sales - a.sales || b.units - a.units || a.name.localeCompare(b.name));
}

function pivot(ds, orders) {
  const codes = ds.markets.map(([code]) => code);
  const rows = new Map();
  for (const o of orders) {
    for (const it of o.items) {
      if (!rows.has(it.product)) rows.set(it.product, { name: ds.products[it.product][0], cells: codes.map(() => 0) });
      rows.get(it.product).cells[codes.indexOf(o.market)] += it.sgd;
    }
  }
  const list = [...rows.values()]
    .map((r) => ({ name: r.name, cells: r.cells.map(r2), total: r2(r.cells.reduce((s, v) => s + v, 0)) }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return { codes, rows: list, max: Math.max(0, ...list.flatMap((r) => r.cells)) };
}

// Orders and revenue per entry of `keys` (payment methods, fulfilment, statuses), in the list's order.
function split(keys, orders, keyOf) {
  const rows = keys.map((key, i) => ({ i, key, orders: 0, revenue: 0 }));
  for (const o of orders) {
    const r = rows[keyOf(o)];
    r.orders += 1;
    r.revenue += o.sgd;
  }
  return rows.map((r) => ({ ...r, revenue: r2(r.revenue), share: share(r.orders, orders.length) }));
}

function promos(ds, orders) {
  const rows = ds.promos.map((code) => ({ code, orders: 0, revenue: 0 }));
  for (const o of orders) {
    if (o.promo < 0) continue;
    rows[o.promo].orders += 1;
    rows[o.promo].revenue += o.sgd;
  }
  return rows.filter((r) => r.orders).map((r) => ({ ...r, revenue: r2(r.revenue), share: share(r.orders, orders.length) })).sort((a, b) => b.orders - a.orders || b.revenue - a.revenue);
}

export function select(ds, state) {
  const w = windows(ds, state.period);
  const mine = (o) => state.market === 'ALL' || o.market === state.market;
  const cur = [];
  const prev = [];
  const everyMarket = [];
  for (const o of ds.orders) {
    if (o.at >= w.cur[0] && o.at < w.cur[1]) {
      everyMarket.push(o);
      if (mine(o)) cur.push(o);
    } else if (o.at >= w.prev[0] && o.at < w.prev[1] && mine(o)) {
      prev.push(o);
    }
  }
  return {
    state,
    w,
    totals: { cur: totals(cur), prev: totals(prev) },
    series: { cur: buckets(cur, w.cur[0], w.unit, w.n), prev: buckets(prev, w.prev[0], w.unit, w.n) },
    markets: byMarket(ds, everyMarket),
    products: byProduct(ds, cur),
    pivot: state.market === 'ALL' ? pivot(ds, cur) : null,
    payments: split(ds.payments, cur, (o) => o.pay),
    fulfilment: split(ds.fulfilments, cur, (o) => o.ful),
    statuses: split(ds.statuses, cur, (o) => o.status),
    promos: promos(ds, cur),
  };
}

// Stock on hand when the page was generated, most urgent first. Not affected by the sales filters.
export function inventory(ds) {
  const from = ds.todayStart - COVER_DAYS * DAY;
  const sold = new Map();
  for (const o of ds.orders) {
    if (o.at < from || o.at >= ds.todayStart) continue;
    for (const it of o.items) sold.set(it.product, (sold.get(it.product) || 0) + it.qty);
  }
  const rank = { out: 0, low: 1, ok: 2 };
  const rows = ds.inventory.map(([product, stock, threshold]) => {
    const units = sold.get(product) || 0;
    return {
      name: ds.products[product][0], category: ds.products[product][1], stock, threshold, sold: units,
      cover: units ? (stock * COVER_DAYS) / units : null, // stock ÷ average units sold per day
      status: stock === 0 ? 'out' : stock <= threshold ? 'low' : 'ok',
    };
  });
  rows.sort((a, b) => rank[a.status] - rank[b.status] || (a.cover ?? 1e9) - (b.cover ?? 1e9) || a.stock - b.stock);
  return {
    rows,
    units: rows.reduce((s, r) => s + r.stock, 0),
    low: rows.filter((r) => r.status === 'low').length,
    out: rows.filter((r) => r.status === 'out').length,
  };
}

// ---- Rendering helpers

// Tooltip content for boot(): a title, then rows of [value, label, key], key naming the series colour.
const tip = (title, rows) => ` data-tip="${esc(JSON.stringify({ t: title, r: rows }))}"`;
const none = (text) => `<p class="empty">${esc(text)}</p>`;
const NO_ORDERS = 'No paid orders in this period.';

function card(cls, title, sub, body, tableView = '') {
  return `<section class="card ${cls}"><h2>${esc(title)}</h2>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}${body}${tableView ? `<details class="tv"><summary>Show as table</summary>${tableView}</details>` : ''}</section>`;
}

// numeric: indexes of right-aligned columns. Every cell is escaped.
function table(head, rows, numeric = []) {
  const cls = (i) => (numeric.includes(i) ? ' class="num"' : '');
  return `<div class="table-wrap"><table class="data"><thead><tr>${head.map((h, i) => `<th${cls(i)}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${cls(i)}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// ---- Filters, caption, stat tiles

function filters(ds, state) {
  const group = (name, legend, options) => `<fieldset class="control"><legend>${legend}</legend><div class="segmented">${options.map(([value, text, title]) => `<label${title ? ` title="${esc(title)}"` : ''}><input type="radio" name="${name}" value="${esc(value)}"${String(value) === String(state[name]) ? ' checked' : ''}><span>${esc(text)}</span></label>`).join('')}</div></fieldset>`;
  return `<div class="filters">${group('period', 'Period', PERIODS)}${group('market', 'Market', [['ALL', 'All markets'], ...ds.markets.map(([code, name]) => [code, code, name])])}</div>`;
}

function caption(ds, m) {
  const { w, state } = m;
  const where = state.market === 'ALL' ? 'All markets' : ds.markets.find(([code]) => code === state.market)[1];
  const when = state.period === 'today'
    ? `<strong>Today so far</strong> · ${fmtDate(w.cur[0])}, 00:00–${fmtTime(w.cur[1])}, compared with the same hours yesterday`
    : `<strong>${w.curName}</strong> · ${fmtRange(w.cur[0], w.cur[1] - DAY)}, compared with ${fmtRange(w.prev[0], w.prev[1] - DAY)}`;
  return `${when} · ${esc(where)}`;
}

const KPIS = [
  ['revenue', 'Revenue', (v) => short(v, 'S$')],
  ['orders', 'Paid orders', (v) => short(v)],
  ['aov', 'Average order value', (v) => money(v)],
  ['units', 'Units sold', (v) => short(v)],
  ['customers', 'Customers', (v) => short(v)],
];

function delta(cur, prev) {
  if (cur == null) return '<b>—</b>';
  if (!prev) return cur ? '<b class="up">New</b>' : '<b>—</b>';
  const d = ((cur - prev) / prev) * 100;
  if (Math.abs(d) < 0.05) return '<b>0.0%</b>';
  return d > 0
    ? `<b class="up"><span aria-hidden="true">▲</span> ${num(d, 1)}%<span class="sr"> up</span></b>`
    : `<b class="down"><span aria-hidden="true">▼</span> ${num(-d, 1)}%<span class="sr"> down</span></b>`;
}

// Previous period in grey, this period in the accent, on one scale. A missing value (average order value
// with no orders) is stepped over, so the line keeps its shape.
function spark(prev, cur) {
  const top = Math.max(0, ...prev, ...cur) || 1;
  const n = prev.length + cur.length;
  const X = (i) => (n === 1 ? 50 : (i / (n - 1)) * 100);
  const Y = (v) => 23 - (v / top) * 22;
  const path = (vals, offset) => vals
    .map((v, i) => (v == null ? null : [X(offset + i), Y(v)]))
    .filter(Boolean)
    .map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`)
    .join('');
  return `<svg class="spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><path class="prev" d="${path(prev, 0)}"/><path class="cur" d="${path(cur, prev.length)}"/></svg>`;
}

function kpis(m) {
  const vs = m.state.period === 'today' ? 'vs same time yesterday' : `vs previous ${m.state.period} days`;
  return KPIS.map(([key, label, fmt]) => {
    const cur = m.totals.cur[key];
    return `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${cur == null ? '—' : fmt(cur)}</div><div class="kpi-delta">${delta(cur, m.totals.prev[key])} <span>${vs}</span></div>${spark(m.series.prev.map((b) => b[key]), m.series.cur.map((b) => b[key]))}</div>`;
  }).join('');
}

// ---- Revenue over time: this period against the previous one, with a crosshair tooltip per day or hour

// Clean ticks, 4 steps, as barChart() in frontend/admin.js. Whole S$ below 10,000, compact (S$10K) on an axis that reaches it.
function axis(max) {
  if (!(max > 0)) return { top: 4, ticks: [0, 1, 2, 3, 4], label: (v) => `S$${num(v)}` };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((v) => v >= raw);
  const top = step * 4;
  const label = top >= 1e4 ? (v) => `S$${num(v / 1e3, v % 1e3 ? 1 : 0)}K` : (v) => `S$${num(v, v % 1 ? 1 : 0)}`;
  return { top, ticks: [0, 1, 2, 3, 4].map((k) => k * step), label };
}

function trend(m) {
  const { w } = m;
  const cur = m.series.cur.map((b) => b.revenue);
  const prev = m.series.prev.map((b) => b.revenue);
  const n = cur.length;
  const hourly = w.unit === HOUR;
  const { top, ticks, label } = axis(Math.max(...cur, ...prev));
  const X = (i) => (n === 1 ? 50 : (i / (n - 1)) * 100); // % across the plot
  const Y = (v) => 100 - (v / top) * 100; // % down the plot
  const line = (vs) => vs.map((v, i) => `${i ? 'L' : 'M'}${(X(i) * 10).toFixed(1)} ${Y(v).toFixed(2)}`).join('');
  const area = n > 1 ? `<path class="cur-area" d="${line(cur)}L1000 100L0 100Z"/>` : '';
  const curLabel = (i) => (hourly ? `${pad(i)}:00–${pad(i + 1)}:00` : fmtDate(w.cur[0] + i * DAY, { weekday: true }));
  const prevLabel = (i) => (hourly ? 'Yesterday' : fmtDate(w.prev[0] + i * DAY, { weekday: true }));
  const every = Math.ceil(n / 7);
  const half = n === 1 ? 50 : 50 / (n - 1);

  const hits = cur.map((v, i) => {
    const [left, right] = [Math.max(0, X(i) - half), Math.min(100, X(i) + half)];
    const c = m.series.cur[i];
    const p = m.series.prev[i];
    return `<span class="hit" style="left:${left.toFixed(2)}%;width:${(right - left).toFixed(2)}%" data-x="${X(i).toFixed(2)}" data-y="${Y(v).toFixed(2)}" data-y2="${Y(prev[i]).toFixed(2)}"${tip(curLabel(i), [
      [money(c.revenue), `${w.curName} · ${plural(c.orders, 'order')}`, 'cur'],
      [money(p.revenue), `${prevLabel(i)} · ${plural(p.orders, 'order')}`, 'prev'],
    ])}></span>`;
  }).join('');
  // Labelled back from the newest bucket; on a phone every other label hides (.alt) so they don't crowd.
  const xLabels = cur.map((_, i) => {
    if ((n - 1 - i) % every) return '';
    const cls = [i === 0 && n > 1 && 'first', i === n - 1 && n > 1 && 'last', ((n - 1 - i) / every) % 2 && 'alt'].filter(Boolean).join(' ');
    return `<span${cls ? ` class="${cls}"` : ''} style="left:${X(i).toFixed(2)}%">${hourly ? `${pad(i)}:00` : fmtDate(w.cur[0] + i * DAY, { year: false })}</span>`;
  }).join('');
  // Direct labels at the line ends, unless they would sit on top of each other (the legend still names both).
  const [endCur, endPrev] = [Y(cur[n - 1]), Y(prev[n - 1])];
  const ends = Math.abs(endCur - endPrev) >= 9 ? `<span style="top:${endCur.toFixed(2)}%">This period</span><span style="top:${endPrev.toFixed(2)}%">Previous</span>` : '';

  return `<div class="trend" tabindex="0" aria-label="${esc(`Revenue by ${hourly ? 'hour' : 'day'}, ${w.curName.toLowerCase()} and ${w.prevName.toLowerCase()}. Use the arrow keys to read each value, or show it as a table.`)}">
<div class="trend-y" aria-hidden="true">${ticks.map((t) => `<span style="top:${Y(t).toFixed(2)}%">${label(t)}</span>`).join('')}</div>
<div class="trend-plot"><svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">${ticks.map((t) => `<line class="${t ? 'grid' : 'base'}" x1="0" x2="1000" y1="${Y(t).toFixed(2)}" y2="${Y(t).toFixed(2)}"/>`).join('')}<path class="prev-line" d="${line(prev)}"/>${area}<path class="cur-line" d="${line(cur)}"/></svg>${n === 1 ? `<span class="dot dot-prev dot-static" style="left:50%;top:${endPrev.toFixed(2)}%"></span>` : ''}<span class="dot dot-end" style="left:${X(n - 1).toFixed(2)}%;top:${endCur.toFixed(2)}%"></span><span class="xhair"></span><span class="dot dot-prev dot-hover"></span><span class="dot dot-cur dot-hover"></span><div class="hits">${hits}</div></div>
<div class="trend-end" aria-hidden="true">${ends}</div>
<div class="trend-x" aria-hidden="true">${xLabels}</div>
</div>
<ul class="legend"><li><i class="lk lk-cur"></i>${esc(w.curName)}</li><li><i class="lk lk-prev"></i>${esc(w.prevName)}</li></ul>`;
}

function trendTable(m) {
  const { w } = m;
  const hourly = w.unit === HOUR;
  const head = hourly ? ['Hour', 'Revenue today', 'Orders', 'Revenue yesterday', 'Orders'] : ['Date', 'Revenue', 'Orders', 'Compared with', 'Revenue', 'Orders'];
  const rows = m.series.cur.map((c, i) => {
    const p = m.series.prev[i];
    return hourly
      ? [`${pad(i)}:00–${pad(i + 1)}:00`, money(c.revenue), num(c.orders), money(p.revenue), num(p.orders)]
      : [fmtDate(w.cur[0] + i * DAY, { weekday: true }), money(c.revenue), num(c.orders), fmtDate(w.prev[0] + i * DAY, { weekday: true }), money(p.revenue), num(p.orders)];
  });
  return table(head, rows, hourly ? [1, 2, 3, 4] : [1, 2, 4, 5]);
}

// ---- Ranked bars (one hue; grey for the markets the filter is not on)

function bars(rows) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return `<div class="bars">${rows.map((r) => `<div class="bar-row${r.dim ? ' dim' : ''}" tabindex="0"${r.tip}><div class="bar-name"><span>${esc(r.name)}</span><span class="note">${esc(r.note)}</span></div><div class="bar-line"><span class="bar" style="--w:${(max ? r.value / max : 0).toFixed(4)}"></span><span class="bar-val">${esc(r.label)}</span></div></div>`).join('')}</div>`;
}

function marketBars(m) {
  const sel = m.state.market;
  return bars(m.markets.map((r) => ({
    name: `${r.code} · ${r.name}`, note: fmtPct(r.share), value: r.revenue, label: money(r.revenue), dim: sel !== 'ALL' && sel !== r.code,
    tip: tip(r.name, [[money(r.revenue), 'revenue'], [money(r.local, r.currency), `in ${r.currency}`], [num(r.orders), r.orders === 1 ? 'order' : 'orders'], [fmtPct(r.share), 'of revenue, all markets']]),
  })));
}

function productBars(m) {
  return bars(m.products.slice(0, TOP_PRODUCTS).map((p) => ({
    name: p.name, note: plural(p.units, 'unit'), value: p.sales, label: money(p.sales),
    tip: tip(p.name, [[money(p.sales), 'item sales'], [num(p.units), p.units === 1 ? 'unit' : 'units'], [fmtPct(p.share), 'of item sales']]),
  })));
}

// ---- Heat table: item sales per product and market, one blue ramp (darker sold more)

function heat(m) {
  const { codes, rows, max } = m.pivot;
  if (!rows.length) return none(NO_ORDERS);
  const q = (v) => (v > 0 ? Math.min(6, Math.ceil((v / max) * 6)) : 0);
  // Cells drop the S$ (the card says SGD) so the table fits a phone; the tooltips give exact amounts.
  const body = rows.map((r) => `<tr><th scope="row">${esc(r.name)}</th>${r.cells.map((v, i) => `<td class="q${q(v)}"${v ? tip(`${r.name} · ${codes[i]}`, [[money(v), 'item sales']]) : ''}>${v ? short(v) : '–'}</td>`).join('')}<td class="total">${short(r.total)}</td></tr>`).join('');
  return `<div class="table-wrap"><table class="heat"><thead><tr><th>Product</th>${codes.map((c) => `<th class="num">${esc(c)}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>${body}</tbody></table></div>
<div class="scale" aria-hidden="true"><span>Less</span>${[1, 2, 3, 4, 5, 6].map((k) => `<i class="q${k}"></i>`).join('')}<span>More (up to ${money(max)})</span></div>`;
}

// ---- Part-to-whole: one tall segmented bar per card, shares printed where they fit

function segmented(name, parts) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (!total) return none(NO_ORDERS);
  const shown = parts.filter((p) => p.value > 0);
  const blocks = shown.map((p) => {
    const pc = share(p.value, total);
    return `<span class="seg ${p.cls}" style="flex-grow:${p.value}" tabindex="0" aria-label="${esc(`${p.name}: ${fmtPct(pc)}`)}"${tip(p.name, p.tip)}>${pc >= 14 ? `<span>${fmtPct(pc)}</span>` : ''}</span>`;
  }).join('');
  return `<div class="segbar" role="group" aria-label="${esc(name)}">${blocks}</div><ul class="legend">${shown.map((p) => `<li><i class="sw ${p.cls}"></i>${esc(p.name)}</li>`).join('')}</ul>`;
}

function splitParts(rows, labels, clsOf) {
  return rows.map((r) => ({
    name: labels[r.key] || titleCase(r.key), value: r.orders, cls: clsOf(r),
    tip: [[fmtPct(r.share), 'of paid orders'], [num(r.orders), r.orders === 1 ? 'order' : 'orders'], [money(r.revenue), 'revenue']],
  }));
}

const splitTable = (parts, rows) => table(['', 'Orders', 'Share', 'Revenue'], rows.map((r, i) => [parts[i].name, num(r.orders), fmtPct(r.share), money(r.revenue)]), [1, 2, 3]);
const categorical = (r) => (r.i < 3 ? `c${r.i + 1}` : 'cx'); // slots 1-3, then grey
const ordinal = (r) => (r.i < 5 ? `o${r.i + 1}` : 'cx'); // the known statuses, in pipeline order

function promoCard(m, cls) {
  const used = m.promos.reduce((s, p) => s + p.orders, 0);
  const sub = used ? `${fmtPct(share(used, m.totals.cur.orders))} of paid orders used one` : 'Paid orders that used a code';
  const body = used ? table(['Code', 'Orders', 'Revenue'], m.promos.map((p) => [p.code, num(p.orders), money(p.revenue)]), [1, 2]) : none('No promo codes used in this period.');
  return card(cls, 'Promo codes', sub, body);
}

// ---- Sheets

// Layout: all markets adds the product x market heat table beside the top products; one market puts the
// promo codes there instead and splits the last row in three.
export function renderSales(ds, m) {
  const { w } = m;
  const empty = !m.totals.cur.orders;
  const sel = m.state.market;
  const last = m.pivot ? 'w-quarter' : 'w-third';
  const pay = splitParts(m.payments, PAYMENT_LABELS, categorical);
  const ful = splitParts(m.fulfilment, FULFILMENT_LABELS, categorical);
  const sts = splitParts(m.statuses, STATUS_LABELS, ordinal);
  const segmentedCard = (title, sub, parts, rows) => card(last, title, sub, segmented(title, parts), empty ? '' : splitTable(parts, rows));
  return `${filters(ds, m.state)}
<p class="caption">${caption(ds, m)}</p>
<div class="kpis">${kpis(m)}</div>
<div class="grid">
${card('w-trend', w.unit === HOUR ? 'Revenue by hour' : 'Revenue by day', `SGD · ${w.curName} compared with ${w.prevName.toLowerCase()}`, trend(m), trendTable(m))}
${card('w-side', 'Revenue by market', `SGD · ${w.curName}${sel === 'ALL' ? '' : ` · ${sel} highlighted`}`, marketBars(m), table(['Market', 'Revenue (SGD)', 'Local currency', 'Orders', 'Share'], m.markets.map((r) => [r.name, money(r.revenue), money(r.local, r.currency), num(r.orders), fmtPct(r.share)]), [1, 2, 3, 4]))}
${card('w-half', 'Top products', `Item sales, SGD · top ${TOP_PRODUCTS}`, empty ? none(NO_ORDERS) : productBars(m), empty ? '' : table(['Product', 'Item sales (SGD)', 'Units', 'Share'], m.products.map((p) => [p.name, money(p.sales), num(p.units), fmtPct(p.share)]), [1, 2, 3]))}
${m.pivot ? card('w-half', 'Item sales by product and market', 'SGD · darker cells sold more', heat(m)) : promoCard(m, 'w-half')}
${segmentedCard('Payment methods', 'Share of paid orders', pay, m.payments)}
${segmentedCard('Fulfilment', 'Share of paid orders', ful, m.fulfilment)}
${segmentedCard('Order status', 'Paid orders by where they are now', sts, m.statuses)}
${m.pivot ? promoCard(m, 'w-quarter') : ''}
</div>`;
}

const ICONS = {
  ok: '<svg class="icon ok" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7"/><path d="M4.6 8.3l2.2 2.2 4.6-4.7"/></svg>',
  low: '<svg class="icon low" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.3 15.2 14.2H.8z"/><path d="M8 6v3.6M8 11.9v.1"/></svg>',
  out: '<svg class="icon out" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7"/><path d="M5.6 5.6l4.8 4.8m0-4.8-4.8 4.8"/></svg>',
};
const stock = (status, text = STOCK_LABELS[status]) => `<span class="stock">${ICONS[status]}${esc(text)}</span>`;

export function renderInventory(ds) {
  const inv = inventory(ds);
  const tile = (label, value, note) => `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-delta">${note}</div></div>`;
  const cover = (r) => (r.cover == null ? 'No sales' : r.cover >= 365 ? '365+' : num(r.cover));
  const rows = inv.rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(titleCase(r.category))}</td><td class="num">${num(r.stock)}</td><td class="num">${num(r.threshold)}</td><td class="num">${num(r.sold)}</td><td class="num">${cover(r)}</td><td>${stock(r.status)}</td></tr>`).join('');
  return `<p class="caption"><strong>Stock on hand</strong> · ${fmtDate(ds.generatedAt)}, ${fmtTime(ds.generatedAt)} · active products · not affected by the sales filters</p>
<div class="kpis">
${tile('Active products', num(inv.rows.length), 'Listed in the shop')}
${tile('Units in stock', short(inv.units), 'All active products')}
${tile('Low stock', num(inv.low), inv.low ? stock('low', 'At or below the low-stock level') : stock('ok', 'None'))}
${tile('Out of stock', num(inv.out), inv.out ? stock('out', 'Cannot be ordered') : stock('ok', 'None'))}
</div>
<div class="grid">${card('w-full', 'Stock levels', `Most urgent first. Days of cover: stock ÷ average daily units sold over the last ${COVER_DAYS} days.`, inv.rows.length
    ? `<div class="table-wrap"><table class="data"><thead><tr><th>Product</th><th>Category</th><th class="num">In stock</th><th class="num">Low-stock level</th><th class="num">Sold, last ${COVER_DAYS} days</th><th class="num">Days of cover</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : none('No active products.'))}</div>`;
}

// ---- Browser only: filters, sheet tabs, tooltips and the crosshair

export function boot(doc) {
  const win = doc.defaultView;
  const ds = decode(JSON.parse(doc.getElementById('kk-data').textContent));
  const sales = doc.getElementById('sales');
  const tabs = [...doc.querySelectorAll('[role="tab"]')];
  const markets = ['ALL', ...ds.markets.map(([code]) => code)];
  const periods = PERIODS.map(([p]) => String(p));
  const toPeriod = (v) => (v === 'today' ? 'today' : Number(v));

  // State lives in the URL hash (#sheet=sales&period=7&market=SG), so a view can be bookmarked or shared.
  const parse = (hash) => {
    const q = new URLSearchParams(hash.replace(/^#/, ''));
    return {
      sheet: ['sales', 'inventory'].includes(q.get('sheet')) ? q.get('sheet') : DEFAULT_STATE.sheet,
      period: periods.includes(q.get('period')) ? toPeriod(q.get('period')) : DEFAULT_STATE.period,
      market: markets.includes(q.get('market')) ? q.get('market') : DEFAULT_STATE.market,
    };
  };

  let state = DEFAULT_STATE;
  let drawn = DEFAULT_STATE; // the page was written showing the default view
  const apply = (next, focus) => {
    state = next;
    if (next.period !== drawn.period || next.market !== drawn.market) {
      sales.innerHTML = renderSales(ds, select(ds, next));
      drawn = next;
      if (focus) sales.querySelector(`input[name="${focus}"]:checked`)?.focus();
    }
    for (const t of tabs) {
      const on = t.dataset.sheet === next.sheet;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      doc.getElementById(t.getAttribute('aria-controls')).classList.toggle('active', on);
    }
    const hash = `#sheet=${next.sheet}&period=${next.period}&market=${next.market}`;
    if (win.location.hash !== hash) win.history.replaceState(null, '', hash);
  };
  apply(parse(win.location.hash));

  sales.addEventListener('change', (e) => {
    const { name, value } = e.target;
    if (name === 'period') apply({ ...state, period: toPeriod(value) }, name);
    if (name === 'market') apply({ ...state, market: value }, name);
  });
  const tablist = doc.querySelector('[role="tablist"]');
  tablist.addEventListener('click', (e) => {
    const t = e.target.closest('[role="tab"]');
    if (t) apply({ ...state, sheet: t.dataset.sheet });
  });
  tablist.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const t = tabs[(tabs.indexOf(doc.activeElement) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    t.focus();
    apply({ ...state, sheet: t.dataset.sheet });
  });
  win.addEventListener('hashchange', () => apply(parse(win.location.hash)));
  tooltips(doc, win);
}

function tooltips(doc, win) {
  const box = doc.createElement('div');
  box.className = 'tip';
  box.setAttribute('role', 'tooltip');
  box.hidden = true;
  doc.body.append(box);
  let current = null;

  const el = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text; // names come from the database: never innerHTML
    return e;
  };
  // A trend hit (one day or hour) also moves the crosshair and the two hover dots.
  const crosshair = (hit) => {
    for (const p of doc.querySelectorAll('.trend-plot.hover')) p.classList.remove('hover');
    if (!hit?.classList.contains('hit')) return;
    const plot = hit.closest('.trend-plot');
    plot.style.setProperty('--hx', `${hit.dataset.x}%`);
    plot.style.setProperty('--hy', `${hit.dataset.y}%`);
    plot.style.setProperty('--hy2', `${hit.dataset.y2}%`);
    plot.classList.add('hover');
  };
  const show = (target, x, y) => {
    if (target !== current) {
      current = target;
      const { t, r } = JSON.parse(target.dataset.tip);
      box.replaceChildren(el('div', 'tip-title', t), ...r.map(([value, label, key]) => {
        const row = el('div', 'tip-row');
        if (key) row.append(el('i', `lk lk-${key}`));
        row.append(el('b', '', value));
        if (label) row.append(el('span', '', label));
        return row;
      }));
      box.hidden = false;
      crosshair(target);
    }
    const [w, h] = [box.offsetWidth, box.offsetHeight];
    box.style.left = `${Math.max(8, x + 14 + w > win.innerWidth - 8 ? x - w - 14 : x + 14)}px`;
    box.style.top = `${Math.max(8, y + 14 + h > win.innerHeight - 8 ? y - h - 14 : y + 14)}px`;
  };
  const hide = () => {
    if (!current) return;
    current = null;
    box.hidden = true;
    crosshair(null);
  };
  const showAt = (target) => {
    const r = target.getBoundingClientRect();
    show(target, r.left + r.width / 2, r.top + Math.min(r.height, 28));
  };
  const onPointer = (e) => {
    const target = e.target.closest?.('[data-tip]');
    if (target) show(target, e.clientX, e.clientY);
    else hide();
  };

  doc.addEventListener('pointermove', onPointer);
  doc.addEventListener('pointerdown', onPointer);
  doc.addEventListener('focusin', (e) => {
    if (e.target.matches('.trend')) showAt([...e.target.querySelectorAll('.hit')].pop());
    else if (e.target.matches('[data-tip]')) showAt(e.target);
  });
  doc.addEventListener('focusout', hide);
  win.addEventListener('scroll', hide, { passive: true });
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return hide();
    if (!e.target.matches?.('.trend') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const hits = [...e.target.querySelectorAll('.hit')];
    const at = hits.indexOf(current);
    const i = e.key === 'Home' ? 0 : e.key === 'End' ? hits.length - 1 : Math.min(hits.length - 1, Math.max(0, (at < 0 ? hits.length - 1 : at) + (e.key === 'ArrowRight' ? 1 : -1)));
    showAt(hits[i]);
  });
}
