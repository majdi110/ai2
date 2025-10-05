const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

// ---- CONFIG ----
const BASE_URI = '/ai2';
const BASE_DIR = '/home/genweb/public_html/datav.belocloud.com/ai2';
const ACTION_TOKEN_FILE = '/home/genweb/agent/ACTION_TOKEN';
const PORT = process.env.PORT || 3000;

// Read token once at boot (fail hard if missing)
const ACTION_TOKEN = fs.readFileSync(ACTION_TOKEN_FILE, 'utf8').trim();

// Helpers
function send(res, code, payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

function ok(res, payload) { send(res, 200, payload); }
function bad(res, msg) { send(res, 400, { error: msg }); }
function forbidden(res) { send(res, 401, { error: 'unauthorized' }); }
function notFound(res) { send(res, 404, { error: 'not_found' }); }
function methodNotAllowed(res) { send(res, 405, { error: 'method_not_allowed' }); }

function nowISO() { return new Date().toISOString(); }

function getTokenFromHeaders(req) {
  const h = req.headers || {};
  // Accept both:
  //   Authorization: Bearer <token>
  //   X-Api-Key: <token>
  if (h.authorization && h.authorization.startsWith('Bearer ')) {
    return h.authorization.slice(7).trim();
  }
  if (h['x-api-key']) return String(h['x-api-key']).trim();
  return null;
}

function requireAuth(req, res) {
  const token = getTokenFromHeaders(req);
  if (!token || token !== ACTION_TOKEN) { forbidden(res); return false; }
  return true;
}

// Prevent path traversal; always resolve inside BASE_DIR
function secureJoin(p) {
  const requested = path.normalize('/' + (p || ''));
  const abs = path.join(BASE_DIR, requested);
  if (!abs.startsWith(BASE_DIR)) {
    throw new Error('path_outside_repo');
  }
  return abs;
}

async function listRecursive(absRoot, depth) {
  const results = [];
  async function walk(current, d) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const e of entries) {
      // Skip hidden internals that shouldn’t be exposed:
      if (e.name === 'tmp' || e.name === 'node_modules' || e.name === '.git') continue;

      const full = path.join(current, e.name);
      const rel = path.relative(BASE_DIR, full);
      const stat = await fsp.stat(full);
      results.push({
        path: rel,
        type: e.isDirectory() ? 'dir' : 'file',
        size: e.isDirectory() ? null : stat.size,
        mtime: stat.mtime.toISOString()
      });
      if (e.isDirectory() && d > 0) await walk(full, d - 1);
    }
  }
  await walk(absRoot, depth);
  return results;
}

async function handleList(req, res, q) {
  if (!requireAuth(req, res)) return;
  const rel = (q.path ?? '').toString();
  const depth = Number.isFinite(+q.depth) ? Math.max(0, Math.min(10, parseInt(q.depth, 10))) : 1;

  let abs;
  try { abs = secureJoin(rel); } catch { return bad(res, 'invalid_path'); }

  let st;
  try { st = await fsp.stat(abs); } catch { return notFound(res); }
  if (!st.isDirectory()) return bad(res, 'path_not_directory');

  const items = await listRecursive(abs, depth);
  ok(res, { ok: true, base: path.relative(BASE_DIR, abs), depth, items, time: nowISO() });
}

async function handleGet(req, res, q) {
  if (!requireAuth(req, res)) return;
  const rel = (q.path ?? '').toString();
  if (!rel) return bad(res, 'missing_path');

  let abs;
  try { abs = secureJoin(rel); } catch { return bad(res, 'invalid_path'); }

  let st;
  try { st = await fsp.stat(abs); } catch { return notFound(res); }
  if (!st.isFile()) return bad(res, 'not_a_file');

  const buf = await fsp.readFile(abs);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  ok(res, {
    ok: true,
    path: rel,
    size: buf.length,
    sha256,
    encoding: 'base64',
    content: buf.toString('base64'),
    time: nowISO()
  });
}

function route(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';

  // Enforce mount base
  if (!pathname.startsWith(BASE_URI)) return notFound(res);

  const sub = pathname.slice(BASE_URI.length) || '/';

  if (req.method === 'GET' && (sub === '/' || sub === '')) {
    return ok(res, { ok: true, banner: 'OK (ai2)', base: BASE_URI, time: nowISO() });
  }

  if (req.method === 'GET' && sub === '/health') {
    return ok(res, { ok: true, time: nowISO() });
  }

  if (req.method === 'GET' && sub === '/list') {
    return handleList(req, res, parsed.query);
  }

  if (req.method === 'GET' && sub === '/get') {
    return handleGet(req, res, parsed.query);
  }

  // Placeholders for future integration:
  if (req.method === 'POST' && sub === '/diff_dryrun') {
    return methodNotAllowed(res); // stub for now
  }
  if (req.method === 'POST' && sub === '/diff_submit') {
    return methodNotAllowed(res); // stub for now
  }

  return notFound(res);
}

http.createServer(route).listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[ai2] listening on ${PORT} at base ${BASE_URI}`);
});
