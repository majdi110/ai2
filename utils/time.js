// utils/time.js
'use strict';
function nowISO(){ return new Date().toISOString(); }
function ts() {
  const d = new Date(), p = n => String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
module.exports = { nowISO, ts };
