// Payment service: a simulated payment gateway supporting cards, PayNow and Apple Pay.
// In production this wraps a PCI-DSS compliant provider (e.g. Stripe / Adyen) so card data
// never touches our servers; API keys come from AWS Secrets Manager. We only store last4 + brand.
//
// Test cards: 4242 4242 4242 4242 (success), 4000 0000 0000 0002 (declined). Any future expiry, any CVC.
const express = require('express');
const crypto = require('crypto');
const { table, id } = require('../lib/db');
const { requireAuth } = require('../lib/security');
const { log } = require('../lib/observability');

const router = express.Router();
const METHODS = ['card', 'paynow', 'applepay'];

function luhn(num) {
  let sum = 0;
  let dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = Number(num[i]);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function brandOf(num) {
  if (/^4/.test(num)) return 'Visa';
  if (/^(5[1-5]|2[2-7])/.test(num)) return 'Mastercard';
  if (/^3[47]/.test(num)) return 'Amex';
  return 'Card';
}

function validateCard(card = {}) {
  const num = String(card.number || '').replace(/\D/g, '');
  if (num.length < 13 || num.length > 19 || !luhn(num)) return { error: 'Card number is invalid.' };
  const m = String(card.expiry || '').match(/^(\d{1,2})\s*\/\s*(\d{2})$/);
  if (!m) return { error: 'Expiry must be in MM/YY format.' };
  const month = Number(m[1]);
  const year = 2000 + Number(m[2]);
  const now = new Date();
  if (month < 1 || month > 12 || year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) return { error: 'Card has expired.' };
  if (!/^\d{3,4}$/.test(String(card.cvc || ''))) return { error: 'CVC is invalid.' };
  if (!String(card.name || '').trim()) return { error: 'Please enter the name on the card.' };
  return { num, brand: brandOf(num), last4: num.slice(-4) };
}

// Returns { status: 'paid' | 'pending' | 'failed', ... }
function charge({ method, card, amount, currency, orderId, userId }) {
  const reference = `PAY-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const base = { id: id('pmt'), orderId, userId, method, amount, currency, reference, createdAt: Date.now() };
  let result;
  if (method === 'card') {
    const v = validateCard(card);
    if (v.error) result = { status: 'failed', error: v.error };
    else if (v.num.endsWith('0002')) result = { status: 'failed', error: 'Your card was declined by the bank.', brand: v.brand, last4: v.last4 };
    else result = { status: 'paid', brand: v.brand, last4: v.last4 };
  } else if (method === 'paynow') {
    result = { status: 'pending', paynowRef: `KK${Date.now().toString().slice(-8)}`, uen: '202312345K' };
  } else if (method === 'applepay') {
    result = { status: 'paid', brand: 'Apple Pay', last4: null };
  } else {
    result = { status: 'failed', error: 'Unsupported payment method.' };
  }
  const rec = table('payments').insert({ ...base, ...result });
  log(result.status === 'failed' ? 'warn' : 'info', 'payment', { orderId, method, status: result.status, amount, currency });
  return rec;
}

function refund(orderId) {
  const p = table('payments').find((x) => x.orderId === orderId && x.status === 'paid');
  if (p) table('payments').update(p.id, { status: 'refunded', refundedAt: Date.now() });
  return p;
}

// Simulates the bank webhook that confirms a PayNow transfer.
router.post('/:orderId/paynow/confirm', requireAuth, (req, res) => {
  const order = table('orders').get(req.params.orderId);
  if (!order || order.userId !== req.user.id) return res.status(404).json({ error: 'Order not found.' });
  if (order.paymentStatus !== 'pending') return res.status(409).json({ error: 'This order is not awaiting payment.' });
  const pmt = table('payments').find((p) => p.orderId === order.id && p.status === 'pending');
  if (pmt) table('payments').update(pmt.id, { status: 'paid', paidAt: Date.now() });
  const orders = require('./orders');
  const updated = orders.markPaid(order, req.user);
  res.json({ order: updated });
});

router.get('/:orderId/receipt', requireAuth, (req, res) => {
  const order = table('orders').get(req.params.orderId);
  const staff = ['staff', 'admin'].includes(req.user.role);
  if (!order || (order.userId !== req.user.id && !staff)) return res.status(404).json({ error: 'Order not found.' });
  const payment = table('payments').filter((p) => p.orderId === order.id).sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  res.json({ order, payment });
});

module.exports = router;
Object.assign(module.exports, { charge, refund, METHODS, validateCard });
