// Staff back-office: dashboard KPIs, product & inventory management, order fulfilment,
// promotions, sales reports (pushed to S3), service metrics/alerts and the notification outbox.
const { Router } = require('../lib/router');
const db = require('../lib/db');
const { requireStaff, getUser } = require('../lib/security');
const { findProducts, decorateProduct } = require('../lib/pricing');
const { MARKETS } = require('../lib/markets');
const obs = require('../lib/observability');
const orders = require('./orders');
const notifications = require('./notifications');
const reports = require('./reports');
const { CATEGORIES } = require('./catalog');

const router = Router();
router.use(requireStaff);

const r2 = (n) => Math.round(n * 100) / 100;
async function audit(req, action, meta) {
  await db.query('INSERT INTO audit_log (id, user_id, action, meta, at) VALUES (?, ?, ?, ?, ?)', [db.id('aud'), req.user.id, action, db.json(meta), db.ts(Date.now())]);
}

// camelCase record -> column map for INSERT ... SET ? / UPDATE ... SET ?
const columns = (rec) => Object.fromEntries(Object.entries(rec).map(([k, v]) => [db.snake(k), v]));

router.get('/dashboard', async (req, res) => {
  const days = Math.max(1, Math.min(90, Number(req.query.days) || 30));
  const since = db.ts(Date.now() - days * 864e5);
  const PAID = "o.payment_status = 'paid' AND o.created_at >= ?";
  const markets = await db.query(`SELECT o.market, COUNT(*) AS orders, SUM(o.total_sgd) AS revenue_sgd FROM orders o WHERE ${PAID} GROUP BY o.market`, [since]);
  // Days are Singapore calendar days (UTC+8, no DST).
  const daily = await db.query(`SELECT DATE_FORMAT(o.created_at + INTERVAL 8 HOUR, '%Y-%m-%d') AS day, SUM(o.total_sgd) AS revenue_sgd FROM orders o WHERE ${PAID} GROUP BY day`, [since]);
  const top = await db.query(`SELECT i.name, SUM(i.qty) AS units FROM order_items i JOIN orders o ON o.id = i.order_id WHERE ${PAID} GROUP BY i.name ORDER BY units DESC, i.name LIMIT 5`, [since]);
  const statuses = await db.query('SELECT status, COUNT(*) AS n FROM orders GROUP BY status');
  const { customers } = await db.one("SELECT COUNT(*) AS customers FROM users WHERE role = 'customer'");
  const lowStock = await db.query('SELECT id, name, stock FROM products WHERE active AND stock <= low_stock_threshold ORDER BY created_at, id');

  const byMarket = Object.fromEntries(Object.keys(MARKETS).map((k) => [k, { orders: 0, revenueSgd: 0 }]));
  for (const m of markets) byMarket[m.market] = { orders: m.orders, revenueSgd: r2(m.revenueSgd) };
  const paidOrders = markets.reduce((s, m) => s + m.orders, 0);
  const revenue = markets.reduce((s, m) => s + m.revenueSgd, 0);
  const byDay = Object.fromEntries(daily.map((d) => [d.day, d.revenueSgd]));
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toLocaleDateString('sv-SE', { timeZone: 'Asia/Singapore' });
    series.push({ date: d, revenueSgd: r2(byDay[d] || 0) });
  }
  res.json({
    days,
    revenueSgd: r2(revenue),
    orders: paidOrders,
    aovSgd: paidOrders ? r2(revenue / paidOrders) : 0,
    customers,
    byMarket,
    series,
    topProducts: top.map((t) => ({ name: t.name, units: Number(t.units) })),
    lowStock,
    statusCounts: Object.fromEntries(statuses.map((s) => [s.status, s.n])),
  });
});

// ---- Products & inventory
router.get('/products', async (req, res) => {
  res.json({ products: (await findProducts()).map((p) => decorateProduct(p, 'SG')), categories: CATEGORIES });
});

