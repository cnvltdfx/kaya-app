// Settles one order once the payment provider reports back. The API has already reserved the stock and saved
// the order as `pending_payment`; the message says how checkout ended:
//   paid    -> `processing`, payment recorded              event: confirmed
//   expired -> `cancelled`, reserved stock released        event: cancelled
//   paid, but the order was already cancelled -> no change event: rejected (staff refund it manually)
// Returns the order event to publish, or null when there is nothing to send.
//
// SQS delivers at least once, so the order row is locked and only a `pending_payment` order is changed.

export const WORKER_NOTE = 'order-worker';
const EXPIRED_NOTE = `${WORKER_NOTE}: payment expired`;
const SETTLED = { paid: 'processing', expired: 'cancelled' };

export async function processOrder(tx, orderId, outcome) {
  if (!SETTLED[outcome]) throw new Error(`Unknown outcome ${outcome}.`);

  return tx(async (conn) => {
    const [[order]] = await conn.query(
      `SELECT o.id, o.email, o.currency, o.total, o.payment_status, o.status, u.name AS customer_name
       FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ? FOR UPDATE OF o`,
      [orderId],
    );
    // Thrown, not skipped: the message may have arrived before the API's insert committed.
    if (!order) throw new Error(`Order ${orderId} not found.`);
    const [items] = await conn.query('SELECT product_id, name, qty FROM order_items WHERE order_id = ? ORDER BY product_id', [orderId]);

    if (order.status !== 'pending_payment') {
      // Redelivery. If this worker made the latest change, the event may not have gone out
      // (crash between commit and publish), so send it again.
      const [[last]] = await conn.query('SELECT status, note FROM order_status_history WHERE order_id = ? ORDER BY id DESC LIMIT 1', [orderId]);
      if (order.status === SETTLED[outcome] && last?.status === order.status && last.note?.startsWith(WORKER_NOTE)) {
        return orderEvent(order, items);
      }
      // Money arrived for an order that is no longer waiting for it (the customer cancelled, or
      // checkout expired first). Leave the order alone and tell staff to refund it.
      if (outcome === 'paid' && order.status === 'cancelled') {
        return orderEvent(order, items, { status: 'rejected', reason: `Payment received for cancelled order ${orderId}: refund it manually` });
      }
      return null;
    }

    if (outcome === 'paid') {
      await conn.query(
        "UPDATE orders SET status = 'processing', payment_status = 'paid', paid_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3) WHERE id = ?",
        [orderId],
      );
      await conn.query("UPDATE payments SET status = 'paid', paid_at = UTC_TIMESTAMP(3) WHERE order_id = ? AND status = 'pending'", [orderId]);
      await history(conn, orderId, 'processing', WORKER_NOTE);
      return orderEvent({ ...order, status: 'processing', payment_status: 'paid' }, items);
    }

    for (const it of items) await conn.query('UPDATE products SET stock = stock + ? WHERE id = ?', [it.qty, it.product_id]);
    await conn.query(
      "UPDATE orders SET status = 'cancelled', payment_status = 'cancelled', updated_at = UTC_TIMESTAMP(3) WHERE id = ?",
      [orderId],
    );
    await conn.query("UPDATE payments SET status = 'failed', error = 'Checkout expired' WHERE order_id = ? AND status = 'pending'", [orderId]);
    await history(conn, orderId, 'cancelled', EXPIRED_NOTE);
    return orderEvent({ ...order, status: 'cancelled', payment_status: 'cancelled' }, items);
  });
}

function history(conn, orderId, status, note) {
  return conn.query('INSERT INTO order_status_history (order_id, status, note, at) VALUES (?, ?, ?, UTC_TIMESTAMP(3))', [orderId, status, note]);
}

// Carries what the email sender needs, so it never has to reach the database.
// status: confirmed | cancelled | rejected (also the SNS `status` attribute; staff get `rejected`).
function orderEvent(order, items, { status, reason } = {}) {
  return {
    orderId: order.id,
    status: status || (order.status === 'processing' ? 'confirmed' : 'cancelled'),
    orderStatus: order.status,
    paymentStatus: order.payment_status,
    ...(reason ? { reason } : {}),
    email: order.email,
    customerName: order.customer_name,
    currency: order.currency,
    total: order.total,
    items: items.map((it) => ({ name: it.name, qty: it.qty })),
  };
}
