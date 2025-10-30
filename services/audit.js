// services/audit.js
'use strict';
const fs = require('fs');
const path = require('path');
const { AUDIT_LOG } = require('../config/constants');

try { fs.mkdirSync(path.dirname(AUDIT_LOG), { recursive:true, mode:0o700 }); } catch {}

function auditWrite(evt) {
  try {
    const rec = { ts: new Date().toISOString(), ...evt };
    fs.appendFileSync(AUDIT_LOG, JSON.stringify(rec) + '\n', { mode:0o600 });
  } catch {}
}

module.exports = { auditWrite };

