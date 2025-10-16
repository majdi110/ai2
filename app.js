'use strict';

/**
 * BeloCloud Actions mini-server (no external deps).
 *
 * Public:
 *   GET/HEAD  /ai2/                 -> "OK (ai2)"
 *   GET/HEAD  /ai2/_health          -> { ok:true, time }
 *   GET/HEAD  /ai2/health           -> alias of /ai2/_health
 *   GET/HEAD  /ai2/version          -> { ok:true, version }
 *   GET/HEAD  /ai2/static/<file>    -> serve ./public/<file> (safe types)
 *   GET       /ai2/debug            -> debug info (node version, env)
 *   POST      /ai2/echo             -> debug echo; shows headers/body + decoded preview
 *   POST      /ai2/plan             -> OpenAI-backed planner (returns/queues patch & command jobs)
 *
 * Actions (write; require token):
 *   POST /ai2/job_submit            -> enqueue a commands job (picked by worker)
 *   POST /ai2/diff_submit           -> enqueue a unified diff (as type=patch, schema=1)  [Phase1: requires X-Idempotency-Key]
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
const https  = require('https');
const fs     = require('fs');
const fsp    = require('fs/promises');
const path   = require('path');
const crypto = require('crypto');
const url    = require('url');
const os     = require('os');
const { execFile, execFileSync } = require('child_process');

/* ---------------- Phase 1: constants & helpers ---------------- */
const CANONICAL_BRANCH = 'public';
const ALLOWED_BRANCHES = new Set([CANONICAL_BRANCH]);

// Size caps (tight for plan & diffs; large global cap remains for generic endpoints)
const MAX_DIFF_BYTES       = 200 * 1024;     // 200KB per diff
const MAX_PLAN_BODY_BYTES  = 256 * 1024;     // /plan & dryrun payload cap
const MAX_PROMPT_CHARS     = 16 * 1024;      // 16K prompt text cap

// Dry-run public endpoint throttling + optional low-trust key
const DRYRUN_RL_PER_MIN    = 10;             // 10 requests/min/IP
const DRYRUN_KEY           = process.env.DRYRUN_KEY || '';

// ---- GLOBAL (multi-process) rate limiter: file-based buckets ----
const RL_DIR = '/home/genweb/agent/rl';
try { fs.mkdirSync(RL_DIR, { recursive: true, mode: 0o700 }); } catch {}

function withFileLock(lockPath, fn) {
  // simple atomic lock via mkdir; short spin-wait
  const start = Date.now();
  while (true) {
    try { fs.mkdirSync(lockPath, 0o700); break; }
    catch (e) {
      if (e && e.code !== 'EEXIST') throw e;
      if (Date.now() - start > 200) throw new Error('rl_lock_timeout');
    }
  }
  try { return fn(); }
  finally { try { fs.rmdirSync(lockPath); } catch {} }
}

