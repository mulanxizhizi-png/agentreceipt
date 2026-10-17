'use strict';
// v0.1.5: requireChanges (empty diff), partial-test mark, init flags/warnings. Requested in comments on the launch post.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process');
const { handleStop } = require('../src/hook');
const { saveConfig, loadConfig, validateConfig, DEFAULTS } = require('../src/config');
const { testScope } = require('../src/scope');
const action = require('../src/action');
const { tmpRepo } = require('./helpers');

const g = (d, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: d, stdio: 'ignore' });
function repo(cfg = {}, files = {}) {
  const d = tmpRepo({ 'ok.js': 'process.exit(0)', 'bad.js': 'process.exit(1)', ...files });
  saveConfig(d, { testCommand: 'node ok.js', timeoutSec: 10, maxBlocks: 3, ...cfg });
  g(d, 'add', '-A'); g(d, 'commit', '-qm', 'config');
  return d;
}

// ---------- requireChanges ----------
test('config: requireChanges must be boolean; absent is fine and not written by default', () => {
  assert.deepEqual(validateConfig({ ...DEFAULTS, testCommand: 'x', requireChanges: true }), []);
  assert.match(validateConfig({ ...DEFAULTS, testCommand: 'x', requireChanges: 'yes' }).join(), /requireChanges must be true or false/);
  const d = repo();
  assert.equal('requireChanges' in JSON.parse(fs.readFileSync(path.join(d, '.agentreceipt/config.json'), 'utf8')), false);
});
test('invalid requireChanges -> error receipt, stop allowed', async () => {
  const d = repo();
  fs.writeFileSync(path.join(d, '.agentreceipt/config.json'), JSON.stringify({ testCommand: 'node ok.js', requireChanges: 1 }));
  const r = await handleStop({ cwd: d, session_id: 'e' });
  assert.equal(r.output.decision, undefined); assert.match(r.error, /requireChanges must be true or false/);
});
test('default (off): no files changed -> NOT blocked, but receipt + hook message say so prominently', async () => {
  const d = repo();
  const r = await handleStop({ cwd: d, session_id: 'a', stop_hook_active: false, last_assistant_message: 'Done, all tests pass.' });
  assert.equal(r.output.decision, undefined); assert.equal(r.receipt.status, 'green');
  assert.equal(r.receipt.diff.filesChanged, 0); assert.equal(r.receipt.diff.noChanges, true);
  assert.equal(r.receipt.changeCheck, undefined);
  assert.match(r.output.systemMessage, /Changes: +NO FILES WERE CHANGED in this turn/);
});
test('default (off): failing tests + no changes -> block reason notes no files were changed', async () => {
  const d = repo({ testCommand: 'node bad.js' });
  const r = await handleStop({ cwd: d, session_id: 'b' });
  assert.equal(r.output.decision, 'block'); assert.match(r.output.reason, /no files were changed in this turn/);
});
test('changed files -> no "no files changed" line', async () => {
  const d = repo({ requireChanges: true });
  fs.writeFileSync(path.join(d, 'src.js'), 'x');
  const r = await handleStop({ cwd: d, session_id: 'c', stop_hook_active: false });
  assert.equal(r.output.decision, undefined); assert.equal(r.receipt.status, 'green');
  assert.equal(r.receipt.diff.noChanges, undefined); assert.deepEqual(r.receipt.changeCheck, { required: true, noChanges: false, satisfied: true });
  assert.doesNotMatch(r.text, /NO FILES WERE CHANGED/);
});
test('requireChanges: no changes -> blocked once (counts toward maxBlocks); next stop without changes -> allowed, red', async () => {
  const d = repo({ requireChanges: true });
  const a = await handleStop({ cwd: d, session_id: 'r', stop_hook_active: false, last_assistant_message: 'Done.' });
  assert.equal(a.output.decision, 'block'); assert.equal(a.receipt.status, 'blocked');
  assert.match(a.output.reason, /no files were changed in this turn.*requireChanges/s);
  assert.match(a.output.reason, /explain why in your final message/);
  assert.match(a.output.reason, /block 1\/3/);
  assert.deepEqual(a.receipt.changeCheck, { required: true, noChanges: true, satisfied: false });
  const b = await handleStop({ cwd: d, session_id: 'r', stop_hook_active: true, last_assistant_message: 'No change needed: the function already handles it.' });
  assert.equal(b.output.decision, undefined); assert.equal(b.receipt.status, 'red');
  assert.equal(b.receipt.blocks.count, 1);
  assert.match(b.text, /NO FILES WERE CHANGED in this turn \(requireChanges is on\)/);
  assert.match(b.text, /Stopped without changing any files/);
  assert.doesNotMatch(b.text, /tests still failing/);
  // fresh turn: asked again
  const c = await handleStop({ cwd: d, session_id: 'r', stop_hook_active: false });
  assert.equal(c.output.decision, 'block');
});
test('requireChanges: agent makes the change after the block -> green', async () => {
  const d = repo({ requireChanges: true });
  assert.equal((await handleStop({ cwd: d, session_id: 'f', stop_hook_active: false })).output.decision, 'block');
  fs.writeFileSync(path.join(d, 'fix.js'), 'x');
  const r = await handleStop({ cwd: d, session_id: 'f', stop_hook_active: true });
  assert.equal(r.output.decision, undefined); assert.equal(r.receipt.status, 'green');
});
test('requireChanges: ignored/generated files do not count as a change', async () => {
  const d = repo({ requireChanges: true, ignore: ['build/'] });
  fs.mkdirSync(path.join(d, 'build')); fs.writeFileSync(path.join(d, 'build/out.js'), 'x');
  fs.mkdirSync(path.join(d, '__pycache__')); fs.writeFileSync(path.join(d, '__pycache__/m.pyc'), 'x');
  const r = await handleStop({ cwd: d, session_id: 'i', stop_hook_active: false });
  assert.equal(r.output.decision, 'block'); assert.equal(r.receipt.diff.noChanges, true);
});
test('requireChanges respects maxBlocks: 0 -> never blocks, receipt red', async () => {
  const d = repo({ requireChanges: true, maxBlocks: 0 });
  const r = await handleStop({ cwd: d, session_id: 'z', stop_hook_active: false });
  assert.equal(r.output.decision, undefined); assert.equal(r.receipt.status, 'red');
});
test('requireChanges: block budget already used by test failures -> no extra block', async () => {
  const d = repo({ requireChanges: true, maxBlocks: 1, testCommand: 'node bad.js' });
  const a = await handleStop({ cwd: d, session_id: 'm', stop_hook_active: false });
  assert.equal(a.output.decision, 'block'); assert.match(a.output.reason, /failed \(exit 1\)/);
  fs.writeFileSync(path.join(d, '.agentreceipt/config.json'), JSON.stringify({ testCommand: 'node ok.js', timeoutSec: 10, maxBlocks: 1, requireChanges: true }));
  const b = await handleStop({ cwd: d, session_id: 'm', stop_hook_active: true });
  assert.equal(b.output.decision, undefined); assert.equal(b.receipt.status, 'red');
});
test('requireChanges: commits made by the agent count as changes', async () => {
  const d = repo({ requireChanges: true });
  await handleStop({ cwd: d, session_id: 'k0', stop_hook_active: false }); // asks
  await handleStop({ cwd: d, session_id: 'k0', stop_hook_active: true }); // allowed red, base = HEAD
  fs.writeFileSync(path.join(d, 'feat.js'), 'x'); g(d, 'add', '-A'); g(d, 'commit', '-qm', 'feat');
  const r = await handleStop({ cwd: d, session_id: 'k1', stop_hook_active: false });
  assert.equal(r.receipt.status, 'green'); assert.equal(r.receipt.diff.filesChanged, 1);
});

