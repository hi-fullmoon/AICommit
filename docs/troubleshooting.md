# Troubleshooting matrix / 故障排查矩阵

Start with credential-free inspection, then run live diagnostics only when provider access is intended:

先执行无凭据检查；只有确实需要访问 provider 时才运行在线诊断：

```bash
aicommit config path
aicommit config validate --output=json
aicommit config show --output=json
aicommit doctor --output=json
```

JSON mode keeps one machine object on stdout and diagnostics on stderr. The `error.category` and process exit code are stable automation inputs.

JSON 模式保证 stdout 只有一个机器对象，诊断进入 stderr。`error.category` 与进程退出码可稳定用于自动化。

| Symptom / 症状                                                                  | Category / exit                 | Likely cause / 常见原因                                                                                                         | Check and recovery / 检查与恢复                                                                                                                         |
| ------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config fails before Git/provider access / 在 Git/provider 前配置失败            | `config` / `2`                  | Malformed JSON, invalid URL, unsupported option, missing credential / JSON 损坏、URL 或选项无效、凭据缺失                       | `aicommit config path`; `aicommit config validate`; fix only the user-owned file shown                                                                  |
| Project settings are ignored / 项目设置被忽略                                   | warning                         | Repository config tried to set endpoint, credential, reasoning, or raise a ceiling / 仓库配置尝试设置连接、凭据、推理或提高预算 | Move trusted connection settings to `~/.aicommit/config.json`; keep team rules in `.aicommit.policy.json`                                               |
| Not a Git repository, conflict, empty index / 非仓库、冲突或 index 为空         | `git_state` / `3`               | Wrong directory or unsafe Git state / 目录错误或 Git 状态不安全                                                                 | `git status`; `aicommit /absolute/repo/path`; resolve conflicts before retrying                                                                         |
| DNS, connection, or timeout / DNS、连接或超时                                   | `network` / `4`                 | Endpoint unavailable, proxy/TLS issue, budget too short / endpoint 不可达、代理/TLS、超时过短                                   | `aicommit doctor -p NAME`; verify HTTPS URL; raise user-owned `timeoutMs` only if expected                                                              |
| HTTP authentication/rate/parameter failure / 鉴权、限流或参数失败               | `provider` / `5`                | Wrong key/model/body; non-retryable 4xx / key、model、body 错误                                                                 | Check `apiKeyEnv`, model and compatibility table; authentication is never retried automatically                                                         |
| Empty or malformed model reply / 空或畸形回复                                   | `response_format` / `6`         | Unsupported response dialect, token limit, or policy validation failure / 响应方言、token 限制或 policy 校验失败                | Raise `maxTokens`, choose the matching adapter, inspect validator issue code; one correction is already attempted                                       |
| `split run --scope=all --yes` stops before API call / split 非交互在 API 前停止 | `sensitive_data` / `7`          | Complete untracked scan found sensitive-looking data / 完整未跟踪扫描发现疑似敏感数据                                           | Review/stage intended files explicitly; do not bypass without checking the actual content                                                               |
| Commit aborts after generation / 生成后提交中止                                 | `concurrent_modification` / `8` | Index/worktree changed during the protected window / 受保护窗口中 index/worktree 被修改                                         | Review `git status`, restore the intended snapshot, and generate again                                                                                  |
| Split stopped after one or more commits / split 部分提交后停止                  | reported Git failure            | Hook, crash, SIGINT, or concurrent pending edit / hook、崩溃、中断或待处理文件变化                                              | Run `aicommit split resume`; if another Git workflow already replaced the transaction, use `aicommit split abort`（只删除恢复元数据，不改提交或工作区） |
| `aicommit update` refuses the installation / update 拒绝当前安装                | `config` / `2`                  | Source checkout, npm link, or another active Node/npm environment / 源码、npm link 或当前是另一套 Node/npm 环境                 | Activate the Node environment that installed AICommit, or run `npm install --global @hifullmoon/aicommit@latest` manually                               |
| `aicommit update` cannot reach npm / update 无法访问 npm                        | `network` / `4`                 | Registry authentication, proxy, DNS, or network failure / registry 鉴权、代理、DNS 或网络失败                                   | Check `npm config get registry` and npm authentication/proxy settings, then retry                                                                       |
| npm provenance is absent or invalid / npm provenance 缺失或失败                 | npm audit failure               | Old npm CLI, non-trusted release, or wrong version / npm 过旧、非可信发布或版本错误                                             | Upgrade npm; run `npm audit signatures`; install only a version linked to the official workflow                                                         |

If a failure remains, capture `aicommit doctor --output=json`, Node/Git versions, the error category, and redacted config sources. Never attach a diff, commit message, config file, API key, reasoning trace, or credential-helper output to a public issue.

若问题仍未解决，请记录 `aicommit doctor --output=json`、Node/Git 版本、错误分类与脱敏后的配置来源。不要在公开 issue 中附加 diff、commit message、配置文件、API key、reasoning 或 credential-helper 输出。

## Large-change limits / 大变更限制

Default `auto` analysis builds a local inventory and selects bounded excerpts, then batches oversized split inventories and merges their plans hierarchically. Deep analysis still has fixed request (256) and depth (8) limits. If its aggregate token/time budget is exhausted or hierarchical planning cannot converge, split mode emits an explicit warning and can fall back to one complete all-files plan; it never uses a partial model plan. Interactive and dry-run flows show that plan, while non-interactive committing requires the explicit `--allow-single-fallback` option. Token/time limits remain configurable in personal settings. Unknown model token counts use conservative estimates; an oversized request is not dispatched, and provider-context errors are not blindly replayed.

默认 `auto` 在本地建立清单并选择受限片段；拆分候选过多时会分批请求，再分层合并计划。深度分析仍有固定的请求数（256）和汇总层级（8）上限。如果总 token/时间预算耗尽，或分层规划无法收敛，拆分模式会明确警告，并可降级为一个覆盖全部文件的计划，绝不会采用模型返回的半份计划。交互和 dry-run 流程会展示该计划；非交互提交必须显式传入 `--allow-single-fallback`。token 和时间预算仍可在个人配置中调整。未知模型采用保守 token 估算，单次输入超限时不会发送该请求；Provider 上下文超限不会盲目重试。

Validated initial `deep` chunks are cached under private Git metadata after a failed or interrupted run. A retry of the identical snapshot and model settings reports cached chunks and requests only the remainder. Any input/model/protection change causes a miss. Successful generation clears the active cache; stale entries expire after 24 hours. Unprotected input is not cached unless personal `largeChange.cache.allowUnprotected` is explicitly enabled.

失败或中断后，已经通过校验的初始 `deep` 分块会缓存在私有 Git 元数据中。使用相同快照和模型设置重试时会报告缓存命中，并只请求剩余分块；输入、模型或保护模式发生任何变化都会失效。完整生成成功后清理当前缓存，遗留项 24 小时后过期。未保护内容只有在个人配置显式启用 `largeChange.cache.allowUnprotected` 时才缓存。

Text lines over 1 MiB fail explicitly. Large-change hunk plans are unsupported; use file-level split. Metadata-only files remain in the complete plan. Invalid provider output remains a response-format error; only deterministic budget/capacity exhaustion activates the complete all-files fallback.

单行超过 1 MiB 会明确报错。大变更暂不支持 hunk 规划，请使用文件级拆分。仅统计的文件仍纳入完整计划。无效、重复或遗漏 ID 会报响应格式错误，不会自动归入兜底组。
