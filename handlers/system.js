// handlers/system.js
'use strict';
const fs = require('fs');
const path = require('path');
const { sendJSON, wrap } = require('../utils/http');
const { STATIC_ROOT, VERSION_FILE, OPENAI_MODEL, PORT } = require('../config/constants');

function handleRoot(req, res){ wrap(res,'root'); if (req.method==='GET'||req.method==='HEAD'){ res.writeHead(200, {'Content-Type':'text/plain; charset=utf-8'}); res.end('OK (ai2)'); } else { res.statusCode=405; res.end(); } }
function handleHealth(_req, res){ wrap(res,'health'); return sendJSON(res,200,{ok:true,time:new Date().toISOString()}); }
function handleVersion(_req,res){ wrap(res,'version'); let v='unknown'; try{ v=fs.readFileSync(VERSION_FILE,'utf8').trim(); }catch{} return sendJSON(res,200,{ok:true,version:v||'unknown'}); }
function handleConfig(_req,res){ wrap(res,'config'); return sendJSON(res,200,{ok:true,port:PORT,model:OPENAI_MODEL}); }
function handleMetrics(_req,res){ wrap(res,'metrics'); res.writeHead(200,{'Content-Type':'text/plain'}); res.end(''); }
function handleEcho(req,res){ wrap(res,'echo'); if(req.method!=='POST'){ res.statusCode=405; return res.end(); } let b=[]; req.on('data',c=>b.push(c)); req.on('end',()=>sendJSON(res,200,{ok:true,preview:Buffer.concat(b).toString('utf8').slice(0,1000)})); }
function handleOpenAICheck(_req,res){ wrap(res,'openai_check'); return sendJSON(res,200,{ok:true,model:OPENAI_MODEL}); }

function serveStatic(_req,res,file){
  const safe = String(file||'').replace(/[^A-Za-z0-9._/-]/g,''); 
  const full = path.join(STATIC_ROOT, safe);
  if (!full.startsWith(STATIC_ROOT)) { res.statusCode=400; return res.end('bad_path'); }
  fs.createReadStream(full).on('error',()=>{ res.statusCode=404; res.end('nf'); }).pipe(res);
}

// Stubs used by router (plans list/read can be wired later)
function handlePlansList(_req,res){ return sendJSON(res,200,{ok:true,items:[]}); }
function handlePlansRead(_req,res){ return sendJSON(res,404,{ok:false,error:'not_found'}); }

module.exports = {
  handleRoot, handleHealth, handleVersion, handleConfig, handleMetrics,
  handleEcho, handleOpenAICheck, serveStatic, handlePlansList, handlePlansRead
};

