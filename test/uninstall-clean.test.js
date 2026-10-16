'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { tmpRepo } = require('./helpers');
const inst = require('../src/install');
const BIN = path.join(__dirname, '..', 'bin', 'agentreceipt.js');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const cli = (args, cwd, env) => spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
const status = (cwd) => execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd }).toString().split('\n').filter(Boolean);
const mkenv = () => { const h = tmp('h-'); return { ...process.env, AGENTRECEIPT_HOME: path.join(h, 'ar'), CODEX_HOME: path.join(h, 'codex'), CLAUDE_CONFIG_DIR: path.join(h, 'claude') }; };
function stop(shimEnv, root) {
  const shim = path.join(shimEnv.AGENTRECEIPT_HOME, 'bin', 'agentreceipt-hook');
  spawnSync('/bin/sh', [shim, 'claude'], { input: JSON.stringify({ cwd: root, session_id: 's' }), encoding: 'utf8', env: shimEnv });
}
const PKG = { 'package.json': '{"scripts":{"test":"node -e 0"}}' };

test('uninstall removes receipts/state/logs, keeps config.json, git status only shows config.json', () => {
  const env = mkenv(); const d = tmpRepo(PKG);
  assert.equal(cli(['init'], d, env).status, 0);
  stop(env, d);
  const dir = path.join(d, '.agentreceipt');
  assert.ok(fs.readdirSync(path.join(dir, 'receipts')).length > 0, 'receipt produced');
  fs.mkdirSync(path.join(dir, 'logs')); fs.writeFileSync(path.join(dir, 'logs', 'x.log'), 'x');
  assert.equal(cli(['uninstall'], d, env).status, 0);
  assert.deepEqual(fs.readdirSync(dir), ['config.json']);
  const own = status(d).filter((l) => l.includes('.agentreceipt'));
  assert.deepEqual(own.map((l) => l.slice(3)), ['.agentreceipt/config.json']);
});

test('cleanProjectData removes the dir when config.json is absent', () => {
  const d = tmpRepo(PKG); const dir = path.join(d, '.agentreceipt');
  fs.mkdirSync(path.join(dir, 'receipts'), { recursive: true }); fs.writeFileSync(path.join(dir, 'receipts', 'a.json'), '{}');
  fs.mkdirSync(path.join(dir, 'state')); fs.writeFileSync(path.join(dir, 'state', 'last.json'), '{}');
  assert.deepEqual(inst.cleanProjectData(d).deleted, ['.agentreceipt/receipts/', '.agentreceipt/state/']);
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(inst.cleanProjectData(d), { deleted: [], kept: [] });
});

const ls = (p) => fs.readdirSync(path.join(p, '.agentreceipt')).sort();
const own = (p) => status(p).filter((l) => l.includes('.agentreceipt') || l.includes('.claude')).map((l) => l.slice(3));
function twoProjects() {
  const env = mkenv(); const A = tmpRepo(PKG); const B = tmpRepo(PKG);
  assert.equal(cli(['init'], A, env).status, 0); assert.equal(cli(['init'], B, env).status, 0);
  stop(env, A); stop(env, B);
  return { env, A, B };
}

test('uninstall --global: current project fully cleaned, other projects keep receipts (still ignored)', () => {
  const { env, A, B } = twoProjects();
  const r = cli(['uninstall', '--global'], A, env);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ls(A), ['config.json']);
  assert.deepEqual(own(A), ['.agentreceipt/config.json']);
  assert.deepEqual(ls(B), ['config.json', 'receipts']);
  assert.ok(fs.readdirSync(path.join(B, '.agentreceipt', 'receipts')).length > 0);
  assert.equal(fs.existsSync(path.join(B, '.claude', 'settings.local.json')), false, 'B hook removed');
  assert.deepEqual(own(B), ['.agentreceipt/config.json'], 'receipts stay ignored in B');
  const ex = fs.readFileSync(inst.excludePath(B), 'utf8');
  assert.match(ex, /\.agentreceipt\/receipts\//); assert.doesNotMatch(ex, /state\//);
  // per-project report
  assert.match(r.stdout, new RegExp(`${B.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\n  deleted: .*state.*\\n  kept: .*receipts`));
  assert.match(r.stdout, /global:\n  deleted: .*runtime/);
});

