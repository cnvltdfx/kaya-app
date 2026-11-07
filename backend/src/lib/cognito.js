// Amazon Cognito sign-in: swaps the authorization code from Managed Login for tokens and verifies the
// ID token. Kaya issues its own session afterwards, so API requests never carry Cognito tokens.
const { CognitoJwtVerifier } = require('aws-jwt-verify');

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const DOMAIN = (process.env.COGNITO_DOMAIN || '').replace(/\/+$/, '');
const REDIRECT_URI = process.env.COGNITO_REDIRECT_URI;

const enabled = !!(USER_POOL_ID && CLIENT_ID && DOMAIN && REDIRECT_URI);
// Email + password routes exist only for local dev and tests. Production without Cognito config has
// no way to sign in, rather than falling back to them.
const localAuth = !enabled && process.env.NODE_ENV !== 'production';

const verifier = enabled ? CognitoJwtVerifier.create({ userPoolId: USER_POOL_ID, clientId: CLIENT_ID, tokenUse: 'id' }) : null;

// Returns the verified ID token claims. Throws if the code is rejected or the token isn't valid.
async function exchangeCode(code, codeVerifier) {
  const res = await fetch(`${DOMAIN}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT_ID, code, code_verifier: codeVerifier, redirect_uri: REDIRECT_URI }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Token endpoint returned ${res.status}.`);
  const { id_token: idToken } = await res.json();
  const claims = await verifier.verify(idToken);
  if (claims.email_verified !== true) throw new Error('Email is not verified.');
  return claims;
}

// Highest role among the user's Cognito groups; no group means customer.
function roleFromClaims(claims) {
  const groups = claims['cognito:groups'] || [];
  if (groups.includes('admin')) return 'admin';
  if (groups.includes('staff')) return 'staff';
  return 'customer';
}

module.exports = { enabled, localAuth, verifier, exchangeCode, roleFromClaims };
