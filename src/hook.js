'use strict';
const fs = require('fs');
const { findRoot, loadConfig } = require('./config');
const { runTests } = require('./run');
const { diffSummary } = require('./git');
const { buildReceipt, writeReceipt, formatReceipt } = require('./receipt');
const { getBlocks, setBlocks } = require('./state');

function blockReason(r) {
  const parts = [`agentreceipt: you tried to finish, but \`${r.tests.command}\` ${r.tests.timedOut ? 'timed out' : `failed (exit ${r.tests.exitCode})`}.`];
  if (r.diff.testFilesChanged.length) parts.push(`Note: test files were modified (${r.diff.testFilesChanged.join(', ')}); fix the code, not the tests.`);
  const tail = r.tests.outputTail.trim().split('\n').slice(-25).join('\n');
  if (tail) parts.push(`Last test output:\n${tail}`);
  parts.push(`Fix the failures and re-run the tests before finishing. (block ${r.blocks.count}/${r.blocks.max})`);
  return parts.join('\n\n');
}

// Core decision. input = Stop hook JSON from stdin. Returns { output, receipt, file } ; output is the JSON to print.
async function handleStop(input, { agent = 'codex' } = {}) {
  const cwd = input.cwd || process.cwd();
  const root = findRoot(cwd);
  const cfg = loadConfig(root);
  if (!cfg || !cfg.testCommand) return { output: {}, skipped: true };

  const sessionId = input.session_id;
  const prior = getBlocks(root, sessionId);
  const test = await runTests(cfg.testCommand, root, cfg.timeoutSec);
  const diff = diffSummary(root);
  const passed = test.exitCode === 0 && !test.timedOut;
  const canBlock = !passed && prior < cfg.maxBlocks;
  const blockCount = canBlock ? prior + 1 : prior;
  const receipt = buildReceipt({
    agent, sessionId, turnId: input.turn_id, claim: input.last_assistant_message,
    testCommand: cfg.testCommand, test, diff, blockCount, maxBlocks: cfg.maxBlocks,
    decision: canBlock ? 'block' : 'allow',
  });
  const file = writeReceipt(root, receipt);
  if (canBlock) setBlocks(root, sessionId, blockCount);
  else setBlocks(root, sessionId, 0); // reset once the agent is allowed to stop
  const text = formatReceipt(receipt);
  const output = canBlock
    ? { decision: 'block', reason: blockReason(receipt) }
    : { systemMessage: `${text}\nReceipt: ${file}` };
  return { output, receipt, file, text };
}

async function hookMain(agent) {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch {}
  let input = {};
  try { input = raw ? JSON.parse(raw) : {}; } catch {}
  try {
    const { output, text } = await handleStop(input, { agent });
    if (text) process.stderr.write(text + '\n');
    process.stdout.write(JSON.stringify(output) + '\n');
  } catch (e) {
    // Never wedge the agent because of our own bug.
    process.stderr.write(`agentreceipt hook error: ${e && e.stack || e}\n`);
    process.stdout.write('{}\n');
  }
}

module.exports = { handleStop, hookMain, blockReason };
