# agentreceipt 开发进度

## v0.1.4（10 月 16 日晚，开发和调试）：生成产物不再算作改动
- **部署复测发现的问题**：Python 项目如果没在 `.gitignore` 里忽略 `__pycache__`，跑测试会生成 `__pycache__/*.pyc`，代码指纹在测试前后不一致，第一次测试明明通过也被拦下。
- **修复**：变化检测（测试中代码变化的指纹、改动文件统计、测试文件改动、验证标准变化提示）默认忽略生成产物：`__pycache__/`、`*.pyc`、`*.pyo`、`.pytest_cache/`、`.mypy_cache/`、`.ruff_cache/`、`.tox/`、`.nox/`、`*.egg-info/`、`node_modules/.cache`、`.coverage`、`coverage/`、`htmlcov/`、`.nyc_output`。项目可以用配置项 `ignore`（glob 数组）再加自己的规则，格式不对时会给出 error 收据。
- **回归测试** `test/generated.test.js`：复现部署的场景（Python 项目、没有 `.gitignore`、测试时生成 pyc 和覆盖率文件），第一次就是绿色、不拦截；在旧代码上这个测试会失败。另有默认规则和 `ignore` 配置的测试。全部 77 个测试连跑 10 次都通过。
- 版本号改为 0.1.4；v0.1.3 仍以 `08869ef` 为准，这次只追加了新提交。

## v0.1.3（10 月 16 日晚，开发和调试）：Python 文档索引测试报告的两个发现
- **验证入口文件纳入“验证标准已变化”提示（报告场景 13）**：新增 `Makefile`、`*.mk`、`justfile`、`noxfile.py`、`conftest.py`、`scripts/test*`、`Taskfile.yml`，原有的 `package.json`、`tox.ini`、`pytest.ini`、`pyproject.toml`、`setup.cfg` 也都在内。项目还可以在配置里用 `criteriaFiles`（glob）声明自己的验证规则文件。这只是提示，不拦截。报告里“把 Makefile 的 test 目标换成 echo”那种情况，现在收据还是绿色，但会提示“验证标准已变化，需复核”。
- **可选的干净环境 `cleanEnv`（报告场景 12）**：开启后，验证时把 `PYTHONPYCACHEPREFIX` 指向一个新建的空临时目录，并设置 `PYTHONDONTWRITEBYTECODE=1`，旧的 pyc 就骗不过去了。复现“旧时间戳 pyc 和坏源码并存”：不开时是绿色（已写成测试，作为已知缺口的记录），开了以后变成 blocked/red。Python 项目的收据会记下解释器路径和版本。
- 注意：上级派活时说的场景 12、13 和报告里的编号正好相反，这里按报告的编号写。
- 这台机器上没有装 make，所以真用 `make test` 跑的那个测试会自动跳过；另外有一个不依赖 make 的测试，验证 Makefile 改动会触发提示。
- README 写明已在 Linux 和 macOS 上测过（macOS 是用户用 Codex 在 Python 项目上实测的）。

## v0.1.3（续）：和 agentundo 打通
- 项目里装了 agentundo 时，每张收据都会记下验证那一刻对应的 agentundo 快照编号（JSON 里的 `undo` 字段）。绿色收据把这张快照标成“最后一次测试通过”；红色和 blocked 收据会多一行“Go back”，给出回到最后一次测试通过状态的命令，比如 `~/.agentundo/bin/agentundo restore 4`。这个命令只给用户看（收据和 PR 评论），不会写进发给 agent 的拦截理由。
- 两个工具互不依赖：没装 agentundo 时收据和以前完全一样。调用 agentundo 有 8 秒超时，出任何错都忽略。设 `AGENTRECEIPT_NO_UNDO=1` 可以关掉。
- 新增 4 个测试，包括跨工具端到端：两个都装上，先绿后红，再执行收据里的命令，确认回到绿色状态，并且收据文件没被恢复操作删掉。全部 67 个测试连跑 3 次都通过。
- v0.1.2 仍以 `ea7b259` 为准，这次只在 main 上追加了新提交，不影响部署给 ea7b259 打 tag。

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
  - **交互界面（TUI，用 tmux 驱动）也测通了**：Claude Code 不会单独让用户批准 hook，只要信任了这个文件夹，hook 就会运行。第一次运行看到的依次是：选主题 → 安全提示（这两步只有新装 Claude Code 才有）→「是否信任此文件夹」（默认选项是「No, exit」，要选「Yes, I trust this folder」）。之后谎报完成会显示「Stop hook error: agentreceipt: …npm test failed」（Claude Code 对拦截一律标成 error），Claude 接着改代码、跑测试，最后显示「Stop says:」加 PASS 收据。用 DeepSeek 时还会多弹一个 auto mode 计费提示，按回车关掉就行，官方订阅不会有这个提示。截屏在 e2e/claude/interactive-tui.txt。
  - 按要求改了安装位置：Claude Code 的 hook 现在写到 .claude/settings.local.json（只在本机，不提交），并加到 .git/info/exclude 让 git 忽略，不改用户仓库里的文件；uninstall 也会清掉旧版本写进 .claude/settings.json 的条目。另外去掉了会留在项目里的 .bak 备份文件。
  - 还没测：Anthropic 官方订阅。
