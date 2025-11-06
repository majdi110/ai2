// handlers/plan.js
'use strict';

const { wrap, sendJSON, readBodyLimited } = require('../utils/http');
const { maybeBlockBrowserPost } = require('../utils/cors');
const { MAX_PLAN_BODY_BYTES, CANONICAL_BRANCH } = require('../config/constants');

const { injectContextIntoPrompt, planWithRetry } = require('../services/planner');
const { writePlanArtifacts } = require('../services/storage');

const {
  normalizeDiff,
  looksBinaryDiff,
  stepPathsUnderRepo,
  buildCombinedDiffFromSteps,
  inferStepOpFromDiff
} = require('../utils/diff');

const { authCtx, allowedPrefixesFromAuth } = require('../utils/auth');
const { rlCheck } = require('../utils/rl');

function parseJSONSafe(buf) {
  try { return JSON.parse(String(buf || '{}')); }
  catch { return null; }
}

async function handlePlan(req, res) {
  wrap(res, 'plan');

  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }

  // Basic browser CSRF guard (curl/tests: send X-Requested-With: ai2-ui)
  if (!maybeBlockBrowserPost(req, res)) return;

  // Require auth to avoid public model burn and to scope prefixes later if needed
  const auth = authCtx(req);
  if (!auth || !auth.ok) return sendJSON(res, 401, { ok:false, error:'unauthorized' });

  // Simple per-IP rate limit (default 10/min; override with PLAN_RL_PER_MIN)
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || (req.socket && req.socket.remoteAddress) || '0.0.0.0';
  const perMin = process.env.PLAN_RL_PER_MIN ? parseInt(process.env.PLAN_RL_PER_MIN, 10) : 10;
  const rl = rlCheck(ip, 'plan', perMin);
  if (!rl.ok) return sendJSON(res, 429, { ok:false, error:'rate_limited', retry_after: rl.retry_after });

  // Read & parse request body
  let bodyBuf;
  try {
    bodyBuf = await new Promise((resolve, reject) =>
      readBodyLimited(req, MAX_PLAN_BODY_BYTES, (e, b) => e ? reject(e) : resolve(b))
    );
  } catch (e) {
    const code = e && e.code === 413 ? 413 : 400;
    return sendJSON(res, code, { ok:false, error: String(e.code || e.message || 'bad_request') });
  }
  const body = parseJSONSafe(bodyBuf);
  if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
    return sendJSON(res, 400, { ok:false, error:'missing_prompt' });
  }

  // Scope planning to user-allowed prefixes
  const prefixes = allowedPrefixesFromAuth(auth);
  const extraCtx = `Allowed path prefixes:\n${prefixes.map(p => '- ' + p).join('\n')}`;
  const effectivePrompt = injectContextIntoPrompt(
    body.prompt,
    [String(body.context || '').trim(), extraCtx].filter(Boolean).join('\n\n')
  );

  // Call planner (with retries / CB already inside)
  let planned, usage;
  try {
    const { plan, usage: u } = await planWithRetry(effectivePrompt);
    planned = plan;
    usage = u || null;
  } catch (e) {
    return sendJSON(res, 502, { ok:false, error: 'planner_failed', detail: String(e.message || e).slice(0,200) });
  }

  // Normalize & validate diffs, infer ops, and build combined_diff
  if (Array.isArray(planned.steps)) {
    for (const s of planned.steps) {
      if (s && s.type === 'patch' && typeof s.diff === 'string') {
        s.diff = normalizeDiff(s.diff);
        if (!s.base_branch) s.base_branch = CANONICAL_BRANCH;

        if (looksBinaryDiff(s.diff)) {
          return sendJSON(res, 400, { ok:false, error:'binary_diff_not_allowed' });
        }
        // Validate paths against user-scoped prefixes for parity with diff_* handlers
        const pathsOk = stepPathsUnderRepo(s.diff, prefixes);
        if (!pathsOk.ok) {
          return sendJSON(res, 400, { ok:false, error:`diff_paths_invalid:${pathsOk.error}` });
        }
        if (!s.op) s.op = inferStepOpFromDiff(s.diff);
      }
    }
  }

  const combined = buildCombinedDiffFromSteps(planned.steps || []);
  if (combined) planned.combined_diff = combined;

  // Persist artifacts (plan.json + combined.patch if present)
  try { writePlanArtifacts(planned, { status: 'planned' }); } catch {}

  return sendJSON(res, 200, { ok:true, plan: planned, usage });
}

module.exports = { handlePlan };
