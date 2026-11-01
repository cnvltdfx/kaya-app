# API reference

Base URL: `http://localhost:3000` locally, or the ALB / CloudFront domain in AWS. Every path below starts with `/api` unless noted.

## Conventions

**Headers**

| Header | Used for |
|---|---|
| `Authorization: Bearer <token>` | Any endpoint marked **auth**. The token comes from `/api/auth/login` (or `/register`, `/sso`, `/mfa`). |
| `X-Market: SG \| MY \| TH \| HK` | Prices and shipping for that market. Defaults to `SG`. |
| `Idempotency-Key: <string>` | `POST /orders/checkout`. A retry with the same key returns the original order instead of charging again. |
| `Content-Type: application/json` | Every request with a body. |

**Errors.** The body is always `{ "error": "message" }`, with one of these status codes:

| Code | Meaning |
|---|---|
| 400 | Invalid input |
| 401 | Not logged in, or the session has expired |
| 402 | Payment declined |
| 403 | Logged in, but not staff or admin |
| 404 | Not found (also returned for orders that belong to someone else) |
| 409 | Conflict: out of stock, invalid status change, duplicate email or review |
| 429 | Rate limited. The `Retry-After` header says how many seconds to wait. |
| 500 | Server error. The body includes a `traceId` to quote when reporting it. |

**Rate limits**, per IP: auth endpoints 20 requests/minute, checkout 10 requests/minute.

**Money.** Prices in `products` are SGD. Cart and order amounts are in the market's currency (`SGD`, `MYR`, `THB` or `HKD`). Each object also carries `totalSgd` where it matters for reporting.

**Dates.** Timestamps are epoch milliseconds (for example `1785778575757`).

---

## Health

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | none | Liveness check for the load balancer. Returns `{ "status": "ok" }`. |
| GET | `/ready` | none | Readiness check. Queries the database. Returns `{ "status": "ready", "products": 12 }`, or 503 if the database is unreachable. |

---

## Auth (`/api/auth`)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/register` | none | Create a customer account and sign in. |
| POST | `/login` | none | Sign in with email and password. |
| POST | `/mfa` | none | Finish a sign-in that needs a code. |
| POST | `/sso` | none | Demo Google/Apple sign-in. |
| POST | `/forgot` | none | Start a password reset. |
| POST | `/reset` | none | Set a new password with a reset token. |
| POST | `/logout` | optional | End the current session. |
| GET | `/me` | auth | Current user's profile. |
| PUT | `/me` | auth | Update the profile. |
| POST | `/password` | auth | Change the password. |
| GET | `/notifications` | auth | The user's last 50 emails and SMS messages (MFA codes excluded). |

**POST `/register`**

```json
{ "name": "Mei", "email": "mei@example.com", "password": "Secret123", "market": "SG", "language": "en" }
```

Password must be at least 8 characters with letters and numbers. `market` and `language` are optional. Returns `{ "token", "user" }`, with the session token valid for 7 days.

**POST `/login`**

```json
{ "email": "admin@koolkaya.sg", "password": "Admin@1234" }
```

Returns `{ "token", "user" }`. If the account has MFA on, it returns instead:

```json
{ "mfaRequired": true, "challengeId": "mfa_…", "devCode": "123456" }
```

`devCode` is included only when `NODE_ENV` is not `production`. The code expires after 5 minutes and locks after 5 wrong attempts.

**POST `/mfa`**

```json
{ "challengeId": "mfa_…", "code": "123456" }
```

Returns `{ "token", "user" }`. Each challenge works once.

**POST `/sso`**

```json
{ "provider": "google", "email": "sam@example.com", "name": "Sam" }
```

`provider` is `google` or `apple`. Creates the customer if the email is new. Staff accounts are refused with 403.

**POST `/forgot`**

```json
{ "email": "mei@example.com" }
```

Always returns `{ "ok": true, "message": "…" }`, so it doesn't reveal which emails are registered. In development the response also includes `devToken`.

**POST `/reset`**

```json
{ "token": "…", "password": "NewSecret1" }
```

