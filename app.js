'use strict';

/**
 * BeloCloud Actions mini-server (no external deps).
 *
 * Public:
 *   GET  /ai2/                   -> "OK (ai2)"
 *   GET  /ai2/_health            -> { ok:true, time }
 *   GET  /ai2/health             -> alias of /ai2/_health
 *   GET  /ai2/version            -> { ok:true, version }
 *   GET  /ai2/static/<file>      -> serve ./public/<file> (json/text/log only)
 *   GET  /ai2/debug              -> debug info (node version, env)
 *   POST /ai2/echo               -> debug echo; shows headers/body + decoded preview
 *
 * Actions (write):
 *   POST /ai2/job_submit         -> enqueue a commands job (picked up by worker.sh)
 *   POST /ai2/diff_submit        -> enqueue a unified diff (plain text)
 *   POST /ai2/diff_dryrun        -> git-apply --check (no enqueue), vs origin/<base_branch>
 *
 * Repo browsing (read-only; require token):
 *   GET  /ai2/repo/list?path=&depth=
 *   GET  /ai2/repo/get?path=relative/path
 *   Aliases: /repo/list, /repo/get, /ai2/fs/list, /ai2/fs/get, /fs/list, /fs/get
 *   Short aliases: /ai2/list, /ai2/get
 *
 * Queue introspection (require token):
 *   GET  /ai2/jobs/list?state=queue|done|fail&limit=100
 *   GET  /ai2/jobs/log?file=job-*.json[.log]&lines=200
 */

const http   = require('http');
const fs     = require('fs');
const fsp    = require('fs/promises');
const path   = require('path');
const crypto = require('crypto');
const url    = require('url');
const os     = require('os');
const { execFile } = require('child_process');

// ----- config -----
const BASE_URI     = '/ai2';

const TOKEN_FILE   = '/home/genweb/agent/ACTION_TOKEN';
const QUEUE_DIR    = '/home/genweb/agent/queue';
const DONE_DIR     = '/home/genweb/agent/done';
const FAIL_DIR     = '/home/genweb/agent/failures';
const LOG_DIR      = '/home/genweb/agent/logs';
const IDEM_DIR     = QUEUE_DIR; // idempotency markers alongside jobs
const DEBUG_LOG    = '/home/genweb/agent/last_action_debug.log';

const STATIC_ROOT  = path.join(__dirname, 'public');
const VERSION_FILE = path.join(__dirname, 'VERSION.txt');
const MAX_BYTES    = 512 * 1024;

// Active repo path (this app's own repo)
const REPO_ROOT      = '/home/genweb/public_html/datav.belocloud.com/ai2';
const LIST_MAX_DEPTH = 3;
const GET_MAX_BYTES  = 256 * 1024;

const HIDDEN_DIRS = new Set(['.git', 'node_modules', '.cache', '.cpanel', '.trash']);
const HIDDEN_TOP  = new Set(['.git', 'node_modules', '.env']);

// ----- init -----
try { fs.mkdirSync(QUEUE_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(DONE_DIR,  { recursive: true }); } catch {}
try { fs.mkdirSync(FAIL_DIR,  { recursive: true }); } catch {}
try { fs.mkdirSync(LOG_DIR,   { recursive: true }); } catch {}

// Lazily load token (don't crash if unreadable)
let ACTION_TOKEN = null;
function loadToken() {
  if (ACTION_TOKEN) return ACTION_TOKEN;
  try {
    ACTION_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch (e) {
    ACTION_TOKEN = (process.env.ACTION_TOKEN || '').trim();
    console.error(`[ai2] WARN: failed to read ACTION_TOKEN from ${TOKEN_FILE}: ${e.message}`);
  }
  return ACTION_TOKEN;
}

// ----- helpers -----
const nowISO  = () => new Date().toISOString();
const ipOf    = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '');
const idemSan = (s) => String(s || '').replace(/[^A-Za-z0-9._:-]/g, '_');
const safeJobBasename = (s) => String(s || '').replace(/[^A-Za-z0-9._-]/g, '');
const ts      = () => {
  const d = new Date(), p = n => String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
};
const r4      = () => crypto.randomBytes(2).toString('hex');
const sha256S = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const logDbg  = (objOrStr) => {
  try {
    const line = typeof objOrStr === 'string' ? objOrStr : JSON.stringify(objOrStr);
    fs.appendFileSync(DEBUG_LOG, line + '\n');
  } catch {}
};

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=UTF-8' });
  res.end(JSON.stringify(obj));
}
function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=UTF-8' });
  res.end(text);
}

