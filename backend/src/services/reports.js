// Reporting service: builds sales & inventory reports and pushes them to Amazon S3.
//
// If S3_BUCKET is set, reports are uploaded with the AWS SDK (credentials from the standard
// AWS chain: IAM role on ECS/EC2/Lambda, or env vars locally), encrypted with SSE-KMS when
// KMS_KEY_ID is set, otherwise SSE-S3. Without S3_BUCKET, reports are written to ./reports
// using the same key layout, so the app works fully offline.
//
// Locally, an in-process timer generates the daily reports at 00:05 Singapore time. In AWS,
// EventBridge Scheduler invokes the report-generator Lambda, which calls runReport through the
// private report port in server.js instead.
//
// Every sales report also rewrites reports/quicksight/sales.csv: all paid orders to date, in the
// same columns. The QuickSight dataset reads only that file, so overlapping daily, weekly and
// manual reports never double-count.
const fs = require('fs');
const path = require('path');
const { table, id } = require('../lib/db');
const { MARKETS } = require('../lib/markets');
const { log, raiseAlert } = require('../lib/observability');

const LOCAL_ROOT = process.env.REPORTS_ROOT || path.join(__dirname, '..', '..'); // keys start with reports/
const BUCKET = process.env.S3_BUCKET || '';
const REGION = process.env.AWS_REGION || 'ap-southeast-1';
const QUICKSIGHT_FEED_KEY = 'reports/quicksight/sales.csv';

let s3 = null;
function s3Client() {
  if (!s3) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3 = new S3Client({ region: REGION });
  }
  return s3;
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

function sgDate(ts) {
  return new Date(ts).toLocaleString('sv-SE', { timeZone: 'Asia/Singapore' }).replace(' ', 'T');
}

function salesReport({ from, to }) {
  const orders = table('orders').filter((o) => o.createdAt >= from && o.createdAt < to && o.paymentStatus === 'paid');
  const rows = [['order_id', 'created_at_sgt', 'market', 'currency', 'status', 'fulfilment', 'payment_method', 'product', 'qty', 'unit_price_local', 'unit_price_sgd', 'order_total_local', 'order_total_sgd', 'promo_code']];
  const byMarket = {};
  const byProduct = {};
  let revenueSgd = 0;
  for (const o of orders) {
    revenueSgd += o.totalSgd;
    const bm = (byMarket[o.market] ||= { orders: 0, revenueSgd: 0, revenueLocal: 0, currency: MARKETS[o.market].currency });
    bm.orders += 1; bm.revenueSgd += o.totalSgd; bm.revenueLocal += o.total;
    for (const it of o.items) {
      rows.push([o.id, sgDate(o.createdAt), o.market, o.currency, o.status, o.fulfilment, o.paymentMethod, it.name, it.qty, it.unitPrice, it.unitPriceSgd, o.total, o.totalSgd, o.promoCode || '']);
      const bp = (byProduct[it.name] ||= { units: 0, revenueSgd: 0 });
      bp.units += it.qty; bp.revenueSgd += it.unitPriceSgd * it.qty;
    }
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  for (const v of Object.values(byMarket)) { v.revenueSgd = r2(v.revenueSgd); v.revenueLocal = r2(v.revenueLocal); }
  for (const v of Object.values(byProduct)) v.revenueSgd = r2(v.revenueSgd);
  const summary = {
    period: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    orders: orders.length,
    revenueSgd: r2(revenueSgd),
    averageOrderValueSgd: orders.length ? r2(revenueSgd / orders.length) : 0,
    byMarket,
    topProducts: Object.entries(byProduct).sort((a, b) => b[1].revenueSgd - a[1].revenueSgd).slice(0, 5).map(([name, v]) => ({ name, ...v })),
  };
  return { csv: toCsv(rows), summary };
}

function inventoryReport() {
  const rows = [['product_id', 'name', 'category', 'price_sgd', 'sale_pct', 'stock', 'low_stock_threshold', 'status']];
  const products = table('products').all();
  for (const p of products) rows.push([p.id, p.name, p.category, p.price, p.salePct, p.stock, p.lowStockThreshold, p.stock === 0 ? 'OUT_OF_STOCK' : p.stock <= p.lowStockThreshold ? 'LOW' : 'OK']);
  return {
    csv: toCsv(rows),
    summary: { products: products.length, lowStock: products.filter((p) => p.stock > 0 && p.stock <= p.lowStockThreshold).length, outOfStock: products.filter((p) => p.stock === 0).length, unitsOnHand: products.reduce((s, p) => s + p.stock, 0) },
  };
}

async function putObject(key, body, contentType) {
  if (BUCKET) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3Client().send(new PutObjectCommand({
      Bucket: BUCKET, Key: key, Body: body, ContentType: contentType,
      ...(process.env.KMS_KEY_ID ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: process.env.KMS_KEY_ID } : { ServerSideEncryption: 'AES256' }),
      Tagging: 'service=reports&app=kool-kaya',
    }));
    return `s3://${BUCKET}/${key}`;
  }
  const file = path.join(LOCAL_ROOT, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return `local://${key}`;
}

