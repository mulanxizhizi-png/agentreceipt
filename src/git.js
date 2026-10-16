'use strict';
const { execFileSync } = require('child_process');

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|^test_.*\.py$|\/test_[^/]*\.py$/i;

// Files agentreceipt itself creates; never count them as the agent's work.
const OWN_UNTRACKED = [/^\.agentreceipt\//, /^\.claude\/settings\.json$/];

function git(root, args) {
  return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

// Working-tree changes vs HEAD plus untracked files.
function diffSummary(root) {
  try {
    git(root, ['rev-parse', '--git-dir']);
  } catch {
    return { isRepo: false, files: [], insertions: 0, deletions: 0, testFilesChanged: [] };
  }
  let numstat = '';
  try { numstat = git(root, ['diff', 'HEAD', '--numstat']); } catch { numstat = git(root, ['diff', '--numstat']); }
  const files = [];
  let insertions = 0, deletions = 0;
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [a, d, f] = line.split('\t');
    if (f.startsWith('.agentreceipt/')) continue;
    insertions += Number(a) || 0; deletions += Number(d) || 0;
    files.push({ path: f, status: 'modified' });
  }
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)
    .filter((f) => !OWN_UNTRACKED.some((re) => re.test(f)));
  for (const f of untracked) files.push({ path: f, status: 'untracked' });
  const testFilesChanged = files.map((f) => f.path).filter((p) => TEST_FILE.test(p));
  return { isRepo: true, files, insertions, deletions, testFilesChanged };
}

module.exports = { diffSummary, TEST_FILE };
