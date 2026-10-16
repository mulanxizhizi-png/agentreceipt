const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { handleStop } = require('../src/hook'); const { saveConfig } = require('../src/config'); const { tmpRepo } = require('./helpers');

function repo(pass, extra = {}) {
  const d = tmpRepo({ 'ok.js': `process.exit(${pass ? 0 : 1})`, ...extra });
  saveConfig(d, { testCommand: 'node ok.js', timeoutSec: 10, maxBlocks: 2 });
  return d;
}
const receipts = (d) => fs.readdirSync(path.join(d, '.agentreceipt', 'receipts'));

test('no config -> no-op', async () => {
  const r = await handleStop({ cwd: tmpRepo({}) });
  assert.deepEqual(r.output, {}); assert.ok(r.skipped);
});
test('passing tests -> allow, green receipt', async () => {
  const d = repo(true);
  const r = await handleStop({ cwd: d, session_id: 's1', last_assistant_message: 'Done!' });
  assert.equal(r.output.decision, undefined); assert.equal(r.receipt.status, 'green');
  assert.equal(r.receipt.schemaVersion, 1); assert.equal(r.receipt.claim, 'Done!');
  assert.equal(receipts(d).length, 1);
});
test('failing tests -> block until max, then red', async () => {
  const d = repo(false);
  const a = await handleStop({ cwd: d, session_id: 's2' });
  assert.equal(a.output.decision, 'block'); assert.match(a.output.reason, /failed \(exit 1\)/); assert.match(a.output.reason, /block 1\/2/);
  const b = await handleStop({ cwd: d, session_id: 's2' });
  assert.equal(b.output.decision, 'block');
  const c = await handleStop({ cwd: d, session_id: 's2' });
  assert.equal(c.output.decision, undefined); assert.equal(c.receipt.status, 'red'); assert.match(c.text, /RED/);
  assert.equal(receipts(d).length, 3);
  // counter is per session
  const other = await handleStop({ cwd: d, session_id: 's3' });
  assert.equal(other.output.decision, 'block');
});
test('timeout counts as failure', async () => {
  const d = tmpRepo({ 'slow.js': 'setTimeout(()=>{},10000)' });
  saveConfig(d, { testCommand: 'node slow.js', timeoutSec: 1, maxBlocks: 1 });
  const r = await handleStop({ cwd: d, session_id: 't' });
  assert.equal(r.output.decision, 'block'); assert.equal(r.receipt.tests.timedOut, true); assert.match(r.output.reason, /timed out/);
});
test('flags modified test files', async () => {
  const d = repo(false, { 'test/a.test.js': '1' });
  fs.writeFileSync(path.join(d, 'test/a.test.js'), '2');
  const r = await handleStop({ cwd: d, session_id: 'm' });
  assert.deepEqual(r.receipt.diff.testFilesChanged, ['test/a.test.js']);
  assert.match(r.output.reason, /fix the code, not the tests/);
});
test('diff ignores agentreceipt own files and untracked .claude/settings.json', async () => {
  const d = repo(true);
  fs.mkdirSync(path.join(d, '.claude')); fs.writeFileSync(path.join(d, '.claude/settings.json'), '{}');
  const r = await handleStop({ cwd: d, session_id: 'x' });
  assert.equal(r.receipt.diff.filesChanged, 0);
});
