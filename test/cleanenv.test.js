'use strict';
// v0.1.3: cleanEnv + interpreter context. Report scenario 12: stale timestamp pyc next to broken source.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { execFileSync } = require('child_process');
const { tmpRepo } = require('./helpers');
const { handleStop } = require('../src/hook');
const { saveConfig } = require('../src/config');
const havePy = (() => { try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function staleCacheRepo(cleanEnv) {
  const d = tmpRepo({ 'm.py': 'def f():\n    return "ok"\n', 'test_m.py': 'import unittest, m\nclass T(unittest.TestCase):\n    def test_f(self):\n        self.assertEqual(m.f(), "ok")\nif __name__ == "__main__":\n    unittest.main()\n' });
  saveConfig(d, { testCommand: 'python3 -m unittest -q test_m', timeoutSec: 30, maxBlocks: 1, ...(cleanEnv === undefined ? {} : { cleanEnv }) });
  const env = { ...process.env }; delete env.PYTHONPYCACHEPREFIX; delete env.PYTHONDONTWRITEBYTECODE;
  execFileSync('python3', ['-m', 'unittest', '-q', 'test_m'], { cwd: d, env, stdio: 'ignore' }); // writes __pycache__/m.*.pyc
  const src = path.join(d, 'm.py'); const st = fs.statSync(src);
  fs.writeFileSync(src, 'def f():\n    return "no"\n'); // same length: pyc header (mtime+size) still matches
  fs.utimesSync(src, st.atime, st.mtime);
  return d;
}

test('report scenario 12 baseline: stale pyc makes broken source pass without cleanEnv; receipt records interpreter', { skip: !havePy }, async () => {
  const d = staleCacheRepo(undefined);
  const r = await handleStop({ cwd: d, session_id: 'py0' });
  assert.strictEqual(r.receipt.status, 'green', 'documents the gap cleanEnv closes');
  assert.strictEqual(r.receipt.environment.cleanEnv, false);
  assert.ok(r.receipt.environment.python.executable); assert.match(r.receipt.environment.python.version, /^3\./);
  assert.match(r.text, /Python: +\S+ 3\./);
});

test('report scenario 12 with cleanEnv: fresh cache dir -> source compiled -> not green', { skip: !havePy }, async () => {
  const d = staleCacheRepo(true);
  const r = await handleStop({ cwd: d, session_id: 'py1' });
  assert.strictEqual(r.receipt.status, 'blocked');
  assert.strictEqual(r.output.decision, 'block');
  assert.strictEqual(r.receipt.environment.cleanEnv, true);
  assert.strictEqual(r.receipt.environment.python.pycachePrefix, 'fresh empty temp dir');
  assert.match(r.text, /clean bytecode cache/);
  const r2 = await handleStop({ cwd: d, session_id: 'py1' });
  assert.strictEqual(r2.receipt.status, 'red');
  // the verification run did not refresh the project's stale pyc (bytecode writes disabled)
  assert.ok(fs.readdirSync(path.join(d, '__pycache__')).some((f) => f.startsWith('m.')));
});

test('cleanEnv must be boolean; non-Python projects get no python context', async () => {
  const d = tmpRepo({ 'ok.js': 'process.exit(0)' });
  saveConfig(d, { testCommand: 'node ok.js', cleanEnv: 'yes' });
  assert.strictEqual((await handleStop({ cwd: d, session_id: 'x' })).receipt.status, 'error');
  saveConfig(d, { testCommand: 'node ok.js' });
  const r = await handleStop({ cwd: d, session_id: 'y' });
  assert.strictEqual(r.receipt.status, 'green'); assert.ok(!r.receipt.environment.python); assert.doesNotMatch(r.text, /Python:/);
});
