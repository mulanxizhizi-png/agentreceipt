'use strict';
const { spawn } = require('child_process');

const TAIL = 4000;

// Runs a shell command with a timeout. Resolves { exitCode, timedOut, durationMs, outputTail }.
function runTests(command, cwd, timeoutSec) {
  return new Promise((resolve) => {
    const start = Date.now();
    let child;
    try { child = spawn(command, { cwd, shell: true, detached: process.platform !== 'win32', env: { ...process.env, CI: '1' } }); }
    catch (e) { resolve({ exitCode: null, timedOut: false, spawnError: String(e), durationMs: 0, outputTail: String(e) }); return; }
    let out = '';
    const add = (b) => { out += b.toString(); if (out.length > TAIL * 4) out = out.slice(-TAIL * 2); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    }, timeoutSec * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? null : code, timedOut, durationMs: Date.now() - start, outputTail: out.slice(-TAIL) });
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ exitCode: null, timedOut: false, spawnError: String(e), durationMs: Date.now() - start, outputTail: String(e) }); });
  });
}

module.exports = { runTests };
