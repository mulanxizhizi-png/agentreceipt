'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process');
// Keep tests away from the real ~/.agentreceipt (runtime, shim, backups).
if (!process.env.AGENTRECEIPT_TEST_HOME) {
  process.env.AGENTRECEIPT_TEST_HOME = '1';
  process.env.AGENTRECEIPT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-home-'));
  // never pick up a real agentundo install from the machine running the tests
  process.env.AGENTUNDO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-undo-home-'));
}
function tmpRepo(files = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-'));
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  const g = (...a) => execFileSync('git', a, { cwd: d, stdio: 'ignore' });
  g('init', '-q'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init', '--allow-empty');
  return d;
}
module.exports = { tmpRepo };
