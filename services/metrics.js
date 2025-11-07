'use strict';

const counters = Object.create(null);
const gauges   = Object.create(null);

function inc(name, labels = {}) {
  const key = keyOf(name, labels);
  counters[key] = (counters[key] || 0) + 1;
}
function setGauge(name, value, labels = {}) {
  const key = keyOf(name, labels);
  gauges[key] = value;
}
function keyOf(name, labels) {
  const parts = [name];
  const keys = Object.keys(labels).sort();
  for (const k of keys) parts.push(`${k}="${String(labels[k]).replace(/"/g,'\\"')}"`);
  return parts.join(',');
}

function toProm() {
  const lines = [];
  // counters
  for (const key of Object.keys(counters)) {
    const [name, ...rest] = key.split(',');
    const lbls = rest.length ? '{' + rest.join(',') + '}' : '';
    lines.push(`${name}_total${lbls} ${counters[key]}`);
  }
  // gauges
  for (const key of Object.keys(gauges)) {
    const [name, ...rest] = key.split(',');
    const lbls = rest.length ? '{' + rest.join(',') + '}' : '';
    lines.push(`${name}${lbls} ${gauges[key]}`);
  }
  return lines.join('\n') + '\n';
}

module.exports = { inc, setGauge, toProm };
