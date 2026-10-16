'use strict';
const fs = require('fs');
const { findRoot, loadConfig, DIR } = require('./config');
const { runTests } = require('./run');
const { diffSummary } = require('./git');
const { buildReceipt, writeReceipt, formatReceipt } = require('./receipt');
const { getBlocks, setBlocks, withSessionLock } = require('./state');
const { extractClaim } = require('./claim');

const NOT_RUN = { exitCode: null, timedOut: false, durationMs: 0, outputTail: '' };
const EMPTY_DIFF = { isRepo: false, files: [], insertions: 0, deletions: 0, testFilesChanged: [] };

function blockReason(r) {
  const parts = [`agentreceipt: you tried to finish, but \`${r.tests.command}\` ${r.tests.timedOut ? 'timed out' : `failed (exit ${r.tests.exitCode})`}.`];
  if (r.diff.testFilesChanged.length) parts.push(`Note: test files were modified (${r.diff.testFilesChanged.join(', ')}); fix the code, not the tests.`);
  const tail = r.tests.outputTail.trim().split('\n').slice(-25).join('\n');
  if (tail) parts.push(`Last test output:\n${tail}`);
  parts.push(`Fix the failures and re-run the tests before finishing. (block ${r.blocks.count}/${r.blocks.max})`);
  return parts.join('\n\n');
}

// Internal failure: never trap the agent (allow stop), but leave an 'error' receipt when possible
// and make the problem visible to the user (systemMessage + stderr).
function errorResult({ root, agent, input, error, testCommand = null, test = NOT_RUN }) {
  const msg = String(error && error.message || error);
  let file = null, receipt = null;
  try {
    let diff = EMPTY_DIFF; try { diff = diffSummary(root); } catch {}
    receipt = buildReceipt({ agent, sessionId: input.session_id, turnId: input.turn_id, claim: extractClaim(input),
      testCommand, test, diff, blockCount: 0, maxBlocks: 0, decision: 'allow', error: msg });
    file = writeReceipt(root, receipt);
  } catch (e) { /* receipt unwritable; still report below */ }
  const text = receipt ? formatReceipt(receipt) : '';
  const warning = `agentreceipt ERROR: could not verify this stop, so it was allowed. ${msg}${file ? `\nReceipt: ${file}` : '\n(no receipt could be written)'}`;
  return { output: { systemMessage: text ? `${text}\n${warning}` : warning }, receipt, file, text, warning, error: msg };
}

// Core decision. input = Stop hook JSON from stdin. Returns { output, receipt, file, text }; output is the JSON to print.
async function handleStop(input, { agent = 'codex' } = {}) {
  const cwd = input.cwd || process.cwd();
  let root;
  try { root = findRoot(cwd); } catch (e) { return errorResult({ root: cwd, agent, input, error: e }); }
  let cfg;
  try { cfg = loadConfig(root); } catch (e) { return errorResult({ root, agent, input, error: e }); }
  if (!cfg) return { output: {}, skipped: true }; // agentreceipt not set up in this repo

  const sessionId = input.session_id;
  try {
    return await withSessionLock(root, sessionId, (cfg.timeoutSec + 120) * 1000, async () => {
      // stop_hook_active=false means this stop starts a fresh turn (not a continuation we caused),
      // so the block budget resets. Both Codex and Claude Code send this field.
      const prior = input.stop_hook_active === false ? 0 : getBlocks(root, sessionId);
      const test = await runTests(cfg.testCommand, root, cfg.timeoutSec);
      if (test.spawnError) return errorResult({ root, agent, input, error: `test command could not be started: ${test.spawnError}`, testCommand: cfg.testCommand, test });
      if (test.exitCode === 127) return errorResult({ root, agent, input, error: `test command not found (exit 127): ${test.outputTail.trim().split('\n').pop()}`, testCommand: cfg.testCommand, test });
      const diff = diffSummary(root);
      const passed = test.exitCode === 0 && !test.timedOut;
      const canBlock = !passed && prior < cfg.maxBlocks;
      const blockCount = canBlock ? prior + 1 : prior;
      const receipt = buildReceipt({
        agent, sessionId, turnId: input.turn_id, claim: extractClaim(input),
        testCommand: cfg.testCommand, test, diff, blockCount, maxBlocks: cfg.maxBlocks,
        decision: canBlock ? 'block' : 'allow',
      });
      const file = writeReceipt(root, receipt);
      setBlocks(root, sessionId, canBlock ? blockCount : 0); // reset once the agent is allowed to stop
      const text = formatReceipt(receipt);
      const output = canBlock
        ? { decision: 'block', reason: blockReason(receipt) }
        : { systemMessage: `${text}\nReceipt: ${file}` };
      return { output, receipt, file, text };
    });
  } catch (e) {
    return errorResult({ root, agent, input, error: e, testCommand: cfg.testCommand });
  }
}

async function hookMain(agent) {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch {}
  let input = {};
  let parseErr = null;
  try { input = raw ? JSON.parse(raw) : {}; } catch (e) { parseErr = e; }
  let result;
  try {
    result = parseErr ? errorResult({ root: process.cwd(), agent, input: {}, error: `invalid hook input JSON: ${parseErr.message}` })
      : await handleStop(input, { agent });
  } catch (e) {
    result = { output: { systemMessage: `agentreceipt ERROR: ${e && e.message || e} (stop allowed)` }, warning: String(e && e.stack || e) };
  }
  if (result.text) process.stderr.write(result.text + '\n');
  if (result.warning) process.stderr.write(result.warning + '\n');
  process.stdout.write(JSON.stringify(result.output) + '\n');
}

module.exports = { handleStop, hookMain, blockReason, errorResult };
