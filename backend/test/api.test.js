// End-to-end API tests: `npm test`. Runs the server against a throwaway data directory.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-test-'));
process.env.DATA_DIR = tmp;
process.env.LOG_SILENT = '1';
process.env.REPORTS_ROOT = tmp;
process.env.PORT = '3457';
const BASE = 'http://localhost:3457';
let server;

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
  ({ server } = require('../server'));
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
});
after(() => {
  server.close();
  require('../src/lib/db').flush();
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

test('staff login requires MFA', async () => {
  const r = await call('POST', '/api/auth/login', { body: { email: 'admin@koolkaya.sg', password: 'Admin@1234' } });
  assert.equal(r.data.mfaRequired, true);
  assert.equal(r.data.token, undefined);
  const bad = await call('POST', '/api/auth/mfa', { body: { challengeId: r.data.challengeId, code: '000000' } });
  assert.equal(bad.status, 401);
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