function allowDryrun(ipRaw) {
  const ip = String(ipRaw || 'unknown').split(',')[0].trim() || 'unknown';
  const key = ip.replace(/[^A-Za-z0-9:._-]/g, '_') || 'unknown';
  const statePath = path.join(RL_DIR, key + '.json');
  const lockPath  = path.join(RL_DIR, '.lock-' + key);

  try {
    return withFileLock(lockPath, () => {
      let st = { tokens: DRYRUN_RL_PER_MIN, ts: Date.now() };
      try { st = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
      const now = Date.now();
      const per = 60_000;
      const max = DRYRUN_RL_PER_MIN;

      const elapsed = now - (st.ts || 0);
      const refill = Math.floor(elapsed / (per / max)); // token every 6s if max=10
      if (refill > 0) {
        st.tokens = Math.min(max, (st.tokens || 0) + refill);
        st.ts = now;
      }

      if ((st.tokens || 0) <= 0) { fs.writeFileSync(statePath, JSON.stringify(st), 'utf8'); return false; }
      st.tokens = (st.tokens || 0) - 1;
      st.ts = now;
      fs.writeFileSync(statePath, JSON.stringify(st), 'utf8');
      return true;
    });
  } catch {
    // fail-open to avoid accidental outage; flip to "return false" if you prefer fail-closed
    return true;
  }
}

// Idempotency store (file-based, body-hash keyed)
const IDEMP_STORE_DIR = '/home/genweb/agent/idempotency';
try { fs.mkdirSync(IDEMP_STORE_DIR, { recursive: true }); } catch {}
function sha256(s){ return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function readJsonSafe(p){ try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return null; } }
function writeJsonSafe(p,obj){ fs.writeFileSync(p, JSON.stringify(obj), 'utf8'); }
function checkIdempotencyOr409(key, bodyStr){
  if(!key) return { ok:false, code:400, msg:'Missing X-Idempotency-Key' };
  const file = path.join(IDEMP_STORE_DIR, key + '.json');
  const hash = sha256(bodyStr);
  const existing = readJsonSafe(file);
  if(existing && existing.hash && existing.hash !== hash){
    return { ok:false, code:409, msg:'Idempotency conflict: body differs for same key' };
  }
  writeJsonSafe(file, { key, hash, ts: Date.now() });
  return { ok:true };
}

function enforceCanonicalBranch(branch) {
  const b = (branch || '').trim() || CANONICAL_BRANCH;
  if(!ALLOWED_BRANCHES.has(b)) {
    return { ok:false, code:400, msg:`Unsupported base_branch '${b}'. Allowed: ${[...ALLOWED_BRANCHES].join(', ')}` };
  }
  return { ok:true, branch: b };
}
function enforceDiffSize(diffStr){
  const n = Buffer.byteLength(diffStr || '', 'utf8');
  if(n > MAX_DIFF_BYTES){
    return { ok:false, code:413, msg:`Diff too large (${n} bytes). Max ${MAX_DIFF_BYTES}` };
  }
  return { ok:true };
}
/* ---------------- end Phase 1 ---------------- */

/* ---------------- Sentry (optional; env-driven) ---------------- */
let Sentry = null;
try {
  // eslint-disable-next-line import/no-extraneous-dependencies
  Sentry = require('@sentry/node');

  const integrations = [];
  if (Sentry.consoleLoggingIntegration) {
    integrations.push(Sentry.consoleLoggingIntegration({ levels: ['log', 'warn', 'error'] }));
  } else if (Sentry.consoleIntegration) {
    integrations.push(Sentry.consoleIntegration({ levels: ['log', 'warn', 'error'] }));
  }

  Sentry.init({
    dsn: process.env.SENTRY_DSN || undefined,
    environment: process.env.SENTRY_ENV || 'production',
    integrations,
    tracesSampleRate: 0.0
  });

  process.on('uncaughtException', (e) => { try { Sentry.captureException(e); } catch (err) {} });
  process.on('unhandledRejection', (r) => {
    try { Sentry.captureException(r instanceof Error ? r : new Error(String(r))); } catch (err) {}
  });

  console.info('[ai2] Sentry initialized');
} catch (e) {
  // Optional; ignore if not installed
}
/* ---------------- end Sentry ---------------- */

// ----- config -----
const BASE_URI     = '/ai2';

const TOKEN_FILE   = '/home/genweb/agent/ACTION_TOKEN';
const QUEUE_DIR    = '/home/genweb/agent/queue';
const DONE_DIR     = '/home/genweb/agent/done';
const FAIL_DIR     = '/home/genweb/agent/failures';
const LOG_DIR      = '/home/genweb/agent/logs';
const IDEM_DIR     = QUEUE_DIR; // legacy idempotency markers alongside jobs (kept for queue dedupe)
const DEBUG_LOG    = '/home/genweb/agent/last_action_debug.log';

const STATIC_ROOT  = path.join(__dirname, 'public');
const VERSION_FILE = path.join(__dirname, 'VERSION.txt');
const MAX_BYTES    = 512 * 1024; // generic read cap

// Active repo path (this app's own repo)
const REPO_ROOT      = '/home/genweb/public_html/datav.belocloud.com/ai2';
const LIST_MAX_DEPTH = 3;
const GET_MAX_BYTES  = 256 * 1024;

const HIDDEN_DIRS = new Set(['.git', 'node_modules', '.cache', '.cpanel', '.trash']);
const HIDDEN_TOP  = new Set(['.git', 'node_modules', '.env']);

// OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL   = process.env.OPENAI_MODEL   || 'gpt-4.1-mini';

// ----- init -----
for (const d of [QUEUE_DIR, DONE_DIR, FAIL_DIR, LOG_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
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
const ipOf    = (req) => String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '');
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
  } catch (e) {}
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

// small HTTPS JSON POST (Node 16 safe)
function httpsJson({ hostname, path, method='POST', headers={}, bodyObj }) {
  return new Promise((resolve, reject) => {
    const data = bodyObj ? JSON.stringify(bodyObj) : '';
    const opts = {
      hostname,
      port: 443,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      }
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTPS ${res.statusCode}: ${raw.slice(0,400)}`));
        }
        try {
          const json = raw ? JSON.parse(raw) : {};
          resolve(json);
        } catch (e) {
          reject(new Error('bad_json_response'));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// read entire request body with a specific max cap
function readBodyLimited(req, maxBytes, cb) {
  let n = 0; const chunks = [];
  req.on('data', c => {
    n += c.length;
    if (n > maxBytes) {
      const e = Object.assign(new Error('payload_too_large'), { code: 413 });
      cb(e); try { req.destroy(); } catch (er) {}
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => cb(null, Buffer.concat(chunks)));
  req.on('error', cb);
}
// generic (kept for non-critical endpoints)
function readBody(req, cb) { return readBodyLimited(req, MAX_BYTES, cb); }

// static: /ai2/static/* (or /static/*) -> ./public/*
function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (!pathname.startsWith(`${BASE_URI}/static/`) && !pathname.startsWith('/static/')) return false;

  const rel0 = pathname.replace(/^\/(ai2\/)?static\//, '');
  const safeRel = rel0.split('/').filter(seg => seg && seg !== '.' && seg !== '..').join('/');
  const file = path.join(STATIC_ROOT, safeRel);

  try {
    if (!fs.existsSync(file)) { sendText(res, 404, 'Not Found\n'); return true; }

    const real = fs.realpathSync(file);
    if (!real.startsWith(STATIC_ROOT)) { sendText(res, 403, 'Forbidden\n'); return true; }

    const st = fs.statSync(real);
    if (!st.isFile()) { sendText(res, 404, 'Not Found\n'); return true; }

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
  } catch (e) {
    sendText(res, 500, 'Static error\n');
  }
  return true;
}

// diff validation helpers
function containsControlBytes(s) { return /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(s); }
function validateUnifiedDiff(diff) {
  const hasFullFormat = /^diff --git /m.test(diff);
  const hasHunkFormat = /@@ -\d+,?\d* \+\d+,?\d* @@/m.test(diff);
  if (!hasFullFormat && !hasHunkFormat) return { ok:false, error:'diff_invalid_format' };

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

/* ---------- shared enqueue helpers (so /plan can call directly) ---------- */
function enqueueCommandsJob({ schema, steps, workdir, idemVal, reqInfo }) {
  if ((schema|0) !== 1) throw new Error('bad_schema');
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('no_steps');

  const id   = `job-${ts()}-${r4()}.json`;
  const file = path.join(QUEUE_DIR, id);
  const job  = {
    enqueued_at: nowISO(),
    from_endpoint: reqInfo?.from || 'job_submit_action_node',
    ip: reqInfo?.ip || '',
    ua: reqInfo?.ua || '',
    type: 'commands',
    schema: 1,
    workdir: workdir || REPO_ROOT,
    steps
  };

  if (idemVal) {
    const idemFile = path.join(IDEM_DIR, `.idem-${idemSan(idemVal)}`);
    if (fs.existsSync(idemFile)) {
      const existing = (fs.readFileSync(idemFile) + '').trim();
      return { ok:true, duplicate_of: path.basename(existing) };
    }
    fs.writeFileSync(file, JSON.stringify(job));
    fs.writeFileSync(idemFile, file);
  } else {
    fs.writeFileSync(file, JSON.stringify(job));
  }

  return { ok:true, queued: path.basename(file), type: 'commands' };
}

async function applyDiffToRepo(diff, message, baseBranch = CANONICAL_BRANCH) {
  const repo = REPO_ROOT;
  const patchPath = path.join(os.tmpdir(), `patch-${Date.now()}-${r4()}.patch`);
  try {
    await fsp.writeFile(patchPath, diff, 'utf8');
    await execp('git', ['checkout', baseBranch], { cwd: repo });
    await execp('git', ['pull', 'origin', baseBranch], { cwd: repo });
    await execp('git', ['apply', '--3way', patchPath], { cwd: repo });
    await execp('git', ['add', '-A'], { cwd: repo });

    let hasChanges = true;
    try {
      await execp('git', ['diff', '--cached', '--quiet'], { cwd: repo });
      hasChanges = false;
    } catch (e) { hasChanges = true; }

    if (hasChanges) {
      await execp('git', ['commit', '-m', message], { cwd: repo });
    }
    await execp('git', ['push', 'origin', baseBranch], { cwd: repo });
    logDbg({ time: nowISO(), tag:'GIT_PUSH_SUCCESS', message, baseBranch });
  } finally {
    try { await fsp.unlink(patchPath); } catch (e) {}
  }
}

async function gitDryRun(diff, baseBranch=CANONICAL_BRANCH) {
  const repo = __dirname;
  const tmpDir = path.join(os.tmpdir(), `ai2-dryrun-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fsp.mkdir(tmpDir, { recursive:true });
  try {
    await execp('git', ['fetch', '--depth=1', 'origin', baseBranch], { cwd: repo });
    await execp('git', ['worktree', 'add', '--detach', '--force', tmpDir, `origin/${baseBranch}`], { cwd: repo });
    const patchPath = path.join(tmpDir, 'incoming.patch');
    await fsp.writeFile(patchPath, diff, 'utf8');
    await execp('git', ['apply', '--check', '--3way', '--unsafe-paths', patchPath], { cwd: tmpDir });
    return { ok:true };
  } catch (e) {
    return { ok:false, error: e.stderr || e.stdout || String(e) };
  } finally {
    try { await execp('git', ['worktree', 'remove', '--force', tmpDir], { cwd: repo }); } catch (e) {}
  }
}

async function enqueuePatchJob({ base, message, diff, idemVal, reqInfo }) {
  if (!diff) throw new Error('diff_required');
  if (containsControlBytes(diff)) throw new Error('diff_contains_control_bytes');
  const v = validateUnifiedDiff(diff);
  if (!v.ok) throw new Error(v.error);

  // Branch already enforced by caller in Phase 1
  const baseBranch = base || CANONICAL_BRANCH;

  // create queue file
  const id   = `job-${ts()}-${r4()}.json`;
  const file = path.join(QUEUE_DIR, id);
  const job  = {
    enqueued_at: nowISO(),
    from_endpoint: reqInfo?.from || 'diff_submit_action_node',
    ip: reqInfo?.ip || '',
    ua: reqInfo?.ua || '',
    type: 'patch',
    schema: 1,
    base_branch: baseBranch,
    message: (message || `ChatGPT change ${nowISO()}`),
    diff,
    sha256: sha256S(diff)
  };

  if (idemVal) {
    const idemFile = path.join(IDEM_DIR, `.idem-${idemSan(idemVal)}`);
    if (fs.existsSync(idemFile)) {
      const existing = (fs.readFileSync(idemFile) + '').trim();
      return { ok:true, duplicate_of: path.basename(existing) };
    }
    fs.writeFileSync(file, JSON.stringify(job));
    fs.writeFileSync(idemFile, file);
  } else {
    fs.writeFileSync(file, JSON.stringify(job));
  }

  // best-effort local apply
  try {
    await applyDiffToRepo(diff, job.message, baseBranch);
  } catch (e) {
    logDbg({ time: nowISO(), tag:'LOCAL_APPLY_FAILED', error: String(e), job: path.basename(file), base: baseBranch });
    try { if (Sentry) Sentry.captureException(e); } catch (er) {}
  }

  return { ok:true, queued: path.basename(file), type: 'patch', sha256: job.sha256 };
}

/* -------------------- OpenAI plan support -------------------- */
function isObj(x){ return x && typeof x==='object' && !Array.isArray(x); }

function buildPlannerSystemPrompt() {
  return [
    'You are an automation planner that converts a webapp idea into an executable plan for my deployment system.',
    'Output STRICT JSON ONLY with this shape:',
    '{',
    '  "version": 1,',
    '  "plan": [',
    '    // items of two kinds:',
    '    // 1) {"type":"patch","base_branch":"public","message":"...","diff":"<unified diff starting with diff --git>"}',
    '    // 2) {"type":"commands","schema":1,"workdir":"/home/genweb/public_html/datav.belocloud.com/ai2","steps":["..."]}',
    '  ],',
    '  "continue_on_error": false',
    '}',
    'Rules:',
    '- Use only the two supported types above.',
    '- Keep all files under /home/genweb/public_html/datav.belocloud.com/ai2 (web assets in public/*).',
    "- Unified diffs MUST start with 'diff --git ' and be valid git-format patches.",
    '- No comments or markdown outside the JSON.',
  ].join('\n');
}

async function callOpenAIPlan(userPrompt) {
  if (!OPENAI_API_KEY) throw new Error('missing_openai_key');

  const system = buildPlannerSystemPrompt();
  // OpenAI Responses API — JSON output via text.format
  const body = {
    model: OPENAI_MODEL,
    input: [
      { role: 'system', content: system },
      { role: 'user',   content: String(userPrompt) }
    ],
    text: { format: { type: "json_object" } }
  };

  const j = await httpsJson({
    hostname: 'api.openai.com',
    path: '/v1/responses',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    bodyObj: body
  });

  const txt =
    j.output_text ||
    (j.output && j.output[0] && j.output[0].content && j.output[0].content[0] && j.output[0].text) ||
    (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) ||
    '';

  if (!txt) throw new Error('openai_no_output');

  let plan;
  try { plan = JSON.parse(txt); }
  catch (e) { throw new Error('openai_bad_json'); }

  return plan;
}

function validatePlan(plan){
  if (!isObj(plan) || plan.version !== 1 || !Array.isArray(plan.plan)) return 'invalid_plan_root';
  for (let i=0;i<plan.plan.length;i++){
    const p = plan.plan[i];
    if (!isObj(p) || typeof p.type !== 'string') return `plan_item_${i}_missing_type`;
    if (p.type === 'patch') {
      if (typeof p.diff !== 'string' || !p.diff.startsWith('diff --git')) return `plan_item_${i}_bad_diff`;
      if (p.diff.length > MAX_DIFF_BYTES) return `plan_item_${i}_diff_too_large`;
    } else if (p.type === 'commands') {
      if ((p.schema|0) !== 1 || !Array.isArray(p.steps) || p.steps.length === 0) return `plan_item_${i}_bad_commands`;
    } else {
      return `plan_item_${i}_unknown_type`;
    }
  }
  return null;
}

/* ---------------- existing endpoints ---------------- */

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
    } catch (e) {}

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
    catch (e) { return sendJSON(res, 400, { ok:false, error:'invalid_json' }); }

    const type    = String(body.type || '');
    const schema  = Number(body.schema || 0);
    const workdir = body.workdir ? String(body.workdir) : null;
    const steps   = Array.isArray(body.steps) ? body.steps : [];

    if (type !== 'commands') return sendJSON(res, 400, { ok:false, error:'unsupported_type' });

    try {
      const idemHeader = String(req.headers['x-idempotency-key'] || '');
      const idemBody   = String(body.idempotency_key || '');
      const idemVal    = idemHeader || idemBody || '';
      const out = enqueueCommandsJob({
        schema, steps, workdir,
        idemVal,
        reqInfo: { from:'job_submit_action_node', ip: ipOf(req), ua: String(req.headers['user-agent'] || '') }
      });

      try {
        if (Sentry && out.ok && out.queued) {
          Sentry.withScope(scope => {
            scope.setTag('job', out.queued);
            scope.setTag('type', 'commands');
            scope.setTag('endpoint', 'job_submit');
            scope.setExtras({ ip: ipOf(req), ua: String(req.headers['user-agent'] || ''), idem: idemVal || null });
            Sentry.captureMessage(`AI2 job enqueued: ${out.queued}`, 'info');
          });
        }
      } catch (e) {}

      return sendJSON(res, 200, { ok:true, ...out });
    } catch (e) {
      if (String(e.message).startsWith('bad_') || String(e.message).endsWith('_steps')) {
        return sendJSON(res, 400, { ok:false, error: e.message });
      }
      logDbg({ time: nowISO(), tag:'QUEUE_WRITE_FAIL', error: String(e) });
      return sendJSON(res, 500, { ok:false, error:'queue_write_failed' });
    }
  });
}

