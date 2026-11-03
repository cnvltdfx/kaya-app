// Finds orders whose checkout never finished: still `pending_payment` more than `timeoutMinutes` after
// they were placed. Each one gets the outcome the order worker should settle it with:
//   no payment received        -> expired (worker cancels it and releases the stock)
//   a payment row is `paid`    -> paid    (the API took the money but could not queue it; resend)
// Read only: the worker locks the order and only changes it while it is still `pending_payment`, so a
// payment that lands between this query and the worker becomes a `rejected` event for staff to refund.

export async function findStale(conn, { timeoutMinutes, limit }) {
  const [rows] = await conn.query(
    `SELECT o.id,
            EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'paid') AS paid
     FROM orders o
     WHERE o.status = 'pending_payment' AND o.created_at < UTC_TIMESTAMP(3) - INTERVAL ? MINUTE
     ORDER BY o.created_at
     LIMIT ?`,
    [timeoutMinutes, limit],
  );
  return rows.map((r) => ({ orderId: r.id, outcome: r.paid ? 'paid' : 'expired' }));
}
