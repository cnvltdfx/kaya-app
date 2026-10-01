// Password hashing, session tokens, auth middleware, security headers and rate limiting.
// In AWS: Cognito (auth + MFA), WAF rate-based rules (bot mitigation), Secrets Manager (secrets).
const crypto = require('crypto');
const { table, id } = require('./db');

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

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  table('sessions').insert({ id: id('ses'), token, userId, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function destroySession(token) {
  table('sessions').remove((s) => s.token === token);
}

function currentUser(req) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  const ses = table('sessions').find((s) => s.token === token);
  if (!ses || ses.expiresAt < Date.now()) return null;
  return table('users').get(ses.userId) || null;
}

// Attaches req.user if a valid session token is present.
function attachUser(req, _res, next) {
  req.user = currentUser(req);
  req.token = (req.get('authorization') || '').slice(7) || null;
  req.market = ['SG', 'MY', 'TH', 'HK'].includes(req.get('x-market')) ? req.get('x-market') : 'SG';
  next();
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
  const { passwordHash, ...rest } = u;
  return { ...rest, hasPassword: !!passwordHash };
}

module.exports = {
  hashPassword, verifyPassword, createSession, destroySession,
  attachUser, requireAuth, requireStaff, securityHeaders, rateLimit, publicUser,
};
