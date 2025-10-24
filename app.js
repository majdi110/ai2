'use strict';

/**
 * ai2 mini-server — robust OpenAI-backed planner with fallbacks, SSE heartbeat,
 * metrics, CORS/CSRF guard, binary patch detection, history, audit JSONL, artifacts,
 * and per-token path scoping (public/users/<user>/projects/<project>/…).
 *
 * Public endpoints:
 *   GET/HEAD  /ai2/                    -> "OK (ai2)"
 *   GET/HEAD  /ai2/_health             -> { ok:true, time }
 *   GET/HEAD  /ai2/health              -> alias
 *   GET/HEAD  /ai2/version             -> { ok:true, version }
 *   GET/HEAD  /ai2/_config             -> echo config (model, prefixes, etc.)
 *   GET/HEAD  /ai2/_openai_check       -> validate key/model + latency
 *   POST      /ai2/echo                -> debug echo
 *   POST      /ai2/plan                -> planner (SSE via ?stream=1 or Accept: text/event-stream)
 *   GET       /ai2/metrics             -> counters (Prometheus-ish)
 *
 * Auth-required (Bearer/X-API-Key = ACTION_TOKEN or scoped token from tokens.json):
 *   POST      /ai2/job_submit          -> enqueue commands steps
 *   POST      /ai2/diff_submit         -> enqueue unified diff as patch job
 *   POST      /ai2/diff_dryrun         -> validate unified diff only (optional scoped constraints)
 *   GET       /ai2/plans/list|read
 *   GET/POST  /ai2/repo/ls|read|download
 *   GET/POST  /ai2/jobs/list|log
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

/* ---------------- Constants & small utils ---------------- */
const CANONICAL_BRANCH = 'public';
const ALLOWED_BRANCHES = new Set([CANONICAL_BRANCH]);

const MAX_DIFF_BYTES       = 200 * 1024;
const MAX_PLAN_BODY_BYTES  = 256 * 1024;
const MAX_PROMPT_CHARS     = 16 * 1024;

const ALLOWED_PATH_PREFIXES =
  (process.env.ALLOWED_PATH_PREFIXES || 'public/users/')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

// Rate-limiting: file-based buckets
const DRYRUN_RL_PER_MIN    = parseInt(process.env.DRYRUN_RL_PER_MIN || '10', 10);
const DRYRUN_KEY           = process.env.DRYRUN_KEY || '';
const RL_RETRY_AFTER_SEC   = parseInt(process.env.RL_RETRY_AFTER_SEC || '60', 10);

// Metrics (Prometheus-ish)
const metrics = { req_total: {}, route_2xx: {}, route_4xx: {}, route_5xx: {} };
function inc(map, key){ map[key]=(map[key]||0)+1; }
function wrap(res, route){
  const origEnd = res.end;
  res.end = function(...a){
    const code = res.statusCode || 0;
    if (code>=200 && code<300) inc(metrics.route_2xx, route);
    else if (code>=400 && code<500) inc(metrics.route_4xx, route);
    else if (code>=500) inc(metrics.route_5xx, route);
    return origEnd.apply(this,a);
  };
}

// CORS / CSRF (allowlist via env)
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean);
function applyCORS(req, res){
  const o = String(req.headers.origin||'');
  if (o && (CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(o))) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary','Origin');
    res.setHeader('Access-Control-Allow-Credentials','true');
    res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Requested-With, X-API-Key, X-Idempotency-Key, X-CSRF-Token, X-Dryrun-Key');
    res.setHeader('Access-Control-Allow-Methods','GET,HEAD,POST,OPTIONS');
  }
}
function maybeBlockBrowserPost(req, res, needsAuth) {
  if (req.method !== 'POST') return true;
  const hdrs = req.headers || {};
  const hasSig = (String(hdrs['x-requested-with']||'') === 'ai2-ui') || Boolean(hdrs['x-csrf-token']);
  const looksBrowser = Boolean(hdrs['origin'] || (hdrs['user-agent']||'').includes('Mozilla'));
  if (looksBrowser && !hasSig) {
    res.writeHead(403, { 'Content-Type':'application/json' });
    res.end(JSON.stringify({ ok:false, error:'csrf_required' }));
    return false;
  }
  return true;
}

// RL storage
const RL_DIR = '/home/genweb/agent/rl';
try { fs.mkdirSync(RL_DIR, { recursive: true, mode: 0o700 }); } catch {}

function withFileLock(lockPath, fn) {
  const start = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try { return fn(); }
      finally { try { fs.closeSync(fd); fs.unlinkSync(lockPath); } catch {} }
    } catch (e) {
      if (e && (e.code === 'EEXIST' || e.code === 'EACCES')) {
        if (Date.now() - start > 1500) throw new Error('lock_timeout');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      } else {
        throw e;
      }
    }
  }
}
function rlKey(ip, name) {
  const s = `${ip}|${name}`;
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}
function rlCheck(ip, name, limitPerMin) {
  const key = rlKey(ip, name);
  const fp = path.join(RL_DIR, `rl-${key}.json`);
  const now = Date.now();
  return withFileLock(fp + '.lock', () => {
    let bucket = { t: now, c: 0 };
    try { bucket = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {}
    if (now - bucket.t >= 60_000) { bucket.t = now; bucket.c = 0; }
    bucket.c++;
    fs.writeFileSync(fp, JSON.stringify(bucket));
    if (bucket.c > limitPerMin) {
      return { ok:false, retry_after: RL_RETRY_AFTER_SEC };
    }
    return { ok:true };
  });
}

// misc utils
function r4() { return Math.random().toString(36).slice(2, 6); }
function isObj(x){ return x && typeof x === 'object' && !Array.isArray(x); }
function nowISO(){ return new Date().toISOString(); }
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type':'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function sha256hex(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }
function execp(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const ps = execFile(cmd, args, { ...opts, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(stderr || stdout || String(err));
        e.stdout = stdout; e.stderr = stderr;
        return reject(e);
      }
      resolve({ stdout, stderr });
    });
    if (opts && opts.input) ps.stdin.end(opts.input);
  });
}
const ipOf = (req) => String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '');

// --- Audit log (append-only JSONL)
const AUDIT_LOG = '/home/genweb/agent/logs/audit.jsonl';
try { fs.mkdirSync(path.dirname(AUDIT_LOG), { recursive:true, mode:0o700 }); } catch {}
function auditWrite(evt) {
  try {
    const rec = { ts: nowISO(), ...evt };
    fs.appendFileSync(AUDIT_LOG, JSON.stringify(rec) + '\n', { mode:0o600 });
  } catch {}
}

/* ---------------- Dirs & constants ---------------- */
const STATIC_ROOT  = path.join(__dirname, 'public');
const VERSION_FILE = path.join(__dirname, 'VERSION.txt');

const QUEUE_DIR   = '/home/genweb/agent/queue';
const DONE_DIR    = '/home/genweb/agent/done';
const FAIL_DIR    = '/home/genweb/agent/failures';
const LOG_DIR     = '/home/genweb/agent/logs';
const PLANS_DIR   = '/home/genweb/agent/work/plans';

// Plan artifacts
const ARTIFACTS_DIR = '/home/genweb/agent/artifacts';
try { fs.mkdirSync(ARTIFACTS_DIR, { recursive:true, mode:0o755 }); } catch {}

function writePlanArtifacts(planObj, opts = {}) {
  try {
    const dir = path.join(ARTIFACTS_DIR, String(planObj.id || planObj.plan?.id || 'unknown'));
    fs.mkdirSync(dir, { recursive:true, mode:0o755 });

    const envelope = planObj.plan ? planObj : { plan: planObj };
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(envelope, null, 2), { mode:0o600 });

    const p = planObj.plan || planObj;
    if (p && p.combined_diff) {
      fs.writeFileSync(path.join(dir, 'combined.patch'), String(p.combined_diff), { mode:0o600 });
    }

    if (opts.status) {
      fs.writeFileSync(path.join(dir, 'status.txt'), `status=${opts.status}\n`, { mode:0o600 });
    }
  } catch {}
}

const REPO_ROOT      = '/home/genweb/public_html/datav.belocloud.com/ai2';
const LIST_MAX_DEPTH = 3;
const LIST_MAX_ITEMS = 2000;
const HIDE_NAMES     = new Set(['.git', 'node_modules', '.env']);

// OpenAI model (key loaded lazily)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''; // not used directly — see getOpenAIKey()
const OPENAI_MODEL   = process.env.OPENAI_MODEL   || 'gpt-4o-mini';

// ----- Token-scoped prefixes (Option B) -----
const TOKENS_FILE = '/home/genweb/agent/tokens.json';
let TOKENS_CACHE = null, TOKENS_MTIME = 0;
function loadTokensFile() {
  try {
    const st = fs.statSync(TOKENS_FILE);
    if (!TOKENS_CACHE || st.mtimeMs !== TOKENS_MTIME) {
      TOKENS_CACHE = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8') || '{}');
      TOKENS_MTIME = st.mtimeMs;
    }
  } catch { TOKENS_CACHE = null; TOKENS_MTIME = 0; }
  return TOKENS_CACHE || {};
}

// Planner retry + circuit-breaker
const PLAN_MAX_RETRIES       = parseInt(process.env.PLAN_MAX_RETRIES || '2', 10);
const PLAN_CB_WINDOW_MS      = 60_000;
const PLAN_CB_FAILS_TO_TRIP  = 5;
let planFailWindow = [];
function plannerHealthy() {
  const now = Date.now();
  planFailWindow = planFailWindow.filter(t => now - t < PLAN_CB_WINDOW_MS);
  return planFailWindow.length < PLAN_CB_FAILS_TO_TRIP;
}
function recordPlannerFail(){ planFailWindow.push(Date.now()); }