async function handleDiffSubmit(req, res) {
  if (!requireAuth(req, res)) return;
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) return sendJSON(res, 415, { ok:false, error:'unsupported_media_type' });

  readBodyLimited(req, MAX_PLAN_BODY_BYTES, async (err, buf) => {
    if (err) return sendJSON(res, err.code === 413 ? 413 : 400, { ok:false, error: err.message || 'read_error' });

    const bodyStr = buf.toString('utf8');
    // Phase 1: require idempotency and lock branch
    const idem = String(req.headers['x-idempotency-key'] || '');
    const idemChk = checkIdempotencyOr409(idem, bodyStr);
    if(!idemChk.ok){ return sendJSON(res, idemChk.code, { ok:false, error: idemChk.msg }); }

    let body = {};
    try { body = JSON.parse(bodyStr || '{}'); }
    catch (e) { return sendJSON(res, 400, { ok:false, error:'invalid_json' }); }

    const baseRaw      = String(body.base_branch || CANONICAL_BRANCH);
    const br           = enforceCanonicalBranch(baseRaw);
    if(!br.ok) return sendJSON(res, br.code, { ok:false, error: br.msg });

    const diff         = String(body.diff || '');
    const sizeChk      = enforceDiffSize(diff);
    if(!sizeChk.ok) return sendJSON(res, sizeChk.code, { ok:false, error: sizeChk.msg });

    const rawMessage   = (typeof body.message === 'string' ? body.message.trim() : '');
    const idemBody     = String(body.idempotency_key || '');
    const idemVal      = idem || idemBody || '';

    try {
      const out = await enqueuePatchJob({
        base: br.branch, message: rawMessage, diff, idemVal,
        reqInfo: { from:'diff_submit_action_node', ip: ipOf(req), ua: String(req.headers['user-agent'] || '') }
      });

      try {
        if (Sentry && out.ok && out.queued) {
          Sentry.withScope(scope => {
            scope.setTag('job', out.queued);
            scope.setTag('type', 'patch');
            scope.setTag('endpoint', 'diff_submit');
            scope.setTag('base_branch', br.branch);
            scope.setExtras({ ip: ipOf(req), ua: String(req.headers['user-agent'] || ''), idem: idemVal || null, sha256: out.sha256 || null });
            Sentry.captureMessage(`AI2 patch enqueued: ${out.queued}`, 'info');
          });
        }
      } catch (e) {}

      return sendJSON(res, 200, { ok:true, ...out });
    } catch (e) {
      const msg = String(e && e.message || e);
      const status =
        msg === 'diff_required' || msg === 'diff_contains_control_bytes' || msg.startsWith('diff_')
          ? 400
          : 500;
      return sendJSON(res, status, { ok:false, error: msg });
    }
  });
}

