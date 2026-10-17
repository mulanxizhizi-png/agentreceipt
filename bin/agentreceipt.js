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
// Hook limit (install.HOOK_TIMEOUT, 900s) minus 120s headroom for everything else the hook does
// (git diff, code fingerprints before/after, receipt + agentundo snapshot).
const MAX_PRACTICAL_TIMEOUT = 780;

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
    if (!flag(args, '--test') && !flag(args, '--max-blocks') && !flag(args, '--timeout') && !args.includes('--require-changes') && !args.includes('--no-require-changes')) { console.error(`agentreceipt: ${e.message}`); process.exit(1); }
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
  // Boolean flags: --require-changes turns it on, --no-require-changes off; otherwise keep the existing value.
  if (args.includes('--require-changes')) cfg.requireChanges = true;
  else if (args.includes('--no-require-changes')) cfg.requireChanges = false;
  const errs = validateConfig(cfg);
  if (errs.length) { console.error(`agentreceipt: invalid settings: ${errs.join('; ')}`); process.exit(1); }
  saveConfig(root, cfg);
  if (cfg.timeoutSec > MAX_PRACTICAL_TIMEOUT) console.warn(`Warning: --timeout ${cfg.timeoutSec}s is above ~${MAX_PRACTICAL_TIMEOUT}s. The agent kills the whole Stop hook after ${inst.HOOK_TIMEOUT}s, so a test run that long ends with no receipt. Keep it at ${MAX_PRACTICAL_TIMEOUT} or less, or run a faster subset locally.`);
  try {
    const sc = require('../src/scope').testScope(root, cfg.testCommand);
    if (sc && sc.partial) console.log(`Note: \`${cfg.testCommand}\` runs only part of the test suite (detected full suite: \`${sc.detectedCommand}\`). Receipts will say so; run the full suite in CI.`);
  } catch {}
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
      // --global: other registered projects lose hook/state/logs but keep receipts (and their ignore rule).
      // --purge (implies --global): receipts are deleted everywhere too; needs confirmation or --yes.
      const root = findRoot(process.cwd());
      const purge = args.includes('--purge');
      const here = path.resolve(root);
      const others = inst.readRegistry().filter((p) => p !== here && fs.existsSync(p));
      const receiptsOnly = inst.readReceiptsOnly().filter((p) => p !== here && !others.includes(p) && fs.existsSync(path.join(p, DIR, 'receipts')));
      const global = purge || args.includes('--global') || others.length === 0;
      if (purge) {
        // --purge always confirms, however many projects there are.
        const list = [here, ...others, ...receiptsOnly].map((p) => `  - ${p}`).join('\n');
        if (!args.includes('--yes')) {
          if (!process.stdin.isTTY || !process.stdout.isTTY) {
            console.error(`agentreceipt: --purge deletes hooks, state, logs and receipts in these projects:\n${list}\nRefusing without confirmation (not a terminal). Re-run with --yes to proceed.`);
            process.exitCode = 1; return;
          }
          console.log(`--purge will delete hooks, state, logs and receipts in:\n${list}`);
          const a = await ask('Proceed? [y/N] ');
          if (!/^y(es)?$/i.test(a)) { console.log('Aborted; nothing changed.'); process.exitCode = 1; return; }
        }
      }
      let failed = false;
      const report = [];
      const tryUninstall = (a, scope, r = root) => {
        try { return inst.uninstall({ agent: a, root: r, scope }); }
        catch (e) { failed = true; console.error(`agentreceipt: skipped: ${e.message}`); return null; }
      };
      const doProject = (p, keepReceipts) => {
        const deleted = [], kept = [];
        for (const sc of ['local', 'project']) { const f = tryUninstall('claude', sc, p); if (f) deleted.push(`hook in ${path.relative(p, f)}`); }
        const res = inst.cleanProjectData(p, { keepReceipts });
        deleted.push(...res.deleted); kept.push(...res.kept);
        if (keepReceipts && res.kept.includes('.agentreceipt/receipts/')) { inst.setExcludes(p, ['.agentreceipt/receipts/']); kept.push('.git/info/exclude rule for .agentreceipt/receipts/'); }
        else if (inst.removeExcludes(p)) deleted.push('.git/info/exclude block');
        report.push({ p, deleted, kept });
      };
      doProject(root, false);
      inst.unregisterProject(root);
      if (!global) {
        console.log(`Kept the shared runtime and global hooks: ${others.length} other project${others.length > 1 ? 's' : ''} still use${others.length > 1 ? '' : 's'} agentreceipt. Run \`agentreceipt uninstall --global\` to remove everything.`);
      } else {
        const kept = [];
        for (const p of others) {
          try { doProject(p, !purge); if (!purge && fs.existsSync(path.join(p, DIR, 'receipts'))) kept.push(p); }
          catch (e) { failed = true; console.error(`agentreceipt: skipped ${p}: ${e.message}`); }
        }
        if (purge) for (const p of receiptsOnly) { try { doProject(p, false); } catch (e) { failed = true; console.error(`agentreceipt: skipped ${p}: ${e.message}`); } }
        inst.setReceiptsOnly(purge ? [] : [...receiptsOnly, ...kept]);
        const g = [];
        for (const [a, sc] of [['codex'], ['claude', 'user']]) { const f = tryUninstall(a, sc); if (f) g.push(`hook in ${f}`); }
        if (failed) { console.error('agentreceipt: runtime kept because a hook could not be removed.'); process.exitCode = 1; }
        else { inst.removeRuntime(); g.push(`runtime ${path.join(inst.homeDir(), 'runtime')}`); }
        report.push({ p: 'global', deleted: g, kept: [] });
      }
      for (const r of report) {
        console.log(`\n${r.p}:`);
        console.log(`  deleted: ${r.deleted.length ? r.deleted.join(', ') : '(nothing)'}`);
        console.log(`  kept:    ${r.kept.length ? r.kept.join(', ') : '(nothing)'}`);
      }
      if (failed) process.exitCode = 1;
      return;
    }
    case '--version': case '-v': return console.log(inst.VERSION);
    default:
      console.log(`agentreceipt ${inst.VERSION}
Usage:
  agentreceipt init [--test "<cmd>"] [--agent codex|claude|all] [--claude-scope local|user] [--timeout 300] [--max-blocks 3] [--require-changes]
  agentreceipt last        print the latest receipt
  agentreceipt uninstall [--global] [--purge [--yes]]
      remove this project's hooks and generated files (config.json is kept)
      --global: also Codex/user hooks + runtime; other projects lose hooks/state/logs but keep receipts
      --purge:  like --global, and delete receipts in every project (asks first; --yes to skip)
  agentreceipt hook        (called by the agent's Stop hook)`);
  }
}

main();
