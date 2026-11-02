// Order service: checkout, order history, status tracking, cancellation.
// Critical path (99.95% target): in AWS runs on multi-AZ compute with RDS Multi-AZ; events
// (order placed / status changed) are published to SQS/EventBridge for notifications and reporting.
const { Router } = require('../lib/router');
const db = require('../lib/db');
const { requireAuth, rateLimit } = require('../lib/security');
const { priceCart } = require('../lib/pricing');
const { market } = require('../lib/markets');
const { log, raiseAlert } = require('../lib/observability');
const orderQueue = require('../lib/orderQueue');
const payments = require('./payments');
const notifications = require('./notifications');
const cart = require('./cart');

const router = Router();
const checkoutLimiter = rateLimit({ windowMs: 60_000, max: 10, name: 'checkout' });

// Next KK order number from the shared sequence table, so API servers never hand out the same one.
async function nextOrderId() {
  const r = await db.query('INSERT INTO order_numbers () VALUES ()');
  return `KK${r.insertId}`;
}

const PICKUP_SLOTS = ['10:00-12:00', '12:00-14:00', '14:00-16:00', '16:00-18:00'];

// Loads orders matching `where` (trusted SQL on alias o) with their items and status history,
// in the API's order shape.
async function findOrders(where, params = [], { limit = 1000 } = {}) {
  const orders = await db.query(`SELECT o.* FROM orders o WHERE ${where} ORDER BY o.created_at DESC, o.id DESC LIMIT ?`, [...params, limit]);
  if (!orders.length) return [];
  const ids = orders.map((o) => o.id);
  const items = await db.query('SELECT * FROM order_items WHERE order_id IN (?) ORDER BY order_id, line_no', [ids]);
  const history = await db.query('SELECT * FROM order_status_history WHERE order_id IN (?) ORDER BY id', [ids]);
  const byOrder = new Map(orders.map((o) => [o.id, { ...o, items: [], statusHistory: [] }]));
  for (const { orderId, lineNo, ...it } of items) byOrder.get(orderId).items.push(it);
  for (const h of history) byOrder.get(h.orderId).statusHistory.push({ status: h.status, at: h.at, ...(h.note ? { note: h.note } : {}) });
  return [...byOrder.values()];
}

async function getOrder(orderId) {
  return (await findOrders('o.id = ?', [String(orderId)], { limit: 1 }))[0] || null;
}