// ensure dirs
for (const d of [QUEUE_DIR, DONE_DIR, FAIL_DIR, LOG_DIR, PLANS_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
}

// Action token & OpenAI key loaders (file-first, env fallback)
let ACTION_TOKEN = '';
const TOKEN_FILE = '/home/genweb/agent/ACTION_TOKEN';
function getActionToken() {
  if (ACTION_TOKEN) return ACTION_TOKEN;
  try {
    ACTION_TOKEN = String(fs.readFileSync(TOKEN_FILE, 'utf8') || '').trim();
    if (!ACTION_TOKEN) throw new Error('empty');
  } catch { ACTION_TOKEN = (process.env.ACTION_TOKEN || '').trim(); }
  return ACTION_TOKEN;
}
let OPENAI_KEY = '';
const OPENAI_KEY_FILE = '/home/genweb/agent/OPENAI_API_KEY';
function getOpenAIKey() {
  if (OPENAI_KEY) return OPENAI_KEY;
  try { OPENAI_KEY = String(fs.readFileSync(OPENAI_KEY_FILE, 'utf8') || '').trim(); } catch {}
  if (!OPENAI_KEY) OPENAI_KEY = (process.env.OPENAI_API_KEY || '').trim();
  return OPENAI_KEY;
}

const DEBUG_LOG = '/home/genweb/agent/last_action_debug.log';
function logDbg(obj){ try { fs.appendFileSync(DEBUG_LOG, JSON.stringify(obj)+'\n'); } catch {} }

/* ---------------- HTTPS JSON helper ---------------- */
function httpsJson({ hostname, path, method='POST', headers={}, bodyObj }) {
  return new Promise((resolve, reject) => {
    const data = bodyObj ? JSON.stringify(bodyObj) : '';
    const opts = {
      hostname, port: 443, path, method,
      headers: { 'Content-Type':'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTPS ${res.statusCode}: ${raw.slice(0,400)}`));
        }
        try { resolve(raw ? JSON.parse(raw) : {}); }
        catch { reject(new Error('bad_json_response')); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
async function openaiWithRetry(bodyObj, tries=3) {
  let lastErr;
  for (let i=0;i<tries;i++){
    try {
      return await httpsJson({
        hostname: 'api.openai.com',
        path: '/v1/responses',
        headers: { 'Authorization': `Bearer ${getOpenAIKey()}` },
        bodyObj
      });
    } catch (e) {
      lastErr = e;
      if (!/HTTPS (429|5\d\d)/.test(String(e.message||''))) break;
      await new Promise(r => setTimeout(r, 300 * Math.pow(2,i)));
    }
  }
  throw lastErr;
}

/* ---------------- Commands safety ---------------- */
const CMD_ALLOWLIST = new Set([
  'node','npm','npx','pnpm','yarn',
  'git','bash','sh',
  'curl','echo','printf','sed','awk','grep','find','tee','cat'
]);
const MAX_CMD_STEPS = 5;
const MAX_CMD_LEN   = 200;
function parseFirstWord(s){ const m = String(s||'').trim().match(/^([^\s]+)/); return m?m[1]:''; }
function validateCommandsSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return 'empty_steps';
  if (steps.length > MAX_CMD_STEPS) return 'too_many_steps';
  for (let i=0;i<steps.length;i++) {
    const line = String(steps[i] || '');
    if (!line.trim()) return `step_${i}_empty`;
    if (line.length > MAX_CMD_LEN) return `step_${i}_too_long`;
    const bin = parseFirstWord(line);
    if (!CMD_ALLOWLIST.has(bin)) return `step_${i}_bin_not_allowed:${bin}`;
    if (/[;&|]{2,}/.test(line)) return `step_${i}_suspicious_operators`;
  }
  return null;
}

/* ---------------- Planner system prompt ---------------- */
function buildPlannerSystemPrompt() {
  const ROOT = "/home/genweb/public_html/datav.belocloud.com/ai2";
  const base = [
    'You are a repository automation planner. Emit STRICT JSON only (no prose), matching the schema below.',
    '',
    '{',
    '  "schema": 1,',
    '  "id": "<string unique id>",',
    '  "status": "planned",',
    '  "goal": "<short description>",',
    '  "constraints": {',
    '    "base_branch": "public",',
    '    "allowed_ops": ["create","modify","delete"],',
    `    "root_dir": "${ROOT}"`,
    '  },',
    '  "steps": [',
    '    { "type":"patch", "op":"create|modify|delete", "base_branch":"public", "message":"<git commit message>", "diff":"<unified diff starting with diff --git ...>" },',
    '    { "type":"commands", "schema":1, "workdir":"'+ROOT+'", "steps":["..."] }',
    '  ],',
    '  "combined_diff": null,',
    '  "artifacts": null,',
    '  "telemetry": null',
    '}',
    '',
    'Rules:',
    `- All file paths MUST be under ${ROOT} and obey the server allowed prefixes.`,
    "- Unified diffs MUST start with 'diff --git ' and be valid git-format patches.",
    '- Prefer a SINGLE patch step when possible.',
    '- Keep total diff size < 200 KB.',
    '- NEVER write outside allowed prefixes.',
    '- No binaries or base64 (text-only patches).',
    '- Minimal edits when modifying existing files.',
    '- Use commands step only for small, safe tasks.',
    '- Output must be pure JSON.',
    '',
    'Templates:',
    'HTML_MINIMAL := "<!doctype html>\\n<html lang=\\"en\\">\\n<head>\\n  <meta charset=\\"utf-8\\">\\n  <title>${TITLE}</title>\\n</head>\\n<body>\\n  <h1>${H1}</h1>\\n</body>\\n</html>\\n"',
    '',
    'Examples:',
    'EXAMPLE_CREATE:',
    '{ "schema":1,"id":"ex-create-1","status":"planned","goal":"Create a welcome page","constraints":{"base_branch":"public","allowed_ops":["create","modify","delete"],"root_dir":"'+ROOT+'"},"steps":[{ "type":"patch","op":"create","base_branch":"public","message":"Add welcome page","diff":"diff --git a/public/welcome.html b/public/welcome.html\\nnew file mode 100644\\nindex 0000000..e69de29\\n--- /dev/null\\n+++ b/public/welcome.html\\n@@ -0,0 +1,5 @@\\n+<!doctype html>\\n+<title>Welcome</title>\\n+<h1>Welcome</h1>\\n+<p>Hello!</p>\\n+" }],"combined_diff":null,"artifacts":null,"telemetry":null }',
    '',
    'EXAMPLE_MODIFY:',
    '{ "schema":1,"id":"ex-mod-1","status":"planned","goal":"Update title in index.html","constraints":{"base_branch":"public","allowed_ops":["create","modify","delete"],"root_dir":"'+ROOT+'"},"steps":[{ "type":"patch","op":"modify","base_branch":"public","message":"Change title to AI2 Demo","diff":"diff --git a/public/index.html b/public/index.html\\nindex abc1234..def5678 100644\\n--- a/public/index.html\\n+++ b/public/index.html\\n@@ -1,5 +1,5 @@\\n <!doctype html>\\n <meta charset=\\"utf-8\\">\\n-<title>Old</title>\\n+<title>AI2 Demo</title>\\n <h1>Hello</h1>\\n" }],"combined_diff":null,"artifacts":null,"telemetry":null }',
    '',
    'EXAMPLE_DELETE:',
    '{ "schema":1,"id":"ex-del-1","status":"planned","goal":"Remove deprecated file","constraints":{"base_branch":"public","allowed_ops":["create","modify","delete"],"root_dir":"'+ROOT+'"},"steps":[{ "type":"patch","op":"delete","base_branch":"public","message":"Remove old file","diff":"diff --git a/public/old.txt b/public/old.txt\\ndeleted file mode 100644\\nindex 1a2b3c4..0000000\\n--- a/public/old.txt\\n+++ /dev/null\\n@@ -1,1 +0,0 @@\\n-legacy content\\n" }],"combined_diff":null,"artifacts":null,"telemetry":null }',
  ];

  const VERBOSE = (process.env.PROMPT_VERBOSE || '') && process.env.PROMPT_VERBOSE !== '0';
  if (VERBOSE) {
    base.push(
      '',
      'EXAMPLES (concise few-shots to guide planning):',
      String.raw`EXAMPLE: Modify public/index.html title
{
  "schema":1,"id":"ex-1","status":"planned","goal":"Update title",
  "constraints":{"base_branch":"public","allowed_ops":["create","modify","delete"],"root_dir":"${ROOT}"},
  "steps":[{"type":"patch","op":"modify","base_branch":"public","message":"Update title",
    "diff":"diff --git a/public/index.html b/public/index.html
index abc..def 100644
--- a/public/index.html
+++ b/public/index.html
@@ -1,5 +1,5 @@
 <!doctype html>
 <html lang=\"en\">
-<title>Old</title>
+<title>AI2 Demo</title>
 </html>
"
  }],
  "combined_diff":null,"artifacts":null,"telemetry":null
}`,
      String.raw`EXAMPLE: Create public/about.html
{
  "schema":1,"id":"ex-2","status":"planned","goal":"Add about page",
  "constraints":{"base_branch":"public","allowed_ops":["create","modify","delete"],"root_dir":"${ROOT}"},
  "steps":[{"type":"patch","op":"create","base_branch":"public","message":"Add about.html",
    "diff":"diff --git a/public/about.html b/public/about.html
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/public/about.html
@@ -0,0 +1,6 @@
+<!doctype html>
+<meta charset=\"utf-8\">
+<title>About - AI2 Demo</title>
+<h1>About</h1>
+<p>Static page from public/</p>
"
  }],
  "combined_diff":null,"artifacts":null,"telemetry":null
}`,
      String.raw`EXAMPLE: Delete a stale file
{
  "schema":1,"id":"ex-3","status":"planned","goal":"Remove old file",
  "constraints":{"base_branch":"public","allowed_ops":["create","modify","delete"],"root_dir":"${ROOT}"},
  "steps":[{"type":"patch","op":"delete","base_branch":"public","message":"Remove old file",
    "diff":"diff --git a/public/old.html b/public/old.html
deleted file mode 100644
index 0123456..0000000
--- a/public/old.html
+++ /dev/null
@@ -1,3 +0,0 @@
-<!doctype html>
-<title>Old</title>
-<p>unused</p>
"
  }],
  "combined_diff":null,"artifacts":null,"telemetry":null
}`,
      '',
      'NEGATIVE RULES:',
      '- Never write outside allowed prefixes (ALLOWED_PATH_PREFIXES).',
      '- Diffs must start with "diff --git " and stay under 200 KB.',
      '- No binary blobs or base64; text-only patches.',
      '- Prefer a single patch step whenever possible.',
      '- Use type:"commands" only when necessary and safe.'
    );
  }
  return base.join('\n');
}

/* ---------------- Diff helpers / validation ---------------- */
function normalizeDiff(raw) {
  if (typeof raw !== 'string') return raw;
  return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
function looksBinaryDiff(diff) {
  return /^(?:GIT binary patch|literal \d+)/m.test(String(diff||''));
}
function stepPathsUnderRepo(diff, prefixes = ALLOWED_PATH_PREFIXES) {
  const re = /^diff --git a\/([^\n]+) b\/([^\n]+)$/mg;
  let m; let n = 0;
  const isDevNull = (p) => p === '/dev/null' || p === 'dev/null';
  const pathAllowed = (rel) =>
    prefixes.length === 0 || prefixes.some(p => rel.startsWith(p));
  while ((m = re.exec(diff)) !== null) {
    n++;
    const a = m[1], b = m[2];
    if (!a || !b) return { ok:false, error:'missing_paths' };
    if (a.startsWith('/') || b.startsWith('/')) return { ok:false, error:'abs_path' };
    if (a.includes('..') || b.includes('..')) return { ok:false, error:'path_traversal' };
    if (a.includes('\\') || b.includes('\\')) return { ok:false, error:'backslash_path' };
    if (!isDevNull(a) && !pathAllowed(a)) return { ok:false, error:'path_disallowed' };
    if (!isDevNull(b) && !pathAllowed(b)) return { ok:false, error:'path_disallowed' };
  }
  if (n === 0) return { ok:false, error:'no_diff_pairs' };
  return { ok:true };
}
function inferStepOpFromDiff(diff) {
  if (/^new file mode /m.test(diff) || /--- \/dev\/null/m.test(diff)) return 'create';
  if (/^deleted file mode /m.test(diff) || /\+\+\+ \/dev\/null/m.test(diff)) return 'delete';
  return 'modify';
}
function buildCombinedDiffFromSteps(steps) {
  const parts = [];
  for (const s of steps) {
    if (s && s.type === 'patch' && typeof s.diff === 'string' && s.diff.trim().startsWith('diff --git')) {
      parts.push(s.diff.trim());
    }
  }
  return parts.length ? parts.join('\n\n') + '\n' : '';
}

/* ---------------- Git dry-run ---------------- */
async function gitDryRun(diff, baseBranch=CANONICAL_BRANCH) {
  const repo = __dirname;
  const tmpDir = path.join(os.tmpdir(), `ai2-dryrun-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fsp.mkdir(tmpDir, { recursive:true });
  try {
    await execp('git', ['fetch', '--depth=1', 'origin', baseBranch], { cwd: repo });
    await execp('git', ['worktree', 'add', '--detach', '--force', tmpDir, `origin/${baseBranch}`], { cwd: repo });
    const patchPath = path.join(tmpDir, 'incoming.patch');
    await fsp.writeFile(patchPath, diff, 'utf8');
    try {
      await execp('git', ['apply', '--check', '--3way', '--unsafe-paths', patchPath], { cwd: tmpDir });
      return { ok: true };
    } catch (e3) {
      try {
        await execp('git', ['apply', '--check', '--unsafe-paths', patchPath], { cwd: tmpDir });
        return { ok: true, fallback: true };
      } catch (e) {
        return { ok: false, error: e.stderr || e.stdout || String(e) };
      }
    }
  } finally {
    try { await execp('git', ['worktree', 'remove', '--force', tmpDir], { cwd: repo }); } catch {}
  }
}

/* ---------------- Auth utils ---------------- */
// (kept for backward compat in a few places; use authCtx instead)
function authOk(req) {
  const bearer = String(req.headers['authorization'] || '');
  const viaBearer = bearer.toLowerCase().startsWith('bearer ') ? bearer.slice(7).trim() : '';
  const viaKey = String(req.headers['x-api-key'] || '').trim();
  const token = getActionToken();
  return Boolean(token) && (viaBearer === token || viaKey === token);
}

// Return structured auth context (global admin token OR scoped per-user token from tokens.json)
function authCtx(req) {
  const bearerRaw = String(req.headers['authorization'] || '');
  const viaBearer = bearerRaw.toLowerCase().startsWith('bearer ') ? bearerRaw.slice(7).trim() : '';
  const viaKey = String(req.headers['x-api-key'] || '').trim();
  const presented = viaBearer || viaKey || '';

  // Global admin token stays valid
  const admin = getActionToken();
  if (admin && presented === admin) return { ok: true, kind: 'global', token: 'ACTION_TOKEN' };

  // Scoped token from tokens.json
  const map = (loadTokensFile().tokens || {});
  const rec = map[presented];
  if (rec && rec.user) {
    const projects = Array.isArray(rec.projects) && rec.projects.length ? rec.projects.map(String) : ['*'];
    return { ok: true, kind: 'scoped', token: presented.slice(0,8)+'…', user: String(rec.user), projects };
  }
  return { ok:false };
}

// Compute allowed path prefixes from auth context
function allowedPrefixesFromAuth(auth) {
  if (auth && auth.ok && auth.kind === 'scoped') {
    if (auth.projects.includes('*')) {
      return [ `public/users/${auth.user}/projects/` ];
    }
    return auth.projects.map(p => `public/users/${auth.user}/projects/${String(p).replace(/[^A-Za-z0-9._-]/g,'')}/`);
  }
  // Fallback: env-level prefixes (for admin/global token)
  return ALLOWED_PATH_PREFIXES;
}

/* ---------------- Envelope normalize/validate ---------------- */
function normalizeIncomingPlan(body, baseBranch, goalText) {
  if (Array.isArray(body.steps)) {
    const id = `plan-${Date.now()}-${r4()}`;
    const steps = body.steps.map((s) => {
      if (s.type === 'patch') {
        const op = s.op || inferStepOpFromDiff(String(s.diff||''));
        return { type:'patch', op, base_branch: baseBranch, message: String(s.message||'Plan patch'), diff: String(s.diff||'') };
      }
      if (s.type === 'commands') {
        return { type:'commands', schema: 1, workdir: s.workdir || REPO_ROOT, steps: (Array.isArray(s.steps)? s.steps.map(String):[]) };
      }
      return s;
    });
    return {
      schema: 1,
      id,
      status: body.preview_only ? 'preview' : 'planned',
      goal: String(body.goal || goalText || ''),
      constraints: { base_branch: baseBranch, allowed_ops:['create','modify','delete'], root_dir: REPO_ROOT },
      steps,
      combined_diff: null,
      artifacts: null,
      telemetry: null
    };
  }
  if (Array.isArray(body.plan)) {
    const id = `plan-${Date.now()}-${r4()}`;
    const steps = body.plan.map((p) => {
      if (p.type === 'patch') {
        return { type:'patch', op: inferStepOpFromDiff(String(p.diff||'')), base_branch: baseBranch, message: String(p.message||'Plan patch'), diff: String(p.diff||'') };
      }
      if (p.type === 'commands') {
        return { type:'commands', schema:1, workdir: p.workdir || REPO_ROOT, steps: (Array.isArray(p.steps)? p.steps.map(String):[]) };
      }
      return p;
    });
    return {
      schema: 1,
      id,
      status: body.preview_only ? 'preview' : 'planned',
      goal: String(body.goal || goalText || ''),
      constraints: { base_branch: baseBranch, allowed_ops:['create','modify','delete'], root_dir: REPO_ROOT },
      steps,
      combined_diff: null,
      artifacts: null,
      telemetry: null
    };
  }
  return null;
}

// Accept dynamic allowed prefixes (from token scope)
function validatePlanEnvelope(plan, prefixes = ALLOWED_PATH_PREFIXES) {
  if (!isObj(plan)) return 'plan_not_object';
  if ((plan.schema|0) !== 1) return 'bad_schema';
  if (typeof plan.id !== 'string' || !plan.id) return 'missing_id';
  if (!['planned','applied','failed','preview'].includes(String(plan.status))) return 'bad_status';
  if (!isObj(plan.constraints)) return 'missing_constraints';
  if (plan.constraints.base_branch !== CANONICAL_BRANCH) return 'bad_base_branch';
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) return 'missing_steps';
  for (let i=0;i<plan.steps.length;i++) {
    const s = plan.steps[i];
    if (!isObj(s) || typeof s.type !== 'string') return `step_${i}_bad_type`;
    if (s.type === 'patch') {
      if (typeof s.diff === 'string') s.diff = normalizeDiff(s.diff);
      if (looksBinaryDiff(s.diff)) return `step_${i}_binary_patch`;
      if (!['create','modify','delete'].includes(String(s.op||''))) return `step_${i}_bad_op`;
      if (typeof s.diff !== 'string' || !s.diff.startsWith('diff --git ')) return `step_${i}_bad_diff`;
      const size = Buffer.byteLength(s.diff,'utf8'); if (size > MAX_DIFF_BYTES) return `step_${i}_diff_too_large`;
      const pairsRe = /^diff --git a\/([^\n]+) b\/([^\n]+)$/mg;
      let m; let count=0;
      const isDevNull = (p) => p === '/dev/null' || p === 'dev/null';
      const pathAllowed = (rel) =>
        prefixes.length === 0 || prefixes.some(p => rel.startsWith(p));
      while ((m = pairsRe.exec(s.diff)) !== null) {
        count++;
        const a=m[1], b=m[2];
        if (!a || !b) return `step_${i}_missing_paths`;
        if (a.startsWith('/') || b.startsWith('/')) return `step_${i}_abs_path`;
        if (a.includes('..') || b.includes('..')) return `step_${i}_path_traversal`;
        if (a.includes('\\') || b.includes('\\')) return `step_${i}_backslash_path`;
        if (!isDevNull(a) && !pathAllowed(a)) return `step_${i}_path_disallowed`;
        if (!isDevNull(b) && !pathAllowed(b)) return `step_${i}_path_disallowed`;
      }
      if (count===0) return `step_${i}_no_paths`;
      const autoOp = inferStepOpFromDiff(s.diff);
      if (autoOp !== s.op) return `step_${i}_op_mismatch`;
    } else if (s.type === 'commands') {
      if ((s.schema|0) !== 1 || !Array.isArray(s.steps) || s.steps.length === 0) return `step_${i}_bad_commands`;
      const vErr = validateCommandsSteps(s.steps);
      if (vErr) return `step_${i}_commands_invalid:${vErr}`;
    } else {
      return `step_${i}_unknown_type`;
    }
  }
  return null;
}

/* ---------------- OpenAI plan call ---------------- */
function injectContextIntoPrompt(userText, contextBlock) {
  return contextBlock ? (`[CONTEXT FOLLOWS]\n${contextBlock}\n\n[REQUEST]\n${userText}`) : userText;
}
async function callOpenAIPlan(userPrompt) {
  const key = getOpenAIKey();
  if (!key) throw new Error('missing_openai_key');

  const system = buildPlannerSystemPrompt();
  const body = {
    model: OPENAI_MODEL,
    input: [
      { role: 'system', content: system },
      { role: 'user',   content: String(userPrompt) }
    ],
    text: { format: { type: "json_object" } }
  };

  const j = await openaiWithRetry(body);

  const txt =
    j.output_text ||
    (j.output?.[0]?.content?.[0]?.text) ||
    (Array.isArray(j.output) && j.output.map(o => o?.content?.[0]?.text).filter(Boolean).join('\n')) ||
    (j.choices?.[0]?.message?.content) ||
    (typeof j === 'string' ? j : '');

  if (!txt) throw new Error('openai_no_output');

  let planObj;
  try { planObj = JSON.parse(txt); }
  catch { throw new Error('openai_bad_json'); }

  const usage = j.usage || j.output?.[0]?.usage || null;
  return { plan: planObj, usage };
}
async function planWithRetry(effPrompt, sseEmit) {
  if (!plannerHealthy()) {
    if (sseEmit) sseEmit('planner_cb_tripped', { window_ms: 60_000 });
    throw new Error('planner_unavailable');
  }
  let lastErr;
  for (let i = 0; i <= PLAN_MAX_RETRIES; i++) {
    try {
      return await callOpenAIPlan(effPrompt);
    } catch (e) {
      lastErr = e;
      recordPlannerFail();
      if (sseEmit) sseEmit('planner_retry', { attempt: i + 1, error: String(e.message || e).slice(0,200) });
      await new Promise(r => setTimeout(r, 250 + Math.random()*500));
    }
  }
  throw lastErr || new Error('planner_failed');
}

/* ---------------- Queue writers ---------------- */
function writeQueueItem(basename, jsonObj) {
  const name = String(basename || ('job-' + ts() + '-' + r4())).replace(/[^A-Za-z0-9._-]/g,'_');
  const fp   = path.join(QUEUE_DIR, name + '.json');
  if (fs.existsSync(fp)) throw new Error('queue_name_conflict');
  fs.writeFileSync(fp, JSON.stringify(jsonObj, null, 2), { mode: 0o600 });
  return { queued: name + '.json', sha256: sha256hex(JSON.stringify(jsonObj)) };
}
function ts() {
  const d = new Date(), p = n => String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
function enqueueCommandsJob({ schema=1, steps=[], workdir=REPO_ROOT, idemVal='', reqInfo={} }) {
  if ((schema|0) !== 1) throw new Error('bad_schema');
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('empty_steps');
  const job = { type:'commands', schema:1, workdir, steps, idempotency_key: idemSan(idemVal), requested_at: nowISO(), request_info: reqInfo };
  return writeQueueItem('job-' + ts(), job);
}
async function enqueuePatchJob({ base=CANONICAL_BRANCH, message='', diff='', idemVal='', reqInfo={} }) {
  const chk = enforceDiffSize(diff);
  if (!chk.ok) throw new Error(chk.msg);
  const br = enforceCanonicalBranch(base);
  if (!br.ok) throw new Error('bad_base_branch');
  const job = {
    type:'patch', schema:1, base_branch: br.branch,
    message: String(message || '').slice(0,200), diff,
    idempotency_key: idemSan(idemVal), requested_at: nowISO(), request_info: reqInfo
  };
  return writeQueueItem('job-' + ts(), job);
}
function enforceCanonicalBranch(branchRaw) {
  const b = String(branchRaw || '').trim() || CANONICAL_BRANCH;
  if (!ALLOWED_BRANCHES.has(b)) return { ok:false, code:400, msg:`Unsupported base_branch '${b}'.` };
  return { ok:true, branch: b };
}
function enforceDiffSize(diff) {
  const n = Buffer.byteLength(String(diff || ''), 'utf8');
  if (n > MAX_DIFF_BYTES) return { ok:false, code:413, msg:`Diff too large (${n}). Max ${MAX_DIFF_BYTES}` };
  return { ok:true };
}
function idemSan(s) { return String(s || '').replace(/[^A-Za-z0-9._:-]/g, '_'); }

/* ---------------- Plans history (auth) ---------------- */
function handlePlansList(req, res) {
  wrap(res,'plans_list'); inc(metrics.req_total,'plans_list');
  const auth = authCtx(req); if (!auth.ok) return sendJSON(res, 401, { ok:false, error:'unauthorized' });
  let files = [];
  try {
    files = fs.readdirSync(PLANS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ file:f, mtime: Math.floor(fs.statSync(path.join(PLANS_DIR,f)).mtimeMs/1000) }))
      .sort((a,b)=>b.mtime-a.mtime).slice(0,50);
  } catch {}
  return sendJSON(res, 200, { ok:true, items: files });
}
function handlePlansRead(req, res) {
  wrap(res,'plans_read'); inc(metrics.req_total,'plans_read');
  const auth = authCtx(req); if (!auth.ok) return sendJSON(res, 401, { ok:false, error:'unauthorized' });
  const id = (new URL(req.url,'http://x')).searchParams.get('id') || '';
  const safe = String(id).replace(/[^A-Za-z0-9._-]/g,'');
  if (!safe) return sendJSON(res, 400, { ok:false, error:'bad_id' });
  const fp = path.join(PLANS_DIR, `${safe}.json`);
  try { return sendJSON(res, 200, JSON.parse(fs.readFileSync(fp,'utf8'))); }
  catch { return sendJSON(res, 404, { ok:false, error:'not_found' }); }
}

/* ---------------- OpenAI health ---------------- */
async function handleOpenAICheck(req, res) {
  wrap(res,'openai_check'); inc(metrics.req_total,'openai_check');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }
  const key = getOpenAIKey();
  if (!key) return sendJSON(res, 200, { ok:false, error:'missing_openai_key' });
  try {
    const t0 = Date.now();
    await httpsJson({
      hostname: 'api.openai.com',
      path: '/v1/models',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${key}` }
    });
    return sendJSON(res, 200, { ok:true, model: OPENAI_MODEL, latency_ms: Date.now()-t0 });
  } catch (e) {
    return sendJSON(res, 200, { ok:false, model: OPENAI_MODEL, error: String(e).slice(0,200) });
  }
}

/* ---------------- Repo helpers (auth) ---------------- */
function safeJoin(root, userPath){
  const p = path.normalize('/' + String(userPath || '').replace(/^\/+/, ''));
  const full = path.join(root, '.' + p);
  if (!full.startsWith(root)) throw new Error('path_traversal');
  return full;
}

/* ---------------- /plan ---------------- */
async function handlePlan(req, res) {
  applyCORS(req,res);
  wrap(res,'plan'); inc(metrics.req_total,'plan');

  const REQUIRE_PLAN_AUTH = (process.env.PLAN_AUTH_REQUIRED || '1') !== '0';
  if (!maybeBlockBrowserPost(req,res,REQUIRE_PLAN_AUTH)) return;
  const auth = authCtx(req);
  if (REQUIRE_PLAN_AUTH && !auth.ok) return sendJSON(res, 401, { ok:false, error:'unauthorized' });

  const ip = ipOf(req);
  auditWrite({
    kind: 'plan_request',
    ip,
    ua: String(req.headers['user-agent'] || ''),
    idem: String(req.headers['x-idempotency-key'] || ''),
  });

  const rl = rlCheck(ip, 'plan', 30);
  if (!rl.ok) return sendJSON(res, 429, { ok:false, error:'rate_limited', retry_after: RL_RETRY_AFTER_SEC });

  const dynamicPrefixes = allowedPrefixesFromAuth(auth);

  const parsedUrl = url.parse(req.url || '', true);
  const wantsSSE = String(parsedUrl.query && parsedUrl.query.stream || '') === '1'
                || String(req.headers['accept'] || '').toLowerCase().includes('text/event-stream');
  const includeFiles = Array.isArray(parsedUrl.query && parsedUrl.query.include_files)
    ? parsedUrl.query.include_files
    : (parsedUrl.query && parsedUrl.query.include_files ? [parsedUrl.query.include_files] : null);

  let hb = null;
  const sseEmit = (name, payload) => {
    if (!wantsSSE) return;
    try {
      const line = JSON.stringify({ event: String(name || ''), ...payload });
      res.write(`data: ${line}\n\n`);
    } catch {}
  };
  const sseEnd = () => { try { if (hb) clearInterval(hb); } catch {} };

  if (wantsSSE) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    try { res.write(`data: ${JSON.stringify({ event: 'planning_started', ts: nowISO() })}\n\n`); } catch {}
    hb = setInterval(() => { try { res.write(':\n\n'); } catch {} }, 15000);
  }

  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) { sseEnd(); return sendJSON(res, 415, { ok:false, error:'unsupported_media_type' }); }

  readBodyLimited(req, MAX_PLAN_BODY_BYTES, async (err, buf) => {
    if (err) { if (wantsSSE) { sseEmit('final', { ok:false, error: err.message || 'read_error' }); try { sseEnd(); return res.end(); } catch {} } return sendJSON(res, err.code === 413 ? 413 : 400, { ok:false, error: err.message || 'read_error' }); }

    const bodyStr = buf.toString('utf8');
    const idem = String(req.headers['x-idempotency-key'] || '');
    const idemChk = checkIdempotencyOr409(idem, bodyStr);
    if(!idemChk.ok){ if (wantsSSE){ sseEmit('final',{ok:false,error:idemChk.msg}); try{sseEnd();res.end();}catch{} } return sendJSON(res, idemChk.code, { ok:false, error: idemChk.msg }); }

    let body = {};
    try { body = JSON.parse(bodyStr || '{}'); }
    catch { if (wantsSSE){ sseEmit('final',{ok:false,error:'invalid_json'}); try{sseEnd();res.end();}catch{} } return sendJSON(res, 400, { ok:false, error:'invalid_json' }); }

    const baseRaw = String(body.base_branch || CANONICAL_BRANCH);
    const br = enforceCanonicalBranch(baseRaw);
    if(!br.ok) { if (wantsSSE){ sseEmit('final',{ok:false,error:br.msg}); try{sseEnd();res.end();}catch{} } return sendJSON(res, br.code, { ok:false, error: br.msg }); }

    const strict = Boolean(body.strict);
    const previewOnly = Boolean(body.preview_only);
    const continueOnError = Boolean(body.continue_on_error);
    const wantCombined = Boolean(body.return_combined_diff);
    const goalText = String(body.goal || body.prompt || '').slice(0, 200);
    const rawFallbackSteps = Array.isArray(body.fallback_steps) ? body.fallback_steps : null;
    let fallbackUsed = false;
    const wantContextFiles = Array.isArray(body.include_files) ? body.include_files : (includeFiles || null);

    // Optional context for planner
    let contextBlock = '';
    if (wantContextFiles && wantContextFiles.length) {
      let total = 0; const MAX_CTX = 200 * 1024;
      const uniq = [...new Set(wantContextFiles.map(String))].slice(0, 12);
      for (const rel of uniq) {
        try {
          const full = safeJoin(REPO_ROOT, rel);
          const data = fs.readFileSync(full, 'utf8');
          const slice = data.slice(0, Math.max(0, MAX_CTX - total));
          if (slice) { contextBlock += `\n\n--- ${rel} ---\n${slice}`; total += Buffer.byteLength(slice,'utf8'); }
          if (total >= MAX_CTX) break;
        } catch {}
      }
    }

    // Strict mode: require client-provided steps
    if (strict) {
      const planFromClient = normalizeIncomingPlan(body, br.branch, goalText);
      if (!planFromClient) { if (wantsSSE){ sseEmit('final',{ok:false,error:'strict_mode_requires_steps'}); try{sseEnd();res.end();}catch{} } return sendJSON(res, 400, { ok:false, error:'strict_mode_requires_steps' }); }
      body.steps = planFromClient.steps;
    }

    // Build plan
    let plan = normalizeIncomingPlan(body, br.branch, goalText);

    if (!plan && !strict) {
      const prompt = String(body.prompt || '').trim();
      if (!prompt) { if (wantsSSE){ sseEmit('final',{ok:false,error:'prompt_required'}); try{sseEnd();res.end();}catch{} } return sendJSON(res, 400, { ok:false, error:'prompt_required' }); }
      if (prompt.length > MAX_PROMPT_CHARS) { if (wantsSSE){ sseEmit('final',{ok:false,error:'prompt_too_long',limit:MAX_PROMPT_CHARS}); try{sseEnd();res.end();}catch{} } return sendJSON(res, 413, { ok:false, error:'prompt_too_long', limit: MAX_PROMPT_CHARS }); }

      try {
        const effPrompt = injectContextIntoPrompt(prompt, contextBlock);
        const aiResp = await planWithRetry(effPrompt, sseEmit);
        if (wantsSSE && aiResp && aiResp.usage) sseEmit('openai_tokens', aiResp.usage);
        const ai = aiResp.plan || aiResp;
        plan = normalizeIncomingPlan(
          isObj(ai) && Array.isArray(ai.steps) ? { steps: ai.steps, preview_only: previewOnly, goal: goalText } :
          isObj(ai) && Array.isArray(ai.plan)  ? { plan:  ai.plan,  preview_only: previewOnly, goal: goalText } :
          null,
          br.branch,
          goalText
        );
        if (!plan) throw new Error('ai_bad_plan_shape');
      } catch (e2) {
        if (rawFallbackSteps && rawFallbackSteps.length) {
          try {
            const fbPlan = normalizeIncomingPlan({ steps: rawFallbackSteps, preview_only: previewOnly, goal: goalText }, br.branch, goalText);
            const fbErr = fbPlan ? validatePlanEnvelope(fbPlan, dynamicPrefixes) : 'bad_fallback_shape';
            if (fbErr) throw new Error(fbErr);
            sseEmit('fallback_used', { reason: String(e2 && e2.message || e2).slice(0,200), count: fbPlan.steps.length });
            plan = fbPlan; fallbackUsed = true;
          } catch (fbE) {
            if (wantsSSE){ sseEmit('final',{ok:false,error:`fallback_invalid:${String(fbE && fbE.message || fbE)}`}); try{sseEnd();res.end();}catch{} }
            return sendJSON(res, 422, { ok:false, error:'fallback_invalid', detail: String(fbE && fbE.message || fbE) });
          }
        } else {
          if (wantsSSE){ sseEmit('final',{ok:false,error:String(e2 && e2.message || e2)}); try{sseEnd();res.end();}catch{} }
          return sendJSON(res, 502, { ok:false, error: String(e2 && e2.message || e2) });
        }
      }
    }

    // If plan present but empty/invalid -> immediate fallback
    if (plan && (!Array.isArray(plan.steps) || plan.steps.length === 0)) {
      if (rawFallbackSteps && rawFallbackSteps.length) {
        try {
          const fbPlan = normalizeIncomingPlan({ steps: rawFallbackSteps, preview_only: previewOnly, goal: goalText }, br.branch, goalText);
          const fbErr = fbPlan ? validatePlanEnvelope(fbPlan, dynamicPrefixes) : 'bad_fallback_shape';
          if (fbErr) throw new Error(fbErr);
          plan = fbPlan; fallbackUsed = true;
          sseEmit('fallback_used', { reason: 'missing_steps', count: plan.steps.length });
        } catch (e) {
          if (wantsSSE) { sseEmit('final',{ok:false,error:`fallback_invalid:${String(e && e.message || e)}`}); try{sseEnd();res.end();}catch{} }
          return sendJSON(res, 422, { ok:false, error:'fallback_invalid', detail:String(e && e.message || e) });
        }
      }
    }

    // Validate envelope; fallback on missing_steps if provided
    let verr = validatePlanEnvelope(plan, dynamicPrefixes);
    if (verr) {
      if (verr === 'missing_steps' && rawFallbackSteps && rawFallbackSteps.length) {
        try {
          const fbPlan = normalizeIncomingPlan({ steps: rawFallbackSteps, preview_only: previewOnly, goal: goalText }, br.branch, goalText);
          const fbErr = fbPlan ? validatePlanEnvelope(fbPlan, dynamicPrefixes) : 'bad_fallback_shape';
          if (fbErr) throw new Error(fbErr);
          plan = fbPlan; verr = null; fallbackUsed = true;
          sseEmit('fallback_used', { reason: 'missing_steps', count: plan.steps.length });
        } catch (e) {
          if (wantsSSE){ sseEmit('final',{ok:false,error:`fallback_invalid:${String(e && e.message || e)}`}); try{sseEnd();res.end();}catch{} }
          return sendJSON(res, 422, { ok:false, error:'fallback_invalid', detail:String(e && e.message || e) });
        }
      }
    }
    if (verr) { if (wantsSSE){ sseEmit('final',{ok:false,error:verr,plan:{id:plan.id,status:'failed'}}); try{sseEnd();res.end();}catch{} } return sendJSON(res, 422, { ok:false, error: verr, plan }); }

    if (wantCombined) plan.combined_diff = buildCombinedDiffFromSteps(plan.steps);

    sseEmit('validated', { ok:true, steps: plan.steps.length });

    auditWrite({
      kind: 'plan_validated',
      plan_id: plan.id,
      steps: plan.steps.length,
      preview: previewOnly,
      combined_diff_bytes: Buffer.byteLength(String(plan.combined_diff || ''), 'utf8')
    });

    if (previewOnly) {
      plan.status = 'preview';
      plan.telemetry = { preview_only:true, ts: nowISO() };
      try { fs.writeFileSync(path.join(PLANS_DIR, `${plan.id}.json`), JSON.stringify(plan,null,2)); } catch{}
      writePlanArtifacts(plan, { status: 'preview' });

      if (wantsSSE) { sseEmit('final', { ok:true, status:'preview', plan:{ id:plan.id, status:plan.status, steps:plan.steps.length } }); try { sseEnd(); return res.end(); } catch {} }
      else return sendJSON(res, 200, { ok:true, plan });
      return;
    }

    const stepResults = [];
    for (let i=0;i<plan.steps.length;i++) {
      const s = plan.steps[i];
      try {
        sseEmit('step_start', { i, type: s.type, op: s.op || null });
        if (s.type === 'patch') {
          const d = String(s.diff||'');
          if (looksBinaryDiff(d)) {
            stepResults.push({ i, type:'patch', ok:false, error:'binary_patch' });
            sseEmit('step_error', { i, error:'binary_patch' });
            if (!continueOnError) { plan.status='failed'; break; } else { continue; }
          }
          const check = await gitDryRun(d, br.branch);
          if (!check.ok) {
            stepResults.push({ i, type:'patch', ok:false, error:'dryrun_failed', detail:(check.error||'').slice(0,400) });
            sseEmit('step_error', { i, error:'dryrun_failed', detail:(check.error||'').slice(0,200) });

            if (!fallbackUsed && rawFallbackSteps && rawFallbackSteps.length) {
              try {
                const fbPlan = normalizeIncomingPlan({ steps: rawFallbackSteps, preview_only: previewOnly, goal: goalText }, br.branch, goalText);
                const fbErr = fbPlan ? validatePlanEnvelope(fbPlan, dynamicPrefixes) : 'bad_fallback_shape';
                if (fbErr) throw new Error(fbErr);
                sseEmit('fallback_used', { reason:'dryrun_failed', at_step:i, count: fbPlan.steps.length });
                for (let j=0;j<fbPlan.steps.length;j++) {
                  const fsStep = fbPlan.steps[j];
                  if (fsStep.type === 'commands') {
                    const vErr = validateCommandsSteps(fsStep.steps);
                    if (vErr) throw new Error(`fallback_commands_invalid:${vErr}`);
                    const out = enqueueCommandsJob({
                      schema:1, steps: fsStep.steps.map(String), workdir: fsStep.workdir || REPO_ROOT,
                      idemVal: `${plan.id}-fb-${i}-${j}`,
                      reqInfo: { from:'plan_fallback', ip: ipOf(req), ua: String(req.headers['user-agent'] || '') }
                    });
                    stepResults.push({ i:`fb-${i}-${j}`, type:'commands', ok:true, queued: out.queued });
                  } else if (fsStep.type === 'patch') {
                    const chk = await gitDryRun(String(fsStep.diff||''), br.branch);
                    if (!chk.ok) throw new Error(`fallback_dryrun_failed:${(chk.error||'').slice(0,120)}`);
                    const out = await enqueuePatchJob({
                      base: br.branch, message: String(fsStep.message || `Fallback patch ${nowISO()}`), diff: String(fsStep.diff||''),
                      idemVal: `${plan.id}-fb-${i}-${j}`,
                      reqInfo: { from:'plan_fallback', ip: ipOf(req), ua: String(req.headers['user-agent'] || '') }
                    });
                    stepResults.push({ i:`fb-${i}-${j}`, type:'patch', ok:true, queued: out.queued });
                  } else { throw new Error('fallback_step_unknown_type'); }
                }
                fallbackUsed = true;
                plan.status = 'applied';
                break;
              } catch (fbErr) {
                stepResults.push({ i, type:'fallback', ok:false, error:String(fbErr && fbErr.message || fbErr).slice(0,400) });
              }
            }

            if (!continueOnError) { plan.status='failed'; break; } else { continue; }
          }
          sseEmit('dryrun_ok', { i });
          const out = await enqueuePatchJob({
            base: br.branch,
            message: String(s.message || `Plan patch ${nowISO()}`),
            diff: String(s.diff||''),
            idemVal: `${plan.id}-${i}`,
            reqInfo: { from:'plan_endpoint', ip: ipOf(req), ua: String(req.headers['user-agent'] || '') }
          });
          stepResults.push({ i, type:'patch', ok:true, queued: out.queued, sha256: out.sha256 });
          sseEmit('enqueued', { i, queued: out.queued });

          auditWrite({
            kind: 'patch_enqueued',
            plan_id: plan.id,
            step_index: i,
            queued: out.queued,
            sha256: out.sha256
          });
        } else if (s.type === 'commands') {
          const vErr = validateCommandsSteps(s.steps);
          if (vErr) {
            stepResults.push({ i, type:'commands', ok:false, error:vErr });
            sseEmit('step_error', { i, error: vErr });
            if (!continueOnError) { plan.status='failed'; break; } else { continue; }
          }
          const out = enqueueCommandsJob({
            schema: 1,
            steps: (Array.isArray(s.steps)? s.steps.map(String):[]),
            workdir: s.workdir || REPO_ROOT,
            idemVal: `${plan.id}-${i}`,
            reqInfo: { from:'plan_endpoint', ip: ipOf(req), ua: String(req.headers['user-agent'] || '') }
          });
          stepResults.push({ i, type:'commands', ok:true, queued: out.queued });
          sseEmit('enqueued', { i, queued: out.queued });

          auditWrite({
            kind: 'commands_enqueued',
            plan_id: plan.id,
            step_index: i,
            queued: out.queued,
            steps_count: (Array.isArray(s.steps) ? s.steps.length : 0)
          });
        }
      } catch (e3) {
        stepResults.push({ i, ok:false, error:String(e3 && e3.message || e3).slice(0,400) });
        sseEmit('step_error', { i, error: String(e3 && e3.message || e3).slice(0,200) });
        if (!continueOnError) { plan.status='failed'; break; }
      }
    }

    if (plan.status !== 'failed') plan.status = 'applied';
    plan.telemetry = { continue_on_error: continueOnError, ts: nowISO(), steps_applied: plan.steps.length };
    try { fs.writeFileSync(path.join(PLANS_DIR, `${plan.id}.json`), JSON.stringify({ plan, stepResults }, null, 2)); } catch{}

    writePlanArtifacts({ plan, stepResults }, { status: plan.status });

    auditWrite({
      kind: 'plan_final',
      plan_id: plan.id,
      status: plan.status,
      steps: plan.steps.length,
      fallback_used: fallbackUsed || false
    });

    if (wantsSSE) {
      sseEmit('final', { ok: plan.status === 'applied', status: plan.status, plan: { id: plan.id, status: plan.status, steps: plan.steps.length } });
      try { sseEnd(); return res.end(); } catch {}
    } else {
      return sendJSON(res, 200, { ok:true, plan, stepResults });
    }
  });
}

/* ---------------- Other handlers ---------------- */
function handleRoot(req, res){ wrap(res,'root'); inc(metrics.req_total,'root'); if (req.method==='GET'||req.method==='HEAD'){ res.writeHead(200, {'Content-Type':'text/plain; charset=utf-8'}); res.end('OK (ai2)'); } else { res.statusCode=405; res.end(); } }
function handleHealth(req, res){ wrap(res,'health'); inc(metrics.req_total,'health'); if (req.method==='GET'||req.method==='HEAD') sendJSON(res,200,{ok:true,time:nowISO()}); else { res.statusCode=405; res.end(); } }
function handleVersion(req,res){ wrap(res,'version'); inc(metrics.req_total,'version'); if (req.method!=='GET'&&req.method!=='HEAD'){ res.statusCode=405; return res.end(); } let v='unknown'; try{ v=fs.readFileSync(VERSION_FILE,'utf8').trim(); }catch{} if(!v){ try{ v=execFileSync('git',['rev-parse','--short','HEAD'],{cwd:REPO_ROOT,encoding:'utf8'}).trim(); }catch{} } sendJSON(res,200,{ok:true,version:v||'unknown'}); }
function serveStatic(req,res,file){ wrap(res,'static'); inc(metrics.req_total,'static');
  const safeName = String(file||'').replace(/[^A-Za-z0-9._/-]/g,''); if (!safeName || safeName.includes('..')) { res.statusCode=400; return res.end('bad_path'); }
  const ext = path.extname(safeName).toLowerCase();
  const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' :
               ext === '.js' ? 'application/javascript; charset=utf-8' : ext === '.json' ? 'application/json; charset=utf-8' :
               ext === '.txt' ? 'text/plain; charset=utf-8' : 'application/octet-stream';
  const full = path.join(STATIC_ROOT, safeName);
  if (!full.startsWith(STATIC_ROOT)) { res.statusCode=400; return res.end('bad_path'); }
  res.setHeader('Content-Type', type);
  fs.createReadStream(full).on('error',()=>{ res.statusCode=404; res.end('nf'); }).pipe(res);
}
function decodeBodyPreview(raw){ try { return JSON.parse(raw); } catch {} try { return Buffer.from(raw,'base64').toString('utf8'); } catch {} return String(raw).slice(0,1000); }
function handleEcho(req,res){ applyCORS(req,res); wrap(res,'echo'); inc(metrics.req_total,'echo'); if (req.method!=='POST'){ res.statusCode=405; return res.end(); } readBodyLimited(req, 512*1024, (err,buf)=>{ if(err) return sendJSON(res, err.code===413?413:400, { ok:false, error:err.message||'read_error' }); const body=buf.toString('utf8'); return sendJSON(res,200,{ ok:true, headers:req.headers, preview:decodeBodyPreview(body) }); }); }

function handleRepoLs(req, res) {
  wrap(res,'repo_ls'); inc(metrics.req_total,'repo_ls');
  const auth = authCtx(req); if (!auth.ok) return sendJSON(res, 401, { ok:false, error:'unauthorized' });
  try {
    const u  = new URL(req.url, 'http://x');
    const p  = u.searchParams.get('path') || '';
    const d  = parseInt(u.searchParams.get('depth') || '1', 10);
    const depth = Math.max(0, Math.min(LIST_MAX_DEPTH, isNaN(d) ? 1 : d));
    const full = safeJoin(REPO_ROOT, p);
    const out = [];
    function walk(dir, level) {
      if (out.length >= LIST_MAX_ITEMS) return;
      const ents = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of ents) {
        if (HIDE_NAMES.has(e.name)) continue;
        const f = path.join(dir, e.name);
        const rel = path.relative(REPO_ROOT, f);
        out.push({ name: e.name, rel, type: e.isDirectory() ? 'dir' : 'file' });
        if (e.isDirectory() && level < depth) walk(f, level + 1);
        if (out.length >= LIST_MAX_ITEMS) break;
      }
    }
    walk(full, 0);
    return sendJSON(res, 200, { ok:true, items: out });
  } catch { return sendJSON(res, 400, { ok:false, error:'bad_path' }); }
}
function handleRepoRead(req, res) {
  wrap(res,'repo_read'); inc(metrics.req_total,'repo_read');
  const auth = authCtx(req); if (!auth.ok) return sendJSON(res, 401, { ok:false, error:'unauthorized' });
  try {
    const u = new URL(req.url, 'http://x');
    const p = u.searchParams.get('path') || '';
    const full = safeJoin(REPO_ROOT, p);
    const data = fs.readFileSync(full, 'utf8');
    res.writeHead(200, { 'Content-Type':'text/plain; charset=utf-8' });
    res.end(data);
  } catch { return sendJSON(res, 400, { ok:false, error:'bad_path_or_read' }); }
}
function handleRepoDownload(req, res) {
  wrap(res,'repo_download'); inc(metrics.req_total,'repo_download');
  const auth = authCtx(req); if (!auth.ok) return sendJSON(res, 401, { ok:false, error:'unauthorized' });
  try {
    const u = new URL(req.url, 'http://x');
    const p = u.searchParams.get('path') || '';
    const full = safeJoin(REPO_ROOT, p);
    const s = fs.createReadStream(full);
    res.writeHead(200, { 'Content-Type':'application/octet-stream' });
    s.pipe(res);
  } catch { return sendJSON(res, 400, { ok:false, error:'bad_path_or_read' }); }
}

