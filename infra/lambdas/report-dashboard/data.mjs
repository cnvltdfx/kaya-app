// Reads what the dashboard shows from MySQL and packs it small, because the page carries it for its filters.
//   orders  paidOrders() from backend/src/services/reports.js, over 2 x MAX_DAYS so every period has a comparison
//   stock   the product query of inventoryReport() in the same file
// Names become indexes into short lists and buyers become numbers. No customer names, emails or addresses
// are read at all, so none can end up in the page.
import { DAY, MAX_DAYS, STATUS_LABELS, sgtDayStart } from './view.mjs';

// backend/src/lib/markets.js
const MARKETS = [['SG', 'Singapore', 'SGD'], ['MY', 'Malaysia', 'MYR'], ['TH', 'Thailand', 'THB'], ['HK', 'Hong Kong', 'HKD']];
const PAYMENTS = ['card', 'paynow', 'applepay'];
const FULFILMENTS = ['delivery', 'pickup'];

const r2 = (n) => Math.round(n * 100) / 100;

// Run inside a transaction (db.mjs tx), so both queries read the same snapshot.
export async function loadDataset(conn, now) {
  const start = sgtDayStart(now) - 2 * MAX_DAYS * DAY;
  const [lines] = await conn.query(
    `SELECT o.id, o.created_at, o.user_id, o.market, o.currency, o.status, o.fulfilment, o.payment_method, o.total, o.total_sgd, o.promo_code,
            i.product_id, i.qty, i.unit_price_sgd
     FROM orders o JOIN order_items i ON i.order_id = o.id
     WHERE o.payment_status = 'paid' AND o.created_at >= ? AND o.created_at < ?
     ORDER BY o.created_at, o.id, i.line_no`,
    [new Date(start), new Date(now)],
  );
  const [products] = await conn.query('SELECT id, name, category, stock, low_stock_threshold, active FROM products ORDER BY created_at, id');
  return pack({ now, lines, products });
}

// Index of `key` in `list`, appending a new entry (make(key, ...extra)) the first time a key is seen.
function indexer(list, keyOf = (e) => e, make = (k) => k) {
  const index = new Map(list.map((e, i) => [keyOf(e), i]));
  return (key, ...extra) => {
    if (!index.has(key)) {
      index.set(key, list.length);
      list.push(make(key, ...extra));
    }
    return index.get(key);
  };
}

// lines: order lines as loadDataset selects them, oldest first, created_at a Date. products: product rows.
// Returns the dataset view.mjs decodes; orders are
//   [minutes since `start`, market, payment, fulfilment, status, total SGD, total local, buyer, promo or -1, [[product, qty, line SGD], ...]]
export function pack({ now, lines, products }) {
  const todayStart = sgtDayStart(now);
  const start = todayStart - 2 * MAX_DAYS * DAY;
  const lists = {
    markets: MARKETS.map((m) => [...m]),
    payments: [...PAYMENTS],
    fulfilments: [...FULFILMENTS],
    statuses: Object.keys(STATUS_LABELS),
    promos: [],
    products: products.map((p) => [p.name, p.category]),
  };
  const market = indexer(lists.markets, (m) => m[0], (code, currency) => [code, code, currency]);
  const payment = indexer(lists.payments);
  const fulfilment = indexer(lists.fulfilments);
  const status = indexer(lists.statuses);
  const promo = indexer(lists.promos);
  const buyer = indexer([]);
  const productIndex = new Map(products.map((p, i) => [p.id, i]));
  const product = (id) => {
    if (!productIndex.has(id)) {
      productIndex.set(id, lists.products.length);
      lists.products.push([id, '']); // no product row for it: its ID stands in for the name
    }
    return productIndex.get(id);
  };

  const orders = [];
  let last = null;
  for (const l of lines) {
    if (l.id !== last) {
      last = l.id;
      orders.push([
        Math.floor((l.created_at.getTime() - start) / 6e4), market(l.market, l.currency), payment(l.payment_method), fulfilment(l.fulfilment), status(l.status),
        l.total_sgd, l.total, buyer(l.user_id), l.promo_code ? promo(l.promo_code) : -1, [],
      ]);
    }
    orders[orders.length - 1][9].push([product(l.product_id), l.qty, r2(l.qty * l.unit_price_sgd)]);
  }

  const inventory = products.filter((p) => p.active).map((p) => [product(p.id), p.stock, p.low_stock_threshold]);
  return { v: 1, generatedAt: now, todayStart, start, ...lists, orders, inventory };
}
