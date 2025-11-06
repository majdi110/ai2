// handlers/repo.js
'use strict';
const fs = require('fs');
const path = require('path');
const { sendJSON } = require('../utils/http');
const { REPO_ROOT, LIST_MAX_DEPTH, LIST_MAX_ITEMS, HIDE_NAMES } = require('../config/constants');

function safeJoin(root, userPath){
  const p = path.normalize('/' + String(userPath || '').replace(/^\/+/, ''));
  const full = path.join(root, '.' + p);
  if (!full.startsWith(root)) throw new Error('path_traversal');
  return full;
}

function handleRepoLs(req,res){
  try{
    const u  = new URL(req.url,'http://x');
    const p  = u.searchParams.get('path') || '';
    const d  = Math.min(LIST_MAX_DEPTH, Math.max(0, parseInt(u.searchParams.get('depth')||'1',10)||1));
    const full = safeJoin(REPO_ROOT, p);
    const out=[];
    (function walk(dir, level){
      if (out.length >= LIST_MAX_ITEMS) return;
      const ents = fs.readdirSync(dir, { withFileTypes:true });
      for (const e of ents){
        if (HIDE_NAMES.has(e.name)) continue;
        const f = path.join(dir, e.name);
        const rel = path.relative(REPO_ROOT, f);
        out.push({ name:e.name, rel, type:e.isDirectory()?'dir':'file' });
        if (e.isDirectory() && level < d) walk(f, level+1);
        if (out.length >= LIST_MAX_ITEMS) break;
      }
    })(full,0);
    return sendJSON(res,200,{ok:true,items:out});
  }catch{
    return sendJSON(res,400,{ok:false,error:'bad_path'});
  }
}

function handleRepoRead(req,res){
  try {
    const u = new URL(req.url, 'http://x');
    const rel = String(u.searchParams.get('path') || '').trim();
    const full = safeJoin(REPO_ROOT, rel);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      return sendJSON(res, 400, { ok:false, error:'is_directory' });
    }
    const content = fs.readFileSync(full, 'utf8');
    return sendJSON(res, 200, {
      ok: true,
      path: rel,
      size: st.size,
      mtime: st.mtime.toISOString(),
      content
    });
  } catch (e) {
    return sendJSON(res, 404, { ok:false, error:'not_found' });
  }
}

function handleRepoDownload(_req,res){
  return sendJSON(res,501,{ok:false,error:'repo_download_not_implemented'});
}

module.exports = { handleRepoLs, handleRepoRead, handleRepoDownload };
