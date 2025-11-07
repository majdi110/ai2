// handlers/system.js
'use strict';

const fs = require('fs');
const path = require('path');
const { sendJSON, wrap } = require('../utils/http');
const { STATIC_ROOT, VERSION_FILE, ARTIFACTS_DIR } = require('../config/constants');

/* ---------------- Simple planner cache metrics ---------------- */
let PLAN_CACHE_HIT = 0;
let PLAN_CACHE_MISS = 0;
let PLAN_CACHE_STALE = 0;
let PLAN_FALLBACK = 0;

/**
 * Bump a planner/cache metric counter.
 * Used by handlers/plan.js (call before returning a response).
 * @param {'HIT'|'MISS'|'STALE'|'FALLBACK'} type
 */
function bumpMetric(type) {
  if (type === 'HIT') PLAN_CACHE_HIT++;
  else if (type === 'MISS') PLAN_CACHE_MISS++;
  else if (type === 'STALE') PLAN_CACHE_STALE++;
  else if (type === 'FALLBACK') PLAN_FALLBACK++;
}

/* ---------------- Basic endpoints ---------------- */
function handleRoot(req, res){
  wrap(res,'root');
  if (req.method==='GET'||req.method==='HEAD'){
    res.writeHead(200, {'Content-Type':'text/plain; charset=utf-8'});
    res.end('OK (ai2)');
  } else {
    res.statusCode=405; res.end();
  }
}

function handleHealth(_req, res){
  wrap(res,'health');
  return sendJSON(res,200,{ok:true,time:new Date().toISOString()});
}

function handleVersion(_req,res){
  wrap(res,'version');
  let v='unknown';
  try{ v=fs.readFileSync(VERSION_FILE,'utf8').trim(); }catch{}
  return sendJSON(res,200,{ok:true,version:v||'unknown'});
}

function handleConfig(_req,res){
  wrap(res,'config');
  const { PORT, OPENAI_MODEL, REPO_ROOT, CANONICAL_BRANCH, ALLOWED_PATH_PREFIXES } = require('../config/constants');
  return sendJSON(res,200,{
    ok: true,
    port: PORT,
    model: OPENAI_MODEL,
    repo_root: REPO_ROOT,
    canonical_branch: CANONICAL_BRANCH,
    ALLOWED_PATH_PREFIXES
  });
}

function handleMetrics(_req,res){
  wrap(res,'metrics');
  const body = [
    `plan_cache_hit ${PLAN_CACHE_HIT}`,
    `plan_cache_miss ${PLAN_CACHE_MISS}`,
    `plan_cache_stale ${PLAN_CACHE_STALE}`,
    `plan_fallback ${PLAN_FALLBACK}`
  ].join('\n');
  res.writeHead(200, {'Content-Type':'text/plain; charset=utf-8'});
  res.end(body);
}

function handleEcho(req,res){
  wrap(res,'echo');
  if(req.method!=='POST'){ res.statusCode=405; return res.end(); }
  let b=[]; req.on('data',c=>b.push(c));
  req.on('end',()=>sendJSON(res,200,{ok:true,preview:Buffer.concat(b).toString('utf8').slice(0,1000)}));
}

function handleOpenAICheck(_req,res){
  wrap(res,'openai_check');
  const { OPENAI_MODEL } = require('../config/constants');
  return sendJSON(res,200,{ok:true,model:OPENAI_MODEL});
}

/* ---------------- Static files ---------------- */
function serveStatic(_req,res,file){
  const safe = String(file||'').replace(/[^A-Za-z0-9._/-]/g,'');
  const full = path.join(STATIC_ROOT, safe);
  if (!full.startsWith(STATIC_ROOT)) { res.statusCode=400; return res.end('bad_path'); }
  fs.createReadStream(full)
    .on('error',()=>{ res.statusCode=404; res.end('nf'); })
    .pipe(res);
}

/* ---------------- Plans history ---------------- */
function handlePlansList(_req,res){
  try{
    const ents = fs.readdirSync(ARTIFACTS_DIR, { withFileTypes:true });
    const items = ents
      .filter(e => e.isDirectory())
      .map(e => ({ file: e.name + '/plan.json' }))
      .slice(0,50);
    return sendJSON(res,200,{ ok:true, items });
  } catch {
    return sendJSON(res,200,{ ok:true, items: [] });
  }
}

function handlePlansRead(req,res){
  const u = new URL(req.url,'http://x');
  const id = String(u.searchParams.get('id')||'').trim();
  if (!id) return sendJSON(res,400,{ok:false,error:'missing_id'});
  try{
    const p = path.join(ARTIFACTS_DIR, id, 'plan.json');
    const txt = fs.readFileSync(p,'utf8');
    return sendJSON(res,200, JSON.parse(txt));
  } catch {
    return sendJSON(res,404,{ok:false,error:'not_found'});
  }
}

/* ---------------- Exports ---------------- */
module.exports = {
  handleRoot,
  handleHealth,
  handleVersion,
  handleConfig,
  handleMetrics,
  handleEcho,
  handleOpenAICheck,
  serveStatic,
  handlePlansList,
  handlePlansRead,
  bumpMetric
};
