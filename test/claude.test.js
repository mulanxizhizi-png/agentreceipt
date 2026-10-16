const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { lastAssistantText, extractClaim } = require('../src/claim');
const { handleStop } = require('../src/hook'); const { saveConfig } = require('../src/config');
const inst = require('../src/install'); const { tmpRepo } = require('./helpers');
const TRANSCRIPT = path.join(__dirname, 'fixtures', 'claude-transcript.jsonl');
const payload = (cwd, extra = {}) => ({ ...JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-stop.json'), 'utf8')
  .replace('__TRANSCRIPT__', TRANSCRIPT).replace('__CWD__', cwd)), ...extra });

test('last assistant text from transcript skips tool-only and junk lines', () => {
  assert.equal(lastAssistantText(TRANSCRIPT), 'Fixed it. All tests pass ✅');
  assert.equal(lastAssistantText('/nope/missing.jsonl'), null);
});
test('extractClaim prefers last_assistant_message', () => {
  assert.equal(extractClaim({ last_assistant_message: 'hi', transcript_path: TRANSCRIPT }), 'hi');
  assert.equal(extractClaim({ transcript_path: TRANSCRIPT }), 'Fixed it. All tests pass ✅');
});
test('claude Stop payload: blocks with decision+reason, claim from transcript', async () => {
  const d = tmpRepo({ 't.js': 'process.exit(1)' });
  saveConfig(d, { testCommand: 'node t.js', timeoutSec: 10, maxBlocks: 2 });
  const r = await handleStop(payload(d), { agent: 'claude' });
  assert.equal(r.output.decision, 'block'); assert.equal(typeof r.output.reason, 'string');
  assert.deepEqual(Object.keys(r.output).sort(), ['decision', 'reason']);
  assert.equal(r.receipt.agent, 'claude'); assert.equal(r.receipt.claim, 'Fixed it. All tests pass ✅');
});
test('stop_hook_active: continuation counts toward limit, fresh turn resets', async () => {
  const d = tmpRepo({ 't.js': 'process.exit(1)' });
  saveConfig(d, { testCommand: 'node t.js', timeoutSec: 10, maxBlocks: 2 });
  const a = await handleStop(payload(d, { stop_hook_active: false }), { agent: 'claude' });
  const b = await handleStop(payload(d, { stop_hook_active: true }), { agent: 'claude' });
  const c = await handleStop(payload(d, { stop_hook_active: true }), { agent: 'claude' });
  assert.deepEqual([a.output.decision, b.output.decision, c.output.decision], ['block', 'block', undefined]);
  assert.equal(c.receipt.status, 'red');
  // user sends a new prompt -> new turn -> stop_hook_active false -> budget resets
  const e = await handleStop(payload(d, { stop_hook_active: false }), { agent: 'claude' });
  assert.equal(e.output.decision, 'block'); assert.equal(e.receipt.blocks.count, 1);
});
test('passing tests on claude: allow (no decision), systemMessage receipt', async () => {
  const d = tmpRepo({ t: '' });
  saveConfig(d, { testCommand: 'true', timeoutSec: 10, maxBlocks: 2 });
  const r = await handleStop(payload(d), { agent: 'claude' });
  assert.equal(r.output.decision, undefined); assert.match(r.output.systemMessage, /PASS/);
});
test('claude user scope writes CLAUDE_CONFIG_DIR/settings.json; uninstall leaves unrelated file untouched', () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccu-')); const env = { CLAUDE_CONFIG_DIR: cfgDir };
  fs.writeFileSync(path.join(cfgDir, 'settings.json'), '{"theme":"dark"}');
  const f = inst.install({ agent: 'claude', root: '/unused', binPath: '/s/agentreceipt-hook', scope: 'user', env });
  assert.equal(f, path.join(cfgDir, 'settings.json'));
  const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(doc.theme, 'dark'); assert.equal(doc.hooks.Stop[0].hooks[0].type, 'command');
  assert.equal(doc.hooks.Stop[0].hooks[0].command, "'/s/agentreceipt-hook' claude");
  assert.equal(doc.hooks.Stop[0].matcher, undefined);
  inst.uninstall({ agent: 'claude', root: '/unused', scope: 'user', env });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { theme: 'dark' });
  // second uninstall: nothing ours -> untouched, returns null
  fs.writeFileSync(f, '{ "theme":   "dark" }');
  assert.equal(inst.uninstall({ agent: 'claude', root: '/unused', scope: 'user', env }), null);
  assert.equal(fs.readFileSync(f, 'utf8'), '{ "theme":   "dark" }');
});
test('end-to-end via CLI hook process with a claude payload', () => {
  const { execFileSync } = require('child_process');
  const d = tmpRepo({ 't.js': 'process.exit(1)' });
  saveConfig(d, { testCommand: 'node t.js', timeoutSec: 10, maxBlocks: 1 });
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'agentreceipt.js'), 'hook', '--agent', 'claude'],
    { input: JSON.stringify(payload(d)), stdio: ['pipe', 'pipe', 'ignore'] }).toString();
  const j = JSON.parse(out.trim()); // stdout must be exactly one JSON object
  assert.equal(j.decision, 'block');
});
