'use strict';

/**
 * BeloCloud Actions mini-server (no external deps).
 *
 * Public:
 *   GET/HEAD  /ai2/                 -> "OK (ai2)"
 *   GET/HEAD  /ai2/_health          -> { ok:true, time }
 *   GET/HEAD  /ai2/health           -> alias of /ai2/_health
 *   GET/HEAD  /ai2/version          -> { ok:true, version }
 *   GET/HEAD  /ai2/static/<file>    -> serve ./public/<file> (wide, safe types)
 *   GET/HEAD  /ai2/debug            -> debug info (node version, env)
 *   POST      /ai2/echo             -> debug echo; shows headers/body + decoded preview
 *
 * Actions (write; require token):
 *   POST /ai2/job_submit            -> enqueue a commands job (picked by worker)
 *   POST /ai2/diff_submit           -> enqueue a unified diff (as type=patch, schema=1)
 *
 * Repo browsing (read-only; require token):
 *   GET /ai2/repo/list?path=&depth=
 *   GET /ai2/repo/get?path=relative/path
 *   Aliases: /repo/list, /repo/get, /ai2/fs/list, /ai2/fs/get, /fs/list, /fs/get
 *   Short aliases: /ai2/list, /ai2/get
 *
 * Queue introspection (require token):
 *   GET /ai2/jobs/list?state=queue|done|fail&limit=100
 *   GET /ai2/jobs/log?file=job-*.json[.log]&lines=200
 *
 * Queue ops (stubs; require token):
 *   POST /ai2/job/requeue
 *   POST /ai2/job/cancel
 */

const http   = require('http');
const fs     = require('fs');
const fsp    = require('fs/promises');
const path   = require('path');
const crypto = require('crypto');
const url    = require('url');
const os     = require('os');
const { execFile, execFileSync } = require('child_process');