async function insertOrder(t, o) {
  await t.query(
    `INSERT INTO orders (id, user_id, email, market, currency, fulfilment, address, pickup_slot, subtotal, discount, shipping,
       total, total_sgd, promo_code, payment_method, payment_status, payment_ref, paynow, status, idempotency_key, created_at, paid_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [o.id, o.userId, o.email, o.market, o.currency, o.fulfilment, db.json(o.address), db.json(o.pickupSlot), o.subtotal, o.discount, o.shipping,
      o.total, o.totalSgd, o.promoCode, o.paymentMethod, o.paymentStatus, o.paymentRef || null, db.json(o.paynow), o.status, o.idempotencyKey || null,
      db.ts(o.createdAt), db.ts(o.paidAt), db.ts(o.createdAt)],
  );
  await t.query(
    'INSERT INTO order_items (order_id, line_no, product_id, name, size, image, qty, unit_price_sgd, unit_price) VALUES ?',
    [o.items.map((it, n) => [o.id, n + 1, it.productId, it.name, it.size || null, it.image || null, it.qty, it.unitPriceSgd, it.unitPrice])],
  );
  await t.query('INSERT INTO order_status_history (order_id, status, note, at) VALUES ?', [o.statusHistory.map((h) => [o.id, h.status, h.note || null, db.ts(h.at)])]);
}

// Takes stock for every item, or none of them. The conditional UPDATE is what stops two shoppers
// on different servers from buying the last jar.
async function reserveStock(items) {
  const reserved = await db.tx(async (t) => {
    for (const it of items) {
      const r = await t.query('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?', [it.qty, it.productId, it.qty]);
      if (!r.affectedRows) throw Object.assign(new Error(`Sorry, ${it.name} just sold out.`), { soldOut: true });
    }
    return t.query('SELECT id, name, stock, low_stock_threshold FROM products WHERE id IN (?)', [items.map((it) => it.productId)]);
  }).catch((err) => { if (err.soldOut) return err; throw err; });
  if (reserved instanceof Error) return { error: reserved.message };
  for (const p of reserved) {
    const qty = items.filter((it) => it.productId === p.id).reduce((s, it) => s + it.qty, 0);
    if (p.stock <= p.lowStockThreshold && p.stock + qty > p.lowStockThreshold) {
      raiseAlert('LowStock', `${p.name} is down to ${p.stock} units`);
      await notifications.send({ channel: 'email', to: 'ops@koolkaya.sg', subject: `Low stock: ${p.name}`, body: `${p.name} has ${p.stock} units left. Please restock.`, kind: 'ops.low_stock' });
    }
  }
  return {};
}

async function releaseStock(items, t = db) {
  for (const it of items) await t.query('UPDATE products SET stock = stock + ? WHERE id = ?', [it.qty, it.productId]);
}

// Moves an order to `status` only if it is still in `from` (so two staff members, or a staff member
// and the customer, can't both act on the same order). Returns the updated order, or null.
async function setStatus(order, status, note, { from = order.status, patch = {} } = {}) {
  const now = Date.now();
  const ok = await db.tx(async (t) => {
    const cols = { ...patch, status, updated_at: db.ts(now) };
    const r = await t.query('UPDATE orders SET ? WHERE id = ? AND status = ?', [cols, order.id, from]);
    if (!r.affectedRows) return false;
    await t.query('INSERT INTO order_status_history (order_id, status, note, at) VALUES (?, ?, ?, ?)', [order.id, status, note || null, db.ts(now)]);
    return true;
  });
  return ok ? getOrder(order.id) : null;
}

async function markPaid(order, user) {
  const updated = await setStatus(order, 'processing', null, { from: 'pending_payment', patch: { payment_status: 'paid', paid_at: db.ts(Date.now()) } });
  if (updated) await notifications.notifyOrder(updated, user, 'placed');
  return updated;
}

// The payment for a `pending_payment` order has gone through. With a queue configured, the order
// worker confirms it (and emails the customer) a moment later; otherwise it is confirmed here.
// Returns the order as it stands now.
async function paymentReceived(order, user) {
  try {
    if (await orderQueue.sendOutcome(order.id, 'paid')) {
      log('info', 'order.queued', { orderId: order.id, outcome: 'paid' });
      return order;
    }
  } catch (err) {
    // The customer has paid, so don't fail the request: the order waits in `pending_payment`
    // with a paid payment row until someone re-sends it.
    log('error', 'order.queue_failed', { orderId: order.id, error: err.message });
    raiseAlert('OrderQueueSendFailed', `Order ${order.id} was paid but could not be queued: ${err.message}`);
    return order;
  }
  return (await markPaid(order, user)) || getOrder(order.id);
}

// Cancels an order still in `order.status`: returns its stock, refunds any payment.
async function cancelOrder(order, note) {
  const updated = await setStatus(order, 'cancelled', note, { patch: { payment_status: order.paymentStatus === 'paid' ? 'refunded' : 'cancelled' } });
  if (!updated) return null;
  await releaseStock(order.items);
  await payments.refund(order.id);
  return updated;
}

router.use(requireAuth);

router.post('/checkout', checkoutLimiter, async (req, res) => {
  const user = req.user;
  const b = req.body || {};
  const idemKey = req.get('idempotency-key')?.slice(0, 100) || null;
  if (idemKey) {
    const existing = await findOrders('o.user_id = ? AND o.idempotency_key = ?', [user.id, idemKey], { limit: 1 });
    if (existing.length) return res.json({ order: existing[0], duplicate: true });
  }

  const m = market(req.market);
  const fulfilment = b.fulfilment === 'pickup' && m.pickup ? 'pickup' : 'delivery';
  const items = (await cart.getCart(user.id)).items;
  const quote = await priceCart(items, req.market, { promoCode: b.promoCode, fulfilment, user });
  if (!quote.lines.length) return res.status(400).json({ error: 'Your cart is empty.' });
  if (quote.errors.length) return res.status(409).json({ error: quote.errors.join(' ') });
  if (b.promoCode && quote.promoError) return res.status(400).json({ error: quote.promoError });

  let address = null;
  let pickupSlot = null;
  if (fulfilment === 'delivery') {
    const a = b.address || {};
    if (!a.line1 || !a.city || !a.postcode) return res.status(400).json({ error: 'Please complete your delivery address.' });
    address = { name: String(a.name || user.name).slice(0, 80), line1: String(a.line1).slice(0, 120), line2: String(a.line2 || '').slice(0, 120), city: String(a.city).slice(0, 60), postcode: String(a.postcode).slice(0, 12), country: m.name, phone: String(a.phone || user.phone || '').slice(0, 20) };
  } else {
    if (!b.pickupDate || !PICKUP_SLOTS.includes(b.pickupSlot)) return res.status(400).json({ error: 'Please choose a pickup date and time slot.' });
    pickupSlot = { date: String(b.pickupDate).slice(0, 10), slot: b.pickupSlot, location: 'Kool Kaya Kitchen, 1 Kaya Lane #01-01, Singapore 123456' };
  }

  const method = b.payment?.method;
  if (!payments.METHODS.includes(method)) return res.status(400).json({ error: 'Please choose a payment method.' });
  if (method === 'paynow' && m.code !== 'SG') return res.status(400).json({ error: 'PayNow is only available in Singapore.' });

  // Reserve stock before charging so two shoppers can't buy the last jar.
  const orderItems = quote.lines.map((l) => ({ productId: l.productId, name: l.name, size: l.size, image: l.image, qty: l.qty, unitPriceSgd: l.unitPriceSgd, unitPrice: l.unitPrice }));
  const reservation = await reserveStock(orderItems);
  if (reservation.error) return res.status(409).json({ error: reservation.error });
  const orderId = await nextOrderId();

  const pmt = await payments.charge({ method, card: b.payment.card, amount: quote.total, currency: quote.currency, orderId, userId: user.id });
  if (pmt.status === 'failed') {
    await releaseStock(orderItems);
    return res.status(402).json({ error: pmt.error || 'Payment failed.' });
  }

  // Saved as awaiting payment even when the charge already went through: paymentReceived below
  // (or the order worker it queues for) moves it on, the same way a PayNow confirmation does.
  const now = Date.now();
  const order = {
    id: orderId, userId: user.id, email: user.email, market: m.code, currency: quote.currency,
    items: orderItems, fulfilment, address, pickupSlot,
    subtotal: quote.subtotal, discount: quote.discount, shipping: quote.shipping, total: quote.total, totalSgd: quote.totalSgd,
    promoCode: quote.promo?.code || null, paymentMethod: method,
    paymentStatus: 'pending',
    paymentRef: pmt.reference, paynow: pmt.status === 'pending' ? { ref: pmt.paynowRef, uen: pmt.uen } : null,
    status: 'pending_payment',
    statusHistory: [{ status: 'placed', at: now }, { status: 'pending_payment', at: now }],
    idempotencyKey: idemKey, createdAt: now, paidAt: null,
  };
  try {
    await db.tx(async (t) => {
      await insertOrder(t, order);
      await cart.clearCart(user.id, t);
    });
  } catch (err) {
    // Undo the reservation and charge; a retry with the same idempotency key that raced us wins.
    await releaseStock(orderItems);
    await payments.refund(orderId);
    if (err.code === 'ER_DUP_ENTRY' && idemKey) {
      const existing = await findOrders('o.user_id = ? AND o.idempotency_key = ?', [user.id, idemKey], { limit: 1 });
      if (existing.length) return res.json({ order: existing[0], duplicate: true });
    }
    throw err;
  }
  let saved = await getOrder(orderId);
  if (pmt.status === 'paid') saved = await paymentReceived(saved, user);
  else await notifications.notifyOrder(saved, user, 'awaiting_payment');
  log('info', 'order.placed', { orderId, market: m.code, totalSgd: quote.totalSgd, method });
  res.status(201).json({ order: saved });
});

router.get('/', async (req, res) => {
  const orders = await findOrders('o.user_id = ?', [req.user.id]);
  res.json({ orders });
});

router.get('/pickup-slots', (_req, res) => res.json({ slots: PICKUP_SLOTS }));

router.get('/:id', async (req, res) => {
  const order = await getOrder(req.params.id);
  const staff = ['staff', 'admin'].includes(req.user.role);
  if (!order || (order.userId !== req.user.id && !staff)) return res.status(404).json({ error: 'Order not found.' });
  res.json({ order });
});

router.post('/:id/cancel', async (req, res) => {
  const order = await getOrder(req.params.id);
  if (!order || order.userId !== req.user.id) return res.status(404).json({ error: 'Order not found.' });
  const cannot = { error: 'This order can no longer be cancelled.' };
  if (!['pending_payment', 'processing'].includes(order.status)) return res.status(409).json(cannot);
  const updated = await cancelOrder(order, 'Cancelled by customer');
  if (!updated) return res.status(409).json(cannot);
  await notifications.notifyOrder(updated, req.user, 'cancelled');
  res.json({ order: updated });
});

module.exports = router;
Object.assign(module.exports, { findOrders, getOrder, setStatus, markPaid, paymentReceived, cancelOrder, nextOrderId, insertOrder, PICKUP_SLOTS });
