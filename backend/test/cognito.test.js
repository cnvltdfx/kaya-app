// Cognito sign-in tests: `npm test`. Needs MySQL, like api.test.js. A local server stands in for Cognito's
// token endpoint, and ID tokens are signed with a test key loaded into the verifier.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const POOL_ID = 'ap-southeast-1_testpool';
const CLIENT_ID = 'test-client';
const REDIRECT_URI = 'https://kaya.test/';
const TOKEN_PORT = 3461;

process.env.DB_NAME = process.env.TEST_DB_NAME || 'kaya_test';
process.env.LOG_SILENT = '1';
process.env.REPORTS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-test-'));
process.env.PORT = '3459';
process.env.REPORTS_PORT = '3460';
process.env.COGNITO_USER_POOL_ID = POOL_ID;
process.env.COGNITO_CLIENT_ID = CLIENT_ID;
process.env.COGNITO_DOMAIN = `http://localhost:${TOKEN_PORT}`;
process.env.COGNITO_REDIRECT_URI = REDIRECT_URI;

const BASE = 'http://localhost:3459';
const KID = 'test-key';
const signingKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const issued = new Map(); // authorization code -> ID token
let lastTokenRequest;
let server;
let reportServer;
let tokenServer;
let db;
let sec;

const b64url = (v) => Buffer.from(v).toString('base64url');

