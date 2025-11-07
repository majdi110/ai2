// services/plannerFallback.js
'use strict';

/**
 * Very conservative rule-based fallback planner.
 * - Only supports trivial "create a small text file" style requests.
 * - Never deletes or modifies outside the 'public/' subtree.
 * - Produces a single unified diff "create" patch when a simple pattern matches.
 *
 * Pattern recognized (case-insensitive):
 *   "create <relative/path> with <single-line text>"
 *
 * Examples:
 *   "create notes/hello.txt with Hello world"
 *   "create app/readme.md with Initial README"
 *
 * If the pattern doesn't match, returns a minimal empty plan (no steps),
 * allowing callers to decide how to proceed.
 *
 * @param {Object} params
 * @param {string} params.prompt   - Natural language user prompt.
 * @param {string} [params.repoRoot='public'] - Repo root path prefix to constrain writes.
 * @returns {Object} plan
 */
function buildFallbackPlan({ prompt, repoRoot = 'public' } = {}) {
  const p = String(prompt || '');
  const m = /create\s+([A-Za-z0-9_\-./]+)\s+with\s+(.+)/i.exec(p);
  if (!m) {
    // Return a valid minimal plan with no steps so callers can still proceed safely.
    return {
      schema: 1,
      id: 'fallback-plan-empty',
      status: 'planned',
      goal: `Fallback (no-op): ${p.slice(0, 200)}`,
      constraints: {
        base_branch: 'public',
        allowed_ops: ['create'],
        root_dir: repoRoot
      },
      steps: [],
      combined_diff: '',
      artifacts: null,
      telemetry: { source: 'fallback', reason: 'no_match' }
    };
  }

  const rel = m[1].replace(/^\//, '');     // strip any leading slash
  const text = m[2].trim();
  const gitPath = `${repoRoot}/${rel}`;    // keep within 'public' (or provided repoRoot)

  const diff = [
    `diff --git a/${gitPath} b/${gitPath}`,
    `new file mode 100644`,
    `index 0000000..e69de29`,
    `--- /dev/null`,
    `+++ b/${gitPath}`,
    `@@ -0,0 +1,1 @@`,
    `+${text}`
  ].join('\n');

  return {
    schema: 1,
    id: 'fallback-plan',
    status: 'planned',
    goal: `Fallback: ${p.slice(0, 200)}`,
    constraints: {
      base_branch: 'public',
      allowed_ops: ['create'],
      root_dir: repoRoot
    },
    steps: [{
      type: 'patch',
      op: 'create',
      base_branch: 'public',
      message: `Fallback create ${gitPath}`,
      diff
    }],
    combined_diff: diff,
    artifacts: null,
    telemetry: { source: 'fallback', matched: true }
  };
}

/**
 * Backward-compatible export used by callers expecting `fallbackPlan`.
 * Delegates to buildFallbackPlan.
 */
function fallbackPlan(args) {
  return buildFallbackPlan(args);
}

module.exports = { buildFallbackPlan, fallbackPlan };
