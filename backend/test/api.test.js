// End-to-end API tests: `npm test`. Needs MySQL (`docker compose up -d`); runs against the
// kaya_test database (override with TEST_DB_NAME), which is wiped and reseeded first.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-test-'));
process.env.DB_NAME = process.env.TEST_DB_NAME || 'kaya_test';
process.env.LOG_SILENT = '1';
process.env.REPORTS_ROOT = tmp;
process.env.PORT = '3457';
process.env.REPORTS_PORT = '3458';
const BASE = 'http://localhost:3457';
let server;
let reportServer;

async function call(method, url, { body, token, market = 'SG', headers = {} } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-market': market, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function login(email, password) {
  const r = await call('POST', '/api/auth/login', { body: { email, password } });
  if (!r.data.mfaRequired) return r.data.token;
  const m = await call('POST', '/api/auth/mfa', { body: { challengeId: r.data.challengeId, code: r.data.devCode } });
  return m.data.token;
}

const card = { method: 'card', card: { name: 'Test', number: '4242424242424242', expiry: '12/39', cvc: '123' } };
const addr = { line1: '1 Test St', city: 'Singapore', postcode: '111111' };

before(async () => {
  await require('../src/lib/db').reset();
  ({ server, reportServer } = await require('../server').ready);
});
after(async () => {
  server.close();
  reportServer.close();
  await require('../src/lib/db').close();
  fs.rmSync(tmp, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 100).unref();
});

test('health and readiness', async () => {
  assert.equal((await call('GET', '/health')).status, 200);
  assert.equal((await call('GET', '/ready')).data.products, 12);
});

test('catalogue prices are localised per market', async () => {
  const sg = await call('GET', '/api/catalog/products/classic-pandan');
  const th = await call('GET', '/api/catalog/products/classic-pandan', { market: 'TH' });
  assert.equal(sg.data.product.currency, 'SGD');
  assert.equal(th.data.product.currency, 'THB');
  assert.equal(th.data.product.priceLocal, Math.round(9.9 * 26.5));
});

test('search, filter and sort', async () => {
  const r = await call('GET', '/api/catalog/products?category=classic&sort=price_desc');
  const prices = r.data.products.map((p) => p.salePriceLocal ?? p.priceLocal);
  assert.ok(r.data.products.every((p) => p.category === 'classic'));
  assert.deepEqual(prices, [...prices].sort((a, b) => b - a));
  const q = await call('GET', '/api/catalog/products?q=durian');
  assert.equal(q.data.total, 1);
});

test('login asks for an MFA code once MFA is enabled', async () => {
  const reg = await call('POST', '/api/auth/register', { body: { name: 'Mfa User', email: 'mfa@example.com', password: 'Secret123' } });
  await call('PUT', '/api/auth/me', { token: reg.data.token, body: { mfaEnabled: true } });
  const r = await call('POST', '/api/auth/login', { body: { email: 'mfa@example.com', password: 'Secret123' } });
  assert.equal(r.data.mfaRequired, true);
  assert.equal(r.data.token, undefined);
  const bad = await call('POST', '/api/auth/mfa', { body: { challengeId: r.data.challengeId, code: '000000' } });
  assert.equal(bad.status, 401);
  const ok = await call('POST', '/api/auth/mfa', { body: { challengeId: r.data.challengeId, code: r.data.devCode } });
  assert.ok(ok.data.token);
});

test('sessions and profiles are read back from the database', async () => {
  const token = await login('demo@koolkaya.sg', 'Demo@1234');
  const me = await call('GET', '/api/auth/me', { token });
  assert.equal(me.data.user.email, 'demo@koolkaya.sg');
  const sec = require('../src/lib/security');
  const user = await sec.getUser(me.data.user.id);
  assert.equal(user.address.city, 'Singapore');
});

test('customers cannot access the back office', async () => {
  const token = await login('demo@koolkaya.sg', 'Demo@1234');
  assert.equal((await call('GET', '/api/admin/dashboard', { token })).status, 403);
});

