// Kool Kaya Kitchen — API gateway + web frontend.
// Each /api/<service> router is an independently deployable module (catalog, auth, cart,
// orders, payments, admin/reports). Locally they run in one process; in AWS each can run
// as its own ECS Fargate service / Lambda behind an Application Load Balancer or API Gateway.
const path = require('path');
const express = require('express');
const db = require('./src/lib/db');
const obs = require('./src/lib/observability');
const sec = require('./src/lib/security');
const { seed } = require('./src/seed');
const reports = require('./src/services/reports');

const PORT = Number(process.env.PORT || 3000);
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(sec.securityHeaders);
app.use(express.json({ limit: '100kb' }));
app.use(sec.attachUser);
app.use(obs.middleware);

// Health checks for the load balancer (liveness) and deployment (readiness)
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/ready', (_req, res) => {
  try {
    db.load();
    res.json({ status: 'ready', products: db.table('products').all().length });
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

app.use(express.static(path.join(__dirname, 'public'), { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0, index: 'index.html' }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  obs.log('error', 'unhandled', { traceId: req.traceId, error: err.message, stack: err.stack });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  res.status(500).json({ error: 'Something went wrong. Please try again.', traceId: req.traceId });
});

if (seed()) obs.log('info', 'database.seeded', { file: db.DB_FILE });
reports.startScheduler();

const server = app.listen(PORT, () => {
  obs.log('info', 'server.started', { url: `http://localhost:${PORT}`, env: process.env.NODE_ENV || 'development' });
});

function shutdown(sig) {
  obs.log('info', 'server.stopping', { signal: sig });
  server.close(() => {
    db.flush();
    process.exit(0);
  });
  setTimeout(() => { db.flush(); process.exit(0); }, 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server };
