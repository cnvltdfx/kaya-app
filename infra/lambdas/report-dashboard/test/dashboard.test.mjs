// No database needed: pack() is fed rows shaped like loadDataset's query results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pack } from '../data.mjs';
import { decode, select, windows, inventory, renderSales } from '../view.mjs';
import { renderPage, dashboardKey, publish, LATEST_KEY } from '../dashboard.mjs';

const NOW = Date.parse('2026-11-08T10:30:00+08:00'); // 10:30 SGT
const sgt = (s) => new Date(`${s}+08:00`);
const iso = (ms) => new Date(ms).toISOString();

const PRODUCTS = [
  { id: 'prd_pandan', name: 'Classic Pandan Kaya', category: 'classic', stock: 40, low_stock_threshold: 15, active: 1 },
  { id: 'prd_durian', name: 'Musang King <Durian> Kaya', category: 'specialty', stock: 6, low_stock_threshold: 15, active: 1 },
  { id: 'prd_hamper', name: 'Festive Hamper', category: 'gifts', stock: 0, low_stock_threshold: 5, active: 1 },
  { id: 'prd_old', name: 'Retired Jar', category: 'classic', stock: 0, low_stock_threshold: 5, active: 0 },
];

// One paid order the way loadDataset's query returns it: a row per item.
function order(id, at, { user = 'usr_a', market = 'SG', currency = 'SGD', status = 'delivered', fulfilment = 'delivery', payment = 'card', sgd, local = sgd, promo = null, items }) {
  return items.map(([product, qty, unit]) => ({
    id, created_at: sgt(at), user_id: user, market, currency, status, fulfilment, payment_method: payment,
    total: local, total_sgd: sgd, promo_code: promo, product_id: product, qty, unit_price_sgd: unit,
  }));
}

const LINES = [
  ...order('KK1', '2026-09-20T12:00:00', { sgd: 30, items: [['prd_pandan', 3, 10]] }),
  ...order('KK2', '2026-10-28T09:00:00', { sgd: 20, user: 'usr_b', items: [['prd_pandan', 2, 10]] }),
  ...order('KK3', '2026-11-03T15:00:00', { sgd: 54, user: 'usr_b', payment: 'paynow', promo: 'KAYA1111', items: [['prd_pandan', 1, 10], ['prd_durian', 2, 22]] }),
  ...order('KK6', '2026-11-07T08:40:00', { sgd: 12, status: 'confirmed', items: [['prd_gone', 1, 12]] }),
  ...order('KK4', '2026-11-07T23:59:00', { sgd: 25.5, local: 88, market: 'MY', currency: 'MYR', user: 'usr_c', status: 'shipped', items: [['prd_hamper', 1, 25.5]] }),
  ...order('KK5', '2026-11-08T08:15:00', { sgd: 10, fulfilment: 'pickup', status: 'processing', items: [['prd_pandan', 1, 10]] }),
];

const data = pack({ now: NOW, lines: LINES, products: PRODUCTS });
const ds = decode(data);

test('N-day periods are whole Singapore days before today; Today runs to the time the page was made', () => {
  const week = windows(ds, 7);
  assert.deepEqual([...week.cur, ...week.prev].map(iso), ['2026-10-31T16:00:00.000Z', '2026-11-07T16:00:00.000Z', '2026-10-24T16:00:00.000Z', '2026-10-31T16:00:00.000Z']);
  assert.equal(week.n, 7);
  const today = windows(ds, 'today');
  assert.deepEqual([...today.cur, ...today.prev].map(iso), ['2026-11-07T16:00:00.000Z', '2026-11-08T02:30:00.000Z', '2026-11-06T16:00:00.000Z', '2026-11-07T02:30:00.000Z']);
  assert.equal(today.n, 11); // 00:00-10:30, by the hour
});

test('totals, daily series and the comparison period', () => {
  const m = select(ds, { period: 7, market: 'ALL' });
  assert.deepEqual(m.totals.cur, { revenue: 91.5, orders: 3, aov: 30.5, units: 5, customers: 3 });
  assert.deepEqual(m.totals.prev, { revenue: 20, orders: 1, aov: 20, units: 2, customers: 1 });
  assert.deepEqual(m.series.cur.map((b) => b.revenue), [0, 0, 54, 0, 0, 0, 37.5]); // 3 Nov; two orders on 7 Nov
  assert.deepEqual(m.series.prev.map((b) => b.revenue), [0, 0, 0, 20, 0, 0, 0]); // 28 Oct
  assert.equal(select(ds, { period: 30, market: 'ALL' }).totals.prev.revenue, 30); // 20 Sep
});

