#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { findRoot, loadConfig, saveConfig, validateConfig, parseNum, DEFAULTS, DIR } = require('../src/config');
const { detectTestCommand } = require('../src/detect');
const { hookMain } = require('../src/hook');
const inst = require('../src/install');
const { formatReceipt } = require('../src/receipt');

function flag(args, name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
}

function ask(q) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

async function init(args) {
  const root = findRoot(process.cwd());
  let existing = {};
  try { existing = loadConfig(root) || {}; } catch (e) {
    if (!flag(args, '--test') && !flag(args, '--max-blocks') && !flag(args, '--timeout')) { console.error(`agentreceipt: ${e.message}`); process.exit(1); }
    try { existing = JSON.parse(fs.readFileSync(path.join(root, DIR, 'config.json'), 'utf8')); } catch { existing = {}; }
  }
  let testCommand = flag(args, '--test', existing.testCommand);
  if (!testCommand) {
    const d = detectTestCommand(root);
    if (d) { testCommand = d.command; console.log(`Detected test command: ${d.command}  (from ${d.source})`); }
    else testCommand = await ask('Could not detect a test command. What runs your tests? ');
  }
  if (!testCommand) { console.error('No test command. Re-run with: agentreceipt init --test "<command>"'); process.exit(1); }
  const cfg = {
    ...DEFAULTS, ...existing, testCommand,
    timeoutSec: parseNum(flag(args, '--timeout', existing.timeoutSec ?? DEFAULTS.timeoutSec)),
    maxBlocks: parseNum(flag(args, '--max-blocks', existing.maxBlocks ?? DEFAULTS.maxBlocks)),
  };
  const errs = validateConfig(cfg);
  if (errs.length) { console.error(`agentreceipt: invalid settings: ${errs.join('; ')}`); process.exit(1); }
  saveConfig(root, cfg);
  // keep receipts/state out of git by default; config stays committable
  // .agentreceipt/.gitignore travels with a committed config.json (teammates' receipts stay ignored);
  // .git/info/exclude keeps `git status` clean right away for this clone.
  fs.writeFileSync(path.join(root, DIR, '.gitignore'), 'receipts/\nstate/\n');
  inst.addExcludes(root, inst.REPO_EXCLUDES);
  // baseline for the first receipt's diff (keeps the agent's commits visible) and config-change warnings
  require('../src/state').setLast(root, { sha: require('../src/git').headSha(root), configFingerprint: require('../src/config').configFingerprint(root), testCommand: cfg.testCommand, source: 'init' });

  const agentArg = flag(args, '--agent', 'all');
  const agents = agentArg === 'all' ? ['codex', 'claude'] : agentArg.split(',');
  const claudeScope = flag(args, '--claude-scope', 'local');
  try { inst.preflight(agents.map((agent) => ({ agent, root, scope: claudeScope }))); }
  catch (e) { console.error(`agentreceipt: ${e.message}`); process.exit(1); }
  const binPath = inst.installRuntime();
  console.log(`Config: ${path.join(root, DIR, 'config.json')}`);
  inst.registerProject(root);
  for (const a of agents) console.log(`Stop hook (${a}): ${inst.install({ agent: a, root, binPath, scope: claudeScope })}`);
  if (agents.includes('codex')) console.log('Codex: open /hooks once in Codex to review and trust the agentreceipt hook.');
  console.log('Done. Your agent now has to show a receipt before it can say "done".');
}

function last() {
  const dir = path.join(findRoot(process.cwd()), DIR, 'receipts');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  if (!files.length) { console.log('No receipts yet.'); return; }
  console.log(formatReceipt(JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8')), { color: process.stdout.isTTY }));
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'init': return init(args);
    case 'hook': return hookMain(flag(args, '--agent', 'codex'));
    case 'last': return last();
    case 'uninstall': {
      // Default: this project only. Global pieces (Codex hooks.json, ~/.claude/settings.json hook, runtime)
      // are removed with --global, or automatically when no other registered project still uses them.
      const root = findRoot(process.cwd());
      let failed = false;
      const tryUninstall = (a, scope) => {
        try { const f = inst.uninstall({ agent: a, root, scope }); if (f) console.log(`Removed hook from ${f}`); }
        catch (e) { failed = true; console.error(`agentreceipt: skipped: ${e.message}`); }
      };
      tryUninstall('claude', 'local'); tryUninstall('claude', 'project');
      if (inst.removeExcludes(root)) console.log('Removed agentreceipt block from .git/info/exclude');
      if (inst.cleanProjectData(root)) console.log('Removed receipts/state from .agentreceipt (config.json kept)');
      const others = inst.unregisterProject(root);
      const global = args.includes('--global') || others.length === 0;
      if (!global) {
        console.log(`Kept the shared runtime and global hooks: ${others.length} other project${others.length > 1 ? 's' : ''} still use${others.length > 1 ? '' : 's'} agentreceipt. Run \`agentreceipt uninstall --global\` to remove everything.`);
      } else {
        // the global hooks/runtime go away, so clean every other registered project too
        for (const p of others) {
          try { inst.uninstall({ agent: 'claude', root: p, scope: 'local' }); inst.removeExcludes(p); if (inst.cleanProjectData(p)) console.log(`Cleaned ${p}`); }
          catch (e) { console.error(`agentreceipt: skipped ${p}: ${e.message}`); }
        }
        tryUninstall('codex'); tryUninstall('claude', 'user');
        if (failed) { console.error('agentreceipt: runtime kept because a hook could not be removed.'); process.exitCode = 1; return; }
        inst.removeRuntime();
        console.log(`Removed runtime from ${path.join(inst.homeDir(), 'runtime')}`);
      }
      if (failed) process.exitCode = 1;
      if (fs.existsSync(path.join(root, DIR, 'config.json'))) console.log(`Left ${path.join(DIR, 'config.json')} in place (team-shared; delete it yourself if you want).`);
      return;
    }
    case '--version': case '-v': return console.log(inst.VERSION);
    default:
      console.log(`agentreceipt ${inst.VERSION}
Usage:
  agentreceipt init [--test "<cmd>"] [--agent codex|claude|all] [--claude-scope local|user] [--timeout 300] [--max-blocks 3]
  agentreceipt last        print the latest receipt
  agentreceipt uninstall [--global]   remove this project's hooks (--global: also Codex/user hooks + runtime)
  agentreceipt hook        (called by the agent's Stop hook)`);
  }
}

main();