async function handleDiffDryrun(req, res) {
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) return sendJSON(res, 415, { ok:false, error:'unsupported_media_type' });

  // Optional low-trust key
  if (DRYRUN_KEY) {
    const k = req.headers['x-dryrun-key'];
    if (k !== DRYRUN_KEY) return sendJSON(res, 401, { ok:false, error:'unauthorized_dryrun_key' });
  }
  // Global rate limit per IP (works across Passenger workers)
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  if (!allowDryrun(ip)) return sendJSON(res, 429, { ok:false, error:'rate_limit_exceeded' });

  readBodyLimited(req, MAX_PLAN_BODY_BYTES, async (err, buf) => {
    if (err) return sendJSON(res, err.code === 413 ? 413 : 400, { ok:false, error: err.message || 'read_error' });

    let body = {};
    try { body = JSON.parse(buf.toString('utf8') || '{}'); }
    catch (e) { return sendJSON(res, 400, { ok:false, error:'invalid_json' }); }

    const baseRaw = body.base_branch ? String(body.base_branch) : CANONICAL_BRANCH;
    const br = enforceCanonicalBranch(baseRaw);
    if(!br.ok) return sendJSON(res, br.code, { ok:false, error: br.msg });

    const diff = body.diff ? String(body.diff) : '';
    if (!diff) return sendJSON(res, 400, { ok:false, error:'missing diff' });

    const sizeChk = enforceDiffSize(diff);
    if(!sizeChk.ok) return sendJSON(res, sizeChk.code, { ok:false, error: sizeChk.msg });

    const v = validateUnifiedDiff(diff);
    if (!v.ok) return sendJSON(res, 400, { ok:false, error: v.error });

    const out = await gitDryRun(diff, br.branch);
    if (out.ok) return sendJSON(res, 200, { ok:true });
    return sendJSON(res, 422, { ok:false, error:'git apply --check failed', detail: out.error || '' });
  });
}

