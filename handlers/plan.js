// handlers/plan.js

// NOTE:
// /ai2/plan is PLAN-ONLY.
// It never runs dry-run or applies patches. It returns:
//   - preview_only: boolean
//   - apply_hint: "preview_only" | "auto_apply"
// Downstream components (UI/auto-approver) decide whether to call diff_dryrun + diff_submit.


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
const { validatePlanShape } = require('../services/planSchema');
const idempotencyStore = require('../services/idempotencyStore');

/* ---------------- helpers ---------------- */

function parseJSONSafe(buf) {
  try {
    return JSON.parse(String(buf || '{}'));
  } catch {
    return null;
  }
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

function sendIdempotentJSON(req, res, t0, idempotencyKey, statusCode, outcome, body, extraLog = {}) {
  if (idempotencyKey && req.principal) {
    try {
      idempotencyStore.storeResult(req.principal.id, idempotencyKey, statusCode, body);
      res.setHeader('X-Idempotency-Key', idempotencyKey);
      res.setHeader('X-Idempotency-Status', 'RECORDED');
    } catch {
      // best-effort — don't break the request if recording fails
    }
  }
  logOutcome(req, t0, statusCode, outcome, extraLog);
  return sendJSON(res, statusCode, body);
}

function maybeAttachCombinedDiff(bodyOut, plan, wantsCombinedDiff) {
  if (!wantsCombinedDiff || !plan) return bodyOut;

  let combined = plan.combined_diff;
  if (!combined && Array.isArray(plan.steps)) {
    combined = buildCombinedDiffFromSteps(plan.steps);
  }
  if (!combined) return bodyOut;

  return { ...bodyOut, combined_diff: combined };
}

function buildPlanBodyOut({ plan, cached, stale, fallback, usage, previewOnly, wantsCombinedDiff }) {
  const applyHint = previewOnly ? 'preview_only' : 'auto_apply';

  let bodyOut = {
    ok: true,
    cached: !!cached,
    stale: stale ? true : undefined,
    fallback: fallback ? true : undefined,
    preview_only: !!previewOnly,
    apply_hint: applyHint,
    plan,
    usage: usage || null
  };

  bodyOut = maybeAttachCombinedDiff(bodyOut, plan, wantsCombinedDiff);
  return bodyOut;
}

/* ---------------- handler ---------------- */

async function handlePlan(req, res) {
  wrap(res, 'plan');
  const t0 = Date.now();

  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end();
  }

  // Auth: must have 'plan' scope
  if (!req.principal || !Array.isArray(req.principal.scopes) || !req.principal.scopes.includes('plan')) {
    logOutcome(req, t0, 401, 'error', { error: 'unauthorized' });
    return sendJSON(res, 401, { ok: false, error: 'unauthorized' });
  }

  // CSRF guard
  if (!maybeBlockBrowserPost(req, res)) {
    logOutcome(req, t0, 403, 'error', { error: 'csrf_block' });
    return;
  }

  // Simple per-IP rate limit
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || (req.socket && req.socket.remoteAddress) || '0.0.0.0';
  const perMin = process.env.PLAN_RL_PER_MIN ? parseInt(process.env.PLAN_RL_PER_MIN, 10) : 10;
  const rl = rlCheck(ip, 'plan', perMin);
  if (!rl.ok) {
    logOutcome(req, t0, 429, 'error', { error: 'rate_limited', retry_after: rl.retry_after });
    return sendJSON(res, 429, { ok: false, error: 'rate_limited', retry_after: rl.retry_after });
  }

  // Read & parse body
  let bodyBuf;
  try {
    bodyBuf = await new Promise((resolve, reject) =>
      readBodyLimited(req, MAX_PLAN_BODY_BYTES, (e, b) => (e ? reject(e) : resolve(b)))
    );
  } catch (e) {
    const code = e && e.code === 413 ? 413 : 400;
    logOutcome(req, t0, code, 'error', { error: String(e.code || e.message || 'bad_request') });
    return sendJSON(res, code, { ok: false, error: String(e.code || e.message || 'bad_request') });
  }

  const body = parseJSONSafe(bodyBuf);
  const previewOnly = !!(body && body.preview_only === true);
  const wantsCombinedDiff =
    body && typeof body.return_combined_diff === 'boolean'
      ? body.return_combined_diff
      : false;

  // ---- Idempotency key extraction (header or body) ----
  const rawIdemHeader = (req.headers['x-idempotency-key'] || '').trim();
  const rawIdemBody =
    body && typeof body.idempotency_key === 'string'
      ? body.idempotency_key.trim()
      : '';

  const idempotencyKey = rawIdemHeader || rawIdemBody || null;

  // Replay / pending checks
  if (idempotencyKey) {
    const hit = idempotencyStore.get(req.principal && req.principal.id, idempotencyKey);
    if (hit && hit.record.status === 'done') {
      res.setHeader('X-Idempotency-Key', idempotencyKey);
      res.setHeader('X-Idempotency-Status', 'HIT');
      logOutcome(req, t0, hit.record.statusCode, 'idempotent_replay', {
        idem_key: idempotencyKey
      });
      return sendJSON(res, hit.record.statusCode, hit.record.body);
    }
    if (hit && hit.record.status === 'pending') {
      res.setHeader('X-Idempotency-Key', idempotencyKey);
      res.setHeader('X-Idempotency-Status', 'PENDING');
      logOutcome(req, t0, 409, 'idempotent_pending', { idem_key: idempotencyKey });
      return sendJSON(res, 409, { ok: false, error: 'idempotent_request_in_progress' });
    }
    // No existing record: mark as pending
    idempotencyStore.markPending(req.principal && req.principal.id, idempotencyKey);
    res.setHeader('X-Idempotency-Key', idempotencyKey);
    res.setHeader('X-Idempotency-Status', 'PENDING');
  }

  // Validate prompt
  if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
    const resp = { ok: false, error: 'missing_prompt' };
    // Record even missing_prompt under the key if provided
    if (idempotencyKey && req.principal) {
      try {
        idempotencyStore.storeResult(req.principal.id, idempotencyKey, 400, resp);
        res.setHeader('X-Idempotency-Key', idempotencyKey);
        res.setHeader('X-Idempotency-Status', 'RECORDED');
      } catch {
        // best-effort
      }
    }
    logOutcome(req, t0, 400, 'error', { error: 'missing_prompt' });
    return sendJSON(res, 400, resp);
  }

  // Auth → path prefixes
  const auth = authCtx(req);
  const prefixes = allowedPrefixesFromAuth(auth);

  const extraCtx = `Allowed path prefixes:\n${prefixes.map(p => '- ' + p).join('\n')}`;
  const effectivePrompt = injectContextIntoPrompt(
    body.prompt,
    [String(body.context || '').trim(), extraCtx].filter(Boolean).join('\n\n')
  );

  // Cache key
  const cacheInput = {
    prompt: effectivePrompt,
    include_files: Array.isArray(body.include_files) ? body.include_files.slice(0, 64) : [],
    preview_only: previewOnly,
    return_combined_diff: wantsCombinedDiff,
    model: process.env.OPENAI_MODEL || ''
  };

  // -------- 1) Cache lookup --------
  const c = cacheGet(cacheInput);
  if (c?.hit && c.fresh && c.rec?.plan) {
    res.setHeader('X-Plan-Cache', 'HIT');
    bumpMetric('HIT');

    const planned = c.rec.plan;
    const validated = await validateAndFinalizePlan(planned, prefixes);
    if (!validated.ok) {
      const bodyOut = validated.body;
      return sendIdempotentJSON(
        req,
        res,
        t0,
        idempotencyKey,
        validated.code,
        'error',
        bodyOut,
        { error: bodyOut.error }
      );
    }

    try {
      writePlanArtifacts(validated.plan, { status: 'planned', preview_only: previewOnly });
    } catch {}

    const bodyOut = buildPlanBodyOut({
      plan: validated.plan,
      cached: true,
      stale: false,
      fallback: false,
      usage: null,
      previewOnly,
      wantsCombinedDiff
    });

    return sendIdempotentJSON(
      req,
      res,
      t0,
      idempotencyKey,
      200,
      'cache_hit',
      bodyOut,
      { plan_id: validated.plan && validated.plan.id }
    );
  }

  // -------- 2) Planner call with timeout --------
  let planned;
  let usage;
  try {
    const plannerPromise = (async () => {
      const { plan, usage: u } = await planWithRetry(effectivePrompt);
      return { plan, usage: u || null };
    })();

    const out = await withTimeout(plannerPromise, PLANNER_TIMEOUT_MS, 'planner_timeout');
    planned = out.plan;
    usage = out.usage;

    const validated = await validateAndFinalizePlan(planned, prefixes);
    if (!validated.ok) {
      const bodyOut = validated.body;
      return sendIdempotentJSON(
        req,
        res,
        t0,
        idempotencyKey,
        validated.code,
        'error',
        bodyOut,
        { error: bodyOut.error }
      );
    }

    cachePut(cacheInput, validated.plan, { source: 'upstream' });
    res.setHeader('X-Plan-Cache', 'MISS');
    bumpMetric('MISS');

    try {
      writePlanArtifacts(validated.plan, { status: 'planned', preview_only: previewOnly });
    } catch {}

    const bodyOut = buildPlanBodyOut({
      plan: validated.plan,
      cached: false,
      stale: false,
      fallback: false,
      usage,
      previewOnly,
      wantsCombinedDiff
    });

    return sendIdempotentJSON(
      req,
      res,
      t0,
      idempotencyKey,
      200,
      'ok',
      bodyOut,
      { plan_id: validated.plan && validated.plan.id }
    );
  } catch (e) {
    // -------- 3) Planner failed: stale cache / fallback / hard error --------
    if (c?.hit && c.staleOK && c.rec?.plan) {
      res.setHeader('X-Plan-Cache', 'STALE');
      bumpMetric('STALE');

      const plannedStale = c.rec.plan;
      const validated = await validateAndFinalizePlan(plannedStale, prefixes);
      if (!validated.ok) {
        const bodyOut = validated.body;
        return sendIdempotentJSON(
          req,
          res,
          t0,
          idempotencyKey,
          validated.code,
          'error',
          bodyOut,
          { error: bodyOut.error }
        );
      }

      try {
        writePlanArtifacts(validated.plan, {
          status: 'planned',
          stale: true,
          preview_only: previewOnly
        });
      } catch {}

      const bodyOut = buildPlanBodyOut({
        plan: validated.plan,
        cached: true,
        stale: true,
        fallback: false,
        usage: null,
        previewOnly,
        wantsCombinedDiff
      });

      return sendIdempotentJSON(
        req,
        res,
        t0,
        idempotencyKey,
        200,
        'cache_stale',
        bodyOut,
        { plan_id: validated.plan && validated.plan.id }
      );
    }

    if (PLANNER_ENABLE_FALLBACK) {
      const fp = fallbackPlan({
        prompt: effectivePrompt,
        include_files: cacheInput.include_files,
        preview_only: cacheInput.preview_only
      });

      const validated = await validateAndFinalizePlan(fp, prefixes);
      if (!validated.ok) {
        const bodyOut = validated.body;
        return sendIdempotentJSON(
          req,
          res,
          t0,
          idempotencyKey,
          validated.code,
          'error',
          bodyOut,
          { error: bodyOut.error }
        );
      }

      cachePut(cacheInput, validated.plan, { source: 'fallback' });
      res.setHeader('X-Plan-Cache', 'FALLBACK');
      res.setHeader('X-Planner', 'fallback');
      bumpMetric('FALLBACK');

      try {
        writePlanArtifacts(validated.plan, {
          status: 'planned',
          fallback: true,
          preview_only: previewOnly
        });
      } catch {}

      const bodyOut = buildPlanBodyOut({
        plan: validated.plan,
        cached: false,
        stale: false,
        fallback: true,
        usage: null,
        previewOnly,
        wantsCombinedDiff
      });

      return sendIdempotentJSON(
        req,
        res,
        t0,
        idempotencyKey,
        200,
        'fallback',
        bodyOut,
        { plan_id: validated.plan && validated.plan.id }
      );
    }

    const detail = String((e && e.message) || e || '').slice(0, 200);
    const bodyOut = { ok: false, error: 'planner_failed', detail };

    return sendIdempotentJSON(
      req,
      res,
      t0,
      idempotencyKey,
      502,
      'error',
      bodyOut,
      { error: 'planner_failed', detail }
    );
  }
}

