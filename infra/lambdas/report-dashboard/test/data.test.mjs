// Runs against local MySQL (`docker compose up -d` in backend/) using the kaya_test database,
// which is wiped and rebuilt from backend/src/db/migrations first.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

process.env.DB_NAME = 'kaya_test';
const { tx, close } = await import('../db.mjs');
const { loadDataset } = await import('../data.mjs');
const { decode, select, inventory } = await import('../view.mjs');
const { publish, LATEST_KEY } = await import('../dashboard.mjs');

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../backend/src/db/migrations');
let conn;

const q = async (sql, params) => (await conn.query(sql, params))[0];

before(async () => {
  conn = await mysql.createConnection({ host: '127.0.0.1', user: 'kaya', password: 'kaya', database: 'kaya_test', multipleStatements: true, decimalNumbers: true });
  const tables = await q('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()');
  if (tables.length) await q(`SET FOREIGN_KEY_CHECKS = 0; DROP TABLE ${tables.map((t) => mysql.escapeId(t.name)).join(', ')}; SET FOREIGN_KEY_CHECKS = 1`);
  for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) await q(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
});

beforeEach(async () => {
  await q('SET FOREIGN_KEY_CHECKS = 0; TRUNCATE order_status_history; TRUNCATE order_items; TRUNCATE orders; TRUNCATE payments; TRUNCATE products; TRUNCATE users; SET FOREIGN_KEY_CHECKS = 1');
  await q("INSERT INTO users (id, email, name, created_at) VALUES ('usr_a', 'a@example.com', 'Ah Lian', UTC_TIMESTAMP(3)), ('usr_b', 'b@example.com', 'Ben', UTC_TIMESTAMP(3))");
  await q(`INSERT INTO products (id, slug, name, category, price, stock, low_stock_threshold, active, description, created_at) VALUES
    ('prd_pandan', 'pandan', 'Classic Pandan Kaya', 'classic', 12.25, 40, 15, TRUE, '', UTC_TIMESTAMP(3)),
    ('prd_durian', 'durian', 'Musang King Durian Kaya', 'specialty', 14.00, 6, 15, TRUE, '', UTC_TIMESTAMP(3) + INTERVAL 1 SECOND),
    ('prd_old', 'old', 'Retired Jar', 'classic', 9.00, 0, 15, FALSE, '', UTC_TIMESTAMP(3) + INTERVAL 2 SECOND)`);
});

after(async () => {
  await close();
  await conn.end();
});

// An order placed `daysAgo` days ago with its items ([product, qty, unit SGD]).
async function order(id, { daysAgo, paymentStatus = 'paid', status = 'delivered', market = 'SG', user = 'usr_a', items = [['prd_pandan', 2, 12.25]] }) {
  const total = items.reduce((s, [, qty, unit]) => s + qty * unit, 0);
  await q(
    `INSERT INTO orders (id, user_id, email, market, currency, fulfilment, address, subtotal, total, total_sgd, payment_method, payment_status, status, created_at, updated_at)
     VALUES (?, ?, 'a@example.com', ?, ?, 'delivery', '{"line1":"1 Kaya Rd"}', ?, ?, ?, 'card', ?, ?, UTC_TIMESTAMP(3) - INTERVAL ? DAY, UTC_TIMESTAMP(3))`,
    [id, user, market, market === 'MY' ? 'MYR' : 'SGD', total, market === 'MY' ? total * 3.45 : total, total, paymentStatus, status, daysAgo],
  );
  for (const [i, [product, qty, unit]] of items.entries()) {
    await q('INSERT INTO order_items (order_id, line_no, product_id, name, qty, unit_price_sgd, unit_price) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, i + 1, product, product, qty, unit, unit]);
  }
}

test('reads paid orders from the last 180 days with their items, and the active products', async () => {
  await order('KK1', { daysAgo: 3 });
  await order('KK2', { daysAgo: 10, user: 'usr_b', market: 'MY', items: [['prd_pandan', 1, 12.25], ['prd_durian', 2, 14]] });
  await order('KK3', { daysAgo: 4, paymentStatus: 'refunded', status: 'cancelled' });
  await order('KK4', { daysAgo: 2, paymentStatus: 'pending', status: 'pending_payment' });
  await order('KK5', { daysAgo: 200 });

  const data = await tx((c) => loadDataset(c, Date.now()));

  assert.deepEqual(data.orders.map((o) => [data.markets[o[1]][0], o[5], o[6], o[9]]), [
    ['MY', 40.25, 138.86, [[0, 1, 12.25], [1, 2, 28]]],
    ['SG', 24.5, 24.5, [[0, 2, 24.5]]],
  ]);
  assert.deepEqual(data.orders.map((o) => o[7]), [0, 1]); // buyers are numbered, in order of first order
  assert.deepEqual(data.products, [['Classic Pandan Kaya', 'classic'], ['Musang King Durian Kaya', 'specialty'], ['Retired Jar', 'classic']]);
  assert.deepEqual(data.inventory, [[0, 40, 15], [1, 6, 15]]);
  assert.ok(!/@|Ah Lian|Kaya Rd|usr_/.test(JSON.stringify(data)), 'no customer details');

  const m = select(decode(data), { period: 30, market: 'ALL' });
  assert.deepEqual(m.totals.cur, { revenue: 64.75, orders: 2, aov: 32.38, units: 5, customers: 2 });
  assert.deepEqual(inventory(decode(data)).rows.map((r) => [r.name, r.status, r.sold]), [['Musang King Durian Kaya', 'low', 2], ['Classic Pandan Kaya', 'ok', 3]]);
});

test('publishes one page under a dated key and as latest', async () => {
  await order('KK1', { daysAgo: 3 });
  const data = await tx((c) => loadDataset(c, Date.now()));
  const files = {};
  const out = await publish(data, async (key, body) => {
    files[key] = body;
    return `mem://${key}`;
  });

  assert.match(out.location, /^mem:\/\/reports\/dashboard\/\d{4}\/\d{2}\/\d{2}\/dashboard-\d{4}-\d{2}-\d{2}T\d{6}\.html$/);
  assert.equal(out.latest, `mem://${LATEST_KEY}`);
  assert.equal(Object.keys(files).length, 2);
  assert.match(files[LATEST_KEY], /Classic Pandan Kaya/);
});
