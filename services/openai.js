// services/openai.js
'use strict';
const https = require('https');
const fs = require('fs');
const { OPENAI_KEY_FILE } = require('../config/constants');

let OPENAI_KEY = '';
function getOpenAIKey() {
  if (OPENAI_KEY) return OPENAI_KEY;
  try { OPENAI_KEY = String(fs.readFileSync(OPENAI_KEY_FILE, 'utf8') || '').trim(); } catch {}
  if (!OPENAI_KEY) OPENAI_KEY = (process.env.OPENAI_API_KEY || '').trim();
  return OPENAI_KEY;
}
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
module.exports = { getOpenAIKey, httpsJson, openaiWithRetry };