test('register → cart → checkout → order history, with stock decrement', async () => {
  const reg = await call('POST', '/api/auth/register', { body: { name: 'New Shopper', email: 'new@example.com', password: 'Secret123', market: 'SG' } });
  assert.equal(reg.status, 200);
  const token = reg.data.token;
  const before = (await call('GET', '/api/catalog/products/salted-egg-kaya')).data.product.stock;
  await call('POST', '/api/cart/items', { token, body: { productId: 'prd_salted-egg-kaya', qty: 3 } });
  const r = await call('POST', '/api/orders/checkout', { token, body: { fulfilment: 'delivery', address: addr, promoCode: 'WELCOME10', payment: card } });
  assert.equal(r.status, 201);
  assert.equal(r.data.order.status, 'processing');
  assert.ok(r.data.order.discount > 0);
  const after = (await call('GET', '/api/catalog/products/salted-egg-kaya')).data.product.stock;
  assert.equal(after, before - 3);
  const hist = await call('GET', '/api/orders', { token });
  assert.equal(hist.data.orders.length, 1);
  assert.equal((await call('GET', '/api/cart', { token })).data.itemCount, 0);
});

test('declined card restores stock and creates no order', async () => {
  const token = await login('demo@koolkaya.sg', 'Demo@1234');
  const stock = (await call('GET', '/api/catalog/products/durian-kaya')).data.product.stock;
  await call('POST', '/api/cart/items', { token, body: { productId: 'prd_durian-kaya', qty: 1 } });
  const r = await call('POST', '/api/orders/checkout', { token, body: { fulfilment: 'delivery', address: addr, payment: { ...card, card: { ...card.card, number: '4000000000000002' } } } });
  assert.equal(r.status, 402);
  assert.equal((await call('GET', '/api/catalog/products/durian-kaya')).data.product.stock, stock);
});

test('idempotency key prevents duplicate orders', async () => {
  const token = await login('demo@koolkaya.sg', 'Demo@1234');
  await call('POST', '/api/cart/items', { token, body: { productId: 'prd_coconut-jam-original', qty: 1 } });
  const headers = { 'idempotency-key': 'abc-123' };
  const a = await call('POST', '/api/orders/checkout', { token, headers, body: { fulfilment: 'pickup', pickupDate: '2030-01-01', pickupSlot: '10:00-12:00', payment: { method: 'applepay' } } });
  const b = await call('POST', '/api/orders/checkout', { token, headers, body: { fulfilment: 'pickup', pickupDate: '2030-01-01', pickupSlot: '10:00-12:00', payment: { method: 'applepay' } } });
  assert.equal(a.data.order.id, b.data.order.id);
  assert.equal(b.data.duplicate, true);
});

test('cannot oversell stock', async () => {
  const token = await login('demo@koolkaya.sg', 'Demo@1234');
  const r = await call('POST', '/api/cart/items', { token, body: { productId: 'prd_festive-hamper', qty: 99 } });
  assert.equal(r.status, 409);
});

test('concurrent checkouts for the last units: only one succeeds', async () => {
  const db = require('../src/lib/db');
  await db.query("UPDATE products SET stock = 2 WHERE id = 'prd_tasting-flight'");
  const shoppers = [];
  for (const n of [1, 2, 3]) {
    const reg = await call('POST', '/api/auth/register', { body: { name: `Racer ${n}`, email: `racer${n}@example.com`, password: 'Secret123' } });
    await call('POST', '/api/cart/items', { token: reg.data.token, body: { productId: 'prd_tasting-flight', qty: 2 } });
    shoppers.push(reg.data.token);
  }
  const results = await Promise.all(shoppers.map((token) => call('POST', '/api/orders/checkout', { token, body: { fulfilment: 'delivery', address: addr, payment: card } })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409]);
  assert.equal((await db.one("SELECT stock FROM products WHERE id = 'prd_tasting-flight'")).stock, 0);
});

test('customer cancel returns stock once', async () => {
  const token = await login('demo@koolkaya.sg', 'Demo@1234');
  const stock = async () => (await call('GET', '/api/catalog/products/kaya-toast-set')).data.product.stock;
  const start = await stock();
  await call('POST', '/api/cart/items', { token, body: { productId: 'prd_kaya-toast-set', qty: 1 } });
  const { data } = await call('POST', '/api/orders/checkout', { token, body: { fulfilment: 'delivery', address: addr, payment: card } });
  const [a, b] = await Promise.all([1, 2].map(() => call('POST', `/api/orders/${data.order.id}/cancel`, { token })));
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(await stock(), start);
  const receipt = await call('GET', `/api/payments/${data.order.id}/receipt`, { token });
  assert.equal(receipt.data.payment.status, 'refunded');
});

