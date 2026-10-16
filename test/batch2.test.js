// v0.1.1 batch 2 regressions.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { tmpRepo } = require('./helpers');
const inst = require('../src/install');
const { diffSummary, parseNumstatZ } = require('../src/git');
const { detectTestCommand } = require('../src/detect');
const { handleStop } = require('../src/hook');
const { saveConfig } = require('../src/config');
const BIN = path.join(__dirname, '..', 'bin', 'agentreceipt.js');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, stdio: 'pipe' }).toString();
const cli = (args, cwd, env) => spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });

test('unicode, tab and renamed paths are reported verbatim (git -z)', () => {
  const d = tmpRepo({ '中文.js': 'a\n', 'old name.js': 'x\n'.repeat(20) });
  fs.writeFileSync(path.join(d, '中文.js'), 'b\n');
  g(d, 'mv', 'old name.js', 'new name.js');
  fs.writeFileSync(path.join(d, 'tab\there.txt'), 'u');
  fs.writeFileSync(path.join(d, '日本.txt'), 'u');
  const files = diffSummary(d).files;
  assert.deepEqual(files.find((f) => f.path === '中文.js'), { path: '中文.js', status: 'modified' });
  assert.deepEqual(files.find((f) => f.status === 'renamed'), { path: 'new name.js', status: 'renamed', from: 'old name.js' });
  assert.ok(files.some((f) => f.path === 'tab\there.txt' && f.status === 'untracked'));
  assert.ok(files.some((f) => f.path === '日本.txt'));
  assert.deepEqual(parseNumstatZ('1\t2\tline\nbreak.js\0'), { files: [{ path: 'line\nbreak.js', status: 'modified' }], insertions: 1, deletions: 2 });
});

test('package manager detection: bun.lock, packageManager field, conflicting lockfiles', () => {
  const pkg = (extra = {}) => JSON.stringify({ scripts: { test: 'x' }, ...extra });
  assert.equal(detectTestCommand(tmpRepo({ 'package.json': pkg(), 'bun.lock': '' })).command, 'bun test');
  assert.equal(detectTestCommand(tmpRepo({ 'package.json': pkg(), 'bun.lockb': '' })).command, 'bun test');
  assert.equal(detectTestCommand(tmpRepo({ 'package.json': pkg({ packageManager: 'pnpm@9.1.0' }), 'yarn.lock': '' })).command, 'pnpm test');
  const both = detectTestCommand(tmpRepo({ 'package.json': pkg(), 'yarn.lock': '', 'pnpm-lock.yaml': '' }));
  assert.equal(both.command, 'npm test'); assert.match(both.source, /several lockfiles/);
  assert.equal(detectTestCommand(tmpRepo({ 'package.json': pkg(), 'package-lock.json': '' })).command, 'npm test');
});

test('linked worktree: ignore rules go to the common git dir and take effect', () => {
  const main = tmpRepo({ 'a.txt': '1' });
  const wt = path.join(tmp('wt-'), 'linked');
  g(main, 'worktree', 'add', '-q', wt);
  inst.install({ agent: 'claude', root: wt, binPath: '/b/agentreceipt-hook' });
  inst.addExcludes(wt, inst.REPO_EXCLUDES);
  assert.equal(inst.excludePath(wt), path.join(fs.realpathSync(main), '.git', 'info', 'exclude'));
  execFileSync('git', ['check-ignore', '-q', '.claude/settings.local.json'], { cwd: wt });
  assert.equal(g(wt, 'status', '--porcelain'), '');
  assert.equal(inst.removeExcludes(wt), true);
});

