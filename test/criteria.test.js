'use strict';
// v0.1.3: test entry points (Makefile, justfile, scripts/test*, ...) and project-declared criteriaFiles
// count as "verification criteria". Notice only; never changes status or blocks.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { execFileSync } = require('child_process');
const { tmpRepo } = require('./helpers');
const { handleStop } = require('../src/hook');
const { saveConfig } = require('../src/config');
const { isCriteriaFile, globRe } = require('../src/receipt');
const haveMake = (() => { try { execFileSync('make', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('test entry files are criteria files', () => {
  for (const p of ['Makefile', 'makefile', 'GNUmakefile', 'build/rules.mk', 'justfile', 'Justfile', 'noxfile.py', 'tox.ini', 'pytest.ini', 'pyproject.toml', 'setup.cfg', 'package.json', 'scripts/test', 'scripts/test.sh', 'scripts/test-unit.py', 'sub/conftest.py'])
    assert.ok(isCriteriaFile(p), p);
  for (const p of ['src/make.py', 'scripts/build.sh', 'README.md', 'docindex/index.py']) assert.ok(!isCriteriaFile(p), p);
  assert.ok(globRe('ci/**/*.sh').test('ci/a/b/check.sh')); assert.ok(globRe('ci/**/*.sh').test('ci/check.sh'));
  assert.ok(!globRe('ci/*.sh').test('ci/a/check.sh'));
});

test('report scenario 13: Makefile test target replaced with an echo -> green but notice shown', { skip: !haveMake && 'make not installed' }, async () => {
  const d = tmpRepo({ 'ok.js': 'process.exit(1)', 'Makefile': 'test:\n\tnode ok.js\n' });
  saveConfig(d, { testCommand: 'make test', timeoutSec: 20, maxBlocks: 1 });
  fs.writeFileSync(path.join(d, 'Makefile'), 'test:\n\t@echo TESTS_SKIPPED\n');
  const r = await handleStop({ cwd: d, session_id: 'mk' });
  assert.strictEqual(r.receipt.status, 'green', 'notice never blocks');
  assert.strictEqual(r.receipt.verificationCriteria.changed, true);
  assert.deepStrictEqual(r.receipt.verificationCriteria.reasons.find((x) => x.kind === 'check-config-files').files, ['Makefile']);
  assert.match(r.text, /验证标准已变化，需复核/);
});

test('Makefile change shows the notice even when make is unavailable to the test (no make on this machine)', async () => {
  const d = tmpRepo({ 'ok.js': 'process.exit(0)', 'Makefile': 'test:\n\tnode ok.js\n' });
  saveConfig(d, { testCommand: 'node ok.js', timeoutSec: 20, maxBlocks: 1 });
  fs.writeFileSync(path.join(d, 'Makefile'), 'test:\n\t@echo TESTS_SKIPPED\n');
  const r = await handleStop({ cwd: d, session_id: 'mk2' });
  assert.strictEqual(r.receipt.status, 'green');
  assert.strictEqual(r.receipt.verificationCriteria.changed, true);
  assert.match(r.text, /Verification criteria changed/);
});

test('criteriaFiles globs from config add project-specific entry points', async () => {
  const d = tmpRepo({ 'ok.js': 'process.exit(0)', 'ci/checks/run.sh': 'echo' });
  saveConfig(d, { testCommand: 'node ok.js', timeoutSec: 20, maxBlocks: 1, criteriaFiles: ['ci/**/*.sh'] });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'cfg', '--allow-empty'], { cwd: d });
  fs.writeFileSync(path.join(d, 'ci/checks/run.sh'), 'exit 0');
  const r = await handleStop({ cwd: d, session_id: 'g' });
  assert.ok(r.receipt.verificationCriteria.reasons.some((x) => x.kind === 'check-config-files' && x.files.includes('ci/checks/run.sh')));
  // invalid criteriaFiles -> config error (stop allowed, error receipt)
  saveConfig(d, { testCommand: 'node ok.js', criteriaFiles: 'ci/*.sh' });
  const e = await handleStop({ cwd: d, session_id: 'g2' });
  assert.strictEqual(e.receipt.status, 'error'); assert.match(e.receipt.error, /criteriaFiles/);
});
