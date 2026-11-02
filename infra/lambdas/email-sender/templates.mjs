// Customer emails for order events from the order worker (see infra/lambdas/order-worker/order.mjs).
// Wording follows backend/src/services/notifications.js notifyOrder.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// evt: { orderId, status, orderStatus, paymentStatus, reason?, email, customerName, currency, total, items: [{ name, qty }] }
// status: confirmed | cancelled (checkout expired) | rejected (paid after the order was cancelled).
// `reason` is for staff (they get rejected events from SNS directly) and is never shown to customers.
// Returns { to, subject, text, html }, or null for an event that has no customer email.
export function buildEmail(evt) {
  const amount = `${evt.currency} ${Number(evt.total).toFixed(2)}`;
  const name = evt.customerName || 'there';
  let subject;
  let lines;

  if (evt.status === 'confirmed') {
    subject = `Order ${evt.orderId} confirmed`;
    lines = [`Thanks ${name}! We've received your order ${evt.orderId} (${amount}). We'll let you know when it ships.`];
  } else if (evt.status === 'cancelled') {
    subject = `Order ${evt.orderId} cancelled`;
    lines = [
      `Hi ${name}, payment for order ${evt.orderId} wasn't completed in time, so we've cancelled it. You have not been charged.`,
      'Your items are back in stock if you would like to order again.',
    ];
  } else if (evt.status === 'rejected') {
    subject = `Order ${evt.orderId} cancelled`;
    lines = [
      `Hi ${name}, we received your payment for order ${evt.orderId}, but the order had already been cancelled.`,
      `Your payment of ${amount} will be refunded within 5-7 business days.`,
    ];
  } else {
    return null;
  }

  const items = evt.items || [];
  const text = [
    ...lines,
    ...(items.length ? ['', ...items.map((it) => `  ${it.qty} x ${it.name}`), `  Total: ${amount}`] : []),
    '',
    'Kool Kaya Kitchen',
  ].join('\n');

  const html = `<!doctype html>
<html><body style="font-family:Arial,sans-serif;color:#222;max-width:560px">
${lines.map((l) => `<p>${esc(l)}</p>`).join('\n')}
${items.length ? `<table cellpadding="4" style="border-collapse:collapse">
${items.map((it) => `<tr><td>${esc(it.qty)} &times;</td><td>${esc(it.name)}</td></tr>`).join('\n')}
<tr><td></td><td><strong>Total: ${esc(amount)}</strong></td></tr>
</table>` : ''}
<p>Kool Kaya Kitchen</p>
</body></html>`;

  return { to: evt.email, subject, text, html };
}
