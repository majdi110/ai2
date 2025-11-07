// config/constants.js
'use strict';
const path = require('path');

/* ---------- Branch and Repo ---------- */
const CANONICAL_BRANCH = 'public';
const ALLOWED_BRANCHES = new Set([CANONICAL_BRANCH]);

/* ---------- Limits ---------- */
const MAX_DIFF_BYTES      = 200 * 1024;
const MAX_PLAN_BODY_BYTES = 256 * 1024;
const MAX_PROMPT_CHARS    = 16 * 1024;

/* ---------- Path and Security ---------- */
const ALLOWED_PATH_PREFIXES =
  (process.env.ALLOWED_PATH_PREFIXES || 'public/users/')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const DRYRUN_RL_PER_MIN  = parseInt(process.env.DRYRUN_RL_PER_MIN || '10', 10);
const DRYRUN_KEY         = process.env.DRYRUN_KEY || '';
const RL_RETRY_AFTER_SEC = parseInt(process.env.RL_RETRY_AFTER_SEC || '60', 10);

/* ---------- Directories ---------- */
const STATIC_ROOT  = path.join(__dirname, '..', 'public');
const VERSION_FILE = path.join(__dirname, '..', 'VERSION.txt');

const QUEUE_DIR = '/home/genweb/agent/queue';
const DONE_DIR  = '/home/genweb/agent/done';
const FAIL_DIR  = '/home/genweb/agent/failures';
const LOG_DIR   = '/home/genweb/agent/logs';
const PLANS_DIR = '/home/genweb/agent/work/plans';
const ARTIFACTS_DIR = '/home/genweb/agent/artifacts';

const REPO_ROOT      = '/home/genweb/public_html/datav.belocloud.com/ai2';
const LIST_MAX_DEPTH = 3;
const LIST_MAX_ITEMS = 2000;
const HIDE_NAMES     = new Set(['.git', 'node_modules', '.env']);

/* ---------- Model / Server ---------- */
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const PORT         = parseInt(process.env.PORT || '3005', 10);

const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

/* ---------- Tokens and Keys ---------- */
const TOKENS_FILE     = '/home/genweb/agent/tokens.json';
const TOKEN_FILE      = '/home/genweb/agent/ACTION_TOKEN';
const OPENAI_KEY_FILE = '/home/genweb/agent/OPENAI_API_KEY';

/* ---------- Logging and Rate Limiting ---------- */
const DEBUG_LOG        = '/home/genweb/agent/last_action_debug.log';
const IDEM_DIR_MARKERS = '/home/genweb/agent/idempotency';
const RL_DIR           = '/home/genweb/agent/rl';
const AUDIT_LOG        = '/home/genweb/agent/logs/audit.jsonl';

/* ---------- Planner Resilience / Cache ---------- */
// New configuration knobs per latest design
const PLANNER_TIMEOUT_MS      = parseInt(process.env.PLANNER_TIMEOUT_MS || '18000', 10); // 18s timeout
const PLANNER_ENABLE_FALLBACK = (process.env.PLANNER_ENABLE_FALLBACK || '1') === '1'; // fallback enabled by default

const PLAN_CACHE_DIR        = process.env.PLAN_CACHE_DIR || '/home/genweb/agent/plan-cache';
const PLAN_CACHE_TTL_SEC    = parseInt(process.env.PLAN_CACHE_TTL_SEC || '3600', 10);   // cache TTL: 1h
const PLAN_CACHE_STALE_SEC  = parseInt(process.env.PLAN_CACHE_STALE_SEC || '86400', 10); // allow stale for 24h

/* ---------- Exports ---------- */
module.exports = {
  CANONICAL_BRANCH, ALLOWED_BRANCHES,
  MAX_DIFF_BYTES, MAX_PLAN_BODY_BYTES, MAX_PROMPT_CHARS,
  ALLOWED_PATH_PREFIXES, DRYRUN_RL_PER_MIN, DRYRUN_KEY, RL_RETRY_AFTER_SEC,

  STATIC_ROOT, VERSION_FILE,
  QUEUE_DIR, DONE_DIR, FAIL_DIR, LOG_DIR, PLANS_DIR,
  ARTIFACTS_DIR, REPO_ROOT, LIST_MAX_DEPTH, LIST_MAX_ITEMS, HIDE_NAMES,

  OPENAI_MODEL, PORT, CORS_ORIGINS,

  TOKENS_FILE, TOKEN_FILE, OPENAI_KEY_FILE,

  DEBUG_LOG, IDEM_DIR_MARKERS, RL_DIR, AUDIT_LOG,

  // Planner resilience & cache
  PLANNER_TIMEOUT_MS, PLANNER_ENABLE_FALLBACK,
  PLAN_CACHE_DIR, PLAN_CACHE_TTL_SEC, PLAN_CACHE_STALE_SEC
};
