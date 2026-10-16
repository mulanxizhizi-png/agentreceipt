'use strict';
// agentundo integration: optional, fail-open, never mentioned to the agent.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { tmpRepo } = require('./helpers');
const { handleStop } = require('../src/hook');
const { saveConfig } = require('../src/config');
const { formatReceipt } = require('../src/receipt');

const UNDO_SRC = process.env.AGENTUNDO_SRC || path.resolve(__dirname, '..', '..', 'agentundo');
const haveUndo = fs.existsSync(path.join(UNDO_SRC, 'bin', 'agentundo.js'));
const TEST = `node -e "process.exit(require('fs').readFileSync('a.txt','utf8')==='good'?0:1)"`;

function withUndoHome(fn) {
  const prev = process.env.AGENTUNDO_HOME;
  process.env.AGENTUNDO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-undo-'));
  return Promise.resolve(fn(process.env.AGENTUNDO_HOME)).finally(() => { process.env.AGENTUNDO_HOME = prev; });
}
function fakeCli(home, script) {
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  const p = path.join(home, 'bin', 'agentundo'); fs.writeFileSync(p, `#!/bin/sh\n${script}\n`); fs.chmodSync(p, 0o755);
}

test('agentundo absent -> receipt unchanged (no undo field, no Snapshot line)', () => withUndoHome(async () => {
  const d = tmpRepo({ 'a.txt': 'good' }); saveConfig(d, { testCommand: TEST, timeoutSec: 20, maxBlocks: 1 });
  const r = await handleStop({ cwd: d, session_id: 's' });
  assert.strictEqual(r.receipt.status, 'green');
  assert.ok(!('undo' in r.receipt)); assert.doesNotMatch(r.text, /Snapshot|agentundo/);
}));

test('agentundo broken / garbage / not initialised / hanging -> fail open, receipt unchanged', () => withUndoHome(async (home) => {
  const d = tmpRepo({ 'a.txt': 'good' }); saveConfig(d, { testCommand: TEST, timeoutSec: 20, maxBlocks: 1 });
  for (const script of ['exit 3', 'echo not json', 'echo \'{"schemaVersion":1,"ok":false,"reason":"not-initialized"}\'', 'sleep 5']) {
    fakeCli(home, script);
    process.env.AGENTRECEIPT_UNDO_TIMEOUT_MS = '700';
    const t0 = Date.now();
    const r = await handleStop({ cwd: d, session_id: 's' + script.length });
    delete process.env.AGENTRECEIPT_UNDO_TIMEOUT_MS;
    assert.strictEqual(r.receipt.status, 'green', script); assert.ok(!('undo' in r.receipt), script);
    assert.ok(Date.now() - t0 < 4000, `bounded by timeout: ${script}`);
  }
}));

test('formatReceipt shows snapshot and go-back command', () => {
  const base = { status: 'red', agent: 'codex', claim: null, tests: { command: 't', passed: false, exitCode: 1, timedOut: false, durationMs: 1, outputTail: '' }, diff: { isRepo: true, filesChanged: 0, insertions: 0, deletions: 0, testFilesChanged: [] }, blocks: { count: 1, max: 1 }, warnings: [] };
  const t = formatReceipt({ ...base, undo: { snapshotId: 9, lastKnownGood: false, lastGreenSnapshotId: 4, restoreCommand: '~/.agentundo/bin/agentundo restore 4' } });
  assert.match(t, /Snapshot: agentundo #9\n/); assert.match(t, /Go back: +~\/\.agentundo\/bin\/agentundo restore 4 +\(last state where tests passed, #4\)/);
  assert.match(formatReceipt({ ...base, status: 'green', undo: { snapshotId: 4, lastKnownGood: true, lastGreenSnapshotId: 4, restoreCommand: null } }), /agentundo #4 \(last known good\)/);
});

test('cross-tool e2e: both installed, green then red; restore command brings back the green state', { skip: !haveUndo && 'agentundo source not found' }, () => withUndoHome(async (home) => {
  const d = tmpRepo({ 'a.txt': 'good', 'src/x.js': 'keep' });
  saveConfig(d, { testCommand: TEST, timeoutSec: 20, maxBlocks: 1 });
  const env = { ...process.env, AGENTUNDO_HOME: home, CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude') };
  execFileSync(process.execPath, [path.join(UNDO_SRC, 'bin', 'agentundo.js'), 'init'], { cwd: d, env, stdio: 'ignore' });

  const g = await handleStop({ cwd: d, session_id: 'e2e' });
  assert.strictEqual(g.receipt.status, 'green');
  assert.strictEqual(g.receipt.undo.lastKnownGood, true);
  assert.strictEqual(g.receipt.undo.restoreCommand, null);
  const green = g.receipt.undo.snapshotId;
  assert.match(g.text, new RegExp(`Snapshot: agentundo #${green} \\(last known good\\)`));

  // the agent breaks things: edits a.txt, deletes src/, adds junk
  fs.writeFileSync(path.join(d, 'a.txt'), 'bad'); fs.rmSync(path.join(d, 'src'), { recursive: true }); fs.writeFileSync(path.join(d, 'junk.txt'), 'j');
  const b = await handleStop({ cwd: d, session_id: 'e2e', stop_hook_active: false });
  assert.strictEqual(b.receipt.status, 'blocked');
  assert.strictEqual(b.receipt.undo.lastGreenSnapshotId, green);
  assert.ok(b.receipt.undo.snapshotId > green);
  assert.match(b.receipt.undo.restoreCommand, new RegExp(`agentundo restore ${green}$`));
  assert.doesNotMatch(b.output.reason, /agentundo|restore/, 'the agent is never told to restore');
  const saved = JSON.parse(fs.readFileSync(b.file, 'utf8'));
  assert.deepStrictEqual(saved.undo, b.receipt.undo);
  const r = await handleStop({ cwd: d, session_id: 'e2e' }); // block limit reached -> red, still offers the command
  assert.strictEqual(r.receipt.status, 'red');
  assert.match(r.text, new RegExp(`Go back: .*agentundo restore ${green}`));

  // agentundo list shows the receipt marks
  const list = execFileSync(path.join(home, 'bin', 'agentundo'), ['list'], { cwd: d, env: { ...env, NO_COLOR: '1' }, encoding: 'utf8' });
  assert.match(list, new RegExp(`^${green} .*✓ tests passed`, 'm'));
  assert.match(list, /✗ tests failed/);

  // run the receipt's command exactly (expanding ~), non-interactively
  const cmd = r.receipt.undo.restoreCommand.replace(/^~/, os.homedir());
  const out = spawnSync('sh', ['-c', `${cmd} --yes`], { cwd: d, env, encoding: 'utf8' });
  assert.strictEqual(out.status, 0, out.stdout + out.stderr);
  assert.strictEqual(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'good');
  assert.strictEqual(fs.readFileSync(path.join(d, 'src/x.js'), 'utf8'), 'keep');
  assert.ok(!fs.existsSync(path.join(d, 'junk.txt')));
  // receipts written after the green snapshot survive the restore (agentundo excludes .agentreceipt/receipts)
  assert.ok(fs.existsSync(b.file) && fs.existsSync(r.file));
  assert.strictEqual(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: d, encoding: 'utf8' }), '');
  const again = await handleStop({ cwd: d, session_id: 'e2e2' });
  assert.strictEqual(again.receipt.status, 'green');
}));
