// services/git.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execp } = require('../utils/exec');
const { REPO_ROOT } = require('../config/constants');

// Write diff to a temp file and run `git apply --check`
async function gitDryRun(diffText, baseBranch='public') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai2-dryrun-'));
  const patch  = path.join(tmpDir, 'plan.patch');
  fs.writeFileSync(patch, diffText, { mode:0o600 });

  // Optionally ensure branch exists (best effort, ignore errors)
  try { await execp('git', ['-C', REPO_ROOT, 'rev-parse', '--verify', baseBranch]); } catch {}

  try {
    // --check means "validate but don't apply"
    await execp('git', ['-C', REPO_ROOT, 'apply', '--check', '--whitespace=nowarn', patch]);
    try { fs.rmSync(tmpDir, { recursive:true, force:true }); } catch {}
    return { ok: true };
  } catch (e) {
    const err = String(e.stderr || e.stdout || e.message || '').slice(0, 2000);
    try { fs.rmSync(tmpDir, { recursive:true, force:true }); } catch {}
    return { ok: false, error: 'git_apply_check_failed', detail: err };
  }
}

module.exports = { gitDryRun };
