// services/queue.js
'use strict';
const fs = require('fs');
const path = require('path');
const { QUEUE_DIR } = require('../config/constants');
const { idemSan, sha256hex } = require('../utils/strings');

try { fs.mkdirSync(QUEUE_DIR, { recursive:true, mode:0o700 }); } catch {}

function ts() {
  const d = new Date(), p = n => String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function writeQueueItem(basename, jsonObj) {
  const name = String(basename || ('job-' + ts())).replace(/[^A-Za-z0-9._-]/g,'_');
  const fp   = path.join(QUEUE_DIR, name + '.json');
  fs.writeFileSync(fp, JSON.stringify(jsonObj, null, 2), { mode:0o600 });
  return { queued: path.basename(fp), sha256: sha256hex(JSON.stringify(jsonObj)) };
}

function enqueueCommandsJob({ schema=1, steps=[], workdir='.', idemVal='', reqInfo={} }) {
  const job = { type:'commands', schema, workdir, steps, idempotency_key: idemSan(idemVal), requested_at: new Date().toISOString(), request_info: reqInfo };
  return writeQueueItem('job-' + ts(), job);
}
function enqueuePatchJob({ base='public', message='', diff='', idemVal='', reqInfo={} }) {
  const job = { type:'patch', schema:1, base_branch: base, message, diff, idempotency_key: idemSan(idemVal), requested_at: new Date().toISOString(), request_info: reqInfo };
  return writeQueueItem('job-' + ts(), job);
}

module.exports = { enqueueCommandsJob, enqueuePatchJob };