function handleJobsList(req, res) {
  wrap(res,'jobs_list'); inc(metrics.req_total,'jobs_list');
  const auth = authCtx(req); if (!auth.ok) return sendJSON(res, 401, { ok:false, error:'unauthorized' });
  const parsed = url.parse(req.url, true);
  const state = String(parsed.query.state || 'queue');
  let limit = parseInt(String(parsed.query.limit || '100'), 10);
  if (isNaN(limit) || limit <= 0) limit = 100;

  let dir;
  if (state === 'queue') dir = QUEUE_DIR;
  else if (state === 'done') dir = DONE_DIR;
  else if (state === 'fail' || state === 'failed') dir = FAIL_DIR;
  else return sendJSON(res, 400, { ok:false, error:'bad_state' });

  let items = [];
  try {
    items = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
      .map(f => ({ file: f, mtime: Math.floor(fs.statSync(path.join(dir, f)).mtimeMs / 1000) }))
      .sort((a,b) => b.mtime - a.mtime).slice(0, limit);
  } catch {}
  return sendJSON(res, 200, { ok:true, state, count: items.length, items });
}
function handleJobsLog(req, res) {
  wrap(res,'jobs_log'); inc(metrics.req_total,'jobs_log');
  const auth = authCtx(req); if (!auth.ok) return sendJSON(res, 401, { ok:false, error:'unauthorized' });
  const parsed = url.parse(req.url, true);
  const raw = String(parsed.query.file || '');
  const safe = String(raw || '').replace(/[^A-Za-z0-9._-]/g, '');
  if (!safe) return sendJSON(res, 400, { ok:false, error:'bad_file' });

  if (safe.endsWith('.log')) {
    const lines = parseInt(String(parsed.query.lines || '200'), 10) || 200;
    let logPath = path.join(LOG_DIR, safe);
    try {
      if (raw.includes('/')) {
        const abs = fs.realpathSync(path.join('/home/genweb/agent', raw));
        const allowedRoots = [LOG_DIR, DONE_DIR, FAIL_DIR].map(r => fs.realpathSync(r));
        if (allowedRoots.some(r => abs === r || abs.startsWith(r + path.sep))) logPath = abs;
      }
    } catch {}
    try {
      if (!fs.existsSync(logPath) || !fs.statSync(logPath).isFile()) return sendJSON(res, 404, { ok:false, error:'not_found' });
      const buf = fs.readFileSync(logPath, 'utf8');
      const arr = buf.split(/\r?\n/);
      const tail = arr.slice(-lines).join('\n');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8' });
      return res.end(tail);
    } catch { return sendJSON(res, 500, { ok:false, error:'read_error' }); }
  }

  if (safe.endsWith('.json')) {
    const candidates = [ path.join(DONE_DIR, safe), path.join(FAIL_DIR, safe), path.join(QUEUE_DIR, safe) ];
    let found = null;
    for (const pth of candidates) { try { if (fs.existsSync(pth) && fs.statSync(pth).isFile()) { found = pth; break; } } catch {} }
    if (!found) return sendJSON(res, 404, { ok:false, error:'not_found' });
    try {
      const text = fs.readFileSync(found, 'utf8');
      let obj; try { obj = JSON.parse(text); } catch { return sendJSON(res, 422, { ok:false, error:'invalid_json_in_job' }); }
      return sendJSON(res, 200, obj);
    } catch { return sendJSON(res, 500, { ok:false, error:'read_error' }); }
  }
  return sendJSON(res, 400, { ok:false, error:'bad_file' });
}

