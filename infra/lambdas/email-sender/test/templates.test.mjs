import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEmail } from '../templates.mjs';

const base = {
  orderId: 'KK100123', email: 'a@example.com', customerName: 'Ah Lian', currency: 'SGD', total: 32,
  items: [{ name: 'Classic Pandan Kaya', qty: 2 }, { name: 'Musang King Durian Kaya', qty: 1 }],
};

test('confirmed order', () => {
  const e = buildEmail({ ...base, status: 'confirmed', orderStatus: 'processing', paymentStatus: 'paid' });
  assert.equal(e.to, 'a@example.com');
  assert.equal(e.subject, 'Order KK100123 confirmed');
  assert.match(e.text, /Thanks Ah Lian! We've received your order KK100123 \(SGD 32\.00\)/);
  assert.match(e.text, /2 x Classic Pandan Kaya/);
  assert.match(e.html, /Total: SGD 32\.00/);
});

test('cancelled after checkout expired says nothing was charged', () => {
  const e = buildEmail({ ...base, status: 'cancelled', orderStatus: 'cancelled', paymentStatus: 'cancelled' });
  assert.equal(e.subject, 'Order KK100123 cancelled');
  assert.match(e.text, /wasn't completed in time/);
  assert.match(e.text, /You have not been charged/);
});

test('rejected (paid after cancel) promises a refund and hides the staff reason', () => {
  const e = buildEmail({ ...base, status: 'rejected', orderStatus: 'cancelled', paymentStatus: 'cancelled', reason: 'Payment received for cancelled order KK100123: refund it manually' });
  assert.equal(e.subject, 'Order KK100123 cancelled');
  assert.match(e.text, /refunded within 5-7 business days/);
  assert.doesNotMatch(e.text, /manually/);
});

test('customer-supplied text is escaped in the HTML', () => {
  const e = buildEmail({ ...base, customerName: '<script>x</script>', status: 'confirmed', orderStatus: 'processing', paymentStatus: 'paid' });
  assert.doesNotMatch(e.html, /<script>/);
  assert.match(e.html, /&lt;script&gt;/);
});

test('unknown statuses have no customer email', () => {
  assert.equal(buildEmail({ ...base, status: 'shipped', orderStatus: 'shipped' }), null);
});