function getTokenFromHeaders(req) {
  const h   = String(req.headers['authorization'] || '');
  const tok = h.toLowerCase().startsWith('bearer ') ? h.slice(7) : '';
  const alt = String(req.headers['x-api-key'] || '');
  return tok || alt || '';
}
function requireAuth(req, res) {
  const expected = loadToken();
  const token = getTokenFromHeaders(req);
  if (!expected || !token || token !== expected) {
    sendJSON(res, 401, { ok:false, error:'unauthorized' });
    return false;
  }
  return true;
}

// read entire request body (size-guarded)
function readBody(req, cb) {
  let n = 0; const chunks = [];
  req.on('data', c => {
    n += c.length;
    if (n > MAX_BYTES) {
      const e = Object.assign(new Error('payload_too_large'), { code: 413 });
      cb(e); try { req.destroy(); } catch {}
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => cb(null, Buffer.concat(chunks)));
  req.on('error', cb);
}

// static: /ai2/static/* (or /static/*) -> ./public/*
function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (!pathname.startsWith(`${BASE_URI}/static/`) && !pathname.startsWith('/static/')) return false;

  const rel0 = pathname.replace(/^\/(ai2\/)?static\//, '');
  const safeRel = rel0.split('/').filter(seg => seg && seg !== '.' && seg !== '..').join('/');
  const file = path.join(STATIC_ROOT, safeRel);

  try {
    const real = fs.realpathSync(file);
    if (!real.startsWith(STATIC_ROOT)) { sendText(res, 403, 'Forbidden\n'); return true; }
    if (!fs.existsSync(real) || !fs.statSync(real).isFile()) { sendText(res, 404, 'Not Found\n'); return true; }

    const ext = path.extname(real).toLowerCase();
    let ct;
    switch (ext) {
      case '.html':
      case '.htm':  ct = 'text/html; charset=UTF-8'; break;
      case '.css':  ct = 'text/css; charset=UTF-8'; break;
      case '.js':   ct = 'application/javascript; charset=UTF-8'; break;
      case '.json': ct = 'application/json; charset=UTF-8'; break;
      case '.txt':
      case '.log':  ct = 'text/plain; charset=UTF-8'; break;
      case '.ico':  ct = 'image/x-icon'; break;
      case '.svg':  ct = 'image/svg+xml'; break;
      case '.png':  ct = 'image/png'; break;
      case '.jpg':
      case '.jpeg': ct = 'image/jpeg'; break;
      case '.gif':  ct = 'image/gif'; break;
      case '.webp': ct = 'image/webp'; break;
      case '.woff':  ct = 'font/woff'; break;
      case '.woff2': ct = 'font/woff2'; break;
      default: return sendText(res, 415, 'Unsupported Media Type\n');
    }

    const data = fs.readFileSync(real);
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') res.end(); else res.end(data);
  } catch {
    sendText(res, 500, 'Static error\n');
  }
  return true;
}

// diff validation helpers
function containsControlBytes(s) { return /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(s); }

function validateUnifiedDiff(diff) {
  // Accept either full unified diff format OR just hunks (for testing/simple cases)
  const hasFullFormat = /^diff --git /m.test(diff);
  const hasHunkFormat = /@@ -\d+,?\d* \+\d+,?\d* @@/m.test(diff);

  if (!hasFullFormat && !hasHunkFormat) {
    return { ok:false, error:'diff_invalid_format' };
  }

  // If full format diff, do structural checks for new files
  if (hasFullFormat && /(^|\n)new file mode \d+/.test(diff)) {
    if (!/(^|\n)new file mode 100644(\r?\n)/.test(diff)) return { ok:false, error:'new_file_mode_must_be_100644' };
    if (!/(^|\n)--- \/dev\/null(\r?\n)/.test(diff))     return { ok:false, error:'new_file_requires_devnull' };
    if (!/(^|\n)\+\+\+ b\/[^\n]+(\r?\n)/.test(diff))    return { ok:false, error:'bad_plus_plus_plus_line' };
  }

  return { ok:true };
}

function execp(cmd, args, opts={}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16*1024*1024, ...(opts||{}) }, (err, stdout, stderr) => {
      if (err) { err.stdout = String(stdout||''); err.stderr = String(stderr||''); return reject(err); }
      resolve({ stdout: String(stdout||''), stderr: String(stderr||'') });
    });
  });
}

