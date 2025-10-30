// utils/rl.js
'use strict';
const fs = require('fs');
const path = require('path');
const { RL_DIR, RL_RETRY_AFTER_SEC } = require('../config/constants');
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
  const crypto = require('crypto');
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
module.exports = { rlCheck };