/* ---------------- Diff endpoints ---------------- */
async function handleDiffSubmit(req, res) {
  applyCORS(req,res); wrap(res,'diff_submit'); inc(metrics.req_total,'diff_submit');
  if (!maybeBlockBrowserPost(req,res,true)) return;
  const auth = authCtx(req); if (!auth.ok) return sendJSON(res, 401, { ok:false, error:'unauthorized' });
  readBodyLimited(req, 512*1024, async (err, buf) => {
    if (err) return sendJSON(res, err.code === 413 ? 413 : 400, { ok:false, error: err.message || 'read_error' });
    try {
      const body = JSON.parse(buf.toString('utf8') || '{}');
      let diff = String(body.diff || '');
      diff = normalizeDiff(diff);
      if (looksBinaryDiff(diff)) return sendJSON(res, 400, { ok:false, error:'binary_patch' });
      const message = String(body.message || 'Patch via /diff_submit');
      const base = String(body.base_branch || CANONICAL_BRANCH);
      const idemHeader = String(req.headers['x-idempotency-key'] || '');
      const idemBody   = String(body.idempotency_key || '');
      const idemVal    = idemHeader || idemBody || '';
      const sizeChk = enforceDiffSize(diff); if (!sizeChk.ok) return sendJSON(res, 413, { ok:false, error:sizeChk.msg });
      const pchk = stepPathsUnderRepo(diff, allowedPrefixesFromAuth(auth)); if (!pchk.ok) return sendJSON(res, 400, { ok:false, error:pchk.error });
      const out = await enqueuePatchJob({ base, message, diff, idemVal, reqInfo: { from:'diff_submit', ip: ipOf(req), ua: String(req.headers['user-agent'] || '') } });

      auditWrite({
        kind: 'diff_submit',
        ip: ipOf(req),
        message,
        queued: out.queued,
        sha256: out.sha256
      });

      return sendJSON(res, 200, { ok:true, ...out });
    } catch { return sendJSON(res, 400, { ok:false, error:'bad_request' }); }
  });
}
async function handleDiffDryRun(req, res) {
  applyCORS(req,res); wrap(res,'diff_dryrun'); inc(metrics.req_total,'diff_dryrun');
  if (!maybeBlockBrowserPost(req,res,false)) return;

  // auth not required for dryrun, but constrain paths if a scoped token is supplied
  const auth = authCtx(req); // may be {ok:false}

  const ip = ipOf(req);
  const rl = rlCheck(ip, 'dryrun', DRYRUN_RL_PER_MIN);
  if (!rl.ok) return sendJSON(res, 429, { ok:false, error:'rate_limited', retry_after: RL_RETRY_AFTER_SEC });

  const lowTrustKey = String(req.headers['x-dryrun-key'] || '');
  if (DRYRUN_KEY && lowTrustKey !== DRYRUN_KEY) return sendJSON(res, 401, { ok:false, error:'unauthorized' });

  readBodyLimited(req, 512*1024, async (err, buf) => {
    if (err) return sendJSON(res, err.code === 413 ? 413 : 400, { ok:false, error: err.message || 'read_error' });
    try {
      const body  = JSON.parse(buf.toString('utf8') || '{}');
      let diff  = String(body.diff || '');
      const base  = String(body.base_branch || CANONICAL_BRANCH);
      if (!diff.trim()) return sendJSON(res, 400, { ok:false, error:'empty_diff' });
      diff = normalizeDiff(diff);
      if (looksBinaryDiff(diff)) return sendJSON(res, 400, { ok:false, error:'binary_patch' });
      const sizeChk = enforceDiffSize(diff); if (!sizeChk.ok) return sendJSON(res, 413, { ok:false, error:sizeChk.msg });
      const pchk = stepPathsUnderRepo(diff, allowedPrefixesFromAuth(auth)); if (!pchk.ok) return sendJSON(res, 400, { ok:false, error:pchk.error });
      const out = await gitDryRun(diff, base);
      return sendJSON(res, out.ok ? 200 : 422, { ok: !!out.ok, result: out.ok ? 'ok' : 'fail', detail: out.error || null });
    } catch { return sendJSON(res, 400, { ok:false, error:'bad_json' }); }
  });
}