- npm 发布准备好了（**还没发布**）：package.json 补齐了 files 白名单（只打包 bin/、src/、README、LICENSE，不含 e2e、测试、spike）、engines（node>=16，实测 Node 16 和 20 都能跑）、MIT 许可（版权人 Zjing / mulanxizhizi-png）、主页、仓库、问题反馈地址、关键词和描述。npm pack 出来 13 个文件，压缩后 11.7 kB。在干净目录里装 tarball 跑了一遍 init → hook 拦截 → last → uninstall，全部正常；npx github: 安装也确认还能用。README 里的图片改成绝对链接，npm 页面上也能显示。
- git 状态更干净：init 把 receipts/、state/、.claude/settings.local.json 写进 .git/info/exclude 里一个带标记的区块（# >>> agentreceipt … # <<< agentreceipt），uninstall 只删这个区块，用户自己写的同样内容不受影响。.agentreceipt/config.json 可以提交给团队共用（README 已说明）。
- **免费 GitHub Action 做好了**（仓库根目录 action.yml，零依赖）：每个 PR 跑一遍测试，生成同一格式的收据（agent: ci，用 PR 标题和描述当「声称」），在 PR 下发一条评论并在每次推送后原地更新，测试没过就让检查失败。真实测试：在临时私有仓库 mulanxizhizi-png/agentreceipt-action-test 开了一个改坏代码的 PR → 检查失败，评论显示 RED；推送修复 → 检查通过，同一条评论更新为 PASS（始终只有 1 条评论）。证据在 e2e/action/。
  - 临时仓库**还没删**：gh 登录缺少 delete_repo 权限，需要 Zjing 手动删，或者授权 delete_repo 后由我来删。
- 待办：init 交互体验打磨；Zjing 网络方便时 npm publish。

