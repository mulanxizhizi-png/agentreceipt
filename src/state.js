'use strict';
const fs = require('fs');
const path = require('path');
const { DIR } = require('./config');

function file(root, sessionId) {
  const safe = String(sessionId || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(root, DIR, 'state', `${safe}.json`);
}
function getBlocks(root, sessionId) {
  try { return JSON.parse(fs.readFileSync(file(root, sessionId), 'utf8')).blocks || 0; } catch { return 0; }
}
function setBlocks(root, sessionId, blocks) {
  const f = file(root, sessionId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ blocks, updatedAt: new Date().toISOString() }) + '\n');
}
module.exports = { getBlocks, setBlocks };