/* -------------------- NEW: OpenAI-backed /plan -------------------- */
async function handlePlan(req, res) {
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) return sendJSON(res, 415, { ok:false, error:'unsupported_media_type' });

  readBodyLimited(req, MAX_PLAN_BODY_BYTES, async (err, buf) => {
    if (err) return sendJSON(res, err.code === 413 ? 413 : 400, { ok:false, error: err.message || 'read_error' });

    const bodyStr = buf.toString('utf8');

    // Phase 1: require idempotency
    const idem = String(req.headers['x-idempotency-key'] || '');
    const idemChk = checkIdempotencyOr409(idem, bodyStr);
    if(!idemChk.ok){ return sendJSON(res, idemChk.code, { ok:false, error: idemChk.msg }); }

    let body = {};
    try { body = JSON.parse(bodyStr || '{}'); }
    catch (e) { return sendJSON(res, 400, { ok:false, error:'invalid_json' }); }

    const prompt = String(body.prompt || '').trim();
    if (!prompt) return sendJSON(res, 400, { ok:false, error:'prompt_required' });
    if (prompt.length > MAX_PROMPT_CHARS) return sendJSON(res, 413, { ok:false, error:`prompt_too_long`, limit: MAX_PROMPT_CHARS });
    if (!OPENAI_API_KEY) return sendJSON(res, 500, { ok:false, error:'missing_openai_key' });

    const baseRaw = String(body.base_branch || CANONICAL_BRANCH);
    const br = enforceCanonicalBranch(baseRaw);
    if(!br.ok) return sendJSON(res, br.code, { ok:false, error: br.msg });

    // call OpenAI
    let plan;
    try {
      plan = await callOpenAIPlan(prompt);
    } catch (e) {
      return sendJSON(res, 502, { ok:false, error: String(e && e.message || e) });
    }

    const v = validatePlan(plan);
    if (v) return sendJSON(res, 422, { ok:false, error: v, plan });

    const continueOnError = Boolean(plan.continue_on_error);
    const results = [];
    for (let i=0; i<plan.plan.length; i++) {
      const item = plan.plan[i];
      try {
        if (item.type === 'patch') {
          const diff   = String(item.diff || '');
          const sizeChk = enforceDiffSize(diff);
          if(!sizeChk.ok){ results.push({ i, type:'patch', ok:false, error:sizeChk.msg }); if(!continueOnError) break; else continue; }

          // dry-run first on canonical branch
          const check = await gitDryRun(diff, br.branch);
          if (!check.ok) {
            results.push({ i, type:'patch', ok:false, error:'dryrun_failed', detail: (check.error || '').slice(0,400) });
            if (!continueOnError) break;
            else continue;
          }
          const out = await enqueuePatchJob({
            base: br.branch,
            message: String(item.message || `Plan patch ${nowISO()}`),
            diff,
            idemVal: `plan-${sha256(prompt)}-${i}`,
            reqInfo: { from:'plan_endpoint', ip: ipOf(req), ua: String(req.headers['user-agent'] || '') }
          });
          results.push({ i, type:'patch', ok:true, queued: out.queued, sha256: out.sha256 });
        } else if (item.type === 'commands') {
          const schema  = item.schema|0;
          const steps   = Array.isArray(item.steps) ? item.steps.map(x=>String(x)) : [];
          const workdir = item.workdir ? String(item.workdir) : REPO_ROOT;
          const out = enqueueCommandsJob({
            schema, steps, workdir,
            idemVal: `plan-${sha256(prompt)}-${i}`,
            reqInfo: { from:'plan_endpoint', ip: ipOf(req), ua: String(req.headers['user-agent'] || '') }
          });
          results.push({ i, type:'commands', ok:true, queued: out.queued });
        } else {
          results.push({ i, ok:false, error:'unknown_type' });
          if (!continueOnError) break;
        }
      } catch (e) {
        results.push({ i, ok:false, error:String(e && e.message || e).slice(0,400) });
        if (!continueOnError) break;
      }
    }

    try {
      if (Sentry) {
        Sentry.withScope(scope => {
          scope.setTag('endpoint', 'plan');
          scope.setExtras({ items: plan.plan.length, continueOnError, sample: results.slice(0,3) });
          Sentry.captureMessage('AI2 plan processed', 'info');
        });
      }
    } catch (e) {}

    return sendJSON(res, 200, { ok:true, prompt, results, continue_on_error: continueOnError });
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
  catch (e) { return sendJSON(res, 400, { ok:false, error:'bad path' }); }

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
      } catch (er) {}
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
  catch (e) { return sendJSON(res, 400, { ok:false, error:'bad path' }); }

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
  } catch (e) { items = []; }
  return sendJSON(res, 200, { ok:true, state, count: items.length, items });
}

