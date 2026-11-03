// Order expirer: invoked by EventBridge Scheduler (infra/terraform/orders.tf), by default every 5 minutes.
// Sends an outcome to the order queue for each order stuck in `pending_payment` past ORDER_PAYMENT_TIMEOUT_MINUTES
// (see expire.mjs), so the order worker cancels it or, if the money did arrive, confirms it.
// An order that is still stuck is found again on the next run; the worker ignores the duplicates.
// Env: ORDER_QUEUE_URL, ORDER_PAYMENT_TIMEOUT_MINUTES, DB_HOST, DB_NAME, DB_SECRET_ARN.
import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { tx } from './db.mjs';
import { findStale } from './expire.mjs';

const sqs = new SQSClient({});
const LIMIT = 500;
const SQS_BATCH = 10;

export const handler = async () => {
  const timeoutMinutes = Number(process.env.ORDER_PAYMENT_TIMEOUT_MINUTES);
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1) throw new Error('ORDER_PAYMENT_TIMEOUT_MINUTES must be a whole number of minutes, 1 or more.');

  const stale = await tx((conn) => findStale(conn, { timeoutMinutes, limit: LIMIT }));

  let failed = 0;
  for (let i = 0; i < stale.length; i += SQS_BATCH) {
    const batch = stale.slice(i, i + SQS_BATCH);
    const out = await sqs.send(new SendMessageBatchCommand({
      QueueUrl: process.env.ORDER_QUEUE_URL,
      Entries: batch.map((m, n) => ({ Id: String(n), MessageBody: JSON.stringify(m) })),
    }));
    failed += out.Failed?.length ?? 0;
  }

  const summary = {
    expired: stale.filter((m) => m.outcome === 'expired').length,
    resent: stale.filter((m) => m.outcome === 'paid').length,
    failed,
    timeoutMinutes,
  };
  console.log(JSON.stringify({ msg: 'expire.done', ...summary }));
  // Fail the run so the errors alarm fires; the unsent orders are picked up again next time.
  if (failed) throw new Error(`${failed} of ${stale.length} order messages could not be queued.`);
  return summary;
};
