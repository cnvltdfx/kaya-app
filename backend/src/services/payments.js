// Payment service: a simulated payment gateway supporting cards, PayNow and Apple Pay.
// In production this wraps a PCI-DSS compliant provider (e.g. Stripe / Adyen) so card data
// never touches our servers; API keys come from AWS Secrets Manager. We only store last4 + brand.
//
// Test cards: 4242 4242 4242 4242 (success), 4000 0000 0000 0002 (declined). Any future expiry, any CVC.
const crypto = require('crypto');
const { Router } = require('../lib/router');
const db = require('../lib/db');
const { requireAuth } = require('../lib/security');
const { log } = require('../lib/observability');

const router = Router();
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
async function charge({ method, card, amount, currency, orderId, userId }) {
  const reference = `PAY-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const base = { id: db.id('pmt'), orderId, userId, method, amount, currency, reference, createdAt: Date.now() };
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
  const rec = { ...base, ...result };
  await db.query(
    `INSERT INTO payments (id, order_id, user_id, method, amount, currency, reference, status, error, brand, last4, paynow_ref, uen, created_at, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [rec.id, orderId, userId, method, amount, currency, reference, rec.status, rec.error || null, rec.brand || null, rec.last4 || null,
      rec.paynowRef || null, rec.uen || null, db.ts(rec.createdAt), rec.status === 'paid' ? db.ts(rec.createdAt) : null],
  );
  log(result.status === 'failed' ? 'warn' : 'info', 'payment', { orderId, method, status: result.status, amount, currency });
  return rec;
}

async function refund(orderId) {
  const r = await db.query("UPDATE payments SET status = 'refunded', refunded_at = ? WHERE order_id = ? AND status = 'paid'", [db.ts(Date.now()), orderId]);
  return r.affectedRows > 0;
}

// Latest payment attempt for an order, without the columns that don't apply to it.
async function latestPayment(orderId) {
  const p = await db.one('SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1', [orderId]);
  return p && Object.fromEntries(Object.entries(p).filter(([, v]) => v !== null));
}

// Simulates the bank webhook that confirms a PayNow transfer.
router.post('/:orderId/paynow/confirm', requireAuth, async (req, res) => {
  const orders = require('./orders');
  const order = await orders.getOrder(req.params.orderId);
  if (!order || order.userId !== req.user.id) return res.status(404).json({ error: 'Order not found.' });
  const notAwaiting = { error: 'This order is not awaiting payment.' };
  if (order.status !== 'pending_payment') return res.status(409).json(notAwaiting);
  // Record the transfer first; a second confirmation finds no pending payment and stops here.
  const r = await db.query("UPDATE payments SET status = 'paid', paid_at = ? WHERE order_id = ? AND status = 'pending'", [db.ts(Date.now()), order.id]);
  if (!r.affectedRows) return res.status(409).json(notAwaiting);
  res.json({ order: await orders.paymentReceived(order, req.user) });
});

router.get('/:orderId/receipt', requireAuth, async (req, res) => {
  const order = await require('./orders').getOrder(req.params.orderId);
  const staff = ['staff', 'admin'].includes(req.user.role);
  if (!order || (order.userId !== req.user.id && !staff)) return res.status(404).json({ error: 'Order not found.' });
  res.json({ order, payment: await latestPayment(order.id) });
});

module.exports = router;
Object.assign(module.exports, { charge, refund, METHODS, validateCard });
