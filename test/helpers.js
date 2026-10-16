'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process');
function tmpRepo(files = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-'));
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  const g = (...a) => execFileSync('git', a, { cwd: d, stdio: 'ignore' });
  g('init', '-q'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init', '--allow-empty');
  return d;
}
module.exports = { tmpRepo };
