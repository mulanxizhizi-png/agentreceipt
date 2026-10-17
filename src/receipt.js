'use strict';
const fs = require('fs');
const path = require('path');
const { DIR } = require('./config');

const SCHEMA_VERSION = 1;

// status: "green" (tests pass), "blocked" (stop refused), "red" (allowed stop despite failures: block limit hit)
const NOTICE_ZH = '验证标准已变化，需复核';
const NOTICE_EN = 'Verification criteria changed, review needed';
// Files that define what "the tests" are: runner configs and test entry points (Makefile targets,
// package.json scripts, justfile recipes, nox/tox sessions, scripts/test*).
const CRITERIA_FILE = /(^|\/)(\.agentreceipt\/config\.json|\.github\/workflows\/[^/]+\.ya?ml|package\.json|jest\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|conftest\.py|noxfile\.py|[Mm]akefile|GNUmakefile|[^/]+\.mk|[Jj]ustfile|\.justfile|Taskfile\.ya?ml|scripts\/test[^/]*)$/;

// Minimal glob -> RegExp for config.criteriaFiles: ** (any dirs), * (within a segment), ?.
function globRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*' && g[i + 1] === '*') { re += g[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += g[i + 2] === '/' ? 2 : 1; }
    else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
function isCriteriaFile(p, extraGlobs = []) { return CRITERIA_FILE.test(p) || extraGlobs.some((g) => globRe(g).test(p)); }

// Informational only: never changes status. Flags that what "passing" means may have moved.
function criteriaChange(diff, config, criteriaFiles = []) {
  const reasons = [];
  if (diff.testFilesChanged && diff.testFilesChanged.length) reasons.push({ kind: 'test-files', files: diff.testFilesChanged });
  if (config && config.changedSinceLastVerified) reasons.push({ kind: 'config', previousTestCommand: config.previousTestCommand || null });
  const cfgFiles = (diff.files || []).map((f) => f.path).filter((p) => isCriteriaFile(p, criteriaFiles) && !(config && config.changedSinceLastVerified && p.endsWith('.agentreceipt/config.json')));
  if (cfgFiles.length) reasons.push({ kind: 'check-config-files', files: cfgFiles });
  return { changed: reasons.length > 0, ...(reasons.length ? { notice: NOTICE_EN, noticeZh: NOTICE_ZH } : {}), reasons, configFingerprint: (config && config.fingerprint) || null };
}

// noChanges: the diff is known (a git repo, PR diff available) and has zero files after ignore globs.
function noChangesIn(diff) { return !!(diff && diff.isRepo && !diff.unavailable && diff.files.length === 0); }

// requireChanges (config): a stop with no changed files is not verified (blocked, or red at the limit).
// scope: result of testScope() (src/scope.js); only a positive "partial" is recorded.
function buildReceipt({ agent, sessionId, turnId, claim, testCommand, test, diff, blockCount, maxBlocks, decision, error, git, fingerprint, config, warnings, criteriaFiles, environment, requireChanges = false, scope = null }) {
  const passed = test.exitCode === 0 && !test.timedOut;
  const noChanges = noChangesIn(diff);
  const changesMissing = !!requireChanges && noChanges;
  const verified = passed && !(fingerprint && fingerprint.changedDuringTests) && !changesMissing;
  const status = error ? 'error' : verified ? 'green' : decision === 'block' ? 'blocked' : 'red';
  const partial = scope && scope.partial ? { partial: true, detectedCommand: scope.detectedCommand, ...(scope.reason ? { partialReason: scope.reason } : {}) } : {};
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: 'agentreceipt',
    createdAt: new Date().toISOString(),
    agent, sessionId: sessionId || null, turnId: turnId || null,
    status, decision,
    claim: claim ? String(claim).slice(0, 2000) : null,
    tests: { command: testCommand, passed, exitCode: test.exitCode, timedOut: test.timedOut, ...partial, ...(test.spawnError ? { spawnError: test.spawnError } : {}), durationMs: test.durationMs,
      outputBytes: test.outputBytes ?? null, logPath: test.logPath || null,
      ...(test.outputHead && test.outputBytes > (test.outputHead.length + (test.outputTail || '').length) ? { outputHead: test.outputHead } : {}),
      outputTail: test.outputTail },
    ...(git ? { git } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(config ? { config } : {}),
    ...(environment ? { environment } : {}),
    warnings: warnings || [],
    verificationCriteria: criteriaChange(diff, config, Array.isArray(criteriaFiles) ? criteriaFiles : []),
    ...(requireChanges ? { changeCheck: { required: true, noChanges, satisfied: !changesMissing } } : {}),
    diff: { isRepo: diff.isRepo, base: diff.base || null, filesChanged: diff.files.length, ...(noChanges ? { noChanges: true } : {}), insertions: diff.insertions, deletions: diff.deletions, files: diff.files, testFilesChanged: diff.testFilesChanged },
    blocks: { count: blockCount, max: maxBlocks },
    ...(error ? { error: String(error) } : {}),
  };
}

