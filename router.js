'use strict';
const url = require('url');
const { applyCORS } = require('./utils/cors');
const { isRoute } = require('./utils/http');
const { CORS_ORIGINS } = require('./config/constants');
const { authCtx, allowedPrefixesFromAuth } = require('./utils/auth');

const system = require('./handlers/system');
const plan   = require('./handlers/plan');
const diffs  = require('./handlers/diffs');
const jobs   = require('./handlers/jobs');
const repo   = require('./handlers/repo');
const fsio   = require('./handlers/fs');

function route(req, res) {
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

  // ---------- DEBUG: auth ----------
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (pathname === '/ai2/_auth_debug' || pathname === '/_auth_debug') {
      const auth = authCtx(req);
      const allowedPrefixes = allowedPrefixesFromAuth(auth);
      res.writeHead(200, { 'Content-Type':'application/json' });
      return res.end(JSON.stringify({ ok:true, auth, allowedPrefixes }));
    }
  }

  // static
  if (pathname.startsWith('/ai2/static/')) return system.serveStatic(req, res, pathname.replace('/ai2/static/', ''));

  // health
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2/_health') || isRoute(req, pathname, ['GET','HEAD'], '/_health')) return system.handleHealth(req,res);
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2/health') || isRoute(req, pathname, ['GET','HEAD'], '/health'))     return system.handleHealth(req,res);

  // version
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2/version') || isRoute(req, pathname, ['GET','HEAD'], '/version'))    return system.handleVersion(req,res);

  // config
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2/_config') || isRoute(req, pathname, ['GET','HEAD'], '/_config'))     return system.handleConfig(req,res);

  // metrics
  if (isRoute(req, pathname, ['GET'], '/ai2/metrics') || isRoute(req, pathname, ['GET'], '/metrics')) return system.handleMetrics(req,res);

  // OpenAI check
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2/_openai_check')) return system.handleOpenAICheck(req, res);

  // root
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2') || isRoute(req, pathname, ['GET','HEAD'], '/')) return system.handleRoot(req, res);

  // echo
  if (isRoute(req, pathname, 'POST', '/ai2/echo')  || isRoute(req, pathname, 'POST', '/echo'))  return system.handleEcho(req,res);

  // planner
  if (isRoute(req, pathname, 'POST', '/ai2/plan') || isRoute(req, pathname, 'POST', '/plan')) return plan.handlePlan(req, res);

  // fs (auth)
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2/_fs/read')   || isRoute(req, pathname, ['GET','HEAD'], '/_fs/read'))   return fsio.handleFSRead(req,res);
  if (isRoute(req, pathname, ['GET'],        '/ai2/_fs/ls')     || isRoute(req, pathname, ['GET'],        '/_fs/ls'))     return fsio.handleFSLs(req,res);
  if (isRoute(req, pathname, 'POST',         '/ai2/_fs/write')  || isRoute(req, pathname, 'POST',         '/_fs/write'))  return fsio.handleFSWrite(req,res);
  if (isRoute(req, pathname, 'POST',         '/ai2/_fs/delete') || isRoute(req, pathname, 'POST',         '/_fs/delete')) return fsio.handleFSDelete(req,res);

  // auth: jobs
  if (isRoute(req, pathname, 'POST', '/ai2/job_submit') || isRoute(req, pathname, 'POST', '/job_submit')) return jobs.handleJobSubmit(req, res);
  if (isRoute(req, pathname, 'POST', '/ai2/diff_submit') || isRoute(req, pathname, 'POST', '/diff_submit')) return diffs.handleDiffSubmit(req, res);
  if (isRoute(req, pathname, 'POST', '/ai2/diff_dryrun') || isRoute(req, pathname, 'POST', '/diff_dryrun')) return diffs.handleDiffDryRun(req, res);

  // plans history (auth)
  if (isRoute(req, pathname, ['GET'], '/ai2/plans/list')) return system.handlePlansList(req,res);
  if (isRoute(req, pathname, ['GET'], '/ai2/plans/read')) return system.handlePlansRead(req,res);

  // repo (auth)
  if (isRoute(req, pathname, ['GET','POST'], '/ai2/repo/ls') || isRoute(req, pathname, ['GET','POST'], '/repo/ls')) return repo.handleRepoLs(req,res);
  if (isRoute(req, pathname, ['GET','POST'], '/ai2/repo/read') || isRoute(req, pathname, ['GET','POST'], '/repo/read')) return repo.handleRepoRead(req,res);
  if (isRoute(req, pathname, ['GET','POST'], '/ai2/repo/download') || isRoute(req, pathname, ['GET','POST'], '/repo/download')) return repo.handleRepoDownload(req,res);

  // jobs (auth)
  if (isRoute(req, pathname, ['GET','POST'], '/ai2/jobs/list') || isRoute(req, pathname, ['GET','POST'], '/jobs/list')) return jobs.handleJobsList(req, res);
  if (isRoute(req, pathname, ['GET','POST'], '/ai2/jobs/log')  || isRoute(req, pathname, ['GET','POST'], '/jobs/log'))   return jobs.handleJobsLog(req, res);

  res.statusCode = 404; res.end('nf');
}
module.exports = { route };
