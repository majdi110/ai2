// router.js
'use strict';

const url = require('url');
const { applyCORS } = require('./utils/cors');
const { isRoute } = require('./utils/http');
const { CORS_ORIGINS } = require('./config/constants');
const { authCtx, allowedPrefixesFromAuth } = require('./utils/auth');
const { verifyOpaqueToken } = require('./services/tokenStore'); // ← token checks

// Logging & metrics
const { withReqId } = require('./utils/reqid');
const logger = require('./services/logger');
const metrics = require('./services/metrics');

const system = require('./handlers/system');
const plan   = require('./handlers/plan');
const diffs  = require('./handlers/diffs');
const jobs   = require('./handlers/jobs');
const repo   = require('./handlers/repo');
const fsio   = require('./handlers/fs');

/* ---------------- minimal scope guard ---------------- */
function guard(scope, req, res) {
  try {
    const hdr = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/.exec(hdr);
    if (!m) { res.statusCode = 401; res.end('missing_bearer'); return false; }
    const out = verifyOpaqueToken(m[1]);
    if (!out.ok) { res.statusCode = 401; res.end('invalid_token'); return false; }
    if (!out.token.scopes || !out.token.scopes.includes(scope)) {
      res.statusCode = 403; res.end('insufficient_scope'); return false;
    }
    // attach principal for downstream handlers
    req.principal = { id: out.token.id, scopes: out.token.scopes };
    return true;
  } catch (e) {
    res.statusCode = 403; res.end('forbidden');
    return false;
  }
}

