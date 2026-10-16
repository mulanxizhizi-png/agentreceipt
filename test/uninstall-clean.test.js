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
  assert.equal(inst.cleanProjectData(d), true);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(inst.cleanProjectData(d), false);
});

test('uninstall --global cleans every registered project', () => {
  const env = mkenv(); const A = tmpRepo(PKG); const B = tmpRepo(PKG);
  assert.equal(cli(['init'], A, env).status, 0); assert.equal(cli(['init'], B, env).status, 0);
  stop(env, A); stop(env, B);
  assert.equal(cli(['uninstall', '--global'], A, env).status, 0);
  for (const p of [A, B]) {
    assert.deepEqual(fs.readdirSync(path.join(p, '.agentreceipt')), ['config.json']);
    assert.deepEqual(status(p).filter((l) => l.includes('.agentreceipt') || l.includes('.claude')).map((l) => l.slice(3)), ['.agentreceipt/config.json']);
  }
});
