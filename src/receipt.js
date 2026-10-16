'use strict';
const fs = require('fs');
const path = require('path');
const { DIR } = require('./config');

const SCHEMA_VERSION = 1;

// status: "green" (tests pass), "blocked" (stop refused), "red" (allowed stop despite failures: block limit hit)
function buildReceipt({ agent, sessionId, turnId, claim, testCommand, test, diff, blockCount, maxBlocks, decision, error }) {
  const passed = test.exitCode === 0 && !test.timedOut;
  const status = error ? 'error' : passed ? 'green' : decision === 'block' ? 'blocked' : 'red';
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: 'agentreceipt',
    createdAt: new Date().toISOString(),
    agent, sessionId: sessionId || null, turnId: turnId || null,
    status, decision,
    claim: claim ? String(claim).slice(0, 2000) : null,
    tests: { command: testCommand, passed, exitCode: test.exitCode, timedOut: test.timedOut, ...(test.spawnError ? { spawnError: test.spawnError } : {}), durationMs: test.durationMs, outputTail: test.outputTail },
    diff: { isRepo: diff.isRepo, filesChanged: diff.files.length, insertions: diff.insertions, deletions: diff.deletions, files: diff.files, testFilesChanged: diff.testFilesChanged },
    blocks: { count: blockCount, max: maxBlocks },
    ...(error ? { error: String(error) } : {}),
  };
}

function writeReceipt(root, receipt) {
  const dir = path.join(root, DIR, 'receipts');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${receipt.createdAt.replace(/[:.]/g, '-')}-${receipt.status}.json`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n');
  return file;
}

function formatReceipt(r, { color = false } = {}) {
  const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const badge = { green: c('32;1', 'PASS  verified'), blocked: c('33;1', 'BLOCKED  agent sent back to work'), red: c('31;1', r.agent === 'ci' ? 'RED  tests failing' : 'RED  stopped with failing tests'), error: c('35;1', 'ERROR  agentreceipt could not verify (stop allowed)') }[r.status];
  const line = '-'.repeat(44);
  const out = [line, ' AGENT RECEIPT', line,
    ` Status:   ${badge}`,
    ` Agent:    ${r.agent}`,
    ` Claimed:  ${r.claim ? r.claim.split('\n')[0].slice(0, 70) : '(no message)'}`,
    ` Tests:    ${!r.tests.command ? '(not run)' : r.tests.spawnError ? `${r.tests.command} -> could not run` : `${r.tests.command} -> ${r.tests.timedOut ? 'TIMED OUT' : r.tests.passed ? 'passed' : `failed (exit ${r.tests.exitCode})`} in ${(r.tests.durationMs / 1000).toFixed(1)}s`}`,
    ` Diff:     ${r.diff.isRepo ? `${r.diff.filesChanged} files, +${r.diff.insertions} -${r.diff.deletions}` : 'not a git repo'}`];
  if (r.diff.testFilesChanged.length) out.push(c('33', ` Warning:  test files changed: ${r.diff.testFilesChanged.join(', ')}`));
  if (r.agent !== 'ci') out.push(` Blocks:   ${r.blocks.count}/${r.blocks.max}`);
  if (r.error) out.push(c('35', ` Error:    ${r.error.split('\n')[0].slice(0, 200)}`));
  if (r.status === 'red' && r.agent !== 'ci') out.push(c('31', ' Block limit reached: stop allowed, tests still failing.'));
  out.push(line);
  return out.join('\n');
}

module.exports = { SCHEMA_VERSION, buildReceipt, writeReceipt, formatReceipt };
