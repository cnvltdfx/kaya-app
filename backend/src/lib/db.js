// MySQL data layer: Amazon RDS for MySQL in AWS, any MySQL 8 locally (`docker compose up -d`).
// Schema lives in src/db/migrations and is applied on startup by migrate().
//
// Connection: DB_HOST, DB_PORT, DB_NAME, plus credentials from either
//   DB_SECRET_ARN  the RDS-managed Secrets Manager secret (AWS; set by the EC2 user_data), or
//   DB_USER / DB_PASSWORD  (local; defaults match docker-compose.yml).
//
// Rows come back with camelCase keys, DATETIME columns as epoch milliseconds and BOOLEAN columns
// as true/false, so the services see the same record shapes as the old JSON store.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const DB_NAME = process.env.DB_NAME || 'kaya';

let poolPromise = null;

async function credentials() {
  if (process.env.DB_SECRET_ARN) {
    const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
    const sm = new SecretsManagerClient({ region: process.env.AWS_REGION || 'ap-southeast-1' });
    const out = await sm.send(new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN }));
    const s = JSON.parse(out.SecretString);
    return { user: s.username, password: s.password };
  }
  return { user: process.env.DB_USER || 'kaya', password: process.env.DB_PASSWORD ?? 'kaya' };
}

function typeCast(field, next) {
  if (field.type === 'DATETIME') {
    const v = field.string();
    return v === null ? null : Date.parse(`${v.replace(' ', 'T')}Z`);
  }
  if (field.type === 'TINY' && field.length === 1) {
    const v = field.string();
    return v === null ? null : v === '1';
  }
  return next();
}

async function connectionOptions() {
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    database: DB_NAME,
    ...(await credentials()),
    // RDS for MySQL 8.4 requires TLS by default; the profile bundles the RDS CA certificates.
    ...(process.env.DB_SECRET_ARN || process.env.DB_SSL === 'rds' ? { ssl: 'Amazon RDS' } : {}),
    timezone: 'Z',
    decimalNumbers: true,
    typeCast,
  };
}

function pool() {
  if (!poolPromise) {
    poolPromise = connectionOptions()
      .then((opts) => mysql.createPool({ ...opts, connectionLimit: Number(process.env.DB_POOL_SIZE || 10) }))
      .catch((err) => { poolPromise = null; throw err; });
  }
  return poolPromise;
}

const camelKey = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const snake = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [camelKey(k), v]));

async function run(conn, sql, params) {
  const [result] = await conn.query(sql, params);
  return Array.isArray(result) ? result.map(camel) : result;
}

// RDS rotates the managed master password; when new connections start failing, rebuild the pool
// with the current secret and retry once.
async function query(sql, params = []) {
  try {
    return await run(await pool(), sql, params);
  } catch (err) {
    if (err.code !== 'ER_ACCESS_DENIED_ERROR' || !process.env.DB_SECRET_ARN) throw err;
    const old = poolPromise;
    poolPromise = null;
    old?.then((p) => p.end()).catch(() => {});
    return run(await pool(), sql, params);
  }
}

async function one(sql, params) {
  return (await query(sql, params))[0] || null;
}

// Runs fn({ query, one }) in a transaction on one connection; commits on success, rolls back on throw.
async function tx(fn) {
  const conn = await (await pool()).getConnection();
  const t = {
    query: (sql, params = []) => run(conn, sql, params),
    one: async (sql, params) => (await run(conn, sql, params))[0] || null,
  };
  try {
    await conn.beginTransaction();
    const out = await fn(t);
    await conn.commit();
    return out;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// MySQL named lock, so only one API server at a time runs fn (e.g. seeding an empty database).
async function withLock(name, fn, timeoutSec = 60) {
  const conn = await (await pool()).getConnection();
  try {
    const [[{ got }]] = await conn.query('SELECT GET_LOCK(?, ?) AS got', [name, timeoutSec]);
    if (got !== 1) throw new Error(`Timed out waiting for database lock ${name}.`);
    return await fn();
  } finally {
    await conn.query('DO RELEASE_LOCK(?)', [name]).catch(() => {});
    conn.release();
  }
}

// Applies pending src/db/migrations/*.sql files in filename order, recording each in
// schema_migrations. Safe when several servers start at once: they queue on a named lock.
async function migrate({ log = () => {} } = {}) {
  const conn = await mysql.createConnection({ ...(await connectionOptions()), multipleStatements: true });
  try {
    const [[{ got }]] = await conn.query("SELECT GET_LOCK('kaya_migrations', 120) AS got");
    if (got !== 1) throw new Error('Timed out waiting for the migration lock.');
    await conn.query('CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(100) NOT NULL PRIMARY KEY, applied_at DATETIME(3) NOT NULL)');
    const [rows] = await conn.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      await conn.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      await conn.query('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [file, new Date()]);
      log(file);
    }
  } finally {
    await conn.query("DO RELEASE_LOCK('kaya_migrations')").catch(() => {});
    await conn.end();
  }
}

// Drops every table in DB_NAME (used by `npm run seed` and the tests), then re-applies migrations.
async function reset() {
  const tables = await query('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()');
  if (tables.length) {
    const conn = await (await pool()).getConnection();
    try {
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      await conn.query(`DROP TABLE ${tables.map((t) => mysql.escapeId(t.name)).join(', ')}`);
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    } finally {
      conn.release();
    }
  }
  await migrate();
}

async function close() {
  const p = poolPromise;
  poolPromise = null;
  if (p) await (await p).end();
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

// Epoch ms -> Date for query parameters (written as UTC).
const ts = (ms) => (ms === null || ms === undefined ? null : new Date(ms));

// JSON column parameter (mysql2 would otherwise expand plain objects into `key = value` lists).
const json = (v) => (v === null || v === undefined ? null : JSON.stringify(v));

module.exports = { query, one, tx, withLock, migrate, reset, close, id, ts, json, snake, camel, DB_NAME };
