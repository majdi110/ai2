// services/plannerFallback.js
'use strict';

const { CANONICAL_BRANCH, REPO_ROOT } = require('../config/constants');

/**
 * Very conservative rule-based fallback planner.
 *
 * Behavior:
 * - Only supports trivial "create a small text file" style requests.
 * - Never plans anything outside the "public/" subtree (or a custom prefix).
 * - Produces at most a single unified diff "create" patch.
 *
 * Pattern recognized (case-insensitive):
 *   "create <relative/path> with <single-line text>"
 *
 * Examples:
 *   "create notes/hello.txt with Hello world"
 *   "create app/readme.md with Initial README"
 *
 * If the pattern doesn't match, returns a valid minimal plan (no steps),
 * so callers still get a schema-compliant object.
 *
 * @param {Object} params
 * @param {string} params.prompt   - Natural language user prompt.
 * @param {string} [params.repoRoot='public'] - Path prefix inside the repo
 *                                             (e.g. "public" or "public/users/u1").
 * @returns {Object} plan
 */
function buildFallbackPlan({ prompt, repoRoot = 'public' } = {}) {
  const p = String(prompt || '');
  const trimmed = p.trim();

  // Simple pattern: "create <relative/path> with <single-line text>"
  const m = /create\s+([A-Za-z0-9_\-./]+)\s+with\s+(.+)/i.exec(trimmed);

  // No match → return a valid, no-op plan with no steps.
  if (!m) {
    return {
      schema: 1,
      id: makeFallbackId('empty'),
      status: 'planned',
      goal: `Fallback (no-op): ${trimmed.slice(0, 200)}`,
      constraints: {
        base_branch: CANONICAL_BRANCH,
        allowed_ops: ['create'],
        root_dir: REPO_ROOT
      },
      steps: [],
      combined_diff: '',
      artifacts: null,
      telemetry: { source: 'fallback', reason: 'no_match' }
    };
  }

  const relRaw = m[1] || '';
  const text = (m[2] || '').trim();

  // Normalize the relative path: strip a leading slash if present.
  const rel = relRaw.replace(/^\//, '');

  // Construct path relative to the repo root. This will later be validated
  // against ALLOWED_PATH_PREFIXES by the diff/path guards.
  const gitPath = `${repoRoot}/${rel}`;

  const diffLines = [
    `diff --git a/${gitPath} b/${gitPath}`,
    'new file mode 100644',
    'index 0000000..e69de29',
    '--- /dev/null',
    `+++ b/${gitPath}`,
    '@@ -0,0 +1,1 @@',
    `+${text}`
  ];

  const diff = diffLines.join('\n');

  return {
    schema: 1,
    id: makeFallbackId('create'),
    status: 'planned',
    goal: `Fallback: ${trimmed.slice(0, 200)}`,
    constraints: {
      base_branch: CANONICAL_BRANCH,
      allowed_ops: ['create'],
      root_dir: REPO_ROOT
    },
    steps: [{
      type: 'patch',
      op: 'create',
      base_branch: CANONICAL_BRANCH,
      message: `Fallback create ${gitPath}`,
      diff
    }],
    combined_diff: diff,
    artifacts: null,
    telemetry: { source: 'fallback', matched: true }
  };
}

/**
 * Generate a simple unique-ish fallback plan id so artifact directories
 * don't collide when multiple fallback plans are created.
 */
function makeFallbackId(kind) {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `fallback-${kind}-${ts}-${rand}`;
}

/**
 * Backward-compatible export used by callers expecting `fallbackPlan`.
 */
function fallbackPlan(args) {
  return buildFallbackPlan(args);
}

module.exports = { buildFallbackPlan, fallbackPlan };
