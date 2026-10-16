'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_ROOT = path.resolve(__dirname, '..');
const VERSION = require('../package.json').version;
const STATUS_MESSAGE = 'agentreceipt: verifying tests';

// POSIX shell single-quoting: the only safe way to embed an arbitrary path in sh code.
function shQuote(v) { return `'${String(v).replace(/'/g, `'\\''`)}'`; }

function homeDir(env = process.env) { return env.AGENTRECEIPT_HOME || process.env.AGENTRECEIPT_HOME || path.join(os.homedir(), '.agentreceipt'); }

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
  fs.writeFileSync(p, `#!/bin/sh\n# agentreceipt hook shim (rewritten by \`agentreceipt init\`)\nexec ${shQuote(process.execPath)} ${shQuote(target)} hook --agent "\${1:-codex}"\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

// Fixed hook timeout (seconds) so the hook definition stays identical across repos/versions.
// The per-repo test timeout (config.timeoutSec) is enforced inside the hook.
const HOOK_TIMEOUT = 900;

function hookCommand(shim, agent) {
  return `${shQuote(shim)} ${agent}`;
}

// Missing/empty file -> {}. Anything else that isn't a JSON object -> throw, so we never overwrite a
// config we couldn't understand.
function readJsonStrict(p) {
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  if (!text.trim()) return {};
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw new Error(`${p} is not valid JSON (${e.message}). Fix or move it, then re-run; nothing was changed.`); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${p} is not a JSON object; nothing was changed.`);
  if (doc.hooks !== undefined && (typeof doc.hooks !== 'object' || Array.isArray(doc.hooks) || doc.hooks === null)) throw new Error(`${p}: "hooks" is not an object; nothing was changed.`);
  if (doc.hooks && doc.hooks.Stop !== undefined && !Array.isArray(doc.hooks.Stop)) throw new Error(`${p}: "hooks.Stop" is not an array; nothing was changed.`);
  return doc;
}

// Identify our own hook by exact structure: a command handler carrying our statusMessage whose command is
// exactly a shim invocation (current or older quoting) or a pre-0.1.0 runtime invocation.
const MANAGED_COMMANDS = [
  /^'(?:[^']|'\\'')*agentreceipt-hook' (codex|claude)$/,
  /^"[^"]*agentreceipt-hook" (codex|claude)$/,
  /^"[^"]*" "[^"]*\/\.agentreceipt\/runtime\/[^"/]+\/bin\/agentreceipt\.js" hook --agent (codex|claude)$/,
];
function isManaged(h) {
  return !!h && h.type === 'command' && h.statusMessage === STATUS_MESSAGE && typeof h.command === 'string' &&
    MANAGED_COMMANDS.some((re) => re.test(h.command));
}

// Add (or replace) our Stop hook in a hooks-style JSON doc. Same shape for Codex hooks.json and Claude settings.json.
function upsertStopHook(doc, command, timeoutSec) {
  doc.hooks = doc.hooks || {};
  const groups = (doc.hooks.Stop || []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isManaged(h)) }))
    .filter((g) => g.hooks.length);
  groups.push({ hooks: [{ type: 'command', command, timeout: timeoutSec, statusMessage: STATUS_MESSAGE }] });
  doc.hooks.Stop = groups;
  return doc;
}

function removeStopHook(doc) {
  if (!doc.hooks || !doc.hooks.Stop) return doc;
  doc.hooks.Stop = doc.hooks.Stop.map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isManaged(h)) })).filter((g) => g.hooks.length);
  if (!doc.hooks.Stop.length) delete doc.hooks.Stop;
  if (!Object.keys(doc.hooks).length) delete doc.hooks;
  return doc;
}

function codexHooksPath(env = process.env) { return path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json'); }
// scope: 'local' (default, .claude/settings.local.json: per-machine, not committed),
//        'user'  (~/.claude/settings.json),
//        'project' (.claude/settings.json: legacy, uninstall only; the hook has an absolute path
//                   that would break teammates if committed).
function claudeSettingsPath(root, scope = 'local', env = process.env) {
  if (scope === 'user') return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
  if (scope === 'project') return path.join(root, '.claude', 'settings.json');
  return path.join(root, '.claude', 'settings.local.json');
}

// Local git ignores live in .git/info/exclude (never committed, so the user's repo isn't changed),
// inside a marked block that uninstall removes without touching lines the user wrote themselves.
const BLOCK_START = '# >>> agentreceipt (managed; removed by `agentreceipt uninstall`)';
const BLOCK_END = '# <<< agentreceipt';

function excludePath(root) {
  const { execFileSync } = require('child_process');
  try {
    const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return path.join(gitDir, 'info', 'exclude');
  } catch { return null; }
}

// Split exclude file into [before, blockLines, after]; block absent => blockLines null.
function splitBlock(text) {
  const lines = text.split('\n');
  const i = lines.indexOf(BLOCK_START);
  const j = i >= 0 ? lines.indexOf(BLOCK_END, i + 1) : -1;
  if (i < 0 || j < 0) return [lines, null, []];
  return [lines.slice(0, i), lines.slice(i + 1, j), lines.slice(j + 1)];
}

function addExcludes(root, entries) {
  const ex = excludePath(root);
  if (!ex) return false;
  fs.mkdirSync(path.dirname(ex), { recursive: true });
  const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
  const [before, block, after] = splitBlock(cur);
  const merged = [...new Set([...(block || []), ...entries])];
  let head = before.join('\n');
  if (block === null) head = head.replace(/\n*$/, '');
  const parts = [head ? head + '\n' : '', [BLOCK_START, ...merged, BLOCK_END].join('\n') + '\n', after.join('\n').replace(/^\n+/, '')];
  fs.writeFileSync(ex, parts.join(''));
  return true;
}

function removeExcludes(root) {
  const ex = excludePath(root);
  if (!ex || !fs.existsSync(ex)) return false;
  const [before, block, after] = splitBlock(fs.readFileSync(ex, 'utf8'));
  if (block === null) return false;
  const out = [...before, ...after].join('\n').replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(ex, out.replace(/\n*$/, '\n') === '\n' ? '' : out.replace(/\n*$/, '\n'));
  return true;
}

const REPO_EXCLUDES = ['.agentreceipt/receipts/', '.agentreceipt/state/'];
const CLAUDE_LOCAL = '.claude/settings.local.json';

// Before changing an existing settings file, keep a copy outside the project (~/.agentreceipt/backups),
// then write atomically.
function backupFile(file, env = process.env) {
  if (!fs.existsSync(file)) return null;
  const dir = path.join(homeDir(env), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${path.resolve(file).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+/, '')}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  const dest = path.join(dir, name);
  fs.copyFileSync(file, dest);
  return dest;
}
function writeHooks(file, doc, env = process.env) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backupFile(file, env);
  const tmp = `${file}.agentreceipt-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function targetFile(agent, root, scope, env) { return agent === 'codex' ? codexHooksPath(env) : claudeSettingsPath(root, scope, env); }
// Validate every file init will touch before writing anything. Throws on the first problem.
function preflight(targets) { for (const t of targets) readJsonStrict(targetFile(t.agent, t.root, t.scope || 'local', t.env || process.env)); }

function install({ agent, root, binPath, scope = 'local', env = process.env }) {
  if (agent === 'claude' && scope === 'project') throw new Error('Refusing to write the hook to committed .claude/settings.json; use --claude-scope local or user');
  const file = targetFile(agent, root, scope, env);
  const doc = readJsonStrict(file); // throws before any write if the file is malformed
  if (agent === 'claude' && scope === 'local') addExcludes(root, [CLAUDE_LOCAL]);
  writeHooks(file, upsertStopHook(doc, hookCommand(binPath, agent), HOOK_TIMEOUT), env);
  return file;
}

function uninstall({ agent, root, scope = 'local', env = process.env }) {
  const file = targetFile(agent, root, scope, env);
  try { fs.unlinkSync(file + '.agentreceipt.bak'); } catch {} // left by versions <= 0.1.0
  if (!fs.existsSync(file)) return null;
  const original = readJsonStrict(file); // malformed -> throw, file left untouched
  const before = JSON.stringify(original);
  const doc = removeStopHook(JSON.parse(before));
  if (JSON.stringify(doc) === before) return null; // nothing of ours there; leave the file untouched
  if (!Object.keys(doc).length) {
    backupFile(file, env);
    fs.unlinkSync(file);
    // drop a project .claude/ dir we created and left empty
    if (agent === 'claude' && scope !== 'user') { try { fs.rmdirSync(path.dirname(file)); } catch {} }
  } else writeHooks(file, doc, env);
  return file;
}

function removeRuntime(env = process.env) {
  const home = homeDir(env);
  fs.rmSync(path.join(home, 'runtime'), { recursive: true, force: true });
  fs.rmSync(path.join(home, 'bin'), { recursive: true, force: true });
  try { if (fs.existsSync(home) && !fs.readdirSync(home).length) fs.rmdirSync(home); } catch {}
}

module.exports = { shQuote, readJsonStrict, isManaged, preflight, targetFile, backupFile, STATUS_MESSAGE, HOOK_TIMEOUT, shimPath, writeShim, removeRuntime, homeDir, VERSION, installRuntime, hookCommand, upsertStopHook, removeStopHook, install, uninstall, codexHooksPath, claudeSettingsPath, addExcludes, removeExcludes, REPO_EXCLUDES, BLOCK_START, BLOCK_END };
