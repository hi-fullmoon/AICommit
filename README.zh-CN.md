# AICommit

[English](README.md) | 简体中文

AI 驱动的 Git 提交信息生成器：读取 diff，请 AI 模型生成符合 Conventional Commits 规范的提交信息，并在你确认后执行提交。

## 安装

使用 npm：

```bash
npm install --global aicommit
```

或使用 Homebrew：

```bash
brew tap hi-fullmoon/aicommit https://github.com/hi-fullmoon/AICommit.git
brew install hi-fullmoon/aicommit/aicommit
```

需要 Node.js >= 18。

安装、升级、签名校验与回滚请参阅双语[分发指南](docs/distribution.md)。npm 和 Homebrew 两条安装路径都有自动化安装冒烟测试。

如需直接安装源码检出版本，请在仓库根目录运行 `npm install --global .`。

## 配置

最快的方式是使用交互式向导：

```bash
aicommit setup
```

向导会引导你从当前生效的版本化预设清单中选择 Provider（内置预设包括 OpenAI、DeepSeek、OpenRouter、MiniMax、Kimi Code 和 Ollama），或填写自定义 OpenAI 兼容端点；随后输入 API Key 和模型、选择提交信息语言，并可选测试连接。配置会原子写入用户配置文件 `~/.aicommit.config.json`；如果已有文件格式错误，替换前会先备份。

如需手动配置，请从 [.aicommit.config.example.json](.aicommit.config.example.json) 开始。AICommit 先加载用户配置，再将 `./.aicommit.config.json` 中白名单内的生成偏好深度合并到用户配置之上。项目配置可以设置 `language`、`commitPolicy`、`stripFiles`、`temperature`，也可以降低 diff、token、timeout 或仓库上下文上限。项目拥有的 `prompt` 默认会被忽略，除非用户配置明确设置 `allowProjectPrompt: true`。连接或 Provider 字段（包括 `apiKeyEnv`）、推理请求控制、未知字段，以及任何试图提高上限的配置，都会被忽略并给出警告。这样可以防止克隆的仓库重定向已鉴权请求，或在不知情的情况下扩大成本和数据范围。

如需避免把密钥写入 JSON，请设置 `"apiKeyEnv": "OPENAI_API_KEY"`（并将 `apiKey` 留空），或在 setup 向导中输入 `env:OPENAI_API_KEY`。环境变量优先于所有其他凭据来源，推荐用于 CI 和其他无状态环境。

AICommit 也可以读取操作系统上已经配置的 Git credential helper。启用 `credentialHelper.enabled`，通过常规 Git/系统凭据流程保存 Provider 凭据，AICommit 就会在不弹出输入提示的情况下调用 `git credential fill`。查询用户名默认为 `aicommit`，可通过 `credentialHelper.username` 修改。凭据解析顺序为：环境变量 → Git credential helper → 用户配置中的明文凭据 → 无密钥 localhost。项目配置不能启用 credential helper，也不能选择凭据来源。

可以定义多个 Provider，并在运行时通过 `-p` / `--provider` 切换：

```json
{
  "defaultProvider": "minimax",

  "providers": {
    "minimax": {
      "providerType": "minimax",
      "apiUrl": "https://api.minimaxi.com/v1/chat/completions",
      "apiKeyEnv": "MINIMAX_API_KEY",
      "modelId": "MiniMax-M3",
      "extraBody": {
        "thinking": { "type": "disabled" },
        "reasoning_split": true
      }
    },
    "deepseek": {
      "providerType": "deepseek",
      "apiUrl": "https://api.deepseek.com/v1/chat/completions",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "modelId": "deepseek-v4-flash"
    },
    "openrouter": {
      "providerType": "openrouter",
      "apiUrl": "https://openrouter.ai/api/v1/chat/completions",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "modelId": "openai/gpt-4o-mini"
    },
    "kimi-code": {
      "providerType": "custom",
      "apiUrl": "https://api.kimi.com/coding/v1/chat/completions",
      "apiKeyEnv": "KIMI_API_KEY",
      "modelId": "kimi-for-coding"
    }
  }
}
```