/* ---------------- Sentry (optional; env-driven) ---------------- */
let Sentry = null;
try {
  // Only loads if installed; safe to skip otherwise
  Sentry = require('@sentry/node');

  const integrations = [];
  if (Sentry.consoleLoggingIntegration) {
    integrations.push(Sentry.consoleLoggingIntegration({ levels: ['log', 'warn', 'error'] }));
  } else if (Sentry.consoleIntegration) {
    integrations.push(Sentry.consoleIntegration({ levels: ['log', 'warn', 'error'] }));
  }

  Sentry.init({
    dsn: process.env.SENTRY_DSN || undefined,      // set via systemd env or skip
    environment: process.env.SENTRY_ENV || 'production',
    integrations,
    tracesSampleRate: 0.0
  });

  process.on('uncaughtException', (e) => { try { Sentry.captureException(e); } catch {} });
  process.on('unhandledRejection', (r) => {
    try { Sentry.captureException(r instanceof Error ? r : new Error(String(r))); } catch {}
  });

  console.info('[ai2] Sentry initialized');
} catch (e) {
  console.warn('[ai2] Sentry not loaded (optional):', e && e.message ? e.message : e);
}
/* ---------------- end Sentry ---------------- */

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
for (const d of [QUEUE_DIR, DONE_DIR, FAIL_DIR, LOG_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
}

// Lazily load token (don’t crash if unreadable)
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

  
if (!real.startsWith(STATIC_ROOT)) { sendText(res, 403, 'Forbidden\n'); return true; }
    if (!fs.existsSync(real) || !fs.statSync(real).isFile()) { sendText(res, 404, 'Not Found\n'); return true; }

    const ext = path.extname(real).toLowerCase();
    const map = {
      '.html':'text/html; charset=UTF-8','.htm':'text/html; charset=UTF-8',
      '.css':'text/css; charset=UTF-8','.js':'application/javascript; charset=UTF-8',
      '.json':'application/json; charset=UTF-8','.txt':'text/plain; charset=UTF-8',
      '.log':'text/plain; charset=UTF-8','.ico':'image/x-icon','.svg':'image/svg+xml',
      '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif',
      '.webp':'image/webp','.woff':'font/woff','.woff2':'font/woff2'
    };
    const ct = map[ext]; if (!ct) return sendText(res, 415, 'Unsupported Media Type\n');

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
  if (!hasFullFormat && !hasHunkFormat) return { ok:false, error:'diff_invalid_format' };

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

// ----- endpoints (public) -----
function handleEcho(req, res) {
  readBody(req, (err, buf) => {
    if (err) return sendJSON(res, err.code === 413 ? 413 : 400, { ok:false, error: err.message || 'read_error' });
    const ct = String(req.headers['content-type'] || '').toLowerCase();

    let body = null, preview = '';
    try {
      if (ct.includes('json')) {
        body = JSON.parse(buf.toString('utf8'));
        if (body && typeof body.diff === 'string') preview = body.diff.slice(0, 200);
      }
    } catch {}

    const hdr = { ...req.headers };
    if (hdr.authorization) hdr.authorization = '[redacted]';
    if (hdr['x-api-key'])  hdr['x-api-key']  = '[redacted]';

    logDbg({ time: nowISO(), tag:'ECHO', ip: ipOf(req), ct, raw_len: buf.length, headers: hdr });
    return sendJSON(res, 200, { ok:true, ct, raw_len: buf.length, headers: hdr, body, diff_preview: preview });
  });
}

// ----- endpoints (write; require auth) -----
function handleJobSubmit(req, res) {
  if (!requireAuth(req, res)) return;
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) return sendJSON(res, 415, { ok:false, error:'unsupported_media_type' });

  readBody(req, (err, buf) => {
    if (err) return sendJSON(res, err.code === 413 ? 413 : 400, { ok:false, error: err.message || 'read_error' });

    const hdr = { ...req.headers };
    if (hdr.authorization) hdr.authorization = '[redacted]';
    if (hdr['x-api-key'])  hdr['x-api-key']  = '[redacted]';
    logDbg({ time: nowISO(), tag:'REQ', path: req.url, method: req.method, ct, ip: ipOf(req), headers: hdr });

    let body = {};
    try { body = JSON.parse(buf.toString('utf8') || '{}'); }
    catch { return sendJSON(res, 400, { ok:false, error:'invalid_json' }); }

    const type    = String(body.type || '');
    const schema  = Number(body.schema || 0);
    const workdir = body.workdir ? String(body.workdir) : null;
    const steps   = Array.isArray(body.steps) ? body.steps : [];

    if (type !== 'commands') return sendJSON(res, 400, { ok:false, error:'unsupported_type' });
    if (schema !== 1)        return sendJSON(res, 400, { ok:false, error:'bad_schema' });
    if (!steps.length)       return sendJSON(res, 400, { ok:false, error:'no_steps' });

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

    // Sentry breadcrumb
    try {
      if (Sentry) {
        Sentry.withScope(scope => {
          scope.setTag('job', path.basename(file));
          scope.setTag('type', 'commands');
          scope.setTag('endpoint', 'job_submit');
          scope.setExtras({ ip: ipOf(req), ua: String(req.headers['user-agent'] || ''), idem: idemVal || null });
          Sentry.captureMessage(`AI2 job enqueued: ${path.basename(file)}`, 'info');
        });
      }
    } catch {}

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

    const base         = String(body.base_branch || 'public'); // default to public
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
      type: 'patch',
      schema: 1,
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

    // Sentry breadcrumb
    try {
      if (Sentry) {
        Sentry.withScope(scope => {
          scope.setTag('job', path.basename(file));
          scope.setTag('type', 'patch');
          scope.setTag('endpoint', 'diff_submit');
          scope.setTag('base_branch', base);
          scope.setExtras({
            ip: ipOf(req), ua: String(req.headers['user-agent'] || ''),
            idem: idemVal || null, sha256: job.sha256
          });
          Sentry.captureMessage(`AI2 patch enqueued: ${path.basename(file)}`, 'info');
        });
      }
    } catch {}

    // Best-effort local apply to REPO_ROOT on the same branch (does not affect queue)
    try {
      await applyDiffToRepo(diff, rawMessage || `ChatGPT change ${nowISO()}`, base);
      logDbg({ time: nowISO(), tag:'APPLIED_LOCALLY', job: path.basename(file), base });
    } catch (applyErr) {
      logDbg({ time: nowISO(), tag:'LOCAL_APPLY_FAILED', error: String(applyErr), job: path.basename(file), base });
      try { if (Sentry) Sentry.captureException(applyErr); } catch {}
    }

    return sendJSON(res, 200, { ok:true, queued: path.basename(file), type: 'patch', sha256: job.sha256 });
  });
}

