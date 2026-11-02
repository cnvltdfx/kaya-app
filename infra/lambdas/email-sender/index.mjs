// Email sender: subscribed to the SNS order-events topic; emails the customer through SES.
// Env: SES_FROM_ADDRESS ("unset" until ses_from_address is set in terraform.tfvars).
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { buildEmail } from './templates.mjs';

const ses = new SESv2Client({});
const FROM = process.env.SES_FROM_ADDRESS;

export const handler = async (event) => {
  for (const record of event.Records) {
    const evt = JSON.parse(record.Sns.Message);
    const log = { messageId: record.Sns.MessageId, orderId: evt.orderId, status: evt.orderStatus };
    const email = buildEmail(evt);

    if (!email || !email.to) {
      console.log(JSON.stringify({ msg: 'email.skipped', reason: 'no customer email for this event', ...log }));
      continue;
    }
    if (!FROM || FROM === 'unset') {
      console.log(JSON.stringify({ msg: 'email.skipped', reason: 'SES_FROM_ADDRESS not set', ...log }));
      continue;
    }

    try {
      await ses.send(new SendEmailCommand({
        FromEmailAddress: FROM,
        Destination: { ToAddresses: [email.to] },
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: 'UTF-8' },
            Body: { Text: { Data: email.text, Charset: 'UTF-8' }, Html: { Data: email.html, Charset: 'UTF-8' } },
          },
        },
      }));
      console.log(JSON.stringify({ msg: 'email.sent', ...log }));
    } catch (err) {
      // Rejected addresses (e.g. unverified recipients in the SES sandbox) won't succeed on retry.
      if (err.name === 'MessageRejected') {
        console.warn(JSON.stringify({ msg: 'email.rejected', error: err.message, ...log }));
        continue;
      }
      // Anything else (throttling, outages): throw, so Lambda retries the SNS delivery.
      console.error(JSON.stringify({ msg: 'email.failed', error: err.message, code: err.name, ...log }));
      throw err;
    }
  }
};
