# AICommit

[English](README.md) | 简体中文

AI 驱动的 Git 提交信息生成器：读取 diff，请 AI 模型生成符合 Conventional Commits 规范的提交信息，并在你确认后执行提交。

## 使用预览

以下截图来自本仓库中的真实交互式终端会话。Provider、模型、路径和耗时均为截图时的实际环境。

### 交互式配置 Provider

![AICommit setup 提示选择 AI Provider](https://raw.githubusercontent.com/hi-fullmoon/AICommit/main/docs/assets/readme/setup-provider.png)

### 检查配置与连接

![AICommit doctor 检查运行环境、配置、凭据和 Provider 连接](https://raw.githubusercontent.com/hi-fullmoon/AICommit/main/docs/assets/readme/doctor-diagnostics.png)

### 生成提交信息

![AICommit 根据已暂存的变更生成提交信息](https://raw.githubusercontent.com/hi-fullmoon/AICommit/main/docs/assets/readme/generating-commit.png)

### 检查生成的提交信息

![AICommit 展示生成的 Conventional Commit 并等待确认](https://raw.githubusercontent.com/hi-fullmoon/AICommit/main/docs/assets/readme/generate-commit.png)

## 安装

使用 npm：

```bash
npm install --global @hifullmoon/aicommit
```

需要 Node.js >= 18。

从当前配置的 registry 更新 npm 全局安装：

```bash
aicommit update
```

该命令会解析 npm 的 `latest` dist-tag，安装对应的精确版本，并校验安装后的 manifest。源码检出、`npm link`，或属于另一个 Node.js/npm 环境的安装会被拒绝；这些情况请使用分发指南中的手动升级命令。

安装、升级、签名校验与回滚请参阅双语[分发指南](docs/distribution.md)。npm package 带有自动化安装冒烟测试。

如需直接安装源码检出版本，请在仓库根目录运行 `npm install --global .`。

## 配置

最快的方式是使用交互式向导：

```bash
aicommit setup
```

向导会引导你选择内置 Provider 默认值（OpenAI、DeepSeek、OpenRouter、MiniMax、Kimi Code 和 Ollama），或填写自定义 OpenAI 兼容端点；随后输入 API Key 和一个或多个模型、选择默认模型和提交信息语言，并可选测试连接。配置会原子写入用户配置文件 `~/.aicommit/config.json`；如果已有文件格式错误或属于旧格式，替换前会先备份。旧路径 `~/.aicommit.config.json` 仍可读取，运行 `aicommit setup` 并保存时会把其中设置迁移到规范路径。

模型步骤会为每个配置单独设置推理。`auto` 不发送显式推理开关，交给 Provider 使用默认行为；`on` 请求推理并继续选择强度；`off` 在模型支持该开关时显式关闭推理。强度默认为 `medium`。对于已知的 OpenAI 模型，setup 会过滤不支持的模式和强度选项；无法关闭推理时也不会列出 `off`。编辑已有模型时，向导会回填其中仍有效的保存值；模型级未配置时，则在适用情况下回填全局推理设置，不再受支持的旧模式会回退到 `auto`。

如需手动配置，请从 [.aicommit.config.example.json](.aicommit.config.example.json) 开始。AICommit 先加载用户配置，再将项目配置 `./.aicommit.config.json` 中白名单内的生成偏好深度合并到用户配置之上。项目配置可以设置 `language`、`commitPolicy`、`stripFiles`、`temperature`，也可以降低 diff、token、timeout 或仓库上下文上限。项目拥有的 `prompt` 默认会被忽略，除非用户配置明确设置 `allowProjectPrompt: true`。连接或 Provider 字段（包括 `apiKeyEnv`）、推理请求控制、未知字段，以及任何试图提高上限的配置，都会被忽略并给出警告。这样可以防止克隆的仓库重定向已鉴权请求，或在不知情的情况下扩大成本和数据范围。

如需避免把密钥写入 JSON，请设置 `"apiKeyEnv": "OPENAI_API_KEY"`（并将 `apiKey` 留空），或在 setup 向导中输入 `env:OPENAI_API_KEY`。环境变量优先于所有其他凭据来源，推荐用于 CI 和其他无状态环境。

AICommit 也可以读取操作系统上已经配置的 Git credential helper。启用 `credentialHelper.enabled`，通过常规 Git/系统凭据流程保存 Provider 凭据，AICommit 就会在不弹出输入提示的情况下调用 `git credential fill`。查询用户名默认为 `aicommit`，可通过 `credentialHelper.username` 修改。凭据解析顺序为：环境变量 → Git credential helper → 用户配置中的明文凭据 → 无密钥 localhost。项目配置不能启用 credential helper，也不能选择凭据来源。

每个 Provider 可以拥有多个命名模型配置。通过 `-p` / `--provider` 切换 Provider，通过 `-m` / `--model` 选择该 Provider 下的模型：

```json
{
  "schemaVersion": 1,
  "defaultProvider": "minimax",
  "providers": {
    "minimax": {
      "providerType": "minimax",
      "apiUrl": "https://api.minimaxi.com/v1/chat/completions",
      "apiKeyEnv": "MINIMAX_API_KEY",
      "defaultModel": "default",
      "models": {
        "default": {
          "label": "MiniMax M3",
          "modelId": "MiniMax-M3",
          "reasoning": { "mode": "on", "effort": "medium" }
        }
      }
    },
    "deepseek": {
      "providerType": "deepseek",
      "apiUrl": "https://api.deepseek.com/v1/chat/completions",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "defaultModel": "chat",
      "models": {
        "chat": {
          "modelId": "deepseek-v4-flash",
          "reasoning": { "mode": "on", "effort": "medium" }
        },
        "reasoner": {
          "modelId": "deepseek-v4-pro",
          "reasoning": { "mode": "on", "effort": "high" }
        }
      }
    },
    "openai": {
      "providerType": "openai",
      "apiUrl": "https://api.openai.com/v1/chat/completions",
      "apiKeyEnv": "OPENAI_API_KEY",
      "defaultModel": "fast",
      "models": {
        "fast": {
          "modelId": "gpt-4o",
          "reasoning": { "mode": "auto" }
        },
        "reasoner": {
          "modelId": "gpt-5.6-sol",
          "reasoning": { "mode": "on", "effort": "medium" }
        }
      }
    },
    "openrouter": {
      "providerType": "openrouter",
      "apiUrl": "https://openrouter.ai/api/v1/chat/completions",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "defaultModel": "auto",
      "models": {
        "auto": {
          "modelId": "openrouter/auto",
          "reasoning": { "mode": "auto" }
        },
        "quality": {
          "modelId": "openai/gpt-5.6-terra",
          "reasoning": { "mode": "on", "effort": "high" }
        }
      }
    },
    "ollama": {
      "providerType": "ollama",
      "apiUrl": "http://127.0.0.1:11434/api/chat",
      "defaultModel": "qwen",
      "models": {
        "qwen": {
          "modelId": "qwen3:8b",
          "reasoning": { "mode": "on", "effort": "medium" }
        },
        "deepseek": {
          "modelId": "deepseek-r1:8b",
          "reasoning": { "mode": "on", "effort": "medium" }
        }
      }
    }
  }
}
```

导出所配置 Provider 使用的 API Key 环境变量后，建议在第一次真实提交前逐个验证模型配置：

```bash
export MINIMAX_API_KEY='your-minimax-api-key'
export DEEPSEEK_API_KEY='your-deepseek-api-key'
export OPENAI_API_KEY='your-openai-api-key'
export OPENROUTER_API_KEY='your-openrouter-api-key'

aicommit doctor -p minimax -m default
aicommit doctor -p deepseek -m reasoner
aicommit doctor -p openai -m reasoner
aicommit doctor -p openrouter -m quality
aicommit doctor -p ollama -m qwen

aicommit -p minimax
aicommit -p deepseek -m reasoner
```

`schemaVersion`、`defaultProvider`、`providers`，以及每个 Provider 的 `providerType`、`apiUrl`、`defaultModel` 和非空 `models` 都是必填项。未指定 `-p` 时选择 `defaultProvider`；未指定 `-m` 时选择该 Provider 的 `defaultModel`。模型配置会继承全局生成设置和 Provider 连接设置，并可覆盖 `temperature`、`maxTokens`、`timeoutMs`、`reasoning` 与 `extraBody`。Provider 名和模型名是稳定的本地别名，`modelId` 才是发送给 API 的模型标识。

这是唯一支持的用户配置格式。旧版扁平配置或 Provider 级 `modelId` 会被直接拒绝；请运行 `aicommit setup` 或显式迁移。

| 配置项               | 说明                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`      | 必填的用户配置 schema 版本，当前为 `1`                                                                                                |
| `providers`          | 命名 Provider 配置；每项包含连接设置、`defaultModel` 和非空 `models`                                                                  |
| `defaultProvider`    | 必填；未指定 `-p` 时使用的 Provider 别名                                                                                              |
| `apiUrl`             | OpenAI 兼容的 Chat Completions 端点                                                                                                   |
| `apiKey`             | API Key；本地模型允许使用空字符串                                                                                                     |
| `apiKeyEnv`          | 保存 API Key 的环境变量名，优先于 `apiKey`（默认：空）                                                                                |
| `providerType`       | 必填适配器：`openai`、`openrouter`、`deepseek`、`minimax`、`ollama` 或 `custom`                                                       |
| `defaultModel`       | 必填；未指定 `-m` 时使用的模型别名                                                                                                    |
| `models`             | 一个 Provider 下的命名模型配置                                                                                                        |
| `modelId`            | 每个模型配置中必填的 API 模型标识                                                                                                     |
| `commitPolicy`       | 版本化提交规则：type、scope、主题长度、正文、破坏性变更和语言                                                                         |
| `prompt`             | 用户批准的可选指导，追加到权威结构化策略之后（默认：空）                                                                              |
| `allowProjectPrompt` | 是否接受项目配置中的 `prompt`，只能由用户配置启用（默认：`false`）                                                                    |
| `repositoryContext`  | 近期提交、包边界、可信约定和 commitlint 检测的总预算与分类预算                                                                        |
| `language`           | 提交信息语言：`zh` 或 `en`（默认：`zh`）                                                                                              |
| `temperature`        | 采样温度（默认：`0.3`）                                                                                                               |
| `maxTokens`          | 最大响应 token 数（默认：`1024`）                                                                                                     |
| `timeoutMs`          | 单次请求超时，单位为毫秒（默认：`120000`）                                                                                            |
| `retry`              | 瞬时错误重试限制：`maxAttempts`、`baseDelayMs`、`maxDelayMs`（默认：`3`、`500`、`5000`）                                              |
| `credentialHelper`   | 通过 `enabled` 和 `username` 选择性启用 `git credential fill`（默认：`false`、`aicommit`）                                            |
| `maxDiffChars`       | 单次发送给模型的 diff 字符数；超限后改为 `--stat` 摘要和截断的 hunk（默认：`30000`）                                                  |
| `maxFileDiffChars`   | 单文件 diff 上限；超限文件只保留前部 hunk，避免一个大文件挤占全部上下文（默认：`3000`）                                               |
| `splitMaxDiffChars`  | 拆分规划请求的 diff 字符数；规划阶段需要的 hunk 细节少于最终信息生成（默认：`16000`）                                                 |
| `splitMaxPlanFiles`  | 交给拆分规划器的最大变更文件数；超出部分归入兜底提交（默认：`100`）                                                                   |
| `diffContextLines`   | 每个 diff hunk 周围的上下文行数（`git diff --unified=<n>`）；越小越节省 token（默认：`1`）                                            |
| `stripFiles`         | 额外替换为占位的文件，按 basename 使用 `*` / `?` 通配，如 `["*.min.js", "*.map", "*.snap"]`（默认：`[]`；项目项与用户项合并而非覆盖） |
| `regenerateWithDiff` | `true` 表示每次重写都重发完整 diff，以获得更多变化；`false`（默认）只要求模型改写上一条消息，成本更低                                 |
| `extraBody`          | 模型配置中合并到请求体的 JSON 字段，但不允许覆盖 `model` / `messages`（默认：`{}`）                                                   |
| `reasoning`          | 全局或模型级推理控制：`mode` / `effort`（默认：`on` / `medium`）、`maxTokens` 和 `maxDisplayChars`                                    |

AICommit 支持 OpenAI、DeepSeek、[OpenRouter](https://openrouter.ai)、MiniMax、[Kimi Code](https://www.kimi.com/code/docs/)、Ollama（原生 `/api/chat` 或 OpenAI 兼容 `/v1/chat/completions`）、LiteLLM，以及其他兼容端点。远程端点必须使用 HTTPS；明文 HTTP 只允许 localhost / loopback。

流式输出、推理、token 预算、usage 和鉴权边界，请参阅双语 [Provider 兼容表](docs/provider-compatibility.md)。

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

### 内置 Provider 默认值

setup 使用随 AICommit 一起发布并经过校验的 Provider 默认值。OpenAI 预置 GPT-4o 与 GPT-5.6 系列，DeepSeek 预置 V4 Flash 与 Pro，OpenRouter 预置 Auto 以及当前常用的 GPT、Claude、Gemini、DeepSeek、Qwen、GLM、Kimi 和 Grok，Ollama 预置 Qwen 3、DeepSeek R1 与 GPT-OSS。这些配置只是起点：setup 仍允许编辑模型 ID，已有的用户自定义模型配置也会优先保留。需要其他 OpenAI 兼容服务时，直接在用户配置中增加命名 Provider；无需安装额外清单或执行第三方代码。

### 节省 Token

单次调用的 token 成本主要来自 diff。AICommit 已经会剔除 lock 文件、压缩过大的 diff，并且在重写或重试时不重发 diff。还可以进一步优化：

- 将生成物添加到 `stripFiles`，例如 `["*.min.js", "*.map", "*.snap"]`；其内容会被替换为单行占位。
- 如果提交通常较小，可降低 `maxDiffChars`，例如设为 `15000`。
- `diffContextLines` 默认为 `1`；设为 `0` 时只发送变更行，不附带上下文。
- 如果某个 `repositoryContext` 分类对仓库风格没有帮助，可降低其预算或直接关闭。

## 隐私与数据流

双语[隐私模型](docs/privacy.md)描述了本地进程、Provider、凭据和分发环节的信任边界。下面概述默认运行路径。

AICommit 没有托管后端，也不会记录或上传使用指标。运行时只会向用户配置选定的 `apiUrl` 发起生成请求。API Key 会作为鉴权信息发送到该端点；在把凭据或仓库内容交给自定义端点前，请先验证其可信度。

提交生成请求可能包含：

- 已配置的系统 prompt 和目标提交语言；
- 普通模式中的变更文件路径 / 状态及暂存 diff；
- split 模式中的变更文件路径 / 状态、tracked diff，以及未跟踪文件的受限文本预览；
- 启用对应上下文分类时，受限的近期提交主题、包边界、显式信任的约定摘录和可识别的 commitlint 约束；
- 请求低成本重写时的上一条生成信息；
- `aicommit doctor` 执行实时连接检查时的一条固定小型 prompt。

AICommit 不会主动发送无关的仓库文件、历史提交正文、环境变量或本地配置文件。每个选中的 diff、路径列表、历史样本、预览和约定摘录都会放入标记为“不可信数据”的显式 JSON 信封；权威 system policy 会要求模型绝不执行仓库内容中嵌入的指令。lock 文件、配置的 `stripFiles`、超大段落、常见敏感文件名、私钥材料、云访问 Key ID 和疑似凭据赋值，会在默认请求前被省略、截断或脱敏。交互警告仍允许你明确发送原始 diff，请谨慎确认。检测规则和 prompt 边界属于安全护栏，不能完全替代秘密扫描或 prompt injection 防护。

项目级配置被视为不可信：它不能修改端点、Provider、凭据、重试策略、推理请求控制，也不能提高用户配置的数据或成本上限。凭据建议使用 `apiKeyEnv` 或由操作系统保护的 Git credential helper。如果用户明确要求，setup 向导也可以把明文 Key 写入用户配置；在操作系统支持时，该文件会以仅所有者可读写权限原子保存。

## 使用方法

```bash
aicommit setup           # 交互式配置向导
aicommit update          # 将 npm 全局安装更新到最新版
aicommit doctor          # 诊断运行时、配置、凭据和连接
aicommit config show     # 显示脱敏后的有效配置
aicommit config validate # 校验配置，但不解析凭据
aicommit config path     # 显示用户配置和项目配置路径
aicommit completion bash # 向 stdout 生成 Bash 补全脚本
aicommit                 # 在当前目录生成提交信息并提交
aicommit /path/to/repo   # 或指定目标目录
aicommit split           # 选择 staged / all 范围并拆分逻辑提交
aicommit split --scope=staged # 只拆分已审阅的 index 快照
aicommit split --scope=all # 拆分完整工作区快照
aicommit --dry-run       # 生成并审阅，但不创建提交
aicommit split --dry-run # 审阅拆分计划，但不创建提交
aicommit --yes           # 非交互提交已明确暂存的变更
aicommit --yes --dry-run # 非交互预览所有变更；退出时恢复暂存状态
aicommit split --scope=all --yes # 非交互规划并提交所有工作区变更
aicommit split plan --scope=staged --file=/tmp/split-plan.json --yes
aicommit split apply --file=/tmp/split-plan.json --yes
aicommit split resume --yes # 恢复中断的拆分事务
aicommit split abort --yes # 丢弃过期 checkpoint；保留提交和变更
aicommit --reasoning=low # 流式显示低强度推理；Ctrl+O 展开或收起
aicommit --no-reasoning # Provider / 模型支持时显式关闭推理
aicommit -l zh           # 提交信息语言
aicommit -p deepseek     # 切换到名为 "deepseek" 的 Provider
aicommit -p deepseek -m reasoner # 使用其中名为 "reasoner" 的模型配置
aicommit --yes --output=json # 向 stdout 输出一个通过 schema 校验的 JSON 结果
aicommit -h              # 帮助
```

| 选项               | 说明                                                                |
| ------------------ | ------------------------------------------------------------------- |
| `-l`, `--lang`     | 提交信息语言：`zh` 或 `en`                                          |
| `-p`, `--provider` | 使用 `providers` 中的命名 Provider                                  |
| `-m`, `--model`    | 使用所选 Provider 下的命名模型配置                                  |
| `--scope`          | `aicommit split` 和 `aicommit split plan` 的范围：`staged` 或 `all` |
| `--file`           | `aicommit split plan` 和 `aicommit split apply` 的 JSON 计划路径    |
| `--dry-run`        | 生成并审阅消息或拆分计划，但不创建提交                              |
| `-y`, `--yes`      | 不提示直接接受；普通模式要求变更已明确暂存                          |
| `--reasoning`      | 启用推理，可选强度：`low`、`medium`、`high`、`xhigh` 或 `max`       |
| `--no-reasoning`   | 所选 Provider / 模型支持时显式关闭推理                              |
| `--output`         | `text`（默认）或单个 JSON 对象；提交 / 拆分的 JSON 流程要求 `--yes` |
| `-v`, `--version`  | 显示版本                                                            |
| `-h`, `--help`     | 显示帮助                                                            |

### 配置检查

`aicommit config show|validate|path` 可以在仓库外运行，并接受可选目标目录。`show` 使用与提交生成相同的用户 / 项目 / 团队策略信任过滤和 Provider / 模型选择，但会递归遮蔽秘密。`validate` 在不读取环境凭据、不调用 Git credential helper 的情况下解析、合并并校验配置，因此 `aicommit config validate --output=json` 可安全用于 CI。即使配置文件格式错误，`path` 仍会报告用户配置、项目配置和团队策略路径。`show` 与 `validate` 都接受 `--provider=<name>` 和 `--model=<name>`。

### Shell 补全

补全脚本由已安装的 CLI 生成，不包含配置或凭据：

```bash
# Bash
aicommit completion bash > ~/.local/share/bash-completion/completions/aicommit

# Zsh
mkdir -p ~/.zfunc
aicommit completion zsh > ~/.zfunc/_aicommit

# Fish
aicommit completion fish > ~/.config/fish/completions/aicommit.fish
```

Zsh 还需要在 Oh My Zsh 或其他补全框架初始化之前，将补全目录加入 `fpath`。使用 Oh My Zsh 时，请在 `~/.zshrc` 的 `source "$ZSH/oh-my-zsh.sh"` 之前加入：

```zsh
fpath=("$HOME/.zfunc" $fpath)
source "$ZSH/oh-my-zsh.sh"
```

如果没有使用负责初始化补全的 Zsh 框架，则改用：

```zsh
fpath=("$HOME/.zfunc" $fpath)
autoload -Uz compinit
compinit
```

修改后重启 Zsh。如果旧补全缓存导致脚本仍未被发现，可以只清理该缓存后再重启：

```bash
rm -f "$HOME"/.zcompdump*
exec zsh
```

运行 `whence -w _aicommit` 验证注册结果；正常应输出 `_aicommit: function`。随后输入 `aicommit`、空一格并按 `Tab` 即可使用补全。

### 机器可读输出

脚本和 CI 请使用 `--output=json`。提交和 split 流程还必须使用 `--yes`，避免机器消费者卡在交互提示上。stdout 只包含一个 JSON 对象；进度、调试信息和诊断输出会写入 stderr。`doctor --output=json` 和 `update --output=json` 不要求 `--yes`。

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

`aicommit doctor` 会检查当前 Node.js 与 Git 版本、已加载的配置来源、端点安全、所选适配器能力、脱敏后的凭据来源，以及实时 Provider 连接。它会显示 `env:OPENAI_API_KEY`、`git credential helper`、`keyless localhost` 等来源标签，但绝不会显示凭据值。端点 userinfo、疑似凭据的查询参数和 URL fragment 也会从正常输出及凭据解析错误中脱敏。使用 `aicommit doctor -p <provider> -m <model>` 选择已配置的 Provider / 模型组合，或在自动化中使用 `aicommit doctor --output=json`。

稳定错误分类、npm 校验失败、Provider 配置和 split 恢复问题，请参阅双语[故障排查矩阵](docs/troubleshooting.md)。

基本流程：读取暂存 diff，发送给 AI，然后让你选择**接受**（Enter）、**编辑**（`e`）或**取消**（`n`）。在交互式选择提示中，按 `q` 会立即退出。如果没有暂存内容，但工作区存在未暂存或未跟踪变更，AICommit 会先询问是否为你暂存——可以一次性执行 `git add -A`，也可以逐文件选择——然后继续。一旦存在暂存内容，就以该 index 快照为准，其余工作区变更保持不动。

`--dry-run` 使用相同审阅流程，但会在 `git commit` 前停止。AICommit 在执行期间做出的任何暂存操作都会在退出前恢复。取消和失败也使用同一 index 事务；如果另一个进程并发修改了 index，AICommit 会保持其现状，不会覆盖对方的工作。

发送仓库内容前，AICommit 会检测常见敏感文件名、私钥材料、云访问 Key ID 和疑似凭据赋值。split 模式会扫描每个未跟踪普通文件的完整字节流，同时保持模型预览受限；请求复用已捕获的预览，而不会再次打开文件。默认保护请求会省略敏感文件 / 私钥段落并脱敏检测到的值；你可以取消，也可以明确发送原始 diff。未跟踪的符号链接和非普通文件绝不会被打开预览。在非交互 split 模式中，检测会在 API 调用前以 fail closed 方式停止，因为 `split run --scope=all --yes` 否则可能自动暂存敏感文件。这是一层安全网，不能替代专用的秘密扫描器。

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

`aicommit split`（也可以显式写成 `aicommit split run`）会询问是对暂存 index 快照分组，还是对全部已暂存、未暂存和未跟踪变更做文件级分组。边界必须明确时请使用 `--scope=staged` 或 `--scope=all`，所有非交互运行都应显式指定范围。提交前可以审阅计划、为选中的组重新生成消息，或直接编辑 JSON 计划。敏感内容检测会在非交互 Provider 请求或自动暂存前 fail closed。

如需可审计的两步流程，使用 `aicommit split plan --scope=staged|all --file=<path>` 导出版本化 JSON 工件，再用 `aicommit split apply --file=<path>` 在接触 index 前重新校验 base commit、变更集和内容指纹。计划文件应保存在工作区之外或专用的 `.git/aicommit/` 目录下，避免被纳入自身计划；导出不会覆盖已有目标文件。

执行过程使用临时 index，并在 `.git/aicommit` 下保存不含代码内容的 checkpoint。hook、Git 错误、中断或崩溃发生后，已完成提交仍保留在历史中，待处理快照也会保留；失败报告会显示已 checkpoint、执行中、待处理，以及当前工作区 / index 状态。解决问题后运行 `aicommit split resume`。恢复流程会先协调“提交完成后崩溃”的可能窗口，再创建任何新提交，因此不会重复或遗漏已完成分组。如果你通过其他 Git 流程有意完成或替换了中断工作，请运行 `aicommit split abort`；它只删除过期 checkpoint，绝不会改写 HEAD、index 或工作区。新的 split 提交流程会在联系 Provider 前检测现有 checkpoint。如果规划或预检在第一组之前失败，不会创建任何 split 提交，真实 index 也保持不变。

## 开发与发布

本地开发和 Pull Request 检查请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)，私密漏洞报告请参阅 [SECURITY.md](SECURITY.md)，维护者发布流程请参阅 [RELEASING.md](RELEASING.md)，npm 安装和用户回滚请参阅双语[分发指南](docs/distribution.md)。发布通过 npm Trusted Publishing 生成 provenance，并发布经过校验的精确 package tarball。`npm run eval` 会运行匿名本地质量语料，覆盖单一与混合变更、rename、生成文件、长 diff、中英文输出和格式错误的弱模型候选；该命令也是 `npm run ci` 的一部分。

## 许可证

[MIT](LICENSE)
