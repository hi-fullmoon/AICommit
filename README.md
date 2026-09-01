# AICommit

[English](README.md) | [简体中文](README.zh-CN.md)

AI-powered git commit message generator: reads your diff, asks an AI model for a conventional commit message, and commits after your confirmation.

## Usage preview

These screenshots were captured from real interactive terminal sessions in this repository. Provider, model, paths, and timings reflect the environment at capture time.

### Configure a provider interactively

![AICommit setup prompting for an AI provider](https://raw.githubusercontent.com/hi-fullmoon/AICommit/main/docs/assets/readme/setup-provider.png)

### Diagnose configuration and connectivity

![AICommit doctor checking runtime, configuration, credentials, and provider connectivity](https://raw.githubusercontent.com/hi-fullmoon/AICommit/main/docs/assets/readme/doctor-diagnostics.png)

### Generate a commit message

![AICommit generating a commit message from staged changes](https://raw.githubusercontent.com/hi-fullmoon/AICommit/main/docs/assets/readme/generating-commit.png)

### Review the generated commit message

![AICommit presenting a generated conventional commit message for confirmation](https://raw.githubusercontent.com/hi-fullmoon/AICommit/main/docs/assets/readme/generate-commit.png)

## Install

```bash
npm install --global @hifullmoon/aicommit
```

Requires Node.js >= 18.

Update an npm-global installation from the configured registry:

```bash
aicommit update
```

The command resolves npm's `latest` dist-tag, installs that exact version, and verifies the installed manifest. It refuses to modify a source checkout, an `npm link`, or a package owned by a different active Node.js/npm environment; use the manual upgrade command from the distribution guide in those cases.

See the bilingual [installation, upgrade, signature-verification, and rollback guide](docs/distribution.md). The npm package has an automated installation smoke test.

To install a source checkout instead, run `npm install --global .` from the repository root.

## Configure

The fastest way is the interactive wizard:

```bash
aicommit setup
```

It walks you through choosing built-in provider defaults (OpenAI, DeepSeek, OpenRouter, MiniMax, Kimi Code, and Ollama) or entering a custom OpenAI-compatible endpoint, then entering your API key and one or more models, choosing a default model and commit language, and optionally testing the connection. Configuration is written atomically to the user config (`~/.aicommit/config.json`); a malformed or old-format existing file is backed up before replacement. The legacy `~/.aicommit.config.json` path remains readable and `aicommit setup` migrates its settings to the canonical path when saving.

The model step configures reasoning independently for each profile. `auto` sends no explicit reasoning switch and leaves the behavior to the provider, `on` requests reasoning and then prompts for its effort, and `off` explicitly disables reasoning when the model supports that switch. Effort defaults to `medium`. For known OpenAI models, setup removes unsupported mode and effort choices, including `off` when reasoning cannot be disabled. When editing an existing model, the wizard preselects valid saved values, falling back to the global reasoning settings when applicable; an unsupported saved mode falls back to `auto`.

To configure by hand, start from [.aicommit.config.example.json](.aicommit.config.example.json). User config is loaded first, then allow-listed generation preferences from the project config at `./.aicommit.config.json` are deep-merged over it. Project config may set `language`, `commitPolicy`, `stripFiles`, `temperature`, and lower diff/token/timeout or repository-context ceilings. A project-owned `prompt` is ignored unless the user config explicitly sets `allowProjectPrompt: true`. Connection/provider fields (including `apiKeyEnv`), reasoning request controls, unknown keys, and attempts to raise a ceiling are ignored with a warning. This prevents a cloned repository from redirecting an authenticated request or silently increasing its cost/data scope.

To keep a key out of the JSON file, set `"apiKeyEnv": "OPENAI_API_KEY"` (and leave `apiKey` empty), or enter `env:OPENAI_API_KEY` in the setup wizard. Environment variables take priority over every other credential source and are recommended for CI and other stateless environments.

AICommit can also read from the Git credential helper already configured on your OS. Enable `credentialHelper.enabled`, store the provider credential through your normal Git/OS credential workflow, and AICommit will call `git credential fill` without prompting. The lookup username defaults to `aicommit` and can be changed with `credentialHelper.username`. Credential resolution order is environment variable → Git credential helper → plaintext user config → keyless localhost. A project config cannot enable a helper or select a credential source.

Each provider owns one or more named model profiles. Switch providers with `-p` / `--provider` and models within that provider with `-m` / `--model`:

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

After exporting the API-key variables used by the providers you configured, validate each profile before its first real commit:

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

`schemaVersion`, `defaultProvider`, `providers`, and every provider's `providerType`, `apiUrl`, `defaultModel`, and non-empty `models` map are required. Without `-p`, AICommit selects `defaultProvider`; without `-m`, it selects that provider's `defaultModel`. Model profiles inherit global generation settings and provider connection settings, then may override `temperature`, `maxTokens`, `timeoutMs`, `reasoning`, and `extraBody`. Provider and model names are stable local aliases; `modelId` is the identifier sent to the API.

This is the only supported user-config shape. Earlier flat or provider-level `modelId` configurations are rejected; run `aicommit setup` or migrate them explicitly.

| Key                  | Description                                                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`      | Required user-config schema version; currently `1`                                                                                                                                                                           |
| `providers`          | Named provider configs; each contains connection settings, `defaultModel`, and a non-empty `models` map                                                                                                                      |
| `defaultProvider`    | Required provider alias used when `-p` is not given                                                                                                                                                                          |
| `apiUrl`             | OpenAI-compatible chat completions endpoint                                                                                                                                                                                  |
| `apiKey`             | API key (empty string allowed for local models)                                                                                                                                                                              |
| `apiKeyEnv`          | Environment variable containing the API key; takes precedence over `apiKey` (default: empty)                                                                                                                                 |
| `providerType`       | Required adapter: `openai`, `openrouter`, `deepseek`, `minimax`, `ollama`, or `custom`                                                                                                                                       |
| `defaultModel`       | Required model alias used when `-m` is not given                                                                                                                                                                             |
| `models`             | Named model profiles under one provider                                                                                                                                                                                      |
| `modelId`            | Required API model identifier inside each model profile                                                                                                                                                                      |
| `commitPolicy`       | Versioned commit rules for types, scope, subject length, body, breaking changes, and language                                                                                                                                |
| `prompt`             | Optional user-approved guidance appended to the authoritative structured policy (default: empty)                                                                                                                             |
| `allowProjectPrompt` | User-owned opt-in for accepting `prompt` from project config (default: `false`)                                                                                                                                              |
| `repositoryContext`  | Total and per-category budgets for recent commits, package boundaries, trusted conventions, and commitlint detection                                                                                                         |
| `language`           | Commit message language, `zh` or `en` (default: `zh`)                                                                                                                                                                        |
| `temperature`        | Sampling temperature (default: `0.3`)                                                                                                                                                                                        |
| `maxTokens`          | Max response tokens (default: `1024`)                                                                                                                                                                                        |
| `timeoutMs`          | Per-request timeout in milliseconds (default: `120000`)                                                                                                                                                                      |
| `retry`              | Transient retry limits: `maxAttempts`, `baseDelayMs`, and `maxDelayMs` (defaults: `3`, `500`, and `5000`)                                                                                                                    |
| `credentialHelper`   | Opt in to `git credential fill` with `enabled` and `username` (defaults: `false` and `aicommit`)                                                                                                                             |
| `maxDiffChars`       | Diff chars sent to the model per call; oversized diffs become a `--stat` summary + truncated hunks (default: `30000`)                                                                                                        |
| `maxFileDiffChars`   | Cap on a single file's diff section; bigger sections are truncated to their leading hunks so one huge file can't crowd out the rest (default: `3000`)                                                                        |
| `splitMaxDiffChars`  | Diff chars sent to the split-planning call; split mode needs less hunk detail than final message generation (default: `16000`)                                                                                               |
| `splitMaxPlanFiles`  | Number of changed files shown to the split planner before extra files are swept into a catch-all commit (default: `100`)                                                                                                     |
| `diffContextLines`   | Context lines around each diff hunk (`git diff --unified=<n>`); lower values mean fewer tokens (default: `1`)                                                                                                                |
| `stripFiles`         | Extra files to stub out of the diff like lock files, matched by basename with `*`/`?` wildcards, e.g. `["*.min.js", "*.map", "*.snap"]` (default: `[]`; project-level entries are merged with user-level ones, not replaced) |
| `regenerateWithDiff` | `true` re-sends the full diff on every regenerate for more varied rewrites; `false` (default) only asks the model to reword its previous message, which is far cheaper                                                       |
| `extraBody`          | Model-profile JSON fields merged into the request body, except `model`/`messages` (default: `{}`)                                                                                                                            |
| `reasoning`          | Global or model-profile reasoning controls: `mode` / `effort` (default: `on` / `medium`), `maxTokens`, and `maxDisplayChars`                                                                                                 |

Works with OpenAI, DeepSeek, [OpenRouter](https://openrouter.ai), MiniMax, [Kimi Code](https://www.kimi.com/code/docs/), Ollama (native `/api/chat` or OpenAI-compatible `/v1/chat/completions`), LiteLLM, and other compatible endpoints. HTTPS is required for remote endpoints; plaintext HTTP is accepted only for localhost/loopback.

See the bilingual [provider compatibility table](docs/provider-compatibility.md) for streaming, reasoning, token-budget, usage, and authentication boundaries.

### Repository policy and bounded context

The default generation contract is structured and versioned instead of being embedded in a free-form prompt. A user config can replace declaration arrays such as `types` and `scope.values` to make them stricter:

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

Each context category and the whole feature can be disabled independently. `conventions.trustedFiles` is accepted only from user-owned config; paths must stay inside the repository and resolve to regular, non-symlinked files. Project config can disable sources or lower existing ceilings, but cannot add trusted files, re-enable a user-disabled source, or raise any budget. Recognized scalar commitlint rules can set repository-specific types/scopes and lower the subject limit; commitlint files are read as data and never executed. Before a provider call, the terminal shows the categories, counts, and total characters selected.

Generated candidates are checked locally for policy format, type/scope, subject and body limits, breaking-change markers, and explicit language. A hard failure gets at most one low-cost correction request without re-sending the diff. Keyword/path alignment with the bounded diff is reported as an advisory warning because it is heuristic.

For a deterministic team gate, generate and commit the strict credential-free policy document, then use the same validator from a local `commit-msg` hook and CI:

```bash
aicommit policy template > .aicommit.policy.json
aicommit policy check --file=.git/COMMIT_EDITMSG
aicommit policy check --range=origin/main..HEAD --output=json
```

The complete team policy loads after personal settings. When one is present, `-l`/`--lang` is rejected instead of overriding the repository language. Machine output includes a policy fingerprint and issue codes but omits commit-message contents; policy commands never resolve credentials. See the bilingual [team migration guide and executable examples](docs/team-policy.md), plus the published [team-policy schema](schemas/aicommit-team-policy.schema.json).

### Provider reliability

Every provider adapter maps the same generation contract: messages, streaming, reasoning controls, output-token budget, normalized usage (`inputTokens`, `outputTokens`, `totalTokens`), and finish reason. Endpoint detection normally selects the adapter; set `providerType` when a compatible service uses a custom domain.

Requests retry only transient failures: HTTP 429, recoverable 5xx responses, network interruption, and interrupted response bodies. Retries are bounded by `retry.maxAttempts`, use capped exponential backoff, and honor `Retry-After` when present. Authentication, invalid-parameter, and content-safety failures are returned immediately without retrying.

### Built-in provider defaults

Setup uses validated provider defaults shipped with AICommit. OpenAI includes GPT-4o and GPT-5.6 profiles; DeepSeek includes V4 Flash and Pro; OpenRouter includes Auto plus current GPT, Claude, Gemini, DeepSeek, Qwen, GLM, Kimi, and Grok choices; Ollama includes Qwen 3, DeepSeek R1, and GPT-OSS profiles. These are starting points: setup keeps the model IDs editable and existing user-defined profiles take precedence. For another OpenAI-compatible service, add a named provider directly to the user config; no separate manifest installation or third-party executable code is required.

### Saving tokens

Token spend per call is dominated by the diff; aicommit already strips lock files, condenses oversized diffs, and never re-sends the diff on regenerate or retry. To trim further:

- Add generated artifacts to `stripFiles` (e.g. `["*.min.js", "*.map", "*.snap"]`) — their content is replaced with a one-line stub.
- Lower `maxDiffChars` (e.g. `15000`) if your commits are usually small.
- `diffContextLines` defaults to `1`; set it to `0` to send only changed lines with no context.
- Lower or disable individual `repositoryContext` categories when their style signal is not useful for your repository.

## Privacy and data flow

The bilingual [privacy model](docs/privacy.md) maps the local process, provider, credential, and distribution trust boundaries. The summary below covers the default runtime path.

AICommit has no hosted backend and does not record or upload usage metrics. At runtime it only makes generation requests to the `apiUrl` selected from your user-owned provider configuration. The API key is sent to that endpoint as authorization; verify custom endpoints before trusting them with credentials or repository content.

Commit-generation requests can contain:

- the configured system prompt and requested commit language;
- changed file paths/statuses and the staged diff in normal mode;
- changed file paths/statuses, tracked diffs, and bounded text previews of untracked files in split mode;
- bounded recent commit subjects, package boundaries, explicitly trusted convention excerpts, and recognized commitlint constraints when their context categories are enabled;
- the previous generated message when asking for a lower-cost rewrite;
- a small fixed prompt when `aicommit doctor` performs its live connectivity check.

AICommit does not intentionally send unrelated repository files, historical commit bodies, environment variables, or its local configuration file. Every selected diff, path list, history sample, preview, and convention excerpt is placed inside an explicit JSON envelope marked as untrusted data; the authoritative system policy instructs the model never to follow embedded repository instructions. Lock files, configured `stripFiles`, oversized sections, common sensitive filenames, private-key material, cloud access-key IDs, and credential-like assignments are omitted, truncated, or redacted before the default request. The interactive warning still allows explicitly sending the original diff, so review that choice carefully. Detection and prompt boundaries are guardrails, not complete secret or prompt-injection defenses.

Project-level configuration is treated as untrusted: it cannot change the endpoint, provider, credentials, retry policy, reasoning request controls, or increase user-configured data/cost ceilings. Prefer `apiKeyEnv` or the OS-backed Git credential helper for credentials. The setup wizard can save a literal key in the user config when requested; that file is written atomically with owner-only permissions where the OS supports them.

## Usage

```bash
aicommit setup           # interactive configuration wizard
aicommit update          # update the global npm installation to latest
aicommit doctor          # diagnose runtime, config, credentials, and connectivity
aicommit config show     # show the effective config with secrets redacted
aicommit config validate # validate config without resolving credentials
aicommit config path     # print user and project config paths
aicommit completion bash # generate Bash completion on stdout
aicommit                 # generate & commit in current directory
aicommit /path/to/repo   # or a target directory
aicommit split           # choose staged/all scope, then split logical commits
aicommit split --scope=staged # split only the reviewed index snapshot
aicommit split --scope=all # split the complete working-tree snapshot
aicommit --dry-run       # generate and review without creating a commit
aicommit split --dry-run # review a split plan without creating commits
aicommit --yes           # non-interactively commit already staged changes
aicommit --yes --dry-run # non-interactively preview all changes; restores staging
aicommit split --scope=all --yes # non-interactively plan and commit all working-tree changes
aicommit split plan --scope=staged --file=/tmp/split-plan.json --yes
aicommit split apply --file=/tmp/split-plan.json --yes
aicommit split resume --yes # resume an interrupted split transaction
aicommit split abort --yes # discard a stale checkpoint; keep commits and changes
aicommit --reasoning=low # stream low-effort reasoning; Ctrl+O expands/collapses it
aicommit --no-reasoning # explicitly disable reasoning when supported
aicommit -l zh           # commit message language
aicommit -p deepseek     # switch to the "deepseek" provider
aicommit -p deepseek -m reasoner # use its "reasoner" model profile
aicommit --yes --output=json # emit one schema-validated JSON result on stdout
aicommit -h              # help
```

| Option             | Description                                                                  |
| ------------------ | ---------------------------------------------------------------------------- |
| `-l`, `--lang`     | Commit message language (`zh` or `en`)                                       |
| `-p`, `--provider` | Use the named provider from `providers`                                      |
| `-m`, `--model`    | Use a named model profile from the selected provider                         |
| `--scope`          | `staged` or `all` scope for `aicommit split` and `aicommit split plan`       |
| `--file`           | JSON plan path for `aicommit split plan` and `aicommit split apply`          |
| `--dry-run`        | Generate and review a message or split plan without creating commits         |
| `-y`, `--yes`      | Accept without prompts; normal mode requires explicitly staged changes       |
| `--reasoning`      | Enable reasoning with `low`, `medium`, `high`, `xhigh`, or `max` effort      |
| `--no-reasoning`   | Explicitly disable reasoning when the selected provider/model supports it    |
| `--output`         | `text` (default) or one JSON object; commit/split JSON flows require `--yes` |
| `-v`, `--version`  | Show version                                                                 |
| `-h`, `--help`     | Show help                                                                    |

### Configuration inspection

`aicommit config show|validate|path` can run outside a repository and accepts an optional target directory. `show` applies the same user/project/team-policy trust filtering and provider/model selection as commit generation, but recursively masks secrets. `validate` parses, merges, and validates configuration without reading environment credentials or invoking Git credential helpers, making `aicommit config validate --output=json` safe for CI. `path` reports user config, project config, and team-policy locations even when a config file is malformed. `show` and `validate` accept `--provider=<name>` and `--model=<name>`.

### Shell completion

Completion scripts are generated from the installed CLI and contain no configuration or credentials:

```bash
# Bash
aicommit completion bash > ~/.local/share/bash-completion/completions/aicommit

# Zsh
mkdir -p ~/.zfunc
aicommit completion zsh > ~/.zfunc/_aicommit

# Fish
aicommit completion fish > ~/.config/fish/completions/aicommit.fish
```

For Zsh, add the completion directory to `fpath` before the line that initializes Oh My Zsh or another completion framework. For Oh My Zsh, place this in `~/.zshrc` before `source "$ZSH/oh-my-zsh.sh"`:

```zsh
fpath=("$HOME/.zfunc" $fpath)
source "$ZSH/oh-my-zsh.sh"
```

If no Zsh framework initializes completion, use this instead:

```zsh
fpath=("$HOME/.zfunc" $fpath)
autoload -Uz compinit
compinit
```

Restart Zsh after editing the file. If a previous completion cache prevents discovery, remove only that cache before restarting:

```bash
rm -f "$HOME"/.zcompdump*
exec zsh
```

Verify the registration with `whence -w _aicommit`; it should print `_aicommit: function`. Then type `aicommit`, add a space, and press `Tab`.

### Machine-readable output

Use `--output=json` for scripts and CI. Commit and split flows also require `--yes`, preventing a machine consumer from hanging on an interactive prompt. stdout contains exactly one JSON object; progress, debug details, and diagnostics go to stderr. `doctor --output=json` and `update --output=json` do not require `--yes`.

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

The published [JSON schema](schemas/aicommit-output.schema.json) covers success, split-plan, doctor/check, and error results. Machine output never includes the diff or model reasoning. Split output exposes only each group message and its assigned paths.

Stable process exits are shared by text and JSON modes:

| Exit  | Category                | Meaning                                       |
| ----- | ----------------------- | --------------------------------------------- |
| `0`   | success                 | Completed, previewed, or cancelled by policy  |
| `1`   | internal                | Unexpected internal failure                   |
| `2`   | config                  | Arguments, config, or credential setup        |
| `3`   | git_state               | Repository, index, or commit state            |
| `4`   | network                 | DNS, connection, timeout, or transport        |
| `5`   | provider                | Provider HTTP/API failure                     |
| `6`   | response_format         | Invalid or unusable model response            |
| `7`   | sensitive_data          | Non-interactive safety boundary               |
| `8`   | concurrent_modification | Protected Git state changed during generation |
| `130` | interrupt               | Interrupted with Ctrl+C                       |

### Diagnostics

`aicommit doctor` checks the running Node.js and Git versions, loaded config sources, endpoint security, selected adapter capabilities, redacted credential source, and a live provider connection. It prints source labels such as `env:OPENAI_API_KEY`, `git credential helper`, or `keyless localhost`, never the credential value. Endpoint userinfo, credential-like query parameters, and fragments are also redacted from normal output and credential-resolution errors. Use `aicommit doctor -p <provider> -m <model>` to select a configured provider/model pair or `aicommit doctor --output=json` in automation.

For stable error categories, npm verification failures, provider configuration, and split recovery, use the bilingual [troubleshooting matrix](docs/troubleshooting.md).

Flow: reads the staged diff, sends it to the AI, then lets you **accept** (Enter), **edit** (`e`), or **cancel** (`n`). In interactive selection prompts, `q` exits immediately. If nothing is staged but the working tree has unstaged or untracked changes, aicommit offers to stage them for you — all at once (`git add -A`) or file by file — before continuing. Once anything is staged, that index snapshot is authoritative; other working-tree changes are left untouched.

`--dry-run` follows the same review flow but stops before `git commit`. Any staging performed by aicommit is restored before it exits. Cancellation and failures use the same index transaction; if another process changed the index concurrently, aicommit leaves it untouched instead of overwriting that work.

Before repository content is sent, aicommit detects common sensitive filenames, private-key material, cloud access-key IDs, and credential-like assignments. Split mode scans the complete byte stream of each untracked regular file for these patterns while keeping the model preview bounded; the request reuses that captured preview instead of reopening the file. The default protected request omits sensitive file/private-key sections and redacts detected values; you can cancel or explicitly send the original diff. Untracked symbolic links and non-regular files are never opened for previews. In non-interactive split mode, detection fails closed before the API call because `split run --scope=all --yes` would otherwise auto-stage the sensitive file. This is a safety net, not a replacement for a dedicated secret scanner.

The staged index (or complete split-mode working tree, including untracked file bytes) is fingerprinted during generation and checked again immediately before committing. If it changed, the commit is aborted so the generated message cannot describe a different snapshot.

Reasoning defaults to `on` with `medium` effort. It is mapped natively for OpenAI reasoning models, DeepSeek, OpenRouter, and MiniMax; models that do not expose reasoning continue normally and show an unavailable notice instead of failing. Official OpenAI endpoints validate the selected effort against the model generation before sending the request, so unsupported combinations such as `o3 --no-reasoning` or `gpt-5.1 --reasoning=max` fail locally with a clear list of supported levels. DeepSeek's current `deepseek-v4-flash` and `deepseek-v4-pro` models receive `thinking: { "type": "enabled" }` plus `reasoning_effort`; `medium`/`xhigh` are normalized to DeepSeek's `high` level.

When reasoning mode is `on` (including via `--reasoning=<level>`), aicommit requests a streaming response and displays reasoning as it arrives. The live view follows the newest two terminal lines by default; press `Ctrl+O` to expand or collapse the accumulated text during generation or review. Long expanded output is kept inside the terminal viewport—use `PageUp`/`PageDown` to read every page. Holding `Ctrl+O` counts as one toggle, so key repeat cannot leave duplicate panels behind. Output is sanitized and capped by `reasoning.maxDisplayChars`; providers that do not expose reasoning show a short unavailable notice.

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

### Split mode

`aicommit split` (also available as the explicit `aicommit split run`) asks whether to group the staged index snapshot or all staged, unstaged, and untracked changes into file-level logical commits. Use `--scope=staged` or `--scope=all` when the boundary must be explicit, including every non-interactive run. You can review the plan, regenerate messages for selected groups, or edit the plan as JSON before committing. Sensitive-content detection fails closed before a non-interactive provider request or automatic staging.

For an auditable two-step flow, `aicommit split plan --scope=staged|all --file=<path>` exports a versioned JSON artifact, and `aicommit split apply --file=<path>` rechecks its base commit, change set, and content fingerprint before touching the index. Keep plan files outside the worktree or under the dedicated `.git/aicommit/` directory so they cannot become part of their own plan. Export never overwrites an existing destination.

Execution uses temporary indexes and a code-free checkpoint under `.git/aicommit`. A hook, Git error, interruption, or crash leaves completed commits in history and preserves the pending snapshot; the failure report shows checkpointed, in-flight, pending, and current worktree/index state. Resolve the cause and run `aicommit split resume`. Resume reconciles the possible post-commit crash window before creating anything else, so a completed group is neither duplicated nor omitted. If you intentionally finished or replaced the interrupted work through another Git workflow, run `aicommit split abort`; it removes only the stale checkpoint and never rewrites HEAD, the index, or the worktree. New committing split runs detect a checkpoint before contacting the provider. If planning or preflight fails before the first group, no split commit is created and the real index remains unchanged.

## Development and releases

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development and pull-request checks, [SECURITY.md](SECURITY.md) for private vulnerability reporting, [RELEASING.md](RELEASING.md) for the maintainer process, and the bilingual [distribution guide](docs/distribution.md) for npm installation and rollback. Releases use npm Trusted Publishing with provenance and publish the exact verified package tarball. `npm run eval` runs the anonymous local quality corpus covering single and mixed changes, renames, generated files, long diffs, Chinese/English output, and malformed weak-model candidates; it is also part of `npm run ci`.

## License

[MIT](LICENSE)
