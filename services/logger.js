'use strict';

const fs = require('fs');
const path = require('path');

const LOG_DIR  = process.env.AI2_LOG_DIR || '/home/genweb/agent/logs';
const LOG_BASENAME = process.env.AI2_LOG_BASENAME || 'ai2-gateway';
const MAX_BYTES = parseInt(process.env.AI2_LOG_MAX_BYTES || '5242880', 10); // 5 MB

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true, mode: 0o700 });
}

function logPath() {
  ensureDir(LOG_DIR);
  return path.join(LOG_DIR, `${LOG_BASENAME}.jsonl`);
}

function rotateIfNeeded(fp) {
  try {
    const st = fs.statSync(fp);
    if (st.size < MAX_BYTES) return;
  } catch { return; }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = fp.replace(/\.jsonl$/, `.${ts}.jsonl`);
  try { fs.renameSync(fp, dst); } catch {}
}

function write(rec) {
  const fp = logPath();
  try { rotateIfNeeded(fp); } catch {}
  const line = JSON.stringify(rec) + '\n';
  try {
    fs.appendFileSync(fp, line, { mode: 0o600 });
  } catch (e) {
    // best-effort: try once more after ensuring dir
    try { ensureDir(LOG_DIR); fs.appendFileSync(fp, line, { mode: 0o600 }); } catch {}
  }
}

function nowIso() { return new Date().toISOString(); }

// helper for request-scoped logging
function reqLogBase(req) {
  return {
    ts: nowIso(),
    rid: req.rid,
    ip: (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || '',
    ua: req.headers['user-agent'] || '',
    method: req.method,
    url: req.url
  };
}

module.exports = { write, reqLogBase, nowIso };
