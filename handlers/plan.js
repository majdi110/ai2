// handlers/plan.js
'use strict';

const { wrap, sendJSON, readBodyLimited } = require('../utils/http');
const { maybeBlockBrowserPost } = require('../utils/cors');
const {
  MAX_PLAN_BODY_BYTES,
  CANONICAL_BRANCH,
  PLANNER_TIMEOUT_MS,
  PLANNER_ENABLE_FALLBACK
} = require('../config/constants');

const logger = require('../services/logger');
const metrics = require('../services/metrics');

const { injectContextIntoPrompt, planWithRetry } = require('../services/planner');
const { writePlanArtifacts } = require('../services/storage');
const { put: cachePut, get: cacheGet } = require('../services/planCache');
const { fallbackPlan } = require('../services/plannerFallback');
const { withTimeout } = require('../services/withTimeout');

const {
  normalizeDiff,
  looksBinaryDiff,
  stepPathsUnderRepo,
  buildCombinedDiffFromSteps,
  inferStepOpFromDiff
} = require('../utils/diff');

const { authCtx, allowedPrefixesFromAuth } = require('../utils/auth');
const { rlCheck } = require('../utils/rl');
const { bumpMetric } = require('./system');

/* ---------------- helpers ---------------- */
function parseJSONSafe(buf) {
  try { return JSON.parse(String(buf || '{}')); }
  catch { return null; }
}

function logOutcome(req, t0, status, outcome, extra = {}) {
  metrics.inc('ai2_planner_requests', { outcome });
  if (logger && typeof logger.write === 'function') {
    logger.write({
      ...logger.reqLogBase(req),
      route: 'plan',
      status,
      ms: Date.now() - t0,
      outcome,
      ...extra
    });
  }
}

