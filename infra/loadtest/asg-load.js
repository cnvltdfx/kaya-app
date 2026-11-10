// ASG demo: steady API traffic through CloudFront until the request-count policy adds servers.
// 50 req/s = 3,000 req/min; with requests_per_target = 1000 the ASG wants 3 servers (asg_max_size = 3).
// Scale-out starts about 3 minutes in, so start this before presenting. Scale-in takes 15+ minutes.
//   k6 run -e SITE=https://d2tz3m76rw00ti.cloudfront.net asg-load.js
//   (optional: -e RATE=50 -e DURATION=12m)
// Mostly /categories (no DB) with some /products (one DB query), so the db.t4g.micro is not the bottleneck.
import http from 'k6/http';
import { check } from 'k6';

const SITE = __ENV.SITE || 'https://d758tib50v2c2.cloudfront.net';

export const options = {
  scenarios: {
    load: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 50),
      timeUnit: '1s',
      duration: __ENV.DURATION || '12m',
      preAllocatedVUs: 100,
      maxVUs: 300,
    },
  },
};

export default function () {
  const path = Math.random() < 0.8 ? 'categories' : 'products';
  const res = http.get(`${SITE}/api/catalog/${path}`, { tags: { name: path } });
  check(res, { 'status 200': (r) => r.status === 200 });
}
