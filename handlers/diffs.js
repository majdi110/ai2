// handlers/diffs.js
'use strict';

const { sendJSON, readBodyLimited, wrap } = require('../utils/http');
const { MAX_DIFF_BYTES, CANONICAL_BRANCH } = require('../config/constants');
const { maybeBlockBrowserPost } = require('../utils/cors');
const { authCtx, allowedPrefixesFromAuth } = require('../utils/auth');
const { gitDryRun } = require('../services/git');
const { enqueuePatchJob } = require('../services/queue');
const {
  normalizeDiff, // kept for parity with existing utils import set
  looksBinaryDiff,
  stepPathsUnderRepo,
  inferStepOpFromDiff,
} = require('../utils/diff');

function parseJSONSafe(buf) {
  try { return JSON.parse(String(buf || '{}')); } catch { return null; }
}

// Small fixups on common planner spacing glitches
function sanitizeDiff(diff) {
  return String(diff)
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/^(\+\+\+|---)b\//mg, '$1 b/'); // ensure space: "+++ b/...", "--- b/..."
}

async function readJsonLimited(req, limit) {
  return await new Promise((resolve, reject) =>
    readBodyLimited(req, limit, (e, b) => e ? reject(e) : resolve(parseJSONSafe(b)))
  );
}

async function handleDiffDryRun(req, res) {
  wrap(res, 'diff_dryrun');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
  if (!maybeBlockBrowserPost(req, res)) return;

  // Require auth and use per-token allowed prefixes
  const auth = authCtx(req);
  if (!auth || !auth.ok) return sendJSON(res, 401, { ok:false, error:'unauthorized' });
  const prefixes = allowedPrefixesFromAuth(auth);

  let body;
  try { body = await readJsonLimited(req, MAX_DIFF_BYTES); }
  catch (e) { return sendJSON(res, e.code === 413 ? 413 : 400, { ok:false, error:String(e.code||'bad_request') }); }

  const diff = sanitizeDiff((body && body.diff) || '');
  if (!diff || typeof diff !== 'string') return sendJSON(res, 400, { ok:false, error:'missing_diff' });
  if (Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES) return sendJSON(res, 413, { ok:false, error:'payload_too_large' });
  if (looksBinaryDiff(diff)) return sendJSON(res, 400, { ok:false, error:'binary_diff_not_allowed' });

  const pathsOk = stepPathsUnderRepo(diff, prefixes);
  if (!pathsOk.ok) return sendJSON(res, 400, { ok:false, error:`diff_paths_invalid:${pathsOk.error}` });

  const branch = String(body.base_branch || CANONICAL_BRANCH);
  const r = await gitDryRun(diff, branch);
  if (!r.ok) return sendJSON(res, 400, { ok:false, error:r.error, detail:r.detail });

  return sendJSON(res, 200, { ok:true });
}

async function handleDiffSubmit(req, res) {
  wrap(res, 'diff_submit');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
  if (!maybeBlockBrowserPost(req, res)) return;

  // Require auth and use per-token allowed prefixes
  const auth = authCtx(req);
  if (!auth || !auth.ok) return sendJSON(res, 401, { ok:false, error:'unauthorized' });
  const prefixes = allowedPrefixesFromAuth(auth);

  let body;
  try { body = await readJsonLimited(req, MAX_DIFF_BYTES); }
  catch (e) { return sendJSON(res, e.code === 413 ? 413 : 400, { ok:false, error:String(e.code||'bad_request') }); }

  const diff = sanitizeDiff((body && body.diff) || '');
  if (!diff) return sendJSON(res, 400, { ok:false, error:'missing_diff' });
  if (Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES) return sendJSON(res, 413, { ok:false, error:'payload_too_large' });
  if (looksBinaryDiff(diff)) return sendJSON(res, 400, { ok:false, error:'binary_diff_not_allowed' });

  const pathsOk = stepPathsUnderRepo(diff, prefixes);
  if (!pathsOk.ok) return sendJSON(res, 400, { ok:false, error:`diff_paths_invalid:${pathsOk.error}` });

  const branch  = String(body.base_branch || CANONICAL_BRANCH);
  const message = String(body.message || 'Apply AI2 plan');
  const idemVal = String(body.idempotency_key || '');
  const reqInfo = { ip: (req.socket && req.socket.remoteAddress) || '' };

  // Server-side guard: repeat the dry-run; DO NOT enqueue on failure.
  const dry = await gitDryRun(diff, branch);
  if (!dry.ok) {
    let firstPath = null;
    const m = diff.match(/^\+\+\+ b\/([^\n]+)/m);
    if (m) firstPath = m[1];
    return sendJSON(res, 422, {
      ok: false,
      error: 'dry_run_failed',
      detail: dry.detail,
      first_path: firstPath,
      advice: firstPath ? `Re-plan as MODIFY for this path; no 'new file mode'.` : undefined
    });
  }

  // Optional: infer op (unused here, but may be helpful in logs)
  const op = inferStepOpFromDiff(diff);

  const q = enqueuePatchJob({ base: branch, message, diff, idemVal, reqInfo });
  return sendJSON(res, 200, { ok:true, enqueued: q, op });
}

module.exports = { handleDiffDryRun, handleDiffSubmit };
