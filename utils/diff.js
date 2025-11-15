// utils/diff.js
'use strict';
const { ALLOWED_PATH_PREFIXES } = require('../config/constants');

function normalizeDiff(diff) {
  if (!diff) return '';
  let s = String(diff);

  // 1) Normalize line endings to LF
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 2) Ensure "+++ b/..." / "--- b/..." have a space before b/
  s = s.replace(/^(\+\+\+|---)b\//mg, '$1 b/');

  // 3) Ensure the patch ends with a newline so the last hunk isn't truncated
  if (!s.endsWith('\n')) s += '\n';

  // IMPORTANT:
  // - Do NOT trim() or trimEnd() — that would drop blank context lines
  //   and corrupt @@ -a,b +c,d @@ counts.
  // - Do NOT touch "@@ ..." hunk headers here.

  return s;
}
function looksBinaryDiff(diff) {
  return /^(?:GIT binary patch|literal \d+)/m.test(String(diff||''));
}
function stepPathsUnderRepo(diff, prefixes = ALLOWED_PATH_PREFIXES) {
  const re = /^diff --git a\/([^\n]+) b\/([^\n]+)$/mg;
  let m; let n = 0;
  const isDevNull = (p) => p === '/dev/null' || p === 'dev/null';
  const pathAllowed = (rel) =>
    prefixes.length === 0 || prefixes.some(p => rel.startsWith(p));
  while ((m = re.exec(diff)) !== null) {
    n++;
    const a = m[1], b = m[2];
    if (!a || !b) return { ok:false, error:'missing_paths' };
    if (a.startsWith('/') || b.startsWith('/')) return { ok:false, error:'abs_path' };
    if (a.includes('..') || b.includes('..')) return { ok:false, error:'path_traversal' };
    if (a.includes('\\') || b.includes('\\')) return { ok:false, error:'backslash_path' };
    if (!isDevNull(a) && !pathAllowed(a)) return { ok:false, error:'path_disallowed' };
    if (!isDevNull(b) && !pathAllowed(b)) return { ok:false, error:'path_disallowed' };
  }
  if (n === 0) return { ok:false, error:'no_diff_pairs' };
  return { ok:true };
}
function inferStepOpFromDiff(diff) {
  if (/^new file mode /m.test(diff) || /--- \/dev\/null/m.test(diff)) return 'create';
  if (/^deleted file mode /m.test(diff) || /\+\+\+ \/dev\/null/m.test(diff)) return 'delete';
  return 'modify';
}
function buildCombinedDiffFromSteps(steps) {
  const parts = [];
  for (const s of steps) {
    if (s && s.type === 'patch' && typeof s.diff === 'string' && s.diff.trim().startsWith('diff --git')) {
      parts.push(s.diff.trim());
    }
  }
  return parts.length ? parts.join('\n\n') + '\n' : '';
}
module.exports = { normalizeDiff, looksBinaryDiff, stepPathsUnderRepo, inferStepOpFromDiff, buildCombinedDiffFromSteps };
