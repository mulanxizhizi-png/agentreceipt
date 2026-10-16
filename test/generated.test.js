'use strict';
// v0.1.4: generated artifacts (__pycache__, tool caches, coverage) never count as changes.
// Deploy's case: Python project with no .gitignore; the first passing run must be green, not blocked.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { execFileSync } = require('child_process');
const { tmpRepo } = require('./helpers');
const { handleStop } = require('../src/hook');
const { saveConfig } = require('../src/config');
const { isGenerated, setIgnore } = require('../src/git');
const havePy = (() => { try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('deploy repro: python project, no .gitignore, first run green (pycache not a change)', { skip: !havePy }, async () => {
  const d = tmpRepo({ 'm.py': 'def f():\n    return "ok"\n', 'tests/__init__.py': '', 'tests/test_m.py': 'import unittest, m\nclass T(unittest.TestCase):\n    def test_f(self):\n        self.assertEqual(m.f(), "ok")\n' });
  assert.ok(!fs.existsSync(path.join(d, '.gitignore')));
  saveConfig(d, { testCommand: 'env -u PYTHONDONTWRITEBYTECODE -u PYTHONPYCACHEPREFIX python3 -m unittest discover -q -s tests -t . && mkdir -p .pytest_cache htmlcov && touch .coverage .pytest_cache/x htmlcov/index.html', timeoutSec: 30, maxBlocks: 2 });
  const r = await handleStop({ cwd: d, session_id: 'gen1' });
  assert.ok(fs.readdirSync(d, { recursive: true }).some((f) => String(f).endsWith('.pyc')), 'test run produced bytecode: ' + r.receipt.tests.outputTail);
  assert.strictEqual(r.receipt.status, 'green');
  assert.strictEqual(r.receipt.fingerprint.changedDuringTests, false);
  assert.deepStrictEqual(r.receipt.diff.testFilesChanged, []);
  assert.strictEqual(r.receipt.verificationCriteria.changed, false);
  assert.ok(!r.receipt.diff.files.some((f) => isGenerated(f.path)), JSON.stringify(r.receipt.diff.files));
  assert.notStrictEqual(r.output.decision, 'block');
  const r2 = await handleStop({ cwd: d, session_id: 'gen1' });
  assert.strictEqual(r2.receipt.status, 'green');
});

test('default generated patterns', () => {
  setIgnore([]);
  for (const p of ['__pycache__/m.cpython-312.pyc', 'tests/__pycache__/x.pyc', 'a.pyc', 'b.pyo', '.pytest_cache/v/x', '.mypy_cache/a', '.ruff_cache/a', '.tox/py/x', '.nox/s/x', 'pkg.egg-info/PKG-INFO', 'node_modules/.cache/x', '.coverage', '.coverage.host.1', 'coverage/lcov.info', 'htmlcov/index.html', '.nyc_output/a.json', 'sub/coverage/x'])
    assert.ok(isGenerated(p), p);
  for (const p of ['m.py', 'tests/test_m.py', 'coverage.py', 'src/coverage.js', 'node_modules/x/index.js', 'Makefile'])
    assert.ok(!isGenerated(p), p);
});

test('config.ignore adds globs; still counts other changes; invalid ignore -> error receipt', async () => {
  const d = tmpRepo({ 'ok.js': 'process.exit(0)' });
  saveConfig(d, { testCommand: 'node ok.js', ignore: ['build/', '*.log'] });
  fs.mkdirSync(path.join(d, 'build')); fs.writeFileSync(path.join(d, 'build/out.js'), 'x');
  fs.writeFileSync(path.join(d, 'run.log'), 'x'); fs.writeFileSync(path.join(d, 'real.js'), 'x');
  const r = await handleStop({ cwd: d, session_id: 'ig' });
  assert.deepStrictEqual(r.receipt.diff.files.map((f) => f.path).filter((p) => !p.startsWith('.agentreceipt')).sort(), ['real.js']);
  saveConfig(d, { testCommand: 'node ok.js', ignore: 'build' });
  assert.strictEqual((await handleStop({ cwd: d, session_id: 'ig2' })).receipt.status, 'error');
  setIgnore([]);
});
