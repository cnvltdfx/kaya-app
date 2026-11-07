// SQS demo: a burst of order messages, then the queue depth live until the order worker has drained it.
// Each message is {"orderId", "outcome": "expired"} for an order that is already settled (e.g. `processing`):
// the worker locks it, sees there is nothing to do and skips it, so no order, stock or email changes.
// Never use a `pending_payment` order (it would be cancelled) or one the worker cancelled (re-sends its email).
// Safe orders are ones that were paid and never went through the worker's cancel, because they can never
// go back to `pending_payment`, so the message is a no-op whatever has happened to them since:
//   - default: seeded demo orders that the seed creates as `processing` (src/seed.js is deterministic, and
//     seeds an empty database before it takes any traffic). The archiver never deletes processing orders.
//   - --orders KK…,KK…: orders the worker's logs show it settled as paid (`order.processed`, `processing`).
// Before the burst, one test message per order must come back as `order.skipped` in the worker's logs.
//
//   npm ci
//   set AWS_PROFILE=kaya
//   node sqs-burst.mjs --count 20000
//
// Spread over several orders: every message for one order waits for the same row lock.
// --watch-only: skip sending and just print the queue depth.
import { SQSClient, GetQueueUrlCommand, GetQueueAttributesCommand, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    orders: { type: 'string' },
    count: { type: 'string', default: '20000' },
    queue: { type: 'string', default: 'kool-kaya-kitchen-orders' },
    'log-group': { type: 'string', default: '/aws/lambda/kool-kaya-kitchen-order-worker' },
    'watch-only': { type: 'boolean', default: false },
  },
});

const region = process.env.AWS_REGION || 'ap-southeast-1';
const sqs = new SQSClient({ region });
const logs = new CloudWatchLogsClient({ region });
const SENDERS = 50; // parallel SendMessageBatch calls
// The first 10 orders backend/src/seed.js creates as `processing` (its random sequence is fixed).
const SEEDED_PROCESSING = ['KK100001', 'KK100007', 'KK100009', 'KK100015', 'KK100020', 'KK100030', 'KK100042', 'KK100043', 'KK100049', 'KK100051'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const queueUrl = async (name) => (await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl;

// Order IDs the worker settled as paid, newest first, from its logs (kept 14 days).
async function paidOrders() {
  const ids = new Map();
  let nextToken;
  do {
    const r = await logs.send(new FilterLogEventsCommand({
      logGroupName: args['log-group'],
      filterPattern: '"order.processed" "processing"',
      startTime: Date.now() - 14 * 86_400_000,
      nextToken,
    }));
    for (const e of r.events) {
      // Text log format: "<time>\t<request id>\tINFO\t{...}"
      try {
        const line = JSON.parse(e.message.slice(e.message.indexOf('{')));
        if (line.msg === 'order.processed' && line.status === 'processing') ids.set(line.orderId, e.timestamp);
      } catch { /* not one of the worker's JSON lines */ }
    }
    nextToken = r.nextToken;
  } while (nextToken);
  return [...ids].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

async function pickOrders() {
  const given = (args.orders || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!given.length) return SEEDED_PROCESSING;
  const paid = await paidOrders();
  const missing = given.filter((id) => !paid.includes(id));
  if (missing.length) throw new Error(`Not settled as paid by the worker in the last 14 days, so not safe to use: ${missing.join(', ')}`);
  return given;
}

// Sends one message per order and waits for the worker to log each as skipped (order exists, nothing to do).
async function testRun(url, orderIds) {
  const since = Date.now() - 5000;
  const r = await sqs.send(new SendMessageBatchCommand({
    QueueUrl: url,
    Entries: orderIds.map((orderId, i) => ({ Id: String(i), MessageBody: JSON.stringify({ orderId, outcome: 'expired' }) })),
  }));
  if (r.Failed?.length) throw new Error(`Could not send the test messages: ${r.Failed[0].Message}`);
  const pending = new Map(r.Successful.map((s) => [s.MessageId, orderIds[Number(s.Id)]]));
  const deadline = Date.now() + 90_000;
  while (pending.size && Date.now() < deadline) {
    await sleep(3000);
    const { events } = await logs.send(new FilterLogEventsCommand({
      logGroupName: args['log-group'], filterPattern: '?"order.skipped" ?"order.failed"', startTime: since,
    }));
    for (const e of events) {
      let line;
      try { line = JSON.parse(e.message.slice(e.message.indexOf('{'))); } catch { continue; }
      if (!pending.has(line.messageId)) continue;
      if (line.msg === 'order.failed') {
        throw new Error(`Test message for ${pending.get(line.messageId)} failed (${line.error}). Nothing else sent; the failed test messages retry and end up in the DLQ in about 15 min.`);
      }
      pending.delete(line.messageId);
    }
  }
  if (pending.size) throw new Error(`No result in the worker logs after 90 s for: ${[...pending.values()].join(', ')}. Is the worker's SQS trigger enabled?`);
  console.log(`Test run OK: the worker skipped all ${orderIds.length} orders without changing them.`);
}

async function send(url, orderIds, count) {
  let next = 0;
  let failed = 0;
  const start = Date.now();
  async function sender() {
    while (next < count) {
      const first = next;
      next = Math.min(next + 10, count);
      const entries = [];
      for (let i = first; i < next; i++) {
        entries.push({ Id: String(i - first), MessageBody: JSON.stringify({ orderId: orderIds[i % orderIds.length], outcome: 'expired' }) });
      }
      const r = await sqs.send(new SendMessageBatchCommand({ QueueUrl: url, Entries: entries }));
      failed += r.Failed?.length || 0;
    }
  }
  await Promise.all(Array.from({ length: SENDERS }, sender));
  const secs = (Date.now() - start) / 1000;
  console.log(`Sent ${count - failed} messages in ${secs.toFixed(1)}s${failed ? ` (${failed} failed)` : ''}.`);
}

async function depth(url) {
  const { Attributes: a } = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: url,
    AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
  }));
  return { waiting: Number(a.ApproximateNumberOfMessages), inFlight: Number(a.ApproximateNumberOfMessagesNotVisible) };
}

// Prints the queue depth every 2 s until it reads empty twice in a row.
async function watch(url) {
  const start = Date.now();
  let empty = 0;
  while (empty < 2) {
    const { waiting, inFlight } = await depth(url);
    const t = Math.round((Date.now() - start) / 1000);
    console.log(`${String(t).padStart(4)}s  waiting ${String(waiting).padStart(6)}  being processed ${String(inFlight).padStart(4)}  ${'#'.repeat(Math.ceil(waiting / 500))}`);
    empty = waiting + inFlight === 0 ? empty + 1 : 0;
    await sleep(2000);
  }
  console.log(`Drained in about ${Math.round((Date.now() - start) / 1000)}s.`);
}

const url = await queueUrl(args.queue);
if (!args['watch-only']) {
  const count = Number(args.count);
  if (!Number.isInteger(count) || count < 1) throw new Error('--count must be a positive whole number.');
  const orderIds = await pickOrders();
  console.log(`Using ${orderIds.length} paid order(s): ${orderIds.join(', ')}`);
  await testRun(url, orderIds);
  await send(url, orderIds, count);
}
await watch(url);

const dlq = await depth(await queueUrl(`${args.queue}-dlq`));
console.log(`DLQ: ${dlq.waiting + dlq.inFlight} messages${dlq.waiting + dlq.inFlight ? ': check the order worker logs' : ''}.`);
