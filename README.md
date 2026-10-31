# Kool Kaya Kitchen — Online Shopping System

IS458 Cloud Management & Engineering · G1T2 · Theme: **Online Shopping System**

A working online store for an artisanal kaya distributor based in Singapore. It sells to four Asia-Pacific markets: Singapore (~80% of customers), Malaysia, Thailand and Hong Kong. The code is split into a static **frontend** (`frontend/`, deployed to S3 + CloudFront) and a **backend** API (`backend/`, a Docker image on EC2/ECS behind the ALB). The backend is built as separate service modules so each one maps directly onto an AWS resource (see [AWS mapping](#aws-mapping)).

## Run it

Requires Node.js 20+.

```bash
cd backend
npm install
npm start            # http://localhost:3000  (seeds demo data on first run)
npm test             # 11 end-to-end API tests
npm run seed         # wipe and reseed the local database
npm run report       # generate sales + inventory reports from the CLI (scheduled-task entry point)
npm run images       # regenerate the product SVGs in frontend/img/products
```

For local development the backend also serves `../frontend`, so the whole store runs from one port. Set `FRONTEND_DIR=` (empty) to run it as a pure API.

To use a `.env` file: `cp backend/.env.example backend/.env`, then `node --env-file=.env server.js` from `backend/`.

### Running the frontend separately

`frontend/` is plain static files with no build step. Point it at the API in `frontend/config.js`:

```js
window.KK_CONFIG = { apiBase: 'http://localhost:3000' };   // '' = same origin
```

then serve it with any static server (e.g. `npx serve frontend -l 8080`) and start the backend with `CORS_ORIGINS=http://localhost:8080 npm start`. In AWS, leave `apiBase` empty and have CloudFront route `/api/*` to the ALB, so no CORS is needed.

### Demo accounts (development only)

| Role | Email | Password | Notes |
|---|---|---|---|
| Customer | `demo@koolkaya.sg` | `Demo@1234` | Has order history in SG |
| Staff | `staff@koolkaya.sg` | `Staff@1234` | MFA required |
| Admin | `admin@koolkaya.sg` | `Admin@1234` | MFA required |

In development, the MFA code and password-reset link are shown on screen. They're also in Back office → Notifications. When `NODE_ENV=production` they're only "sent" by email.

**Test cards** (simulated gateway): `4242 4242 4242 4242` succeeds, `4000 0000 0000 0002` is declined. Use any future expiry and any CVC. PayNow orders show a QR code and a "Simulate bank confirmation" button.

## Features vs. requirements

### Functional
| Requirement | Where |
|---|---|
| Product catalogue, details (price, image, description) | Shop, product pages |
| Search, filter (category, price, on sale, in stock), sort (price, rating, best-selling, newest) | Shop |
| Add to cart, with DB and view updates | Server-side cart for logged-in users; guest cart in the browser, merged on login |
| Reviews & ratings | Product page ("Verified buyer" badge if purchased) |
| Promotions / sales | Sale prices plus promo codes `WELCOME10`, `KAYA1111` (min S$30), `FREESHIP` |
| Help page | FAQ, shipping fees per market, contact |
| Register / log in (email + SSO) | Email/password; Google/Apple SSO (demo flow, Cognito-ready) |
| Reset password | Forgot password → emailed token (30 min expiry) |
| Profile management | Account → Profile (name, email, phone, address, market, language) |
| Checkout: delivery or pick-up, payment method | Delivery (all markets) or self pick-up with time slot (SG) |
| Pay by card / PayNow / Apple Pay, with receipt | Simulated gateway; printable receipt; only last 4 digits stored |
| Order history & status | Account → Orders, status timeline per order |
| SMS / email notifications | On every order event; see Account → Notifications |
| Staff: products, inventory, orders, sales reports | Back office |
| **Reports pushed to S3** | Back office → Reports, a daily 00:05 SGT scheduler, and `npm run report` |

### Non-functional (as built)
- **Availability:** stateless app server with `/health` and `/ready` for the load balancer. Recommendations are optional: if that service fails (`RECS_FAIL_RATE=0.5`), the rest of the page still loads.
- **Consistency:** stock is reserved before payment and released if payment fails. An `Idempotency-Key` header prevents duplicate orders on retry. The server blocks overselling.
- **Security:** scrypt password hashing; MFA required for staff and admin; role-based access control; rate limiting on auth and checkout (bot mitigation, like AWS WAF rate rules); CSP/HSTS headers; output escaping; audit log; card numbers never stored.
- **Observability:** structured JSON logs with trace IDs; live p50/p95 latency and error rate **per service and per market**; SLO alerts (latency, error rate), plus low-stock and report-failure alerts.
- **Localisation:** SGD / MYR / THB / HKD pricing; English, Simplified Chinese, Traditional Chinese, Malay and Thai; dates shown in each market's time zone.

## AWS mapping

| App module | Local implementation | AWS target |
|---|---|---|
| Web frontend (`frontend/`) | Express static (local dev only) | S3 + CloudFront (edge caching for MY/TH/HK latency) |
| API services (`backend/src/services/*`) | One Express process, one router per service | ECS Fargate services behind an ALB (multi-AZ), auto-scaling on CPU/request count; scheduled scale-up before 11.11 |
| Data (`backend/src/lib/db.js`) | JSON document store | DynamoDB (carts, sessions) + RDS Multi-AZ (orders, products), with a cross-region replica for DR |
| Auth (`auth.js`) | scrypt + session tokens + email MFA | Amazon Cognito (hosted UI, Google/Apple IdPs, MFA) |
| Payments (`payments.js`) | Simulated gateway | Stripe/Adyen; keys in Secrets Manager |
| Notifications (`notifications.js`) | Outbox table | SQS → Lambda → SES (email) / SNS (SMS) |
| Reports (`reports.js`) | `./reports/…` or S3 via AWS SDK | **S3** (SSE-KMS, lifecycle to Glacier), triggered by EventBridge Scheduler |
| Observability (`observability.js`) | In-process metrics + JSON logs | CloudWatch Logs / Metrics / Dashboards / Alarms → SNS; X-Ray tracing |
| Rate limiting | In-process limiter | AWS WAF + Shield |

### Pushing reports to S3

```bash
cd backend && S3_BUCKET=kool-kaya-reports AWS_REGION=ap-southeast-1 npm start
```

Credentials come from the standard AWS chain: the ECS task role in AWS, or `AWS_PROFILE` / env vars locally. The task role needs `s3:PutObject` and `s3:GetObject` on `arn:aws:s3:::kool-kaya-reports/reports/*`. Objects are written to `reports/{sales|inventory}/YYYY/MM/DD/…csv|json`.

### Container

The image contains only the backend API.

```bash
docker build -t kool-kaya-api backend
docker run -p 3000:3000 -e S3_BUCKET=… kool-kaya-api
```

## Project structure

```
frontend/                         static storefront → S3 + CloudFront
  index.html, styles.css
  config.js                       API base URL (set per environment)
  app.js, admin.js, i18n.js       storefront SPA, back office, translations
  img/                            logo + product art
backend/                          API → Docker image (EC2/ECS behind the ALB)
  server.js                       API gateway, health checks, CORS, dev static hosting
  src/lib/                        db, markets/FX, pricing, security, observability
  src/services/                   catalog, auth, cart, orders, payments, notifications, reports, admin
  src/seed.js                     products, demo users, 160 historical orders (80% SG)
  test/api.test.js                end-to-end API tests
  Dockerfile, .env.example
infra/                            Terraform + Lambda functions
```