// ----- endpoints (write) -----
function handleEcho(req, res) {
  readBody(req, (err, buf) => {
    if (err) return sendJSON(res, err.code === 413 ? 413 : 400, { ok:false, error: err.message || 'read_error' });
    const ct = String(req.headers['content-type'] || '').toLowerCase();

    let body = null, preview = '';
    try {
      if (ct.includes('json')) {
        body = JSON.parse(buf.toString('utf8'));
        if (body && typeof body.diff === 'string') {
          preview = body.diff.slice(0, 200);
        }
      }
    } catch {}

    // redact headers before logging
    const hdr = { ...req.headers };
    if (hdr.authorization) hdr.authorization = '[redacted]';
    if (hdr['x-api-key'])  hdr['x-api-key']  = '[redacted]';

    logDbg({ time: nowISO(), tag:'ECHO', ip: ipOf(req), ct, raw_len: buf.length, headers: hdr });
    return sendJSON(res, 200, { ok:true, ct, raw_len: buf.length, headers: hdr, body, diff_preview: preview });
  });
}

// --- job_submit (commands) ---
function handleJobSubmit(req, res) {
  if (!requireAuth(req, res)) return;

  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) return sendJSON(res, 415, { ok:false, error:'unsupported_media_type' });

  readBody(req, (err, buf) => {
    if (err) return sendJSON(res, err.code === 413 ? 413 : 400, { ok:false, error: err.message || 'read_error' });

    // redact headers before logging
    const hdr = { ...req.headers };
    if (hdr.authorization) hdr.authorization = '[redacted]';
    if (hdr['x-api-key'])  hdr['x-api-key']  = '[redacted]';
    logDbg({ time: nowISO(), tag:'REQ', path: req.url, method: req.method, ct, ip: ipOf(req), headers: hdr });

    let body = {};
    try { body = JSON.parse(buf.toString('utf8') || '{}'); }
    catch { return sendJSON(res, 400, { ok:false, error:'invalid_json' }); }

    const type   = String(body.type || '');
    const schema = Number(body.schema || 0);
    const workdir = body.workdir ? String(body.workdir) : null;
    const steps  = Array.isArray(body.steps) ? body.steps : [];

    if (type !== 'commands') return sendJSON(res, 400, { ok:false, error:'unsupported_type' });
    if (schema !== 1)        return sendJSON(res, 400, { ok:false, error:'bad_schema' });
    if (!steps.length)       return sendJSON(res, 400, { ok:false, error:'no_steps' });

    // idempotency
    const idemHeader = String(req.headers['x-idempotency-key'] || '');
    const idemBody   = String(body.idempotency_key || '');
    const idemVal    = idemHeader || idemBody || '';

    let idemPointerFile = '';
    if (idemVal) {
      const idemFile = path.join(IDEM_DIR, `.idem-${idemSan(idemVal)}`);
      idemPointerFile = idemFile;
      if (fs.existsSync(idemFile)) {
        const existing = (fs.readFileSync(idemFile) + '').trim();
        return sendJSON(res, 200, { ok:true, duplicate_of: path.basename(existing) });
      }
    }

    const id   = `job-${ts()}-${r4()}.json`;
    const file = path.join(QUEUE_DIR, id);
    const job  = {
      enqueued_at: nowISO(),
      from_endpoint: 'job_submit_action_node',
      ip: ipOf(req),
      ua: String(req.headers['user-agent'] || ''),
      type, schema, workdir, steps
    };

    try {
      fs.writeFileSync(file, JSON.stringify(job));
      if (idemVal && idemPointerFile) fs.writeFileSync(idemPointerFile, file);
    } catch (e) {
      logDbg({ time: nowISO(), tag:'QUEUE_WRITE_FAIL', error: String(e) });
      return sendJSON(res, 500, { ok:false, error:'queue_write_failed' });
    }

    logDbg({ time: nowISO(), tag:'ENQUEUED', job: path.basename(file), type, idem: idemVal || null });
    return sendJSON(res, 200, { ok:true, queued: path.basename(file), type });
  });
}