选中 Provider 的配置会深度合并到顶层字段之上，因此共享设置（`language`、`commitPolicy`、`temperature`、`maxTokens` 等）只需配置一次。未指定 `-p` 时使用 `defaultProvider`；如果没有 `defaultProvider`，则使用 `providers` 中的第一项。旧版的扁平单模型配置（顶层 `apiUrl` / `apiKey` / `modelId`，且没有 `providers`）仍然兼容。

| 配置项               | 说明                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `providers`          | 命名 Provider 配置（`apiUrl` / `apiKey` / `modelId` / ...）                                                                             |
| `defaultProvider`    | 未指定 `-p` 时使用的 Provider（原字段名为 `default`）                                                                                   |
| `apiUrl`             | OpenAI 兼容的 Chat Completions 端点                                                                                                     |
| `apiKey`             | API Key；本地模型允许使用空字符串                                                                                                       |
| `apiKeyEnv`          | 保存 API Key 的环境变量名，优先于 `apiKey`（默认：空）                                                                                  |
| `modelId`            | 模型标识符                                                                                                                              |
| `providerType`       | 可选的适配器覆盖：`openai`、`openrouter`、`deepseek`、`minimax`、`ollama`、`custom` 或用户安装的 `extension:<id>`；未设置时根据端点推断 |
| `commitPolicy`       | 版本化提交规则：type、scope、主题长度、正文、破坏性变更和语言                                                                           |
| `prompt`             | 用户批准的可选指导，追加到权威结构化策略之后（默认：空）                                                                                |
| `allowProjectPrompt` | 是否接受项目配置中的 `prompt`，只能由用户配置启用（默认：`false`）                                                                      |
| `repositoryContext`  | 近期提交、包边界、可信约定和 commitlint 检测的总预算与分类预算                                                                          |
| `language`           | 提交信息语言：`zh` 或 `en`（默认：`zh`）                                                                                                |
| `temperature`        | 采样温度（默认：`0.3`）                                                                                                                 |
| `maxTokens`          | 最大响应 token 数（默认：`1024`）                                                                                                       |
| `timeoutMs`          | 单次请求超时，单位为毫秒（默认：`120000`）                                                                                              |
| `retry`              | 瞬时错误重试限制：`maxAttempts`、`baseDelayMs`、`maxDelayMs`（默认：`3`、`500`、`5000`）                                                |
| `credentialHelper`   | 通过 `enabled` 和 `username` 选择性启用 `git credential fill`（默认：`false`、`aicommit`）                                              |
| `metrics`            | 仅本地指标控制：`enabled`、绝对路径 `path`（空表示默认路径）、`maxEntries`（默认：`true`、空、`500`）                                   |
| `extensions`         | 用户拥有的绝对扩展清单路径，以及执行超时和上下文上限；项目配置不能启用或重定向扩展                                                      |
| `maxDiffChars`       | 单次发送给模型的 diff 字符数；超限后改为 `--stat` 摘要和截断的 hunk（默认：`30000`）                                                    |
| `maxFileDiffChars`   | 单文件 diff 上限；超限文件只保留前部 hunk，避免一个大文件挤占全部上下文（默认：`3000`）                                                 |
| `splitMaxDiffChars`  | 拆分规划请求的 diff 字符数；规划阶段需要的 hunk 细节少于最终信息生成（默认：`16000`）                                                   |
| `splitMaxPlanFiles`  | 交给拆分规划器的最大变更文件数；超出部分归入兜底提交（默认：`100`）                                                                     |
| `diffContextLines`   | 每个 diff hunk 周围的上下文行数（`git diff --unified=<n>`）；越小越节省 token（默认：`1`）                                              |
| `stripFiles`         | 额外替换为占位的文件，按 basename 使用 `*` / `?` 通配，如 `["*.min.js", "*.map", "*.snap"]`（默认：`[]`；项目项与用户项合并而非覆盖）   |
| `regenerateWithDiff` | `true` 表示每次重写都重发完整 diff，以获得更多变化；`false`（默认）只要求模型改写上一条消息，成本更低                                   |
| `extraBody`          | 合并到请求体的 Provider 专用 JSON 字段，但不允许覆盖 `model` / `messages`（默认：`{}`）；除非显式配置，标准请求不会发送厂商扩展字段     |
| `reasoning`          | 推理控制：`mode`、`effort`、`maxTokens` 和 `maxDisplayChars`；默认为 `mode: "on"`，并自动流式展示推理                                   |

