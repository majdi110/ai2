// services/combinedDiffInput.js
'use strict';

const {
  normalizeDiff,
  looksBinaryDiff,
  stepPathsUnderRepo,
  buildCombinedDiffFromSteps
} = require('../utils/diff');

// Same header fix you had in handlers/diffs.js
function sanitizeHeaders(diff) {
  return String(diff)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/^(\+\+\+|---)b\//mg, '$1 b/'); // "+++ b/..." / "--- b/..."
}

/**
 * Canonical combined-diff extraction and validation.
 *
 * Accepts body like:
 *   - { plan: { steps[], combined_diff? }, ... }
 *   - { combined_diff: "..." }
 *   - { diff: "..." }               // legacy/compat
 *
 * Returns:
 *   { ok: true, diff }
 * or
 *   { ok: false, code, error }
 */
function extractCombinedDiffFromBody(body, prefixes) {
  if (!body || typeof body !== 'object') {
    return { ok: false, code: 400, error: 'missing_body' };
  }

  const hasPlan      = body.plan && typeof body.plan === 'object';
  const hasCombined  = typeof body.combined_diff === 'string';
  const hasDiffField = typeof body.diff === 'string';

  let raw;

  if (hasPlan) {
    const plan = body.plan;
    if (typeof plan.combined_diff === 'string' && plan.combined_diff.trim()) {
      raw = plan.combined_diff;
    } else if (Array.isArray(plan.steps)) {
      const combined = buildCombinedDiffFromSteps(plan.steps);
      if (!combined || !combined.trim()) {
        return { ok: false, code: 400, error: 'plan_has_no_diff' };
      }
      raw = combined;
    } else {
      return { ok: false, code: 400, error: 'plan_missing_steps' };
    }
  } else if (hasCombined) {
    raw = body.combined_diff;
  } else if (hasDiffField) {
    // Backwards compatible with your current API
    raw = body.diff;
  } else {
    return { ok: false, code: 400, error: 'missing_diff' };
  }

  let diff = sanitizeHeaders(raw);
  diff = normalizeDiff(diff);

  if (!diff || !diff.trim()) {
    return { ok: false, code: 400, error: 'empty_diff' };
  }

  if (looksBinaryDiff(diff)) {
    return { ok: false, code: 400, error: 'binary_diff_not_allowed' };
  }

  const pathsOk = stepPathsUnderRepo(diff, prefixes);
  if (!pathsOk.ok) {
    return {
      ok: false,
      code: 400,
      error: `diff_paths_invalid:${pathsOk.error || 'unknown'}`
    };
  }

  return { ok: true, diff };
}

module.exports = { extractCombinedDiffFromBody };
