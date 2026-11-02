import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEmail } from '../templates.mjs';

const base = {
  orderId: 'KK100123', email: 'a@example.com', customerName: 'Ah Lian', currency: 'SGD', total: 32,
  items: [{ name: 'Classic Pandan Kaya', qty: 2 }, { name: 'Musang King Durian Kaya', qty: 1 }],
};

test('confirmed paid order', () => {
  const e = buildEmail({ ...base, status: 'confirmed', orderStatus: 'processing', paymentStatus: 'paid' });
  assert.equal(e.to, 'a@example.com');
  assert.equal(e.subject, 'Order KK100123 confirmed');
  assert.match(e.text, /Thanks Ah Lian! We've received your order KK100123 \(SGD 32\.00\)/);
  assert.match(e.text, /2 x Classic Pandan Kaya/);
  assert.match(e.html, /Total: SGD 32\.00/);
});

test('confirmed PayNow order waiting for payment', () => {
  const e = buildEmail({ ...base, status: 'confirmed', orderStatus: 'pending_payment', paymentStatus: 'pending' });
  assert.equal(e.subject, 'Complete payment for KK100123');
  assert.match(e.text, /pay SGD 32\.00/);
});

test('rejected paid order mentions the refund and the reason', () => {
  const e = buildEmail({ ...base, status: 'rejected', orderStatus: 'rejected', paymentStatus: 'refunded', reason: 'Musang King Durian Kaya is out of stock' });
  assert.equal(e.subject, "We couldn't fulfil order KK100123");
  assert.match(e.text, /Musang King Durian Kaya is out of stock/);
  assert.match(e.text, /refunded within 5-7 business days/);
});

test('rejected unpaid order says nothing was charged', () => {
  const e = buildEmail({ ...base, status: 'rejected', orderStatus: 'rejected', paymentStatus: 'cancelled', reason: 'x is out of stock' });
  assert.match(e.text, /You have not been charged/);
  assert.doesNotMatch(e.text, /refunded/);
});

test('customer-supplied text is escaped in the HTML', () => {
  const e = buildEmail({ ...base, customerName: '<script>x</script>', status: 'confirmed', orderStatus: 'processing', paymentStatus: 'paid' });
  assert.doesNotMatch(e.html, /<script>/);
  assert.match(e.html, /&lt;script&gt;/);
});

test('other statuses have no customer email', () => {
  assert.equal(buildEmail({ ...base, status: 'confirmed', orderStatus: 'shipped' }), null);
});
