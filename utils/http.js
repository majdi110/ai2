// utils/http.js
'use strict';
const { nowISO } = require('./time');

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
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type':'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBodyLimited(req, limit, cb) {
  let size = 0; const chunks = [];
  req.on('data', (c) => {
    size += c.length; if (size > limit) { req.destroy(); const e = new Error('payload_too_large'); e.code = 413; return cb(e); }
    chunks.push(c);
  });
  req.on('end', () => cb(null, Buffer.concat(chunks)));
  req.on('error', (e) => cb(e));
}
function isRoute(req, pathname, methods, p) {
  const okMethod = Array.isArray(methods) ? methods.includes(req.method) : req.method === methods;
  return okMethod && (pathname === p || pathname === `/ai2${p}` || pathname === `${p}/` || pathname === `/ai2${p}/`);
}
module.exports = { metrics, wrap, sendJSON, readBodyLimited, isRoute };
