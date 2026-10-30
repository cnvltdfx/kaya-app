// Structured logging + in-process metrics.
// In AWS these JSON log lines go to CloudWatch Logs; the metrics endpoint
// mirrors what CloudWatch custom metrics / dashboards would show per service and per market.
const crypto = require('crypto');

const startedAt = Date.now();
const WINDOW_MS = 15 * 60 * 1000; // keep last 15 minutes of samples
const samples = []; // { t, service, route, market, status, ms }
const alerts = [];

const SLO = {
  p95LatencyMs: Number(process.env.SLO_P95_MS || 300),
  errorRate: Number(process.env.SLO_ERROR_RATE || 0.02),
};

function log(level, msg, fields = {}) {
  if (process.env.LOG_SILENT) return;
  const line = { ts: new Date().toISOString(), level, msg, ...fields };
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
}

function serviceOf(path) {
  const m = path.match(/^\/api\/([a-z]+)/);
  return m ? m[1] : 'web';
}

function middleware(req, res, next) {
  const start = process.hrtime.bigint();
  req.traceId = req.get('x-trace-id') || crypto.randomBytes(8).toString('hex');
  res.set('x-trace-id', req.traceId);
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const urlPath = req.originalUrl.split('?')[0];
    if (!urlPath.startsWith('/api')) return;
    const rec = {
      t: Date.now(),
      service: serviceOf(urlPath),
      route: `${req.method} ${req.route ? req.baseUrl + req.route.path : urlPath}`,
      market: req.market || 'SG',
      status: res.statusCode,
      ms,
    };
    samples.push(rec);
    log(res.statusCode >= 500 ? 'error' : 'info', 'request', { traceId: req.traceId, ...rec, ms: Math.round(ms * 10) / 10 });
    prune();
  });
  next();
}

function prune() {
  const cutoff = Date.now() - WINDOW_MS;
  while (samples.length && samples[0].t < cutoff) samples.shift();
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

function summarise(list) {
  const lat = list.map((s) => s.ms);
  const errors = list.filter((s) => s.status >= 500).length;
  return {
    requests: list.length,
    errors,
    errorRate: list.length ? errors / list.length : 0,
    p50: Math.round(pct(lat, 50) * 10) / 10,
    p95: Math.round(pct(lat, 95) * 10) / 10,
  };
}

function groupBy(key) {
  const out = {};
  for (const s of samples) (out[s[key]] ||= []).push(s);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, summarise(v)]));
}

function evaluateAlerts() {
  const overall = summarise(samples);
  const active = [];
  if (overall.requests >= 20 && overall.p95 > SLO.p95LatencyMs) active.push({ name: 'HighLatency', detail: `p95 ${overall.p95}ms > SLO ${SLO.p95LatencyMs}ms` });
  if (overall.requests >= 20 && overall.errorRate > SLO.errorRate) active.push({ name: 'HighErrorRate', detail: `error rate ${(overall.errorRate * 100).toFixed(1)}% > ${(SLO.errorRate * 100).toFixed(1)}%` });
  for (const a of active) {
    const last = alerts.findLast?.((x) => x.name === a.name);
    if (!last || Date.now() - last.t > 5 * 60 * 1000) {
      alerts.push({ ...a, t: Date.now() });
      log('warn', 'alert', a);
    }
  }
  return active;
}

function raiseAlert(name, detail) {
  alerts.push({ name, detail, t: Date.now() });
  log('warn', 'alert', { name, detail });
}

function snapshot() {
  prune();
  return {
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    windowMinutes: WINDOW_MS / 60000,
    slo: SLO,
    overall: summarise(samples),
    byService: groupBy('service'),
    byMarket: groupBy('market'),
    activeAlerts: evaluateAlerts(),
    recentAlerts: alerts.slice(-20).reverse(),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
  };
}

module.exports = { log, middleware, snapshot, raiseAlert };