// Apply diff to the local repository (branch-aware)
async function applyDiffToRepo(diff, message, baseBranch = 'public') {
  const repo = REPO_ROOT;
  const patchPath = path.join(os.tmpdir(), `patch-${Date.now()}-${r4()}.patch`);
  try {
    await fsp.writeFile(patchPath, diff, 'utf8');
    await execp('git', ['checkout', baseBranch], { cwd: repo });
    await execp('git', ['pull', 'origin', baseBranch], { cwd: repo });
    await execp('git', ['apply', '--3way', patchPath], { cwd: repo });
    await execp('git', ['add', '-A'], { cwd: repo });

    // Commit only if there are staged changes
    let hasChanges = true;
    try {
      await execp('git', ['diff', '--cached', '--quiet'], { cwd: repo });
      hasChanges = false; // exit 0 => no staged changes
    } catch { hasChanges = true; }

    if (hasChanges) {
      await execp('git', ['commit', '-m', message], { cwd: repo });
    }
    await execp('git', ['push', 'origin', baseBranch], { cwd: repo });
    logDbg({ time: nowISO(), tag:'GIT_PUSH_SUCCESS', message, baseBranch });
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

    const base_branch = body.base_branch ? String(body.base_branch) : 'public';
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

// ----- repo browsing (read-only; require auth) -----
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

// ----- jobs list/log (read-only; require auth) -----
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
  } catch { items = []; }
  return sendJSON(res, 200, { ok:true, state, count: items.length, items });
}

