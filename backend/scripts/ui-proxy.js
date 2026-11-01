// Local dev helper: serves ../frontend and forwards /api and /health to a deployed API (the ALB),
// so you can use the storefront and back office against AWS without CORS or any infra changes.
//
//   node scripts/ui-proxy.js http://<alb_dns_name>        # then open http://localhost:8080
//
// Not part of the Docker image (the image copies only server.js and src/).
const http = require('http');
const fs = require('fs');
const path = require('path');

const target = new URL(process.argv[2] || process.env.API_TARGET || '');
if (!/^https?:$/.test(target.protocol)) {
  console.error('Usage: node scripts/ui-proxy.js http://<alb_dns_name>');
  process.exit(1);
}
const PORT = Number(process.env.PORT || 8080);
const ROOT = path.join(__dirname, '..', '..', 'frontend');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function proxy(req, res) {
  const lib = target.protocol === 'https:' ? require('https') : http;
  const up = lib.request({
    host: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80),
    method: req.method, path: req.url, headers: { ...req.headers, host: target.host },
  }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', (e) => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: `Cannot reach ${target.origin}: ${e.message}` })); });
  req.pipe(up);
}

http.createServer((req, res) => {
  if (req.url.startsWith('/api') || req.url === '/health' || req.url === '/ready') return proxy(req, res);
  const file = path.join(ROOT, path.normalize(decodeURIComponent(req.url.split('?')[0])));
  const inside = file.startsWith(ROOT);
  const target404 = inside && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(ROOT, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(target404)] || 'application/octet-stream' });
  fs.createReadStream(target404).pipe(res);
}).listen(PORT, () => console.log(`Storefront: http://localhost:${PORT}  ->  API ${target.origin}`));
