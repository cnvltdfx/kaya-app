// Order service: checkout, order history, status tracking, cancellation.
// Critical path (99.95% target): in AWS runs on multi-AZ compute with RDS Multi-AZ; events
// (order placed / status changed) are published to SQS/EventBridge for notifications and reporting.
const express = require('express');
const { table, flush } = require('../lib/db');
const { requireAuth, rateLimit } = require('../lib/security');
const { priceCart } = require('../lib/pricing');
const { market } = require('../lib/markets');
const { log, raiseAlert } = require('../lib/observability');
const payments = require('./payments');
const notifications = require('./notifications');
const cart = require('./cart');

const router = express.Router();
const checkoutLimiter = rateLimit({ windowMs: 60_000, max: 10, name: 'checkout' });

let seq = null;
function nextOrderId() {
  if (seq === null) seq = table('orders').all().reduce((m, o) => Math.max(m, Number(o.id.slice(2)) || 0), 100000);
  seq += 1;
  return `KK${seq}`;
}

const PICKUP_SLOTS = ['10:00-12:00', '12:00-14:00', '14:00-16:00', '16:00-18:00'];

function adjustStock(items, sign) {
  for (const it of items) {
    const p = table('products').get(it.productId);
    if (!p) continue;
    const stock = p.stock + sign * it.qty;
    table('products').update(p.id, { stock });
    if (sign < 0 && stock <= p.lowStockThreshold && p.stock > p.lowStockThreshold) {
      raiseAlert('LowStock', `${p.name} is down to ${stock} units`);
      notifications.send({ channel: 'email', to: 'ops@koolkaya.sg', subject: `Low stock: ${p.name}`, body: `${p.name} has ${stock} units left. Please restock.`, kind: 'ops.low_stock' });
    }
  }
}

function setStatus(order, status, note) {
  const history = [...(order.statusHistory || []), { status, at: Date.now(), ...(note ? { note } : {}) }];
  return table('orders').update(order.id, { status, statusHistory: history });
}

function markPaid(order, user) {
  table('orders').update(order.id, { paymentStatus: 'paid', paidAt: Date.now() });
  const updated = setStatus(order, 'processing');
  notifications.notifyOrder(updated, user, 'placed');
  return updated;
}

router.use(requireAuth);

router.post('/checkout', checkoutLimiter, (req, res) => {
  const user = req.user;
  const b = req.body || {};
  const idemKey = req.get('idempotency-key');
  if (idemKey) {
    const existing = table('orders').find((o) => o.userId === user.id && o.idempotencyKey === idemKey);
    if (existing) return res.json({ order: existing, duplicate: true });
  }

  const m = market(req.market);
  const fulfilment = b.fulfilment === 'pickup' && m.pickup ? 'pickup' : 'delivery';
  const items = cart.getCart(user.id).items;
  const quote = priceCart(items, req.market, { promoCode: b.promoCode, fulfilment, user });
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
  const orderId = nextOrderId();
  const orderItems = quote.lines.map((l) => ({ productId: l.productId, name: l.name, size: l.size, image: l.image, qty: l.qty, unitPriceSgd: l.unitPriceSgd, unitPrice: l.unitPrice }));
  adjustStock(orderItems, -1);

  const pmt = payments.charge({ method, card: b.payment.card, amount: quote.total, currency: quote.currency, orderId, userId: user.id });
  if (pmt.status === 'failed') {
    adjustStock(orderItems, +1);
    return res.status(402).json({ error: pmt.error || 'Payment failed.' });
  }

  const now = Date.now();
  const order = table('orders').insert({
    id: orderId, userId: user.id, email: user.email, market: m.code, currency: quote.currency,
    items: orderItems, fulfilment, address, pickupSlot,
    subtotal: quote.subtotal, discount: quote.discount, shipping: quote.shipping, total: quote.total, totalSgd: quote.totalSgd,
    promoCode: quote.promo?.code || null, paymentMethod: method,
    paymentStatus: pmt.status === 'paid' ? 'paid' : 'pending',
    paymentRef: pmt.reference, paynow: pmt.status === 'pending' ? { ref: pmt.paynowRef, uen: pmt.uen } : null,
    status: pmt.status === 'paid' ? 'processing' : 'pending_payment',
    statusHistory: [{ status: 'placed', at: now }, { status: pmt.status === 'paid' ? 'processing' : 'pending_payment', at: now }],
    idempotencyKey: idemKey || null, createdAt: now,
  });
  cart.clearCart(user.id);
  flush();
  notifications.notifyOrder(order, user, pmt.status === 'paid' ? 'placed' : 'awaiting_payment');
  log('info', 'order.placed', { orderId, market: m.code, totalSgd: quote.totalSgd, method });
  res.status(201).json({ order });
});

router.get('/', (req, res) => {
  const orders = table('orders').filter((o) => o.userId === req.user.id).sort((a, b) => b.createdAt - a.createdAt);
  res.json({ orders });
});

router.get('/pickup-slots', (_req, res) => res.json({ slots: PICKUP_SLOTS }));

router.get('/:id', (req, res) => {
  const order = table('orders').get(req.params.id);
  const staff = ['staff', 'admin'].includes(req.user.role);
  if (!order || (order.userId !== req.user.id && !staff)) return res.status(404).json({ error: 'Order not found.' });
  res.json({ order });
});

router.post('/:id/cancel', (req, res) => {
  const order = table('orders').get(req.params.id);
  if (!order || order.userId !== req.user.id) return res.status(404).json({ error: 'Order not found.' });
  if (!['pending_payment', 'processing'].includes(order.status)) return res.status(409).json({ error: 'This order can no longer be cancelled.' });
  adjustStock(order.items, +1);
  payments.refund(order.id);
  table('orders').update(order.id, { paymentStatus: order.paymentStatus === 'paid' ? 'refunded' : 'cancelled' });
  const updated = setStatus(order, 'cancelled', 'Cancelled by customer');
  notifications.notifyOrder(updated, req.user, 'cancelled');
  res.json({ order: updated });
});

module.exports = router;
Object.assign(module.exports, { setStatus, markPaid, adjustStock, PICKUP_SLOTS });
