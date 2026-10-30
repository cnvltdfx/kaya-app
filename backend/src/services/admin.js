// Staff back-office: dashboard KPIs, product & inventory management, order fulfilment,
// promotions, sales reports (pushed to S3), service metrics/alerts and the notification outbox.
const express = require('express');
const { table, id } = require('../lib/db');
const { requireStaff } = require('../lib/security');
const { decorateProduct } = require('../lib/pricing');
const { MARKETS } = require('../lib/markets');
const obs = require('../lib/observability');
const orders = require('./orders');
const notifications = require('./notifications');
const reports = require('./reports');
const { CATEGORIES } = require('./catalog');

const router = express.Router();
router.use(requireStaff);

const r2 = (n) => Math.round(n * 100) / 100;
function audit(req, action, meta) {
  table('auditLog').insert({ id: id('aud'), userId: req.user.id, action, meta, at: Date.now() });
}

router.get('/dashboard', (req, res) => {
  const days = Math.max(1, Math.min(90, Number(req.query.days) || 30));
  const since = Date.now() - days * 864e5;
  const paid = table('orders').filter((o) => o.createdAt >= since && o.paymentStatus === 'paid');
  const revenue = paid.reduce((s, o) => s + o.totalSgd, 0);
  const byMarket = Object.fromEntries(Object.keys(MARKETS).map((k) => [k, { orders: 0, revenueSgd: 0 }]));
  const daily = {};
  const products = {};
  for (const o of paid) {
    byMarket[o.market].orders += 1;
    byMarket[o.market].revenueSgd += o.totalSgd;
    const day = new Date(o.createdAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Singapore' });
    daily[day] = (daily[day] || 0) + o.totalSgd;
    for (const it of o.items) products[it.name] = (products[it.name] || 0) + it.qty;
  }
  for (const v of Object.values(byMarket)) v.revenueSgd = r2(v.revenueSgd);
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toLocaleDateString('sv-SE', { timeZone: 'Asia/Singapore' });
    series.push({ date: d, revenueSgd: r2(daily[d] || 0) });
  }
  const statusCounts = {};
  for (const o of table('orders').all()) statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
  res.json({
    days,
    revenueSgd: r2(revenue),
    orders: paid.length,
    aovSgd: paid.length ? r2(revenue / paid.length) : 0,
    customers: table('users').filter((u) => u.role === 'customer').length,
    byMarket,
    series,
    topProducts: Object.entries(products).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, units]) => ({ name, units })),
    lowStock: table('products').filter((p) => p.active && p.stock <= p.lowStockThreshold).map((p) => ({ id: p.id, name: p.name, stock: p.stock })),
    statusCounts,
  });
});

// ---- Products & inventory
router.get('/products', (req, res) => {
  res.json({ products: table('products').all().map((p) => decorateProduct(p, 'SG')), categories: CATEGORIES });
});

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