/* ---------------- Auth-required job submit ---------------- */
async function handleJobSubmit(req, res) {
  applyCORS(req,res); wrap(res,'job_submit'); inc(metrics.req_total,'job_submit');
  if (!maybeBlockBrowserPost(req,res,true)) return;
  const auth = authCtx(req); if (!auth.ok) return sendJSON(res, 401, { ok:false, error:'unauthorized' });

  readBodyLimited(req, 512*1024, async (err, buf) => {
    if (err) return sendJSON(res, err.code === 413 ? 413 : 400, { ok:false, error: err.message || 'read_error' });
    try {
      const body = JSON.parse(buf.toString('utf8') || '{}');
      const steps   = Array.isArray(body.steps) ? body.steps : [];
      const workdir = String(body.workdir || REPO_ROOT);
      const vErr = validateCommandsSteps(steps);
      if (vErr) return sendJSON(res, 400, { ok:false, error:`commands_validation:${vErr}` });
      const idemHeader = String(req.headers['x-idempotency-key'] || '');
      const idemBody   = String(body.idempotency_key || '');
      const idemVal    = idemHeader || idemBody || '';
      const out = enqueueCommandsJob({ schema:1, steps, workdir, idemVal, reqInfo: { from:'job_submit_action_node', ip: ipOf(req), ua: String(req.headers['user-agent'] || '') } });

      auditWrite({
        kind: 'job_submit',
        ip: ipOf(req),
        queued: out.queued,
        steps_count: steps.length
      });

      return sendJSON(res, 200, { ok:true, ...out });
    } catch { return sendJSON(res, 400, { ok:false, error:'bad_request' }); }
  });
}