/* ---------------- router ---------------- */
function route(req, res) {
  // Per-request IDs, logging, and metrics
  withReqId(req, res);
  const t0 = Date.now();
  let wroteHead = false;
  const origWriteHead = res.writeHead;
  res.writeHead = function (...args) { wroteHead = true; return origWriteHead.apply(this, args); };
  res.on('finish', () => {
    const ms = Date.now() - t0;
    const status = res.statusCode || 200;
    metrics.inc('ai2_http_requests', { method: req.method, path: safeRoute(req.url), status });
    if (logger && typeof logger.write === 'function') {
      logger.write({ ...logger.reqLogBase(req), status, ms });
    }
  });
  function safeRoute(u) {
    try {
      const p = (u || '').split('?')[0];
      return p.replace(/[A-Fa-f0-9]{8,}/g, ':id');
    } catch { return '/'; }
  }

  applyCORS(req,res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';

  // Optional CORS allowlist block
  if (CORS_ORIGINS.length && req.headers.origin &&
      !(CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(req.headers.origin))) {
    res.statusCode = 403; return res.end('forbidden');
  }

  // ---------- QUICK SANITY ----------
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (pathname === '/ai2/_ping' || pathname === '/_ping') {
      res.writeHead(200, { 'Content-Type':'application/json' });
      return res.end(JSON.stringify({ ok:true, route: pathname }));
    }
  }

  // ---------- DEBUG: auth (hidden in production) ----------
  if (process.env.NODE_ENV !== 'production' && (req.method === 'GET' || req.method === 'HEAD')) {
    if (pathname === '/ai2/_auth_debug' || pathname === '/_auth_debug') {
      const auth = authCtx(req);
      const allowedPrefixes = allowedPrefixesFromAuth(auth);
      res.writeHead(200, { 'Content-Type':'application/json' });
      return res.end(JSON.stringify({ ok:true, auth, allowedPrefixes }));
    }
  }

  // static
  if (pathname.startsWith('/ai2/static/')) {
    return system.serveStatic(req, res, pathname.replace('/ai2/static/', ''));
  }

  // health
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2/_health') || isRoute(req, pathname, ['GET','HEAD'], '/_health')) {
    return system.handleHealth(req,res);
  }
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2/health') || isRoute(req, pathname, ['GET','HEAD'], '/health')) {
    return system.handleHealth(req,res);
  }

  // version
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2/version') || isRoute(req, pathname, ['GET','HEAD'], '/version')) {
    return system.handleVersion(req,res);
  }

  // whoami (read scope)
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2/whoami')) {
    if (!guard('read', req, res)) return;
    res.writeHead(200, { 'Content-Type':'application/json' });
    return res.end(JSON.stringify({ ok:true, id: req.principal.id, scopes: req.principal.scopes }));
  }

  // config
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2/_config') || isRoute(req, pathname, ['GET','HEAD'], '/_config')) {
    return system.handleConfig(req,res);
  }

  // metrics (Prometheus text)
  if (isRoute(req, pathname, ['GET'], '/ai2/metrics') || isRoute(req, pathname, ['GET'], '/metrics')) {
    const body = (metrics && typeof metrics.toProm === 'function') ? metrics.toProm() : '';
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    return res.end(body);
  }

  // OpenAI check
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2/_openai_check')) {
    return system.handleOpenAICheck(req, res);
  }

  // root
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2') || isRoute(req, pathname, ['GET','HEAD'], '/')) {
    return system.handleRoot(req, res);
  }

  // echo
  if (isRoute(req, pathname, 'POST', '/ai2/echo')  || isRoute(req, pathname, 'POST', '/echo')) {
    return system.handleEcho(req,res);
  }

  // planner (scope: plan)
  if (isRoute(req, pathname, 'POST', '/ai2/plan') || isRoute(req, pathname, 'POST', '/plan')) {
    if (!guard('plan', req, res)) return;
    return plan.handlePlan(req, res);
  }

  // fs (auth) — scopes: read/write
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2/_fs/read')   || isRoute(req, pathname, ['GET','HEAD'], '/_fs/read')) {
    if (!guard('read', req, res)) return;
    return fsio.handleFSRead(req,res);
  }
  if (isRoute(req, pathname, ['GET'],        '/ai2/_fs/ls')     || isRoute(req, pathname, ['GET'],        '/_fs/ls')) {
    if (!guard('read', req, res)) return;
    return fsio.handleFSLs(req,res);
  }
  if (isRoute(req, pathname, 'POST',         '/ai2/_fs/write')  || isRoute(req, pathname, 'POST',         '/_fs/write')) {
    if (!guard('write', req, res)) return;
    return fsio.handleFSWrite(req,res);
  }
  if (isRoute(req, pathname, 'POST',         '/ai2/_fs/delete') || isRoute(req, pathname, 'POST',         '/_fs/delete')) {
    if (!guard('write', req, res)) return;
    return fsio.handleFSDelete(req,res);
  }

  // auth: jobs (scopes: queue/read)
  if (isRoute(req, pathname, 'POST', '/ai2/job_submit') || isRoute(req, pathname, 'POST', '/job_submit')) {
    if (!guard('queue', req, res)) return;
    return jobs.handleJobSubmit(req, res);
  }
  if (isRoute(req, pathname, 'POST', '/ai2/diff_submit') || isRoute(req, pathname, 'POST', '/diff_submit')) {
    if (!guard('apply', req, res)) return;
    return diffs.handleDiffSubmit(req, res);
  }
  if (isRoute(req, pathname, 'POST', '/ai2/diff_dryrun') || isRoute(req, pathname, 'POST', '/diff_dryrun')) {
    if (!guard('dryrun', req, res)) return;
    return diffs.handleDiffDryRun(req, res);
  }

  // plans history (scope: read)
  if (isRoute(req, pathname, ['GET'], '/ai2/plans/list')) {
    if (!guard('read', req, res)) return;
    return system.handlePlansList(req,res);
  }
  if (isRoute(req, pathname, ['GET'], '/ai2/plans/read')) {
    if (!guard('read', req, res)) return;
    return system.handlePlansRead(req,res);
  }

  // repo (scope: read)
  if (isRoute(req, pathname, ['GET','POST'], '/ai2/repo/ls') || isRoute(req, pathname, ['GET','POST'], '/repo/ls')) {
    if (!guard('read', req, res)) return;
    return repo.handleRepoLs(req,res);
  }
  if (isRoute(req, pathname, ['GET','POST'], '/ai2/repo/read') || isRoute(req, pathname, ['GET','POST'], '/repo/read')) {
    if (!guard('read', req, res)) return;
    return repo.handleRepoRead(req,res);
  }
  if (isRoute(req, pathname, ['GET','POST'], '/ai2/repo/download') || isRoute(req, pathname, ['GET','POST'], '/repo/download')) {
    if (!guard('read', req, res)) return;
    return repo.handleRepoDownload(req,res);
  }

  // jobs (scope: read)
  if (isRoute(req, pathname, ['GET','POST'], '/ai2/jobs/list') || isRoute(req, pathname, ['GET','POST'], '/jobs/list')) {
    if (!guard('read', req, res)) return;
    return jobs.handleJobsList(req, res);
  }
  if (isRoute(req, pathname, ['GET','POST'], '/ai2/jobs/log')  || isRoute(req, pathname, ['GET','POST'], '/jobs/log')) {
    if (!guard('read', req, res)) return;
    return jobs.handleJobsLog(req, res);
  }

  res.statusCode = 404; res.end('nf');
}

module.exports = { route };
