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
const { findStale } = await import('../expire.mjs');

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
  await q('SET FOREIGN_KEY_CHECKS = 0; TRUNCATE order_status_history; TRUNCATE order_items; TRUNCATE orders; TRUNCATE payments; TRUNCATE users; SET FOREIGN_KEY_CHECKS = 1');
  await q("INSERT INTO users (id, email, name, created_at) VALUES ('usr_a', 'a@example.com', 'Ah Lian', UTC_TIMESTAMP(3))");
});

after(async () => {
  await close();
  await conn.end();
});

// An order placed `minutesAgo` minutes ago, now in `status`, whose payment row is `paymentStatus`.
async function order(id, status, minutesAgo, paymentStatus = 'pending') {
  await q(
    `INSERT INTO orders (id, user_id, email, market, currency, fulfilment, subtotal, total, total_sgd, payment_method, payment_status, status, created_at, updated_at)
     VALUES (?, 'usr_a', 'a@example.com', 'SG', 'SGD', 'pickup', 32, 32, 32, 'paynow', 'pending', ?, UTC_TIMESTAMP(3) - INTERVAL ? MINUTE, UTC_TIMESTAMP(3))`,
    [id, status, minutesAgo],
  );
  await q("INSERT INTO payments (id, order_id, user_id, method, amount, currency, reference, status, created_at) VALUES (?, ?, 'usr_a', 'paynow', 32, 'SGD', 'pn_test', ?, UTC_TIMESTAMP(3))", [`pmt_${id}`, id, paymentStatus]);
}

const stale = (opts = {}) => tx((c) => findStale(c, { timeoutMinutes: 30, limit: 500, ...opts }));

test('unpaid orders past the timeout expire, oldest first', async () => {
  await order('KK2', 'pending_payment', 45);
  await order('KK1', 'pending_payment', 90);
  assert.deepEqual(await stale(), [{ orderId: 'KK1', outcome: 'expired' }, { orderId: 'KK2', outcome: 'expired' }]);
});

test('orders still inside the timeout are left alone', async () => {
  await order('KK1', 'pending_payment', 10);
  assert.deepEqual(await stale(), []);
});

test('a paid order that never left pending_payment is resent as paid', async () => {
  await order('KK1', 'pending_payment', 45, 'paid');
  assert.deepEqual(await stale(), [{ orderId: 'KK1', outcome: 'paid' }]);
});

test('orders past pending_payment are ignored', async () => {
  await order('KK1', 'processing', 90, 'paid');
  await order('KK2', 'cancelled', 90, 'failed');
  assert.deepEqual(await stale(), []);
});

test('stops at the limit', async () => {
  await order('KK1', 'pending_payment', 90);
  await order('KK2', 'pending_payment', 80);
  await order('KK3', 'pending_payment', 70);
  assert.deepEqual((await stale({ limit: 2 })).map((m) => m.orderId), ['KK1', 'KK2']);
});
