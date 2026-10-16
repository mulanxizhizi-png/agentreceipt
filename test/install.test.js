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
  assert.equal(h.timeout, inst.HOOK_TIMEOUT); assert.match(h.command, / codex$/);
  inst.uninstall({ agent: 'codex', root: home, env });
  assert.equal(fs.existsSync(f), false);
});
test('claude default install writes .claude/settings.local.json, gitignores it, never touches settings.json', () => {
  const { tmpRepo } = require('./helpers'); const { execFileSync } = require('child_process');
  const root = tmpRepo({ '.claude/settings.json': '{"model":"x"}' });
  const f = inst.install({ agent: 'claude', root, binPath: '/b/agentreceipt-hook' });
  assert.equal(f, path.join(root, '.claude/settings.local.json'));
  assert.match(JSON.parse(fs.readFileSync(f, 'utf8')).hooks.Stop[0].hooks[0].command, / claude$/);
  assert.equal(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'), '{"model":"x"}');
  execFileSync('git', ['check-ignore', '-q', '.claude/settings.local.json'], { cwd: root }); // throws if not ignored
  inst.install({ agent: 'claude', root, binPath: '/b/agentreceipt-hook' }); // idempotent gitignore
  assert.equal(fs.existsSync(path.join(root, '.gitignore')), false); // repo untouched
  assert.equal(fs.readFileSync(path.join(root, '.git/info/exclude'), 'utf8').split('\n').filter((l) => l === '.claude/settings.local.json').length, 1);
  assert.throws(() => inst.install({ agent: 'claude', root, binPath: '/b/x', scope: 'project' }));
});
test('uninstall cleans settings.local.json and legacy settings.json entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-'));
  fs.mkdirSync(path.join(root, '.claude'));
  const legacy = { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: '"/usr/bin/node" "/h/.agentreceipt/runtime/0.1.0/bin/agentreceipt.js" hook --agent claude' }] }] } };
  fs.writeFileSync(path.join(root, '.claude/settings.json'), JSON.stringify(legacy));
  inst.install({ agent: 'claude', root, binPath: '/b/agentreceipt-hook' });
  assert.ok(inst.uninstall({ agent: 'claude', root, scope: 'local' }));
  assert.ok(inst.uninstall({ agent: 'claude', root, scope: 'project' }));
  assert.equal(fs.existsSync(path.join(root, '.claude/settings.local.json')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8')), { model: 'x' });
});
test('removeRuntime deletes runtime and empty home', () => {
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arh-')), '.agentreceipt');
  const env = { AGENTRECEIPT_HOME: home };
  inst.installRuntime(env);
  assert.ok(fs.existsSync(path.join(home, 'runtime')));
  inst.removeRuntime(env);
  assert.equal(fs.existsSync(home), false);
});
test('hook command text is version-independent; shim dispatches to current runtime', () => {
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arv-')), '.agentreceipt');
  const env = { AGENTRECEIPT_HOME: home };
  const shim = inst.installRuntime(env);
  assert.equal(shim, inst.shimPath(env));
  assert.equal(inst.hookCommand(shim, 'codex'), JSON.stringify(path.join(home, 'bin', 'agentreceipt-hook')) + ' codex');
  assert.match(fs.readFileSync(shim, 'utf8'), new RegExp('runtime/' + inst.VERSION.replace(/\./g, '\\.') + '/bin/agentreceipt.js'));
  // simulated old version gets cleaned up
  fs.mkdirSync(path.join(home, 'runtime', '0.0.1'));
  inst.installRuntime(env);
  assert.deepEqual(fs.readdirSync(path.join(home, 'runtime')), [inst.VERSION]);
  const a = inst.upsertStopHook({}, inst.hookCommand(shim, 'codex'), inst.HOOK_TIMEOUT);
  const b = inst.upsertStopHook({}, inst.hookCommand(inst.installRuntime(env), 'codex'), inst.HOOK_TIMEOUT);
  assert.deepEqual(a, b);
});
