'use strict';

/**
 * BeloCloud Actions Connector (CommonJS)
 * --------------------------------------
 * Connects securely to the BeloCloud mini-server API (`/ai2/diff_dryrun`, `/ai2/diff_submit`).
 * Uses ACTION_TOKEN from environment for authenticated submissions.
 *
 * Usage:
 *   const { dryRun, submitDiff, makeNewFilePatch } = require('./connector.js');
 *
 *   // Example:
 *   const patch = makeNewFilePatch('public/test.txt', 'Hello world!');
 *   dryRun(patch).then(console.log);
 */

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const crypto = require('crypto');

// ----- config -----
const BELOCLOUD_API = 'https://datav.belocloud.com/ai2';
const ACTION_TOKEN = process.env.ACTION_TOKEN || '';

if (!ACTION_TOKEN) {
  console.warn('[connector] ⚠️  ACTION_TOKEN not set — dry-run will work, submit will fail.');
}

// ----- helpers -----
function normalizeDiff(diffText) {
  let t = String(diffText).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!t.endsWith('\n')) t += '\n';
  return t;
}

function looksLikeUnifiedDiff(t) {
  return (
    /^diff --git a\/.+ b\/.+\n/.test(t) &&
    /^(--- |\+\+\+ )/m.test(t) &&
    /^@@ /m.test(t)
  );
}

function toBase64Clean(s) {
  const b64 = Buffer.from(s, 'utf8').toString('base64');
  if (!/^[A-Za-z0-9+/=]+$/.test(b64) || (b64.length % 4 !== 0)) {
    throw new Error('Base64 validation failed');
  }
  return b64;
}

// ----- API calls -----
async function dryRun(diffText) {
  const diff = normalizeDiff(diffText);
  if (!looksLikeUnifiedDiff(diff)) throw new Error('Invalid unified diff format');

  const diff_b64 = toBase64Clean(diff);
  const body = { base_branch: 'main', diff_b64 };

  const res = await fetch(`${BELOCLOUD_API}/diff_dryrun`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Dry-run failed: ${data.error || res.statusText}`);
  console.log('[dryRun] ✅', data);
  return data;
}

async function submitDiff({ diffText, message, idemKey }) {
  const diff = normalizeDiff(diffText);
  if (!looksLikeUnifiedDiff(diff)) throw new Error('Invalid unified diff format');

  const diff_b64 = toBase64Clean(diff);
  const idem = idemKey || `id-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

  const payload = {
    base_branch: 'main',
    message: message || `Automated change ${new Date().toISOString()}`,
    diff_b64,
    idempotency_key: idem
  };

  const res = await fetch(`${BELOCLOUD_API}/diff_submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': ACTION_TOKEN,
      'X-Idempotency-Key': idem
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Submit failed: ${data.error || res.statusText}`);
  console.log('[submitDiff] ✅', data);
  return data;
}

// ----- diff generator -----
function makeNewFilePatch(repoPath, fileText) {
  const lf = String(fileText).replace(/\r\n?/g, '\n');
  const lines = lf.endsWith('\n') ? lf.slice(0, -1).split('\n') : lf.split('\n');

  const header = [
    `diff --git a/${repoPath} b/${repoPath}`,
    `new file mode 100644`,
    `--- /dev/null`,
    `+++ b/${repoPath}`,
    `@@ -0,0 +${lines.length} @@`
  ];

  const body = lines.map(l => '+' + l);
  return header.concat(body).join('\n') + '\n';
}

console.log('[connector] ✅ Initialized: BeloCloud connector ready.');

module.exports = { dryRun, submitDiff, makeNewFilePatch };
