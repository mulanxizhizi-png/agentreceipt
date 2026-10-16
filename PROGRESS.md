# agentreceipt 开发进度

## 第 1 天（10 月 16 日）
- 已完成：
  - 骨架代码写好，在共享电脑 /workspace/agentreceipt：零依赖 Node CLI，`init` 自动探测测试命令（npm/pnpm/yarn、pytest、cargo、go、make），写 `.agentreceipt/config.json`，安装 Codex（~/.codex/hooks.json）和 Claude Code（.claude/settings.json）的 Stop hook。
  - Stop hook：真跑测试（带超时），核对 git 改动，测试没过就返回 block 让 agent 接着干；每个会话最多拦 3 次，超了放行并标红；发现 agent 改了测试文件会警告；每次写一份带版本号的 JSON 收据到 `.agentreceipt/receipts/`，终端打印可读收据。
  - 单元测试 16 个，全部通过（`npm test`）。
  - **Codex 0.163.0 端到端实测通过**：临时仓库里放一个故意写错的 add 函数，让 Codex 谎报「Done, all tests pass.」→ Stop hook 触发并拦住 → Codex 自己去修代码、跑测试 → 第二次停下时测试通过、放行。生成了 BLOCKED 和 PASS 两张真实收据（在 e2e/ 目录）。实测后已把 Codex 配置恢复原样。
- 下午追加：
  - GitHub 仓库已上线：https://github.com/mulanxizhizi-png/agentreceipt ，部署已验证 GitHub 安装可用。
  - uninstall 会顺带删掉 ~/.agentreceipt/runtime；收据的改动统计不再把 agentreceipt 自己生成的文件算进去。单元测试 18 个全过。
  - **真实红色收据**：Codex 真跑（max-blocks 1，让 Codex 不许改代码）→ 拦一次 → 第二次放行并标红。截图在 e2e/red-receipt.png，内容是 hook 原样输出，没有修改，可以交给运营和部署用。
  - **Codex 交互模式实测通过（tmux 驱动 TUI）**：首次启动会弹出「Hooks need review」，选 Review hooks → 选中 Stop → 回车 → 按 t 信任 → Esc 两次。之后拦截、标红都在 TUI 里正常显示。全局 ~/.codex/hooks.json 在交互模式下能触发。
  - README 已重写（安装、Codex 信任步骤、配置、收据格式、卸载，Claude Code 标为实验性、未测试）。
  - 测试后 Codex 配置已清理干净。
- 未完成 / 阻塞：
  - Claude Code 实测需要 Zjing 私聊帮忙登录一次。
- 升级不再需要重新信任：hook 命令固定指向 ~/.agentreceipt/bin/agentreceipt-hook（一个转发脚本），升级时只改脚本里指向的版本，Codex 看到的命令文本不变。实测：0.1.0 信任一次 → 升到 0.1.1 重新 init → 启动 Codex 不再弹「Hooks need review」。没有用到模型额度。
- Claude Code 适配（按官方文档，没有登录实测）：Stop hook 可以装到项目的 .claude/settings.json 或用户的 ~/.claude/settings.json（--claude-scope user）。测试没过时返回 decision: block 加 reason。agent 说了什么，优先读 last_assistant_message，读不到就从对话记录 transcript_path 里取最后一条回复。用 stop_hook_active 防死循环：同一轮里被拦后的续跑计入拦截上限，新一轮重新计数。uninstall 会清掉项目级和用户级两处。单元测试 26 个全过，含 Claude 的输入样例和对话记录样例。
- **Claude Code 实测通过**（Claude Code 2.1.301，headless 模式 claude -p，模型走 DeepSeek 的 Anthropic 兼容接口 deepseek-flash）：
  - (a) 谎报完成 → 被拦 → 自己改 add.js、跑 npm test → 放行，生成 PASS 收据；
  - (b) 上限设为 1 → 拦一次后放行 → 生成 RED 收据；
  - (c) uninstall 后项目级和用户级 settings 都恢复原样，原有配置保留；我们自己建的空 .claude 目录也会删掉（这次实测发现并修好的小问题）。
  - 两次运行合计约 0.22 美元（Claude Code 按 Anthropic 价格估算，DeepSeek 实际扣费更低）。记录在 e2e/claude/，提交前确认过不含密钥。
  - 还没测：Anthropic 官方订阅、交互界面（TUI）。
- 待办：init 交互体验打磨。
