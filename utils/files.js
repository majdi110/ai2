// utils/files.js
'use strict';
const path = require('path');
const { REPO_ROOT } = require('../config/constants');

// Join a user-provided path safely under REPO_ROOT (no traversal)
function safeJoin(root, userPath){
  const p = path.normalize('/' + String(userPath || '').replace(/^\/+/, ''));
  const full = path.join(root, '.' + p);
  if (!full.startsWith(root)) throw new Error('path_traversal');
  return full;
}

module.exports = { safeJoin };