/* ---------------- Config & metrics ---------------- */
function handleConfig(req, res) {
  wrap(res,'config'); inc(metrics.req_total,'config');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }
  return sendJSON(res, 200, {
    ok: true,
    port: PORT,
    repo_root: REPO_ROOT,
    branch: CANONICAL_BRANCH,
    allowed_prefixes: ALLOWED_PATH_PREFIXES,
    node: process.version,
    model: OPENAI_MODEL,
    prompt_verbose: Boolean(process.env.PROMPT_VERBOSE && process.env.PROMPT_VERBOSE !== '0')
  });
}
function handleMetrics(req, res) {
  wrap(res,'metrics'); inc(metrics.req_total,'metrics');
  if (req.method !== 'GET') { res.statusCode=405; return res.end(); }
  res.writeHead(200, {'Content-Type':'text/plain; version=0.0.4'});
  for (const [k,v] of Object.entries(metrics.req_total))  res.write(`ai2_req_total{route="${k}"} ${v}\n`);
  for (const [k,v] of Object.entries(metrics.route_2xx))  res.write(`ai2_route_2xx{route="${k}"} ${v}\n`);
  for (const [k,v] of Object.entries(metrics.route_4xx))  res.write(`ai2_route_4xx{route="${k}"} ${v}\n`);
  for (const [k,v] of Object.entries(metrics.route_5xx))  res.write(`ai2_route_5xx{route="${k}"} ${v}\n`);
  return res.end();
}

