'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TAIL = 4000;
const HEAD = 4000;
const LOG_CAP = 50 * 1024 * 1024; // full log on disk, capped

// Runs a shell command with a timeout. The child's stdout+stderr go straight into a log FILE
// (not a pipe): many test runners call process.exit() right after printing, and output still
// queued for a non-blocking pipe is then lost (Node drops it). File writes are synchronous, so
// nothing is dropped. After the child closes we read head + tail from the file.
function runTests(command, cwd, timeoutSec, { logFile } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    let file = logFile, keep = !!logFile, fd = null;
    try {
      if (!file) file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentreceipt-')), 'test.log');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fd = fs.openSync(file, 'w');
    } catch { fd = null; keep = false; }
    let head = '', tail = '', bytes = 0, done = false;
    const finish = (r) => {
      if (done) return; done = true;
      if (fd !== null) {
        try {
          fs.closeSync(fd);
          bytes = fs.statSync(file).size;
          const rd = fs.openSync(file, 'r');
          const hb = Buffer.alloc(Math.min(HEAD, bytes)); fs.readSync(rd, hb, 0, hb.length, 0);
          const tl = Math.min(TAIL * 4, bytes); const tb = Buffer.alloc(tl); fs.readSync(rd, tb, 0, tl, bytes - tl);
          fs.closeSync(rd);
          head = hb.toString().slice(0, HEAD); tail = tb.toString().slice(-TAIL);
          if (bytes > LOG_CAP) { fs.truncateSync(file, LOG_CAP); fs.appendFileSync(file, `\n[agentreceipt: log truncated at ${LOG_CAP} bytes of ${bytes}]\n`); }
          if (!keep) fs.rmSync(path.dirname(file), { recursive: true, force: true });
        } catch {}
      }
      if (r.spawnError) tail = r.spawnError;
      resolve({ ...r, durationMs: Date.now() - start, outputHead: head, outputTail: tail, outputBytes: bytes, logPath: keep ? logFile : null });
    };
    let child;
    const out = fd !== null ? fd : 'pipe';
    try { child = spawn(command, { cwd, shell: true, stdio: ['ignore', out, out], detached: process.platform !== 'win32', env: { ...process.env, CI: '1' } }); }
    catch (e) { finish({ exitCode: null, timedOut: false, spawnError: String(e) }); return; }
    if (fd === null) { // fallback: no writable log location
      const add = (b) => { bytes += b.length; const s = b.toString(); if (head.length < HEAD) head += s.slice(0, HEAD - head.length); tail = (tail + s).slice(-TAIL); };
      child.stdout.on('data', add); child.stderr.on('data', add);
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    }, timeoutSec * 1000);
    child.on('close', (code) => { clearTimeout(timer); finish({ exitCode: timedOut ? null : code, timedOut }); });
    child.on('error', (e) => { clearTimeout(timer); finish({ exitCode: null, timedOut: false, spawnError: String(e) }); });
  });
}

module.exports = { runTests };
