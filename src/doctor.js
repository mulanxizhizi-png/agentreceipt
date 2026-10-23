'use strict';
// agentreceipt doctor: static install/hook checks + optional harmless --canary.
// Does not change Stop-hook behavior. Tool-call false-success is out of v1 (→ v1.1).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { findRoot, loadConfig, ConfigError, DIR, configPath } = require('./config');
const inst = require('./install');

// Claude Code / Codex skill descriptions that are very long often get truncated or
// deprioritized in the agent's skill picker. Warn, don't fail.
const SKILL_DESC_WARN = 500;

const NOTE_P001 =
  'Note: test failures are already blocked by the Stop hook; tool-call false-success is not in v1 (planned for v1.1).';

function issue(level, code, message, extra = {}) {
  return { level, code, message, ...extra };
}

function hasBom(buf) {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

function readRaw(file) {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// Parse a hooks-style JSON file for doctor: BOM / invalid JSON / wrong hooks.Stop shape → issues.
// Returns { doc, issues } (doc may be null).
function inspectHooksFile(file, label) {
  const issues = [];
  const buf = readRaw(file);
  if (buf === null) return { doc: null, issues, missing: true };
  if (hasBom(buf)) {
    issues.push(issue('error', 'bom', `${label}: UTF-8 BOM at start of ${file} (agents often fail to parse this)`));
  }
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  if (!text.trim()) return { doc: {}, issues, missing: false };
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    issues.push(issue('error', 'json', `${label}: not valid JSON (${e.message})`));
    return { doc: null, issues, missing: false };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    issues.push(issue('error', 'json-shape', `${label}: root is not a JSON object`));
    return { doc: null, issues, missing: false };
  }
  if (doc.hooks !== undefined) {
    if (typeof doc.hooks !== 'object' || doc.hooks === null || Array.isArray(doc.hooks)) {
      issues.push(issue('error', 'hooks-shape', `${label}: "hooks" is not an object`));
    } else if (doc.hooks.Stop !== undefined && !Array.isArray(doc.hooks.Stop)) {
      issues.push(issue('error', 'stop-shape', `${label}: "hooks.Stop" is not an array`));
    }
  }
  return { doc, issues, missing: false };
}

function collectManaged(doc) {
  if (!doc || !doc.hooks || !Array.isArray(doc.hooks.Stop)) return [];
  const out = [];
  for (const g of doc.hooks.Stop) {
    if (!g || typeof g !== 'object') continue;
    for (const h of g.hooks || []) {
      if (inst.isManaged(h)) out.push(h);
    }
  }
  return out;
}

// Extract the executable path from a managed hook command (shim or legacy runtime).
function commandBinary(cmd) {
  if (typeof cmd !== 'string') return null;
  // single-quoted shim: '/path/agentreceipt-hook' agent
  let m = cmd.match(/^'((?:[^']|'\\'')+)'\s+(codex|claude)$/);
  if (m) return m[1].replace(/'\\''/g, "'");
  // double-quoted shim
  m = cmd.match(/^"([^"]+)"\s+(codex|claude)$/);
  if (m) return m[1];
  // legacy: "node" "/…/.agentreceipt/runtime/…/bin/agentreceipt.js" hook --agent X
  m = cmd.match(/^"[^"]+"\s+"([^"]+\/\.agentreceipt\/runtime\/[^"]+\/bin\/agentreceipt\.js)"\s+hook\s+--agent\s+(codex|claude)$/);
  if (m) return m[1];
  return null;
}

function checkManagedCommands(managed, label, env, issues) {
  const shim = inst.shimPath(env);
  for (const h of managed) {
    const bin = commandBinary(h.command);
    if (!bin) {
      issues.push(issue('error', 'command-parse', `${label}: managed hook command could not be parsed: ${h.command}`));
      continue;
    }
    if (!fs.existsSync(bin)) {
      issues.push(issue('error', 'command-missing', `${label}: hook command path does not exist: ${bin}`));
    } else if (path.resolve(bin) !== path.resolve(shim) && !bin.includes(`${path.sep}.agentreceipt${path.sep}runtime${path.sep}`)) {
      // Pointing at something that isn't the current shim or a runtime copy — still warn.
      issues.push(issue('warn', 'command-unexpected', `${label}: managed hook command path is not the current shim (${shim}): ${bin}`));
    }
  }
}

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  const block = text.slice(3, end).replace(/^\r?\n/, '');
  const meta = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[m[1]] = v;
  }
  return meta;
}

