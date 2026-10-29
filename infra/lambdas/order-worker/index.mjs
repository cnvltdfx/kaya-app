// Order worker (placeholder): triggered by the SQS order queue.
// Env: DB_HOST, DB_NAME, DB_SECRET_ARN, ORDER_EVENTS_TOPIC_ARN.
export const handler = async (event) => {
  const batchItemFailures = [];

  for (const record of event.Records) {
    try {
      const order = JSON.parse(record.body);
      console.log(JSON.stringify({ msg: 'order.received', messageId: record.messageId, order }));

      // TODO: read DB credentials from Secrets Manager (DB_SECRET_ARN).
      // TODO: confirm the order and stock in one DB transaction.
      // TODO: publish { orderId, status } to ORDER_EVENTS_TOPIC_ARN, with a `status`
      //       message attribute so the staff email filter ("rejected") matches.
    } catch (err) {
      console.error(JSON.stringify({ msg: 'order.failed', messageId: record.messageId, error: err.message }));
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  // Failed messages go back to the queue, then to the DLQ after 5 attempts.
  return { batchItemFailures };
};
