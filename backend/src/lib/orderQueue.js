// Hands checkout outcomes to the SQS order queue, where the order-worker Lambda
// (infra/lambdas/order-worker) settles the order and emails the customer.
// Enabled by ORDER_QUEUE_URL (set by the EC2 user_data). Without it (local dev, tests),
// sendOutcome returns false and the caller settles the order itself.
let client = null;

// outcome: 'paid' | 'expired'
async function sendOutcome(orderId, outcome) {
  if (!process.env.ORDER_QUEUE_URL) return false;
  const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
  client ||= new SQSClient({ region: process.env.AWS_REGION || 'ap-southeast-1' });
  await client.send(new SendMessageCommand({ QueueUrl: process.env.ORDER_QUEUE_URL, MessageBody: JSON.stringify({ orderId, outcome }) }));
  return true;
}

module.exports = { sendOutcome };