function handleJobsLog(req, res) {
  if (!requireAuth(req, res)) return;
  const parsed = url.parse(req.url, true);
  const raw = String(parsed.query.file || '');
  const fname = safeJobBasename(raw);
  if (!fname) return sendJSON(res, 400, { ok:false, error:'bad_file' });

  if (fname.endsWith('.log')) {
    const lines = parseInt(String(parsed.query.lines || '200'), 10) || 200;
    let logPath = path.join(LOG_DIR, fname);

    try {
      if (raw.includes('/')) {
        const abs = fs.realpathSync(path.join('/home/genweb/agent', raw));
        const allowedRoots = [LOG_DIR, DONE_DIR, FAIL_DIR].map(r => fs.realpathSync(r));
        if (allowedRoots.some(r => abs === r || abs.startsWith(r + path.sep))) {
          logPath = abs;
        }
      }
    } catch (e) {}

    try {
      if (!fs.existsSync(logPath) || !fs.statSync(logPath).isFile()) return sendJSON(res, 404, { ok:false, error:'not_found' });
      const buf = fs.readFileSync(logPath, 'utf8');
      const arr = buf.split(/\r?\n/);
      const tail = arr.slice(-lines).join('\n');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8' });
      return res.end(tail);
    } catch (e) {
      return sendJSON(res, 500, { ok:false, error:'read_error' });
    }
  }

  if (fname.endsWith('.json')) {
    const candidates = [
      path.join(DONE_DIR, fname),
      path.join(FAIL_DIR, fname),
      path.join(QUEUE_DIR, fname),
    ];
    let found = null;
    for (const pth of candidates) {
      try { if (fs.existsSync(pth) && fs.statSync(pth).isFile()) { found = pth; break; } } catch (e) {}
    }
    if (!found) return sendJSON(res, 404, { ok:false, error:'not_found' });
    try {
      const text = fs.readFileSync(found, 'utf8');
      let obj;
      try { obj = JSON.parse(text); }
      catch (e) { return sendJSON(res, 422, { ok:false, error:'invalid_json_in_job' }); }
      return sendJSON(res, 200, obj);
    } catch (e) {
      return sendJSON(res, 500, { ok:false, error:'read_error' });
    }
  }

  return sendJSON(res, 400, { ok:false, error:'bad_file' });
}

