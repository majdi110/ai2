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

// Plans persistence (Phase 3)
const PLANS_DIR    = '/home/genweb/agent/work/plans';

const MAX_BYTES    = 512 * 1024; // generic read cap

// Active repo path (this app's own repo)
const REPO_ROOT      = '/home/genweb/public_html/datav.belocloud.com/ai2';
const LIST_MAX_DEPTH = 3;
const LIST_MAX_ITEMS = 2000;
const HIDE_NAMES     = new Set(['.git', 'node_modules', '.env']);

// OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL   = process.env.OPENAI_MODEL   || 'gpt-4.1-mini';

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

// ----- helpers -----
const ipOf     = (req) => String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '');
const safeJobBasename = (s) => String(s || '').replace(/[^A-Za-z0-9._-]/g, '');
const ts       = () => {
  const d = new Date(), p = n => String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
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

// simple path checks for "under repo root" from diffs
function stepPathsUnderRepo(diff) {
  const re = /^diff --git a\/([^\n]+) b\/([^\n]+)$/mg;
  let m; let n = 0;
  while ((m = re.exec(diff)) !== null) {
    n++;
    const a = m[1], b = m[2];
    if (!a || !b) return { ok:false, error:'missing_paths' };
    if (a.startsWith('/') || b.startsWith('/')) return { ok:false, error:'abs_path' };
    if (a.includes('..') || b.includes('..')) return { ok:false, error:'path_traversal' };
    if (a.includes('\\') || b.includes('\\')) return { ok:false, error:'backslash_path' };
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

/* -------------------- OpenAI plan support -------------------- */
function buildPlannerSystemPrompt() {
  return [
    'You are an automation planner for my repo. Return STRICT JSON (no prose) that follows this schema exactly:',
    '{',
    '  "schema": 1,',
    '  "id": "<string unique id>",',
    '  "status": "planned",',
    '  "goal": "<short description>",',
    '  "constraints": {',
    '    "base_branch": "public",',
    '    "allowed_ops": ["create","modify","delete"],',
    '    "root_dir": "/home/genweb/public_html/datav.belocloud.com/ai2"',
    '  },',
    '  "steps": [',
    '    {',
    '      "type":"patch",',
    '      "op":"create|modify|delete",',
    '      "base_branch":"public",',
    '      "message":"<git commit message>",',
    '      "diff":"<unified diff starting with diff --git ...>"',
    '    }',
    '    // or',
    '    { "type":"commands", "schema":1, "workdir":"/home/genweb/public_html/datav.belocloud.com/ai2", "steps":["..."] }',
    '  ],',
    '  "combined_diff": null,',
    '  "artifacts": null,',
    '  "telemetry": null',
    '}',
    'Rules:',
    '- All file paths must be under /home/genweb/public_html/datav.belocloud.com/ai2 (use relative paths like public/..., app files at repo root).',
    "- Unified diffs MUST start with 'diff --git ' and be valid git-format patches.",
    '- Prefer a single patch step when possible. Keep diffs < 200 KB.',
    '- No markdown or comments outside the JSON.',
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
      // ---- NEW: Normalize CRLF -> LF BEFORE regex checks
      if (typeof s.diff === 'string') {
        s.diff = s.diff.replace(/\r\n/g, '\n');
      }
      if (!['create','modify','delete'].includes(String(s.op||''))) return `step_${i}_bad_op`;
      if (typeof s.diff !== 'string' || !s.diff.startsWith('diff --git ')) return `step_${i}_bad_diff`;
      const size = Buffer.byteLength(s.diff,'utf8'); if (size > MAX_DIFF_BYTES) return `step_${i}_diff_too_large`;
      const pairsRe = /^diff --git a\/([^\n]+) b\/([^\n]+)$/mg;
      let m; let count=0;
      while ((m = pairsRe.exec(s.diff)) !== null) {
        count++;
        const a=m[1], b=m[2];
        if (!a || !b) return `step_${i}_missing_paths`;
        if (a.startsWith('/') || b.startsWith('/')) return `step_${i}_abs_path`;
        if (a.includes('..') || b.includes('..')) return `step_${i}_path_traversal`;
        if (a.includes('\\') || b.includes('\\')) return `step_${i}_backslash_path`;
      }
      if (count===0) return `step_${i}_no_paths`;
      const autoOp = inferStepOpFromDiff(s.diff);
      if (autoOp !== s.op) return `step_${i}_op_mismatch`;
    } else if (s.type === 'commands') {
      if ((s.schema|0) !== 1 || !Array.isArray(s.steps) || s.steps.length === 0) return `step_${i}_bad_commands`;
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

    const baseRaw = String(body.base_branch || CANONICAL_BRANCH);
    const br = enforceCanonicalBranch(baseRaw);
    if(!br.ok) return sendJSON(res, br.code, { ok:false, error: br.msg });

    const previewOnly = Boolean(body.preview_only);
    const continueOnError = Boolean(body.continue_on_error);
    const wantCombined = Boolean(body.return_combined_diff);
    const goalText = String(body.goal || body.prompt || '').slice(0, 200);

    // If caller supplied steps (strict or legacy), use them and DO NOT require OpenAI.
    let plan = normalizeIncomingPlan(body, br.branch, goalText);

    // Otherwise: prompt-driven planning via OpenAI
    if (!plan) {
      const prompt = String(body.prompt || '').trim();
      if (!prompt) return sendJSON(res, 400, { ok:false, error:'prompt_required' });
      if (prompt.length > MAX_PROMPT_CHARS) return sendJSON(res, 413, { ok:false, error:`prompt_too_long`, limit: MAX_PROMPT_CHARS });
      if (!OPENAI_API_KEY) return sendJSON(res, 500, { ok:false, error:'missing_openai_key' });
      try {
        const ai = await callOpenAIPlan(prompt);
        plan = normalizeIncomingPlan(
          isObj(ai) && Array.isArray(ai.steps) ? { steps: ai.steps, preview_only: previewOnly, goal: goalText } :
          isObj(ai) && Array.isArray(ai.plan)  ? { plan:  ai.plan,  preview_only: previewOnly, goal: goalText } :
          null,
          br.branch,
          goalText
        );
        if (!plan) return sendJSON(res, 422, { ok:false, error:'ai_bad_plan_shape', ai });
      } catch (e) {
        return sendJSON(res, 502, { ok:false, error: String(e && e.message || e) });
      }
    }

    // ---- NEW: detect JSON-escaped "\n" diffs RIGHT BEFORE VALIDATION
    for (let i = 0; i < plan.steps.length; i++) {
      const s = plan.steps[i];
      if (s && s.type === 'patch' && typeof s.diff === 'string') {
        const looksEscaped = s.diff.includes('\\n') && !s.diff.includes('\n');
        if (looksEscaped) {
          return sendJSON(res, 422, {
            ok: false,
            error: 'diff_likely_json_escaped',
            hint: "Send raw diff bytes. With jq: jq -n --rawfile diff patch.diff '{diff:$diff, base_branch:\"public\"}'"
          });
        }
      }
    }

    // Validate strict envelope (validatePlanEnvelope does CRLF->LF normalization per step)
    const verr = validatePlanEnvelope(plan);
    if (verr) return sendJSON(res, 422, { ok:false, error: verr, plan });

    // Combined diff (on demand)
    if (wantCombined) plan.combined_diff = buildCombinedDiff(plan.steps);

    // Preview path: no enqueue/apply
    if (previewOnly) {
      plan.status = 'preview';
      plan.telemetry = { preview_only:true, ts: nowISO() };
      try { fs.writeFileSync(path.join(PLANS_DIR, `${plan.id}.json`), JSON.stringify(plan,null,2)); } catch(e){}
      return sendJSON(res, 200, { ok:true, plan });
    }

    // Apply path: dry-run every patch and enqueue jobs
    const stepResults = [];
    for (let i=0;i<plan.steps.length;i++) {
      const s = plan.steps[i];
      try {
        if (s.type === 'patch') {
          const check = await gitDryRun(String(s.diff||''), br.branch);
          if (!check.ok) {
            stepResults.push({ i, type:'patch', ok:false, error:'dryrun_failed', detail:(check.error||'').slice(0,400) });
            if (!continueOnError) { plan.status='failed'; break; } else { continue; }
          }
          const out = await enqueuePatchJob({
            base: br.branch,
            message: String(s.message || `Plan patch ${nowISO()}`),
            diff: String(s.diff||''),
            idemVal: `${plan.id}-${i}`,
            reqInfo: { from:'plan_endpoint', ip: ipOf(req), ua: String(req.headers['user-agent'] || '') }
          });
          stepResults.push({ i, type:'patch', ok:true, queued: out.queued, sha256: out.sha256 });
        } else if (s.type === 'commands') {
          const out = enqueueCommandsJob({
            schema: 1,
            steps: (Array.isArray(s.steps)? s.steps.map(String):[]),
            workdir: s.workdir || REPO_ROOT,
            idemVal: `${plan.id}-${i}`,
            reqInfo: { from:'plan_endpoint', ip: ipOf(req), ua: String(req.headers['user-agent'] || '') }
          });
          stepResults.push({ i, type:'commands', ok:true, queued: out.queued });
        }
      } catch (e) {
        stepResults.push({ i, ok:false, error:String(e && e.message || e).slice(0,400) });
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

    return sendJSON(res, 200, { ok:true, plan, stepResults });
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

      // ---- NEW: helpful 422 if JSON-escaped "\n" but no real newlines
      const looksEscaped = diff.includes('\\n') && !diff.includes('\n');
      if (looksEscaped) {
        return sendJSON(res, 422, {
          ok: false,
          error: 'diff_likely_json_escaped',
          hint: "Send raw diff bytes. With jq: jq -n --rawfile diff patch.diff '{diff:$diff, base_branch:\"public\"}'"
        });
      }

      // ---- NEW: Normalize CRLF -> LF BEFORE validation
      diff = diff.replace(/\r\n/g, '\n');

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
});
