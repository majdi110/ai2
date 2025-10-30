// handlers/shared.js
'use strict';
const { CANONICAL_BRANCH } = require('../config/constants');

function enforceCanonicalBranch(branch) {
  // accept undefined or the canonical branch only
  return !branch || String(branch) === CANONICAL_BRANCH;
}

// No-op idempotency gate for now. Return null to indicate "no conflict".
function checkIdempotencyOr409(_req, _res) {
  return null;
}

module.exports = { enforceCanonicalBranch, checkIdempotencyOr409 };