// ----- queue ops (stubs; require auth) -----
function handleJobRequeue(_req, res){ if (!requireAuth(_req, res)) return; sendJSON(res, 501, { ok:false, error:'not_implemented' }); }
function handleJobCancel (_req, res){ if (!requireAuth(_req, res)) return; sendJSON(res, 501, { ok:false, error:'not_implemented' }); }

// ----- tiny route matcher -----
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
    if (parsed.query && parsed.query.log && Sentry) {
      try {
        Sentry.withScope(scope => {
          scope.setTag('endpoint','debug');
          scope.setExtras({ ip: ipOf(req), ua: String(req.headers['user-agent'] || '') });
          Sentry.captureMessage(String(parsed.query.log), 'info');
        });
      } catch (e) {}
    }
    if (parsed.query && parsed.query.boom && Sentry) {
      try { throw new Error('Manual Sentry test error (boom=1)'); } catch (e) { try { Sentry.captureException(e); } catch (er) {} }
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

  // version
  if (isRoute(req, pathname, ['GET','HEAD'], '/version')) {
    let rev = '';
    try { rev = fs.readFileSync(VERSION_FILE, 'utf8').trim(); } catch (e) {}
    if (!rev) {
      try { rev = execFileSync('git', ['rev-parse','--short','HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(); }
      catch (e) { rev = 'unknown'; }
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

  // dryrun (no auth; Phase1: throttled + optional key)
  if (isRoute(req, pathname, 'POST', '/diff_dryrun'))
    return handleDiffDryrun(req, res);

  // planner
  if (isRoute(req, pathname, 'POST', '/plan'))
    return handlePlan(req, res);

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
