'use strict';
// v0.1.4 follow-up: the Action reads .agentreceipt/config.json (ignore, criteriaFiles) through the same
// code path as the Stop hook, so local and CI receipts agree; invalid config -> error receipt + PR comment.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { execFileSync } = require('child_process');
const action = require('../src/action'); const { tmpRepo } = require('./helpers');
const { handleStop } = require('../src/hook');
const { saveConfig } = require('../src/config');

const g = (d, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: d, stdio: 'ignore' });
function env(d) {
  const p = (s) => path.join(d, '..', path.basename(d) + s);
  const base = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: d }).toString().trim();
  fs.writeFileSync(p('-ev.json'), JSON.stringify({ pull_request: { number: 3, title: 'PR', body: '', base: { sha: base }, head: { sha: '1234567' } } }));
  fs.writeFileSync(p('-out'), ''); fs.writeFileSync(p('-sum'), '');
  return { out: p('-out'), sum: p('-sum'), env: { GITHUB_WORKSPACE: d, GITHUB_EVENT_PATH: p('-ev.json'), GITHUB_OUTPUT: p('-out'), GITHUB_STEP_SUMMARY: p('-sum'), GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: 'https://api.test', AR_TOKEN: 't', AR_COMMENT: 'true', AR_TIMEOUT: '30' } };
}
function mockFetch(store) {
  return async (url, opts) => {
    let data = opts.method === 'GET' ? store.comments : null;
    if (opts.method === 'POST') { data = { id: 1, body: JSON.parse(opts.body).body }; store.comments.push(data); }
    return { ok: true, status: 200, json: async () => data, text: async () => '' };
  };
}
const readReceipt = (out) => JSON.parse(fs.readFileSync(fs.readFileSync(out, 'utf8').match(/receipt-path=(.*)/)[1], 'utf8'));
const paths = (r) => r.diff.files.map((f) => f.path).sort();

test('custom ignore + criteriaFiles: local hook receipt and Action receipt agree', async (t) => {
  t.mock.method(global, 'fetch', mockFetch({ comments: [] }));
  const d = tmpRepo({ 'ok.js': 'process.exit(0)' });
  saveConfig(d, { testCommand: 'node ok.js', ignore: ['build/', '*.log'], criteriaFiles: ['ci/**'] });
  g(d, 'add', '-A'); g(d, 'commit', '-qm', 'config');
  const changes = { 'build/out.js': 'x', 'run.log': 'x', 'src/real.js': 'x', 'ci/check.sh': 'x', '__pycache__/m.pyc': 'x', 'tests/test_a.js': 'x' };
  for (const [f, c] of Object.entries(changes)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  const local = (await handleStop({ cwd: d, session_id: 'loc' })).receipt;
  g(d, 'add', '-A', '-f'); g(d, 'commit', '-qm', 'pr');
  const a = env(d); process.exitCode = 0;
  await action.main(a.env);
  assert.equal(process.exitCode, 0); process.exitCode = 0;
  const ci = readReceipt(a.out);
  assert.deepStrictEqual(paths(local), ['ci/check.sh', 'src/real.js', 'tests/test_a.js']);
  assert.deepStrictEqual(paths(ci), paths(local));
  assert.deepStrictEqual(ci.diff.testFilesChanged, local.diff.testFilesChanged);
  assert.equal(local.status, 'green'); assert.equal(ci.status, 'green');
  const kinds = (r) => r.verificationCriteria.reasons.map((x) => `${x.kind}:${(x.files || []).join(',')}`);
  assert.deepStrictEqual(kinds(ci), kinds(local));
  assert.ok(kinds(ci).includes('check-config-files:ci/check.sh'));
});

test('invalid config: Action writes error receipt like the hook, comments it on the PR, fails the check', async (t) => {
  const store = { comments: [] };
  t.mock.method(global, 'fetch', mockFetch(store));
  const d = tmpRepo({ 'ok.js': 'process.exit(0)' });
  saveConfig(d, { testCommand: 'node ok.js', ignore: 'build' });
  const local = (await handleStop({ cwd: d, session_id: 'bad' })).receipt;
  g(d, 'add', '-A', '-f'); g(d, 'commit', '-qm', 'bad config');
  const a = env(d); process.exitCode = 0;
  await action.main(a.env);
  assert.equal(process.exitCode, 1); process.exitCode = 0;
  const ci = readReceipt(a.out);
  assert.equal(local.status, 'error'); assert.equal(ci.status, 'error');
  assert.match(ci.error, /ignore must be an array of glob strings/);
  assert.equal(ci.error, local.error);
  assert.equal(store.comments.length, 1);
  assert.match(store.comments[0].body, /ERROR: could not verify/);
  assert.match(store.comments[0].body, /check failed/); assert.doesNotMatch(store.comments[0].body, /stop allowed/);
  assert.match(store.comments[0].body, /ignore must be an array of glob strings/);
  assert.match(fs.readFileSync(a.sum, 'utf8'), /ignore must be an array/);
});

test('CI error wording: Action receipt says check failed, hook keeps stop allowed', () => {
  const { formatReceipt, buildReceipt } = require('../src/receipt');
  const mk = (agent) => formatReceipt(buildReceipt({ agent, testCommand: null, test: { exitCode: null, timedOut: false, durationMs: 0, outputTail: '' }, diff: { isRepo: true, files: [], insertions: 0, deletions: 0, testFilesChanged: [] }, blockCount: 0, maxBlocks: 0, decision: 'allow', error: 'bad config' }));
  const ci = mk('ci'), local = mk('codex');
  assert.match(ci, /check failed/); assert.doesNotMatch(ci, /stop allowed/);
  assert.match(local, /stop allowed/);
});
