// app/ui.js — tiny helper without $ conflicts
const q = (s, r=document) => r.querySelector(s);
const qa = (s, r=document) => Array.from(r.querySelectorAll(s));

function loadEnv() {
  try { return JSON.parse(localStorage.getItem('ai2_env')||'{}'); } catch { return {}; }
}
function saveEnv(env) { localStorage.setItem('ai2_env', JSON.stringify(env)); }
function authHeaders(extra={}) {
  const env = loadEnv();
  const h = { 'X-Requested-With':'ai2-ui', ...extra };
  if (env.API_TOKEN) h.Authorization = `Bearer ${env.API_TOKEN}`;
  return h;
}
function apiBase() {
  const env = loadEnv();
  return (env.API_BASE || '/ai2').replace(/\/+$/,'');
}

// Simple FS helpers
async function fsWrite(path, content) {
  const res = await fetch(`${apiBase()}/_fs/write`, {
    method: 'POST',
    headers: authHeaders({'Content-Type':'application/json'}),
    body: JSON.stringify({ path, content })
  });
  if(!res.ok) throw new Error(`write ${res.status}`);
  return res.json();
}
async function fsRead(path) {
  const res = await fetch(`${apiBase()}/_fs/read?path=${encodeURIComponent(path)}`, { headers: authHeaders() });
  if(!res.ok) throw new Error(`read ${res.status}`);
  return res.json();
}
async function fsLs(path, depth=1) {
  const res = await fetch(`${apiBase()}/_fs/ls?path=${encodeURIComponent(path)}&depth=${depth}`, { headers: authHeaders() });
  if(!res.ok) throw new Error(`ls ${res.status}`);
  return res.json();
}
