// Regression tests for the v0.1.1 review findings.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process');
const { tmpRepo } = require('./helpers');
const inst = require('../src/install');
const { handleStop } = require('../src/hook');
const { saveConfig, loadConfig } = require('../src/config');
const { getBlocks, setBlocks } = require('../src/state');
const BIN = path.join(__dirname, '..', 'bin', 'agentreceipt.js');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const run = (args, opts) => { try { return { code: 0, out: execFileSync(process.execPath, [BIN, ...args], { stdio: 'pipe', ...opts }).toString() }; } catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; } };

// 1. malformed settings
test('install refuses malformed hooks.json and leaves it byte-identical', () => {
  const codex = tmp('cx-'); const f = path.join(codex, 'hooks.json');
  fs.writeFileSync(f, '{ invalid json user config');
  assert.throws(() => inst.install({ agent: 'codex', root: codex, binPath: '/b/agentreceipt-hook', env: { CODEX_HOME: codex, AGENTRECEIPT_HOME: tmp('h-') } }), /not valid JSON/);
  assert.equal(fs.readFileSync(f, 'utf8'), '{ invalid json user config');
  for (const bad of ['[]', '{"hooks": []}', '{"hooks": {"Stop": {}}}']) {
    fs.writeFileSync(f, bad);
    assert.throws(() => inst.install({ agent: 'codex', root: codex, binPath: '/b/agentreceipt-hook', env: { CODEX_HOME: codex } }));
    assert.equal(fs.readFileSync(f, 'utf8'), bad);
  }
});
test('init aborts before writing anything when a target file is malformed', () => {
  const repo = tmpRepo({ 'package.json': '{"scripts":{"test":"node -e 0"}}', '.claude/settings.local.json': '{oops' });
  const home = tmp('h-'); const env = { ...process.env, AGENTRECEIPT_HOME: path.join(home, 'ar'), CODEX_HOME: path.join(home, 'codex') };
  const r = run(['init'], { cwd: repo, env });
  assert.equal(r.code, 1); assert.match(r.out, /settings\.local\.json is not valid JSON/);
  assert.equal(fs.existsSync(path.join(home, 'codex', 'hooks.json')), false, 'codex hook not written either');
  assert.equal(fs.existsSync(path.join(home, 'ar', 'bin')), false, 'no runtime installed');
  assert.equal(fs.readFileSync(path.join(repo, '.claude/settings.local.json'), 'utf8'), '{oops');
});
test('existing settings are backed up outside the project before modification', () => {
  const repo = tmpRepo({ '.claude/settings.local.json': '{"model":"x"}' });
  const env = { AGENTRECEIPT_HOME: tmp('h-') };
  inst.install({ agent: 'claude', root: repo, binPath: '/b/agentreceipt-hook', env });
  const backups = fs.readdirSync(path.join(env.AGENTRECEIPT_HOME, 'backups'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(env.AGENTRECEIPT_HOME, 'backups', backups[0]), 'utf8'), '{"model":"x"}');
  assert.deepEqual(fs.readdirSync(path.join(repo, '.claude')), ['settings.local.json'], 'no backup left in the project');
});
test('uninstall skips malformed file without touching it, exits non-zero, keeps runtime', () => {
  const repo = tmpRepo({ '.claude/settings.local.json': '{oops' });
  const home = tmp('h-'); const env = { ...process.env, AGENTRECEIPT_HOME: path.join(home, 'ar'), CODEX_HOME: path.join(home, 'codex') };
  fs.mkdirSync(path.join(home, 'ar', 'runtime'), { recursive: true });
  const r = run(['uninstall'], { cwd: repo, env });
  assert.equal(r.code, 1); assert.match(r.out, /skipped/);
  assert.equal(fs.readFileSync(path.join(repo, '.claude/settings.local.json'), 'utf8'), '{oops');
  assert.ok(fs.existsSync(path.join(home, 'ar', 'runtime')));
});

