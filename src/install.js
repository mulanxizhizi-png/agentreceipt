'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_ROOT = path.resolve(__dirname, '..');
const VERSION = require('../package.json').version;
const MARK = 'agentreceipt';

function homeDir(env = process.env) { return env.AGENTRECEIPT_HOME || path.join(os.homedir(), '.agentreceipt'); }

// npx caches are temporary, so copy the runtime to a stable place the hooks can point to.
function installRuntime(env = process.env) {
  const dest = path.join(homeDir(env), 'runtime', VERSION);
  for (const d of ['bin', 'src']) {
    fs.mkdirSync(path.join(dest, d), { recursive: true });
    for (const f of fs.readdirSync(path.join(PKG_ROOT, d))) fs.copyFileSync(path.join(PKG_ROOT, d, f), path.join(dest, d, f));
  }
  fs.copyFileSync(path.join(PKG_ROOT, 'package.json'), path.join(dest, 'package.json'));
  // drop older runtimes; the shim only ever points at the current one
  for (const v of fs.readdirSync(path.join(homeDir(env), 'runtime'))) {
    if (v !== VERSION) fs.rmSync(path.join(homeDir(env), 'runtime', v), { recursive: true, force: true });
  }
  return writeShim(path.join(dest, 'bin', 'agentreceipt.js'), env);
}

// Stable entry point. The hook command in agent configs always points here, so its text
// (which Codex hashes for trust) never changes across agentreceipt versions; only the shim's
// target is rewritten on init/upgrade.
function shimPath(env = process.env) { return path.join(homeDir(env), 'bin', 'agentreceipt-hook'); }
function writeShim(target, env = process.env) {
  const p = shimPath(env);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `#!/bin/sh\n# agentreceipt hook shim (rewritten by \`agentreceipt init\`)\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(target)} hook --agent "\${1:-codex}"\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

// Fixed hook timeout (seconds) so the hook definition stays identical across repos/versions.
// The per-repo test timeout (config.timeoutSec) is enforced inside the hook.
const HOOK_TIMEOUT = 900;

function hookCommand(shim, agent) {
  return `${JSON.stringify(shim)} ${agent}`;
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } }

// Add (or replace) our Stop hook in a hooks-style JSON doc. Same shape for Codex hooks.json and Claude settings.json.
function upsertStopHook(doc, command, timeoutSec) {
  doc.hooks = doc.hooks || {};
  const groups = (doc.hooks.Stop || []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !String(h.command || '').includes(MARK)) }))
    .filter((g) => g.hooks.length);
  groups.push({ hooks: [{ type: 'command', command, timeout: timeoutSec, statusMessage: 'agentreceipt: verifying tests' }] });
  doc.hooks.Stop = groups;
  return doc;
}

function removeStopHook(doc) {
  if (!doc.hooks || !doc.hooks.Stop) return doc;
  doc.hooks.Stop = doc.hooks.Stop.map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !String(h.command || '').includes(MARK)) })).filter((g) => g.hooks.length);
  if (!doc.hooks.Stop.length) delete doc.hooks.Stop;
  if (!Object.keys(doc.hooks).length) delete doc.hooks;
  return doc;
}

function codexHooksPath(env = process.env) { return path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json'); }
function claudeSettingsPath(root, scope = 'project', env = process.env) {
  if (scope === 'user') return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
  return path.join(root, '.claude', 'settings.json');
}

function writeHooks(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && !fs.existsSync(file + '.agentreceipt.bak')) fs.copyFileSync(file, file + '.agentreceipt.bak');
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
}

function install({ agent, root, binPath, scope = 'project', env = process.env }) {
  const file = agent === 'codex' ? codexHooksPath(env) : claudeSettingsPath(root, scope, env);
  writeHooks(file, upsertStopHook(readJson(file), hookCommand(binPath, agent), HOOK_TIMEOUT));
  return file;
}

function uninstall({ agent, root, scope = 'project', env = process.env }) {
  const file = agent === 'codex' ? codexHooksPath(env) : claudeSettingsPath(root, scope, env);
  if (!fs.existsSync(file)) return null;
  const before = JSON.stringify(readJson(file));
  const doc = removeStopHook(readJson(file));
  if (JSON.stringify(doc) === before) return null; // nothing of ours there; leave the file untouched
  if (!Object.keys(doc).length) fs.unlinkSync(file); else fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  return file;
}

function removeRuntime(env = process.env) {
  const home = homeDir(env);
  fs.rmSync(path.join(home, 'runtime'), { recursive: true, force: true });
  fs.rmSync(path.join(home, 'bin'), { recursive: true, force: true });
  try { if (fs.existsSync(home) && !fs.readdirSync(home).length) fs.rmdirSync(home); } catch {}
}

module.exports = { HOOK_TIMEOUT, shimPath, writeShim, removeRuntime, homeDir, VERSION, installRuntime, hookCommand, upsertStopHook, removeStopHook, install, uninstall, codexHooksPath, claudeSettingsPath };
