const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process');
const action = require('../src/action'); const { tmpRepo } = require('./helpers');

function setup(pass) {
  const d = tmpRepo({ 'package.json': '{"scripts":{"test":"node t.js"}}', 't.js': 'process.exit(1)' });
  const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: d, stdio: 'ignore' });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d }).toString().trim();
  fs.writeFileSync(path.join(d, 't.js'), `process.exit(${pass ? 0 : 1})\n// change`);
  g('commit', '-qam', 'pr change');
  const ev = path.join(d, '..', path.basename(d) + '-event.json');
  fs.writeFileSync(ev, JSON.stringify({ pull_request: { number: 7, title: 'Fix tests', body: 'All tests pass now', base: { sha: base }, head: { sha: 'abcdef1234' } } }));
  const out = path.join(d, '..', path.basename(d) + '-out'); fs.writeFileSync(out, '');
  const sum = path.join(d, '..', path.basename(d) + '-sum'); fs.writeFileSync(sum, '');
  return { d, env: { GITHUB_WORKSPACE: d, GITHUB_EVENT_PATH: ev, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum, GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: 'https://api.test', AR_TOKEN: 't', AR_COMMENT: 'true', AR_TIMEOUT: '30' }, out, sum };
}

function mockFetch(store) {
  return async (url, opts) => {
    store.calls.push(`${opts.method} ${url}`);
    let data = null;
    if (opts.method === 'GET') data = store.comments;
    if (opts.method === 'POST') { data = { id: 1, body: JSON.parse(opts.body).body }; store.comments.push(data); }
    if (opts.method === 'PATCH') { const c = store.comments.find((x) => url.endsWith('/' + x.id)); c.body = JSON.parse(opts.body).body; data = c; }
    return { ok: true, status: 200, json: async () => data, text: async () => '' };
  };
}

test('failing PR: red receipt, exit 1, comment posted, then updated (single comment) on pass', async (t) => {
  const store = { calls: [], comments: [{ id: 99, body: 'unrelated' }] };
  t.mock.method(global, 'fetch', mockFetch(store));
  const a = setup(false);
  process.exitCode = 0;
  await action.main(a.env);
  assert.equal(process.exitCode, 1);
  const r = JSON.parse(fs.readFileSync(fs.readFileSync(a.out, 'utf8').match(/receipt-path=(.*)/)[1], 'utf8'));
  assert.equal(r.status, 'red'); assert.equal(r.agent, 'ci'); assert.equal(r.schemaVersion, 1);
  assert.equal(r.claim, 'Fix tests | All tests pass now'); assert.equal(r.diff.filesChanged, 1);
  assert.equal(store.comments.length, 2); assert.match(store.comments[1].body, /RED/); assert.ok(store.comments[1].body.includes(action.MARKER));
  assert.match(fs.readFileSync(a.sum, 'utf8'), /Agent Receipt/);

  const b = setup(true);
  process.exitCode = 0;
  await action.main(b.env);
  assert.equal(process.exitCode, 0);
  assert.equal(store.comments.length, 2, 'updated in place, not a second comment');
  assert.match(store.comments[1].body, /PASS/);
  assert.ok(store.calls.some((c) => c.startsWith('PATCH')));
});
test('comment: false skips the API; markdown escapes fences', async (t) => {
  const store = { calls: [], comments: [] };
  t.mock.method(global, 'fetch', mockFetch(store));
  const a = setup(true); process.exitCode = 0;
  await action.main({ ...a.env, AR_COMMENT: 'false' });
  assert.equal(store.calls.length, 0); assert.equal(process.exitCode, 0);
});
test('test-command input overrides detection', () => {
  assert.equal(action.resolveTestCommand(tmpRepo({ 'package.json': '{"scripts":{"test":"x"}}' }), 'make check'), 'make check');
  assert.equal(action.resolveTestCommand(tmpRepo({ 'package.json': '{"scripts":{"test":"x"}}' }), ''), 'npm test');
});
