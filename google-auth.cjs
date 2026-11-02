'use strict';

// Google ID token verification using the official library. We never trust a
// decoded JWT payload without signature/audience/issuer/expiry verification.

let cachedLibrary = null;

function library() {
  if (!cachedLibrary) {
    // Loaded lazily so name/password login works without the dependency.
    cachedLibrary = require('google-auth-library');
  }
  return cachedLibrary;
}

async function verifyCredential(clientId, credential, expectedNonce) {
  if (!clientId) throw new Error('Google login is not configured.');
  if (typeof credential !== 'string' || credential.length > 8192) {
    throw new Error('Missing Google credential.');
  }
  const { OAuth2Client } = library();
  const client = new OAuth2Client(clientId);
  const ticket = await client.verifyIdToken({
    idToken: credential,
    audience: clientId,
  });
  const payload = ticket.getPayload();
  if (!payload || !payload.sub) throw new Error('Invalid Google token payload.');
  if (payload.email_verified !== true) throw new Error('Google email is not verified.');
  if (expectedNonce && payload.nonce !== expectedNonce) {
    throw new Error('Google login challenge did not match.');
  }
  return payload;
}

module.exports = { verifyCredential };
