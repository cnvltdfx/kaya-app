// User service: registration, login (email + SSO), MFA for staff/admin, password reset, profile.
// In AWS this maps to Amazon Cognito user pools (hosted UI, social IdPs, MFA, password policy).
const express = require('express');
const crypto = require('crypto');
const { table, id } = require('../lib/db');
const sec = require('../lib/security');
const { MARKETS, LANGUAGES } = require('../lib/markets');
const notifications = require('./notifications');
const { log } = require('../lib/observability');

const router = express.Router();
const DEV = process.env.NODE_ENV !== 'production';
const authLimiter = sec.rateLimit({ windowMs: 60_000, max: 20, name: 'auth' });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and numbers.';
  return null;
}

function audit(userId, action, meta = {}) {
  table('auditLog').insert({ id: id('aud'), userId, action, meta, at: Date.now() });
}

function issueSession(res, user) {
  const token = sec.createSession(user.id);
  table('users').update(user.id, { lastLoginAt: Date.now() });
  audit(user.id, 'login');
  res.json({ token, user: sec.publicUser(user) });
}

router.post('/register', authLimiter, (req, res) => {
  const { name, email, password, market = 'SG', language } = req.body || {};
  const em = String(email || '').trim().toLowerCase();
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Please enter your name.' });
  if (!EMAIL_RE.test(em)) return res.status(400).json({ error: 'Please enter a valid email.' });
  const pwErr = passwordProblem(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (table('users').find((u) => u.email === em)) return res.status(409).json({ error: 'An account with this email already exists.' });
  const mkt = MARKETS[market] ? market : 'SG';
  const user = table('users').insert({
    id: id('usr'), email: em, name: String(name).trim().slice(0, 80), role: 'customer',
    passwordHash: sec.hashPassword(password), market: mkt,
    language: LANGUAGES.includes(language) ? language : MARKETS[mkt].defaultLang,
    phone: '', address: { line1: '', line2: '', city: '', postcode: '', country: MARKETS[mkt].name },
    mfaEnabled: false, createdAt: Date.now(),
  });
  notifications.send({ userId: user.id, to: user.email, subject: 'Welcome to Kool Kaya Kitchen!', body: `Hi ${user.name}, welcome! Use code WELCOME10 for 10% off your first order.`, kind: 'welcome' });
  issueSession(res, user);
});

router.post('/login', authLimiter, (req, res) => {
  const em = String(req.body?.email || '').trim().toLowerCase();
  const user = table('users').find((u) => u.email === em);
  if (!user || !sec.verifyPassword(String(req.body?.password || ''), user.passwordHash)) {
    log('warn', 'auth.failed', { email: em.replace(/^(.{2}).*@/, '$1***@') });
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  // MFA is mandatory for staff and admins
  if (user.role !== 'customer' || user.mfaEnabled) {
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    const challenge = table('mfaChallenges').insert({ id: id('mfa'), userId: user.id, codeHash: sec.hashPassword(code), attempts: 0, expiresAt: Date.now() + 5 * 60_000 });
    notifications.send({ userId: user.id, to: user.email, subject: 'Your Kool Kaya sign-in code', body: `Your verification code is ${code}. It expires in 5 minutes.`, kind: 'mfa' });
    return res.json({ mfaRequired: true, challengeId: challenge.id, ...(DEV ? { devCode: code } : {}) });
  }
  issueSession(res, user);
});

router.post('/mfa', authLimiter, (req, res) => {
  const { challengeId, code } = req.body || {};
  const ch = table('mfaChallenges').get(challengeId);
  if (!ch || ch.expiresAt < Date.now() || ch.attempts >= 5) return res.status(401).json({ error: 'Code expired. Please sign in again.' });
  if (!sec.verifyPassword(String(code || ''), ch.codeHash)) {
    table('mfaChallenges').update(ch.id, { attempts: ch.attempts + 1 });
    return res.status(401).json({ error: 'Incorrect code.' });
  }
  table('mfaChallenges').remove((c) => c.id === ch.id);
  issueSession(res, table('users').get(ch.userId));
});

// Demo SSO: in production this is a Cognito federated identity (Google / Apple) redirect flow.
router.post('/sso', authLimiter, (req, res) => {
  const { provider, email, name } = req.body || {};
  if (!['google', 'apple'].includes(provider)) return res.status(400).json({ error: 'Unsupported provider.' });
  const em = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(em)) return res.status(400).json({ error: 'Please enter a valid email.' });
  let user = table('users').find((u) => u.email === em);
  if (user && user.role !== 'customer') return res.status(403).json({ error: 'Staff must sign in with password + MFA.' });
  if (!user) {
    const mkt = req.market;
    user = table('users').insert({
      id: id('usr'), email: em, name: String(name || em.split('@')[0]).slice(0, 80), role: 'customer', passwordHash: null,
      ssoProvider: provider, market: mkt, language: MARKETS[mkt].defaultLang, phone: '',
      address: { line1: '', line2: '', city: '', postcode: '', country: MARKETS[mkt].name }, mfaEnabled: false, createdAt: Date.now(),
    });
  }
  issueSession(res, user);
});

router.post('/forgot', authLimiter, (req, res) => {
  const em = String(req.body?.email || '').trim().toLowerCase();
  const user = table('users').find((u) => u.email === em);
  const out = { ok: true, message: 'If an account exists for that email, a reset link has been sent.' };
  if (user) {
    const token = crypto.randomBytes(20).toString('hex');
    table('resetTokens').insert({ id: id('rst'), userId: user.id, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 30 * 60_000 });
    notifications.send({ userId: user.id, to: user.email, subject: 'Reset your Kool Kaya password', body: `Use this link to reset your password (valid 30 min): /#/reset?token=${token}`, kind: 'password_reset' });
    if (DEV) out.devToken = token;
  }
  res.json(out);
});

router.post('/reset', authLimiter, (req, res) => {
  const { token, password } = req.body || {};
  const hash = crypto.createHash('sha256').update(String(token || '')).digest('hex');
  const rec = table('resetTokens').find((t) => t.tokenHash === hash && t.expiresAt > Date.now());
  if (!rec) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
  const pwErr = passwordProblem(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  table('users').update(rec.userId, { passwordHash: sec.hashPassword(password) });
  table('resetTokens').remove((t) => t.userId === rec.userId);
  table('sessions').remove((s) => s.userId === rec.userId);
  audit(rec.userId, 'password_reset');
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  if (req.token) sec.destroySession(req.token);
  res.json({ ok: true });
});

router.get('/me', sec.requireAuth, (req, res) => res.json({ user: sec.publicUser(req.user) }));

router.put('/me', sec.requireAuth, (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.name !== undefined) {
    if (!String(b.name).trim()) return res.status(400).json({ error: 'Name cannot be empty.' });
    patch.name = String(b.name).trim().slice(0, 80);
  }
  if (b.email !== undefined) {
    const em = String(b.email).trim().toLowerCase();
    if (!EMAIL_RE.test(em)) return res.status(400).json({ error: 'Please enter a valid email.' });
    if (table('users').find((u) => u.email === em && u.id !== req.user.id)) return res.status(409).json({ error: 'That email is already in use.' });
    patch.email = em;
  }
  if (b.phone !== undefined) patch.phone = String(b.phone).replace(/[^\d+\s-]/g, '').slice(0, 20);
  if (b.market !== undefined && MARKETS[b.market]) patch.market = b.market;
  if (b.language !== undefined && LANGUAGES.includes(b.language)) patch.language = b.language;
  if (b.address) {
    const a = b.address;
    patch.address = ['line1', 'line2', 'city', 'postcode', 'country'].reduce((o, k) => ({ ...o, [k]: String(a[k] || '').slice(0, 120) }), {});
  }
  if (b.mfaEnabled !== undefined && req.user.role === 'customer') patch.mfaEnabled = !!b.mfaEnabled;
  const user = table('users').update(req.user.id, patch);
  audit(req.user.id, 'profile_update', { fields: Object.keys(patch) });
  res.json({ user: sec.publicUser(user) });
});

router.post('/password', sec.requireAuth, (req, res) => {
  const { current, password } = req.body || {};
  if (req.user.passwordHash && !sec.verifyPassword(String(current || ''), req.user.passwordHash)) return res.status(400).json({ error: 'Current password is incorrect.' });
  const pwErr = passwordProblem(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  table('users').update(req.user.id, { passwordHash: sec.hashPassword(password) });
  audit(req.user.id, 'password_change');
  res.json({ ok: true });
});

router.get('/notifications', sec.requireAuth, (req, res) => {
  res.json({ notifications: table('notifications').filter((n) => n.userId === req.user.id && n.kind !== 'mfa').sort((a, b) => b.createdAt - a.createdAt).slice(0, 50) });
});

module.exports = router;
