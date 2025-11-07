#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKENS_PATH = process.env.TOKENS_PATH || '/home/genweb/agent/tokens.json';

/* -------------------- utils -------------------- */
function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readJson(p) {
  if (!fs.existsSync(p)) return { pepper: '', tokens: [] };
  const raw = fs.readFileSync(p, 'utf8');
  if (!raw.trim()) return { pepper: '', tokens: [] };
  try {
    const j = JSON.parse(raw);
    // normalize structure
    if (!j || typeof j !== 'object') return { pepper: '', tokens: [] };
    if (!Array.isArray(j.tokens)) j.tokens = [];
    if (typeof j.pepper !== 'string') j.pepper = '';
    return j;
  } catch {
    return { pepper: '', tokens: [] };
  }
}

function writeAtomic(p, obj) {
  ensureDirFor(p);
  const tmp = p + '.tmp';
  const data = JSON.stringify(obj, null, 2) + '\n';
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch {}
}

function b64(n) {
  return crypto.randomBytes(n).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, n * 2);
}
function sha256b64(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('base64');
}

function ensurePepper(doc) {
  if (!doc.pepper) doc.pepper = b64(24);
}
function hashToken(doc, token) {
  return 'sha256:' + sha256b64(doc.pepper + ':' + token);
}
function loadOrInit() {
  return readJson(TOKENS_PATH);
}

/* -------------------- CLI -------------------- */
const cmd = process.argv[2];

if (cmd === 'create') {
  const id = process.argv[3];
  if (!id) {
    console.error('usage: tokenctl create <id> [scopes=plan,queue,read,write] [days=365]');
    process.exit(2);
  }
  const scopes = (process.argv[4] || 'plan,queue,read,write').split(',').map(s => s.trim()).filter(Boolean);
  const days = parseInt(process.argv[5] || '365', 10);

  const doc = loadOrInit(); ensurePepper(doc);
  const token = 'ai2_' + b64(24);
  const entry = {
    id,
    hash: hashToken(doc, token),
    scopes,
    expiresAt: new Date(Date.now() + days * 86400e3).toISOString(),
    revoked: false,
    notes: ''
  };

  doc.tokens = (doc.tokens || []).filter(t => t.id !== id).concat(entry);
  writeAtomic(TOKENS_PATH, doc);

  console.log('PLAINTEXT_TOKEN=', token); // print once; not stored
  console.log('id=', id);
  console.log('expiresAt=', entry.expiresAt);
  console.log('scopes=', scopes.join(','));
  process.exit(0);
}

if (cmd === 'revoke') {
  const id = process.argv[3];
  if (!id) { console.error('usage: tokenctl revoke <id>'); process.exit(2); }
  const doc = loadOrInit(); if (!doc.tokens) doc.tokens = [];
  let found = false;
  doc.tokens = doc.tokens.map(t => (t.id === id ? (found = true, { ...t, revoked: true }) : t));
  if (!found) { console.error('not found:', id); process.exit(2); }
  writeAtomic(TOKENS_PATH, doc);
  console.log('revoked', id);
  process.exit(0);
}

if (cmd === 'rotate') {
  const id = process.argv[3];
  const days = parseInt(process.argv[4] || '365', 10);
  if (!id) { console.error('usage: tokenctl rotate <id> [days=365]'); process.exit(2); }

  const doc = loadOrInit(); ensurePepper(doc);
  const token = 'ai2_' + b64(24);
  let found = false;

  doc.tokens = (doc.tokens || []).map(t => {
    if (t.id !== id) return t;
    found = true;
    return {
      ...t,
      hash: hashToken(doc, token),
      expiresAt: new Date(Date.now() + days * 86400e3).toISOString(),
      revoked: false
    };
  });

  if (!found) { console.error('not found:', id); process.exit(2); }
  writeAtomic(TOKENS_PATH, doc);

  console.log('PLAINTEXT_TOKEN=', token);
  console.log('rotated', id);
  process.exit(0);
}

if (cmd === 'list') {
  const doc = loadOrInit();
  console.log(JSON.stringify(doc, null, 2));
  process.exit(0);
}

/* fallback usage */
console.error(`usage:
  tokenctl create <id> [scopes=plan,queue,read,write] [days=365]
  tokenctl rotate <id> [days=365]
  tokenctl revoke <id>
  tokenctl list`);
process.exit(2);