test('breakdowns: markets, products, payment methods, statuses, promo codes', () => {
  const m = select(ds, { period: 7, market: 'ALL' });
  assert.deepEqual(m.markets.map((r) => [r.code, r.revenue, r.local, r.orders]), [['SG', 66, 66, 2], ['MY', 25.5, 88, 1], ['TH', 0, 0, 0], ['HK', 0, 0, 0]]);
  assert.deepEqual(m.products.map((p) => [p.name, p.sales, p.units]), [['Musang King <Durian> Kaya', 44, 2], ['Festive Hamper', 25.5, 1], ['prd_gone', 12, 1], ['Classic Pandan Kaya', 10, 1]]);
  assert.deepEqual(m.payments.map((r) => [r.key, r.orders]), [['card', 2], ['paynow', 1], ['applepay', 0]]);
  assert.deepEqual(m.statuses.filter((r) => r.orders).map((r) => r.key), ['shipped', 'delivered', 'confirmed']); // unknown statuses go last
  assert.deepEqual(m.promos, [{ code: 'KAYA1111', orders: 1, revenue: 54, share: (1 / 3) * 100 }]);
  assert.deepEqual(m.pivot.rows[0], { name: 'Musang King <Durian> Kaya', cells: [44, 0, 0, 0], total: 44 });
});

test('a market filter scopes everything except the market chart, which highlights it', () => {
  const m = select(ds, { period: 7, market: 'MY' });
  assert.deepEqual(m.totals.cur, { revenue: 25.5, orders: 1, aov: 25.5, units: 1, customers: 1 });
  assert.equal(m.totals.prev.orders, 0);
  assert.equal(m.markets.length, 4);
  assert.equal(m.pivot, null);
  const html = renderSales(ds, m);
  assert.match(html, /MY highlighted/);
  assert.equal((html.match(/class="bar-row dim"/g) || []).length, 3);
});

test('Today compares with the same hours yesterday', () => {
  const m = select(ds, { period: 'today', market: 'ALL' });
  assert.equal(m.totals.cur.revenue, 10); // 08:15 today
  assert.equal(m.totals.prev.revenue, 12); // 08:40 yesterday; 23:59 yesterday is past 10:30
  assert.equal(m.series.cur[8].orders, 1);
  assert.equal(m.series.prev[8].orders, 1);
});

test('inventory: active products only, most urgent first, days of cover from the last 30 days', () => {
  const inv = inventory(ds);
  assert.deepEqual(inv.rows.map((r) => [r.name, r.status, r.sold, r.cover]), [
    ['Festive Hamper', 'out', 1, 0],
    ['Musang King <Durian> Kaya', 'low', 2, 90],
    ['Classic Pandan Kaya', 'ok', 3, 400], // today's order is not counted
  ]);
  assert.deepEqual([inv.units, inv.low, inv.out], [46, 1, 1]);
});

test('every view renders without gaps in the numbers, even with no orders', () => {
  for (const period of ['today', 7, 30, 90]) {
    for (const market of ['ALL', 'SG', 'MY', 'TH', 'HK']) {
      assert.doesNotMatch(renderSales(ds, select(ds, { period, market })), /NaN|Infinity|undefined|null/, `${period} ${market}`);
    }
  }
  const empty = decode(pack({ now: NOW, lines: [], products: [] }));
  assert.match(renderSales(empty, select(empty, { period: 30, market: 'ALL' })), /No paid orders in this period/);
});

test('the page is self-contained, escapes names and carries the dataset without buyer IDs', () => {
  const html = renderPage(data);
  assert.ok(!html.includes('<Durian>'));
  assert.ok(html.includes('Musang King &#60;Durian&#62; Kaya'));
  assert.doesNotMatch(html, /\b(src|href)=["']?(https?:)?\/\//i);
  assert.doesNotMatch(html, /<link\b/i);
  assert.ok(!html.includes('usr_'));
  const json = html.match(/<script type="application\/json" id="kk-data">(.*?)<\/script>/s)[1];
  assert.deepEqual(JSON.parse(json), data);
  assert.ok(html.includes('boot(document);'));
});

test('stored under the CSV reports key layout, and as latest', async () => {
  assert.equal(dashboardKey(NOW), 'reports/dashboard/2026/11/08/dashboard-2026-11-08T103000.html');
  const files = {};
  const out = await publish(data, async (key, body, opts = {}) => {
    files[key] = { body, opts };
    return `mem://${key}`;
  });
  assert.deepEqual(out, { location: `mem://${dashboardKey(NOW)}`, latest: `mem://${LATEST_KEY}`, orders: 6, bytes: Buffer.byteLength(files[LATEST_KEY].body) });
  assert.equal(files[dashboardKey(NOW)].body, files[LATEST_KEY].body);
  assert.deepEqual(files[LATEST_KEY].opts, { cacheControl: 'no-cache' });
});
