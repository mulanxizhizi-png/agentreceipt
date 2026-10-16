'use strict';
const fs = require('fs');
const path = require('path');

const NPM_PLACEHOLDER = /no test specified/;

// Returns { command, source } or null.
function detectTestCommand(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const t = pkg.scripts && pkg.scripts.test;
      if (t && !NPM_PLACEHOLDER.test(t)) {
        // packageManager field wins; otherwise the lockfile; npm if none (or several conflicting ones).
        let pm = null, why = '';
        const declared = typeof pkg.packageManager === 'string' && /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager);
        if (declared) { pm = declared[1]; why = `packageManager ${pkg.packageManager}`; }
        else {
          const locks = [['pnpm', 'pnpm-lock.yaml'], ['yarn', 'yarn.lock'], ['bun', 'bun.lock'], ['bun', 'bun.lockb'], ['npm', 'package-lock.json']].filter(([, f]) => has(f));
          const kinds = [...new Set(locks.map(([k]) => k))];
          if (kinds.length === 1) { pm = kinds[0]; why = locks.filter(([k]) => k === pm).map(([, f]) => f).join(', '); }
          else if (kinds.length > 1) { pm = 'npm'; why = `several lockfiles (${locks.map(([, f]) => f).join(', ')}); defaulting to npm, set --test to override`; }
        }
        pm = pm || 'npm';
        return { command: pm === 'npm' ? 'npm test' : `${pm} test`, source: `package.json scripts.test${why ? ` (${why})` : ''}` };
      }
    } catch { /* ignore bad package.json */ }
  }
  if (has('pytest.ini') || has('conftest.py') || has('tox.ini') ||
      (has('pyproject.toml') && /pytest/.test(fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8'))) ||
      (has('setup.cfg') && /pytest/.test(fs.readFileSync(path.join(dir, 'setup.cfg'), 'utf8')))) {
    return { command: 'pytest -q', source: 'pytest config' };
  }
  if (has('Cargo.toml')) return { command: 'cargo test', source: 'Cargo.toml' };
  if (has('go.mod')) return { command: 'go test ./...', source: 'go.mod' };
  if (has('Makefile') && /^test:/m.test(fs.readFileSync(path.join(dir, 'Makefile'), 'utf8'))) {
    return { command: 'make test', source: 'Makefile test target' };
  }
  if (has('tests') || has('test')) {
    const d = has('tests') ? 'tests' : 'test';
    const files = fs.readdirSync(path.join(dir, d));
    if (files.some((f) => /^test_.*\.py$|_test\.py$/.test(f))) return { command: 'pytest -q', source: `${d}/ python files` };
  }
  return null;
}

module.exports = { detectTestCommand };
