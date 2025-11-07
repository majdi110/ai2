// utils/auth.js
'use strict';

/**
 * Map scopes to allowed repo/path prefixes.
 * Tighten this mapping per scope/policy as needed.
 * Example policy: any scoped token can operate under `public/`.
 */
function prefixesFromScopes(scopes) {
  return Array.isArray(scopes) && scopes.length ? ['public/'] : [];
}

/**
 * Bridge router auth → legacy helpers.
 *
 * The router (router.js) validates the Bearer token and attaches:
 *   req.principal = { id: <token id>, scopes: [ ... ] }
 *
 * Here we trust that and expose a legacy-shaped authCtx so existing
 * handlers calling authCtx(req) continue to work unchanged.
 *
 * If you still need legacy header/cookie parsing, add it AFTER
 * the req.principal branch below (currently disabled by design).
 */
function authCtx(req) {
  if (req && req.principal) {
    return {
      ok: true,
      id: req.principal.id,
      scopes: Array.isArray(req.principal.scopes) ? req.principal.scopes : [],
      allowedPrefixes: prefixesFromScopes(req.principal.scopes || [])
    };
  }
  // Legacy fallback disabled: unauthenticated by default.
  return { ok: false };
}

/**
 * Helper used across handlers to read allowed path prefixes
 * from an authCtx-shaped object.
 */
function allowedPrefixesFromAuth(auth) {
  return (auth && auth.ok && Array.isArray(auth.allowedPrefixes))
    ? auth.allowedPrefixes
    : [];
}

module.exports = { authCtx, allowedPrefixesFromAuth };
