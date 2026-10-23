'use strict';
const test = require('node:test'); const assert = require('node:assert');
require('./helpers');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process');
const inst = require('../src/install');
const { saveConfig } = require('../src/config');
const {
  doctor, staticChecks, runCanary, inspectHooksFile, hasBom, SKILL_DESC_WARN, NOTE_P001,
} = require('../src/doctor');
const { tmpRepo } = require('./helpers');

function envHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ard-home-'));
  return {
    home,
    env: {
      ...process.env,
      HOME: home,
      AGENTRECEIPT_HOME: path.join(home, '.agentreceipt'),
      CODEX_HOME: path.join(home, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    },
  };
}

function initProject({ agent = 'all' } = {}) {
  const { home, env } = envHome();
  const root = tmpRepo({ 'package.json': '{"scripts":{"test":"node -e \\"process.exit(0)\\""}}' });
  const bin = path.join(__dirname, '..', 'bin', 'agentreceipt.js');
  const agents = agent === 'all' ? ['codex', 'claude'] : [agent];
  execFileSync(process.execPath, [bin, 'init', '--agent', agents.join(','), '--test', 'node -e "process.exit(0)"'], {
    cwd: root, env, stdio: 'ignore',
  });
  return { root, env, home, bin };
}

test('doctor: healthy init is green (exit 0) and prints P001 note', () => {
  const { root, env, bin } = initProject();
  const out = execFileSync(process.execPath, [bin, 'doctor'], { cwd: root, env, encoding: 'utf8' });
  assert.match(out, /OK: static checks passed/);
  assert.match(out, /test failures are already blocked by the Stop hook/);
  assert.match(out, /false-success is not in v1/);
  assert.ok(out.includes(NOTE_P001.split(':')[0])); // same note family
});

test('doctor: broken hook path → error, exit 1', () => {
  const { root, env } = initProject({ agent: 'codex' });
  const hooks = inst.codexHooksPath(env);
  const doc = JSON.parse(fs.readFileSync(hooks, 'utf8'));
  const h = doc.hooks.Stop[0].hooks[0];
  h.command = "'/no/such/agentreceipt-hook' codex";
  fs.writeFileSync(hooks, JSON.stringify(doc, null, 2) + '\n');
  const r = doctor([], { root, env });
  assert.equal(r.code, 1);
  assert.ok(r.issues.some((i) => i.level === 'error' && i.code === 'command-missing'));
  assert.match(r.text, /ERROR \[command-missing\]/);
});

test('doctor: UTF-8 BOM on hooks.json → error', () => {
  const { root, env } = initProject({ agent: 'codex' });
  const hooks = inst.codexHooksPath(env);
  const body = fs.readFileSync(hooks);
  assert.equal(hasBom(body), false);
  fs.writeFileSync(hooks, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]));
  const r = doctor([], { root, env });
  assert.equal(r.code, 1);
  assert.ok(r.issues.some((i) => i.code === 'bom' && i.level === 'error'));
});

test('doctor: hooks.Stop wrong shape → error', () => {
  const { env } = envHome();
  const f = path.join(env.CODEX_HOME, 'hooks.json');
  fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ hooks: { Stop: { not: 'array' } } }));
  const { issues } = inspectHooksFile(f, 'Codex hooks.json');
  assert.ok(issues.some((i) => i.code === 'stop-shape'));
});

test('doctor: long skill description → warn; --strict makes exit 1', () => {
  const { root, env } = initProject({ agent: 'claude' });
  const skillDir = path.join(root, '.claude', 'skills', 'longone');
  fs.mkdirSync(skillDir, { recursive: true });
  const desc = 'x'.repeat(SKILL_DESC_WARN + 10);
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: longone\ndescription: ${desc}\n---\n\n# hi\n`);
  const r = doctor([], { root, env });
  assert.equal(r.code, 0, 'warn alone is exit 0');
  assert.ok(r.issues.some((i) => i.code === 'skill-desc-long' && i.level === 'warn'));
  const strict = doctor(['--strict'], { root, env });
  assert.equal(strict.code, 1);
});

test('doctor: no config → error', () => {
  const { env } = envHome();
  const root = tmpRepo({});
  const r = doctor([], { root, env });
  assert.equal(r.code, 1);
  assert.ok(r.issues.some((i) => i.code === 'no-config'));
});

test('doctor --canary: triggers in temp dir without touching project', () => {
  const { root, env } = initProject({ agent: 'codex' });
  const before = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  const r = doctor(['--canary'], { root, env });
  assert.equal(r.canary.triggered, true, r.canary && r.canary.detail);
  assert.match(r.text, /CANARY: triggered/);
  const after = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  assert.equal(after, before, 'canary must not dirty the user repo');
});

test('doctor --canary: missing shim → not triggered, exit 1', () => {
  const { root, env } = initProject({ agent: 'codex' });
  fs.rmSync(path.join(env.AGENTRECEIPT_HOME, 'bin'), { recursive: true, force: true });
  const r = doctor(['--canary'], { root, env });
  // static already errors on shim-missing; canary also reports not triggered
  assert.equal(r.code, 1);
  assert.equal(r.canary.triggered, false);
  assert.match(r.text, /CANARY: not triggered/);
});

test('runCanary alone reports triggered after initRuntime', () => {
  const { env } = envHome();
  inst.installRuntime(env);
  const c = runCanary({ env, agent: 'codex' });
  assert.equal(c.triggered, true, c.detail);
});