test('uninstall in project A keeps the runtime used by project B; last project removes it; --global forces', () => {
  const home = tmp('h-'); const env = { ...process.env, AGENTRECEIPT_HOME: path.join(home, 'ar'), CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude') };
  const A = tmpRepo({ 'package.json': '{"scripts":{"test":"node -e 0"}}' });
  const B = tmpRepo({ 'package.json': '{"scripts":{"test":"node -e 0"}}' });
  assert.equal(cli(['init'], A, env).status, 0); assert.equal(cli(['init'], B, env).status, 0);
  const shim = path.join(home, 'ar', 'bin', 'agentreceipt-hook');
  let r = cli(['uninstall'], A, env);
  assert.equal(r.status, 0); assert.match(r.stdout, /1 other project still uses/);
  assert.ok(fs.existsSync(shim), 'B still has its launcher');
  assert.ok(fs.existsSync(path.join(home, 'codex', 'hooks.json')));
  assert.equal(fs.existsSync(path.join(A, '.claude', 'settings.local.json')), false);
  const out = spawnSync('/bin/sh', [shim, 'claude'], { input: JSON.stringify({ cwd: B, session_id: 's' }), encoding: 'utf8' });
  assert.match(JSON.parse(out.stdout).systemMessage, /PASS/, 'B still verified after A uninstalled');
  r = cli(['uninstall'], B, env);
  assert.match(r.stdout, /Removed runtime/);
  assert.equal(fs.existsSync(shim), false); assert.equal(fs.existsSync(path.join(home, 'codex', 'hooks.json')), false);
  // --global removes everything even with others registered
  assert.equal(cli(['init'], A, env).status, 0); assert.equal(cli(['init'], B, env).status, 0);
  r = cli(['uninstall', '--global'], A, env);
  assert.match(r.stdout, /Removed runtime/); assert.equal(fs.existsSync(shim), false);
});

test('receipt keeps commits since the last stop visible, records SHA and fingerprints', async () => {
  const home = tmp('h-'); const env = { ...process.env, AGENTRECEIPT_HOME: path.join(home, 'ar'), CODEX_HOME: path.join(home, 'codex') };
  const d = tmpRepo({ 'package.json': '{"scripts":{"test":"node t.js"}}', 't.js': 'process.exit(0)', 'src.js': 'ok\n' });
  assert.equal(cli(['init', '--agent', 'codex'], d, env).status, 0);
  fs.writeFileSync(path.join(d, 'src.js'), 'broken\n'); fs.writeFileSync(path.join(d, 't.js'), 'process.exit(1)');
  g(d, 'commit', '-qam', 'agent commits bad code');
  const r = await handleStop({ cwd: d, session_id: 's' });
  assert.equal(r.receipt.status, 'blocked');
  assert.equal(r.receipt.diff.filesChanged, 2, 'committed changes are not hidden');
  assert.equal(r.receipt.git.commitsSinceBase, 1);
  assert.equal(r.receipt.git.head, g(d, 'rev-parse', 'HEAD').trim());
  assert.match(r.receipt.fingerprint.before, /^sha256:/); assert.equal(r.receipt.fingerprint.changedDuringTests, false);
  assert.match(r.text, /\+1 commit since last stop/);
});

test('code changed during the test run is never green', async () => {
  const d = tmpRepo({ 'src.js': 'ok\n' });
  saveConfig(d, { testCommand: `node -e "require('fs').appendFileSync('src.js','tampered\\n')"`, maxBlocks: 1 });
  let r = await handleStop({ cwd: d, session_id: 'drift' });
  assert.equal(r.receipt.tests.passed, true); assert.equal(r.receipt.fingerprint.changedDuringTests, true);
  assert.equal(r.receipt.status, 'blocked'); assert.match(r.output.reason, /code changed while the tests were running/);
  r = await handleStop({ cwd: d, session_id: 'drift' });
  assert.equal(r.receipt.status, 'red');
});

test('long output: full log kept on disk, head + tail in receipt and feedback', async () => {
  const d = tmpRepo({});
  saveConfig(d, { testCommand: `node -e "console.log('ASSERTION FAILED: total expected 90 got 900'); for (let i=0;i<5000;i++) console.log('noise line '+i); process.exit(1)"` });
  const r = await handleStop({ cwd: d, session_id: 'long' });
  const log = fs.readFileSync(r.receipt.tests.logPath, 'utf8');
  assert.match(log, /ASSERTION FAILED/); assert.match(log, /noise line 4999/);
  assert.match(r.receipt.tests.outputHead, /ASSERTION FAILED/);
  assert.match(r.output.reason, /ASSERTION FAILED/); assert.match(r.output.reason, /Full log: /);
  assert.ok(r.receipt.tests.outputBytes > 50000);
});

test('config change since the last verified stop is warned about', async () => {
  const home = tmp('h-'); const env = { ...process.env, AGENTRECEIPT_HOME: path.join(home, 'ar'), CODEX_HOME: path.join(home, 'codex') };
  const d = tmpRepo({ 'package.json': '{"scripts":{"test":"node t.js"}}', 't.js': 'process.exit(1)' });
  assert.equal(cli(['init', '--agent', 'codex'], d, env).status, 0);
  const cfgFile = path.join(d, '.agentreceipt', 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), testCommand: 'node -e 0' }));
  const r = await handleStop({ cwd: d, session_id: 'cfg' });
  assert.equal(r.receipt.config.changedSinceLastVerified, true);
  assert.match(r.receipt.warnings[0], /test command was `npm test`, now `node -e 0`/);
  assert.match(r.output.systemMessage, /Warning: .*config\.json changed/);
});

