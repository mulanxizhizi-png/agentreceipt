'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { findRoot, loadConfig, configFingerprint, DIR } = require('./config');
const { runTests } = require('./run');
const { diffSummary, codeFingerprint, headSha, isAncestor, git: gitCmd } = require('./git');
const { buildReceipt, writeReceipt, formatReceipt, receiptName } = require('./receipt');
const { recordUndo } = require('./undo');
const { getBlocks, setBlocks, withSessionLock, getLast, setLast } = require('./state');
const { extractClaim } = require('./claim');

const NOT_RUN = { exitCode: null, timedOut: false, durationMs: 0, outputTail: '' };
const EMPTY_DIFF = { isRepo: false, files: [], insertions: 0, deletions: 0, testFilesChanged: [] };

function blockReason(r) {
  const drift = r.fingerprint && r.fingerprint.changedDuringTests;
  const parts = [drift && r.tests.passed
    ? `agentreceipt: \`${r.tests.command}\` passed, but the code changed while the tests were running, so the result can't be trusted. Make sure nothing is still editing files, then re-run the tests.`
    : `agentreceipt: you tried to finish, but \`${r.tests.command}\` ${r.tests.timedOut ? 'timed out' : `failed (exit ${r.tests.exitCode})`}.`];
  if (r.verificationCriteria && r.verificationCriteria.changed) parts.push(`Notice: ${r.verificationCriteria.notice} (${r.verificationCriteria.noticeZh}). The user will review this change.`);
  for (const w of r.warnings || []) parts.push(`Warning: ${w}`);
  if (r.diff.testFilesChanged.length) parts.push(`Note: test files were modified (${r.diff.testFilesChanged.join(', ')}); fix the code, not the tests.`);
  if (r.tests.outputHead) parts.push(`Start of test output:\n${r.tests.outputHead.trim().split('\n').slice(0, 25).join('\n')}`);
  const tail = r.tests.outputTail.trim().split('\n').slice(-25).join('\n');
  if (tail) parts.push(`${r.tests.outputHead ? 'End' : 'Last'} of test output:\n${tail}`);
  if (r.tests.logPath) parts.push(`Full log: ${r.tests.logPath}`);
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
      const last = getLast(root);
      const head = headSha(root);
      // Diff base: the commit at the last turn-ending stop (or init), if it's still an ancestor of HEAD.
      const base = last && last.sha && head && last.sha !== head && isAncestor(root, last.sha, head) ? last.sha : null;
      let commitsSinceBase = 0;
      if (base) { try { commitsSinceBase = Number(gitCmd(root, ['rev-list', '--count', `${base}..${head}`]).trim()) || 0; } catch {} }
      const cfgFp = configFingerprint(root);
      const warnings = [];
      const configChanged = !!(last && last.configFingerprint && cfgFp && last.configFingerprint !== cfgFp);
      if (configChanged) warnings.push(`.agentreceipt/config.json changed since the last verified stop${last.testCommand && last.testCommand !== cfg.testCommand ? ` (test command was \`${last.testCommand}\`, now \`${cfg.testCommand}\`)` : ''}`);

      const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
      const logFile = path.join(root, DIR, 'receipts', `${stamp}.log`);
      const fpBefore = codeFingerprint(root);
      const test = await runTests(cfg.testCommand, root, cfg.timeoutSec, { logFile });
      const fpAfter = codeFingerprint(root);
      if (test.spawnError) return errorResult({ root, agent, input, error: `test command could not be started: ${test.spawnError}`, testCommand: cfg.testCommand, test });
      if (test.exitCode === 127) return errorResult({ root, agent, input, error: `test command not found (exit 127): ${test.outputTail.trim().split('\n').pop()}`, testCommand: cfg.testCommand, test });
      const diff = diffSummary(root, base);
      const fingerprint = { before: fpBefore, after: fpAfter, changedDuringTests: !!(fpBefore && fpAfter && fpBefore !== fpAfter) };
      const passed = test.exitCode === 0 && !test.timedOut && !fingerprint.changedDuringTests;
      const canBlock = !passed && prior < cfg.maxBlocks;
      const blockCount = canBlock ? prior + 1 : prior;
      const receipt = buildReceipt({
        agent, sessionId, turnId: input.turn_id, claim: extractClaim(input),
        testCommand: cfg.testCommand, test, diff, blockCount, maxBlocks: cfg.maxBlocks,
        decision: canBlock ? 'block' : 'allow',
        git: { head, base, commitsSinceBase }, fingerprint,
        config: { fingerprint: cfgFp, changedSinceLastVerified: configChanged, ...(configChanged && last.testCommand && last.testCommand !== cfg.testCommand ? { previousTestCommand: last.testCommand } : {}) },
        warnings, criteriaFiles: cfg.criteriaFiles,
      });
      // agentundo (optional): snapshot id of the verified state; for the user only, never in the block reason.
      const undo = recordUndo(root, receipt.status, receiptName(receipt));
      if (undo) receipt.undo = undo;
      const file = writeReceipt(root, receipt);
      setBlocks(root, sessionId, canBlock ? blockCount : 0); // reset once the agent is allowed to stop
      if (!canBlock) setLast(root, { sha: head, configFingerprint: cfgFp, testCommand: cfg.testCommand, receipt: path.basename(file) });
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
