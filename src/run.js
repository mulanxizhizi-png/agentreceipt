'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TAIL = 4000;
const HEAD = 4000;
const LOG_CAP = 50 * 1024 * 1024; // full log on disk, capped

// Runs a shell command with a timeout. Full combined output goes to `logFile` (if given);
// the receipt keeps the head (first failure is usually near the top) and the tail.
function runTests(command, cwd, timeoutSec, { logFile } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    let log = null;
    if (logFile) { try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); log = fs.openSync(logFile, 'w'); } catch { log = null; } }
    let head = '', tail = '', bytes = 0;
    const finish = (r) => {
      if (log !== null) { try { if (bytes > LOG_CAP) fs.writeSync(log, `\n[agentreceipt: log truncated at ${LOG_CAP} bytes of ${bytes}]\n`); fs.closeSync(log); } catch {} }
      resolve({ ...r, durationMs: Date.now() - start, outputHead: head, outputTail: tail, outputBytes: bytes, logPath: log !== null ? logFile : null });
    };
    let child;
    try { child = spawn(command, { cwd, shell: true, detached: process.platform !== 'win32', env: { ...process.env, CI: '1' } }); }
    catch (e) { tail = String(e); finish({ exitCode: null, timedOut: false, spawnError: String(e) }); return; }
    const add = (b) => {
      if (log !== null && bytes < LOG_CAP) { try { fs.writeSync(log, b.subarray(0, LOG_CAP - bytes)); } catch {} }
      bytes += b.length;
      const s = b.toString();
      if (head.length < HEAD) head += s.slice(0, HEAD - head.length);
      tail = (tail + s).slice(-TAIL);
    };
    child.stdout.on('data', add); child.stderr.on('data', add);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    }, timeoutSec * 1000);
    child.on('close', (code) => { clearTimeout(timer); finish({ exitCode: timedOut ? null : code, timedOut }); });
    child.on('error', (e) => { clearTimeout(timer); tail = String(e); finish({ exitCode: null, timedOut: false, spawnError: String(e) }); });
  });
}

module.exports = { runTests };