test('output printed right before process.exit() is never lost (regression #22)', async () => {
  const { runTests } = require('../src/run');
  const dir = tmp('long-');
  for (let k = 0; k < 5; k++) {
    const p = runTests(`node -e "for (let i=0;i<20000;i++) console.log('noise line '+i); process.exit(1)"`, dir, 60, { logFile: path.join(dir, `l${k}.log`) });
    const until = Date.now() + 400; while (Date.now() < until) {} // a busy parent = slow reader, which used to drop the tail
    const r = await p;
    assert.equal(r.exitCode, 1);
    assert.match(fs.readFileSync(r.logPath, 'utf8'), /noise line 19999\n$/);
    assert.match(r.outputTail, /noise line 19999/); assert.match(r.outputHead, /^noise line 0\n/);
  }
});

test('verification criteria change: neutral notice, config fingerprint, status unchanged', async () => {
  const { buildReceipt, formatReceipt, NOTICE_ZH, NOTICE_EN } = require('../src/receipt');
  const test0 = { exitCode: 0, timedOut: false, durationMs: 1, outputTail: '' };
  const base = { agent: 'codex', testCommand: 'npm test', test: test0, blockCount: 0, maxBlocks: 3, decision: 'allow' };
  const clean = buildReceipt({ ...base, diff: { isRepo: true, files: [{ path: 'src/a.js' }], insertions: 1, deletions: 0, testFilesChanged: [] }, config: { fingerprint: 'sha256:x', changedSinceLastVerified: false } });
  assert.equal(clean.verificationCriteria.changed, false); assert.equal(clean.verificationCriteria.configFingerprint, 'sha256:x');
  assert.doesNotMatch(formatReceipt(clean), /Notice/);
  const t = buildReceipt({ ...base, diff: { isRepo: true, files: [{ path: 'test/a.test.js' }], insertions: 1, deletions: 0, testFilesChanged: ['test/a.test.js'] }, config: { fingerprint: 'sha256:x', changedSinceLastVerified: false } });
  assert.equal(t.status, 'green', 'notice is informational only');
  assert.equal(t.verificationCriteria.changed, true); assert.equal(t.verificationCriteria.noticeZh, NOTICE_ZH);
  assert.ok(formatReceipt(t).includes(NOTICE_EN) && formatReceipt(t).includes(NOTICE_ZH));
  const c = buildReceipt({ ...base, diff: { isRepo: true, files: [], insertions: 0, deletions: 0, testFilesChanged: [] }, config: { fingerprint: 'sha256:y', changedSinceLastVerified: true, previousTestCommand: 'node -e 1' } });
  assert.deepEqual(c.verificationCriteria.reasons.map((r) => r.kind), ['config']);
  const w = buildReceipt({ ...base, diff: { isRepo: true, files: [{ path: '.github/workflows/ci.yml' }], insertions: 1, deletions: 0, testFilesChanged: [] } });
  assert.equal(w.verificationCriteria.reasons[0].kind, 'check-config-files');
});

test('verification criteria notice reaches the agent feedback when the config changed', async () => {
  const d = tmpRepo({ 'src.js': 'x\n' });
  saveConfig(d, { testCommand: 'node -e 0' });
  let r = await handleStop({ cwd: d, session_id: 'vc' });
  assert.equal(r.receipt.verificationCriteria.changed, false); assert.match(r.receipt.verificationCriteria.configFingerprint, /^sha256:/);
  saveConfig(d, { testCommand: 'node -e "process.exit(1)"', maxBlocks: 2 });
  r = await handleStop({ cwd: d, session_id: 'vc2' });
  assert.equal(r.receipt.verificationCriteria.changed, true);
  assert.equal(r.receipt.verificationCriteria.reasons[0].previousTestCommand, 'node -e 0');
  assert.match(r.output.reason, /Verification criteria changed, review needed/); assert.match(r.output.reason, /验证标准已变化，需复核/);
});

test('PR comment shows the verification criteria notice', () => {
  const { markdown } = require('../src/action');
  const { buildReceipt } = require('../src/receipt');
  const rc = buildReceipt({ agent: 'ci', testCommand: 'npm test', test: { exitCode: 0, timedOut: false, durationMs: 1, outputTail: '' }, blockCount: 0, maxBlocks: 0, decision: 'allow',
    diff: { isRepo: true, files: [{ path: 'test/x.test.js' }], insertions: 1, deletions: 0, testFilesChanged: ['test/x.test.js'] }, config: { fingerprint: 'sha256:z' } });
  const md = markdown(rc);
  assert.match(md, /> \[!NOTE\]/); assert.match(md, /验证标准已变化，需复核/); assert.match(md, /✅/);
});
