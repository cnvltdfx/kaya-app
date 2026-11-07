// SQS demo: a burst of order messages, then the queue depth live until the order worker has drained it.
// Each message is {"orderId", "outcome": "expired"} for an order that is already settled (e.g. `processing`):
// the worker locks it, sees there is nothing to do and skips it, so no order, stock or email changes.
// Never use a `pending_payment` order (it would be cancelled) or a `cancelled` one (re-sends its email);
// the script checks each order's status through the API first, as the signed-in customer.
//
//   npm ci
//   $env:AWS_PROFILE = 'kaya'
//   node sqs-burst.mjs --orders KK100001,KK100002,KK100003 --count 20000 --token <kk_token>
//
// --token: the session token, from the browser console on the site while signed in:
//   JSON.parse(localStorage.kk_token)
// Spread the burst over several orders: every message for one order waits for the same row lock.
// --watch-only: skip sending and just print the queue depth.
import { SQSClient, GetQueueUrlCommand, GetQueueAttributesCommand, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    orders: { type: 'string' },
    count: { type: 'string', default: '20000' },
    token: { type: 'string' },
    site: { type: 'string', default: 'https://d2tz3m76rw00ti.cloudfront.net' },
    queue: { type: 'string', default: 'kool-kaya-kitchen-orders' },
    'watch-only': { type: 'boolean', default: false },
  },
});

const sqs = new SQSClient({ region: process.env.AWS_REGION || 'ap-southeast-1' });
const UNSAFE = ['pending_payment', 'cancelled'];
const SENDERS = 50; // parallel SendMessageBatch calls

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const queueUrl = async (name) => (await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl;

async function checkOrders(orderIds) {
  for (const id of orderIds) {
    const res = await fetch(`${args.site}/api/orders/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${args.token}` } });
    if (!res.ok) throw new Error(`${id}: API returned ${res.status} (wrong order ID, or not this account's order?)`);
    const { order } = await res.json();
    if (UNSAFE.includes(order.status)) throw new Error(`${id} is ${order.status}: only use settled orders such as processing.`);
    console.log(`${id}: ${order.status}, OK`);
  }
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
  const orderIds = (args.orders || '').split(',').map((s) => s.trim()).filter(Boolean);
  const count = Number(args.count);
  if (!orderIds.length || !args.token) throw new Error('Need --orders and --token (see the top of this file).');
  if (!Number.isInteger(count) || count < 1) throw new Error('--count must be a positive whole number.');
  await checkOrders(orderIds);
  await send(url, orderIds, count);
}
await watch(url);

const dlq = await depth(await queueUrl(`${args.queue}-dlq`));
console.log(`DLQ: ${dlq.waiting + dlq.inFlight} messages${dlq.waiting + dlq.inFlight ? ': check the order worker logs' : ''}.`);
