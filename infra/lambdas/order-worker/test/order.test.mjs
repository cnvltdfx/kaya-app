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
const { processOrder } = await import('../order.mjs');

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
  await q("INSERT INTO users (id, email, name, created_at) VALUES ('usr_a', 'a@example.com', 'Ah Lian', UTC_TIMESTAMP(3))");
  await q(`INSERT INTO products (id, slug, name, category, price, stock, description, created_at) VALUES
    ('prd_pandan', 'pandan', 'Classic Pandan Kaya', 'classic', 12.00, 5, '', UTC_TIMESTAMP(3)),
    ('prd_durian', 'durian', 'Musang King Durian Kaya', 'specialty', 20.00, 1, '', UTC_TIMESTAMP(3))`);
});

after(async () => {
  await close();
  await conn.end();
});

// A queued order as the API would save it, with a payment row when paid.
async function queuedOrder(id, lines, { paid = true } = {}) {
  await q(
    `INSERT INTO orders (id, user_id, email, market, currency, fulfilment, subtotal, total, total_sgd, payment_method, payment_status, status, created_at, updated_at)
     VALUES (?, 'usr_a', 'a@example.com', 'SG', 'SGD', 'pickup', 32, 32, 32, ?, ?, 'queued', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
    [id, paid ? 'card' : 'paynow', paid ? 'paid' : 'pending'],
  );
  await q('INSERT INTO order_items (order_id, line_no, product_id, name, qty, unit_price_sgd, unit_price) VALUES ?',
    [lines.map(([productId, qty], n) => [id, n + 1, productId, productId, qty, 10, 10])]);
  await q("INSERT INTO order_status_history (order_id, status, at) VALUES (?, 'queued', UTC_TIMESTAMP(3))", [id]);
  if (paid) await q("INSERT INTO payments (id, order_id, user_id, method, amount, currency, reference, status, created_at) VALUES (?, ?, 'usr_a', 'card', 32, 'SGD', 'ref', 'paid', UTC_TIMESTAMP(3))", [`pmt_${id}`, id]);
}

const stock = async () => Object.fromEntries((await q('SELECT id, stock FROM products')).map((p) => [p.id, p.stock]));
const order = async (id) => (await q('SELECT status, payment_status FROM orders WHERE id = ?', [id]))[0];

test('a paid order with enough stock is confirmed and its stock taken', async () => {
  await queuedOrder('KK1', [['prd_pandan', 2], ['prd_durian', 1]]);
  const evt = await processOrder(tx, 'KK1');

  assert.deepEqual(await stock(), { prd_pandan: 3, prd_durian: 0 });
  assert.deepEqual(await order('KK1'), { status: 'processing', payment_status: 'paid' });
  assert.equal(evt.status, 'confirmed');
  assert.equal(evt.orderStatus, 'processing');
  assert.equal(evt.email, 'a@example.com');
  assert.equal(evt.customerName, 'Ah Lian');
  assert.equal(evt.total, 32);
  assert.equal(evt.items.length, 2);
  const [last] = await q("SELECT status, note FROM order_status_history WHERE order_id = 'KK1' ORDER BY id DESC LIMIT 1");
  assert.deepEqual(last, { status: 'processing', note: 'order-worker' });
});

test('an unpaid PayNow order takes stock and waits for payment', async () => {
  await queuedOrder('KK2', [['prd_pandan', 1]], { paid: false });
  const evt = await processOrder(tx, 'KK2');

  assert.deepEqual(await order('KK2'), { status: 'pending_payment', payment_status: 'pending' });
  assert.equal((await stock()).prd_pandan, 4);
  assert.equal(evt.status, 'confirmed');
  assert.equal(evt.orderStatus, 'pending_payment');
  assert.equal(evt.paymentStatus, 'pending');
});

test('one short line rejects the whole order, keeps all stock and refunds', async () => {
  await queuedOrder('KK3', [['prd_pandan', 2], ['prd_durian', 2]]);
  const evt = await processOrder(tx, 'KK3');

  assert.deepEqual(await stock(), { prd_pandan: 5, prd_durian: 1 });
  assert.deepEqual(await order('KK3'), { status: 'rejected', payment_status: 'refunded' });
  assert.equal((await q("SELECT status FROM payments WHERE order_id = 'KK3'"))[0].status, 'refunded');
  assert.equal(evt.status, 'rejected');
  assert.equal(evt.reason, 'prd_durian is out of stock');
  assert.equal(evt.paymentStatus, 'refunded');
});

test('a redelivered message re-sends the event without taking stock again', async () => {
  await queuedOrder('KK4', [['prd_pandan', 1]]);
  const first = await processOrder(tx, 'KK4');
  const again = await processOrder(tx, 'KK4');

  assert.deepEqual(again, first);
  assert.equal((await stock()).prd_pandan, 4);
  assert.equal((await q("SELECT COUNT(*) AS n FROM order_status_history WHERE order_id = 'KK4'"))[0].n, 2);
});

test('a redelivered rejection re-sends the same reason', async () => {
  await queuedOrder('KK5', [['prd_durian', 3]]);
  const first = await processOrder(tx, 'KK5');
  assert.deepEqual(await processOrder(tx, 'KK5'), first);
});

test('a redelivered message is ignored once staff have moved the order on', async () => {
  await queuedOrder('KK6', [['prd_pandan', 1]]);
  await processOrder(tx, 'KK6');
  await q("UPDATE orders SET status = 'cancelled' WHERE id = 'KK6'");
  await q("INSERT INTO order_status_history (order_id, status, note, at) VALUES ('KK6', 'cancelled', 'Cancelled by customer', UTC_TIMESTAMP(3))");

  assert.equal(await processOrder(tx, 'KK6'), null);
});

test('a missing order throws, so SQS retries it', async () => {
  await assert.rejects(processOrder(tx, 'KK404'), /not found/);
});

test('two orders racing for the last jar: exactly one gets it', async () => {
  await queuedOrder('KK7', [['prd_durian', 1]]);
  await queuedOrder('KK8', [['prd_durian', 1]]);
  const evts = await Promise.all([processOrder(tx, 'KK7'), processOrder(tx, 'KK8')]);

  assert.deepEqual(evts.map((e) => e.status).sort(), ['confirmed', 'rejected']);
  assert.equal((await stock()).prd_durian, 0);
});
