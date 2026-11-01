-- Kool Kaya Kitchen: initial schema (MySQL 8 / Amazon RDS for MySQL / Aurora MySQL v3).
-- Applied once by backend/src/lib/db.js migrate(); never edit an applied migration, add 002_... instead.
--
-- Conventions
--   * Timestamps are DATETIME(3) in UTC. The API converts them to epoch milliseconds.
--   * Money is DECIMAL. `price`, `*_sgd` and promotion `min_spend` are SGD; order `subtotal`,
--     `discount`, `shipping`, `total` and item `unit_price` are in the order's own currency.
--   * Status columns are VARCHAR, not ENUM, so new states (e.g. the order worker's `confirmed` /
--     `rejected`) don't need a schema change.

-- ---------------------------------------------------------------- Identity

CREATE TABLE users (
  id               VARCHAR(32)  NOT NULL,
  email            VARCHAR(254) NOT NULL,
  name             VARCHAR(80)  NOT NULL,
  role             VARCHAR(16)  NOT NULL DEFAULT 'customer',  -- customer | staff | admin
  password_hash    VARCHAR(255) NULL,                         -- scrypt "salt:hash"; NULL for SSO-only accounts
  sso_provider     VARCHAR(16)  NULL,                         -- google | apple
  market           CHAR(2)      NOT NULL DEFAULT 'SG',        -- SG | MY | TH | HK
  language         VARCHAR(8)   NOT NULL DEFAULT 'en',
  phone            VARCHAR(20)  NOT NULL DEFAULT '',
  address_line1    VARCHAR(120) NOT NULL DEFAULT '',
  address_line2    VARCHAR(120) NOT NULL DEFAULT '',
  address_city     VARCHAR(120) NOT NULL DEFAULT '',
  address_postcode VARCHAR(120) NOT NULL DEFAULT '',
  address_country  VARCHAR(120) NOT NULL DEFAULT '',
  mfa_enabled      BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at       DATETIME(3)  NOT NULL,
  last_login_at    DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY ix_users_role (role)
);

