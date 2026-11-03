// Moves one batch of closed orders out of MySQL into Parquet files, inside the caller's transaction:
//   1. lock the oldest closed orders past the cutoff (delivered or cancelled, by created_at)
//   2. write their orders, order_items, order_status_history and payments rows as one Parquet file per table
//   3. upload the files, then delete the rows (items and history cascade; payments has no foreign key)
// A failed upload throws before anything is deleted, so the transaction rolls back and the orders stay in
// MySQL for the next run. Keys are fixed per run date and batch, so a retry the same day overwrites them.
// Returns the number of orders archived (0 when there is nothing left to do).
import { parquetWriteBuffer, schemaFromColumnData } from 'hyparquet-writer';

export const CLOSED_STATUSES = ['delivered', 'cancelled'];

const decimal = (precision) => ({ type: 'INT64', converted_type: 'DECIMAL', precision, scale: 2 });

// Columns and Parquet types per table, from backend/src/db/migrations/001_initial_schema.sql.
// `by` is the column holding the order ID.
export const TABLES = {
  orders: {
    by: 'id',
    columns: {
      id: 'STRING', user_id: 'STRING', email: 'STRING', market: 'STRING', currency: 'STRING', fulfilment: 'STRING',
      address: 'JSON', pickup_slot: 'JSON', subtotal: decimal(12), discount: decimal(12), shipping: decimal(12),
      total: decimal(12), total_sgd: decimal(12), promo_code: 'STRING', payment_method: 'STRING',
      payment_status: 'STRING', payment_ref: 'STRING', paynow: 'JSON', status: 'STRING', idempotency_key: 'STRING',
      created_at: 'TIMESTAMP', paid_at: 'TIMESTAMP', updated_at: 'TIMESTAMP',
    },
  },
  order_items: {
    by: 'order_id',
    columns: {
      order_id: 'STRING', line_no: 'INT32', product_id: 'STRING', name: 'STRING', size: 'STRING', image: 'STRING',
      qty: 'INT32', unit_price_sgd: decimal(10), unit_price: decimal(12),
    },
  },
  order_status_history: {
    by: 'order_id',
    columns: { id: 'INT64', order_id: 'STRING', status: 'STRING', note: 'STRING', at: 'TIMESTAMP' },
  },
  payments: {
    by: 'order_id',
    columns: {
      id: 'STRING', order_id: 'STRING', user_id: 'STRING', method: 'STRING', amount: decimal(12), currency: 'STRING',
      reference: 'STRING', status: 'STRING', error: 'STRING', brand: 'STRING', last4: 'STRING', paynow_ref: 'STRING',
      uen: 'STRING', created_at: 'TIMESTAMP', paid_at: 'TIMESTAMP', refunded_at: 'TIMESTAMP',
    },
  },
};

export function toParquet(columns, rows) {
  const columnData = Object.entries(columns).map(([name, type]) => ({
    name,
    data: rows.map((r) => (type === 'INT64' && r[name] != null ? BigInt(r[name]) : r[name] ?? null)),
    ...(typeof type === 'string' ? { type } : {}),
  }));
  const schemaOverrides = Object.fromEntries(Object.entries(columns)
    .filter(([, type]) => typeof type !== 'string')
    .map(([name, type]) => [name, { name, repetition_type: 'OPTIONAL', ...type }]));
  const schema = schemaFromColumnData({ columnData, schemaOverrides });
  return new Uint8Array(parquetWriteBuffer({ columnData: columnData.map(({ name, data }) => ({ name, data })), schema }));
}

export const archiveKey = (runDate, firstOrderId, table) => `orders/archived_on=${runDate}/batch-${firstOrderId}/${table}.parquet`;

// put(key, bytes) uploads one file. runDate is YYYY-MM-DD (Asia/Singapore).
export async function archiveBatch(conn, { orderAgeDays, batchSize, runDate, put }) {
  // SKIP LOCKED: an overlapping run (e.g. a retry) takes different orders instead of waiting.
  const [found] = await conn.query(
    `SELECT id FROM orders WHERE status IN (?) AND created_at < UTC_TIMESTAMP(3) - INTERVAL ? DAY
     ORDER BY created_at, id LIMIT ? FOR UPDATE SKIP LOCKED`,
    [CLOSED_STATUSES, orderAgeDays, batchSize],
  );
  if (!found.length) return 0;
  const ids = found.map((o) => o.id);

  for (const [table, { by, columns }] of Object.entries(TABLES)) {
    const [rows] = await conn.query(
      `SELECT ${Object.keys(columns).join(', ')} FROM ${table} WHERE ${by} IN (?) ORDER BY ${by}`,
      [ids],
    );
    await put(archiveKey(runDate, ids[0], table), toParquet(columns, rows));
  }

  await conn.query('DELETE FROM payments WHERE order_id IN (?)', [ids]);
  await conn.query('DELETE FROM orders WHERE id IN (?)', [ids]);
  return ids.length;
}
