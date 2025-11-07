// services/tokenStore.js
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const TOKENS_PATH = process.env.TOKENS_PATH || "/home/genweb/agent/tokens.json";

let cache = { tokens: new Map(), pepper: "", mtimeMs: 0 };

// constant-time compare
function ctEq(a, b) {
  const A = Buffer.from(a); const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function parseAndBuild(raw) {
  const j = JSON.parse(raw);
  if (!j || typeof j !== "object" || !Array.isArray(j.tokens)) throw new Error("Invalid tokens.json");
  const m = new Map();
  for (const t of j.tokens) {
    if (!t.id || !t.hash || !Array.isArray(t.scopes)) continue;
    m.set(t.id, { ...t });
  }
  return { pepper: j.pepper || "", tokens: m };
}

function load(force = false) {
  const st = fs.statSync(TOKENS_PATH);
  if (!force && st.mtimeMs === cache.mtimeMs) return;
  const raw = fs.readFileSync(TOKENS_PATH, "utf8");
  const parsed = parseAndBuild(raw);
  cache = { ...parsed, mtimeMs: st.mtimeMs };
}

function watch() {
  // atomic replace-safe: reload on change; fallback to periodic check if needed
  fs.watch(path.dirname(TOKENS_PATH), { persistent: false }, (eventType, fname) => {
    if (!fname || !fname.endsWith(path.basename(TOKENS_PATH))) return;
    try { load(true); } catch { /* keep last good cache */ }
  });
  // belt & suspenders: periodic verify
  setInterval(() => { try { load(false); } catch {} }, 5000).unref();
}

function sha256Base64(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("base64");
}

// Token string format expected from clients: "ai2_<random>"
// We don't store it; we store sha256(pepper + token)
function hashToken(pepper, token) {
  return "sha256:" + sha256Base64(pepper + ":" + token);
}

function verifyOpaqueToken(token) {
  try { load(false); } catch {}
  const now = Date.now();
  for (const [, t] of cache.tokens.entries()) {
    if (t.revoked) continue;
    if (t.expiresAt && now > Date.parse(t.expiresAt)) continue;
    const want = t.hash;
    const got = hashToken(cache.pepper, token);
    if (ctEq(want, got)) return { ok: true, token: t };
  }
  return { ok: false };
}

function requireScope(scope) {
  return (req, res, next) => {
    const hdr = req.get("Authorization") || "";
    const m = /^Bearer\s+(.+)$/.exec(hdr);
    if (!m) return res.status(401).json({ error: "missing_bearer" });
    const token = m[1];
    const out = verifyOpaqueToken(token);
    if (!out.ok) return res.status(401).json({ error: "invalid_token" });
    if (!out.token.scopes.includes(scope)) return res.status(403).json({ error: "insufficient_scope", need: scope });
    // attach principal
    req.principal = { id: out.token.id, scopes: out.token.scopes };
    return next();
  };
}

load(true);
watch();

module.exports = { verifyOpaqueToken, requireScope, hashToken, TOKENS_PATH };