test('staff can ship an order, run a report and see metrics', async () => {
  const token = await login('staff@koolkaya.sg', 'Staff@1234');
  const list = await call('GET', '/api/admin/orders?status=processing', { token });
  const order = list.data.orders.find((o) => o.fulfilment === 'delivery');
  const upd = await call('PUT', `/api/admin/orders/${order.id}/status`, { token, body: { status: 'shipped' } });
  assert.equal(upd.data.order.status, 'shipped');
  const bad = await call('PUT', `/api/admin/orders/${order.id}/status`, { token, body: { status: 'processing' } });
  assert.equal(bad.status, 409);
  const rpt = await call('POST', '/api/admin/reports', { token, body: { type: 'sales', days: 30 } });
  assert.equal(rpt.status, 201);
  assert.ok(rpt.data.report.summary.orders > 0);
  const m = await call('GET', '/api/admin/metrics', { token });
  assert.ok(m.data.overall.requests > 0);
  assert.ok(m.data.byMarket.SG);
});

test('private report port runs scheduled reports and refreshes the QuickSight feed', async () => {
  const res = await fetch('http://localhost:3458/reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'sales', days: 1 }) });
  assert.equal(res.status, 201);
  const { report } = await res.json();
  assert.equal(report.trigger, 'scheduled');
  assert.ok(report.location.startsWith('local://reports/sales/'));
  const feed = fs.readFileSync(path.join(tmp, 'reports/quicksight/sales.csv'), 'utf8').trim().split('\n');
  assert.ok(feed[0].startsWith('order_id,created_at_sgt,'));
  assert.ok(feed.length > 160); // every paid order line, not just the last day
  assert.equal((await call('POST', '/reports', { body: { type: 'sales' } })).status, 404); // not on the public port
});

// With ORDER_QUEUE_URL set, a paid order is handed to the order worker instead of settled here.
// Checkouts come from their own client IP so the earlier tests' checkout rate limit doesn't apply.
const queueClient = { 'x-forwarded-for': '10.0.0.7' };
async function withQueue(send, fn) {
  const orderQueue = require('../src/lib/orderQueue');
  const original = orderQueue.sendOutcome;
  orderQueue.sendOutcome = send;
  try { await fn(); } finally { orderQueue.sendOutcome = original; }
}

test('queue mode: a card checkout is queued for the order worker as paid', async () => {
  const sent = [];
  await withQueue(async (...args) => { sent.push(args); return true; }, async () => {
    const token = await login('demo@koolkaya.sg', 'Demo@1234');
    await call('POST', '/api/cart/items', { token, body: { productId: 'prd_coconut-jam-original', qty: 1 } });
    const r = await call('POST', '/api/orders/checkout', { token, headers: queueClient, body: { fulfilment: 'delivery', address: addr, payment: card } });
    assert.equal(r.status, 201);
    assert.equal(r.data.order.status, 'pending_payment');
    assert.deepEqual(sent, [[r.data.order.id, 'paid']]);
    const receipt = await call('GET', `/api/payments/${r.data.order.id}/receipt`, { token });
    assert.equal(receipt.data.payment.status, 'paid');
  });
});

test('queue mode: a PayNow confirmation is queued once', async () => {
  const sent = [];
  await withQueue(async (...args) => { sent.push(args); return true; }, async () => {
    const token = await login('demo@koolkaya.sg', 'Demo@1234');
    await call('POST', '/api/cart/items', { token, body: { productId: 'prd_coconut-jam-original', qty: 1 } });
    const r = await call('POST', '/api/orders/checkout', { token, headers: queueClient, body: { fulfilment: 'delivery', address: addr, payment: { method: 'paynow' } } });
    assert.equal(r.data.order.status, 'pending_payment');
    assert.equal(sent.length, 0);
    const id = r.data.order.id;
    const ok = await call('POST', `/api/payments/${id}/paynow/confirm`, { token });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.order.status, 'pending_payment'); // the worker confirms it next
    assert.equal((await call('POST', `/api/payments/${id}/paynow/confirm`, { token })).status, 409);
    assert.deepEqual(sent, [[id, 'paid']]);
  });
});

test('queue mode: a failed send still returns the paid order', async () => {
  await withQueue(async () => { throw new Error('SQS unavailable'); }, async () => {
    const token = await login('demo@koolkaya.sg', 'Demo@1234');
    await call('POST', '/api/cart/items', { token, body: { productId: 'prd_coconut-jam-original', qty: 1 } });
    const r = await call('POST', '/api/orders/checkout', { token, headers: queueClient, body: { fulfilment: 'delivery', address: addr, payment: card } });
    assert.equal(r.status, 201);
    assert.equal(r.data.order.status, 'pending_payment');
  });
});