AICommit 支持 OpenAI、DeepSeek、[OpenRouter](https://openrouter.ai)、MiniMax、[Kimi Code](https://www.kimi.com/code/docs/)、Ollama（原生 `/api/chat` 或 OpenAI 兼容 `/v1/chat/completions`）、LiteLLM，以及其他兼容端点。远程端点必须使用 HTTPS；明文 HTTP 只允许 localhost / loopback。

### Kimi Code 示例

在 Kimi Code 控制台创建 API Key，通过环境变量导出，避免把密钥存入 JSON，然后在 `aicommit setup` 中选择内置预设。手动配置时请使用完整的 OpenAI 兼容端点：

```bash
export KIMI_API_KEY='your-kimi-code-api-key'
```

```json
{
  "defaultProvider": "kimi-code",
  "providers": {
    "kimi-code": {
      "providerType": "custom",
      "apiUrl": "https://api.kimi.com/coding/v1/chat/completions",
      "apiKeyEnv": "KIMI_API_KEY",
      "modelId": "kimi-for-coding"
    }
  }
}
```

首次提交前验证端点、Key 和模型：

```bash
aicommit --check -p kimi-code
```

`kimi-for-coding` 对所有 Kimi Code 会员档位开放，并随服务滚动升级模型。Kimi Code 会员 Key 使用 `api.kimi.com`；Kimi 开放平台按量付费 Key 使用不同端点，两者不能混用。

流式输出、推理、token 预算、usage、鉴权、预设和扩展适配边界，请参阅双语 [Provider 兼容表](docs/provider-compatibility.md)。

### 仓库策略与受限上下文

默认生成契约采用结构化、版本化策略，而不是嵌入自由格式 prompt。用户配置可以替换 `types`、`scope.values` 等声明数组，使规则更严格：

```json
{
  "commitPolicy": {
    "version": 1,
    "types": ["feat", "fix", "docs", "refactor", "test", "chore"],
    "scope": { "mode": "optional", "values": ["api", "cli"] },
    "subject": { "maxLength": 72 },
    "body": { "mode": "optional", "maxLines": 8 },
    "breakingChange": "allow",
    "language": "inherit"
  },
  "allowProjectPrompt": false,
  "repositoryContext": {
    "enabled": true,
    "maxChars": 4000,
    "recentCommits": { "enabled": true, "count": 12, "maxChars": 1000 },
    "packageBoundaries": { "enabled": true, "maxEntries": 40, "maxChars": 800 },
    "conventions": {
      "enabled": true,
      "trustedFiles": ["CONTRIBUTING.md"],
      "maxFiles": 4,
      "maxChars": 1400
    },
    "commitlint": { "enabled": true, "maxChars": 800 }
  }
}
```

每个上下文分类和整个功能都可以独立关闭。`conventions.trustedFiles` 只接受用户配置中的值；路径必须位于仓库内部，并解析为普通的非符号链接文件。项目配置可以关闭来源或降低已有上限，但不能添加可信文件、重新启用用户已关闭的来源，也不能提高任何预算。可识别的 commitlint 标量规则可以设置仓库专用 type / scope 并降低主题长度上限；commitlint 文件只作为数据读取，绝不会执行。调用 Provider 前，终端会显示选中的分类、数量和总字符数。

生成的候选信息会在本地检查策略格式、type / scope、主题和正文上限、破坏性变更标记，以及明确的语言。硬性校验失败后最多发起一次低成本修正请求，并且不会重发 diff。关键词或路径与受限 diff 的一致性只作为提示性警告，因为它属于启发式判断。

如需确定性的团队门禁，请生成并提交不含凭据的严格策略文件，然后在本地 `commit-msg` hook 和 CI 中使用同一校验器：

```bash
aicommit policy template > .aicommit.policy.json
aicommit policy check --file=.git/COMMIT_EDITMSG
aicommit policy check --range=origin/main..HEAD --output=json
```

完整团队策略会在个人设置之后加载。存在团队策略时，`-l` / `--lang` 会被拒绝，而不是覆盖仓库语言。机器输出包含策略指纹和问题代码，但不包含提交信息正文；策略命令从不解析凭据。参阅双语[团队迁移指南和可执行示例](docs/team-policy.md)，以及已发布的 [team-policy schema](schemas/aicommit-team-policy.schema.json)。

### Provider 可靠性

每个 Provider 适配器都会映射同一套生成契约：messages、流式输出、推理控制、输出 token 预算、标准化 usage（`inputTokens`、`outputTokens`、`totalTokens`）和结束原因。通常根据端点自动选择适配器；兼容服务使用自定义域名时可设置 `providerType`。

请求只对瞬时错误重试：HTTP 429、可恢复的 5xx、网络中断和响应体中断。重试次数受 `retry.maxAttempts` 限制，使用带上限的指数退避，并遵循 `Retry-After`。鉴权、非法参数和内容安全错误会立即返回，不会重试。

### 版本化 Provider 预设

setup 默认值保存在严格的清单中，与请求适配器及 Git / 交互流程分离。添加兼容 Provider 只需更新预设数据，并引用已有适配器：

```bash
aicommit preset show
aicommit preset validate --file=provider-presets.json
aicommit preset install --file=provider-presets.json
aicommit preset rollback
```

当前用户清单位于 `~/.aicommit/provider-presets.json`；每次更新都会保留上一份有效版本，以便回滚。清单声明自己的语义版本、支持的核心版本范围和适配器契约版本，并且不能包含凭据。核心预发布版本和构建元数据按 SemVer 规则解析；构建元数据不影响兼容性排序。参阅双语[预设兼容与更新指南](docs/provider-presets.md)及已发布的 [schema](schemas/aicommit-provider-presets.schema.json)。

### 无凭据扩展

AICommit 提供三种最小扩展接口：受限仓库上下文、提交信息校验，以及 Provider 请求 / 响应适配。用户安装的单文件 ESM 扩展在 CLI 进程之外、Node 权限模型下运行，并声明 `credentials: false`；扩展既不会收到已解析凭据，也不会继承秘密环境变量。仓库配置不能安装或选择扩展代码。只有启用可执行扩展时才需要 Node.js 20+；核心 CLI 仍兼容 Node.js 18。参阅双语[扩展契约、安全模型和可执行示例](docs/extensions.md)，以及[扩展清单 schema](schemas/aicommit-extension.schema.json)。

### 节省 Token

单次调用的 token 成本主要来自 diff。AICommit 已经会剔除 lock 文件、压缩过大的 diff，并且在重写或重试时不重发 diff。还可以进一步优化：

- 将生成物添加到 `stripFiles`，例如 `["*.min.js", "*.map", "*.snap"]`；其内容会被替换为单行占位。
- 如果提交通常较小，可降低 `maxDiffChars`，例如设为 `15000`。
- `diffContextLines` 默认为 `1`；设为 `0` 时只发送变更行，不附带上下文。
- 如果某个 `repositoryContext` 分类对仓库风格没有帮助，可降低其预算或直接关闭。

## 隐私与数据流

双语[隐私模型](docs/privacy.md)描述了本地进程、Provider、扩展、指标和分发环节的信任边界。下面概述默认运行路径。

AICommit 没有托管后端，也没有指标上传实现。运行时只会向用户配置选定的 `apiUrl` 发起生成请求。API Key 会作为鉴权信息发送到该端点；在把凭据或仓库内容交给自定义端点前，请先验证其可信度。

提交生成请求可能包含：

- 已配置的系统 prompt 和目标提交语言；
- 普通模式中的变更文件路径 / 状态及暂存 diff；
- split 模式中的变更文件路径 / 状态、tracked diff，以及未跟踪文件的受限文本预览；
- 启用对应上下文分类时，受限的近期提交主题、包边界、显式信任的约定摘录和可识别的 commitlint 约束；
- 请求低成本重写时的上一条生成信息；
- 运行 `aicommit --check` 时的一条固定小型 prompt。

AICommit 不会主动发送无关的仓库文件、历史提交正文、环境变量或本地配置文件。每个选中的 diff、路径列表、历史样本、预览和约定摘录都会放入标记为“不可信数据”的显式 JSON 信封；权威 system policy 会要求模型绝不执行仓库内容中嵌入的指令。lock 文件、配置的 `stripFiles`、超大段落、常见敏感文件名、私钥材料、云访问 Key ID 和疑似凭据赋值，会在默认请求前被省略、截断或脱敏。交互警告仍允许你明确发送原始 diff，请谨慎确认。检测规则和 prompt 边界属于安全护栏，不能完全替代秘密扫描或 prompt injection 防护。

项目级配置被视为不可信：它不能修改端点、Provider、凭据、重试策略、指标、推理请求控制，也不能提高用户配置的数据或成本上限。凭据建议使用 `apiKeyEnv` 或由操作系统保护的 Git credential helper。如果用户明确要求，setup 向导也可以把明文 Key 写入用户配置；在操作系统支持时，该文件会以仅所有者可读写权限原子保存。

默认情况下，成功和失败的提交运行会向 `~/.aicommit/metrics.jsonl` 写入最小化的本地 JSONL 指标。每条记录只包含耗时、标准化 token 用量、受限结果分类、消息是否被编辑，以及重写次数（包括自动策略修正）。它绝不包含 diff、推理、提交信息、文件名、Provider、模型或凭据。默认只保留最新 500 条记录，并在系统支持时使用仅所有者权限写入。

使用 `aicommit stats` 查看首次接受率、编辑 / 重写 / 失败率、P50 / P95 延迟、token 总量，以及近期窗口和前一窗口的趋势。成功运行达到 10 次后，它会比较两个按时间排序的基线窗口，并报告相对于路线图“编辑 / 重写率降低 20%”目标的进度。`aicommit stats clear|enable|disable` 管理同一本地数据；清除操作不可恢复。底层的 `aicommit metrics status|clear|enable|disable` 命令仍然可用。可以在用户配置中将 `metrics.enabled` 设为 `false`、指定绝对 `metrics.path`，或修改 `metrics.maxEntries`。项目配置不能覆盖这些设置，也不存在上传实现。

## 使用方法

```bash
aicommit setup           # 交互式配置向导
aicommit doctor          # 诊断运行时、配置、凭据和连接
aicommit config show     # 显示脱敏后的有效配置
aicommit config validate # 校验配置，但不解析凭据
aicommit config path     # 显示用户配置和项目配置路径
aicommit completion bash # 向 stdout 生成 Bash 补全脚本
aicommit metrics status  # 检查仅本地的指标状态，不上传任何内容
aicommit stats           # 显示本地质量、延迟和 token 趋势
aicommit stats clear     # 永久清除本地指标历史
aicommit                 # 在当前目录生成提交信息并提交
aicommit /path/to/repo   # 或指定目标目录
aicommit --split         # 选择 staged / all 范围并拆分逻辑提交
aicommit --split=staged  # 只拆分已审阅的 index 快照
aicommit --split=all     # 拆分完整工作区快照
aicommit --split=staged --split-hunks # 实验性同文件 hunk 拆分
aicommit --dry-run       # 生成并审阅，但不创建提交
aicommit --split --dry-run # 审阅拆分计划，但不创建提交
aicommit --yes           # 非交互提交已明确暂存的变更
aicommit --yes --dry-run # 非交互预览所有变更；退出时恢复暂存状态
aicommit --split=all --yes # 非交互规划并提交所有工作区变更
aicommit split plan --scope=staged --file=/tmp/split-plan.json --yes
aicommit split apply --file=/tmp/split-plan.json --yes
aicommit split --resume --yes # 恢复中断的拆分事务
aicommit split --abort --yes # 丢弃过期 checkpoint；保留提交和变更
aicommit --reasoning=low # 流式显示低强度推理；Ctrl+O 展开或收起
aicommit --no-reasoning # Provider / 模型支持时显式关闭推理
aicommit -l zh           # 提交信息语言
aicommit -p deepseek     # 切换到名为 "deepseek" 的 Provider
aicommit --yes --output=json # 向 stdout 输出一个通过 schema 校验的 JSON 结果
aicommit -c              # 检查已配置 LLM 是否可访问
aicommit -c -p openrouter # 单独检查 "openrouter" Provider
aicommit -h              # 帮助
```

| 选项               | 说明                                                                |
| ------------------ | ------------------------------------------------------------------- |
| `-l`, `--lang`     | 提交信息语言：`zh` 或 `en`                                          |
| `-p`, `--provider` | 使用 `providers` 中的命名 Provider                                  |
| `-s`, `--split`    | 选择范围并拆分变更；使用 `--split=staged\|all` 显式选择范围         |
| `--split-hunks`    | 启用实验性同文件文本 hunk 规划；默认关闭                            |
| `--scope`          | `aicommit split plan` 的范围：`staged` 或 `all`                     |
| `--file`           | `aicommit split plan` 和 `aicommit split apply` 的 JSON 计划路径    |
| `--dry-run`        | 生成并审阅消息或拆分计划，但不创建提交                              |
| `-y`, `--yes`      | 不提示直接接受；普通模式要求变更已明确暂存                          |
| `--reasoning`      | 启用推理，可选强度：`low`、`medium`、`high`、`xhigh` 或 `max`       |
| `--no-reasoning`   | 所选 Provider / 模型支持时显式关闭推理                              |
| `--output`         | `text`（默认）或单个 JSON 对象；提交 / 拆分的 JSON 流程要求 `--yes` |
| `-c`, `--check`    | Ping Provider，验证端点 / Key / 模型；失败时使用稳定的分类退出码    |
| `-v`, `--version`  | 显示版本                                                            |
| `-h`, `--help`     | 显示帮助                                                            |

### 配置检查

`aicommit config show|validate|path` 可以在仓库外运行，并接受可选目标目录。`show` 使用与提交生成相同的用户 / 项目 / 团队策略信任过滤和 Provider 选择，但会递归遮蔽秘密。`validate` 在不读取环境凭据、不调用 Git credential helper 的情况下解析、合并并校验配置，因此 `aicommit config validate --output=json` 可安全用于 CI。即使配置文件格式错误，`path` 仍会报告用户配置、项目配置和团队策略路径。`show` 与 `validate` 都接受 `--provider=<name>`。

### Shell 补全

补全脚本由已安装的 CLI 生成，不包含配置或凭据：

```bash
# Bash
aicommit completion bash > ~/.local/share/bash-completion/completions/aicommit

# Zsh（请确保目标目录位于 $fpath 中）
aicommit completion zsh > ~/.zfunc/_aicommit

# Fish
aicommit completion fish > ~/.config/fish/completions/aicommit.fish
```

### 机器可读输出

脚本和 CI 请使用 `--output=json`。提交和 split 流程还必须使用 `--yes`，避免机器消费者卡在交互提示上。stdout 只包含一个 JSON 对象；进度、调试信息和诊断输出会写入 stderr。`--check --output=json` 与 `doctor --output=json` 不要求 `--yes`。

```json
{
  "schemaVersion": "1.0",
  "ok": true,
  "message": "fix: handle provider retry limits",
  "plan": null,
  "provider": "openai",
  "model": "gpt-4o",
  "latencyMs": 842,
  "usage": {
    "inputTokens": 420,
    "outputTokens": 18,
    "totalTokens": 438
  },
  "warnings": [],
  "exitReason": "dry_run",
  "committed": false,
  "error": null
}
```

已发布的 [JSON schema](schemas/aicommit-output.schema.json) 覆盖成功、拆分计划、doctor / check 和错误结果。机器输出绝不包含 diff 或模型推理。split 输出只暴露每组消息及其分配路径。

文本与 JSON 模式共享稳定的进程退出码：

| 退出码 | 分类                    | 含义                              |
| ------ | ----------------------- | --------------------------------- |
| `0`    | success                 | 已完成、已预览，或被策略取消      |
| `1`    | internal                | 意外内部错误                      |
| `2`    | config                  | 参数、配置或凭据设置问题          |
| `3`    | git_state               | 仓库、index 或提交状态问题        |
| `4`    | network                 | DNS、连接、超时或传输错误         |
| `5`    | provider                | Provider HTTP / API 错误          |
| `6`    | response_format         | 模型响应无效或不可用              |
| `7`    | sensitive_data          | 非交互安全边界阻止操作            |
| `8`    | concurrent_modification | 生成期间受保护的 Git 状态发生变化 |
| `130`  | interrupt               | 被 Ctrl+C 中断                    |

### 诊断

`aicommit doctor` 会检查当前 Node.js 与 Git 版本、已加载的配置来源、端点安全、所选适配器能力、脱敏后的凭据来源，以及实时 Provider 连接。它会显示 `env:OPENAI_API_KEY`、`git credential helper`、`keyless localhost` 等来源标签，但绝不会显示凭据值。端点 userinfo、疑似凭据的查询参数和 URL fragment 也会从正常输出及凭据解析错误中脱敏。使用 `aicommit doctor -p <name>` 选择已配置 Provider，或在自动化中使用 `aicommit doctor --output=json`。

稳定错误分类、Homebrew / npm 校验失败、split 恢复、预设兼容和扩展隔离错误，请参阅双语[故障排查矩阵](docs/troubleshooting.md)。

基本流程：读取暂存 diff，发送给 AI，然后让你选择**接受**（Enter）、**编辑**（`e`）或**取消**（`n`）。如果没有暂存内容，但工作区存在未暂存或未跟踪变更，AICommit 会先询问是否为你暂存——可以一次性执行 `git add -A`，也可以逐文件选择——然后继续。如果一部分变更已经暂存、另一部分尚未暂存，AICommit 会询问是否将其余变更纳入本次提交。

`--dry-run` 使用相同审阅流程，但会在 `git commit` 前停止。AICommit 在执行期间做出的任何暂存操作都会在退出前恢复。取消和失败也使用同一 index 事务；如果另一个进程并发修改了 index，AICommit 会保持其现状，不会覆盖对方的工作。

发送仓库内容前，AICommit 会检测常见敏感文件名、私钥材料、云访问 Key ID 和疑似凭据赋值。split 模式会扫描每个未跟踪普通文件的完整字节流，同时保持模型预览受限；请求复用已捕获的预览，而不会再次打开文件。默认保护请求会省略敏感文件 / 私钥段落并脱敏检测到的值；你可以取消，也可以明确发送原始 diff。未跟踪的符号链接和非普通文件绝不会被打开预览。在非交互 split 模式中，检测会在 API 调用前以 fail closed 方式停止，因为 `--split --yes` 否则可能自动暂存敏感文件。这是一层安全网，不能替代专用的秘密扫描器。

生成期间会为暂存 index（或完整 split 工作区，包括未跟踪文件字节）计算指纹，并在提交前立即再次校验。如果状态发生变化，提交会被中止，避免生成的消息描述另一份快照。

推理默认为 `on`，强度为 `medium`。OpenAI 推理模型、DeepSeek、OpenRouter 和 MiniMax 使用各自原生映射；不暴露推理能力的模型会正常继续，并显示“不可用”提示，而不是失败。官方 OpenAI 端点会在发送请求前根据模型代际校验所选强度，因此 `o3 --no-reasoning` 或 `gpt-5.1 --reasoning=max` 等不支持的组合会在本地失败，并清楚列出支持的级别。DeepSeek 当前的 `deepseek-v4-flash` 和 `deepseek-v4-pro` 会收到 `thinking: { "type": "enabled" }` 与 `reasoning_effort`；`medium` / `xhigh` 会归一化为 DeepSeek 的 `high` 级别。

推理模式为 `on` 时（包括通过 `--reasoning=<level>` 启用），AICommit 会请求流式响应并实时显示推理。默认实时视图跟随终端最新两行；生成或审阅期间按 `Ctrl+O` 可展开或收起累计文本。较长的展开输出会限制在终端视口内，可用 `PageUp` / `PageDown` 阅读所有页面。长按 `Ctrl+O` 只计为一次切换，避免按键重复留下多个面板。输出会经过清理，并受 `reasoning.maxDisplayChars` 限制；不暴露推理的 Provider 会显示简短的不可用提示。

```json
{
  "reasoning": {
    "mode": "on",
    "effort": "medium",
    "maxTokens": 4096,
    "maxDisplayChars": 12000,
    "enabledBody": { "enable_thinking": true },
    "disabledBody": { "enable_thinking": false }
  }
}
```

### 拆分提交模式

`--split` 会询问是对暂存 index 快照分组，还是对全部已暂存、未暂存和未跟踪变更分组。边界必须明确时请使用 `--split=staged` 或 `--split=all`，所有非交互运行都应显式指定范围。提交前可以审阅计划、为选中的组重新生成消息，或直接编辑 JSON 计划。扩展校验错误会随计划显示，必须通过编辑或重新生成修复后才能提交。敏感内容检测会在非交互 Provider 请求或自动暂存前 fail closed。

如需可审计的两步流程，使用 `aicommit split plan --scope=staged|all --file=<path>` 导出版本化 JSON 工件，再用 `aicommit split apply --file=<path>` 在接触 index 前重新校验 base commit、变更集和内容指纹。计划文件应保存在工作区之外或 `.git` 下，避免被纳入自身计划。

执行过程使用临时 index，并在 `.git/aicommit` 下保存不含代码内容的 checkpoint。hook、Git 错误、中断或崩溃发生后，已完成提交仍保留在历史中，待处理快照也会保留；失败报告会显示已 checkpoint、执行中、待处理，以及当前工作区 / index 状态。解决问题后运行 `aicommit split --resume`。恢复流程会先协调“提交完成后崩溃”的可能窗口，再创建任何新提交，因此不会重复或遗漏已完成分组。如果你通过其他 Git 流程有意完成或替换了中断工作，请运行 `aicommit split --abort`；它只删除过期 checkpoint，绝不会改写 HEAD、index 或工作区。新的 split 提交流程会在联系 Provider 前检测现有 checkpoint。如果规划或预检在第一组之前失败，不会创建任何 split 提交，真实 index 也保持不变。

split 默认仍按文件拆分。`--split-hunks` 可选择性启用实验性的同文件拆分，适用于包含多个 unified-diff hunk 的 tracked 文本修改。JSON 计划和 checkpoint 只保存 hunk ID、行范围和哈希，不保存 patch 内容。第一次提交前，AICommit 会把每个选中 patch 应用到临时 index，并要求最终 tree 精确还原捕获的目标 blob；解析、patch、二进制 / mode-change 或无损校验失败时会退回文件级计划。hunk 执行绝不会修改工作区。

## 开发与发布

本地开发和 Pull Request 检查请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)，私密漏洞报告请参阅 [SECURITY.md](SECURITY.md)，可执行的维护者发布流程请参阅 [RELEASING.md](RELEASING.md)，npm / Homebrew 安装、验证和用户回滚请参阅双语[分发指南](docs/distribution.md)。发布要求包含 GitHub 验证的签名 tag、精确 npm tarball 和 SPDX SBOM 的 Sigstore / GitHub attestations、npm Trusted Publishing provenance、SHA-256 固定的 Homebrew formula，以及发布后的冒烟测试。`npm run eval` 会运行匿名本地质量语料，覆盖单一与混合变更、rename、生成文件、长 diff、中英文输出和格式错误的弱模型候选；该命令也是 `npm run ci` 的一部分。

## 许可证

[MIT](LICENSE)