function idToken(claims, { key = signingKey.privateKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: crypto.randomUUID(), token_use: 'id', aud: CLIENT_ID, iss: `https://cognito-idp.ap-southeast-1.amazonaws.com/${POOL_ID}`,
    email_verified: true, name: 'Test User', iat: now, auth_time: now, exp: now + 3600, ...claims,
  };
  const body = `${b64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}`;
  return `${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
}

async function call(method, url, { body, token } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-market': 'SG', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

function signIn(token) {
  const code = crypto.randomUUID();
  issued.set(code, token);
  return call('POST', '/api/auth/cognito', { body: { code, codeVerifier: 'verifier-123' } });
}

before(async () => {
  tokenServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      lastTokenRequest = { path: req.url, form: new URLSearchParams(raw) };
      const token = issued.get(lastTokenRequest.form.get('code'));
      issued.delete(lastTokenRequest.form.get('code'));
      res.writeHead(token ? 200 : 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(token ? { id_token: token } : { error: 'invalid_grant' }));
    });
  }).listen(TOKEN_PORT);
  db = require('../src/lib/db');
  sec = require('../src/lib/security');
  await db.reset();
  ({ server, reportServer } = await require('../server').ready);
  require('../src/lib/cognito').verifier.cacheJwks({ keys: [{ ...signingKey.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] });
});
after(async () => {
  server.close();
  reportServer.close();
  tokenServer.close();
  await db.close();
});

test('first sign-in creates a customer and returns a working session', async () => {
  const sub = crypto.randomUUID();
  const r = await signIn(idToken({ sub, email: 'New.Shopper@Example.com', name: 'New Shopper' }));
  assert.equal(r.status, 200);
  assert.equal(r.data.user.email, 'new.shopper@example.com');
  assert.equal(r.data.user.role, 'customer');
  assert.equal(r.data.user.cognitoSub, undefined);

  assert.equal(lastTokenRequest.path, '/oauth2/token');
  assert.equal(lastTokenRequest.form.get('code_verifier'), 'verifier-123');
  assert.equal(lastTokenRequest.form.get('redirect_uri'), REDIRECT_URI);
  assert.equal(lastTokenRequest.form.get('client_id'), CLIENT_ID);

  const me = await call('GET', '/api/auth/me', { token: r.data.token });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.name, 'New Shopper');
  const row = await db.one('SELECT cognito_sub FROM users WHERE email = ?', ['new.shopper@example.com']);
  assert.equal(row.cognitoSub, sub);
});

test('signing in again reuses the row and keeps a name edited in Kaya', async () => {
  const sub = crypto.randomUUID();
  const first = await signIn(idToken({ sub, email: 'repeat@example.com', name: 'Original' }));
  await call('PUT', '/api/auth/me', { token: first.data.token, body: { name: 'Edited' } });
  const second = await signIn(idToken({ sub, email: 'repeat@example.com', name: 'Original' }));
  assert.equal(second.data.user.id, first.data.user.id);
  assert.equal(second.data.user.name, 'Edited');
});

test('rejects bad tokens and codes', async () => {
  const email = 'rejected@example.com';
  const cases = [
    idToken({ email }, { key: otherKey.privateKey }),
    idToken({ email, aud: 'another-client' }),
    idToken({ email, iss: 'https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_other' }),
    idToken({ email, token_use: 'access' }),
    idToken({ email, exp: Math.floor(Date.now() / 1000) - 60 }),
    idToken({ email, email_verified: false }),
  ];
  for (const token of cases) assert.equal((await signIn(token)).status, 401);
  const unknownCode = await call('POST', '/api/auth/cognito', { body: { code: 'never-issued', codeVerifier: 'x' } });
  assert.equal(unknownCode.status, 401);
  const missing = await call('POST', '/api/auth/cognito', { body: {} });
  assert.equal(missing.status, 400);
  assert.equal(await db.one('SELECT id FROM users WHERE email = ?', [email]), null);
});

test('role follows Cognito groups at each login', async () => {
  const sub = crypto.randomUUID();
  const email = 'worker@example.com';
  const staff = await signIn(idToken({ sub, email, 'cognito:groups': ['staff'] }));
  assert.equal(staff.data.user.role, 'staff');
  assert.equal((await call('GET', '/api/admin/dashboard', { token: staff.data.token })).status, 200);

  const admin = await signIn(idToken({ sub, email, 'cognito:groups': ['staff', 'admin'] }));
  assert.equal(admin.data.user.role, 'admin');

  const removed = await signIn(idToken({ sub, email }));
  assert.equal(removed.data.user.role, 'customer');
  assert.equal((await call('GET', '/api/admin/dashboard', { token: removed.data.token })).status, 403);
});

test('a matching email retires the old account instead of linking it', async () => {
  const old = await sec.findUserByEmail('admin@koolkaya.sg');
  const r = await signIn(idToken({ email: 'admin@koolkaya.sg' }));
  assert.equal(r.status, 200);
  assert.notEqual(r.data.user.id, old.id);
  assert.equal(r.data.user.role, 'customer', 'an email match must not inherit the old role');
  const retired = await sec.getUser(old.id);
  assert.equal(retired.email, `legacy-${old.id}@invalid`);
  assert.equal(retired.passwordHash, null);
  assert.equal(retired.role, 'customer');
});

test('sessions from before Cognito stop working', async () => {
  const demo = await sec.findUserByEmail('demo@koolkaya.sg');
  const token = await sec.createSession(demo.id);
  assert.equal((await call('GET', '/api/auth/me', { token })).status, 401);
});

test('email + password routes and demo SSO are gone', async () => {
  for (const route of ['register', 'login', 'mfa', 'sso', 'forgot', 'reset']) {
    const r = await call('POST', `/api/auth/${route}`, { body: { email: 'demo@koolkaya.sg', password: 'Demo@1234', provider: 'google' } });
    assert.equal(r.status, 404, route);
  }
  const { data } = await signIn(idToken({ email: 'pw@example.com' }));
  assert.equal((await call('POST', '/api/auth/password', { token: data.token, body: { password: 'NewPassw0rd' } })).status, 404);
});

test('profile email and MFA are not editable', async () => {
  const { data } = await signIn(idToken({ email: 'locked@example.com' }));
  const changed = await call('PUT', '/api/auth/me', { token: data.token, body: { email: 'other@example.com' } });
  assert.equal(changed.status, 400);
  const same = await call('PUT', '/api/auth/me', { token: data.token, body: { email: 'locked@example.com', phone: '+65 1234' } });
  assert.equal(same.status, 200);
  const mfa = await call('PUT', '/api/auth/me', { token: data.token, body: { mfaEnabled: true } });
  assert.equal(mfa.data.user.mfaEnabled, 0);
});

test('production without Cognito config has no local sign-in', () => {
  const env = { ...process.env, NODE_ENV: 'production' };
  for (const k of ['COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID', 'COGNITO_DOMAIN', 'COGNITO_REDIRECT_URI']) delete env[k];
  const out = execFileSync(process.execPath, ['-e', "const c = require('./src/lib/cognito'); console.log(JSON.stringify({ enabled: c.enabled, localAuth: c.localAuth }))"], { env, cwd: path.join(__dirname, '..') });
  assert.deepEqual(JSON.parse(out), { enabled: false, localAuth: false });
});
