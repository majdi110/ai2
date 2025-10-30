// utils/strings.js
'use strict';
const crypto = require('crypto');

function r4() { return Math.random().toString(36).slice(2, 6); }
function isObj(x){ return x && typeof x === 'object' && !Array.isArray(x); }
function sha256hex(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }
function idemSan(s) { return String(s || '').replace(/[^A-Za-z0-9._:-]/g, '_'); }

module.exports = { r4, isObj, sha256hex, idemSan };