const getProduct = (productId) => db.one('SELECT * FROM products WHERE id = ?', [String(productId)]);

function productPatch(b) {
  const patch = {};
  if (b.name !== undefined) patch.name = String(b.name).trim().slice(0, 100);
  if (b.size !== undefined) patch.size = String(b.size).slice(0, 30);
  if (b.description !== undefined) patch.description = String(b.description).slice(0, 2000);
  if (b.ingredients !== undefined) patch.ingredients = String(b.ingredients).slice(0, 500);
  if (b.category !== undefined && CATEGORIES.some((c) => c.id === b.category)) patch.category = b.category;
  if (b.price !== undefined) { const v = Number(b.price); if (!(v > 0)) throw new Error('Price must be greater than 0.'); patch.price = r2(v); }
  if (b.salePct !== undefined) { const v = Number(b.salePct); if (!(v >= 0 && v < 90)) throw new Error('Sale % must be between 0 and 89.'); patch.salePct = Math.round(v); }
  if (b.stock !== undefined) { const v = Number(b.stock); if (!(Number.isInteger(v) && v >= 0)) throw new Error('Stock must be a whole number.'); patch.stock = v; }
  if (b.lowStockThreshold !== undefined) patch.lowStockThreshold = Math.max(0, Math.floor(Number(b.lowStockThreshold) || 0));
  if (b.featured !== undefined) patch.featured = !!b.featured;
  if (b.active !== undefined) patch.active = !!b.active;
  return patch;
}

router.post('/products', async (req, res) => {
  let patch;
  try { patch = productPatch(req.body || {}); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (!patch.name || !patch.price || !patch.category) return res.status(400).json({ error: 'Name, price and category are required.' });
  const slug = patch.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36);
  const p = {
    id: `prd_${slug}`, slug, size: '250g', description: '', ingredients: '', salePct: 0, stock: 0, lowStockThreshold: 15,
    featured: false, active: true, image: '/img/products/classic-pandan.svg', createdAt: Date.now(), ...patch,
  };
  await db.query('INSERT INTO products SET ?', [columns({ ...p, createdAt: db.ts(p.createdAt) })]);
  await audit(req, 'product.create', { productId: p.id });
  res.status(201).json({ product: await getProduct(p.id) });
});

