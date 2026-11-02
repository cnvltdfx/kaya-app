// Transacts one queued order: takes stock for every line or for none, then moves the order on.
//   enough stock -> `processing` (paid) or `pending_payment` (PayNow not yet received)
//   any line short -> `rejected`, stock untouched, payment refunded
// Returns the order event to publish, or null when there is nothing to send.
//
// SQS delivers at least once, so the order row is locked and only a `queued` order is changed.

export const WORKER_NOTE = 'order-worker';

export async function processOrder(tx, orderId) {
  return tx(async (conn) => {
    const [[order]] = await conn.query(
      `SELECT o.id, o.email, o.currency, o.total, o.payment_status, o.status, u.name AS customer_name
       FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ? FOR UPDATE OF o`,
      [orderId],
    );
    // Thrown, not skipped: the message may have arrived before the API's insert committed.
    if (!order) throw new Error(`Order ${orderId} not found.`);
    // In product order, so two workers lock the same products in the same sequence (no deadlock).
    const [items] = await conn.query('SELECT product_id, name, qty FROM order_items WHERE order_id = ? ORDER BY product_id', [orderId]);

    if (order.status !== 'queued') {
      // Redelivery. If this worker made the latest change, the event may not have gone out
      // (crash between commit and publish), so send it again. Otherwise someone has moved on.
      const [[last]] = await conn.query('SELECT status, note FROM order_status_history WHERE order_id = ? ORDER BY id DESC LIMIT 1', [orderId]);
      if (!last?.note?.startsWith(WORKER_NOTE) || last.status !== order.status) return null;
      return orderEvent(order, items, last.status === 'rejected' ? last.note.slice(WORKER_NOTE.length + 2) : null);
    }

    await conn.query('SAVEPOINT stock');
    let short = null;
    for (const it of items) {
      const [r] = await conn.query('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?', [it.qty, it.product_id, it.qty]);
      if (!r.affectedRows) { short = it; break; }
    }

    if (short) {
      await conn.query('ROLLBACK TO SAVEPOINT stock');
      const reason = `${short.name} is out of stock`;
      await conn.query(
        "UPDATE orders SET status = 'rejected', payment_status = IF(payment_status = 'paid', 'refunded', 'cancelled'), updated_at = UTC_TIMESTAMP(3) WHERE id = ?",
        [orderId],
      );
      await conn.query("UPDATE payments SET status = 'refunded', refunded_at = UTC_TIMESTAMP(3) WHERE order_id = ? AND status = 'paid'", [orderId]);
      await history(conn, orderId, 'rejected', `${WORKER_NOTE}: ${reason}`);
      const paymentStatus = order.payment_status === 'paid' ? 'refunded' : 'cancelled';
      return orderEvent({ ...order, status: 'rejected', payment_status: paymentStatus }, items, reason);
    }

    const next = order.payment_status === 'paid' ? 'processing' : 'pending_payment';
    await conn.query('UPDATE orders SET status = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?', [next, orderId]);
    await history(conn, orderId, next, WORKER_NOTE);
    return orderEvent({ ...order, status: next }, items, null);
  });
}

function history(conn, orderId, status, note) {
  return conn.query('INSERT INTO order_status_history (order_id, status, note, at) VALUES (?, ?, ?, UTC_TIMESTAMP(3))', [orderId, status, note]);
}

// Carries what the email sender needs, so it never has to reach the database.
function orderEvent(order, items, reason) {
  return {
    orderId: order.id,
    status: order.status === 'rejected' ? 'rejected' : 'confirmed',
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