function skillDirs(root, env) {
  const home = env.HOME || os.homedir();
  const claudeCfg = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  return [
    path.join(root, '.claude', 'skills'),
    path.join(root, '.agents', 'skills'),
    path.join(claudeCfg, 'skills'),
    path.join(codexHome, 'skills'),
  ];
}

function walkSkills(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkSkills(p, out);
    else if (e.isFile() && (e.name === 'SKILL.md' || e.name === 'skill.md')) out.push(p);
  }
  return out;
}

function checkSkills(root, env, issues) {
  for (const dir of skillDirs(root, env)) {
    for (const file of walkSkills(dir)) {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const meta = parseFrontmatter(text);
      if (!meta || meta.description == null) continue;
      const desc = String(meta.description);
      if (desc.length > SKILL_DESC_WARN) {
        issues.push(issue('warn', 'skill-desc-long',
          `skill description is ${desc.length} chars (warn > ${SKILL_DESC_WARN}); agents may truncate or deprioritize it: ${file}`));
      }
    }
  }
}

function checkProjectConfig(root, issues) {
  const p = configPath(root);
  if (!fs.existsSync(p)) {
    issues.push(issue('error', 'no-config', `no ${DIR}/config.json in ${root} (run \`agentreceipt init\` first)`));
    return null;
  }
  try {
    return loadConfig(root);
  } catch (e) {
    issues.push(issue('error', 'config', e instanceof ConfigError ? e.message : String(e.message || e)));
    return null;
  }
}

function staticChecks({ root, env = process.env } = {}) {
  const issues = [];
  const cfg = checkProjectConfig(root, issues);

  // Runtime / shim
  const shim = inst.shimPath(env);
  if (!fs.existsSync(shim)) {
    issues.push(issue('error', 'shim-missing', `hook shim missing: ${shim} (re-run \`agentreceipt init\`)`));
  }

  // Codex hooks.json
  const codexFile = inst.codexHooksPath(env);
  const codex = inspectHooksFile(codexFile, 'Codex hooks.json');
  issues.push(...codex.issues);
  const codexManaged = collectManaged(codex.doc);
  if (!codex.missing && codex.doc) checkManagedCommands(codexManaged, 'Codex hooks.json', env, issues);

  // Claude: local + user (+ legacy project if present)
  const claudeTargets = [
    { scope: 'local', file: inst.claudeSettingsPath(root, 'local', env), label: 'Claude settings.local.json' },
    { scope: 'user', file: inst.claudeSettingsPath(root, 'user', env), label: 'Claude user settings.json' },
  ];
  const projectFile = inst.claudeSettingsPath(root, 'project', env);
  if (fs.existsSync(projectFile)) claudeTargets.push({ scope: 'project', file: projectFile, label: 'Claude settings.json (project)' });

  let claudeManagedTotal = 0;
  for (const t of claudeTargets) {
    const r = inspectHooksFile(t.file, t.label);
    issues.push(...r.issues);
    const managed = collectManaged(r.doc);
    claudeManagedTotal += managed.length;
    if (!r.missing && r.doc) checkManagedCommands(managed, t.label, env, issues);
  }

  if (cfg) {
    // Project is initialized: at least one agent should have a managed Stop hook.
    if (codexManaged.length === 0 && claudeManagedTotal === 0) {
      issues.push(issue('error', 'no-managed-hook',
        'no managed agentreceipt Stop hook found in Codex hooks.json or Claude settings (local/user). Re-run `agentreceipt init`.'));
    } else {
      if (codexManaged.length === 0 && !codex.missing) {
        issues.push(issue('warn', 'no-codex-hook', `Codex hooks.json has no managed agentreceipt Stop hook (${codexFile})`));
      }
      if (codex.missing) {
        issues.push(issue('warn', 'no-codex-file', `Codex hooks.json not found (${codexFile}); Codex Stop hook is not installed`));
      }
      if (claudeManagedTotal === 0) {
        issues.push(issue('warn', 'no-claude-hook', 'no managed agentreceipt Stop hook in Claude settings (local/user)'));
      }
    }
  }

  checkSkills(root, env, issues);
  return { issues, cfg, codexManaged: codexManaged.length, claudeManaged: claudeManagedTotal };
}

