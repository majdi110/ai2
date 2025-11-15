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
    // ensure "+++ b/..." / "--- b/..." have a space before b/
    .replace(/^(\+\+\+|---)b\//mg, '$1 b/');
    // NOTE: do NOT touch @@ hunk headers anymore; planner already emits valid ones
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

  // ----- 1) Fast-path: plan.combined_diff (already normalized by validateAndFinalizePlan) -----
  if (hasPlan) {
    const plan = body.plan;

    if (typeof plan.combined_diff === 'string' && plan.combined_diff.trim()) {
      const diff = String(plan.combined_diff);

      if (!diff.trim()) {
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

      // IMPORTANT: return early, without extra normalization
      return { ok: true, diff };
    }

    // No combined_diff, but we *do* have steps: build combined now
    if (Array.isArray(plan.steps)) {
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
    // Backwards compatible with legacy { diff: "..." } payloads
    raw = body.diff;
  } else {
    return { ok: false, code: 400, error: 'missing_diff' };
  }

  // ----- 2) Non-plan / legacy flows go through sanitize + normalize -----
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
