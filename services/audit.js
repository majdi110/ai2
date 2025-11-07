// services/audit.js
'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const AUDIT_DIR = process.env.AI2_AUDIT_DIR || '/home/genweb/agent/logs';
const AUDIT_FILE = path.join(AUDIT_DIR, 'audit.jsonl');

/**
 * Ensures that the audit directory exists with secure permissions.
 */
function ensureDir(p) {
  try {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  } catch (e) {
    if (logger && typeof logger.write === 'function') {
      logger.write({ level: 'error', msg: 'Failed to ensure audit directory', error: e.message });
    }
  }
}

/**
 * Writes a structured audit record to the audit log file.
 * Each record is appended as a single JSON line (JSONL format).
 * Uses secure file permissions and piggybacks on logger rotation policy.
 */
function writeAudit(rec) {
  ensureDir(AUDIT_DIR);
  const entry = { ts: new Date().toISOString(), ...rec };
  try {
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch (e) {
    if (logger && typeof logger.write === 'function') {
      logger.write({ level: 'error', msg: 'Failed to write audit record', error: e.message });
    }
  }
}

module.exports = { writeAudit };
