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

// Stock as it is after checkout reserved the test orders' items.
beforeEach(async () => {
  await q('SET FOREIGN_KEY_CHECKS = 0; TRUNCATE order_status_history; TRUNCATE order_items; TRUNCATE orders; TRUNCATE payments; TRUNCATE products; TRUNCATE users; SET FOREIGN_KEY_CHECKS = 1');
  await q("INSERT INTO users (id, email, name, created_at) VALUES ('usr_a', 'a@example.com', 'Ah Lian', UTC_TIMESTAMP(3))");
  await q(`INSERT INTO products (id, slug, name, category, price, stock, description, created_at) VALUES
    ('prd_pandan', 'pandan', 'Classic Pandan Kaya', 'classic', 12.00, 5, '', UTC_TIMESTAMP(3)),
    ('prd_durian', 'durian', 'Musang King Durian Kaya', 'specialty', 20.00, 0, '', UTC_TIMESTAMP(3))`);
});

after(async () => {
  await close();
  await conn.end();
});

// An order as the API saves it at checkout: stock already reserved, waiting for payment.
async function awaitingPayment(id, lines) {
  await q(
    `INSERT INTO orders (id, user_id, email, market, currency, fulfilment, subtotal, total, total_sgd, payment_method, payment_status, status, created_at, updated_at)
     VALUES (?, 'usr_a', 'a@example.com', 'SG', 'SGD', 'pickup', 32, 32, 32, 'card', 'pending', 'pending_payment', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
    [id],
  );
  await q('INSERT INTO order_items (order_id, line_no, product_id, name, qty, unit_price_sgd, unit_price) VALUES ?',
    [lines.map(([productId, qty], n) => [id, n + 1, productId, productId, qty, 10, 10])]);
  await q("INSERT INTO order_status_history (order_id, status, at) VALUES (?, 'pending_payment', UTC_TIMESTAMP(3))", [id]);
  await q("INSERT INTO payments (id, order_id, user_id, method, amount, currency, reference, status, created_at) VALUES (?, ?, 'usr_a', 'card', 32, 'SGD', 'cs_test', 'pending', UTC_TIMESTAMP(3))", [`pmt_${id}`, id]);
}

const stock = async () => Object.fromEntries((await q('SELECT id, stock FROM products')).map((p) => [p.id, p.stock]));
const order = async (id) => (await q('SELECT status, payment_status FROM orders WHERE id = ?', [id]))[0];
const payment = async (id) => (await q('SELECT status FROM payments WHERE order_id = ?', [id]))[0].status;
const lastHistory = async (id) => (await q('SELECT status, note FROM order_status_history WHERE order_id = ? ORDER BY id DESC LIMIT 1', [id]))[0];

test('paid: the order is confirmed and the payment recorded, stock untouched', async () => {
  await awaitingPayment('KK1', [['prd_pandan', 2], ['prd_durian', 1]]);
  const evt = await processOrder(tx, 'KK1', 'paid');

  assert.deepEqual(await order('KK1'), { status: 'processing', payment_status: 'paid' });
  assert.equal(await payment('KK1'), 'paid');
  assert.deepEqual(await stock(), { prd_pandan: 5, prd_durian: 0 });
  assert.deepEqual(await lastHistory('KK1'), { status: 'processing', note: 'order-worker' });
  assert.equal(evt.status, 'confirmed');
  assert.equal(evt.orderStatus, 'processing');
  assert.equal(evt.paymentStatus, 'paid');
  assert.equal(evt.email, 'a@example.com');
  assert.equal(evt.customerName, 'Ah Lian');
  assert.equal(evt.total, 32);
  assert.equal(evt.items.length, 2);
});

test('expired: the order is cancelled and its reserved stock released', async () => {
  await awaitingPayment('KK2', [['prd_pandan', 2], ['prd_durian', 1]]);
  const evt = await processOrder(tx, 'KK2', 'expired');

  assert.deepEqual(await order('KK2'), { status: 'cancelled', payment_status: 'cancelled' });
  assert.equal(await payment('KK2'), 'failed');
  assert.deepEqual(await stock(), { prd_pandan: 7, prd_durian: 1 });
  assert.deepEqual(await lastHistory('KK2'), { status: 'cancelled', note: 'order-worker: payment expired' });
  assert.equal(evt.status, 'cancelled');
});

test('a redelivered paid message re-sends the event without changing anything', async () => {
  await awaitingPayment('KK3', [['prd_pandan', 1]]);
  const first = await processOrder(tx, 'KK3', 'paid');
  const again = await processOrder(tx, 'KK3', 'paid');

  assert.deepEqual(again, first);
  assert.equal((await q("SELECT COUNT(*) AS n FROM order_status_history WHERE order_id = 'KK3'"))[0].n, 2);
});

test('a redelivered expired message does not release the stock twice', async () => {
  await awaitingPayment('KK4', [['prd_pandan', 2]]);
  const first = await processOrder(tx, 'KK4', 'expired');
  const again = await processOrder(tx, 'KK4', 'expired');

  assert.deepEqual(again, first);
  assert.equal((await stock()).prd_pandan, 7);
});

test('paid after the customer cancelled: order unchanged, staff told to refund', async () => {
  await awaitingPayment('KK5', [['prd_pandan', 1]]);
  await q("UPDATE orders SET status = 'cancelled', payment_status = 'cancelled' WHERE id = 'KK5'");
  await q("INSERT INTO order_status_history (order_id, status, note, at) VALUES ('KK5', 'cancelled', 'Cancelled by customer', UTC_TIMESTAMP(3))");
  const evt = await processOrder(tx, 'KK5', 'paid');

  assert.deepEqual(await order('KK5'), { status: 'cancelled', payment_status: 'cancelled' });
  assert.equal(evt.status, 'rejected');
  assert.match(evt.reason, /refund it manually/);
});

test('paid after checkout had already expired: staff told to refund', async () => {
  await awaitingPayment('KK6', [['prd_pandan', 1]]);
  await processOrder(tx, 'KK6', 'expired');
  const evt = await processOrder(tx, 'KK6', 'paid');

  assert.equal(evt.status, 'rejected');
  assert.equal((await order('KK6')).status, 'cancelled');
});

test('a late message is ignored once staff have moved the order on', async () => {
  await awaitingPayment('KK7', [['prd_pandan', 1]]);
  await processOrder(tx, 'KK7', 'paid');
  await q("UPDATE orders SET status = 'shipped' WHERE id = 'KK7'");
  await q("INSERT INTO order_status_history (order_id, status, at) VALUES ('KK7', 'shipped', UTC_TIMESTAMP(3))");

  assert.equal(await processOrder(tx, 'KK7', 'paid'), null);
  assert.equal(await processOrder(tx, 'KK7', 'expired'), null);
});

test('a missing order throws, so SQS retries it', async () => {
  await assert.rejects(processOrder(tx, 'KK404', 'paid'), /not found/);
});

test('an unknown outcome throws and changes nothing', async () => {
  await awaitingPayment('KK8', [['prd_pandan', 1]]);
  await assert.rejects(processOrder(tx, 'KK8', 'refunded'), /Unknown outcome/);
  assert.equal((await order('KK8')).status, 'pending_payment');
});

test('paid and expired racing for one order: whichever commits first settles it', async () => {
  await awaitingPayment('KK9', [['prd_pandan', 1]]);
  const [paid, expired] = await Promise.all([processOrder(tx, 'KK9', 'paid'), processOrder(tx, 'KK9', 'expired')]);

  if ((await order('KK9')).status === 'processing') {
    assert.equal(paid.status, 'confirmed');
    assert.equal(expired, null);
    assert.equal((await stock()).prd_pandan, 5);
  } else {
    assert.equal(expired.status, 'cancelled');
    assert.equal(paid.status, 'rejected');
    assert.equal((await stock()).prd_pandan, 6);
  }
});
