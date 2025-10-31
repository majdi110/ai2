"use strict";
const fs = require("fs");
const { ALLOWED_PATH_PREFIXES, TOKENS_FILE, TOKEN_FILE } = require("../config/constants");

let TOKENS_CACHE = null, TOKENS_MTIME = 0;
function loadTokensFile() {
  try {
    const st = fs.statSync(TOKENS_FILE);
    if (!TOKENS_CACHE || st.mtimeMs !== TOKENS_MTIME) {
      TOKENS_CACHE = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8") || "{}");
      TOKENS_MTIME = st.mtimeMs;
    }
  } catch { TOKENS_CACHE = null; TOKENS_MTIME = 0; }
  return TOKENS_CACHE || {};
}

let ACTION_TOKEN = "";
function getActionToken() {
  if (ACTION_TOKEN) return ACTION_TOKEN;
  try {
    ACTION_TOKEN = String(fs.readFileSync(TOKEN_FILE, "utf8") || "").trim();
    if (!ACTION_TOKEN) throw new Error("empty");
  } catch { ACTION_TOKEN = (process.env.ACTION_TOKEN || "").trim(); }
  return ACTION_TOKEN;
}

// Normalize a tokens.json projects array which may contain strings or {id, role} objects.
function normalizeProjects(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return ["*"];
  return arr.map((p) => {
    if (p && typeof p === "object") {
      if (p.id != null) return String(p.id);
      return JSON.stringify(p);
    }
    return String(p);
  });
}

function authCtx(req) {
  const bearerRaw = String(req.headers["authorization"] || "");
  const viaBearer = bearerRaw.toLowerCase().startsWith("bearer ") ? bearerRaw.slice(7).trim() : "";
  const viaKey = String(req.headers["x-api-key"] || "").trim();
  const presented = viaBearer || viaKey || "";

  const admin = getActionToken();
  if (admin && presented === admin) return { ok: true, kind: "global", token: "ACTION_TOKEN" };

  const map = (loadTokensFile().tokens || {});
  const rec = map[presented];
  if (rec && rec.user) {
    const projects = normalizeProjects(rec.projects);

    // Keep richer debug info when available
    let projects_detail = null;
    if (Array.isArray(rec.projects)) {
      projects_detail = rec.projects.map((p) =>
        (p && typeof p === "object")
          ? { id: (p.id != null ? String(p.id) : null), role: (p.role != null ? String(p.role) : null) }
          : { id: String(p), role: null }
      );
    }

    return {
      ok: true,
      kind: "scoped",
      token: presented.slice(0,8) + "…",
      user: String(rec.user),
      projects,
      projects_detail
    };
  }
  return { ok:false };
}

function allowedPrefixesFromAuth(auth) {
  if (auth && auth.ok && auth.kind === "scoped") {
    if (auth.projects.includes("*")) {
      return [ `public/users/${auth.user}/projects/` ];
    }
    return auth.projects.map((p) =>
      `public/users/${auth.user}/projects/${String(p).replace(/[^A-Za-z0-9._-]/g,"")}/`
    );
  }
  return ALLOWED_PATH_PREFIXES;
}

module.exports = { authCtx, allowedPrefixesFromAuth, getActionToken };
