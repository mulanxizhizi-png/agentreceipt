'use strict';
// GitHub Action entry point. No dependencies: uses Node's built-in fetch (Node 18+ on GitHub runners).
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { detectTestCommand } = require('./detect');
const { runTests } = require('./run');
const { diffBetween, git } = require('./git');
const { buildReceipt, writeReceipt, formatReceipt } = require('./receipt');

const MARKER = '<!-- agentreceipt:ci -->';

function resolveTestCommand(root, input) {
  if (input) return input;
  const cfg = loadConfig(root);
  if (cfg && cfg.testCommand) return cfg.testCommand;
  const d = detectTestCommand(root);
  return d ? d.command : null;
}

// PR diff: actions/checkout checks out the merge commit; its first parent is the base.
function prDiff(root, event) {
  const base = event && event.pull_request && event.pull_request.base && event.pull_request.base.sha;
  const tryRef = (ref) => diffBetween(root, ref, 'HEAD');
  let d = base && tryRef(base);
  if (!d) d = tryRef('HEAD^1');
  if (!d) {
    try { git(root, ['fetch', '--quiet', '--depth=2', 'origin', 'HEAD']); } catch {}
    try { if (base) git(root, ['fetch', '--quiet', '--depth=1', 'origin', base]); } catch {}
    d = (base && tryRef(base)) || tryRef('HEAD^1');
  }
  return d || { isRepo: true, files: [], insertions: 0, deletions: 0, testFilesChanged: [], unavailable: true };
}

function markdown(r, { runUrl } = {}) {
  const icon = r.status === 'green' ? '✅' : '🟥';
  const title = r.status === 'green' ? 'PASS: tests verified' : 'RED: tests failing';
  const tail = r.tests.outputTail.trim().split('\n').slice(-30).join('\n');
  return [MARKER,
    `### ${icon} Agent Receipt: ${title}`,
    '',
    '```',
    formatReceipt(r),
    '```',
    r.status !== 'green' && tail ? `<details><summary>Last test output</summary>\n\n\`\`\`\n${tail.replace(/```/g, "'''")}\n\`\`\`\n</details>` : '',
    '',
    `<sub>agentreceipt · schema v${r.schemaVersion} · ${r.createdAt}${runUrl ? ` · [run](${runUrl})` : ''}</sub>`,
  ].filter((l) => l !== null).join('\n');
}

async function gh(token, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'agentreceipt' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function upsertComment({ token, api, repo, number, body }) {
  let page = 1, existing = null;
  for (;;) {
    const list = await gh(token, 'GET', `${api}/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    existing = list.find((c) => c.body && c.body.includes(MARKER)) || existing;
    if (list.length < 100 || existing) break;
    page++;
  }
  if (existing) return gh(token, 'PATCH', `${api}/repos/${repo}/issues/comments/${existing.id}`, { body });
  return gh(token, 'POST', `${api}/repos/${repo}/issues/${number}/comments`, { body });
}

function setOutput(k, v, env = process.env) {
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`);
}

async function main(env = process.env) {
  const root = env.GITHUB_WORKSPACE || process.cwd();
  let event = null;
  try { event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')); } catch {}
  const pr = event && event.pull_request;
  const testCommand = resolveTestCommand(root, (env.AR_TEST_COMMAND || '').trim());
  if (!testCommand) { console.log('::error::agentreceipt: no test command configured or detected. Set the test-command input.'); process.exitCode = 1; return; }

  const test = await runTests(testCommand, root, Number(env.AR_TIMEOUT) || 600);
  const diff = prDiff(root, event);
  const passed = test.exitCode === 0 && !test.timedOut;
  const claim = pr ? [pr.title, (pr.body || '').split('\n')[0]].filter(Boolean).join(' | ') : null;
  const receipt = buildReceipt({
    agent: 'ci', sessionId: env.GITHUB_RUN_ID || null, turnId: pr ? `pr-${pr.number}@${(pr.head && pr.head.sha || '').slice(0, 7)}` : null,
    claim, testCommand, test, diff, blockCount: 0, maxBlocks: 0, decision: passed ? 'allow' : 'fail',
  });
  const file = writeReceipt(root, receipt);
  console.log(formatReceipt(receipt));
  setOutput('status', receipt.status, env); setOutput('receipt-path', file, env);
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;
  const body = markdown(receipt, { runUrl });
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, body + '\n');

  if (pr && String(env.AR_COMMENT).toLowerCase() !== 'false') {
    try {
      await upsertComment({ token: env.AR_TOKEN, api: env.GITHUB_API_URL || 'https://api.github.com', repo: env.GITHUB_REPOSITORY, number: pr.number, body });
    } catch (e) {
      console.log(`::warning::agentreceipt: could not post PR comment (needs permissions: pull-requests: write). ${e.message}`);
    }
  }
  if (!passed) { console.log(`::error::agentreceipt: \`${testCommand}\` ${test.timedOut ? 'timed out' : `failed (exit ${test.exitCode})`}`); process.exitCode = 1; }
}

if (require.main === module) main().catch((e) => { console.log(`::error::agentreceipt: ${e.stack || e}`); process.exitCode = 1; });

module.exports = { main, markdown, upsertComment, resolveTestCommand, MARKER };
