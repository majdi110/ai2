// utils/cors.js
'use strict';
const { CORS_ORIGINS } = require('../config/constants');

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
function maybeBlockBrowserPost(req, res) {
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
module.exports = { applyCORS, maybeBlockBrowserPost };
