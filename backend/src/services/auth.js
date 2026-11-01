// User service: registration, login (email + SSO), MFA, password reset, profile.
// In AWS this maps to Amazon Cognito user pools (hosted UI, social IdPs, MFA, password policy).
const crypto = require('crypto');
const { Router } = require('../lib/router');
const db = require('../lib/db');
const sec = require('../lib/security');
const { MARKETS, LANGUAGES } = require('../lib/markets');
const notifications = require('./notifications');
const { log } = require('../lib/observability');

const router = Router();
const DEV = process.env.NODE_ENV !== 'production';
const authLimiter = sec.rateLimit({ windowMs: 60_000, max: 20, name: 'auth' });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and numbers.';
  return null;
}

async function audit(userId, action, meta = {}) {
  await db.query('INSERT INTO audit_log (id, user_id, action, meta, at) VALUES (?, ?, ?, ?, ?)', [db.id('aud'), userId, action, db.json(meta), db.ts(Date.now())]);
}

async function issueSession(res, user) {
  const token = await sec.createSession(user.id);
  await db.query('UPDATE users SET last_login_at = ? WHERE id = ?', [db.ts(Date.now()), user.id]);
  await audit(user.id, 'login');
  res.json({ token, user: sec.publicUser(user) });
}

router.post('/register', authLimiter, async (req, res) => {
  const { name, email, password, market = 'SG', language } = req.body || {};
  const em = String(email || '').trim().toLowerCase();
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Please enter your name.' });
  if (!EMAIL_RE.test(em)) return res.status(400).json({ error: 'Please enter a valid email.' });
  const pwErr = passwordProblem(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (await sec.findUserByEmail(em)) return res.status(409).json({ error: 'An account with this email already exists.' });
  const mkt = MARKETS[market] ? market : 'SG';
  const user = await sec.insertUser({
    id: db.id('usr'), email: em, name: String(name).trim().slice(0, 80), role: 'customer',
    passwordHash: sec.hashPassword(password), market: mkt,
    language: LANGUAGES.includes(language) ? language : MARKETS[mkt].defaultLang,
    phone: '', address: { line1: '', line2: '', city: '', postcode: '', country: MARKETS[mkt].name },
    mfaEnabled: false, createdAt: Date.now(),
  });
  await notifications.send({ userId: user.id, to: user.email, subject: 'Welcome to Kool Kaya Kitchen!', body: `Hi ${user.name}, welcome! Use code WELCOME10 for 10% off your first order.`, kind: 'welcome' });
  await issueSession(res, user);
});

router.post('/login', authLimiter, async (req, res) => {
  const em = String(req.body?.email || '').trim().toLowerCase();
  const user = await sec.findUserByEmail(em);
  if (!user || !sec.verifyPassword(String(req.body?.password || ''), user.passwordHash)) {
    log('warn', 'auth.failed', { email: em.replace(/^(.{2}).*@/, '$1***@') });
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  // MFA applies to accounts that have it enabled. Staff and admin accounts are seeded with it off
  // for now: in production the code is only "emailed" (the outbox), so they couldn't sign in.
  if (user.mfaEnabled) {
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    const challengeId = db.id('mfa');
    await db.query('INSERT INTO mfa_challenges (id, user_id, code_hash, attempts, expires_at) VALUES (?, ?, ?, 0, ?)', [challengeId, user.id, sec.hashPassword(code), db.ts(Date.now() + 5 * 60_000)]);
    await notifications.send({ userId: user.id, to: user.email, subject: 'Your Kool Kaya sign-in code', body: `Your verification code is ${code}. It expires in 5 minutes.`, kind: 'mfa' });
    return res.json({ mfaRequired: true, challengeId, ...(DEV ? { devCode: code } : {}) });
  }
  await issueSession(res, user);
});

router.post('/mfa', authLimiter, async (req, res) => {
  const { challengeId, code } = req.body || {};
  const ch = await db.one('SELECT * FROM mfa_challenges WHERE id = ?', [String(challengeId || '')]);
  if (!ch || ch.expiresAt < Date.now() || ch.attempts >= 5) return res.status(401).json({ error: 'Code expired. Please sign in again.' });
  if (!sec.verifyPassword(String(code || ''), ch.codeHash)) {
    await db.query('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id = ?', [ch.id]);
    return res.status(401).json({ error: 'Incorrect code.' });
  }
  // Single use: only the request that deletes the challenge gets a session.
  const del = await db.query('DELETE FROM mfa_challenges WHERE id = ?', [ch.id]);
  if (!del.affectedRows) return res.status(401).json({ error: 'Code expired. Please sign in again.' });
  await issueSession(res, await sec.getUser(ch.userId));
});

// Demo SSO: in production this is a Cognito federated identity (Google / Apple) redirect flow.
router.post('/sso', authLimiter, async (req, res) => {
  const { provider, email, name } = req.body || {};
  if (!['google', 'apple'].includes(provider)) return res.status(400).json({ error: 'Unsupported provider.' });
  const em = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(em)) return res.status(400).json({ error: 'Please enter a valid email.' });
  let user = await sec.findUserByEmail(em);
  if (user && user.role !== 'customer') return res.status(403).json({ error: 'Staff must sign in with password + MFA.' });
  if (!user) {
    const mkt = req.market;
    user = await sec.insertUser({
      id: db.id('usr'), email: em, name: String(name || em.split('@')[0]).slice(0, 80), role: 'customer', passwordHash: null,
      ssoProvider: provider, market: mkt, language: MARKETS[mkt].defaultLang, phone: '',
      address: { line1: '', line2: '', city: '', postcode: '', country: MARKETS[mkt].name }, mfaEnabled: false, createdAt: Date.now(),
    });
  }
  await issueSession(res, user);
});

router.post('/forgot', authLimiter, async (req, res) => {
  const em = String(req.body?.email || '').trim().toLowerCase();
  const user = await sec.findUserByEmail(em);
  const out = { ok: true, message: 'If an account exists for that email, a reset link has been sent.' };
  if (user) {
    const token = crypto.randomBytes(20).toString('hex');
    await db.query('INSERT INTO reset_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)', [db.id('rst'), user.id, sec.sha256(token), db.ts(Date.now() + 30 * 60_000)]);
    await notifications.send({ userId: user.id, to: user.email, subject: 'Reset your Kool Kaya password', body: `Use this link to reset your password (valid 30 min): /#/reset?token=${token}`, kind: 'password_reset' });
    if (DEV) out.devToken = token;
  }
  res.json(out);
});

router.post('/reset', authLimiter, async (req, res) => {
  const { token, password } = req.body || {};
  const rec = await db.one('SELECT * FROM reset_tokens WHERE token_hash = ? AND expires_at > ?', [sec.sha256(token || ''), db.ts(Date.now())]);
  if (!rec) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
  const pwErr = passwordProblem(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  await db.tx(async (t) => {
    await t.query('UPDATE users SET password_hash = ? WHERE id = ?', [sec.hashPassword(password), rec.userId]);
    await t.query('DELETE FROM reset_tokens WHERE user_id = ?', [rec.userId]);
    await t.query('DELETE FROM sessions WHERE user_id = ?', [rec.userId]);
  });
  await audit(rec.userId, 'password_reset');
  res.json({ ok: true });
});

router.post('/logout', async (req, res) => {
  if (req.token) await sec.destroySession(req.token);
  res.json({ ok: true });
});

router.get('/me', sec.requireAuth, (req, res) => res.json({ user: sec.publicUser(req.user) }));

router.put('/me', sec.requireAuth, async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.name !== undefined) {
    if (!String(b.name).trim()) return res.status(400).json({ error: 'Name cannot be empty.' });
    patch.name = String(b.name).trim().slice(0, 80);
  }
  if (b.email !== undefined) {
    const em = String(b.email).trim().toLowerCase();
    if (!EMAIL_RE.test(em)) return res.status(400).json({ error: 'Please enter a valid email.' });
    const other = await sec.findUserByEmail(em);
    if (other && other.id !== req.user.id) return res.status(409).json({ error: 'That email is already in use.' });
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
  const { address, ...fields } = patch;
  const cols = Object.fromEntries(Object.entries(fields).map(([k, v]) => [db.snake(k), v]));
  if (address) for (const [k, v] of Object.entries(address)) cols[`address_${k}`] = v;
  if (Object.keys(cols).length) await db.query('UPDATE users SET ? WHERE id = ?', [cols, req.user.id]);
  await audit(req.user.id, 'profile_update', { fields: Object.keys(patch) });
  res.json({ user: sec.publicUser(await sec.getUser(req.user.id)) });
});

router.post('/password', sec.requireAuth, async (req, res) => {
  const { current, password } = req.body || {};
  if (req.user.passwordHash && !sec.verifyPassword(String(current || ''), req.user.passwordHash)) return res.status(400).json({ error: 'Current password is incorrect.' });
  const pwErr = passwordProblem(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [sec.hashPassword(password), req.user.id]);
  await audit(req.user.id, 'password_change');
  res.json({ ok: true });
});

router.get('/notifications', sec.requireAuth, async (req, res) => {
  const list = await db.query(`SELECT ${notifications.COLUMNS} FROM notifications WHERE user_id = ? AND kind <> 'mfa' ORDER BY created_at DESC LIMIT 50`, [req.user.id]);
  res.json({ notifications: list });
});

module.exports = router;
