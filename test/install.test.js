const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const inst = require('../src/install');
test('upsert keeps other hooks and is idempotent', () => {
  const doc = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other.sh' }] }], PreToolUse: [] } };
  inst.upsertStopHook(doc, 'node /x/agentreceipt.js hook', 60);
  inst.upsertStopHook(doc, 'node /y/agentreceipt.js hook', 60);
  const cmds = doc.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
  assert.deepEqual(cmds, ['other.sh', 'node /y/agentreceipt.js hook']);
  inst.removeStopHook(doc);
  assert.deepEqual(doc.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command)), ['other.sh']);
});
test('codex install writes CODEX_HOME/hooks.json, uninstall cleans up', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-'));
  const env = { CODEX_HOME: home };
  const f = inst.install({ agent: 'codex', root: home, binPath: '/b/agentreceipt.js', timeoutSec: 300, env });
  assert.equal(f, path.join(home, 'hooks.json'));
  const h = JSON.parse(fs.readFileSync(f, 'utf8')).hooks.Stop[0].hooks[0];
  assert.equal(h.timeout, 330); assert.match(h.command, /hook --agent codex/);
  inst.uninstall({ agent: 'codex', root: home, env });
  assert.equal(fs.existsSync(f), false);
});
test('claude install writes .claude/settings.json preserving keys', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
  fs.mkdirSync(path.join(root, '.claude')); fs.writeFileSync(path.join(root, '.claude/settings.json'), '{"model":"x"}');
  inst.install({ agent: 'claude', root, binPath: '/b/agentreceipt.js', timeoutSec: 60 });
  const doc = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'));
  assert.equal(doc.model, 'x'); assert.match(doc.hooks.Stop[0].hooks[0].command, /--agent claude/);
});
test('removeRuntime deletes runtime and empty home', () => {
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arh-')), '.agentreceipt');
  const env = { AGENTRECEIPT_HOME: home };
  inst.installRuntime(env);
  assert.ok(fs.existsSync(path.join(home, 'runtime')));
  inst.removeRuntime(env);
  assert.equal(fs.existsSync(home), false);
});
