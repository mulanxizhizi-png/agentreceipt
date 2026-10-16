'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|^test_.*\.py$|\/test_[^/]*\.py$/i;

// Files agentreceipt itself creates; never count them as the agent's work.
const OWN = [/^\.agentreceipt\//, /^\.claude\/settings(\.local)?\.json$/];
const isOwn = (f) => OWN.some((re) => re.test(f));

function git(root, args, opts = {}) {
  return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024, ...opts }).toString();
}
function isRepo(root) { try { git(root, ['rev-parse', '--git-dir']); return true; } catch { return false; } }
function headSha(root) { try { return git(root, ['rev-parse', '--verify', '-q', 'HEAD']).trim() || null; } catch { return null; } }
function isAncestor(root, a, b = 'HEAD') {
  try { execFileSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: root, stdio: 'ignore' }); return true; } catch { return false; }
}

// Parse `git diff -z --numstat` (paths are raw bytes, no quoting; renames are "a\td\t\0old\0new\0").
function parseNumstatZ(out) {
  const files = []; let insertions = 0, deletions = 0;
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
    if (!m) continue;
    let file = m[3], from = null;
    if (file === '') { from = parts[++i]; file = parts[++i]; }
    if (isOwn(file)) continue;
    insertions += Number(m[1]) || 0; deletions += Number(m[2]) || 0;
    files.push(from ? { path: file, status: 'renamed', from } : { path: file, status: 'modified' });
  }
  return { files, insertions, deletions };
}

function untracked(root) {
  return git(root, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter((f) => f && !isOwn(f));
}

// Changes from `base` (a commit; default HEAD) to the working tree, plus untracked files.
// Using the last verified commit as base keeps committed work visible in the receipt.
function diffSummary(root, base) {
  if (!isRepo(root)) return { isRepo: false, files: [], insertions: 0, deletions: 0, testFilesChanged: [] };
  let out = '';
  const ref = base || 'HEAD';
  try { out = git(root, ['diff', '-z', '--numstat', '-M', ref]); } catch { try { out = git(root, ['diff', '-z', '--numstat']); } catch {} }
  const d = parseNumstatZ(out);
  for (const f of untracked(root)) d.files.push({ path: f, status: 'untracked' });
  return { isRepo: true, base: base || null, ...d, testFilesChanged: d.files.map((f) => f.path).filter((p) => TEST_FILE.test(p)) };
}

// Committed changes between two refs (used in CI: PR base vs head).
function diffBetween(root, base, head = 'HEAD') {
  let out;
  try { out = git(root, ['diff', '-z', '--numstat', '-M', base, head]); } catch { return null; }
  const d = parseNumstatZ(out);
  return { isRepo: true, ...d, testFilesChanged: d.files.map((f) => f.path).filter((p) => TEST_FILE.test(p)) };
}

// Fingerprint of the code as it is on disk: HEAD + tracked working-tree changes + untracked file contents.
// Taken before and after the test run to prove the receipt describes the code that was actually tested.
function codeFingerprint(root) {
  if (!isRepo(root)) return null;
  const h = crypto.createHash('sha256');
  h.update(`head:${headSha(root) || 'none'}\0`);
  try { h.update(execFileSync('git', ['diff', '--binary', 'HEAD', '--', '.', ':(exclude).agentreceipt'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024 * 1024 })); } catch {}
  for (const f of untracked(root).sort()) {
    h.update(`\0untracked:${f}\0`);
    try { h.update(fs.readFileSync(path.join(root, f))); } catch { h.update('<unreadable>'); }
  }
  return 'sha256:' + h.digest('hex');
}

module.exports = { diffSummary, diffBetween, parseNumstatZ, codeFingerprint, headSha, isAncestor, git, isRepo, TEST_FILE };
