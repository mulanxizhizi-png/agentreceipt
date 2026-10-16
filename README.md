# agentreceipt

**Your coding agent says "done". Make it show a receipt.**

agentreceipt adds a Stop hook to your coding agent. When the agent tries to finish, the hook runs your tests and checks the git diff. If the tests fail, the agent is sent back to work with the failure output. After a set number of blocks it's allowed to stop, and the receipt is marked **RED**.

![red receipt](https://raw.githubusercontent.com/mulanxizhizi-png/agentreceipt/main/e2e/red-receipt.png)

*Real output from Codex 0.163.0: the agent claimed "all tests pass", got blocked once, then stopped with the tests still failing.*

## Install

In your project (git repo):

```
npx github:mulanxizhizi-png/agentreceipt init
```

`init` finds your test command (`package.json` test via npm/pnpm/yarn/bun, pytest, cargo, go, `make test`), or asks you for it. It writes `.agentreceipt/config.json` and installs the hook. The runtime is copied to `~/.agentreceipt/runtime/<version>/` (behind a stable shim in `~/.agentreceipt/bin/`) so the hook keeps working after npx clears its cache. Requires Node 18 or newer. No dependencies.

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
| `timeoutSec` | 300 | longer runs are killed and count as a failure |
| `maxBlocks` | 3 | times per turn the agent can be sent back before it's allowed to stop (RED) |

## What goes in git

- **Commit** `.agentreceipt/config.json` (the team-shared test command, timeout and block limit) and `.agentreceipt/.gitignore`, so teammates' receipts are ignored too.
- **Not committed:** `.agentreceipt/receipts/`, `.agentreceipt/state/` and `.claude/settings.local.json`. `init` lists them in a marked block in `.git/info/exclude` (`# >>> agentreceipt` … `# <<< agentreceipt`), so `git status` stays clean without touching your `.gitignore`. `uninstall` removes only that block.

## Receipts

Every check writes `.agentreceipt/receipts/<timestamp>-<status>.json` (not committed) and prints a readable receipt. `agentreceipt last` shows the latest one.

Status: `green` (tests pass), `blocked` (agent sent back), `red` (block limit hit, stopped with failing tests).

```json
{
  "schemaVersion": 1,
  "agent": "codex",
  "status": "red",
  "decision": "allow",
  "claim": "Done, all tests pass.",
  "tests": { "command": "npm test", "passed": false, "exitCode": 1, "timedOut": false, "durationMs": 412, "outputTail": "..." },
  "diff": { "filesChanged": 0, "insertions": 0, "deletions": 0, "files": [], "testFilesChanged": [] },
  "blocks": { "count": 1, "max": 1 }
}
```

`testFilesChanged` flags agents that edit the tests instead of the code. The block message warns them too.

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
npx github:mulanxizhizi-png/agentreceipt uninstall
```

This removes the hooks from `~/.codex/hooks.json`, `.claude/settings.local.json`, `~/.claude/settings.json` and any legacy entry in `.claude/settings.json` (files without an agentreceipt hook are left untouched), and deletes `~/.agentreceipt/runtime` and `~/.agentreceipt/bin`. Delete `.agentreceipt/` in your repo yourself if you don't want the receipts.

MIT licensed.
