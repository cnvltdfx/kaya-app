# Load test demo: ASG scaling and SQS burst

Two live tests, about 6–8 minutes together:

1. **ASG scaling:** steady web traffic makes the Auto Scaling group add API servers (1 → 3).
2. **SQS burst:** a burst of thousands of order messages lands in the order queue. The EC2 servers don't
   change; the order-worker Lambda scales out (up to 10 at once) and drains the queue.

Both run against the shared AWS stack (`kaya` profile, ap-southeast-1). Tell the team before rehearsing
or presenting: alarm emails can fire, and the stack serves everyone's testing.

## One-time setup

| What | Why |
|---|---|
| `terraform.tfvars`: `asg_max_size = 3`, `warm_pool_min_size = 2` | Lets the ASG scale out, and starts new servers from a warm pool (faster) |
| `terraform.tfvars`: no `order_payment_timeout_minutes = 1` / `order_expiry_schedule = "rate(1 minute)"` | The 1-minute expiry cancels unpaid orders and re-queues paid ones during the demo |
| Apply: `terraform plan -out demo.tfplan`, review, `terraform apply demo.tfplan` | Also adds "Order workers running at once" to the dashboard |
| `winget install k6` | Load generator for the ASG test |
| `cd infra/loadtest; npm ci` | AWS SDK for the burst script |

Check that the site URL in the commands below is still current (`terraform output`); it changes if
the stack is rebuilt.

## Before the demo (do the day before, and check again on the day)

- [ ] ASG `kool-kaya-kitchen-api` is at **1** server (after a rehearsal it takes 15+ minutes to scale back in).
- [ ] 3–5 orders placed with a card on your account, all showing **Processing** under My orders. Note their IDs (`KK…`).
- [ ] Session token copied: on the site, signed in, run `JSON.parse(localStorage.kk_token)` in the browser console.
- [ ] Order DLQ `kool-kaya-kitchen-orders-dlq` is empty.
- [ ] WAF is still in **count** mode. In block mode the site rate limit (2,000 requests per 5 min per IP) blocks the ASG test.
- [ ] A full rehearsal done, and screen-recorded as a backup in case the venue Wi-Fi fails.

Open these tabs, in this order:

1. CloudWatch dashboard `kool-kaya-kitchen-ops`, last 15 minutes, auto-refresh 10 s.
2. EC2 → Auto Scaling groups → `kool-kaya-kitchen-api` → **Activity** tab.
3. Lambda → `kool-kaya-kitchen-order-worker` → **Monitor** tab ("Concurrent executions").
4. SQS → `kool-kaya-kitchen-orders` ("Messages available").
5. Two PowerShell terminals in `infra/loadtest`, both with `$env:AWS_PROFILE = 'kaya'`.

## Run order

The ASG needs about 3 minutes of sustained traffic before it reacts, so start k6 first, run the SQS
test while the ASG is still at 1 server, then come back to the ASG.

| Time | Do | Say |
|---|---|---|
| 0:00 | Terminal 1: start k6 (Test 1) | "Steady shopper traffic, 50 requests a second." |
| 0:30 | Terminal 2: start the burst (Test 2) | "Now a burst of payment confirmations, like midnight on 11.11." |
| 0:30–3:00 | Show queue draining, worker concurrency, ASG still at 1 | See Test 2 talking points |
| 3:00–6:00 | Show the ASG Activity tab and "API servers" graph go 1 → 3 | See Test 1 talking points |
| End | Stop k6 with Ctrl+C | "Scale-in is deliberately slow, so we don't drop servers mid-spike." |

## Test 1: ASG scaling

```powershell
k6 run -e SITE=https://d2tz3m76rw00ti.cloudfront.net asg-load.js
```

Sends 50 requests/second (3,000/minute) through CloudFront to the API for 12 minutes: 80%
`/api/catalog/categories`, 20% `/api/catalog/products`. Options: `-e RATE=50`, `-e DURATION=12m`.

**Expected**

- About 3 minutes in: the `alb-requests-target-tracking` policy fires (target: 1,000 requests per server per minute, so 3,000/min asks for 3 servers).
- The Activity tab shows instances launching from the warm pool; about 1–2 minutes later they pass health checks.
- Dashboard: "API servers behind the load balancer" goes 1 → 3, and requests per server drop.
- k6 summary: `status 200` checks close to 100%.

**Talking points**

- Scaling is driven by requests per server, not just CPU, so it reacts to traffic directly.
- The warm pool keeps pre-built, stopped servers, so a scale-out skips the boot and image download.
- Traffic comes through CloudFront and WAF; the load balancer only accepts traffic from CloudFront.
- Scale-in waits about 15 minutes of low traffic, so short dips don't remove servers.

## Test 2: SQS burst

```powershell
node sqs-burst.mjs --orders KK100001,KK100002,KK100003 --count 20000 --token <token>
```

The script:

1. Checks each order through the API and **refuses to run** if any is `pending_payment` or `cancelled`.
2. Sends `--count` messages, spread across the orders, in a few seconds.
3. Prints the queue depth every 2 seconds until it is empty, then the DLQ count.

Each message says checkout `expired` for an order that is already paid. The worker locks the order,
sees it is already settled and skips it, so **no order, stock or email changes**. Say so if asked:
the burst is replayed messages, which also shows that duplicate deliveries are harmless.

Watch the queue again without sending: `node sqs-burst.mjs --watch-only`.

**Expected**

- Terminal: "waiting" jumps to the full count, then falls to 0 within a minute or two.
- Lambda Monitor tab / dashboard: order workers running at once climbs to about 10, then back to 0.
- ASG: still 1 server, unchanged by the burst.
- Script ends with `DLQ: 0 messages`.

**Talking points**

- Settling an order (payment, status change, emails) happens off the web servers: the API saves the order and drops a message on the queue, and the worker does the rest. A burst of settlements never piles up on the web servers. (Checkout itself still runs on the API, which is what Test 1 scales.)
- Lambda adds workers while there is a backlog and goes back to zero afterwards; we pay only while it runs.
- Nothing is lost: a message that fails is retried, and after 5 failures it is kept in the dead-letter queue for staff.
- SQS delivers at least once. The worker locks the order row and only changes an order still awaiting payment, so repeats are safe.
- Limit: Lambda in this account runs at most 10 functions at once (a new-account quota), shared with the email sender. It can be raised to 1,000 on request.

**Tuning:** pick `--count` in rehearsal so the queue takes 1–2 minutes to drain. 20,000 is a starting
guess. Cost is negligible: SQS is about US$0.40 per million messages.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| ASG doesn't scale after 5 minutes | `asg_max_size` still 1, or k6 not reaching the API | Check the ASG's max; check k6's `status 200` rate |
| k6 shows 403s | WAF switched to block mode | Set `waf_mode = "count"` for the demo |
| k6 shows 5xx or slow responses | Database or servers overloaded | Lower `-e RATE=30`; check the dashboard's CPU graphs |
| Burst script: `API returned 401/404` | Token expired, or order isn't on this account | Copy a fresh token; use your own order IDs |
| Burst script refuses an order | Order is `pending_payment` or `cancelled` | Use an order that is Processing |
| Queue drains in a few seconds | Burst too small to see | Raise `--count` |
| DLQ not 0 | Worker errors | Check logs in `/aws/lambda/kool-kaya-kitchen-order-worker` for `order.failed` |

## After the demo

- Stop k6 (Ctrl+C). The ASG returns to 1 server on its own after about 15 minutes.
- Check the DLQ is empty.
- Optional: put `asg_max_size` back to its usual value and re-apply, if the team prefers.