// Harmless canary: temp repo + config, invoke the shim Stop hook once, do not touch the user repo.
function runCanary({ env = process.env, agent = 'codex' } = {}) {
  const shim = inst.shimPath(env);
  if (!fs.existsSync(shim)) {
    return { triggered: false, detail: `shim missing: ${shim}` };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-doctor-canary-'));
  try {
    // Minimal git repo so findRoot / diff work.
    spawnSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init', '--allow-empty'], { cwd: dir, stdio: 'ignore' });
    fs.mkdirSync(path.join(dir, DIR), { recursive: true });
    fs.writeFileSync(path.join(dir, DIR, 'config.json'), JSON.stringify({
      version: 1, testCommand: 'node -e "process.exit(0)"', timeoutSec: 30, maxBlocks: 1,
    }, null, 2) + '\n');
    const event = JSON.stringify({
      cwd: dir,
      session_id: 'doctor-canary',
      turn_id: '1',
      stop_hook_active: false,
      last_assistant_message: 'doctor canary',
    });
    const res = spawnSync(shim, [agent], {
      cwd: dir,
      env: { ...process.env, ...env },
      input: event,
      encoding: 'utf8',
      timeout: 60000,
    });
    const stdout = (res.stdout || '').trim();
    const stderr = (res.stderr || '').trim();
    const receiptsDir = path.join(dir, DIR, 'receipts');
    const wroteReceipt = fs.existsSync(receiptsDir) && fs.readdirSync(receiptsDir).some((f) => f.endsWith('.json'));
    let parsed = null;
    try { parsed = stdout ? JSON.parse(stdout) : null; } catch {}
    const triggered = wroteReceipt || !!(parsed && (parsed.systemMessage || parsed.decision || parsed.reason)) || /agentreceipt/i.test(stderr);
    return {
      triggered,
      detail: triggered
        ? `Stop hook ran in temp dir (${wroteReceipt ? 'receipt written' : 'hook output seen'})`
        : `Stop hook did not produce a receipt or hook output (exit ${res.status}, signal ${res.signal})`,
      exitCode: res.status,
      stdoutHead: stdout.slice(0, 200),
      stderrHead: stderr.slice(0, 200),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function formatReport({ issues, canary, version }) {
  const errors = issues.filter((i) => i.level === 'error');
  const warns = issues.filter((i) => i.level === 'warn');
  const lines = [];
  lines.push(`agentreceipt doctor ${version || inst.VERSION}`);
  if (!errors.length && !warns.length) lines.push('OK: static checks passed.');
  for (const i of errors) lines.push(`ERROR [${i.code}] ${i.message}`);
  for (const i of warns) lines.push(`WARN  [${i.code}] ${i.message}`);
  if (canary) {
    lines.push(canary.triggered
      ? `CANARY: triggered — ${canary.detail}`
      : `CANARY: not triggered — ${canary.detail}`);
  }
  lines.push(NOTE_P001);
  return lines.join('\n');
}

function exitCode(issues, { strict = false, canary = null } = {}) {
  const errors = issues.filter((i) => i.level === 'error');
  const warns = issues.filter((i) => i.level === 'warn');
  if (errors.length) return 1;
  if (canary && canary.triggered === false) return 1;
  if (strict && warns.length) return 1;
  return 0;
}

function doctor(args = [], opts = {}) {
  const env = opts.env || process.env;
  const cwd = opts.cwd || process.cwd();
  const root = opts.root || findRoot(cwd);
  const canaryFlag = args.includes('--canary');
  const strict = args.includes('--strict');
  const { issues } = staticChecks({ root, env });
  let canary = null;
  if (canaryFlag) canary = runCanary({ env });
  const text = formatReport({ issues, canary, version: inst.VERSION });
  const code = exitCode(issues, { strict, canary });
  return { issues, canary, text, code, root };
}

module.exports = {
  doctor, staticChecks, runCanary, formatReport, exitCode, inspectHooksFile,
  collectManaged, commandBinary, checkSkills, SKILL_DESC_WARN, NOTE_P001, hasBom,
};