async function runReport({ type = 'sales', days = 1, trigger = 'manual', by = null } = {}) {
  const to = Date.now();
  const from = to - Math.max(1, Math.min(365, Number(days) || 1)) * 864e5;
  const { csv, summary } = type === 'inventory' ? inventoryReport() : salesReport({ from, to });
  const stamp = sgDate(to).replace(/[:]/g, '').slice(0, 17);
  const [y, m, d] = stamp.slice(0, 10).split('-');
  const base = `reports/${type}/${y}/${m}/${d}/${type}-${stamp}`;
  try {
    const csvLoc = await putObject(`${base}.csv`, csv, 'text/csv');
    const jsonLoc = await putObject(`${base}.json`, JSON.stringify(summary, null, 2), 'application/json');
    if (type === 'sales') await putObject(QUICKSIGHT_FEED_KEY, salesReport({ from: 0, to }).csv, 'text/csv');
    const rec = table('reports').insert({
      id: id('rpt'), type, days: type === 'inventory' ? null : Number(days) || 1, trigger, by,
      storage: BUCKET ? 's3' : 'local', key: `${base}.csv`, location: csvLoc, summaryLocation: jsonLoc,
      sizeBytes: Buffer.byteLength(csv), summary, createdAt: to,
    });
    log('info', 'report.generated', { type, location: csvLoc, trigger });
    return rec;
  } catch (err) {
    raiseAlert('ReportUploadFailed', `${type} report failed: ${err.message}`);
    throw err;
  }
}

async function readReport(rec) {
  if (rec.storage === 's3') {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const out = await s3Client().send(new GetObjectCommand({ Bucket: BUCKET, Key: rec.key }));
    return out.Body.transformToString();
  }
  return fs.readFileSync(path.join(LOCAL_ROOT, rec.key), 'utf8');
}

let timer = null;
function msUntilNextRun() {
  // 00:05 Singapore time (UTC+8, no DST)
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 16, 5));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}
function startScheduler() {
  const schedule = () => {
    timer = setTimeout(async () => {
      try {
        await runReport({ type: 'sales', days: 1, trigger: 'scheduled' });
        await runReport({ type: 'inventory', trigger: 'scheduled' });
      } catch (e) { log('error', 'report.scheduled_failed', { error: e.message }); }
      schedule();
    }, msUntilNextRun());
    timer.unref();
  };
  schedule();
  log('info', 'report.scheduler_started', { nextRunInMin: Math.round(msUntilNextRun() / 60000), destination: BUCKET ? `s3://${BUCKET}` : 'local ./reports' });
}

module.exports = { runReport, readReport, startScheduler, destination: () => (BUCKET ? `s3://${BUCKET}` : 'local ./reports (set S3_BUCKET to push to S3)') };

// CLI: `npm run report` (usable as a scheduled ECS task / Lambda entry point)
if (require.main === module) {
  require('../seed').seed();
  (async () => {
    const days = Number((process.argv.find((a) => a.startsWith('--days=')) || '').split('=')[1]) || 1;
    const s = await runReport({ type: 'sales', days, trigger: 'cli' });
    const i = await runReport({ type: 'inventory', trigger: 'cli' });
    require('../lib/db').flush();
    console.log('Sales report:', s.location, '\nInventory report:', i.location);
  })().catch((e) => { console.error(e); process.exit(1); });
}