router.post('/products', (req, res) => {
  try {
    const patch = productPatch(req.body || {});
    if (!patch.name || !patch.price || !patch.category) return res.status(400).json({ error: 'Name, price and category are required.' });
    const slug = patch.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36);
    const p = table('products').insert({
      id: `prd_${slug}`, slug, size: '250g', description: '', ingredients: '', salePct: 0, stock: 0, lowStockThreshold: 15,
      featured: false, active: true, image: '/img/products/classic-pandan.svg', createdAt: Date.now(), ...patch,
    });
    audit(req, 'product.create', { productId: p.id });
    res.status(201).json({ product: p });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put('/products/:id', (req, res) => {
  try {
    const patch = productPatch(req.body || {});
    const p = table('products').update(req.params.id, patch);
    if (!p) return res.status(404).json({ error: 'Product not found.' });
    audit(req, 'product.update', { productId: p.id, fields: Object.keys(patch) });
    res.json({ product: p });
  } catch (e) { res.status(400).json({ error: e.message }); }
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

router.get('/orders', (req, res) => {
  const { status, market, q } = req.query;
  let list = table('orders').all();
  if (status) list = list.filter((o) => o.status === status);
  if (market) list = list.filter((o) => o.market === market);
  if (q) { const s = String(q).toLowerCase(); list = list.filter((o) => o.id.toLowerCase().includes(s) || o.email.includes(s)); }
  list = [...list].sort((a, b) => b.createdAt - a.createdAt);
  res.json({ orders: list.slice(0, 200), total: list.length, transitions: TRANSITIONS });
});

router.put('/orders/:id/status', (req, res) => {
  const order = table('orders').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const next = req.body?.status;
  if (!(TRANSITIONS[order.status] || []).includes(next)) return res.status(409).json({ error: `Cannot move order from ${order.status} to ${next}.` });
  if (next === 'ready_for_pickup' && order.fulfilment !== 'pickup') return res.status(409).json({ error: 'Only pickup orders can be marked ready for pickup.' });
  if (next === 'shipped' && order.fulfilment !== 'delivery') return res.status(409).json({ error: 'Pickup orders are not shipped.' });
  if (next === 'cancelled') {
    orders.adjustStock(order.items, +1);
    require('./payments').refund(order.id);
    table('orders').update(order.id, { paymentStatus: order.paymentStatus === 'paid' ? 'refunded' : 'cancelled' });
  }
  const updated = orders.setStatus(order, next, `Updated by ${req.user.name}`);
  const customer = table('users').get(order.userId);
  if (customer) notifications.notifyOrder(updated, customer, next);
  audit(req, 'order.status', { orderId: order.id, from: order.status, to: next });
  res.json({ order: updated });
});

// ---- Promotions
router.get('/promotions', (_req, res) => res.json({ promotions: table('promotions').all() }));

router.post('/promotions', (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,20}$/.test(code)) return res.status(400).json({ error: 'Code must be 3-20 letters/numbers.' });
  if (table('promotions').find((p) => p.code === code)) return res.status(409).json({ error: 'That code already exists.' });
  const type = b.type === 'shipping' ? 'shipping' : 'percent';
  const value = Number(b.value) || 0;
  if (type === 'percent' && !(value > 0 && value <= 50)) return res.status(400).json({ error: 'Discount must be between 1 and 50%.' });
  const promo = table('promotions').insert({ id: id('promo'), code, description: String(b.description || '').slice(0, 120) || `${value}% off`, type, value, minSpend: Math.max(0, Number(b.minSpend) || 0), firstOrderOnly: false, active: true });
  audit(req, 'promotion.create', { code });
  res.status(201).json({ promotion: promo });
});

router.put('/promotions/:id', (req, res) => {
  const p = table('promotions').update(req.params.id, { active: !!req.body?.active });
  if (!p) return res.status(404).json({ error: 'Promotion not found.' });
  audit(req, 'promotion.toggle', { code: p.code, active: p.active });
  res.json({ promotion: p });
});

// ---- Reports (pushed to S3)
router.get('/reports', (_req, res) => {
  res.json({ reports: table('reports').all().slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 50), destination: reports.destination() });
});

router.post('/reports', async (req, res, next) => {
  try {
    const type = req.body?.type === 'inventory' ? 'inventory' : 'sales';
    const rec = await reports.runReport({ type, days: req.body?.days, trigger: 'manual', by: req.user.email });
    audit(req, 'report.run', { type, location: rec.location });
    res.status(201).json({ report: rec });
  } catch (e) { next(e); }
});

router.get('/reports/:id/download', async (req, res, next) => {
  try {
    const rec = table('reports').get(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Report not found.' });
    const body = await reports.readReport(rec);
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="${rec.key.split('/').pop()}"`);
    res.send(body);
  } catch (e) { next(e); }
});

// ---- Observability
router.get('/metrics', (_req, res) => res.json(obs.snapshot()));

router.get('/notifications', (_req, res) => {
  res.json({ notifications: table('notifications').all().slice(-100).reverse() });
});

router.get('/audit', (_req, res) => {
  const users = Object.fromEntries(table('users').all().map((u) => [u.id, u.email]));
  res.json({ entries: table('auditLog').all().slice(-100).reverse().map((e) => ({ ...e, email: users[e.userId] })) });
});

module.exports = router;