-- Bearer tokens are stored as SHA-256 hashes, so a database leak doesn't leak live sessions.
CREATE TABLE sessions (
  token_hash CHAR(64)    NOT NULL,
  user_id    VARCHAR(32) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY (token_hash),
  KEY ix_sessions_user (user_id),
  KEY ix_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE mfa_challenges (
  id         VARCHAR(32)      NOT NULL,
  user_id    VARCHAR(32)      NOT NULL,
  code_hash  VARCHAR(255)     NOT NULL,
  attempts   TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_mfa_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE reset_tokens (
  id         VARCHAR(32) NOT NULL,
  user_id    VARCHAR(32) NOT NULL,
  token_hash CHAR(64)    NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reset_token (token_hash),
  CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE audit_log (
  id      VARCHAR(32) NOT NULL,
  user_id VARCHAR(32) NULL,
  action  VARCHAR(40) NOT NULL,
  meta    JSON        NULL,
  at      DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_audit_at (at),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
);

-- ---------------------------------------------------------------- Catalogue

CREATE TABLE products (
  id                  VARCHAR(128)     NOT NULL,              -- prd_<slug>
  slug                VARCHAR(124)     NOT NULL,              -- a short URL-friendly version of a name: classic-pandan 
  name                VARCHAR(100)     NOT NULL,
  size                VARCHAR(30)      NOT NULL DEFAULT '',
  category            VARCHAR(20)      NOT NULL,              -- classic | specialty | coconut | gifts
  price               DECIMAL(10,2)    NOT NULL,              -- SGD, before sale
  sale_pct            TINYINT UNSIGNED NOT NULL DEFAULT 0,
  stock               INT UNSIGNED     NOT NULL DEFAULT 0,
  low_stock_threshold INT UNSIGNED     NOT NULL DEFAULT 15,
  featured            BOOLEAN          NOT NULL DEFAULT FALSE,
  active              BOOLEAN          NOT NULL DEFAULT TRUE,
  description         TEXT             NOT NULL,
  ingredients         VARCHAR(500)     NOT NULL DEFAULT '',
  image               VARCHAR(255)     NOT NULL DEFAULT '',
  created_at          DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_products_slug (slug),
  KEY ix_products_category (category),
  CONSTRAINT ck_products_price CHECK (price > 0),
  CONSTRAINT ck_products_sale CHECK (sale_pct < 90)
);

CREATE TABLE promotions (
  id               VARCHAR(32)   NOT NULL,
  code             VARCHAR(20)   NOT NULL,                    -- matched case-insensitively
  description      VARCHAR(120)  NOT NULL,
  type             VARCHAR(16)   NOT NULL,                    -- percent | shipping
  value            DECIMAL(10,2) NOT NULL DEFAULT 0,          -- % off for `percent`
  min_spend        DECIMAL(10,2) NOT NULL DEFAULT 0,          -- SGD
  first_order_only BOOLEAN       NOT NULL DEFAULT FALSE,
  active           BOOLEAN       NOT NULL DEFAULT TRUE,
  PRIMARY KEY (id),
  UNIQUE KEY uq_promotions_code (code)
);

CREATE TABLE reviews (
  id         VARCHAR(32)      NOT NULL,
  product_id VARCHAR(128)     NOT NULL,
  user_id    VARCHAR(32)      NOT NULL,
  user_name  VARCHAR(80)      NOT NULL,
  rating     TINYINT UNSIGNED NOT NULL,
  text       VARCHAR(1000)    NOT NULL,
  verified   BOOLEAN          NOT NULL DEFAULT FALSE,         -- reviewer has a paid order with this product
  created_at DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reviews_product_user (product_id, user_id),
  KEY ix_reviews_product_created (product_id, created_at),
  CONSTRAINT ck_reviews_rating CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT fk_reviews_product FOREIGN KEY (product_id) REFERENCES products (id),
  CONSTRAINT fk_reviews_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- Cart (logged-in users; guest carts stay in the browser)

CREATE TABLE cart_items (
  user_id    VARCHAR(32)       NOT NULL,
  product_id VARCHAR(128)      NOT NULL,
  qty        SMALLINT UNSIGNED NOT NULL,
  added_at   DATETIME(3)       NOT NULL,                      -- keeps the cart in the order items were added
  PRIMARY KEY (user_id, product_id),
  CONSTRAINT fk_cart_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_cart_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- Orders

-- Order number sequence: each insert hands out the next KK number, unique across all API servers.
CREATE TABLE order_numbers (
  n BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (n)
) AUTO_INCREMENT = 100000;

CREATE TABLE orders (
  id              VARCHAR(16)   NOT NULL,                     -- KK100123
  user_id         VARCHAR(32)   NOT NULL,
  email           VARCHAR(254)  NOT NULL,                     -- at the time of ordering
  market          CHAR(2)       NOT NULL,
  currency        CHAR(3)       NOT NULL,
  fulfilment      VARCHAR(16)   NOT NULL,                     -- delivery | pickup
  address         JSON          NULL,                         -- delivery address snapshot
  pickup_slot     JSON          NULL,                         -- { date, slot, location }
  subtotal        DECIMAL(12,2) NOT NULL,
  discount        DECIMAL(12,2) NOT NULL DEFAULT 0,
  shipping        DECIMAL(12,2) NOT NULL DEFAULT 0,
  total           DECIMAL(12,2) NOT NULL,
  total_sgd       DECIMAL(12,2) NOT NULL,
  promo_code      VARCHAR(20)   NULL,
  payment_method  VARCHAR(16)   NOT NULL,                     -- card | paynow | applepay
  payment_status  VARCHAR(16)   NOT NULL,                     -- pending | paid | failed | refunded | cancelled
  payment_ref     VARCHAR(32)   NULL,
  paynow          JSON          NULL,                         -- { ref, uen } while awaiting a PayNow transfer
  status          VARCHAR(24)   NOT NULL,                     -- pending_payment | processing | shipped | ready_for_pickup | delivered | cancelled
  idempotency_key VARCHAR(100)  NULL,
  created_at      DATETIME(3)   NOT NULL,
  paid_at         DATETIME(3)   NULL,
  updated_at      DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_orders_idempotency (user_id, idempotency_key),
  KEY ix_orders_user_created (user_id, created_at),
  KEY ix_orders_status_created (status, created_at),            -- back office filters, archival of old closed orders
  KEY ix_orders_payment_created (payment_status, created_at),   -- sales reports and dashboard
  KEY ix_orders_market_created (market, created_at),
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE TABLE order_items (
  order_id       VARCHAR(16)       NOT NULL,
  line_no        SMALLINT UNSIGNED NOT NULL,
  product_id     VARCHAR(128)      NOT NULL,
  name           VARCHAR(100)      NOT NULL,                  -- snapshot, so renaming a product doesn't rewrite history
  size           VARCHAR(30)       NULL,
  image          VARCHAR(255)      NULL,
  qty            SMALLINT UNSIGNED NOT NULL,
  unit_price_sgd DECIMAL(10,2)     NOT NULL,
  unit_price     DECIMAL(12,2)     NOT NULL,                  -- order currency
  PRIMARY KEY (order_id, line_no),
  KEY ix_order_items_product (product_id),
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_order_items_product FOREIGN KEY (product_id) REFERENCES products (id)
);

CREATE TABLE order_status_history (
  id       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id VARCHAR(16)     NOT NULL,
  status   VARCHAR(24)     NOT NULL,
  note     VARCHAR(200)    NULL,
  at       DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY ix_status_history_order (order_id, id),
  CONSTRAINT fk_status_history_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
);

-- One row per charge attempt. No foreign key to orders: the charge happens before the order row
-- exists, and declined charges never get an order.
CREATE TABLE payments (
  id          VARCHAR(32)   NOT NULL,
  order_id    VARCHAR(16)   NOT NULL,
  user_id     VARCHAR(32)   NOT NULL,
  method      VARCHAR(16)   NOT NULL,
  amount      DECIMAL(12,2) NOT NULL,
  currency    CHAR(3)       NOT NULL,
  reference   VARCHAR(32)   NOT NULL,
  status      VARCHAR(16)   NOT NULL,                         -- paid | pending | failed | refunded
  error       VARCHAR(200)  NULL,
  brand       VARCHAR(20)   NULL,                             -- card brand; only the last 4 digits are ever stored
  last4       CHAR(4)       NULL,
  paynow_ref  VARCHAR(32)   NULL,
  uen         VARCHAR(16)   NULL,
  created_at  DATETIME(3)   NOT NULL,
  paid_at     DATETIME(3)   NULL,
  refunded_at DATETIME(3)   NULL,
  PRIMARY KEY (id),
  KEY ix_payments_order (order_id),
  CONSTRAINT fk_payments_user FOREIGN KEY (user_id) REFERENCES users (id)
);

-- ---------------------------------------------------------------- Ops

CREATE TABLE notifications (
  id         VARCHAR(32)  NOT NULL,
  user_id    VARCHAR(32)  NULL,                               -- NULL for ops messages (e.g. low stock)
  channel    VARCHAR(8)   NOT NULL,                           -- email | sms
  recipient  VARCHAR(254) NOT NULL,
  subject    VARCHAR(200) NOT NULL,
  body       TEXT         NOT NULL,
  kind       VARCHAR(40)  NOT NULL,
  status     VARCHAR(16)  NOT NULL,
  created_at DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  KEY ix_notifications_user_created (user_id, created_at),
  KEY ix_notifications_created (created_at),
  CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
);

-- Metadata for report files pushed to S3 (the files themselves live in the reports bucket).
CREATE TABLE reports (
  id               VARCHAR(32)       NOT NULL,
  type             VARCHAR(16)       NOT NULL,                -- sales | inventory
  days             SMALLINT UNSIGNED NULL,
  trigger_source   VARCHAR(16)       NOT NULL,                -- manual | scheduled | cli
  requested_by     VARCHAR(254)      NULL,
  storage          VARCHAR(8)        NOT NULL,                -- s3 | local
  s3_key           VARCHAR(255)      NOT NULL,
  location         VARCHAR(512)      NOT NULL,
  summary_location VARCHAR(512)      NOT NULL,
  size_bytes       INT UNSIGNED      NOT NULL,
  summary          JSON              NOT NULL,
  created_at       DATETIME(3)       NOT NULL,
  PRIMARY KEY (id),
  KEY ix_reports_created (created_at)
);
