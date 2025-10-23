'use strict';

/**
 * BeloCloud Actions mini-server (no external deps).
 *
 * Public:
 *   GET/HEAD  /ai2/                 -> "OK (ai2)"
 *   GET/HEAD  /ai2/_health          -> { ok:true, time }
 *   GET/HEAD  /ai2/health           -> alias of /ai2/_health
 *   GET/HEAD  /ai2/version          -> { ok:true, version }
 *   GET/HEAD  /ai2/_config          -> quick config echo
 *   GET/HEAD  /ai2/_openai_check    -> quick OpenAI key/model/latency check
 *   GET/HEAD  /ai2/static/<file>    -> serve ./public/<file> (safe types)
 *   GET       /ai2/debug            -> debug info (node version, env)
 *   POST      /ai2/echo             -> debug echo; shows headers/body + decoded preview
 *   POST      /ai2/plan             -> OpenAI-backed planner (preview/apply with strict schema)
 *
 * Actions (write; require token):
 *   POST /ai2/job_submit            -> enqueue a commands job (picked by worker)
 *   POST /ai2/diff_submit           -> enqueue a unified diff (as type=patch, applied by worker)
 *   POST /ai2/diff_dryrun           -> validate a diff against the repo without enqueuing (rate limited)
 *
 * Repo browsing (read-only; require token):
 *   GET/POST /ai2/repo/ls?path=&depth=1        -> list files/dirs (modern)
 *   GET/POST /ai2/repo/read?path=...           -> read text file (modern)
 *   GET/POST /ai2/repo/download?path=...       -> download any file (octet-stream) (modern)
 *   Aliases/legacy (GET or POST accepted):
 *     /ai2/repo/list | /ai2/fs/list | /ai2/list
 *     /ai2/repo/get  | /ai2/fs/get  | /ai2/get
 *
 * Jobs (read-only; require token, GET or POST accepted):
 *   /ai2/jobs/list?state=queue|done|fail&limit=100
 *   /ai2/jobs/log?file=job-*.json[.log]&lines=200
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

// ---- Project-scoped allowed path prefixes (env: ALLOWED_PATH_PREFIXES; default public/users/)
const ALLOWED_PATH_PREFIXES =
  (process.env.ALLOWED_PATH_PREFIXES || 'public/users/')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

// Dry-run public endpoint throttling + optional low-trust key
const DRYRUN_RL_PER_MIN    = parseInt(process.env.DRYRUN_RL_PER_MIN || '10', 10);
const DRYRUN_KEY           = process.env.DRYRUN_KEY || '';
const RL_RETRY_AFTER_SEC   = parseInt(process.env.RL_RETRY_AFTER_SEC || '60', 10);

// ---- GLOBAL (multi-process) rate limiter: file-based buckets ----
const RL_DIR = '/home/genweb/agent/rl';
try { fs.mkdirSync(RL_DIR, { recursive: true, mode: 0o700 }); } catch {}

function withFileLock(lockPath, fn) {
  const start = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try { return fn(); }
      finally { try { fs.closeSync(fd); fs.unlinkSync(lockPath); } catch (e) {} }
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

// --- generic utils ---
function r4() { return Math.random().toString(36).slice(2, 6); }
function isObj(x){ return x && typeof x === 'object' && !Array.isArray(x); }
function nowISO(){ return new Date().toISOString(); }
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type':'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

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
    if (opts && opts.input) {
      ps.stdin.end(opts.input);
    }
  });
}

// enforce canonical branch
function enforceCanonicalBranch(branchRaw) {
  const b = String(branchRaw || '').trim() || CANONICAL_BRANCH;
  if (!ALLOWED_BRANCHES.has(b)) {
    return { ok:false, code:400, msg:`Unsupported base_branch '${b}'. Allowed: ${[...ALLOWED_BRANCHES].join(', ')}` };
  }
  return { ok:true, branch: b };
}

// check + record idempotency (memory-less but consistent per body hash)
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

function idemSan(s) {
  return String(s || '').replace(/[^A-Za-z0-9._:-]/g, '_');
}

// --- diff helpers ---
function enforceDiffSize(diff) {
  const n = Buffer.byteLength(String(diff || ''), 'utf8');
  if (n > MAX_DIFF_BYTES) {
    return { ok:false, code:413, msg:`Diff too large (${n} bytes). Max ${MAX_DIFF_BYTES}` };
  }
  return { ok:true };
}

// ---- CRLF normalization helper ----
function normalizeDiff(raw) {
  if (typeof raw !== 'string') return raw;
  // Convert CRLF → LF and remove stray carriage returns
  return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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
} catch (e) {
  Sentry = null;
}

/* ---------------- Phase 2: directories & constants ---------------- */
const STATIC_ROOT  = path.join(__dirname, 'public');
const VERSION_FILE = path.join(__dirname, 'VERSION.txt');

// Queue/Log dirs
const QUEUE_DIR   = '/home/genweb/agent/queue';
const DONE_DIR    = '/home/genweb/agent/done';
const FAIL_DIR    = '/home/genweb/agent/failures';
const LOG_DIR     = '/home/genweb/agent/logs';
const IDEM_DIR    = QUEUE_DIR; // legacy idempotency markers alongside jobs (kept for queue dedupe)
const DEBUG_LOG   = '/home/genweb/agent/last_action_debug.log';

// Plans persistence
const PLANS_DIR    = '/home/genweb/agent/work/plans';

const MAX_BYTES    = 512 * 1024; // generic read cap

// Active repo path (this app's own repo)
const REPO_ROOT      = '/home/genweb/public_html/datav.belocloud.com/ai2';
const LIST_MAX_DEPTH = 3;
const LIST_MAX_ITEMS = 2000;
const HIDE_NAMES     = new Set(['.git', 'node_modules', '.env']);

// OpenAI model (key is loaded lazily via getOpenAIKey())
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''; // kept for compatibility; not relied upon
const OPENAI_MODEL   = process.env.OPENAI_MODEL   || 'gpt-4o-mini';