function noChangesText(r) {
  return `NO FILES WERE CHANGED ${r.agent === 'ci' ? 'in this PR' : 'in this turn'}${r.changeCheck ? ' (requireChanges is on)' : ''}`;
}
function partialText(r) {
  return `only part of the test suite ran (configured \`${r.tests.command}\`, detected full suite \`${r.tests.detectedCommand}\`)`;
}

function receiptName(receipt) { return `${receipt.createdAt.replace(/[:.]/g, '-')}-${receipt.status}.json`; }

function writeReceipt(root, receipt) {
  const dir = path.join(root, DIR, 'receipts');
  fs.mkdirSync(dir, { recursive: true });
  const name = receiptName(receipt);
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n');
  return file;
}

function formatReceipt(r, { color = false } = {}) {
  const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const badge = { green: c('32;1', 'PASS  verified'), blocked: c('33;1', 'BLOCKED  agent sent back to work'), red: c('31;1', r.agent === 'ci' ? 'RED  tests failing' : 'RED  stopped with failing tests'), error: c('35;1', r.agent === 'ci' ? 'ERROR  agentreceipt could not verify (check failed)' : 'ERROR  agentreceipt could not verify (stop allowed)') }[r.status];
  const line = '-'.repeat(44);
  const out = [line, ' AGENT RECEIPT', line,
    ` Status:   ${badge}`,
    ` Agent:    ${r.agent}`,
    ` Claimed:  ${r.claim ? r.claim.split('\n')[0].slice(0, 70) : '(no message)'}`,
    ` Tests:    ${!r.tests.command ? '(not run)' : r.tests.spawnError ? `${r.tests.command} -> could not run` : `${r.tests.command} -> ${r.tests.timedOut ? 'TIMED OUT' : r.tests.passed ? 'passed' : `failed (exit ${r.tests.exitCode})`} in ${(r.tests.durationMs / 1000).toFixed(1)}s`}`,
    ` Diff:     ${r.diff.isRepo ? `${r.diff.filesChanged} files, +${r.diff.insertions} -${r.diff.deletions}` : 'not a git repo'}`];
  if (r.diff.noChanges) out.push(c('33;1', ` Changes:  ${noChangesText(r)}`));
  if (r.tests.partial) out.push(c('33;1', ` Scope:    ${partialText(r)}`));
  if (r.git && r.git.head) out.push(` Commit:   ${r.git.head.slice(0, 12)}${r.git.commitsSinceBase ? ` (+${r.git.commitsSinceBase} commit${r.git.commitsSinceBase > 1 ? 's' : ''} since last stop)` : ''}`);
  const vc = r.verificationCriteria;
  if (vc && vc.changed) out.push(c('36;1', ` Notice:   ${vc.notice} / ${vc.noticeZh}`) + ` (${vc.reasons.map((x) => x.kind).join(', ')})`);
  if (r.fingerprint && r.fingerprint.changedDuringTests) out.push(c('31', ' Warning:  code changed while tests were running; result not trusted'));
  for (const w of r.warnings || []) out.push(c('33', ` Warning:  ${w}`));
  if (r.tests.logPath) out.push(` Log:      ${r.tests.logPath}`);
  const py = r.environment && r.environment.python;
  if (py && (py.executable || r.environment.cleanEnv)) out.push(` Python:   ${py.executable ? `${py.executable} ${py.version}` : '(not found)'}${r.environment.cleanEnv ? ' (clean bytecode cache)' : ''}`);
  if (r.undo) {
    out.push(` Snapshot: agentundo #${r.undo.snapshotId}${r.undo.lastKnownGood ? ' (last known good)' : ''}`);
    if (r.undo.restoreCommand) out.push(c('36', ` Go back:  ${r.undo.restoreCommand}`) + `  (last state where tests passed, #${r.undo.lastGreenSnapshotId})`);
  }
  if (r.diff.testFilesChanged.length) out.push(c('33', ` Warning:  test files changed: ${r.diff.testFilesChanged.join(', ')}`));
  if (r.agent !== 'ci') out.push(` Blocks:   ${r.blocks.count}/${r.blocks.max}`);
  if (r.error) out.push(c('35', ` Error:    ${r.error.split('\n')[0].slice(0, 200)}`));
  const changesMissing = !!(r.changeCheck && !r.changeCheck.satisfied);
  if (r.status === 'red' && r.agent !== 'ci') out.push(c('31', r.tests.passed && changesMissing ? ' Stopped without changing any files (requireChanges is on).' : ' Block limit reached: stop allowed, tests still failing.'));
  if (r.status === 'red' && r.agent === 'ci' && r.tests.passed && changesMissing) out.push(c('31', ' Check failed: the PR changes no files (requireChanges is on).'));
  out.push(line);
  return out.join('\n');
}

module.exports = { noChangesIn, noChangesText, partialText, globRe, isCriteriaFile, receiptName, NOTICE_EN, NOTICE_ZH, criteriaChange, SCHEMA_VERSION, buildReceipt, writeReceipt, formatReceipt };
