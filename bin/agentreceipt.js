#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { findRoot, loadConfig, saveConfig, DEFAULTS, DIR } = require('../src/config');
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
  const existing = loadConfig(root) || {};
  let testCommand = flag(args, '--test', existing.testCommand);
  if (!testCommand) {
    const d = detectTestCommand(root);
    if (d) { testCommand = d.command; console.log(`Detected test command: ${d.command}  (from ${d.source})`); }
    else testCommand = await ask('Could not detect a test command. What runs your tests? ');
  }
  if (!testCommand) { console.error('No test command. Re-run with: agentreceipt init --test "<command>"'); process.exit(1); }
  const cfg = {
    ...DEFAULTS, ...existing, testCommand,
    timeoutSec: Number(flag(args, '--timeout', existing.timeoutSec || DEFAULTS.timeoutSec)),
    maxBlocks: Number(flag(args, '--max-blocks', existing.maxBlocks ?? DEFAULTS.maxBlocks)),
  };
  saveConfig(root, cfg);
  // keep receipts/state out of git by default; config stays committable
  fs.writeFileSync(path.join(root, DIR, '.gitignore'), 'receipts/\nstate/\n');

  const agentArg = flag(args, '--agent', 'all');
  const agents = agentArg === 'all' ? ['codex', 'claude'] : agentArg.split(',');
  const binPath = inst.installRuntime();
  console.log(`Config: ${path.join(root, DIR, 'config.json')}`);
  for (const a of agents) console.log(`Stop hook (${a}): ${inst.install({ agent: a, root, binPath, scope: flag(args, '--claude-scope', 'project') })}`);
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
      const root = findRoot(process.cwd());
      for (const [a, scope] of [['codex'], ['claude', 'project'], ['claude', 'user']]) {
        const f = inst.uninstall({ agent: a, root, scope }); if (f) console.log(`Removed hook from ${f}`);
      }
      inst.removeRuntime();
      console.log(`Removed runtime from ${path.join(inst.homeDir(), 'runtime')}`);
      return;
    }
    case '--version': case '-v': return console.log(inst.VERSION);
    default:
      console.log(`agentreceipt ${inst.VERSION}
Usage:
  agentreceipt init [--test "<cmd>"] [--agent codex|claude|all] [--claude-scope project|user] [--timeout 300] [--max-blocks 3]
  agentreceipt last        print the latest receipt
  agentreceipt uninstall   remove the Stop hooks
  agentreceipt hook        (called by the agent's Stop hook)`);
  }
}

main();