Tokens expire after 30 minutes. Resetting the password signs the user out everywhere.

**PUT `/me`**: any of these fields, all optional:

```json
{
  "name": "Mei Lin",
  "email": "mei.lin@example.com",
  "phone": "+65 8123 4567",
  "market": "MY",
  "language": "ms",
  "address": { "line1": "…", "line2": "", "city": "…", "postcode": "…", "country": "…" },
  "mfaEnabled": true
}
```

`mfaEnabled` can be changed only by customers. Returns `{ "user" }`.

**POST `/password`**

```json
{ "current": "Secret123", "password": "NewSecret1" }
```

`current` is required only if the account has a password (SSO-only accounts don't).

---

## Catalogue (`/api/catalog`)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/config` | none | Markets, languages and categories. |
| GET | `/categories` | none | Categories only. |
| GET | `/products` | none | List and search products. |
| GET | `/products/:id` | none | One product with its reviews. `:id` is the slug (`durian-kaya`) or the ID (`prd_durian-kaya`). |
| POST | `/products/:id/reviews` | auth | Add a review. |
| GET | `/promotions` | none | Active promo codes, and products on sale. |
| GET | `/recommendations` | none | Up to 4 products. Add `?productId=` for "customers also bought". Can return 503 when the optional recommendations service fails. |

**GET `/products`** query parameters, all optional:

| Parameter | Example | Notes |
|---|---|---|
| `q` | `pandan` | Words must all appear in the name, description, ingredients or category. |
| `category` | `classic` | `classic`, `specialty`, `coconut` or `gifts` |
| `minPrice`, `maxPrice` | `10` | In the market's currency |
| `onSale` | `1` | Only products with a sale |
| `inStock` | `1` | Only products with stock |
| `sort` | `price_asc` | `featured` (default), `price_asc`, `price_desc`, `rating`, `newest`, `name`, `popular` |

Response: `{ "products": [...], "total": 12 }`. Each product includes `priceLocal`, `salePriceLocal`, `currency`, `rating`, `reviewCount`, `inStock` and `lowStock`.

**POST `/products/:id/reviews`**

```json
{ "rating": 5, "text": "Lovely with toast." }
```

Rating is 1 to 5. A user can review a product once. `verified` is set to true when the user has a paid order containing it.

---

## Cart (`/api/cart`)

Logged-in users get a server-side cart. Guests keep their cart in the browser, then merge it in with `/merge` after signing in.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/quote` | optional | Price a cart. Guests send their items in the body. |
| GET | `/` | auth | The cart, priced. |
| POST | `/items` | auth | Add a product: `{ "productId": "prd_…", "qty": 2 }`. |
| PUT | `/items/:productId` | auth | Set the quantity: `{ "qty": 3 }`. 0 removes the item. |
| DELETE | `/items/:productId` | auth | Remove an item. |
| POST | `/merge` | auth | Merge a guest cart: `{ "items": [{ "productId", "qty" }] }`. |

Every cart endpoint returns the priced cart: `lines`, `subtotal`, `discount`, `shipping`, `total`, `currency`, `promo`, `promoError`, `errors` and `itemCount`. `errors` lists problems such as out-of-stock items.

`/quote` also takes `promoCode` and `fulfilment` (`delivery` or `pickup`) in the body.

---

## Orders (`/api/orders`): all auth

| Method | Path | Description |
|---|---|---|
| POST | `/checkout` | Place an order from the cart. |
| GET | `/` | The user's orders, newest first. |
| GET | `/pickup-slots` | The pickup time slots. |
| GET | `/:id` | One order. Returns 404 for another user's order. |
| POST | `/:id/cancel` | Cancel an order that is `pending_payment` or `processing`. Returns stock and refunds. |

**POST `/checkout`**, with a card payment:

```json
{
  "fulfilment": "delivery",
  "address": { "name": "Mei", "line1": "1 Kaya Lane", "line2": "#01-23", "city": "Singapore", "postcode": "123456", "phone": "+65 8123 4567" },
  "promoCode": "WELCOME10",
  "payment": {
    "method": "card",
    "card": { "name": "Mei", "number": "4242 4242 4242 4242", "expiry": "12/30", "cvc": "123" }
  }
}
```

- `payment.method` is `card`, `paynow` or `applepay`. `paynow` is only available in SG. For `applepay`, omit `card`.
- For pickup, use `"fulfilment": "pickup"`, drop `address`, and send `"pickupDate": "2030-01-01"` and `"pickupSlot": "10:00-12:00"` (one of the values from `/pickup-slots`).
- Test cards: `4242 4242 4242 4242` succeeds, `4000 0000 0000 0002` is declined.

Responses:

| Status | Body | When |
|---|---|---|
| 201 | `{ "order": {...} }` | Order placed. `paynow` orders stay `pending_payment` until confirmed. |
| 200 | `{ "order": {...}, "duplicate": true }` | Same `Idempotency-Key` as an earlier order. |
| 400 | `{ "error" }` | Empty cart, missing address or slot, bad payment method, or a bad promo code. |
| 402 | `{ "error" }` | Card declined. Stock is put back. |
| 409 | `{ "error" }` | Out of stock. |

An order object includes `id` (for example `KK100123`), `status`, `paymentStatus`, `items`, `statusHistory`, `total`, `currency`, `address`, `pickupSlot` and `paynow` (`{ ref, uen }` while a PayNow transfer is pending).

**Order statuses:** `pending_payment` → `processing` → `shipped` or `ready_for_pickup` → `delivered`. `cancelled` is reachable from `pending_payment` or `processing`.

---

## Payments (`/api/payments`): all auth

| Method | Path | Description |
|---|---|---|
| POST | `/:orderId/paynow/confirm` | Simulates the bank confirming a PayNow transfer. The order moves to `processing`. |
| GET | `/:orderId/receipt` | `{ "order", "payment" }`. Customers see their own orders; staff see any. |

Payments are created during checkout. There's no separate charge endpoint.

---

## Admin (`/api/admin`): staff or admin only

Every route returns 403 for customers.

| Method | Path | Description |
|---|---|---|
| GET | `/dashboard?days=30` | Revenue, orders, average order value, customers, breakdown by market, daily series (1–90 days), top products, low stock and order status counts. |
| GET | `/products` | All products (including inactive), with review stats. |
| POST | `/products` | Create a product. Requires `name`, `price`, `category`. The slug is generated from the name. |
| PUT | `/products/:id` | Update any of `name`, `size`, `description`, `ingredients`, `category`, `price`, `salePct`, `stock`, `lowStockThreshold`, `featured`, `active`. |
| GET | `/orders?status=&market=&q=` | Latest 200 orders, with `total` and the allowed `transitions`. `q` matches order ID or email. |
| PUT | `/orders/:id/status` | `{ "status": "shipped" }`. Returns 409 if the move isn't allowed. Pickup orders can't be shipped, and delivery orders can't be marked ready for pickup. Cancelling returns stock and refunds. |
| GET | `/promotions` | All promo codes. |
| POST | `/promotions` | `{ "code": "SUMMER20", "type": "percent", "value": 20, "minSpend": 30, "description": "…" }`. `type` is `percent` (1–50) or `shipping`. |
| PUT | `/promotions/:id` | `{ "active": false }` |
| GET | `/reports` | The 50 most recent report records. |
| POST | `/reports` | `{ "type": "sales", "days": 30 }` or `{ "type": "inventory" }`. Writes CSV and JSON files to the reports bucket (or `./reports` locally). |
| GET | `/reports/:id/download` | Downloads the report CSV. |
| GET | `/metrics` | Request counts, p50/p95 latency and error rate, overall and per market. |
| GET | `/notifications` | The latest 100 notifications, for every user. |
| GET | `/audit` | The latest 100 audit entries, with the actor's email. |

---

## Quick start

```bash
# 1. Sign in as the seeded admin
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@koolkaya.sg","password":"Admin@1234"}' | jq -r .token)

# 2. Read the dashboard
curl -s "http://localhost:3000/api/admin/dashboard?days=30" -H "authorization: Bearer $TOKEN"
```