function handleJobsLog(req, res) {
  if (!requireAuth(req, res)) return;
  const parsed = url.parse(req.url, true);
  const raw = String(parsed.query.file || '');
  const fname = safeJobBasename(raw);
  if (!fname) return sendJSON(res, 400, { ok:false, error:'bad_file' });

  // .log -> tail text (primary: LOG_DIR/fname; optionally allow agent subdirs via raw)
  if (fname.endsWith('.log')) {
    const lines = parseInt(String(parsed.query.lines || '200'), 10) || 200;
    let logPath = path.join(LOG_DIR, fname);

    // Optional: allow done/<name>.log or failures/<name>.log if it resolves under allowed roots
    try {
      if (raw.includes('/')) {
        const abs = fs.realpathSync(path.join('/home/genweb/agent', raw));
        const allowedRoots = [LOG_DIR, DONE_DIR, FAIL_DIR].map(r => fs.realpathSync(r));
        if (allowedRoots.some(r => abs === r || abs.startsWith(r + path.sep))) {
          logPath = abs;
        }
      }
    } catch { /* fallback to LOG_DIR/fname */ }

    try {
      if (!fs.existsSync(logPath) || !fs.statSync(logPath).isFile()) return sendJSON(res, 404, { ok:false, error:'not_found' });
      const buf = fs.readFileSync(logPath, 'utf8');
      const arr = buf.split(/\r?\n/);
      const tail = arr.slice(-lines).join('\n');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8' });
      return res.end(tail);
    } catch {
      return sendJSON(res, 500, { ok:false, error:'read_error' });
    }
  }

  // .json -> return job JSON from any state dir (by filename only)
  if (fname.endsWith('.json')) {
    const candidates = [
      path.join(DONE_DIR, fname),
      path.join(FAIL_DIR, fname),
      path.join(QUEUE_DIR, fname),
    ];
    let found = null;
    for (const pth of candidates) {
      try { if (fs.existsSync(pth) && fs.statSync(pth).isFile()) { found = pth; break; } } catch {}
    }
    if (!found) return sendJSON(res, 404, { ok:false, error:'not_found' });
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

  return sendJSON(res, 400, { ok:false, error:'bad_file' });
}

// ----- queue ops (stubs; require auth) -----
function handleJobRequeue(_req, res){ if (!requireAuth(_req, res)) return; sendJSON(res, 501, { ok:false, error:'not_implemented' }); }
function handleJobCancel (_req, res){ if (!requireAuth(_req, res)) return; sendJSON(res, 501, { ok:false, error:'not_implemented' }); }

// ----- tiny route matcher -----
// Matches either ${BASE_URI}${p} or bare ${p}; supports GET/HEAD/POST.
function isRoute(req, pathname, methods, p) {
  const okMethod = Array.isArray(methods) ? methods.includes(req.method) : req.method === methods;
  return okMethod && (pathname === `${BASE_URI}${p}` || pathname === p);
}

// ----- router -----
function handler(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '';

  // static first
  if (serveStatic(req, res, pathname)) return;

  // health
  if (isRoute(req, pathname, ['GET','HEAD'], '/_health'))
    return sendJSON(res, 200, { ok:true, time: nowISO() });
  if (isRoute(req, pathname, ['GET','HEAD'], '/health'))
    return sendJSON(res, 200, { ok:true, time: nowISO() });

  // debug (GET only)
  if (isRoute(req, pathname, 'GET', '/debug')) {
    // /ai2/debug?log=Your+message → info log to Sentry
    if (parsed.query && parsed.query.log && Sentry) {
      try {
        Sentry.withScope(scope => {
          scope.setTag('endpoint','debug');
          scope.setExtras({ ip: ipOf(req), ua: String(req.headers['user-agent'] || '') });
          Sentry.captureMessage(String(parsed.query.log), 'info');
        });
      } catch {}
    }
    // /ai2/debug?boom=1 → simulate an exception (error event)
    if (parsed.query && parsed.query.boom && Sentry) {
      try { throw new Error('Manual Sentry test error (boom=1)'); } catch (e) { Sentry.captureException(e); }
    }

    const dsnMasked = (process.env.SENTRY_DSN || '').replace(/https?:\/\/([^@]+)@/, 'https://***@');
    return sendJSON(res, 200, {
      ok: true,
      underPassenger: !!process.env.PASSENGER_APP_ENV,
      node: process.version,
      port: process.env.PORT || process.env.PASSENGER_PORT || null,
      cwd: process.cwd(),
      time: nowISO(),
      sentry: {
        enabled: Boolean(process.env.SENTRY_DSN),
        env: process.env.SENTRY_ENV || null,
        dsn_present: Boolean(process.env.SENTRY_DSN),
        dsn_masked: dsnMasked || null
      }
    });
  }

  // version (reads VERSION.txt; falls back to git rev)
  if (isRoute(req, pathname, ['GET','HEAD'], '/version')) {
    let rev = '';
    try { rev = fs.readFileSync(VERSION_FILE, 'utf8').trim(); } catch {}
    if (!rev) {
      try { rev = execFileSync('git', ['rev-parse','--short','HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(); }
      catch { rev = 'unknown'; }
    }
    return sendJSON(res, 200, { ok:true, version: rev || 'unknown' });
  }

  // echo
  if (isRoute(req, pathname, 'POST', '/echo'))
    return handleEcho(req, res);

  // submit commands job
  if (isRoute(req, pathname, 'POST', '/job_submit'))
    return handleJobSubmit(req, res);

  // submit diff
  if (isRoute(req, pathname, 'POST', '/diff_submit'))
    return handleDiffSubmit(req, res);

  // dryrun (no auth)
  if (isRoute(req, pathname, 'POST', '/diff_dryrun'))
    return handleDiffDryrun(req, res);

  // repo browsing (list)
  if (
    isRoute(req, pathname, 'GET', '/repo/list') ||
    isRoute(req, pathname, 'GET', '/fs/list')   ||
    isRoute(req, pathname, 'GET', '/list')
  ) return handleRepoList(req, res);

  // repo browsing (get)
  if (
    isRoute(req, pathname, 'GET', '/repo/get') ||
    isRoute(req, pathname, 'GET', '/fs/get')   ||
    isRoute(req, pathname, 'GET', '/get')
  ) return handleRepoGet(req, res);

  // jobs
  if (isRoute(req, pathname, 'GET', '/jobs/list'))
    return handleJobsList(req, res);
  if (isRoute(req, pathname, 'GET', '/jobs/log'))
    return handleJobsLog(req, res);

  // queue ops
  if (isRoute(req, pathname, 'POST', '/job/requeue'))
    return handleJobRequeue(req, res);
  if (isRoute(req, pathname, 'POST', '/job/cancel'))
    return handleJobCancel(req, res);

  // redirect /ai2 -> /ai2/
  if (isRoute(req, pathname, ['GET','HEAD'], ''))
    if (pathname === BASE_URI) { res.writeHead(301, { Location: `${BASE_URI}/` }); return res.end(); }

  // root banner
  if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === `${BASE_URI}/` || pathname === '/'))
    return sendText(res, 200, 'OK (ai2)\n');

  // fallback
  return sendText(res, 404, 'Not Found\n');
}

// ----- start server -----
process.on('uncaughtException', e => console.error('[ai2] uncaughtException:', e));
process.on('unhandledRejection', e => console.error('[ai2] unhandledRejection:', e));
console.log(`[ai2] starting with Node ${process.version}, PORT=${process.env.PORT || '(none)'} at ${nowISO()}`);

const PORT = process.env.PORT || 3000;
http.createServer(handler).listen(PORT, () => {
  logDbg({ tag: 'boot', time: nowISO(), msg: `listening PORT=${PORT}` });
});
