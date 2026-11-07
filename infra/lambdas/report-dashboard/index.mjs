// Report dashboard: invoked by EventBridge Scheduler (infra/terraform/reporting.tf), by default at 00:30 SGT daily.
// The free stand-in for QuickSight: reads paid orders and stock straight from MySQL (data.mjs), renders a
// self-contained HTML dashboard (dashboard.mjs, view.mjs) and writes it to the reports bucket twice:
//   reports/dashboard/YYYY/MM/DD/dashboard-<SGT time>.html   one per run, in the same layout as the CSV reports
//   reports/dashboard/latest.html                            always the newest, to bookmark
// Without REPORTS_BUCKET (a local run) the files go under ./reports with the same keys, as the app's reports do.
// Env: REPORTS_BUCKET, DB_HOST, DB_NAME, DB_SECRET_ARN.
import fs from 'node:fs';
import path from 'node:path';
import { tx } from './db.mjs';
import { loadDataset } from './data.mjs';
import { publish } from './dashboard.mjs';

const BUCKET = process.env.REPORTS_BUCKET || '';
let s3 = null;

// The bucket's default encryption (the project KMS key) applies.
async function put(key, body, { cacheControl } = {}) {
  if (!BUCKET) {
    const file = path.join(process.env.REPORTS_ROOT || process.cwd(), key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return `local://${key}`;
  }
  // The Lambda runtime ships the AWS SDK; imported lazily so local runs don't need it.
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  s3 ||= new S3Client({});
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: 'text/html; charset=utf-8', CacheControl: cacheControl }));
  return `s3://${BUCKET}/${key}`;
}

export const handler = async () => {
  const now = Date.now();
  const data = await tx((conn) => loadDataset(conn, now));
  const out = await publish(data, put);
  console.log(JSON.stringify({ msg: 'dashboard.generated', ...out }));
  return out;
};