// 2. shell quoting
test('shim and hook command survive paths with spaces, $, $(...), backticks and quotes', () => {
  const base = tmp('q-');
  const weird = path.join(base, `dir with space $HOME $(touch PWNED) \`touch PWNED2\` it's "q"`);
  fs.mkdirSync(path.join(weird, 'bin'), { recursive: true });
  const target = path.join(weird, 'bin', 'agentreceipt.js');
  fs.writeFileSync(target, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const env = { AGENTRECEIPT_HOME: weird };
  const shim = inst.writeShim(target, env);
  const out = execFileSync('/bin/sh', [shim, 'claude'], { cwd: base }).toString();
  assert.deepEqual(JSON.parse(out), ['hook', '--agent', 'claude']);
  // the hook command line as the agent runs it (sh -c)
  const out2 = execFileSync('/bin/sh', ['-c', inst.hookCommand(shim, 'codex')], { cwd: base }).toString();
  assert.deepEqual(JSON.parse(out2), ['hook', '--agent', 'codex']);
  assert.equal(fs.existsSync(path.join(base, 'PWNED')) || fs.existsSync(path.join(base, 'PWNED2')), false);
  assert.ok(inst.isManaged({ type: 'command', command: inst.hookCommand(shim, 'codex'), statusMessage: inst.STATUS_MESSAGE }));
});

// 3. exact managed-hook matching
test('removeStopHook only removes our managed hook, not lookalikes', () => {
  const ours = { type: 'command', command: inst.hookCommand('/h/.agentreceipt/bin/agentreceipt-hook', 'codex'), statusMessage: inst.STATUS_MESSAGE };
  const lookalikes = [
    { type: 'command', command: 'echo agentreceipt diagnostics' },
    { type: 'command', command: inst.hookCommand('/h/.agentreceipt/bin/agentreceipt-hook', 'codex') }, // no statusMessage
    { type: 'command', command: 'my-agentreceipt-hook-wrapper codex && rm x', statusMessage: inst.STATUS_MESSAGE },
  ];
  const doc = inst.removeStopHook({ hooks: { Stop: [{ hooks: [ours, ...lookalikes] }] } });
  assert.deepEqual(doc.hooks.Stop[0].hooks, lookalikes);
});

// 5. config validation
test('invalid maxBlocks / timeout are rejected, not silently treated as red-allow', async () => {
  for (const [k, v] of [['maxBlocks', -1], ['maxBlocks', 'abc'], ['maxBlocks', 1.5], ['timeoutSec', 0], ['timeoutSec', 'abc']]) {
    const d = tmpRepo({});
    saveConfig(d, { testCommand: 'node -e "process.exit(1)"', [k]: v });
    assert.throws(() => loadConfig(d), new RegExp(k));
    const r = await handleStop({ cwd: d, session_id: 's' });
    assert.equal(r.receipt.status, 'error'); assert.equal(r.output.decision, undefined);
    assert.match(r.output.systemMessage, /agentreceipt ERROR/); assert.match(r.receipt.error, new RegExp(k));
  }
  const ok = tmpRepo({}); saveConfig(ok, { testCommand: 'node -e "process.exit(1)"', maxBlocks: 0 });
  assert.equal((await handleStop({ cwd: ok, session_id: 's' })).receipt.status, 'red', 'maxBlocks 0 is a valid, intentional setting');
});
test('init rejects bad --max-blocks / --timeout flags', () => {
  const repo = tmpRepo({ 'package.json': '{"scripts":{"test":"node -e 0"}}' });
  const env = { ...process.env, AGENTRECEIPT_HOME: tmp('h-'), CODEX_HOME: tmp('c-') };
  for (const a of [['--max-blocks', '-1'], ['--max-blocks', 'abc'], ['--timeout', '0'], ['--timeout', 'abc']]) {
    const r = run(['init', '--agent', 'codex', ...a], { cwd: repo, env });
    assert.equal(r.code, 1, a.join(' ')); assert.match(r.out, /invalid settings/);
  }
  assert.equal(fs.existsSync(path.join(env.CODEX_HOME, 'hooks.json')), false);
});

// 6. internal failures are visible
test('internal failures: error receipt + visible message, stop allowed', async () => {
  const bad = tmpRepo({}); fs.mkdirSync(path.join(bad, '.agentreceipt')); fs.writeFileSync(path.join(bad, '.agentreceipt/config.json'), '{nope');
  let r = await handleStop({ cwd: bad, session_id: 's' });
  assert.equal(r.receipt.status, 'error'); assert.match(r.output.systemMessage, /invalid JSON/); assert.ok(fs.existsSync(r.file));

  const nf = tmpRepo({}); saveConfig(nf, { testCommand: 'definitely-not-a-command-xyz' });
  r = await handleStop({ cwd: nf, session_id: 's' });
  assert.equal(r.receipt.status, 'error'); assert.equal(r.output.decision, undefined); assert.match(r.receipt.error, /not found/);

  const ro = tmpRepo({}); saveConfig(ro, { testCommand: 'node -e "process.exit(1)"' });
  fs.writeFileSync(path.join(ro, '.agentreceipt/receipts'), 'a file where the receipts dir should be');
  r = await handleStop({ cwd: ro, session_id: 's' });
  assert.equal(r.output.decision, undefined); assert.match(r.output.systemMessage, /agentreceipt ERROR/); assert.match(r.output.systemMessage, /no receipt could be written/);
});
test('hook process never prints bare {} on failure; stderr carries the warning', () => {
  const bad = tmpRepo({}); fs.mkdirSync(path.join(bad, '.agentreceipt')); fs.writeFileSync(path.join(bad, '.agentreceipt/config.json'), '{"testCommand":"x","maxBlocks":-1}');
  const res = require('child_process').spawnSync(process.execPath, [BIN, 'hook', '--agent', 'codex'], { input: JSON.stringify({ cwd: bad, session_id: 's' }) });
  const out = JSON.parse(res.stdout.toString().trim());
  assert.match(out.systemMessage, /agentreceipt ERROR/); assert.match(res.stderr.toString(), /agentreceipt ERROR/);
  const res2 = require('child_process').spawnSync(process.execPath, [BIN, 'hook'], { input: 'not json' });
  assert.match(JSON.parse(res2.stdout.toString().trim()).systemMessage, /invalid hook input JSON/);
});

// 7. session state
test('session ids are hashed: distinct ids never collide', () => {
  const d = tmpRepo({});
  setBlocks(d, 'a/b', 2);
  assert.equal(getBlocks(d, 'a?b'), 0); assert.equal(getBlocks(d, 'a_b'), 0); assert.equal(getBlocks(d, 'a/b'), 2);
});
test('concurrent Stop events for one session are serialized', async () => {
  const d = tmpRepo({}); saveConfig(d, { testCommand: 'node -e "setTimeout(()=>process.exit(1),150)"', maxBlocks: 3 });
  const rr = await Promise.all([1, 2, 3].map(() => handleStop({ cwd: d, session_id: 'same', stop_hook_active: true })));
  assert.deepEqual(rr.map((r) => r.receipt.blocks.count).sort(), [1, 2, 3]);
  assert.equal(getBlocks(d, 'same'), 3);
});
