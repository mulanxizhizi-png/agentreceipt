'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DIR } = require('./config');

// Session ids are hashed so distinct ids ("a/b" vs "a?b") never share a file.
function key(sessionId) { return crypto.createHash('sha256').update(String(sessionId ?? 'default')).digest('hex').slice(0, 32); }
function file(root, sessionId) { return path.join(root, DIR, 'state', `${key(sessionId)}.json`); }

function getBlocks(root, sessionId) {
  try { return JSON.parse(fs.readFileSync(file(root, sessionId), 'utf8')).blocks || 0; } catch { return 0; }
}
function setBlocks(root, sessionId, blocks) {
  const f = file(root, sessionId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ blocks, updatedAt: new Date().toISOString() }) + '\n');
  fs.renameSync(tmp, f);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Per-session lock around the whole read -> run tests -> decide -> update sequence, so concurrent Stop
// events for one session are serialized. mkdir is atomic; a lock older than staleMs is taken over.
async function withSessionLock(root, sessionId, staleMs, fn) {
  const dir = file(root, sessionId) + '.lock';
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const start = Date.now();
  for (;;) {
    try { fs.mkdirSync(dir); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(dir).mtimeMs > staleMs) { fs.rmSync(dir, { recursive: true, force: true }); continue; } } catch { continue; }
      if (Date.now() - start > staleMs) throw new Error(`timed out waiting for session lock ${dir}`);
      await sleep(50);
    }
  }
  try { return await fn(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = { getBlocks, setBlocks, withSessionLock, key };
