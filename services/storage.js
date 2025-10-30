// services/storage.js
'use strict';
const fs = require('fs');
const path = require('path');
const { ARTIFACTS_DIR } = require('../config/constants');

try { fs.mkdirSync(ARTIFACTS_DIR, { recursive:true, mode:0o755 }); } catch {}

function writePlanArtifacts(planObj, opts = {}) {
  try {
    const id  = String(planObj.id || planObj.plan?.id || 'unknown');
    const dir = path.join(ARTIFACTS_DIR, id);
    fs.mkdirSync(dir, { recursive:true, mode:0o755 });

    const envelope = planObj.plan ? planObj : { plan: planObj };
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(envelope, null, 2), { mode:0o600 });

    const p = planObj.plan || planObj;
    if (p && p.combined_diff) {
      fs.writeFileSync(path.join(dir, 'combined.patch'), String(p.combined_diff), { mode:0o600 });
    }
    if (opts.status) {
      fs.writeFileSync(path.join(dir, 'status.txt'), `status=${opts.status}\n`, { mode:0o600 });
    }
  } catch {}
}
module.exports = { writePlanArtifacts };

