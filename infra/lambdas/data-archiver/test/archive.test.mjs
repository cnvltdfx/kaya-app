// Runs against local MySQL (`docker compose up -d` in backend/) using the kaya_test database,
// which is wiped and rebuilt from backend/src/db/migrations first.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { parquetReadObjects } from 'hyparquet';

process.env.DB_NAME = 'kaya_test';
const { tx, close } = await import('../db.mjs');
const { archiveBatch, archiveKey } = await import('../archive.mjs');

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../backend/src/db/migrations');
const RUN_DATE = '2026-11-15';
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
  await q("INSERT INTO products (id, slug, name, category, price, stock, description, created_at) VALUES ('prd_pandan', 'pandan', 'Classic Pandan Kaya', 'classic', 12.00, 5, '', UTC_TIMESTAMP(3))");
});

after(async () => {
  await close();
  await conn.end();
});

// An order placed `daysAgo` days ago, now in `status`, with one item, one history row and one payment.
async function order(id, status, daysAgo) {
  await q(
    `INSERT INTO orders (id, user_id, email, market, currency, fulfilment, address, subtotal, total, total_sgd, payment_method, payment_status, status, created_at, updated_at)
     VALUES (?, 'usr_a', 'a@example.com', 'SG', 'SGD', 'delivery', '{"line1":"1 Kaya Rd"}', 24.5, 24.5, 24.5, 'card', 'paid', ?,
             UTC_TIMESTAMP(3) - INTERVAL ? DAY, UTC_TIMESTAMP(3))`,
    [id, status, daysAgo],
  );
  await q("INSERT INTO order_items (order_id, line_no, product_id, name, qty, unit_price_sgd, unit_price) VALUES (?, 1, 'prd_pandan', 'Classic Pandan Kaya', 2, 12.25, 12.25)", [id]);
  await q('INSERT INTO order_status_history (order_id, status, at) VALUES (?, ?, UTC_TIMESTAMP(3))', [id, status]);
  await q("INSERT INTO payments (id, order_id, user_id, method, amount, currency, reference, status, created_at) VALUES (?, ?, 'usr_a', 'card', 24.5, 'SGD', 'cs_test', 'paid', UTC_TIMESTAMP(3))", [`pmt_${id}`, id]);
}

function bucket() {
  const files = {};
  return { files, put: async (key, body) => { files[key] = body; } };
}

const read = (bytes) => parquetReadObjects({ file: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
const ids = async (table, col = 'order_id') => (await q(`SELECT ${col} AS id FROM ${table} ORDER BY ${col}`)).map((r) => r.id);

test('moves closed orders past the cutoff to Parquet and deletes them with their rows', async () => {
  await order('KK1', 'delivered', 10);
  await order('KK2', 'cancelled', 9);
  await order('KK3', 'delivered', 3);  // too recent
  await order('KK4', 'shipped', 10);   // not closed
  const { files, put } = bucket();

  const n = await tx((c) => archiveBatch(c, { orderAgeDays: 7, batchSize: 500, runDate: RUN_DATE, put }));

  assert.equal(n, 2);
  assert.deepEqual(Object.keys(files).sort(), ['order_items', 'order_status_history', 'orders', 'payments'].map((t) => archiveKey(RUN_DATE, 'KK1', t)).sort());

  const orders = await read(files[archiveKey(RUN_DATE, 'KK1', 'orders')]);
  assert.deepEqual(orders.map((o) => [o.id, o.status, o.total, o.address.line1]), [['KK1', 'delivered', 24.5, '1 Kaya Rd'], ['KK2', 'cancelled', 24.5, '1 Kaya Rd']]);
  assert.ok(orders[0].created_at instanceof Date);
  const items = await read(files[archiveKey(RUN_DATE, 'KK1', 'order_items')]);
  assert.deepEqual(items.map((i) => [i.order_id, i.qty, i.unit_price_sgd]), [['KK1', 2, 12.25], ['KK2', 2, 12.25]]);
  assert.equal((await read(files[archiveKey(RUN_DATE, 'KK1', 'order_status_history')])).length, 2);
  assert.deepEqual((await read(files[archiveKey(RUN_DATE, 'KK1', 'payments')])).map((p) => p.id), ['pmt_KK1', 'pmt_KK2']);

  assert.deepEqual(await ids('orders', 'id'), ['KK3', 'KK4']);
  assert.deepEqual(await ids('order_items'), ['KK3', 'KK4']);
  assert.deepEqual(await ids('order_status_history'), ['KK3', 'KK4']);
  assert.deepEqual(await ids('payments'), ['KK3', 'KK4']);
});

test('archives the oldest orders first, one batch at a time', async () => {
  await order('KK1', 'delivered', 8);
  await order('KK2', 'delivered', 12);
  await order('KK3', 'delivered', 10);
  const { files, put } = bucket();
  const run = () => tx((c) => archiveBatch(c, { orderAgeDays: 7, batchSize: 2, runDate: RUN_DATE, put }));

  assert.equal(await run(), 2);
  assert.deepEqual((await read(files[archiveKey(RUN_DATE, 'KK2', 'orders')])).map((o) => o.id), ['KK2', 'KK3']);
  assert.equal(await run(), 1);
  assert.deepEqual((await read(files[archiveKey(RUN_DATE, 'KK1', 'orders')])).map((o) => o.id), ['KK1']);
  assert.equal(await run(), 0);
});

test('a failed upload deletes nothing', async () => {
  await order('KK1', 'delivered', 10);
  const put = async () => { throw new Error('S3 is down'); };

  await assert.rejects(tx((c) => archiveBatch(c, { orderAgeDays: 7, batchSize: 500, runDate: RUN_DATE, put })), /S3 is down/);

  assert.deepEqual(await ids('orders', 'id'), ['KK1']);
  assert.deepEqual(await ids('payments'), ['KK1']);
});

test('nothing to archive uploads nothing', async () => {
  await order('KK1', 'delivered', 3);
  const { files, put } = bucket();

  assert.equal(await tx((c) => archiveBatch(c, { orderAgeDays: 7, batchSize: 500, runDate: RUN_DATE, put })), 0);
  assert.deepEqual(files, {});
});
