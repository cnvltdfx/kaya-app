// Order worker: triggered by the SQS order queue. Each message is {"orderId":"KK100123"} for an
// order the API saved with status `queued`. See order.mjs for what happens to it.
// Env: ORDER_EVENTS_TOPIC_ARN, DB_HOST, DB_NAME, DB_SECRET_ARN.
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { tx } from './db.mjs';
import { processOrder } from './order.mjs';

const sns = new SNSClient({});

// `status` (confirmed | rejected) is also a message attribute, for the staff "rejected" filter.
async function publish(evt) {
  await sns.send(new PublishCommand({
    TopicArn: process.env.ORDER_EVENTS_TOPIC_ARN,
    Message: JSON.stringify(evt),
    MessageAttributes: { status: { DataType: 'String', StringValue: evt.status } },
  }));
}

export const handler = async (event) => {
  const batchItemFailures = [];

  for (const record of event.Records) {
    try {
      const { orderId } = JSON.parse(record.body);
      if (typeof orderId !== 'string' || !/^KK\d+$/.test(orderId)) throw new Error('Message has no valid orderId.');

      const evt = await processOrder(tx, orderId);
      if (evt) await publish(evt);
      console.log(JSON.stringify({ msg: evt ? 'order.processed' : 'order.skipped', messageId: record.messageId, orderId, status: evt?.orderStatus }));
    } catch (err) {
      console.error(JSON.stringify({ msg: 'order.failed', messageId: record.messageId, error: err.message, code: err.code }));
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  // Failed messages go back to the queue, then to the DLQ after 5 attempts.
  return { batchItemFailures };
};
