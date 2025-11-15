// services/idempotencyStore.js
'use strict';

const crypto = require('crypto');

// Default: 15 minutes
const TTL_MS = parseInt(process.env.IDEMP_TTL_MS || '900000', 10);

// key => { status: 'pending' | 'done', statusCode, body, createdAt, expiresAt }
const records = new Map();

function makeKey(principalId, idemKey) {
  const base = String(principalId || 'anon') + ':' + String(idemKey);
  return crypto.createHash('sha256').update(base, 'utf8').digest('hex');
}

function isExpired(rec) {
  return rec.expiresAt && rec.expiresAt < Date.now();
}

function get(principalId, idemKey) {
  if (!idemKey) return null;
  const k = makeKey(principalId, idemKey);
  const rec = records.get(k);
  if (!rec) return null;
  if (isExpired(rec)) {
    records.delete(k);
    return null;
  }
  return { key: k, record: rec };
}

function markPending(principalId, idemKey) {
  if (!idemKey) return null;
  const k = makeKey(principalId, idemKey);
  const now = Date.now();
  const existing = records.get(k);
  if (existing && !isExpired(existing)) {
    return { key: k, record: existing, existed: true };
  }
  const rec = {
    status: 'pending',
    createdAt: now,
    expiresAt: now + TTL_MS
  };
  records.set(k, rec);
  return { key: k, record: rec, existed: false };
}

function storeResult(principalId, idemKey, statusCode, body) {
  if (!idemKey) return;
  const k = makeKey(principalId, idemKey);
  const now = Date.now();
  const rec = {
    status: 'done',
    statusCode,
    body,
    createdAt: now,
    expiresAt: now + TTL_MS
  };
  records.set(k, rec);
}

// Optional: slow background cleanup (belt + suspenders)
setInterval(() => {
  const now = Date.now();
  for (const [k, rec] of records.entries()) {
    if (rec.expiresAt && rec.expiresAt < now) {
      records.delete(k);
    }
  }
}, TTL_MS).unref();

module.exports = { get, markPending, storeResult };