/* ---------------- Tiny helpers ---------------- */
function readBodyLimited(req, limit, cb) {
  let size = 0; const chunks = [];
  req.on('data', (c) => {
    size += c.length; if (size > limit) { req.destroy(); const e = new Error('payload_too_large'); e.code = 413; return cb(e); }
    chunks.push(c);
  });
  req.on('end', () => cb(null, Buffer.concat(chunks)));
  req.on('error', (e) => cb(e));
}

/* ---------------- Tiny route matcher ---------------- */
function isRoute(req, pathname, methods, p) {
  const okMethod = Array.isArray(methods) ? methods.includes(req.method) : req.method === methods;
  return okMethod && (pathname === p || pathname === `/ai2${p}` || pathname === `${p}/` || pathname === `/ai2${p}/`);
}

/* ---------------- Router ---------------- */
function route(req, res) {
  applyCORS(req,res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';

  // Optionally block CORS origins not in allowlist
  if (CORS_ORIGINS.length && req.headers.origin && !(CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(req.headers.origin))) {
    res.statusCode = 403; return res.end('forbidden');
  }

  // static
  if (pathname.startsWith('/ai2/static/')) return serveStatic(req, res, pathname.replace('/ai2/static/', ''));

  // health
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2/_health') || isRoute(req, pathname, ['GET','HEAD'], '/_health')) return handleHealth(req,res);
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2/health') || isRoute(req, pathname, ['GET','HEAD'], '/health'))     return handleHealth(req,res);

  // version
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2/version') || isRoute(req, pathname, ['GET','HEAD'], '/version'))    return handleVersion(req,res);

  // config
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2/_config') || isRoute(req, pathname, ['GET','HEAD'], '/_config'))     return handleConfig(req,res);

  // metrics
  if (isRoute(req, pathname, ['GET'], '/ai2/metrics') || isRoute(req, pathname, ['GET'], '/metrics')) return handleMetrics(req,res);

  // OpenAI check
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2/_openai_check')) return handleOpenAICheck(req, res);

  // root
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2') || isRoute(req, pathname, ['GET','HEAD'], '/')) return handleRoot(req, res);

  // echo
  if (isRoute(req, pathname, 'POST', '/ai2/echo')  || isRoute(req, pathname, 'POST', '/echo'))  return handleEcho(req,res);

  // planner
  if (isRoute(req, pathname, 'POST', '/ai2/plan') || isRoute(req, pathname, 'POST', '/plan')) return handlePlan(req, res);

  // auth: jobs
  if (isRoute(req, pathname, 'POST', '/ai2/job_submit') || isRoute(req, pathname, 'POST', '/job_submit')) return handleJobSubmit(req, res);
  if (isRoute(req, pathname, 'POST', '/ai2/diff_submit') || isRoute(req, pathname, 'POST', '/diff_submit')) return handleDiffSubmit(req, res);
  if (isRoute(req, pathname, 'POST', '/ai2/diff_dryrun') || isRoute(req, pathname, 'POST', '/diff_dryrun')) return handleDiffDryRun(req, res);

  // plans history (auth)
  if (isRoute(req, pathname, ['GET'], '/ai2/plans/list')) return handlePlansList(req,res);
  if (isRoute(req, pathname, ['GET'], '/ai2/plans/read')) return handlePlansRead(req,res);

  // repo (auth)
  if (isRoute(req, pathname, ['GET','POST'], '/ai2/repo/ls') || isRoute(req, pathname, ['GET','POST'], '/repo/ls')) return handleRepoLs(req,res);
  if (isRoute(req, pathname, ['GET','POST'], '/ai2/repo/read') || isRoute(req, pathname, ['GET','POST'], '/repo/read')) return handleRepoRead(req,res);
  if (isRoute(req, pathname, ['GET','POST'], '/ai2/repo/download') || isRoute(req, pathname, ['GET','POST'], '/repo/download')) return handleRepoDownload(req,res);

  // jobs (auth)
  if (isRoute(req, pathname, ['GET','POST'], '/ai2/jobs/list') || isRoute(req, pathname, ['GET','POST'], '/jobs/list')) return handleJobsList(req, res);
  if (isRoute(req, pathname, ['GET','POST'], '/ai2/jobs/log')  || isRoute(req, pathname, ['GET','POST'], '/jobs/log'))   return handleJobsLog(req, res);

  res.statusCode = 404; res.end('nf');
}

/* ---------------- Idempotency store ---------------- */
const IDEM_DIR_MARKERS = '/home/genweb/agent/idempotency';
try { fs.mkdirSync(IDEM_DIR_MARKERS, { recursive:true, mode:0o700 }); } catch {}
function checkIdempotencyOr409(idemKey, bodyStr) {
  if (!idemKey) return { ok:false, code: 400, msg:'Missing X-Idempotency-Key' };
  const safe = idemSan(idemKey);
  const hash = sha256hex(bodyStr || '');
  const fp = path.join(IDEM_DIR_MARKERS, safe + '.json');
  try {
    const prev = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (prev && prev.hash && prev.hash === hash) return { ok:true };
    return { ok:false, code:409, msg:'Idempotency conflict: body differs for same key' };
  } catch {}
  try { fs.writeFileSync(fp, JSON.stringify({ ts: nowISO(), hash }), { flag:'wx', mode:0o600 }); } catch {}
  return { ok:true };
}

/* ---------------- Server ---------------- */
const PORT = parseInt(process.env.PORT || '3005', 10);
http.createServer(route).listen(PORT, () => {
  console.log(`[ai2] listening on :${PORT}`);
  console.log(`[ai2] planner model: ${OPENAI_MODEL}`);
});
