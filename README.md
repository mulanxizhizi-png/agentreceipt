# agentreceipt

Your coding agent says "done". Make it show a receipt.

agentreceipt installs a **Stop hook** for Codex (and Claude Code). When the agent tries to finish, it runs your tests and checks the git diff. If tests fail, the agent is sent back to work with the failure output. After a max number of blocks (default 3) it is allowed to stop and the receipt is marked **RED**.

```
npx github:mulanxizhizi-png/agentreceipt init
```

- Auto-detects the test command (`package.json` test, pytest, cargo, go, make). Otherwise asks, or pass `--test "<cmd>"`.
- Options: `--agent codex|claude|all`, `--timeout 300` (seconds), `--max-blocks 3`.
- Codex: hook goes to `~/.codex/hooks.json` (global; it no-ops in repos without `.agentreceipt/config.json`). Open `/hooks` in Codex once to trust it.
- Claude Code: hook goes to `.claude/settings.json` in the repo.
- Every check writes a versioned JSON receipt to `.agentreceipt/receipts/` and prints a readable one.
- Flags when the agent edited test files.

`agentreceipt last` prints the latest receipt; `agentreceipt uninstall` removes the hooks.

```
--------------------------------------------
 AGENT RECEIPT
--------------------------------------------
 Status:   BLOCKED  agent sent back to work
 Agent:    codex
 Claimed:  Done, all tests pass.
 Tests:    npm test -> failed (exit 1) in 0.4s
 Diff:     0 files, +0 -0
 Blocks:   1/3
--------------------------------------------
```

MIT licensed. Zero dependencies, Node >= 18.