async function handleDiffSubmit(req, res) {
  if (!requireAuth(req, res)) return;

  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) return sendJSON(res, 415, { ok:false, error:'unsupported_media_type' });

  readBody(req, async (err, buf) => {
    if (err) return sendJSON(res, err.code === 413 ? 413 : 400, { ok:false, error: err.message || 'read_error' });

    const hdr = { ...req.headers };
    if (hdr.authorization) hdr.authorization = '[redacted]';
    if (hdr['x-api-key'])  hdr['x-api-key']  = '[redacted]';
    logDbg({ time: nowISO(), tag:'REQ', path: req.url, method: req.method, ct, ip: ipOf(req), headers: hdr });
    logDbg({ time: nowISO(), tag:'REQ_BODY', raw_len: buf.length, json_head: buf.slice(0, 512).toString('utf8') });

    let body = {};
    try { body = JSON.parse(buf.toString('utf8') || '{}'); }
    catch { return sendJSON(res, 400, { ok:false, error:'invalid_json' }); }

    const base         = String(body.base_branch || 'main');
    const rawMessage   = (typeof body.message === 'string' ? body.message.trim() : '');
    const diff         = String(body.diff || '');
    const idemHeader   = String(req.headers['x-idempotency-key'] || '');
    const idemBody     = String(body.idempotency_key || '');
    const idemVal      = idemHeader || idemBody || '';

    const ALLOWED_BRANCHES = new Set(['main', 'master', 'public']);
    if (!ALLOWED_BRANCHES.has(base)) return sendJSON(res, 403, { ok:false, error:'branch_not_allowed' });
    if (!diff) return sendJSON(res, 400, { ok:false, error:'diff_required' });

    logDbg({ time: nowISO(), tag:'DIFF_HEAD', preview: diff.slice(0, 200) });

    if (containsControlBytes(diff)) return sendJSON(res, 400, { ok:false, error:'diff_contains_control_bytes' });
    const v = validateUnifiedDiff(diff);
    if (!v.ok) return sendJSON(res, 400, { ok:false, error: v.error });

    let idemPointerFile = '';
    if (idemVal) {
      const idemFile = path.join(IDEM_DIR, `.idem-${idemSan(idemVal)}`);
      idemPointerFile = idemFile;
      if (fs.existsSync(idemFile)) {
        const existing = (fs.readFileSync(idemFile) + '').trim();
        return sendJSON(res, 200, { ok:true, duplicate_of: path.basename(existing) });
      }
    }

    const id   = `job-${ts()}-${r4()}.json`;
    const file = path.join(QUEUE_DIR, id);
    const job  = {
      enqueued_at: nowISO(),
      from_endpoint: 'diff_submit_action_node',
      ip: ipOf(req),
      ua: String(req.headers['user-agent'] || ''),
      base_branch: base,
      message: (rawMessage || `ChatGPT change ${nowISO()}`),
      diff,
      sha256: sha256S(diff)
    };

    try {
      fs.writeFileSync(file, JSON.stringify(job));
      if (idemVal && idemPointerFile) fs.writeFileSync(idemPointerFile, file);
    } catch (e) {
      logDbg({ time: nowISO(), tag:'QUEUE_WRITE_FAIL', error: String(e) });
      return sendJSON(res, 500, { ok:false, error:'queue_write_failed' });
    }

    logDbg({ time: nowISO(), tag:'ENQUEUED', job: path.basename(file), sha256: job.sha256, msg: job.message, idem: idemVal || null });

    // Try to apply locally (best effort)
    try {
      await applyDiffToRepo(diff, rawMessage || `ChatGPT change ${nowISO()}`);
      logDbg({ time: nowISO(), tag:'APPLIED_LOCALLY', job: path.basename(file) });
    } catch (applyErr) {
      logDbg({ time: nowISO(), tag:'LOCAL_APPLY_FAILED', error: String(applyErr), job: path.basename(file) });
    }

    return sendJSON(res, 200, { ok:true, queued: path.basename(file), sha256: job.sha256 });
  });
}