// ----- init -----
for (const d of [QUEUE_DIR, DONE_DIR, FAIL_DIR, LOG_DIR, PLANS_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
}

// Lazily load token (don’t crash if unreadable)
let ACTION_TOKEN = '';
const TOKEN_FILE = '/home/genweb/agent/ACTION_TOKEN';
function getActionToken() {
  if (ACTION_TOKEN) return ACTION_TOKEN;
  try {
    ACTION_TOKEN = String(fs.readFileSync(TOKEN_FILE, 'utf8') || '').trim();
    if (!ACTION_TOKEN) throw new Error('empty token');
  } catch (e) {
    ACTION_TOKEN = (process.env.ACTION_TOKEN || '').trim();
    console.error(`[ai2] WARN: failed to read ACTION_TOKEN from ${TOKEN_FILE}: ${e.message}`);
  }
  return ACTION_TOKEN;
}

// Lazily load OPENAI_API_KEY (prefer file, fallback to env)
let OPENAI_KEY_CACHE = '';
const OPENAI_KEY_FILE = '/home/genweb/agent/OPENAI_API_KEY';
function getOpenAIKey() {
  if (OPENAI_KEY_CACHE) return OPENAI_KEY_CACHE;
  try {
    OPENAI_KEY_CACHE = String(fs.readFileSync(OPENAI_KEY_FILE, 'utf8') || '').trim();
    if (!OPENAI_KEY_CACHE) throw new Error('empty');
  } catch {
    OPENAI_KEY_CACHE = (process.env.OPENAI_API_KEY || '').trim();
  }
  return OPENAI_KEY_CACHE;
}

// ----- helpers -----
const ipOf     = (req) => String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '');
// Timestamp (UTC) YYYY-MM-DDTHHMMSSZ  ✅ bugfix
const safeJobBasename = (s) => String(s || '').replace(/[^A-Za-z0-9._-]/g, '');
const ts       = () => {
  const d = new Date(), p = n => String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}` +
         `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
};
function logDbg(obj) { try { fs.appendFileSync(DEBUG_LOG, JSON.stringify(obj) + '\n'); } catch (e) {} }

// post JSON via HTTPS (Responses API compatible)
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
          // Include status + snippet for easier SSE debugging
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

// Light retry wrapper for OpenAI Responses (handles 429/5xx briefly)
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
      const msg = String(e.message || '');
      if (!/HTTPS (429|5\d\d)/.test(msg)) break;
      await new Promise(r => setTimeout(r, 300 * Math.pow(2,i)));
    }
  }
  throw lastErr;
}

