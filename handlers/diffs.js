// handlers/diffs.js
'use strict';

const { sendJSON, readBodyLimited, wrap } = require('../utils/http');
const { MAX_DIFF_BYTES, CANONICAL_BRANCH } = require('../config/constants');
const { gitDryRun } = require('../services/git');
const { enqueuePatchJob } = require('../services/queue');
const {
  normalizeDiff,
  looksBinaryDiff,
  stepPathsUnderRepo,
  inferStepOpFromDiff,
} = require('../utils/diff');

function parseJSONSafe(buf) { try { return JSON.parse(String(buf || '{}')); } catch { return null; } }

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

  let body;
  try { body = await readJsonLimited(req, MAX_DIFF_BYTES); }
  catch (e) { return sendJSON(res, e.code === 413 ? 413 : 400, { ok:false, error:String(e.code||'bad_request') }); }

  const diff = sanitizeDiff((body && body.diff) || '');
  if (!diff || typeof diff !== 'string') return sendJSON(res, 400, { ok:false, error:'missing_diff' });
  if (Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES) return sendJSON(res, 413, { ok:false, error:'payload_too_large' });
  if (looksBinaryDiff(diff)) return sendJSON(res, 400, { ok:false, error:'binary_diff_not_allowed' });

  const pathsOk = stepPathsUnderRepo(diff);
  if (!pathsOk.ok) return sendJSON(res, 400, { ok:false, error:`diff_paths_invalid:${pathsOk.error}` });

  const branch = String(body.base_branch || CANONICAL_BRANCH);
  const r = await gitDryRun(diff, branch);
  if (!r.ok) return sendJSON(res, 400, { ok:false, error:r.error, detail:r.detail });

  return sendJSON(res, 200, { ok:true });
}

async function handleDiffSubmit(req, res) {
  wrap(res, 'diff_submit');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }

  let body;
  try { body = await readJsonLimited(req, MAX_DIFF_BYTES); }
  catch (e) { return sendJSON(res, e.code === 413 ? 413 : 400, { ok:false, error:String(e.code||'bad_request') }); }

  let diff = sanitizeDiff((body && body.diff) || '');
  if (!diff) return sendJSON(res, 400, { ok:false, error:'missing_diff' });
  if (Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES) return sendJSON(res, 413, { ok:false, error:'payload_too_large' });
  if (looksBinaryDiff(diff)) return sendJSON(res, 400, { ok:false, error:'binary_diff_not_allowed' });

  const pathsOk = stepPathsUnderRepo(diff);
  if (!pathsOk.ok) return sendJSON(res, 400, { ok:false, error:`diff_paths_invalid:${pathsOk.error}` });

  const branch  = String(body.base_branch || CANONICAL_BRANCH);
  const message = String(body.message || 'Apply AI2 plan');
  const idemVal = String(body.idempotency_key || '');
  const reqInfo = { ip: req.socket && req.socket.remoteAddress || '' };

  // Optional: infer op (unused here, but may be helpful in logs)
  const op = inferStepOpFromDiff(diff);

  const q = enqueuePatchJob({ base: branch, message, diff, idemVal, reqInfo });
  return sendJSON(res, 200, { ok:true, enqueued: q, op });
}

module.exports = { handleDiffDryRun, handleDiffSubmit };
