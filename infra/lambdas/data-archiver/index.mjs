// Data archiver: invoked by EventBridge Scheduler (infra/terraform/archive.tf), by default at 03:00 SGT on the 15th.
// Moves closed orders older than ARCHIVE_ORDER_AGE_DAYS from MySQL into Parquet files in the archive bucket,
// one batch per transaction (see archive.mjs), until none are left or the timeout is near; the next run
// picks up the rest. The bucket's lifecycle rules then move the files to Glacier and delete them.
// Env: ARCHIVE_BUCKET, ARCHIVE_ORDER_AGE_DAYS, ARCHIVE_BATCH_SIZE, DB_HOST, DB_NAME, DB_SECRET_ARN.
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { tx } from './db.mjs';
import { archiveBatch } from './archive.mjs';

const s3 = new S3Client({});
const STOP_BEFORE_TIMEOUT_MS = 60_000;

// Written straight to Intelligent-Tiering; the bucket's default KMS encryption applies.
async function put(key, body) {
  await s3.send(new PutObjectCommand({
    Bucket: process.env.ARCHIVE_BUCKET,
    Key: key,
    Body: body,
    ContentType: 'application/vnd.apache.parquet',
    StorageClass: 'INTELLIGENT_TIERING',
  }));
}

const sgtDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(d);

export const handler = async (_event, context) => {
  const opts = {
    orderAgeDays: Number(process.env.ARCHIVE_ORDER_AGE_DAYS),
    batchSize: Number(process.env.ARCHIVE_BATCH_SIZE || 500),
    runDate: sgtDate(new Date()),
    put,
  };
  if (!Number.isInteger(opts.orderAgeDays) || opts.orderAgeDays < 0) throw new Error('ARCHIVE_ORDER_AGE_DAYS must be a whole number of days.');

  let orders = 0;
  let batches = 0;
  let complete = false;
  while (context.getRemainingTimeInMillis() > STOP_BEFORE_TIMEOUT_MS) {
    const n = await tx((conn) => archiveBatch(conn, opts));
    orders += n;
    if (n) batches += 1;
    if (n < opts.batchSize) { complete = true; break; }
  }

  const summary = { orders, batches, complete, runDate: opts.runDate, orderAgeDays: opts.orderAgeDays };
  console.log(JSON.stringify({ msg: complete ? 'archive.done' : 'archive.incomplete', ...summary }));
  return summary;
};