// read entire request body with a specific max cap
function readBodyLimited(req, maxBytes, cb) {
  const chunks = [];
  let total = 0, aborted = false;
  req.on('data', (c) => {
    total += c.length;
    if (total > maxBytes) {
      aborted = true;
      cb(Object.assign(new Error('request_entity_too_large'), { code: 413 }), null);
      try { req.destroy(); } catch (e) {}
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => aborted ? null : cb(null, Buffer.concat(chunks)));
  req.on('error', (e) => cb(e, null));
}

// queue JSON writer
function writeQueueItem(basename, jsonObj) {
  const name = safeJobBasename(basename || ('job-' + ts() + '-' + r4()));
  const fp   = path.join(QUEUE_DIR, name + '.json');
  if (fs.existsSync(fp)) throw new Error('queue_name_conflict');
  fs.writeFileSync(fp, JSON.stringify(jsonObj, null, 2), { mode: 0o600 });
  return { queued: name + '.json', sha256: sha256hex(JSON.stringify(jsonObj)) };
}

// enqueue commands job
function enqueueCommandsJob({ schema=1, steps=[], workdir=REPO_ROOT, idemVal='', reqInfo={} }) {
  if ((schema|0) !== 1) throw new Error('bad_schema');
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('empty_steps');
  const job = {
    type: 'commands',
    schema: 1,
    workdir,
    steps,
    idempotency_key: idemSan(idemVal),
    requested_at: nowISO(),
    request_info: reqInfo
  };
  return writeQueueItem('job-' + ts(), job);
}

// enqueue patch job
async function enqueuePatchJob({ base=CANONICAL_BRANCH, message='', diff='', idemVal='', reqInfo={} }) {
  const chk = enforceDiffSize(diff);
  if (!chk.ok) throw new Error(chk.msg);
  const br = enforceCanonicalBranch(base);
  if (!br.ok) throw new Error('bad_base_branch');
  const job = {
    type: 'patch',
    schema: 1,
    base_branch: br.branch,
    message: String(message || '').slice(0, 200),
    diff,
    idempotency_key: idemSan(idemVal),
    requested_at: nowISO(),
    request_info: reqInfo
  };
  return writeQueueItem('job-' + ts(), job);
}

// repo HEAD push of a diff (best-effort; worker does the real apply)
async function gitPushPatch(message, diff, baseBranch=CANONICAL_BRANCH) {
  const repo = __dirname;
  const patchPath = path.join(os.tmpdir(), `ai2-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`);
  try {
    await fsp.writeFile(patchPath, diff, 'utf8');
    await execp('git', ['fetch', '--depth=1', 'origin', baseBranch], { cwd: repo });
    await execp('git', ['checkout', '-B', baseBranch, `origin/${baseBranch}`], { cwd: repo });
    try {
      await execp('git', ['apply', '--3way', '--whitespace=nowarn', '--unsafe-paths', patchPath], { cwd: repo });
    } catch {
      await execp('git', ['apply', '--unsafe-paths', patchPath], { cwd: repo });
    }
    let hasChanges = false;
    try {
      const { stdout } = await execp('git', ['status', '--porcelain'], { cwd: repo });
      hasChanges = stdout.trim().length > 0;
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
      // strict first
      await execp('git', ['apply', '--check', '--3way', '--unsafe-paths', patchPath], { cwd: tmpDir });
      return { ok: true };
    } catch (e3) {
      // fallback for brand-new files etc.
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

/* ---------------- Phase 3: path safety + plan helpers ---------------- */

// simple path checks for "under repo root" from diffs (+ allowed prefixes)
function stepPathsUnderRepo(diff) {
  const re = /^diff --git a\/([^\n]+) b\/([^\n]+)$/mg;
  let m; let n = 0;
  const isDevNull = (p) => p === '/dev/null' || p === 'dev/null';
  const pathAllowed = (rel) =>
    ALLOWED_PATH_PREFIXES.length === 0 || ALLOWED_PATH_PREFIXES.some(p => rel.startsWith(p));
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

const ALLOWED_OPS = new Set(['create', 'modify', 'delete']);
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

/* -------------------- Commands-step safety (GAP G) -------------------- */
const CMD_ALLOWLIST = new Set([
  'node','npm','npx','pnpm','yarn',
  'git','bash','sh',
  'curl','echo','printf','sed','awk','grep','find','tee','cat'
]);
const MAX_CMD_STEPS = 5;
const MAX_CMD_LEN   = 200;

function parseFirstWord(s) {
  const m = String(s || '').trim().match(/^([^\s]+)/);
  return m ? m[1] : '';
}
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

/* -------------------- OpenAI plan support -------------------- */
function buildPlannerSystemPrompt() {
  const ROOT = "/home/genweb/public_html/datav.belocloud.com/ai2";
  return [
    // ===== Objective =====
    'You are a repository automation planner. Emit STRICT JSON only (no prose), matching the schema below.',
    '',
    // ===== Schema =====
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
    // ===== Hard rules (security & quality) =====
    'Rules:',
    `- All file paths MUST be under ${ROOT} and obey the server allowed prefixes. Use relative paths like public/...`,
    "- Unified diffs MUST start with 'diff --git ' and be valid git-format patches.",
    '- Prefer a SINGLE patch step when possible.',
    '- Keep total diff size < 200 KB; do not include large blocks.',
    '- NEVER write outside allowed prefixes. If a requested path is disallowed, adjust the plan to allowed locations only.',
    '- Do NOT include binary content. No images/binaries or large base64. Text only; tiny base64 only if absolutely necessary.',
    '- When modifying existing files, keep diffs minimal: only the changed lines plus strict context.',
    '- Use a commands step ONLY for small, safe repo tasks (e.g., npm ci, npm run build, simple git ops) and only allowed binaries.',
    '- Output must be pure JSON, no markdown, no comments.',
    '',
    // ===== Framework/boilerplate snippets the model can reuse =====
    'Templates:',
    'HTML_MINIMAL := "<!doctype html>\\n<html lang=\\"en\\">\\n<head>\\n  <meta charset=\\"utf-8\\">\\n  <title>${TITLE}</title>\\n</head>\\n<body>\\n  <h1>${H1}</h1>\\n</body>\\n</html>\\n"',
    '',
    // ===== Few-shot examples =====
    'Examples:',
    // create
    'EXAMPLE_CREATE:',
    '{',
    '  "schema":1,',
    '  "id":"ex-create-1",',
    '  "status":"planned",',
    '  "goal":"Create a welcome page",',
    '  "constraints":{"base_branch":"public","allowed_ops":["create","modify","delete"],"root_dir":"'+ROOT+'"},',
    '  "steps":[{',
    '    "type":"patch","op":"create","base_branch":"public","message":"Add welcome page",',
    '    "diff":"diff --git a/public/welcome.html b/public/welcome.html\\nnew file mode 100644\\nindex 0000000..e69de29\\n--- /dev/null\\n+++ b/public/welcome.html\\n@@ -0,0 +1,5 @@\\n+<!doctype html>\\n+<title>Welcome</title>\\n+<h1>Welcome</h1>\\n+<p>Hello!</p>\\n+"',
    '  }],',
    '  "combined_diff":null,"artifacts":null,"telemetry":null',
    '}',
    '',
    // modify
    'EXAMPLE_MODIFY:',
    '{',
    '  "schema":1,"id":"ex-mod-1","status":"planned","goal":"Update title in index.html",',
    '  "constraints":{"base_branch":"public","allowed_ops":["create","modify","delete"],"root_dir":"'+ROOT+'"},',
    '  "steps":[{',
    '    "type":"patch","op":"modify","base_branch":"public","message":"Change title to AI2 Demo",',
    '    "diff":"diff --git a/public/index.html b/public/index.html\\nindex abc1234..def5678 100644\\n--- a/public/index.html\\n+++ b/public/index.html\\n@@ -1,5 +1,5 @@\\n <!doctype html>\\n <meta charset=\\"utf-8\\">\\n-<title>Old</title>\\n+<title>AI2 Demo</title>\\n <h1>Hello</h1>\\n"',
    '  }],',
    '  "combined_diff":null,"artifacts":null,"telemetry":null',
    '}',
    '',
    // delete
    'EXAMPLE_DELETE:',
    '{',
    '  "schema":1,"id":"ex-del-1","status":"planned","goal":"Remove deprecated file",',
    '  "constraints":{"base_branch":"public","allowed_ops":["create","modify","delete"],"root_dir":"'+ROOT+'"},',
    '  "steps":[{',
    '    "type":"patch","op":"delete","base_branch":"public","message":"Remove old file",',
    '    "diff":"diff --git a/public/old.txt b/public/old.txt\\ndeleted file mode 100644\\nindex 1a2b3c4..0000000\\n--- a/public/old.txt\\n+++ /dev/null\\n@@ -1,1 +0,0 @@\\n-legacy content\\n"',
    '  }],',
    '  "combined_diff":null,"artifacts":null,"telemetry":null',
    '}',
  ].join('\n');
}

// Helper to prepend file-context into the user prompt (GAP H)
function injectContextIntoPrompt(userText, contextBlock) {
  return contextBlock ? (`[CONTEXT FOLLOWS]\n${contextBlock}\n\n[REQUEST]\n${userText}`) : userText;
}

async function callOpenAIPlan(userPrompt) {
  if (!getOpenAIKey()) throw new Error('missing_openai_key');

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

  const j = await openaiWithRetry(body);

  const txt =
    j.output_text ||
    (j.output?.[0]?.content?.[0]?.text) ||
    (Array.isArray(j.output) && j.output.map(o => o?.content?.[0]?.text).filter(Boolean).join('\n')) ||
    (j.choices?.[0]?.message?.content) ||
    (typeof j === 'string' ? j : '');

  if (!txt) throw new Error('openai_no_output');

  let plan;
  try { plan = JSON.parse(txt); }
  catch (e) { throw new Error('openai_bad_json'); }

  return plan;
}

/* -------------------- NEW: OpenAI-backed /plan (strict envelope) -------------------- */
function normalizeIncomingPlan(body, baseBranch, goalText) {
  // strict (steps[])
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
  // legacy (plan[])
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

function validatePlanEnvelope(plan) {
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
      // Normalize CRLF -> LF BEFORE regex checks
      if (typeof s.diff === 'string') {
        s.diff = normalizeDiff(s.diff);
      }
      if (!['create','modify','delete'].includes(String(s.op||''))) return `step_${i}_bad_op`;
      if (typeof s.diff !== 'string' || !s.diff.startsWith('diff --git ')) return `step_${i}_bad_diff`;
      const size = Buffer.byteLength(s.diff,'utf8'); if (size > MAX_DIFF_BYTES) return `step_${i}_diff_too_large`;
      const pairsRe = /^diff --git a\/([^\n]+) b\/([^\n]+)$/mg;
      let m; let count=0;
      const isDevNull = (p) => p === '/dev/null' || p === 'dev/null';
      const pathAllowed = (rel) =>
        ALLOWED_PATH_PREFIXES.length === 0 || ALLOWED_PATH_PREFIXES.some(p => rel.startsWith(p));
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

function buildCombinedDiff(steps) {
  const parts = [];
  for (const s of steps) if (s.type === 'patch' && typeof s.diff === 'string') parts.push(s.diff.trimEnd());
  return parts.length ? (parts.join('\n') + '\n') : null;
}

/* -------------------- Plans history (auth) -------------------- */
function handlePlansList(req, res) {
  if (!authOk(req)) return sendJSON(res, 401, { ok:false, error:'unauthorized' });
  const limit = Math.max(1, Math.min(200, parseInt((new URL(req.url,'http://x')).searchParams.get('limit')||'50',10)));
  let files = [];
  try {
    files = fs.readdirSync(PLANS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ file:f, mtime: Math.floor(fs.statSync(path.join(PLANS_DIR,f)).mtimeMs/1000) }))
      .sort((a,b)=>b.mtime-a.mtime).slice(0,limit);
  } catch {}
  return sendJSON(res, 200, { ok:true, items: files });
}

// Quick config echo for sanity checks
function handleConfig(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }
  return sendJSON(res, 200, {
    ok: true,
    port: PORT,
    repo_root: REPO_ROOT,
    branch: CANONICAL_BRANCH,
    allowed_prefixes: ALLOWED_PATH_PREFIXES,
    node: process.version,
    model: OPENAI_MODEL
  });
}

function handlePlansRead(req, res) {
  if (!authOk(req)) return sendJSON(res, 401, { ok:false, error:'unauthorized' });
  const id = (new URL(req.url,'http://x')).searchParams.get('id') || '';
  const safe = String(id).replace(/[^A-Za-z0-9._-]/g,'');
  if (!safe) return sendJSON(res, 400, { ok:false, error:'bad_id' });
  const fp = path.join(PLANS_DIR, `${safe}.json`);
  try { return sendJSON(res, 200, JSON.parse(fs.readFileSync(fp,'utf8'))); }
  catch { return sendJSON(res, 404, { ok:false, error:'not_found' }); }
}

/* -------------------- OpenAI health check -------------------- */
async function handleOpenAICheck(req, res) {
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

/* -------------------- /plan handler -------------------- */
async function handlePlan(req, res) {
  // optional per-env auth requirement (defaults ON)
  const REQUIRE_PLAN_AUTH = (process.env.PLAN_AUTH_REQUIRED || '1') !== '0';
  if (REQUIRE_PLAN_AUTH && !authOk(req)) {
    return sendJSON(res, 401, { ok:false, error:'unauthorized' });
  }

  const ip = ipOf(req);
  const rl = rlCheck(ip, 'plan', 30); // 30/min per IP (tune)
  if (!rl.ok) return sendJSON(res, 429, { ok:false, error:'rate_limited', retry_after: RL_RETRY_AFTER_SEC });

  // --- SSE detection (Accept: text/event-stream or ?stream=1) ---
  const parsedUrlForPlan = url.parse(req.url || '', true);
  const wantsSSE = String(parsedUrlForPlan.query && parsedUrlForPlan.query.stream || '') === '1'
                || String(req.headers['accept'] || '').toLowerCase().includes('text/event-stream');
  // optional file list via query (?include_files=path&include_files=other)
  const includeFiles = Array.isArray(parsedUrlForPlan.query && parsedUrlForPlan.query.include_files)
    ? parsedUrlForPlan.query.include_files
    : (parsedUrlForPlan.query && parsedUrlForPlan.query.include_files ? [parsedUrlForPlan.query.include_files] : null);

  // Helper to emit SSE events safely (no-op when not in SSE mode)
  const sseEmit = (name, payload) => {
    if (!wantsSSE) return;
    try {
      const line = JSON.stringify({ event: String(name || ''), ...payload });
      res.write(`data: ${line}\n\n`);
    } catch {}
  };

  // If streaming, set headers up front
  if (wantsSSE) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    try { res.write(`data: ${JSON.stringify({ event: 'planning_started', ts: nowISO() })}\n\n`); } catch {}
  }

  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) return sendJSON(res, 415, { ok:false, error:'unsupported_media_type' });

  readBodyLimited(req, MAX_PLAN_BODY_BYTES, async (err, buf) => {
    if (err) {
      if (wantsSSE) { sseEmit('final', { ok:false, error: err.message || 'read_error' }); try { return res.end(); } catch {} }
      return sendJSON(res, err.code === 413 ? 413 : 400, { ok:false, error: err.message || 'read_error' });
    }

    const bodyStr = buf.toString('utf8');

    // Phase 1: require idempotency
    const idem = String(req.headers['x-idempotency-key'] || '');
    const idemChk = checkIdempotencyOr409(idem, bodyStr);
    if(!idemChk.ok){
      if (wantsSSE) { sseEmit('final', { ok:false, error: idemChk.msg }); try { return res.end(); } catch {} }
      return sendJSON(res, idemChk.code, { ok:false, error: idemChk.msg });
    }

    let body = {};
    try { body = JSON.parse(bodyStr || '{}'); }
    catch (e) {
      if (wantsSSE) { sseEmit('final', { ok:false, error:'invalid_json' }); try { return res.end(); } catch {} }
      return sendJSON(res, 400, { ok:false, error:'invalid_json' });
    }

    const baseRaw = String(body.base_branch || CANONICAL_BRANCH);
    const br = enforceCanonicalBranch(baseRaw);
    if(!br.ok) {
      if (wantsSSE) { sseEmit('final', { ok:false, error: br.msg }); try { return res.end(); } catch {} }
      return sendJSON(res, br.code, { ok:false, error: br.msg });
    }

    const previewOnly = Boolean(body.preview_only);
    const continueOnError = Boolean(body.continue_on_error);
    const wantCombined = Boolean(body.return_combined_diff);
    const goalText = String(body.goal || body.prompt || '').slice(0, 200);
    const wantContextFiles = Array.isArray(body.include_files) ? body.include_files : (includeFiles || null);

    // (Optional) pull file context for the planner (GAP H)
    let contextBlock = '';
    if (wantContextFiles && wantContextFiles.length) {
      let total = 0;
      const MAX_CTX = 200 * 1024; // 200KB
      const uniq = [...new Set(wantContextFiles.map(String))].slice(0, 12);
      for (const rel of uniq) {
        try {
          const full = safeJoin(REPO_ROOT, rel);
          const data = fs.readFileSync(full, 'utf8');
          const slice = data.slice(0, Math.max(0, MAX_CTX - total));
          if (slice) {
            contextBlock += `\n\n--- ${rel} ---\n${slice}`;
            total += Buffer.byteLength(slice, 'utf8');
          }
          if (total >= MAX_CTX) break;
        } catch {}
      }
    }

    // If caller supplied steps (strict or legacy), use them and DO NOT require OpenAI.
    let plan = normalizeIncomingPlan(body, br.branch, goalText);

    // Otherwise: prompt-driven planning via OpenAI
    if (!plan) {
      const prompt = String(body.prompt || '').trim();
      if (!prompt) {
        if (wantsSSE) { sseEmit('final', { ok:false, error:'prompt_required' }); try { return res.end(); } catch {} }
        return sendJSON(res, 400, { ok:false, error:'prompt_required' });
      }
      if (prompt.length > MAX_PROMPT_CHARS) {
        if (wantsSSE) { sseEmit('final', { ok:false, error:'prompt_too_long', limit: MAX_PROMPT_CHARS }); try { return res.end(); } catch {} }
        return sendJSON(res, 413, { ok:false, error:`prompt_too_long`, limit: MAX_PROMPT_CHARS });
      }
      if (!getOpenAIKey()) {
        if (wantsSSE) { sseEmit('final', { ok:false, error:'missing_openai_key' }); try { return res.end(); } catch {} }
        return sendJSON(res, 500, { ok:false, error:'missing_openai_key' });
      }
      try {
        const effPrompt = injectContextIntoPrompt(prompt, contextBlock);
        const ai = await callOpenAIPlan(effPrompt);
        plan = normalizeIncomingPlan(
          isObj(ai) && Array.isArray(ai.steps) ? { steps: ai.steps, preview_only: previewOnly, goal: goalText } :
          isObj(ai) && Array.isArray(ai.plan)  ? { plan:  ai.plan,  preview_only: previewOnly, goal: goalText } :
          null,
          br.branch,
          goalText
        );
        if (!plan) {
          if (wantsSSE) { sseEmit('final', { ok:false, error:'ai_bad_plan_shape' }); try { return res.end(); } catch {} }
          return sendJSON(res, 422, { ok:false, error:'ai_bad_plan_shape' });
        }
      } catch (e2) {
        if (wantsSSE) { sseEmit('final', { ok:false, error: String(e2 && e2.message || e2) }); try { return res.end(); } catch {} }
        return sendJSON(res, 502, { ok:false, error: String(e2 && e2.message || e2) });
      }
    }

    // Validate strict envelope (includes per-step CRLF normalization and allowed-prefix checks)
    const verr = validatePlanEnvelope(plan);
    if (verr) {
      if (wantsSSE) { sseEmit('final', { ok:false, error: verr, plan: { id: plan.id, status:'failed' } }); try { return res.end(); } catch {} }
      return sendJSON(res, 422, { ok:false, error: verr, plan });
    }

    // Emit validation success
    sseEmit('validated', { ok:true, steps: plan.steps.length });

    // Combined diff (on demand)
    if (wantCombined) plan.combined_diff = buildCombinedDiff(plan.steps);

    // Preview path: no enqueue/apply
    if (previewOnly) {
      plan.status = 'preview';
      plan.telemetry = { preview_only:true, ts: nowISO() };
      try { fs.writeFileSync(path.join(PLANS_DIR, `${plan.id}.json`), JSON.stringify(plan,null,2)); } catch(e){}
      if (wantsSSE) {
        sseEmit('final', { ok:true, status:'preview', plan: { id: plan.id, status: plan.status, steps: plan.steps.length } });
        try { return res.end(); } catch {}
      } else {
        return sendJSON(res, 200, { ok:true, plan });
      }
    }

    // Apply path: dry-run every patch and enqueue jobs
    const stepResults = [];
    for (let i=0;i<plan.steps.length;i++) {
      const s = plan.steps[i];
      try {
        sseEmit('step_start', { i, type: s.type, op: s.op || null });
        if (s.type === 'patch') {
          const check = await gitDryRun(String(s.diff||''), br.branch);
          if (!check.ok) {
            stepResults.push({ i, type:'patch', ok:false, error:'dryrun_failed', detail:(check.error||'').slice(0,400) });
            sseEmit('step_error', { i, error:'dryrun_failed', detail:(check.error||'').slice(0,200) });
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
        }
      } catch (e3) {
        stepResults.push({ i, ok:false, error:String(e3 && e3.message || e3).slice(0,400) });
        sseEmit('step_error', { i, error: String(e3 && e3.message || e3).slice(0,200) });
        if (!continueOnError) { plan.status='failed'; break; }
      }
    }

    if (plan.status !== 'failed') plan.status = 'applied';
    plan.telemetry = { continue_on_error: continueOnError, ts: nowISO(), steps_applied: stepResults.length };

    try { fs.writeFileSync(path.join(PLANS_DIR, `${plan.id}.json`), JSON.stringify({ plan, stepResults }, null, 2)); } catch(e){}

    try {
      if (Sentry) {
        Sentry.withScope(scope => {
          scope.setTag('endpoint','plan');
          scope.setExtras({ id: plan.id, steps: plan.steps.length });
          Sentry.captureMessage('AI2 plan processed', 'info');
        });
      }
    } catch(e){}

    if (wantsSSE) {
      sseEmit('final', {
        ok: plan.status === 'applied',
        status: plan.status,
        plan: { id: plan.id, status: plan.status, steps: plan.steps.length },
      });
      try { return res.end(); } catch {}
    } else {
      return sendJSON(res, 200, { ok:true, plan, stepResults });
    }
  });
}

/* -------------------- Public endpoints -------------------- */
function handleRoot(req, res) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Type':'text/plain; charset=utf-8' });
    res.end('OK (ai2)');
    return;
  }
  res.statusCode = 405; res.end();
}
function handleHealth(req, res) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return sendJSON(res, 200, { ok:true, time: nowISO() });
  }
  res.statusCode = 405; res.end();
}
function handleVersion(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }
  let v = 'unknown';
  try { v = fs.readFileSync(VERSION_FILE, 'utf8').trim(); } catch {}
  if (!v) {
    try { v = execFileSync('git', ['rev-parse','--short','HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(); } catch {}
  }
  sendJSON(res, 200, { ok:true, version: v || 'unknown' });
}
function serveStatic(req, res, file) {
  const safeName = String(file || '').replace(/[^A-Za-z0-9._/-]/g, '');
  if (!safeName || safeName.includes('..')) { res.statusCode = 400; return res.end('bad_path'); }
  const ext = path.extname(safeName).toLowerCase();
  const type = ext === '.html' ? 'text/html; charset=utf-8'
             : ext === '.css'  ? 'text/css; charset=utf-8'
             : ext === '.js'   ? 'application/javascript; charset=utf-8'
             : ext === '.json' ? 'application/json; charset=utf-8'
             : ext === '.txt'  ? 'text/plain; charset=utf-8'
             : 'application/octet-stream';
  const full = path.join(STATIC_ROOT, safeName);
  if (!full.startsWith(STATIC_ROOT)) { res.statusCode = 400; return res.end('bad_path'); }
  fs.createReadStream(full).on('error', () => { res.statusCode = 404; res.end('nf'); }).pipe(res);
}

function decodeBodyPreview(raw) {
  try { return JSON.parse(raw); } catch {}
  try { return Buffer.from(raw, 'base64').toString('utf8'); } catch {}
  return String(raw).slice(0, 1000);
}
function handleEcho(req, res) {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
  readBodyLimited(req, MAX_BYTES, (err, buf) => {
    if (err) return sendJSON(res, err.code === 413 ? 413 : 400, { ok:false, error: err.message || 'read_error' });
    const body = buf.toString('utf8');
    const preview = decodeBodyPreview(body);
    return sendJSON(res, 200, { ok:true, headers: req.headers, preview });
  });
}
function handleDebug(req, res) {
  if (req.method !== 'GET') { res.statusCode = 405; return res.end(); }
  return sendJSON(res, 200, {
    ok:true,
    node: process.version,
    pid: process.pid,
    cwd: process.cwd(),
    env: {
      NODE_ENV: process.env.NODE_ENV || null,
      OPENAI_MODEL: process.env.OPENAI_MODEL || null,
      SENTRY_ENV: process.env.SENTRY_ENV || null
    }
  });
}

/* -------------------- Actions API (auth required) -------------------- */
function authOk(req) {
  const bearer = String(req.headers['authorization'] || '');
  const viaBearer = bearer.toLowerCase().startsWith('bearer ') ? bearer.slice(7).trim() : '';
  const viaKey = String(req.headers['x-api-key'] || '').trim();
  const token = getActionToken();
  return Boolean(token) && (viaBearer === token || viaKey === token);
}

async function handleJobSubmit(req, res) {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
  if (!authOk(req)) return sendJSON(res, 401, { ok:false, error:'unauthorized' });

  readBodyLimited(req, MAX_BYTES, async (err, buf) => {
    if (err) return sendJSON(res, err.code === 413 ? 413 : 400, { ok:false, error: err.message || 'read_error' });

    try {
      const body = JSON.parse(buf.toString('utf8') || '{}');
      const schema  = (body.schema|0) || 1;
      const steps   = Array.isArray(body.steps) ? body.steps : [];
      const workdir = String(body.workdir || REPO_ROOT);

      const vErr = validateCommandsSteps(steps);
      if (vErr) return sendJSON(res, 400, { ok:false, error:`commands_validation:${vErr}` });

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
      } catch {}

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
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
  if (!authOk(req)) return sendJSON(res, 401, { ok:false, error:'unauthorized' });

  readBodyLimited(req, MAX_BYTES, async (err, buf) => {
    if (err) return sendJSON(res, err.code === 413 ? 413 : 400, { ok:false, error: err.message || 'read_error' });

    try {
      const body = JSON.parse(buf.toString('utf8') || '{}');
      const diff = String(body.diff || '');
      const message = String(body.message || 'Patch via /diff_submit');
      const base = String(body.base_branch || CANONICAL_BRANCH);

      const idemHeader = String(req.headers['x-idempotency-key'] || '');
      const idemBody   = String(body.idempotency_key || '');
      const idemVal    = idemHeader || idemBody || '';

      const sizeChk = enforceDiffSize(diff);
      if (!sizeChk.ok) return sendJSON(res, 413, { ok:false, error:sizeChk.msg });

      const pchk = stepPathsUnderRepo(diff); if (!pchk.ok) return sendJSON(res, 400, { ok:false, error:pchk.error });

      const out = await enqueuePatchJob({
        base,
        message,
        diff,
        idemVal,
        reqInfo: { from:'diff_submit', ip: ipOf(req), ua: String(req.headers['user-agent'] || '') }
      });

      return sendJSON(res, 200, { ok:true, ...out });
    } catch (e) {
      logDbg({ time: nowISO(), tag:'DIFF_SUBMIT_FAIL', error: String(e) });
      return sendJSON(res, 400, { ok:false, error:'bad_request' });
    }
  });
}

async function handleDiffDryRun(req, res) {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }

  const ip = ipOf(req);
  const rl = rlCheck(ip, 'dryrun', DRYRUN_RL_PER_MIN);
  if (!rl.ok) return sendJSON(res, 429, { ok:false, error:'rate_limited', retry_after: RL_RETRY_AFTER_SEC });

  const lowTrustKey = String(req.headers['x-dryrun-key'] || '');
  if (DRYRUN_KEY && lowTrustKey !== DRYRUN_KEY) return sendJSON(res, 401, { ok:false, error:'unauthorized' });

  readBodyLimited(req, MAX_BYTES, async (err, buf) => {
    if (err) return sendJSON(res, err.code === 413 ? 413 : 400, { ok:false, error: err.message || 'read_error' });
    try {
      const body  = JSON.parse(buf.toString('utf8') || '{}');
      let diff  = String(body.diff || '');
      const base  = String(body.base_branch || CANONICAL_BRANCH);

      if (!diff.trim()) return sendJSON(res, 400, { ok:false, error:'empty_diff' });

      // Normalize CRLF -> LF BEFORE any validation
      diff = normalizeDiff(diff);

      const sizeChk = enforceDiffSize(diff);
      if (!sizeChk.ok) return sendJSON(res, 413, { ok:false, error:sizeChk.msg });

      const pchk = stepPathsUnderRepo(diff); if (!pchk.ok) return sendJSON(res, 400, { ok:false, error:pchk.error });

      const out = await gitDryRun(diff, base);
      return sendJSON(res, out.ok ? 200 : 422, { ok: !!out.ok, result: out.ok ? 'ok' : 'fail', detail: out.error || null });
    } catch (e) {
      return sendJSON(res, 400, { ok:false, error:'bad_json' });
    }
  });
}

/* -------------------- Repo browsing (auth) -------------------- */
function safeJoin(root, userPath){
  const p = path.normalize('/' + String(userPath || '').replace(/^\/+/, ''));
  const full = path.join(root, '.' + p);
  if (!full.startsWith(root)) throw new Error('path_traversal');
  return full;
}
function handleRepoLs(req, res) {
  if (!authOk(req)) return sendJSON(res, 401, { ok:false, error:'unauthorized' });
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
  } catch {
    return sendJSON(res, 400, { ok:false, error:'bad_path' });
  }
}
function handleRepoRead(req, res) {
  if (!authOk(req)) return sendJSON(res, 401, { ok:false, error:'unauthorized' });
  try {
    const u = new URL(req.url, 'http://x');
    const p = u.searchParams.get('path') || '';
    const full = safeJoin(REPO_ROOT, p);
    const data = fs.readFileSync(full, 'utf8');
    res.writeHead(200, { 'Content-Type':'text/plain; charset=utf-8' });
    res.end(data);
  } catch {
    return sendJSON(res, 400, { ok:false, error:'bad_path_or_read' });
  }
}
function handleRepoDownload(req, res) {
  if (!authOk(req)) return sendJSON(res, 401, { ok:false, error:'unauthorized' });
  try {
    const u = new URL(req.url, 'http://x');
    const p = u.searchParams.get('path') || '';
    const full = safeJoin(REPO_ROOT, p);
    const s = fs.createReadStream(full);
    res.writeHead(200, { 'Content-Type':'application/octet-stream' });
    s.pipe(res);
  } catch {
    return sendJSON(res, 400, { ok:false, error:'bad_path_or_read' });
  }
}

/* -------- Legacy/alias repo endpoints (JSON, base64 for /get) -------- */
function handleRepoListLegacy(req, res) { // returns { ok, path, items:[{path,type,size,mtime}] }
  if (!authOk(req)) return sendJSON(res, 401, { ok:false, error:'unauthorized' });

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
      if (HIDE_NAMES.has(e.name)) continue;
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
function handleRepoGetLegacy(req, res) { // returns { ok, path, size, mtime, content_b64 }
  if (!authOk(req)) return sendJSON(res, 401, { ok:false, error:'unauthorized' });

  const parsed = url.parse(req.url, true);
  const rel = String(parsed.query.path || '');

  let abs;
  try { abs = safeJoin(REPO_ROOT, rel); }
  catch { return sendJSON(res, 400, { ok:false, error:'bad path' }); }

  if (!fs.existsSync(abs)) return sendJSON(res, 404, { ok:false, error:'not found' });

  const st = fs.statSync(abs);
  if (!st.isFile()) return sendJSON(res, 400, { ok:false, error:'not a file' });
  const GET_MAX_BYTES = 256 * 1024;
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

/* -------------------- Jobs list/log (read-only; require auth) -------------------- */
function handleJobsList(req, res) {
  if (!authOk(req)) return sendJSON(res, 401, { ok:false, error:'unauthorized' });
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
    items = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ file: f, mtime: Math.floor(fs.statSync(path.join(dir, f)).mtimeMs / 1000) }))
      .sort((a,b) => b.mtime - a.mtime)
      .slice(0, limit);
  } catch { items = []; }
  return sendJSON(res, 200, { ok:true, state, count: items.length, items });
}

function handleJobsLog(req, res) {
  if (!authOk(req)) return sendJSON(res, 401, { ok:false, error:'unauthorized' });
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
        if (allowedRoots.some(r => abs === r || abs.startsWith(r + path.sep))) {
          logPath = abs;
        }
      }
    } catch {}

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

  if (safe.endsWith('.json')) {
    const candidates = [
      path.join(DONE_DIR, safe),
      path.join(FAIL_DIR, safe),
      path.join(QUEUE_DIR, safe),
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

/* -------------------- tiny route matcher -------------------- */
function isRoute(req, pathname, methods, p) {
  const okMethod = Array.isArray(methods) ? methods.includes(req.method) : req.method === methods;
  return okMethod && (pathname === p || pathname === `/ai2${p}` || pathname === `${p}/` || pathname === `/ai2${p}/`);
}

/* -------------------- Router -------------------- */
function route(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';

  // static first
  if (pathname.startsWith('/ai2/static/')) return serveStatic(req, res, pathname.replace('/ai2/static/', ''));

  // health
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2/_health') || isRoute(req, pathname, ['GET','HEAD'], '/_health'))
    return sendJSON(res, 200, { ok:true, time: nowISO() });
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2/health') || isRoute(req, pathname, ['GET','HEAD'], '/health'))
    return sendJSON(res, 200, { ok:true, time: nowISO() });

  // version
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2/version') || isRoute(req, pathname, ['GET','HEAD'], '/version'))
    return handleVersion(req, res);

  // config
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2/_config') || isRoute(req, pathname, ['GET','HEAD'], '/_config'))
    return handleConfig(req, res);

  // OpenAI check
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2/_openai_check'))
    return handleOpenAICheck(req, res);

  // root banner
  if (isRoute(req, pathname, ['GET','HEAD'], '/ai2') || isRoute(req, pathname, ['GET','HEAD'], '/'))
    return handleRoot(req, res);

  // debug & echo
  if (isRoute(req, pathname, 'GET', '/ai2/debug') || isRoute(req, pathname, 'GET', '/debug'))
    return handleDebug(req, res);
  if (isRoute(req, pathname, 'POST', '/ai2/echo') || isRoute(req, pathname, 'POST', '/echo'))
    return handleEcho(req, res);

  // Actions (auth)
  if (isRoute(req, pathname, 'POST', '/ai2/job_submit') || isRoute(req, pathname, 'POST', '/job_submit'))
    return handleJobSubmit(req, res);
  if (isRoute(req, pathname, 'POST', '/ai2/diff_submit') || isRoute(req, pathname, 'POST', '/diff_submit'))
    return handleDiffSubmit(req, res);
  if (isRoute(req, pathname, 'POST', '/ai2/diff_dryrun') || isRoute(req, pathname, 'POST', '/diff_dryrun'))
    return handleDiffDryRun(req, res);

  // Planner
  if (isRoute(req, pathname, 'POST', '/ai2/plan') || isRoute(req, pathname, 'POST', '/plan'))
    return handlePlan(req, res);

  // Plans history (auth)
  if (isRoute(req, pathname, ['GET'], '/ai2/plans/list')) return handlePlansList(req,res);
  if (isRoute(req, pathname, ['GET'], '/ai2/plans/read')) return handlePlansRead(req,res);

  // Modern repo endpoints (auth) — allow GET or POST
  if (isRoute(req, pathname, ['GET','POST'], '/ai2/repo/ls') || isRoute(req, pathname, ['GET','POST'], '/repo/ls'))
    return handleRepoLs(req, res);
  if (isRoute(req, pathname, ['GET','POST'], '/ai2/repo/read') || isRoute(req, pathname, ['GET','POST'], '/repo/read'))
    return handleRepoRead(req, res);
  if (isRoute(req, pathname, ['GET','POST'], '/ai2/repo/download') || isRoute(req, pathname, ['GET','POST'], '/repo/download'))
    return handleRepoDownload(req, res);

  // Legacy/aliases (auth) — allow GET or POST
  if (
    isRoute(req, pathname, ['GET','POST'], '/ai2/repo/list') ||
    isRoute(req, pathname, ['GET','POST'], '/ai2/fs/list')   ||
    isRoute(req, pathname, ['GET','POST'], '/ai2/list')      ||
    isRoute(req, pathname, ['GET','POST'], '/repo/list')     ||
    isRoute(req, pathname, ['GET','POST'], '/fs/list')       ||
    isRoute(req, pathname, ['GET','POST'], '/list')
  ) return handleRepoListLegacy(req, res);

  if (
    isRoute(req, pathname, ['GET','POST'], '/ai2/repo/get') ||
    isRoute(req, pathname, ['GET','POST'], '/ai2/fs/get')   ||
    isRoute(req, pathname, ['GET','POST'], '/ai2/get')      ||
    isRoute(req, pathname, ['GET','POST'], '/repo/get')     ||
    isRoute(req, pathname, ['GET','POST'], '/fs/get')       ||
    isRoute(req, pathname, ['GET','POST'], '/get')
  ) return handleRepoGetLegacy(req, res);

  // Jobs (auth) — allow GET or POST
  if (isRoute(req, pathname, ['GET','POST'], '/ai2/jobs/list') || isRoute(req, pathname, ['GET','POST'], '/jobs/list'))
    return handleJobsList(req, res);
  if (isRoute(req, pathname, ['GET','POST'], '/ai2/jobs/log')  || isRoute(req, pathname, ['GET','POST'], '/jobs/log'))
    return handleJobsLog(req, res);

  // fallback
  res.statusCode = 404; res.end('nf');
}

/* -------------------- Server -------------------- */
const PORT = parseInt(process.env.PORT || '3005', 10);
http.createServer(route).listen(PORT, () => {
  console.log(`[ai2] listening on :${PORT}`);
  console.log(`[ai2] planner model: ${OPENAI_MODEL}`);
});
