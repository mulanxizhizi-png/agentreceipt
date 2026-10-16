# agentreceipt

**Your coding agent says "done". Make it show a receipt.**

agentreceipt adds a Stop hook to your coding agent. When the agent tries to finish, the hook runs your tests and checks the git diff. If the tests fail, the agent is sent back to work with the failure output. After a set number of blocks it's allowed to stop, and the receipt is marked **RED**.

![red receipt](https://raw.githubusercontent.com/mulanxizhizi-png/agentreceipt/main/e2e/red-receipt.png)

*Real output from Codex 0.163.0: the agent claimed "all tests pass", got blocked once, then stopped with the tests still failing.*

## Install

In your project (git repo):

```
npx github:mulanxizhizi-png/agentreceipt#v0.1.4 init
```

`init` never overwrites a settings file it can't parse: it stops with an error and changes nothing. Before modifying an existing file, it saves a copy to `~/.agentreceipt/backups/`.

`init` finds your test command (`package.json` test via npm/pnpm/yarn/bun, chosen by the `packageManager` field or lockfile incl. `bun.lock`, pytest, cargo, go, `make test`), or asks you for it. It writes `.agentreceipt/config.json` and installs the hook. The runtime is copied to `~/.agentreceipt/runtime/<version>/` (behind a stable shim in `~/.agentreceipt/bin/`) so the hook keeps working after npx clears its cache. Requires Node 18 or newer. No dependencies. Tested on Linux and macOS (macOS: a real Codex run on a Python project).

## Codex: trust the hook once

Codex won't run a new hook until you trust it. The hook goes to `~/.codex/hooks.json` (user level). In repos without `.agentreceipt/config.json` it does nothing. The next time you start `codex`:

1. Codex shows **"Hooks need review"**. Pick **1. Review hooks**. (2. *Trust all and continue* also works.)
2. Select the `Stop` row, press **Enter**, check the command (`~/.agentreceipt/bin/agentreceipt-hook codex`), and press **t** to trust it.
3. Press **Esc** twice and work as normal.

You can review it again anytime with `/hooks`. Upgrading agentreceipt (re-running `init`) doesn't ask for trust again: the hook always calls a stable shim at `~/.agentreceipt/bin/agentreceipt-hook`, and only the shim's target changes.

## Claude Code (experimental)

Tested end-to-end with Claude Code 2.1.301, both headless (`claude -p`) and in the interactive TUI, running on DeepSeek's Anthropic-compatible API. Two cases passed: blocked, then the agent fixed the code and the stop was allowed (PASS); and the block limit was reached (RED). Logs are in [`e2e/claude/`](https://github.com/mulanxizhizi-png/agentreceipt/tree/main/e2e/claude). Not yet tested on an official Anthropic subscription.

First run in the interactive TUI: there's no separate hook approval. Hooks in `.claude/settings.local.json` run once you trust the folder.

1. Claude Code's own first-run screens (theme, security notes) appear only on a brand-new Claude Code install.
2. **"Accessing workspace … Is this a project you created or one you trust?"** The default is *No, exit*. Pick **Yes, I trust this folder**.
3. Work as normal. When tests fail at a stop, you'll see `Ran 1 stop hook` / `Stop hook error: agentreceipt: you tried to finish, but npm test failed …`. "Error" is just how Claude Code labels a blocking stop hook. Claude then keeps working, and when it finishes you get a `Stop says:` message with the receipt. `/hooks` lists the hook.

- `init` adds a `Stop` hook to `.claude/settings.local.json`. This file is per-machine and not committed, and `init` makes sure git ignores it (see [What goes in git](#what-goes-in-git)). The hook contains an absolute path, so it never goes into the shared `.claude/settings.json`. Use `--claude-scope user` to put it in `~/.claude/settings.json` instead (respects `CLAUDE_CONFIG_DIR`). Other keys in the file are kept.
- If tests fail, the hook returns `{"decision":"block","reason":"..."}`. Claude Code then keeps working, using the reason as feedback.
- The claim comes from `last_assistant_message`, or from the last assistant text in `transcript_path` (JSONL).
- `stop_hook_active` is used to avoid infinite loops. Continuations count toward `maxBlocks`, and a fresh turn (`stop_hook_active: false`) resets the count. Claude Code's own 8-continuation cap is a second backstop.
- To install for only one agent: `--agent codex` or `--agent claude`.

## Options

```
agentreceipt init [--test "<cmd>"] [--agent codex|claude|all] [--claude-scope local|user] [--timeout 300] [--max-blocks 3]
```

`.agentreceipt/config.json`:

| key | default | meaning |
| --- | --- | --- |
| `testCommand` | detected | shell command run from the repo root; exit 0 = pass |
| `timeoutSec` | 300 | longer runs are killed and count as a failure. Number > 0 |
| `maxBlocks` | 3 | times per turn the agent can be sent back before it's allowed to stop (RED). Integer ≥ 0; 0 = receipts only, never block |
| `cleanEnv` | false | verify in a cleaner environment. Python: point `PYTHONPYCACHEPREFIX` at a fresh empty temp dir and set `PYTHONDONTWRITEBYTECODE=1`, so a stale `__pycache__/*.pyc` can't make broken source pass |
| `criteriaFiles` | none | extra globs (`*`, `**`, `?`) for files that define your checks, e.g. `["ci/**/*.sh"]`. Changes to them add the "verification criteria changed" notice |
| `ignore` | none | extra globs for generated files to leave out of change detection, e.g. `["build/", "*.log"]`. Always ignored by default: `__pycache__/`, `*.pyc`, `*.pyo`, `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`, `.tox/`, `.nox/`, `*.egg-info/`, `node_modules/.cache`, `.coverage`, `coverage/`, `htmlcov/`, `.nyc_output`. The GitHub Action reads the same `ignore`/`criteriaFiles`, so CI and local receipts agree |

## What goes in git

- **Commit** `.agentreceipt/config.json` (the team-shared test command, timeout and block limit) and `.agentreceipt/.gitignore`, so teammates' receipts are ignored too.
- **Not committed:** `.agentreceipt/receipts/`, `.agentreceipt/state/` and `.claude/settings.local.json`. `init` lists them in a marked block in `.git/info/exclude` (`# >>> agentreceipt` … `# <<< agentreceipt`), so `git status` stays clean without touching your `.gitignore`. `uninstall` removes only that block. In a linked worktree this goes to the shared repo's `info/exclude` (the one git actually reads).

## Receipts

Every check writes `.agentreceipt/receipts/<timestamp>-<status>.json` (not committed) and prints a readable receipt. `agentreceipt last` shows the latest one.

Status: `green` (tests pass), `blocked` (agent sent back), `red` (block limit hit, stopped with failing tests), `error` (agentreceipt itself couldn't verify, e.g. invalid config, a test command that can't start or isn't found (exit 127), or receipts that can't be written; the stop is allowed and a warning is shown).

```json
{
  "schemaVersion": 1,
  "agent": "codex",
  "status": "red",
  "decision": "allow",
  "claim": "Done, all tests pass.",
  "tests": { "command": "npm test", "passed": false, "exitCode": 1, "timedOut": false, "durationMs": 412,
             "outputBytes": 1830, "logPath": "/repo/.agentreceipt/receipts/2026-10-16T08-00-00-000Z-a1b2c3.log", "outputTail": "..." },
  "git": { "head": "3f2c…", "base": "9a1e…", "commitsSinceBase": 1 },
  "fingerprint": { "before": "sha256:…", "after": "sha256:…", "changedDuringTests": false },
  "config": { "fingerprint": "sha256:…", "changedSinceLastVerified": false },
  "warnings": [],
  "diff": { "base": "9a1e…", "filesChanged": 1, "insertions": 3, "deletions": 1, "files": [{ "path": "src/pricing.js", "status": "modified" }], "testFilesChanged": [] },
  "blocks": { "count": 1, "max": 1 }
}
```

- `testFilesChanged` flags agents that edit the tests instead of the code. The block message warns them too.
- **Diff base:** changes are measured from the commit at the last allowed stop (or at `init`), so code the agent *committed* still shows up. `git.head` is the commit that was tested.
- **Fingerprint:** the code on disk is hashed before and after the test run. If it changed while tests ran, the receipt is never green (blocked, or red at the limit).
- **Full log:** the complete test output is saved next to the receipt (`tests.logPath`, capped at 50 MB). The receipt and the block message keep the start and the end of the output, so an early assertion isn't lost under noise.
- **Verification criteria notice:** if the change touches files that define what "the tests" are, the receipt says *Verification criteria changed, review needed* (`verificationCriteria`). That covers runner configs and test entry points: `Makefile`/`*.mk`, `package.json` (scripts), `justfile`, `noxfile.py`, `tox.ini`, `pytest.ini`, `pyproject.toml`, `setup.cfg`, `conftest.py`, `scripts/test*`, CI workflows, `.agentreceipt/config.json`, and any `criteriaFiles` globs. It's a notice for you to review. It never blocks, and it doesn't stop an agent running with your permissions from bypassing the checks.
- **Execution context:** for Python projects (or with `cleanEnv`), `environment.python` records the interpreter (`executable`, `version`) the tests ran with, and the receipt shows it.
- **Config warning:** if `.agentreceipt/config.json` changed since the last allowed stop (e.g. the test command was swapped), the receipt carries a warning and the agent/user sees it. It warns; it does not block.
- Paths are read with `git -z`, so non-ASCII, spaces and renames are reported exactly.

## With agentundo: go back to when tests passed

If [agentundo](https://github.com/mulanxizhizi-png/agentundo) is also set up in the project, every receipt records the agentundo snapshot of the state it verified:

- **Green** receipts mark that snapshot as *last known good*.
- **Red/blocked** receipts include a ready-to-run command that returns the project to the last state where the tests passed:

```
 Snapshot: agentundo #9
 Go back:  ~/.agentundo/bin/agentundo restore 4  (last state where tests passed, #4)
```

The same data is in the JSON receipt under `undo` (`snapshotId`, `lastKnownGood`, `lastGreenSnapshotId`, `restoreCommand`) and in the PR comment. The command is shown only to you; the agent is never told to restore. `agentundo list` marks snapshots with green or red receipts.

The two tools don't depend on each other. Without agentundo, receipts are unchanged. agentreceipt calls agentundo's CLI with a short timeout, and any problem is ignored. Set `AGENTRECEIPT_NO_UNDO=1` to turn the integration off.

## GitHub Action (free)

Runs your tests on every pull request, writes a receipt in the same JSON format (`agent: "ci"`, with the PR title and body as the claim), and posts a single PR comment that is updated on every push. The check fails when tests fail.

```yaml
# .github/workflows/agentreceipt.yml
name: agentreceipt
on: pull_request
permissions:
  contents: read
  pull-requests: write   # for the receipt comment
jobs:
  receipt:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 2 }   # lets the receipt show the PR diff
      - uses: actions/setup-node@v4   # plus whatever your tests need
        with: { node-version: 20 }
      - uses: mulanxizhizi-png/agentreceipt@main
        # with:
        #   test-command: npm test   # default: .agentreceipt/config.json, else auto-detect
        #   timeout: 600             # seconds
        #   comment: true            # post/update the PR comment
        #   github-token: ${{ github.token }}
```

Outputs: `status` (`green`/`red`) and `receipt-path`. The receipt is also added to the job summary. No dependencies; it uses the runner's Node.

## Uninstall

```
npx github:mulanxizhizi-png/agentreceipt#v0.1.4 uninstall
```

By default this only affects the **current project**: it removes the hook from `.claude/settings.local.json` (and any legacy entry in `.claude/settings.json`) and the agentreceipt block in `.git/info/exclude`.

`uninstall` removes this project's hooks and generated files (`.agentreceipt/receipts/`, `state/`, `logs/`, the ignore block); `.agentreceipt/config.json` is kept (it's team-shared), and the folder is removed if nothing else is left. At the end it prints, per project, what was deleted and what was kept.

The shared pieces (the Codex hook in `~/.codex/hooks.json`, the hook in `~/.claude/settings.json`, and `~/.agentreceipt/runtime` + `bin`) are used by every project you ran `init` in, so they are kept while another project still has agentreceipt set up, and removed automatically when you uninstall the last one. Files without an agentreceipt hook are left untouched; backups of edited settings stay in `~/.agentreceipt/backups/`.

- `uninstall --global` removes the shared pieces right away. The current project is cleaned as above; every other registered project loses its hook, state and logs but **keeps its receipts**, and keeps the `.git/info/exclude` rule for `.agentreceipt/receipts/` so `git status` stays clean there.
- `uninstall --purge` does the same and also deletes receipts in every project. It always lists the affected projects (including ones whose receipts were kept by an earlier `--global`) and asks for confirmation, even when only one project is involved; pass `--yes` to skip the prompt. Answering anything but `y` aborts with exit code 1. Without a terminal and without `--yes` it refuses (exit 1) and changes nothing.

MIT licensed.
