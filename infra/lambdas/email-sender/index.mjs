// Email sender (placeholder): subscribed to the SNS order-events topic.
// Env: SES_FROM_ADDRESS.
export const handler = async (event) => {
  for (const record of event.Records) {
    const orderEvent = JSON.parse(record.Sns.Message);
    console.log(JSON.stringify({ msg: 'order_event.received', messageId: record.Sns.MessageId, orderEvent }));

    // TODO: build the subject/body per status (templates in backend/src/services/notifications.js notifyOrder).
    // TODO: send with SES (SendEmailCommand from @aws-sdk/client-sesv2) from SES_FROM_ADDRESS.
  }
};