// Apply diff to the local repository
async function applyDiffToRepo(diff, message) {
  const repo = REPO_ROOT;
  const patchPath = path.join(os.tmpdir(), `patch-${Date.now()}-${r4()}.patch`);

  try {
    await fsp.writeFile(patchPath, diff, 'utf8');
    await execp('git', ['checkout', 'main'], { cwd: repo });
    await execp('git', ['pull', 'origin', 'main'], { cwd: repo });
    await execp('git', ['apply', '--3way', patchPath], { cwd: repo });
    await execp('git', ['add', '-A'], { cwd: repo });
    await execp('git', ['commit', '-m', message], { cwd: repo });
    await execp('git', ['push', 'origin', 'main'], { cwd: repo });
    logDbg({ time: nowISO(), tag:'GIT_PUSH_SUCCESS', message });
  } finally {
    try { await fsp.unlink(patchPath); } catch {}
  }
}

async function handleDiffDryrun(req, res) {
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) return sendJSON(res, 415, { ok:false, error:'unsupported_media_type' });

  readBody(req, async (err, buf) => {
    if (err) return sendJSON(res, err.code === 413 ? 413 : 400, { ok:false, error: err.message || 'read_error' });

    let body = {};
    try { body = JSON.parse(buf.toString('utf8') || '{}'); }
    catch { return sendJSON(res, 400, { ok:false, error:'invalid_json' }); }

    const base_branch = body.base_branch ? String(body.base_branch) : 'main';
    const diff = body.diff ? String(body.diff) : '';
    if (!diff) return sendJSON(res, 400, { ok:false, error:'missing diff' });

    const patchBuf = Buffer.from(diff, 'utf8');
    if (patchBuf.length > 5 * 1024 * 1024) return sendJSON(res, 413, { ok:false, error:'patch too large (>5MB)' });

    const v = validateUnifiedDiff(diff);
    if (!v.ok) return sendJSON(res, 400, { ok:false, error: v.error });

    const repo = __dirname;
    const tmpDir = path.join(os.tmpdir(), `ai2-dryrun-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await fsp.mkdir(tmpDir, { recursive:true });
      await execp('git', ['fetch', '--depth=1', 'origin', base_branch], { cwd: repo });
      await execp('git', ['worktree', 'add', '--detach', '--force', tmpDir, `origin/${base_branch}`], { cwd: repo });

      const patchPath = path.join(tmpDir, 'incoming.patch');
      await fsp.writeFile(patchPath, patchBuf);

      try {
        await execp('git', ['apply', '--check', '--3way', '--unsafe-paths', patchPath], { cwd: tmpDir });
        return sendJSON(res, 200, { ok:true });
      } catch (e) {
        return sendJSON(res, 422, { ok:false, error:'git apply --check failed', detail: e.stderr || e.stdout || String(e) });
      } finally {
        try { await execp('git', ['worktree', 'remove', '--force', tmpDir], { cwd: repo }); } catch {}
      }
    } catch (e) {
      try { await execp('git', ['worktree', 'remove', '--force', tmpDir], { cwd: repo }); } catch {}
      return sendJSON(res, 500, { ok:false, error: e.message || String(e) });
    }
  });
}

// ----- repo browsing (read-only) -----
function safeJoin(root, userPath){
  const p = path.normalize('/' + String(userPath || '').replace(/^\/+/, ''));
  const full = path.join(root, '.' + p);
  if (!full.startsWith(root)) throw new Error('path_traversal');
  return full;
}
function isHiddenName(n){ return n.startsWith('.') && !['.htaccess','.htpasswd'].includes(n); }

function handleRepoList(req, res) {
  if (!requireAuth(req, res)) return;

  const parsed = url.parse(req.url, true);
  const rel = String(parsed.query.path || '');
  let depth = parseInt(String(parsed.query.depth || '1'), 10);
  if (isNaN(depth) || depth < 0) depth = 1;
  if (depth > LIST_MAX_DEPTH) depth = LIST_MAX_DEPTH;

  let root;
  try { root = safeJoin(REPO_ROOT, rel); }
  catch { return sendJSON(res, 400, { ok:false, error:'bad path' }); }

  if (!fs.existsSync(root)) return sendJSON(res, 200, { ok:true, path: rel, items: [] });

  function walk(dir, d, prefix) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (HIDDEN_DIRS.has(e.name) || HIDDEN_TOP.has(e.name) || isHiddenName(e.name)) continue;
      const abs = path.join(dir, e.name);
      const relp = path.posix.join(prefix, e.name);
      try {
        const st = fs.statSync(abs);
        out.push({
          path: relp,
          type: e.isDirectory() ? 'dir' : 'file',
          size: st.size,
          mtime: Math.floor(st.mtimeMs / 1000)
        });
        if (e.isDirectory() && d > 0) out.push(...walk(abs, d - 1, relp));
      } catch {}
    }
    return out;
  }

  const prefix = rel.replace(/^\/+/, '');
  return sendJSON(res, 200, { ok:true, path: rel, items: walk(root, depth, prefix) });
}

function handleRepoGet(req, res) {
  if (!requireAuth(req, res)) return;

  const parsed = url.parse(req.url, true);
  const rel = String(parsed.query.path || '');

  let abs;
  try { abs = safeJoin(REPO_ROOT, rel); }
  catch { return sendJSON(res, 400, { ok:false, error:'bad path' }); }

  if (!fs.existsSync(abs)) return sendJSON(res, 404, { ok:false, error:'not found' });

  const st = fs.statSync(abs);
  if (!st.isFile()) return sendJSON(res, 400, { ok:false, error:'not a file' });
  if (st.size > GET_MAX_BYTES) return sendJSON(res, 413, { ok:false, error:'file too large', limit: GET_MAX_BYTES });

  const buf = fs.readFileSync(abs);
  return sendJSON(res, 200, {
    ok: true,
    path: rel,
    size: buf.length,
    mtime: Math.floor(st.mtimeMs / 1000),
    content_b64: buf.toString('base64')
  });
}

// ----- jobs list/log (read-only) -----
function handleJobsList(req, res) {
  if (!requireAuth(req, res)) return;
  const parsed = url.parse(req.url, true);
  const state = String(parsed.query.state || 'queue');
  let limit = parseInt(String(parsed.query.limit || '100'), 10);
  if (isNaN(limit) || limit <= 0) limit = 100;

  let dir;
  if (state === 'queue') dir = QUEUE_DIR;
  else if (state === 'done') dir = DONE_DIR;
  else if (state === 'fail') dir = FAIL_DIR;
  else return sendJSON(res, 400, { ok:false, error:'bad_state' });

  let items = [];
  try {
    items = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ file: f, mtime: Math.floor(fs.statSync(path.join(dir, f)).mtimeMs / 1000) }))
      .sort((a,b) => b.mtime - a.mtime)
      .slice(0, limit);
  } catch {
    items = [];
  }
  return sendJSON(res, 200, { ok:true, state, count: items.length, items });
}

function handleJobsLog(req, res) {
  if (!requireAuth(req, res)) return;
  const parsed = url.parse(req.url, true);
  const raw = String(parsed.query.file || '');
  const fname = safeJobBasename(raw);
  if (!fname) return sendJSON(res, 400, { ok:false, error:'bad_file' });

  // If a .log is requested -> return text tail
  if (fname.endsWith('.log')) {
    const lines = parseInt(String(parsed.query.lines || '200'), 10) || 200;
    const logPath = path.join(LOG_DIR, fname);
    try {
      if (!fs.existsSync(logPath) || !fs.statSync(logPath).isFile()) return sendJSON(res, 400, { ok:false, error:'bad_file' });
      const buf = fs.readFileSync(logPath, 'utf8');
      const arr = buf.split(/\r?\n/);
      const tail = arr.slice(-lines).join('\n');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8' });
      return res.end(tail);
    } catch {
      return sendJSON(res, 500, { ok:false, error:'read_error' });
    }
  }

  // If a .json job file is requested -> return raw JSON from state dirs
  if (fname.endsWith('.json')) {
    const candidates = [
      path.join(DONE_DIR, fname),
      path.join(FAIL_DIR, fname),
      path.join(QUEUE_DIR, fname),
    ];
    let found = null;
    for (const p of candidates) {
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) { found = p; break; }
      } catch {}
    }
    if (!found) return sendJSON(res, 400, { ok:false, error:'bad_file' });
    try {
      const text = fs.readFileSync(found, 'utf8');
      let obj;
      try { obj = JSON.parse(text); }
      catch { return sendJSON(res, 422, { ok:false, error:'invalid_json_in_job' }); }
      return sendJSON(res, 200, obj);
    } catch {
      return sendJSON(res, 500, { ok:false, error:'read_error' });
    }
  }

  // Anything else is invalid
  return sendJSON(res, 400, { ok:false, error:'bad_file' });
}

// ----- router -----
function handler(req, res) {
  const pathname = url.parse(req.url).pathname || '';

  // serve static first
  if (serveStatic(req, res, pathname)) return;

  // health
  if (req.method === 'GET' && (pathname === `${BASE_URI}/_health` || pathname === '/_health'))
    return sendJSON(res, 200, { ok:true, time: nowISO() });
  if (req.method === 'GET' && (pathname === `${BASE_URI}/health` || pathname === '/health'))
    return sendJSON(res, 200, { ok:true, time: nowISO() });

  // debug (which node, passenger env)
  if (req.method === 'GET' && (pathname === `${BASE_URI}/debug` || pathname === '/debug'))
    return sendJSON(res, 200, {
      ok: true,
      underPassenger: !!process.env.PASSENGER_APP_ENV,
      node: process.version,
      port: process.env.PORT || process.env.PASSENGER_PORT || null,
      cwd: process.cwd(),
      time: nowISO()
    });

  // version
  if (req.method === 'GET' && (pathname === `${BASE_URI}/version` || pathname === '/version')) {
    let rev = 'unknown';
    try { rev = fs.readFileSync(VERSION_FILE, 'utf8').trim(); } catch {}
    return sendJSON(res, 200, { ok:true, version: rev });
  }

  // echo (debug)
  if (req.method === 'POST' && (pathname === `${BASE_URI}/echo` || pathname === '/echo'))
    return handleEcho(req, res);

  // submit commands job (auth required)
  if (req.method === 'POST' && (pathname === `${BASE_URI}/job_submit` || pathname === '/job_submit'))
    return handleJobSubmit(req, res);

  // submit diff (auth required)
  if (req.method === 'POST' && (pathname === `${BASE_URI}/diff_submit` || pathname === '/diff_submit'))
    return handleDiffSubmit(req, res);

  // dryrun (no auth; safe validation only)
  if (req.method === 'POST' && (pathname === `${BASE_URI}/diff_dryrun` || pathname === '/diff_dryrun'))
    return handleDiffDryrun(req, res);

  // repo browsing (auth required)
  if (req.method === 'GET' && (
      pathname === `${BASE_URI}/repo/list` || pathname === '/repo/list' ||
      pathname === `${BASE_URI}/fs/list`   || pathname === '/fs/list'   ||
      pathname === `${BASE_URI}/list`
    )) return handleRepoList(req, res);

  if (req.method === 'GET' && (
      pathname === `${BASE_URI}/repo/get`  || pathname === '/repo/get'  ||
      pathname === `${BASE_URI}/fs/get`    || pathname === '/fs/get'    ||
      pathname === `${BASE_URI}/get`
    )) return handleRepoGet(req, res);

  // jobs (auth required) — ADDED ABOVE 404
  if (req.method === 'GET' && (pathname === `${BASE_URI}/jobs/list` || pathname === '/jobs/list'))
    return handleJobsList(req, res);
  if (req.method === 'GET' && (pathname === `${BASE_URI}/jobs/log` || pathname === '/jobs/log'))
    return handleJobsLog(req, res);

  // root banner
  if (req.method === 'GET' && (pathname === `${BASE_URI}/` || pathname === '/'))
    return sendText(res, 200, 'OK (ai2)\n');

  // fallback
  return sendText(res, 404, 'Not Found\n');
}

// ----- start server (Passenger sets PORT) -----
process.on('uncaughtException', e => console.error('[ai2] uncaughtException:', e));
process.on('unhandledRejection', e => console.error('[ai2] unhandledRejection:', e));
console.log(`[ai2] starting with Node ${process.version}, PORT=${process.env.PORT || '(none)'} at ${nowISO()}`);

const PORT = process.env.PORT || 3000;
http.createServer(handler).listen(PORT, () => {
  logDbg({ tag: 'boot', time: nowISO(), msg: `listening PORT=${PORT}` });
});