## v0.1.1（10 月 16 日，按外部 Codex 评审修复，第一批）
- 已有的 hooks.json / settings 文件如果是坏的 JSON，init 直接报错退出，一个字节都不改；修改前先把原文件备份到 ~/.agentreceipt/backups（不留在项目里）。
- 启动脚本和 hook 命令改用 shell 单引号转义：路径里有空格、$、$(...)、反引号、引号也不会被执行。
- 卸载时只删我们自己的 hook（命令格式和 statusMessage 都要精确匹配），别人的 hook 即使名字里带 agentreceipt 也不动。
- npm test 改成显式的 test/*.test.js（修复 Node 24 上跑不起来）；engines 统一为 node>=18。
- maxBlocks / timeout 填了非法值（-1、abc 等）：init 报错；hook 生成 error 收据并给出可见警告，不再悄悄标红放行。
- hook 自身出错（配置坏了、收据写不进去、测试命令启动不了或找不到）：仍然放行，不困住 agent，但会尽量写一张 error 收据，并在 systemMessage 和 stderr 里给出警告。
- 会话 id 改为哈希后做文件名，不同会话不会撞上；同一会话的并发 Stop 加锁串行，计数正确。
- 单元测试 43 个全过；外部探针复测：上述 7 项全部转为已修复，中文路径和 bun.lock 留到第二批。

## 2026-10-16 v0.1.1 batch 2 (Codex review)
- git paths via `-z` (unicode/tab/newline/renames exact); bun.lock + packageManager detection; linked worktree uses common-dir info/exclude.
- uninstall: current project by default; shared runtime/global hooks kept while other registered projects (~/.agentreceipt/projects.json) use them, removed with the last one or `--global`.
- receipts: git head/base/commitsSinceBase (diff from last allowed stop / init, fixes zero diff after agent commits), pre/post code fingerprint (drift during tests => never green), full log file + head/tail, config fingerprint warning.
- 51 tests green on Node 20 + 24; probe + lab retest rerun: lab 06/09/10/12/13 limitation assertions now fail (= fixed), 07 now warns.

## 2026-10-16 #22 偶发失败修复
- 根因：测试命令打印大量输出后立刻 `process.exit()`，Node 子进程写到非阻塞管道里还没写出去的数据会被直接丢掉；父进程读得慢时（CI 繁忙）就丢尾部。这是真实产品问题：receipt 会丢测试日志尾部。
- 修复：子进程 stdout/stderr 直接写入日志文件（同步写，不丢数据），结束后从文件读取 head + tail。新增回归测试（旧代码 5/5 失败，新代码 0 失败）。
- 验证：Node 20 全量 40 次 0 失败，Node 22 全量 40 次 0 失败，#22 单测 100 次 0 失败。

## 2026-10-16 验证标准变化提示
- 测试文件、检查命令/配置（.agentreceipt/config.json、CI workflow、package.json、jest/vitest/pytest 配置等）变化时，receipt 新增 `verificationCriteria` 字段（changed、reasons、configFingerprint），并在人类可读回执、agent 反馈、PR 评论中以中性提示显示「验证标准已变化，需复核 / Verification criteria changed, review needed」。
- 只做提示，不改变 status（场景 08 仍不阻断）。新增 3 个测试，共 55 个；Node 20 / Node 22 并行各跑 40 次，0 失败。

## 2026-10-16 v0.1.2：卸载时清理生成文件
- 问题（部署干净环境实测发现）：卸载后 `.git/info/exclude` 的忽略规则被删，但 `.agentreceipt/` 里的收据、状态文件还在，`git status` 多出一堆未跟踪文件。
- 修复：`uninstall` 会删除 `.agentreceipt/` 下的 `receipts/`、`state/`、`logs/`，以及 init 自动生成且未被提交的 `.gitignore`，只保留 `config.json`；没有 `config.json` 时整个目录删掉。`uninstall --global` 对所有已登记的项目都做同样清理。
- 卸载后 `git status` 里与 agentreceipt 相关的只剩 `.agentreceipt/config.json`（如果它没提交过）。
- 新增 3 个测试，共 58 个；Node 20 连跑 20 次全绿。版本号升到 0.1.2（tag/release 由部署来做）。

## 2026-10-16 v0.1.2 补充：`--global` 保留其他项目的收据，新增 `--purge`
- `uninstall --global`：当前项目照旧清干净，只留 `config.json`；其他登记过的项目删掉 hook、state 和 logs，**保留收据**，同时保留 `.git/info/exclude` 里忽略收据的那一条规则，那边的 `git status` 仍然干净。
- 新增 `uninstall --purge`：在 `--global` 的基础上把所有项目的收据也删掉。执行前先列出受影响的项目，要求确认（或加 `--yes`）；不在终端里运行又没加 `--yes` 时会拒绝执行，什么都不改。
- 卸载结束后逐个项目打印：删了什么、保留了什么。
- README 和帮助文本已更新；新增测试，共 60 个，Node 20 连跑 20 次全绿。

## 2026-10-16 v0.1.2 修复：`--purge` 三个问题（部署复测 22c2c9e 发现）
- 问题 1（非终端、没加 `--yes` 却照样执行了）：原因是只在「还有其他登记项目」时才确认，只剩当前一个项目时直接跳过确认。现在 `--purge` 一律要确认，与项目数量无关；非终端又没加 `--yes` 时拒绝执行，退出码 1，什么都不改。
- 问题 2（`--global` 之后 `--purge` 找不到保留了收据的项目）：原因是 `--global` 删 runtime 时把登记表 `projects.json` 整个删了。现在保留收据的项目会以 `receiptsOnly` 登记下来，`--purge` 会把它们一起列出并清理，清理完再从登记表移除。
- 问题 3（真终端里看不到项目列表和确认提示）：和问题 1 是同一个原因。现在用真实伪终端测试：输入 n 时显示「Aborted; nothing changed.」，退出码 1，什么都不改；输入 y 时执行清理。
- 新增 3 个回归测试，按部署的 A/B/C 步骤复现，其中一个用 python pty 跑真实终端；共 63 个，Node 20 连跑 20 次全绿。
