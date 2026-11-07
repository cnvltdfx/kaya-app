// Password hashing, session tokens, auth middleware, security headers and rate limiting.
// In AWS: Cognito (identity, see cognito.js), WAF rate-based rules (bot mitigation), Secrets Manager (secrets).
const crypto = require('crypto');
const db = require('./db');
const cognito = require('./cognito');

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// users row -> user record (address columns folded back into an object)
function toUser(row) {
  if (!row) return null;
  const { addressLine1, addressLine2, addressCity, addressPostcode, addressCountry, ...u } = row;
  return { ...u, address: { line1: addressLine1, line2: addressLine2, city: addressCity, postcode: addressPostcode, country: addressCountry } };
}

async function getUser(userId) {
  return toUser(await db.one('SELECT * FROM users WHERE id = ?', [userId]));
}

async function findUserByEmail(email) {
  return toUser(await db.one('SELECT * FROM users WHERE email = ?', [email]));
}

// Inserts a user record (same shape toUser returns) and returns it.
async function insertUser(u, q = db) {
  const a = u.address || {};
  await q.query(
    `INSERT INTO users (id, cognito_sub, email, name, role, password_hash, sso_provider, market, language, phone,
       address_line1, address_line2, address_city, address_postcode, address_country, mfa_enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [u.id, u.cognitoSub || null, u.email, u.name, u.role, u.passwordHash, u.ssoProvider || null, u.market, u.language, u.phone || '',
      a.line1 || '', a.line2 || '', a.city || '', a.postcode || '', a.country || '', !!u.mfaEnabled, db.ts(u.createdAt)],
  );
  return u;
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  await db.query('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [sha256(token), userId, db.ts(now), db.ts(now + SESSION_TTL_MS)]);
  return token;
}

async function destroySession(token) {
  await db.query('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
}

async function currentUser(req) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  // Outside local auth, only Cognito-linked users count, so sessions from before Cognito stop working.
  const linked = cognito.localAuth ? '' : ' AND u.cognito_sub IS NOT NULL';
  const row = await db.one(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?${linked}`, [sha256(token), db.ts(Date.now())]);
  return toUser(row);
}

// Attaches req.user if a valid session token is present.
function attachUser(req, _res, next) {
  req.token = (req.get('authorization') || '').slice(7) || null;
  req.market = ['SG', 'MY', 'TH', 'HK'].includes(req.get('x-market')) ? req.get('x-market') : 'SG';
  currentUser(req).then((user) => { req.user = user; next(); }, next);
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in to continue.' });
  next();
}

function requireStaff(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in to continue.' });
  if (!['staff', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Staff access only.' });
  next();
}

function securityHeaders(_req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'",
  });
  next();
}

// CORS for a frontend hosted on another origin (e.g. S3/CloudFront). CORS_ORIGINS is a
// comma-separated allowlist; unset means same-origin only.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
function cors(req, res, next) {
  const origin = req.get('origin');
  if (origin && (CORS_ORIGINS.includes(origin) || CORS_ORIGINS.includes('*'))) {
    res.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'authorization,content-type,x-market,idempotency-key',
      'Access-Control-Expose-Headers': 'content-disposition',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
}

// Simple fixed-window rate limiter keyed by IP (stand-in for AWS WAF rate-based rules).
function rateLimit({ windowMs, max, name }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || now - rec.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return next();
    }
    rec.count += 1;
    if (rec.count > max) {
      res.set('Retry-After', Math.ceil((rec.start + windowMs - now) / 1000));
      return res.status(429).json({ error: 'Too many requests, please slow down.' });
    }
    next();
  };
}

function publicUser(u) {
  if (!u) return null;
  const { passwordHash, cognitoSub, ...rest } = u;
  return { ...rest, hasPassword: !!passwordHash };
}

module.exports = {
  hashPassword, verifyPassword, sha256, toUser, getUser, findUserByEmail, insertUser, createSession, destroySession,
  attachUser, requireAuth, requireStaff, securityHeaders, cors, rateLimit, publicUser,
};