test('uninstall --purge refuses without a TTY or --yes, changes nothing', () => {
  const { env, A, B } = twoProjects();
  const r = cli(['uninstall', '--purge'], A, env);
  assert.equal(r.status, 1); assert.match(r.stderr, /Refusing.*--yes/s); assert.ok(r.stderr.includes(B));
  assert.ok(ls(A).includes('receipts')); assert.ok(ls(B).includes('receipts'));
  assert.ok(fs.existsSync(path.join(env.AGENTRECEIPT_HOME, 'bin', 'agentreceipt-hook')));
});

test('uninstall --purge --yes deletes receipts everywhere', () => {
  const { env, A, B } = twoProjects();
  const r = cli(['uninstall', '--purge', '--yes'], A, env);
  assert.equal(r.status, 0, r.stderr);
  for (const p of [A, B]) { assert.deepEqual(ls(p), ['config.json']); assert.deepEqual(own(p), ['.agentreceipt/config.json']); }
  assert.equal(fs.existsSync(path.join(env.AGENTRECEIPT_HOME, 'bin')), false);
});

// ---- regression: deploy retest of 22c2c9e ----
const PTY = path.join(__dirname, 'fixtures', 'pty-answer.py');
function ptyRun(args, cwd, env, answer) {
  return spawnSync('python3', [PTY, answer, process.execPath, BIN, ...args], { cwd, env, encoding: 'utf8', timeout: 20000 });
}
function abc() {
  const env = mkenv(); const [A, B, C] = [tmpRepo(PKG), tmpRepo(PKG), tmpRepo(PKG)];
  for (const p of [A, B, C]) { assert.equal(cli(['init'], p, env).status, 0); stop(env, p); }
  assert.equal(cli(['uninstall', '--global'], A, env).status, 0);
  assert.equal(cli(['init'], C, env).status, 0); stop(env, C);
  return { env, A, B, C };
}
const has = (p, n) => fs.existsSync(path.join(p, '.agentreceipt', n));

test('A/B/C repro: --purge without TTY and without --yes refuses (even as the only registered project)', () => {
  const { env, B, C } = abc();
  const r = spawnSync(process.execPath, [BIN, 'uninstall', '--purge'], { cwd: C, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /Refusing/);
  assert.ok(r.stderr.includes(B), 'receipts-only project B is listed');
  assert.ok(has(C, 'receipts') && has(C, 'state') && has(B, 'receipts'));
  assert.ok(fs.existsSync(path.join(C, '.claude', 'settings.local.json')), 'C hook untouched');
});

test('A/B/C repro: --global keeps B as receipts-only; --purge --yes deletes B and C receipts', () => {
  const { env, A, B, C } = abc();
  assert.deepEqual(inst.readReceiptsOnly(env), [B].sort());
  const r = cli(['uninstall', '--purge', '--yes'], C, env);
  assert.equal(r.status, 0, r.stderr);
  for (const p of [A, B, C]) assert.equal(has(p, 'receipts'), false, p);
  assert.deepEqual(own(B), ['.agentreceipt/config.json']);
  assert.deepEqual(inst.readReceiptsOnly(env), []);
});

test('A/B/C repro: real pseudo-terminal, answer n -> nothing changed; answer y -> purged', () => {
  const { env, B, C } = abc();
  let r = ptyRun(['uninstall', '--purge'], C, env, 'n');
  assert.match(r.stdout, /will delete/); assert.ok(r.stdout.includes(B)); assert.match(r.stdout, /Proceed\? \[y\/N\]/);
  assert.match(r.stdout, /Aborted; nothing changed/); assert.match(r.stdout, /EXIT 1/);
  assert.ok(has(C, 'receipts') && has(B, 'receipts'));
  assert.ok(fs.existsSync(path.join(C, '.claude', 'settings.local.json')));
  r = ptyRun(['uninstall', '--purge'], C, env, 'y');
  assert.match(r.stdout, /EXIT 0/, r.stdout);
  assert.equal(has(C, 'receipts'), false); assert.equal(has(B, 'receipts'), false);
});
