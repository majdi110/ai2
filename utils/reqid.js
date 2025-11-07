'use strict';
const crypto = require('crypto');

function rid() {
  return crypto.randomBytes(8).toString('hex');
}

function withReqId(req, res) {
  req.rid = req.rid || rid();
  res.setHeader('X-Request-Id', req.rid);
}

module.exports = { withReqId };
