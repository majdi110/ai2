'use strict';
const http = require('http');
const { route } = require('./router');
const { PORT, OPENAI_MODEL } = require('./config/constants');

const server = http.createServer(route);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[ai2] listening on :${PORT}`);
  console.log(`[ai2] planner model: ${OPENAI_MODEL}`);
});
server.on('error', (err) => {
  console.error('[ai2] server error:', err && err.stack || err);
});
module.exports = server;
