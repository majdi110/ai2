// services/git.js
'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execp } = require('../utils/exec');
const { REPO_ROOT } = require('../config/constants');

/**
 * Best-effort: ensure a branch exists locally (ignore errors).
 */
async function ensureBranchExists(branch) {
  try {
    await execp('git', ['-C', REPO_ROOT, 'rev-parse', '--verify', branch]);
  } catch {
    // no-op
  }
}

/**
 * Sanitize a path that will be used with `git show <branch>:<relPath>`.
 * - Must be a POSIX-style relative path
 * - No absolute paths, no backslashes, no '..' escape
 * - No newlines / CRs
 */
function sanitizeGitRelPath(relPath) {
  const raw = String(relPath ?? '').replace(/[\r\n]/g, '').trim();
  if (!raw) throw new Error('empty_path');

  // Use posix semantics regardless of OS to match git's expectations
  const posix = path.posix;

  if (posix.isAbsolute(raw)) throw new Error('absolute_path_not_allowed');
  // Normalize and drop leading './'
  let norm = posix.normalize(raw).replace(/^\.\/+/, '');

  // Reject backslashes (windows-style) to avoid ambiguity
  if (norm.includes('\\')) throw new Error('backslash_not_allowed');

  // Reject repo escapes (`..` at start or after a separator)
  if (norm === '' || norm.startsWith('..') || norm.split('/').includes('..')) {
    throw new Error('path_traversal_detected');
  }

  return norm;
}

/**
 * Write a diff to a temp file and run `git apply --check` to validate it.
 * Returns { ok: true } on success or { ok:false, error, detail } on failure.
 */
async function gitDryRun(diffText, baseBranch = 'public') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai2-dryrun-'));
  const patch  = path.join(tmpDir, 'plan.patch');
  fs.writeFileSync(patch, String(diffText ?? ''), { mode: 0o600 });

  await ensureBranchExists(baseBranch);

  try {
    // --check validates without applying
    await execp('git', ['-C', REPO_ROOT, 'apply', '--check', '--whitespace=nowarn', patch]);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return { ok: true };
  } catch (e) {
    const err = String(e.stderr || e.stdout || e.message || '').slice(0, 2000);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return { ok: false, error: 'git_apply_check_failed', detail: err };
  }
}

/**
 * Branch-aware blob read: returns the file contents at `<branch>:<relPath>`.
 * Throws if git fails or if the path is invalid.
 */
async function gitShow(repoRoot, branch, relPath) {
  // Basic guard: repoRoot must match configured repo root
  const root = String(repoRoot || '');
  if (!root || path.resolve(root) !== path.resolve(REPO_ROOT)) {
    throw new Error('invalid_repo_root');
  }

  await ensureBranchExists(branch);
  const safeRel = sanitizeGitRelPath(relPath);

  const { stdout } = await execp('git', ['-C', REPO_ROOT, 'show', `${branch}:${safeRel}`]);
  return stdout;
}

module.exports = { gitDryRun, gitShow };