/* ---------------- handler ---------------- */
async function handlePlan(req, res) {
  wrap(res, 'plan');
  const t0 = Date.now();

  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }

  // Ensure router attached a validated principal with 'plan' scope
  if (!req.principal || !Array.isArray(req.principal.scopes) || !req.principal.scopes.includes('plan')) {
    logOutcome(req, t0, 401, 'error', { error: 'unauthorized' });
    return sendJSON(res, 401, { ok:false, error:'unauthorized' });
  }

  // Basic browser CSRF guard (curl/tests: send X-Requested-With: ai2-ui)
  if (!maybeBlockBrowserPost(req, res)) {
    logOutcome(req, t0, 403, 'error', { error: 'csrf_block' });
    return; // maybeBlockBrowserPost already wrote response
  }

  // Simple per-IP rate limit (default 10/min; override with PLAN_RL_PER_MIN)
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || (req.socket && req.socket.remoteAddress) || '0.0.0.0';
  const perMin = process.env.PLAN_RL_PER_MIN ? parseInt(process.env.PLAN_RL_PER_MIN, 10) : 10;
  const rl = rlCheck(ip, 'plan', perMin);
  if (!rl.ok) {
    logOutcome(req, t0, 429, 'error', { error: 'rate_limited', retry_after: rl.retry_after });
    return sendJSON(res, 429, { ok:false, error:'rate_limited', retry_after: rl.retry_after });
  }

  // Read & parse request body
  let bodyBuf;
  try {
    bodyBuf = await new Promise((resolve, reject) =>
      readBodyLimited(req, MAX_PLAN_BODY_BYTES, (e, b) => e ? reject(e) : resolve(b))
    );
  } catch (e) {
    const code = e && e.code === 413 ? 413 : 400;
    logOutcome(req, t0, code, 'error', { error: String(e.code || e.message || 'bad_request') });
    return sendJSON(res, code, { ok:false, error: String(e.code || e.message || 'bad_request') });
  }
  const body = parseJSONSafe(bodyBuf);
  if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
    logOutcome(req, t0, 400, 'error', { error: 'missing_prompt' });
    return sendJSON(res, 400, { ok:false, error:'missing_prompt' });
  }

  // Derive legacy-shaped auth (bridged from req.principal) to get allowed prefixes
  const auth = authCtx(req); // now reflects req.principal via utils/auth bridge
  const prefixes = allowedPrefixesFromAuth(auth);

  // Scope planning to user-allowed prefixes (also surface in system prompt)
  const extraCtx = `Allowed path prefixes:\n${prefixes.map(p => '- ' + p).join('\n')}`;
  const effectivePrompt = injectContextIntoPrompt(
    body.prompt,
    [String(body.context || '').trim(), extraCtx].filter(Boolean).join('\n\n')
  );

  // -------- Planner call with timeout + cache + fallback --------
  // Build a stable cache input. Include effective prompt and basic knobs that change output.
  const cacheInput = {
    prompt: effectivePrompt,
    include_files: Array.isArray(body.include_files) ? body.include_files.slice(0, 64) : [],
    preview_only: !!body.preview_only,
    return_combined_diff: !!body.return_combined_diff,
    model: process.env.OPENAI_MODEL || ''
  };

  // 1) Cache lookup
  const c = cacheGet(cacheInput);
  if (c?.hit && c.fresh && c.rec?.plan) {
    res.setHeader('X-Plan-Cache', 'HIT');
    bumpMetric('HIT');
    const planned = c.rec.plan;
    const validated = await validateAndFinalizePlan(planned, prefixes);
    if (!validated.ok) {
      logOutcome(req, t0, validated.code, 'error', { error: validated.body.error });
      return sendJSON(res, validated.code, validated.body);
    }
    try { writePlanArtifacts(validated.plan, { status: 'planned' }); } catch {}
    logOutcome(req, t0, 200, 'cache_hit', { plan_id: validated.plan && validated.plan.id });
    return sendJSON(res, 200, { ok:true, cached:true, plan: validated.plan, usage: null });
  }

  // 2) Call upstream planner with timeout
  let planned, usage;
  try {
    const plannerPromise = (async () => {
      const { plan, usage: u } = await planWithRetry(effectivePrompt);
      return { plan, usage: (u || null) };
    })();
    const out = await withTimeout(plannerPromise, PLANNER_TIMEOUT_MS, 'planner_timeout');
    planned = out.plan;
    usage = out.usage;

    // Validate & finalize (diff normalization, path check, combined diff)
    const validated = await validateAndFinalizePlan(planned, prefixes);
    if (!validated.ok) {
      logOutcome(req, t0, validated.code, 'error', { error: validated.body.error });
      return sendJSON(res, validated.code, validated.body);
    }

    // Cache and persist
    cachePut(cacheInput, validated.plan, { source: 'upstream' });
    res.setHeader('X-Plan-Cache', 'MISS');
    bumpMetric('MISS');
    try { writePlanArtifacts(validated.plan, { status: 'planned' }); } catch {}
    logOutcome(req, t0, 200, 'ok', { plan_id: validated.plan && validated.plan.id });
    return sendJSON(res, 200, { ok:true, cached:false, plan: validated.plan, usage });
  } catch (e) {
    // 3) Upstream failed: serve stale cache if allowed, else fallback
    if (c?.hit && c.staleOK && c.rec?.plan) {
      res.setHeader('X-Plan-Cache', 'STALE');
      bumpMetric('STALE');
      const plannedStale = c.rec.plan;
      const validated = await validateAndFinalizePlan(plannedStale, prefixes);
      if (!validated.ok) {
        logOutcome(req, t0, validated.code, 'error', { error: validated.body.error });
        return sendJSON(res, validated.code, validated.body);
      }
      try { writePlanArtifacts(validated.plan, { status: 'planned', stale: true }); } catch {}
      logOutcome(req, t0, 200, 'cache_stale', { plan_id: validated.plan && validated.plan.id });
      return sendJSON(res, 200, { ok:true, cached:true, stale:true, plan: validated.plan, usage: null });
    }
    if (PLANNER_ENABLE_FALLBACK) {
      const fp = fallbackPlan({
        prompt: effectivePrompt,
        include_files: cacheInput.include_files,
        preview_only: cacheInput.preview_only
      });
      const validated = await validateAndFinalizePlan(fp, prefixes);
      if (!validated.ok) {
        logOutcome(req, t0, validated.code, 'error', { error: validated.body.error });
        return sendJSON(res, validated.code, validated.body);
      }
      cachePut(cacheInput, validated.plan, { source: 'fallback' });
      res.setHeader('X-Plan-Cache', 'FALLBACK');
      res.setHeader('X-Planner', 'fallback');
      bumpMetric('FALLBACK');
      try { writePlanArtifacts(validated.plan, { status: 'planned', fallback: true }); } catch {}
      logOutcome(req, t0, 200, 'fallback', { plan_id: validated.plan && validated.plan.id });
      return sendJSON(res, 200, { ok:true, fallback:true, plan: validated.plan, usage: null });
    }
    logOutcome(req, t0, 502, 'error', { error: 'planner_failed', detail: String(e && e.message || e || '').slice(0,200) });
    return sendJSON(res, 502, { ok:false, error: 'planner_failed', detail: String(e && e.message || e || '').slice(0,200) });
  }
}

/* -------- validation / finalization pipeline for plan steps -------- */
async function validateAndFinalizePlan(planned, prefixes) {
  try {
    if (!planned || typeof planned !== 'object') {
      return { ok:false, code:502, body:{ ok:false, error:'invalid_plan' } };
    }

    if (Array.isArray(planned.steps)) {
      for (const s of planned.steps) {
        if (s && s.type === 'patch' && typeof s.diff === 'string') {
          s.diff = normalizeDiff(s.diff);
          if (!s.base_branch) s.base_branch = CANONICAL_BRANCH;

          if (looksBinaryDiff(s.diff)) {
            return { ok:false, code:400, body:{ ok:false, error:'binary_diff_not_allowed' } };
          }
          // Validate paths against user-scoped prefixes for parity with diff_* handlers
          const pathsOk = stepPathsUnderRepo(s.diff, prefixes);
          if (!pathsOk.ok) {
            return { ok:false, code:400, body:{ ok:false, error:`diff_paths_invalid:${pathsOk.error}` } };
          }
          if (!s.op) s.op = inferStepOpFromDiff(s.diff);
        }
      }
    }

    const combined = buildCombinedDiffFromSteps(planned.steps || []);
    if (combined) planned.combined_diff = combined;

    return { ok:true, plan: planned };
  } catch (e) {
    return {
      ok:false,
      code:500,
      body:{ ok:false, error:'plan_validation_error', detail:String(e.message||e).slice(0,200) }
    };
  }
}

module.exports = { handlePlan };