router.put('/products/:id', async (req, res) => {
  let patch;
  try { patch = productPatch(req.body || {}); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (Object.keys(patch).length) await db.query('UPDATE products SET ? WHERE id = ?', [columns(patch), String(req.params.id)]);
  const p = await getProduct(req.params.id);
  if (!p) return res.status(404).json({ error: 'Product not found.' });
  await audit(req, 'product.update', { productId: p.id, fields: Object.keys(patch) });
  res.json({ product: p });
});

// ---- Orders
const TRANSITIONS = {
  pending_payment: ['cancelled'],
  processing: ['shipped', 'ready_for_pickup', 'cancelled'],
  shipped: ['delivered'],
  ready_for_pickup: ['delivered'],
  delivered: [],
  cancelled: [],
};

router.get('/orders', async (req, res) => {
  const { status, market, q } = req.query;
  const where = ['1 = 1'];
  const params = [];
  if (status) { where.push('o.status = ?'); params.push(String(status)); }
  if (market) { where.push('o.market = ?'); params.push(String(market)); }
  if (q) {
    const like = `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push('(o.id LIKE ? OR o.email LIKE ?)');
    params.push(like, like);
  }
  const sql = where.join(' AND ');
  const { total } = await db.one(`SELECT COUNT(*) AS total FROM orders o WHERE ${sql}`, params);
  res.json({ orders: await orders.findOrders(sql, params, { limit: 200 }), total, transitions: TRANSITIONS });
});

router.put('/orders/:id/status', async (req, res) => {
  const order = await orders.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const next = req.body?.status;
  const conflict = { error: `Cannot move order from ${order.status} to ${next}.` };
  if (!(TRANSITIONS[order.status] || []).includes(next)) return res.status(409).json(conflict);
  if (next === 'ready_for_pickup' && order.fulfilment !== 'pickup') return res.status(409).json({ error: 'Only pickup orders can be marked ready for pickup.' });
  if (next === 'shipped' && order.fulfilment !== 'delivery') return res.status(409).json({ error: 'Pickup orders are not shipped.' });
  const note = `Updated by ${req.user.name}`;
  const updated = next === 'cancelled' ? await orders.cancelOrder(order, note) : await orders.setStatus(order, next, note);
  if (!updated) return res.status(409).json(conflict); // someone else changed it first
  const customer = await getUser(order.userId);
  if (customer) await notifications.notifyOrder(updated, customer, next);
  await audit(req, 'order.status', { orderId: order.id, from: order.status, to: next });
  res.json({ order: updated });
});

// ---- Promotions
router.get('/promotions', async (_req, res) => res.json({ promotions: await db.query('SELECT * FROM promotions ORDER BY code') }));

router.post('/promotions', async (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim().toUpperCase();
  const exists = { error: 'That code already exists.' };
  if (!/^[A-Z0-9]{3,20}$/.test(code)) return res.status(400).json({ error: 'Code must be 3-20 letters/numbers.' });
  if (await db.one('SELECT 1 FROM promotions WHERE code = ?', [code])) return res.status(409).json(exists);
  const type = b.type === 'shipping' ? 'shipping' : 'percent';
  const value = Number(b.value) || 0;
  if (type === 'percent' && !(value > 0 && value <= 50)) return res.status(400).json({ error: 'Discount must be between 1 and 50%.' });
  const promo = { id: db.id('promo'), code, description: String(b.description || '').slice(0, 120) || `${value}% off`, type, value, minSpend: Math.max(0, Number(b.minSpend) || 0), firstOrderOnly: false, active: true };
  try {
    await db.query('INSERT INTO promotions SET ?', [columns(promo)]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json(exists);
    throw err;
  }
  await audit(req, 'promotion.create', { code });
  res.status(201).json({ promotion: promo });
});

router.put('/promotions/:id', async (req, res) => {
  await db.query('UPDATE promotions SET active = ? WHERE id = ?', [!!req.body?.active, String(req.params.id)]);
  const p = await db.one('SELECT * FROM promotions WHERE id = ?', [String(req.params.id)]);
  if (!p) return res.status(404).json({ error: 'Promotion not found.' });
  await audit(req, 'promotion.toggle', { code: p.code, active: p.active });
  res.json({ promotion: p });
});

// ---- Reports (pushed to S3)
router.get('/reports', async (_req, res) => {
  res.json({ reports: await reports.listReports(50), destination: reports.destination() });
});

router.post('/reports', async (req, res) => {
  const type = req.body?.type === 'inventory' ? 'inventory' : 'sales';
  const rec = await reports.runReport({ type, days: req.body?.days, trigger: 'manual', by: req.user.email });
  await audit(req, 'report.run', { type, location: rec.location });
  res.status(201).json({ report: rec });
});

router.get('/reports/:id/download', async (req, res) => {
  const rec = await reports.getReport(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Report not found.' });
  const body = await reports.readReport(rec);
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', `attachment; filename="${rec.key.split('/').pop()}"`);
  res.send(body);
});

// ---- Observability
router.get('/metrics', (_req, res) => res.json(obs.snapshot()));

router.get('/notifications', async (_req, res) => {
  res.json({ notifications: await db.query(`SELECT ${notifications.COLUMNS} FROM notifications ORDER BY created_at DESC, id LIMIT 100`) });
});

router.get('/audit', async (_req, res) => {
  const entries = await db.query('SELECT a.*, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.at DESC, a.id LIMIT 100');
  res.json({ entries });
});

module.exports = router;
