// Notification service: email + SMS.
// Locally, messages are written to an outbox (viewable in the app). In AWS this maps to
// Amazon SES (email) and Amazon SNS (SMS), triggered asynchronously via an SQS queue.
const { table, id } = require('../lib/db');
const { log } = require('../lib/observability');

function send({ userId = null, channel = 'email', to, subject, body, kind = 'general' }) {
  if (!to) return null;
  const rec = table('notifications').insert({
    id: id('ntf'), userId, channel, to, subject, body, kind, status: 'sent', createdAt: Date.now(),
  });
  log('info', 'notification.sent', { channel, kind, to: mask(to) });
  return rec;
}

function mask(s) {
  return String(s).replace(/^(.{2}).*(@.*)$/, '$1***$2').replace(/^(\+?\d{3}).*(\d{2})$/, '$1****$2');
}

function notifyOrder(order, user, event) {
  const msgs = {
    placed: [`Order ${order.id} confirmed`, `Thanks ${user.name}! We've received your order ${order.id} (${order.currency} ${order.total.toFixed(2)}). We'll let you know when it ships.`],
    awaiting_payment: [`Complete payment for ${order.id}`, `Scan the PayNow QR to pay ${order.currency} ${order.total.toFixed(2)} for order ${order.id}.`],
    processing: [`Order ${order.id} is being prepared`, `Your kaya is being freshly packed for order ${order.id}.`],
    shipped: [`Order ${order.id} has shipped`, `Good news! Order ${order.id} is on its way.`],
    ready_for_pickup: [`Order ${order.id} is ready for pickup`, `Order ${order.id} is ready for collection at Kool Kaya Kitchen, 1 Kaya Lane, Singapore.`],
    delivered: [`Order ${order.id} delivered`, `Order ${order.id} has been delivered. Enjoy, and leave us a review!`],
    cancelled: [`Order ${order.id} cancelled`, `Order ${order.id} has been cancelled. Any payment will be refunded within 5-7 business days.`],
  };
  const [subject, body] = msgs[event] || [`Order ${order.id} update`, `Your order status is now ${event}.`];
  send({ userId: user.id, channel: 'email', to: user.email, subject, body, kind: `order.${event}` });
  if (user.phone) send({ userId: user.id, channel: 'sms', to: user.phone, subject, body: `Kool Kaya: ${subject}.`, kind: `order.${event}` });
}

module.exports = { send, notifyOrder };
