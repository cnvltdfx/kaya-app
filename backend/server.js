// Kool Kaya Kitchen — API gateway.
// Each /api/<service> router is an independently deployable module (catalog, auth, cart,
// orders, payments, admin/reports). Locally they run in one process; in AWS each can run
// as its own ECS Fargate service / Lambda behind an Application Load Balancer or API Gateway.
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('./src/lib/db');
const obs = require('./src/lib/observability');
const sec = require('./src/lib/security');
const { seed } = require('./src/seed');
const reports = require('./src/services/reports');

const PORT = Number(process.env.PORT || 3000);
// The storefront lives in ../frontend and is deployed separately (S3 + CloudFront). For local
// dev the API also serves it when that directory is present; set FRONTEND_DIR='' to disable.
const FRONTEND_DIR = process.env.FRONTEND_DIR ?? path.join(__dirname, '..', 'frontend');
const app = express();
// Proxy hops in front of the app whose X-Forwarded-For entries are trusted for req.ip (rate limits):
// 1 = ALB only (local dev, or the ALB open to the internet), 2 = CloudFront -> ALB.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
app.disable('x-powered-by');

app.use(sec.securityHeaders);
app.use(sec.cors);
app.use(express.json({ limit: '100kb' }));
app.use(sec.attachUser);
app.use(obs.middleware);

// Health checks for the load balancer (liveness) and deployment (readiness)
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/ready', async (_req, res) => {
  try {
    const { products } = await db.one('SELECT COUNT(*) AS products FROM products');
    res.json({ status: 'ready', products });
  } catch (e) {
    res.status(503).json({ status: 'not_ready', error: e.message });
  }
});

app.use('/api/catalog', require('./src/services/catalog'));
app.use('/api/auth', require('./src/services/auth'));
app.use('/api/cart', require('./src/services/cart'));
app.use('/api/orders', require('./src/services/orders'));
app.use('/api/payments', require('./src/services/payments'));
app.use('/api/admin', require('./src/services/admin'));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

if (FRONTEND_DIR && fs.existsSync(path.join(FRONTEND_DIR, 'index.html'))) {
  app.use(express.static(FRONTEND_DIR, { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0, index: 'index.html' }));
  app.get('*', (_req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));
} else {
  app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  obs.log('error', 'unhandled', { traceId: req.traceId, error: err.message, stack: err.stack });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  res.status(500).json({ error: 'Something went wrong. Please try again.', traceId: req.traceId });
});

// Private report port for the scheduled report Lambda (infra/lambdas/report-generator). The ALB
// doesn't route to it; only the Lambda's security group can reach it. When it's set, EventBridge
// Scheduler owns the report schedule, so the in-process timer stays off.
const REPORTS_PORT = Number(process.env.REPORTS_PORT || 0);
let server = null;
let reportServer = null;

function listen(target, port) {
  return new Promise((resolve, reject) => {
    const s = target.listen(port, () => resolve(s));
    s.once('error', reject);
  });
}

// Brings the schema up to date and seeds an empty database before taking traffic. If the database
// is unreachable the process exits, and systemd / the orchestrator restarts it.
async function start() {
  await db.migrate({ log: (file) => obs.log('info', 'database.migrated', { migration: file }) });
  if (await seed()) obs.log('info', 'database.seeded', { database: db.DB_NAME });
  if (REPORTS_PORT) {
    reportServer = await listen(reportApp(), REPORTS_PORT);
    obs.log('info', 'report.port_started', { port: REPORTS_PORT });
  } else {
    reports.startScheduler();
  }
  server = await listen(app, PORT);
  obs.log('info', 'server.started', { url: `http://localhost:${PORT}`, env: process.env.NODE_ENV || 'development' });
  return { server, reportServer };
}

function reportApp() {
  const reportApp = express();
  reportApp.use(express.json({ limit: '1kb' }));
  reportApp.post('/reports', async (req, res) => {
    const type = req.body?.type === 'inventory' ? 'inventory' : 'sales';
    try {
      const report = await reports.runReport({ type, days: req.body?.days, trigger: 'scheduled' });
      res.status(201).json({ report });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  return reportApp;
}

const ready = start();
ready.catch((err) => {
  obs.log('error', 'server.start_failed', { error: err.message });
  process.exit(1);
});

function shutdown(sig) {
  obs.log('info', 'server.stopping', { signal: sig });
  reportServer?.close();
  const exit = () => db.close().finally(() => process.exit(0));
  if (server) server.close(exit); else exit();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// `ready` resolves to { server, reportServer } once both are listening.
module.exports = { app, ready };