/* -------- validation / finalization pipeline for plan steps -------- */

async function validateAndFinalizePlan(planned, prefixes) {
  try {
    if (!planned || typeof planned !== 'object') {
      return { ok: false, code: 502, body: { ok: false, error: 'invalid_plan' } };
    }

    // Strict-ish JSON schema validation
    const shape = validatePlanShape(planned);
    if (!shape.ok) {
      return {
        ok: false,
        code: 400,
        body: { ok: false, error: shape.error }
      };
    }

    if (Array.isArray(planned.steps)) {
      for (const s of planned.steps) {
        if (s && s.type === 'patch' && typeof s.diff === 'string') {
          s.diff = normalizeDiff(s.diff);
          if (!s.base_branch) s.base_branch = CANONICAL_BRANCH;

          if (looksBinaryDiff(s.diff)) {
            return {
              ok: false,
              code: 400,
              body: { ok: false, error: 'binary_diff_not_allowed' }
            };
          }

          const pathsOk = stepPathsUnderRepo(s.diff, prefixes);
          if (!pathsOk.ok) {
            return {
              ok: false,
              code: 400,
              body: { ok: false, error: `diff_paths_invalid:${pathsOk.error}` }
            };
          }

          if (!s.op) s.op = inferStepOpFromDiff(s.diff);
        }
      }
    }

    const combined = buildCombinedDiffFromSteps(planned.steps || []);
    if (combined) planned.combined_diff = combined;

    return { ok: true, plan: planned };
  } catch (e) {
    return {
      ok: false,
      code: 500,
      body: {
        ok: false,
        error: 'plan_validation_error',
        detail: String(e.message || e).slice(0, 200)
      }
    };
  }
}

module.exports = { handlePlan };
