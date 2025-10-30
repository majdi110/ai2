// utils/exec.js
'use strict';
const { execFile } = require('child_process');

function execp(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const ps = execFile(cmd, args, { ...opts, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(stderr || stdout || String(err));
        e.stdout = stdout; e.stderr = stderr;
        return reject(e);
      }
      resolve({ stdout, stderr });
    });
    if (opts && opts.input) ps.stdin.end(opts.input);
  });
}

module.exports = { execp };