// ---------- partial tests ----------
const PY = { 'pytest.ini': '[pytest]\n', 'tests/unit/test_a.py': '', 'tests/test_b.py': '' };
test('scope: pytest subsets are partial; flags-only / whole tests dir are not', () => {
  const d = tmpRepo(PY);
  const p = (c) => testScope(d, c);
  assert.equal(p('pytest -q').partial, false);
  assert.equal(p('pytest').partial, false);
  assert.equal(p('python -m pytest -x -q').partial, false);
  assert.equal(p('pytest tests').partial, false);
  assert.deepEqual(p('pytest tests/unit'), { partial: true, command: 'pytest tests/unit', detectedCommand: 'pytest -q', reason: 'path tests/unit' });
  assert.equal(p('uv run pytest tests/test_b.py').partial, true);
  assert.equal(p('pytest tests/test_b.py::test_x').partial, true);
  assert.equal(p('pytest -m smoke').partial, true);
  assert.equal(p('pytest -k "fast and not slow"').partial, true);
  assert.equal(p('pytest --lf').partial, true);
  assert.equal(p('pytest --maxfail 2').partial, false, 'option value is not a path');
});
test('scope: unknown/different runners and shell syntax -> no mark (null)', () => {
  const d = tmpRepo(PY);
  assert.equal(testScope(d, 'make test'), null);
  assert.equal(testScope(d, 'pytest tests/unit && echo ok'), null);
  assert.equal(testScope(d, './run-tests.sh tests/unit'), null);
  assert.equal(testScope(tmpRepo({ 'tests/x.txt': '' }), 'pytest tests/unit'), null, 'nothing detected -> no mark');
});
test('scope: npm / package.json script, cargo, go', () => {
  const js = tmpRepo({ 'package.json': '{"scripts":{"test":"jest"}}', 'test/unit/a.test.js': '' });
  assert.equal(testScope(js, 'npm test').partial, false);
  assert.equal(testScope(js, 'npm run test').partial, false);
  assert.equal(testScope(js, 'npm test -- --coverage').partial, false);
  assert.equal(testScope(js, 'npm test -- test/unit').partial, true);
  assert.equal(testScope(js, 'npx jest test/unit/a.test.js').partial, true);
  assert.equal(testScope(js, 'jest -t login').partial, true);
  assert.equal(testScope(js, 'jest').partial, false);
  assert.equal(testScope(js, 'vitest run'), null);
  const rs = tmpRepo({ 'Cargo.toml': '' });
  assert.equal(testScope(rs, 'cargo test --release').partial, false);
  assert.equal(testScope(rs, 'cargo test parser').partial, true);
  assert.equal(testScope(rs, 'cargo test -p core').partial, true);
  assert.equal(testScope(rs, 'cargo test -- --nocapture').partial, false);
  assert.equal(testScope(rs, 'cargo test -- --skip slow').partial, true);
  const go = tmpRepo({ 'go.mod': '' });
  assert.equal(testScope(go, 'go test -count=1 -race ./...').partial, false);
  assert.equal(testScope(go, 'go test -timeout 5m ./...').partial, false);
  assert.equal(testScope(go, 'go test ./pkg/...').partial, true);
  assert.equal(testScope(go, 'go test -run TestFoo ./...').partial, true);
  assert.equal(testScope(go, 'go test').partial, true);
});
test('hook: partial command -> receipt tests.partial + detectedCommand, prominent line in receipt and block reason', async () => {
  const d = repo({ testCommand: 'pytest tests/unit' }, PY);
  // pytest may not be installed: fake it with a tiny shim on PATH
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-bin-'));
  fs.writeFileSync(path.join(bin, 'pytest'), '#!/bin/sh\nexit 0\n'); fs.chmodSync(path.join(bin, 'pytest'), 0o755);
  const old = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${old}`;
  try {
    fs.writeFileSync(path.join(d, 'x.py'), 'x');
    const r = await handleStop({ cwd: d, session_id: 'p', stop_hook_active: false });
    assert.equal(r.receipt.status, 'green');
    assert.equal(r.receipt.tests.partial, true); assert.equal(r.receipt.tests.detectedCommand, 'pytest -q');
    assert.match(r.output.systemMessage, /Scope: +only part of the test suite ran \(configured `pytest tests\/unit`, detected full suite `pytest -q`\)/);
    fs.writeFileSync(path.join(bin, 'pytest'), '#!/bin/sh\nexit 1\n');
    const b = await handleStop({ cwd: d, session_id: 'p2', stop_hook_active: false });
    assert.equal(b.output.decision, 'block'); assert.match(b.output.reason, /only part of the test suite ran/);
  } finally { process.env.PATH = old; }
});
test('hook: full command -> no partial mark', async () => {
  const d = repo({ testCommand: 'npm test' }, { 'package.json': '{"scripts":{"test":"node ok.js"}}' });
  fs.writeFileSync(path.join(d, 'y.js'), 'x');
  const r = await handleStop({ cwd: d, session_id: 'np', stop_hook_active: false });
  assert.equal(r.receipt.tests.partial, undefined); assert.equal(r.receipt.tests.detectedCommand, undefined);
  assert.doesNotMatch(r.text, /Scope:/);
});

// ---------- GitHub Action ----------
function prEnv(d) {
  const p = (s) => path.join(d, '..', path.basename(d) + s);
  const base = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: d }).toString().trim();
  fs.writeFileSync(p('-ev.json'), JSON.stringify({ pull_request: { number: 7, title: 'PR', body: '', base: { sha: base }, head: { sha: '1234567' } } }));
  fs.writeFileSync(p('-out'), ''); fs.writeFileSync(p('-sum'), '');
  return { out: p('-out'), env: { GITHUB_WORKSPACE: d, GITHUB_EVENT_PATH: p('-ev.json'), GITHUB_OUTPUT: p('-out'), GITHUB_STEP_SUMMARY: p('-sum'), GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: 'https://api.test', AR_TOKEN: 't', AR_COMMENT: 'true', AR_TIMEOUT: '30' } };
}
function mockFetch(store) {
  return async (url, opts) => {
    let data = opts.method === 'GET' ? store.comments : null;
    if (opts.method === 'POST') { data = { id: 1, body: JSON.parse(opts.body).body }; store.comments.push(data); }
    return { ok: true, status: 200, json: async () => data, text: async () => '' };
  };
}
const readReceipt = (out) => JSON.parse(fs.readFileSync(fs.readFileSync(out, 'utf8').match(/receipt-path=(.*)/)[1], 'utf8'));
test('Action: PR with no file changes -> comment says so; requireChanges -> check fails (RED: no files changed)', async (t) => {
  const store = { comments: [] }; t.mock.method(global, 'fetch', mockFetch(store));
  const d = repo();
  g(d, 'commit', '-q', '--allow-empty', '-m', 'empty PR');
  let a = prEnv(d); process.exitCode = 0;
  await action.main(a.env);
  assert.equal(process.exitCode, 0);
  let r = readReceipt(a.out);
  assert.equal(r.status, 'green'); assert.equal(r.diff.noChanges, true);
  assert.match(store.comments[0].body, /> \*\*NO FILES WERE CHANGED in this PR\*\*/);
  // now with requireChanges in the shared config
  const d2 = repo({ requireChanges: true });
  g(d2, 'commit', '-q', '--allow-empty', '-m', 'empty PR');
  store.comments.length = 0; a = prEnv(d2);
  await action.main(a.env);
  assert.equal(process.exitCode, 1); process.exitCode = 0;
  r = readReceipt(a.out);
  assert.equal(r.status, 'red'); assert.equal(r.decision, 'fail'); assert.equal(r.tests.passed, true);
  assert.match(store.comments[0].body, /RED: no files changed/);
  assert.match(store.comments[0].body, /requireChanges is on/);
});
test('Action: partial test command -> PR comment shows the partial line', async (t) => {
  const store = { comments: [] }; t.mock.method(global, 'fetch', mockFetch(store));
  const d = repo({ testCommand: 'npm test -- test/unit' }, { 'package.json': '{"scripts":{"test":"node ok.js"}}', 'test/unit/a.test.js': '' });
  fs.writeFileSync(path.join(d, 'z.js'), 'x'); g(d, 'add', '-A'); g(d, 'commit', '-qm', 'pr');
  const a = prEnv(d); process.exitCode = 0;
  await action.main(a.env);
  assert.equal(process.exitCode, 0);
  const r = readReceipt(a.out);
  assert.equal(r.tests.partial, true); assert.equal(r.tests.detectedCommand, 'npm test');
  assert.match(store.comments[0].body, /> \*\*only part of the test suite ran \(configured `npm test -- test\/unit`, detected full suite `npm test`\)\*\*/);
});

// ---------- init ----------
function runInit(root, args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arh-'));
  const env = { ...process.env, HOME: home, AGENTRECEIPT_HOME: path.join(home, '.agentreceipt'), CODEX_HOME: path.join(home, '.codex') };
  const res = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'agentreceipt.js'), 'init', '--agent', 'codex', ...args], { cwd: root, env, encoding: 'utf8' });
  return { ...res, out: res.stdout + res.stderr };
}
test('init --require-changes / --no-require-changes; >780s timeout warns; partial command noted', () => {
  const d = tmpRepo({ ...PY });
  let r = runInit(d, ['--test', 'pytest tests/unit', '--require-changes']);
  assert.equal(r.status, 0, r.out);
  assert.equal(loadConfig(d).requireChanges, true);
  assert.match(r.out, /runs only part of the test suite \(detected full suite: `pytest -q`\)/);
  assert.doesNotMatch(r.out, /Warning: --timeout/);
  r = runInit(d, ['--timeout', '800']);
  assert.equal(r.status, 0, r.out);
  assert.equal(loadConfig(d).requireChanges, true, 'kept when flag absent');
  assert.match(r.out, /Warning: --timeout 800s is above ~780s.*900s/);
  r = runInit(d, ['--no-require-changes']);
  assert.equal(loadConfig(d).requireChanges, false);
});
