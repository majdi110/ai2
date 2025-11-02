'use strict';
const fs = require('fs');
const path = require('path');
const { wrap, sendJSON, readBodyLimited } = require('../utils/http');
const { maybeBlockBrowserPost } = require('../utils/cors');
const { REPO_ROOT, LIST_MAX_DEPTH, LIST_MAX_ITEMS, HIDE_NAMES } = require('../config/constants');
const { authCtx, allowedPrefixesFromAuth } = require('../utils/auth');
const { safeJoin } = require('../utils/files');

function normRel(userPath) {
  const full = safeJoin(REPO_ROOT, userPath);
  let rel = path.relative(REPO_ROOT, full);
  if (path.sep === '\\') rel = rel.replace(/\\/g, '/');
  return { full, rel };
}
function pathAllowed(rel, prefixes) {
  if (!Array.isArray(prefixes) || prefixes.length === 0) return true;
  return prefixes.some(p => rel.startsWith(p));
}

async function handleFSWrite(req, res) {
  wrap(res, 'fs_write');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
  if (!maybeBlockBrowserPost(req, res)) return;

  const auth = authCtx(req);
  if (!auth || !auth.ok) return sendJSON(res, 401, { ok:false, error:'unauthorized' });
  const prefixes = allowedPrefixesFromAuth(auth);

  let body;
  try {
    body = await new Promise((resolve, reject) =>
      readBodyLimited(req, 256 * 1024, (e, b) => e ? reject(e) : resolve(JSON.parse(String(b||'{}'))))
    );
  } catch (e) {
    return sendJSON(res, e && e.code === 413 ? 413 : 400, { ok:false, error:String(e.code || 'bad_request') });
  }

  const p = String(body && body.path || '').trim();
  const content = String(body && body.content != null ? body.content : '');
  if (!p) return sendJSON(res, 400, { ok:false, error:'missing_path' });

  let full, rel;
  try { ({ full, rel } = normRel(p)); } catch { return sendJSON(res, 400, { ok:false, error:'bad_path' }); }
  if (!pathAllowed(rel, prefixes)) return sendJSON(res, 403, { ok:false, error:'path_disallowed' });

  try {
    fs.mkdirSync(path.dirname(full), { recursive:true, mode:0o755 });
    fs.writeFileSync(full, content, { mode:0o644 });
    const st = fs.statSync(full);
    return sendJSON(res, 200, { ok:true, path: rel, bytes: st.size, mtime: st.mtime.toISOString() });
  } catch {
    return sendJSON(res, 500, { ok:false, error:'write_failed' });
  }
}

function handleFSRead(req, res) {
  wrap(res, 'fs_read');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }

  const auth = authCtx(req);
  if (!auth || !auth.ok) return sendJSON(res, 401, { ok:false, error:'unauthorized' });
  const prefixes = allowedPrefixesFromAuth(auth);

  const u = new URL(req.url, 'http://x');
  const p = String(u.searchParams.get('path') || '').trim();
  if (!p) return sendJSON(res, 400, { ok:false, error:'missing_path' });

  let full, rel, st;
  try { ({ full, rel } = normRel(p)); st = fs.statSync(full); }
  catch { return sendJSON(res, 404, { ok:false, error:'not_found' }); }
  if (!pathAllowed(rel, prefixes)) return sendJSON(res, 403, { ok:false, error:'path_disallowed' });
  if (st.isDirectory()) return sendJSON(res, 400, { ok:false, error:'is_directory' });

  try {
    const content = fs.readFileSync(full, 'utf8');
    return sendJSON(res, 200, { ok:true, path: rel, size: st.size, mtime: st.mtime.toISOString(), content });
  } catch {
    return sendJSON(res, 500, { ok:false, error:'read_failed' });
  }
}

function handleFSLs(req, res) {
  wrap(res, 'fs_ls');
  if (req.method !== 'GET') { res.statusCode = 405; return res.end(); }

  const auth = authCtx(req);
  if (!auth || !auth.ok) return sendJSON(res, 401, { ok:false, error:'unauthorized' });
  const prefixes = allowedPrefixesFromAuth(auth);

  const u = new URL(req.url, 'http://x');
  const p = String(u.searchParams.get('path') || '').trim();
  const depth = Math.min(LIST_MAX_DEPTH, Math.max(0, parseInt(u.searchParams.get('depth')||'1',10)||1));
  if (!p) return sendJSON(res, 400, { ok:false, error:'missing_path' });

  let full, rel;
  try { ({ full, rel } = normRel(p)); } catch { return sendJSON(res, 400, { ok:false, error:'bad_path' }); }
  if (!pathAllowed(rel, prefixes)) return sendJSON(res, 403, { ok:false, error:'path_disallowed' });

  try {
    const out = [];
    (function walk(dir, level){
      if (out.length >= LIST_MAX_ITEMS) return;
      const ents = fs.readdirSync(dir, { withFileTypes:true });
      for (const e of ents){
        if (HIDE_NAMES.has(e.name)) continue;
        const f = path.join(dir, e.name);
        const r = path.relative(REPO_ROOT, f).replace(/\\/g,'/');
        out.push({ name:e.name, rel:r, type:e.isDirectory()?'dir':'file' });
        if (e.isDirectory() && level < depth) walk(f, level+1);
        if (out.length >= LIST_MAX_ITEMS) break;
      }
    })(full, 0);
    return sendJSON(res, 200, { ok:true, items: out });
  } catch {
    return sendJSON(res, 500, { ok:false, error:'list_failed' });
  }
}

async function handleFSDelete(req, res) {
  wrap(res, 'fs_delete');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
  if (!maybeBlockBrowserPost(req, res)) return;

  const auth = authCtx(req);
  if (!auth || !auth.ok) return sendJSON(res, 401, { ok:false, error:'unauthorized' });
  const prefixes = allowedPrefixesFromAuth(auth);

  let body;
  try {
    body = await new Promise((resolve, reject) =>
      readBodyLimited(req, 32 * 1024, (e, b) => e ? reject(e) : resolve(JSON.parse(String(b||'{}'))))
    );
  } catch (e) {
    return sendJSON(res, e && e.code === 413 ? 413 : 400, { ok:false, error:String(e.code || 'bad_request') });
  }

  const p = String(body && body.path || '').trim();
  if (!p) return sendJSON(res, 400, { ok:false, error:'missing_path' });

  let full, rel, st;
  try { ({ full, rel } = normRel(p)); st = fs.statSync(full); }
  catch { return sendJSON(res, 404, { ok:false, error:'not_found' }); }
  if (!pathAllowed(rel, prefixes)) return sendJSON(res, 403, { ok:false, error:'path_disallowed' });
  if (st.isDirectory()) return sendJSON(res, 400, { ok:false, error:'is_directory' });

  try { fs.unlinkSync(full); return sendJSON(res, 200, { ok:true, path:rel }); }
  catch { return sendJSON(res, 500, { ok:false, error:'delete_failed' }); }
}

module.exports = { handleFSWrite, handleFSRead, handleFSLs, handleFSDelete };
