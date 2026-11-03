// MySQL connection for the order expirer, with the same settings as backend/src/lib/db.js (copied from order-worker):
//   DB_HOST, DB_PORT, DB_NAME, plus credentials from either
//   DB_SECRET_ARN  the RDS-managed Secrets Manager secret (AWS), or
//   DB_USER / DB_PASSWORD  (local; defaults match backend/docker-compose.yml).
// The pool lives at module scope, so warm invocations reuse the connection.
import mysql from 'mysql2/promise';

let poolPromise = null;

async function credentials() {
  if (process.env.DB_SECRET_ARN) {
    // The Lambda runtime ships the AWS SDK; imported lazily so local tests don't need it.
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const sm = new SecretsManagerClient({});
    const out = await sm.send(new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN }));
    const s = JSON.parse(out.SecretString);
    return { user: s.username, password: s.password };
  }
  return { user: process.env.DB_USER || 'kaya', password: process.env.DB_PASSWORD ?? 'kaya' };
}

function pool() {
  if (!poolPromise) {
    poolPromise = credentials()
      .then((creds) => mysql.createPool({
        host: process.env.DB_HOST || '127.0.0.1',
        port: Number(process.env.DB_PORT || 3306),
        database: process.env.DB_NAME || 'kaya',
        ...creds,
        // RDS for MySQL 8.4 requires TLS; the profile bundles the RDS CA certificates.
        ...(process.env.DB_SECRET_ARN ? { ssl: 'Amazon RDS' } : {}),
        timezone: 'Z',
        decimalNumbers: true,
        connectionLimit: Number(process.env.DB_POOL_SIZE || 2),
      }))
      .catch((err) => { poolPromise = null; throw err; });
  }
  return poolPromise;
}

// RDS rotates the managed master password; when a new connection is refused, rebuild the pool
// with the current secret and try once more.
async function connect() {
  try {
    return await (await pool()).getConnection();
  } catch (err) {
    if (err.code !== 'ER_ACCESS_DENIED_ERROR' || !process.env.DB_SECRET_ARN) throw err;
    await close();
    return (await pool()).getConnection();
  }
}

// Runs fn(conn) in a transaction; commits on success, rolls back on throw.
export async function tx(fn) {
  const conn = await connect();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

export async function close() {
  const p = poolPromise;
  poolPromise = null;
  if (p) await (await p).end().catch(() => {});
}
