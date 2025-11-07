'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PLAN_CACHE_DIR, PLAN_CACHE_TTL_SEC, PLAN_CACHE_STALE_SEC } = require('../config/constants');

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true, mode: 0o700 }); }
function sha256(s){return crypto.createHash('sha256').update(s,'utf8').digest('hex');}
function keyFor(inputObj){
  // normalize: prompt + important options only
  const pick = {
    prompt: inputObj.prompt || '',
    repo: inputObj.repo || 'public',
    mode: inputObj.mode || 'default',
    constraints: inputObj.constraints || {},
  };
  return sha256(JSON.stringify(pick));
}
function pathForKey(k){ ensureDir(PLAN_CACHE_DIR); return path.join(PLAN_CACHE_DIR, `${k}.json`); }

function put(inputObj, plan, meta={}) {
  const k = keyFor(inputObj);
  const p = pathForKey(k);
  const rec = { savedAt: Date.now(), input: { ...inputObj, prompt: undefined }, plan, meta };
  fs.writeFileSync(p, JSON.stringify(rec, null, 2)+'\n', { mode: 0o600 });
  return { key:k, path:p };
}

function get(inputObj){
  const k = keyFor(inputObj);
  const p = pathForKey(k);
  if (!fs.existsSync(p)) return { hit:false };
  try {
    const rec = JSON.parse(fs.readFileSync(p,'utf8'));
    const ageSec = Math.floor((Date.now() - (rec.savedAt||0))/1000);
    const fresh = ageSec <= PLAN_CACHE_TTL_SEC;
    const staleOK = ageSec <= (PLAN_CACHE_TTL_SEC + PLAN_CACHE_STALE_SEC);
    return { hit:true, fresh, staleOK, key:k, path:p, rec };
  } catch {
    return { hit:false };
  }
}

module.exports = { put, get, keyFor };
