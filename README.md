# AICommit

AI-powered git commit message generator: reads your diff, asks an AI model for a conventional commit message, and commits after your confirmation.

## Install

```bash
npm install --global aicommit
```

Requires Node.js >= 18.

To install a source checkout instead, run `npm install --global .` from the repository root.

## Configure

The fastest way is the interactive wizard:

```bash
aicommit setup
```

It walks you through picking a provider (OpenAI, DeepSeek, OpenRouter, MiniMax, or a custom OpenAI-compatible endpoint), entering your API key and model, choosing the commit language, and optionally testing the connection. Configuration is written atomically to the user config (`~/.aicommit.config.json`); a malformed existing file is backed up before replacement.

To configure by hand, start from [.aicommit.config.example.json](.aicommit.config.example.json). User config is loaded first, then allow-listed generation preferences from `./.aicommit.config.json` are deep-merged over it. Project config may set `language`, `commitPolicy`, `stripFiles`, `temperature`, and lower diff/token/timeout or repository-context ceilings. A project-owned `prompt` is ignored unless the user config explicitly sets `allowProjectPrompt: true`. Connection/provider fields (including `apiKeyEnv`), reasoning request controls, unknown keys, and attempts to raise a ceiling are ignored with a warning. This prevents a cloned repository from redirecting an authenticated request or silently increasing its cost/data scope.

To keep a key out of the JSON file, set `"apiKeyEnv": "OPENAI_API_KEY"` (and leave `apiKey` empty), or enter `env:OPENAI_API_KEY` in the setup wizard. Environment variables take priority over every other credential source and are recommended for CI and other stateless environments.

AICommit can also read from the Git credential helper already configured on your OS. Enable `credentialHelper.enabled`, store the provider credential through your normal Git/OS credential workflow, and AICommit will call `git credential fill` without prompting. The lookup username defaults to `aicommit` and can be changed with `credentialHelper.username`. Credential resolution order is environment variable → Git credential helper → plaintext user config → keyless localhost. A project config cannot enable a helper or select a credential source.

Multiple providers can be defined and switched at runtime with `-p` / `--provider`:

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
    }
  }
}
```

The selected provider's values are deep-merged over the top-level keys, so shared settings (`language`, `commitPolicy`, `temperature`, `maxTokens`, ...) only need to be set once. Without `-p`, the `defaultProvider` is used (or the first entry in `providers` if `defaultProvider` is omitted). A flat single-model config (top-level `apiUrl`/`apiKey`/`modelId`, no `providers`) still works as before.

| Key                  | Description                                                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers`          | Named provider configs (`apiUrl`/`apiKey`/`modelId`/...)                                                                                                                                                                     |
| `defaultProvider`    | Provider used when `-p` is not given (renamed from `default`)                                                                                                                                                                |
| `apiUrl`             | OpenAI-compatible chat completions endpoint                                                                                                                                                                                  |
| `apiKey`             | API key (empty string allowed for local models)                                                                                                                                                                              |
| `apiKeyEnv`          | Environment variable containing the API key; takes precedence over `apiKey` (default: empty)                                                                                                                                 |
| `modelId`            | Model identifier                                                                                                                                                                                                             |
| `providerType`       | Optional adapter override: `openai`, `openrouter`, `deepseek`, `minimax`, `ollama`, or `custom`; otherwise inferred from the endpoint                                                                                        |
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
| `metrics`            | Local-only metrics controls: `enabled`, absolute `path` or empty for the default, and `maxEntries` (defaults: `true`, empty, and `500`)                                                                                      |
| `maxDiffChars`       | Diff chars sent to the model per call; oversized diffs become a `--stat` summary + truncated hunks (default: `30000`)                                                                                                        |
| `maxFileDiffChars`   | Cap on a single file's diff section; bigger sections are truncated to their leading hunks so one huge file can't crowd out the rest (default: `3000`)                                                                        |
| `splitMaxDiffChars`  | Diff chars sent to the split-planning call; split mode needs less hunk detail than final message generation (default: `16000`)                                                                                               |
| `splitMaxPlanFiles`  | Number of changed files shown to the split planner before extra files are swept into a catch-all commit (default: `100`)                                                                                                     |
| `diffContextLines`   | Context lines around each diff hunk (`git diff --unified=<n>`); lower values mean fewer tokens (default: `1`)                                                                                                                |
| `stripFiles`         | Extra files to stub out of the diff like lock files, matched by basename with `*`/`?` wildcards, e.g. `["*.min.js", "*.map", "*.snap"]` (default: `[]`; project-level entries are merged with user-level ones, not replaced) |
| `regenerateWithDiff` | `true` re-sends the full diff on every regenerate for more varied rewrites; `false` (default) only asks the model to reword its previous message, which is far cheaper                                                       |
| `extraBody`          | Extra provider-specific JSON fields merged into the request body, except `model`/`messages` (default: `{}`); standard requests send no vendor extensions unless explicitly configured                                        |
| `reasoning`          | Reasoning controls: `mode`, `effort`, `maxTokens`, and `maxDisplayChars`; defaults to `mode: "on"` and streams reasoning automatically                                                                                       |

Works with OpenAI, DeepSeek, [OpenRouter](https://openrouter.ai), MiniMax, Ollama (native `/api/chat` or OpenAI-compatible `/v1/chat/completions`), LiteLLM, and other compatible endpoints. HTTPS is required for remote endpoints; plaintext HTTP is accepted only for localhost/loopback.

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

The complete team policy loads after personal settings. Machine output includes a policy fingerprint and issue codes but omits commit-message contents; policy commands never resolve credentials. See the bilingual [team migration guide and executable examples](docs/team-policy.md), plus the published [team-policy schema](schemas/aicommit-team-policy.schema.json).

### Provider reliability

Every provider adapter maps the same generation contract: messages, streaming, reasoning controls, output-token budget, normalized usage (`inputTokens`, `outputTokens`, `totalTokens`), and finish reason. Endpoint detection normally selects the adapter; set `providerType` when a compatible service uses a custom domain.

Requests retry only transient failures: HTTP 429, recoverable 5xx responses, network interruption, and interrupted response bodies. Retries are bounded by `retry.maxAttempts`, use capped exponential backoff, and honor `Retry-After` when present. Authentication, invalid-parameter, and content-safety failures are returned immediately without retrying.

### Saving tokens

Token spend per call is dominated by the diff; aicommit already strips lock files, condenses oversized diffs, and never re-sends the diff on regenerate or retry. To trim further:

- Add generated artifacts to `stripFiles` (e.g. `["*.min.js", "*.map", "*.snap"]`) — their content is replaced with a one-line stub.
- Lower `maxDiffChars` (e.g. `15000`) if your commits are usually small.
- `diffContextLines` defaults to `1`; set it to `0` to send only changed lines with no context.
- Lower or disable individual `repositoryContext` categories when their style signal is not useful for your repository.

## Privacy and data flow

AICommit has no hosted backend and no metrics-upload implementation. At runtime it only makes generation requests to the `apiUrl` selected from your user-owned provider configuration. The API key is sent to that endpoint as authorization; verify custom endpoints before trusting them with credentials or repository content.

Commit-generation requests can contain:

- the configured system prompt and requested commit language;
- changed file paths/statuses and the staged diff in normal mode;
- changed file paths/statuses, tracked diffs, and bounded text previews of untracked files in split mode;
- bounded recent commit subjects, package boundaries, explicitly trusted convention excerpts, and recognized commitlint constraints when their context categories are enabled;
- the previous generated message when asking for a lower-cost rewrite;
- a small fixed prompt when running `aicommit --check`.

AICommit does not intentionally send unrelated repository files, historical commit bodies, environment variables, or its local configuration file. Every selected diff, path list, history sample, preview, and convention excerpt is placed inside an explicit JSON envelope marked as untrusted data; the authoritative system policy instructs the model never to follow embedded repository instructions. Lock files, configured `stripFiles`, oversized sections, common sensitive filenames, private-key material, cloud access-key IDs, and credential-like assignments are omitted, truncated, or redacted before the default request. The interactive warning still allows explicitly sending the original diff, so review that choice carefully. Detection and prompt boundaries are guardrails, not complete secret or prompt-injection defenses.

Project-level configuration is treated as untrusted: it cannot change the endpoint, provider, credentials, retry policy, metrics, reasoning request controls, or increase user-configured data/cost ceilings. Prefer `apiKeyEnv` or the OS-backed Git credential helper for credentials. The setup wizard can save a literal key in the user config when requested; that file is written atomically with owner-only permissions where the OS supports them.

Successful and failed commit runs write a minimal local JSONL metric by default to `~/.aicommit/metrics.jsonl`. Each record contains exactly duration, normalized token usage, a bounded result category, whether the message was edited, and the rewrite count (including automatic policy correction). It never contains the diff, reasoning, commit message, file names, provider, model, or credentials. The file retains the newest 500 records by default and is written with owner-only permissions where supported.

Use `aicommit stats` to view first-pass acceptance, edit/rewrite/failure rates, P50/P95 latency, token totals, and recent-vs-previous trends. After ten successful runs it compares two chronological baseline windows and reports progress toward the roadmap's 20% relative edit/rewrite-rate improvement target. `aicommit stats clear|enable|disable` manages the same local store; clearing is permanent. The lower-level `aicommit metrics status|clear|enable|disable` commands remain available. Set `metrics.enabled` to `false`, choose an absolute `metrics.path`, or change `metrics.maxEntries` in the user config. Project config cannot override these settings, and there is no upload implementation.

## Usage

```bash
aicommit setup           # interactive configuration wizard
aicommit doctor          # diagnose runtime, config, credentials, and connectivity
aicommit config show     # show the effective config with secrets redacted
aicommit config validate # validate config without resolving credentials
aicommit config path     # print user and project config paths
aicommit completion bash # generate Bash completion on stdout
aicommit metrics status  # inspect local metrics state without uploading anything
aicommit stats           # show local quality, latency, and token trends
aicommit stats clear     # permanently clear local metric history
aicommit                 # generate & commit in current directory
aicommit /path/to/repo   # or a target directory
aicommit --split         # choose staged/all scope, then split logical commits
aicommit --split=staged  # split only the reviewed index snapshot
aicommit --split=all     # split the complete working-tree snapshot
aicommit --split=staged --split-hunks # experimental same-file hunk splitting
aicommit --dry-run       # generate and review without creating a commit
aicommit --split --dry-run # review a split plan without creating commits
aicommit --yes           # non-interactively commit already staged changes
aicommit --yes --dry-run # non-interactively preview all changes; restores staging
aicommit --split=all --yes # non-interactively plan and commit all working-tree changes
aicommit split plan --scope=staged --file=/tmp/split-plan.json --yes
aicommit split apply --file=/tmp/split-plan.json --yes
aicommit split --resume --yes # resume an interrupted split transaction
aicommit --reasoning=low # stream low-effort reasoning; Ctrl+O expands/collapses it
aicommit --no-reasoning # explicitly disable reasoning when supported
aicommit -l zh           # commit message language
aicommit -p deepseek     # switch to the "deepseek" provider
aicommit --yes --output=json # emit one schema-validated JSON result on stdout
aicommit -c              # verify the configured LLM is reachable
aicommit -c -p openrouter # verify the "openrouter" provider specifically
aicommit -h              # help
```

| Option             | Description                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `-l`, `--lang`     | Commit message language (`zh` or `en`)                                                               |
| `-p`, `--provider` | Use the named provider from `providers`                                                              |
| `-s`, `--split`    | Choose a scope and split changes; use `--split=staged\|all` to select it explicitly                  |
| `--split-hunks`    | Opt in to experimental same-file text-hunk planning; disabled by default                             |
| `--scope`          | `staged` or `all` scope for `aicommit split plan`                                                    |
| `--file`           | JSON plan path for `aicommit split plan` and `aicommit split apply`                                  |
| `--dry-run`        | Generate and review a message or split plan without creating commits                                 |
| `-y`, `--yes`      | Accept without prompts; normal mode requires explicitly staged changes                               |
| `--reasoning`      | Enable reasoning with `low`, `medium`, `high`, `xhigh`, or `max` effort                              |
| `--no-reasoning`   | Explicitly disable reasoning when the selected provider/model supports it                            |
| `--output`         | `text` (default) or one JSON object; commit/split JSON flows require `--yes`                         |
| `-c`, `--check`    | Ping the provider to verify endpoint/key/model are working; failures use the stable classified exits |
| `-v`, `--version`  | Show version                                                                                         |
| `-h`, `--help`     | Show help                                                                                            |

### Configuration inspection

`aicommit config show|validate|path` can run outside a repository and accepts an optional target directory. `show` applies the same user/project/team-policy trust filtering and provider selection as commit generation, but recursively masks secrets. `validate` parses, merges, and validates configuration without reading environment credentials or invoking Git credential helpers, making `aicommit config validate --output=json` safe for CI. `path` reports user config, project config, and team-policy locations even when a config file is malformed. `show` and `validate` accept `--provider=<name>`.

### Shell completion

Completion scripts are generated from the installed CLI and contain no configuration or credentials:

```bash
# Bash
aicommit completion bash > ~/.local/share/bash-completion/completions/aicommit

# Zsh (ensure the destination directory is in $fpath)
aicommit completion zsh > ~/.zfunc/_aicommit

# Fish
aicommit completion fish > ~/.config/fish/completions/aicommit.fish
```

### Machine-readable output

Use `--output=json` for scripts and CI. Commit and split flows also require `--yes`, preventing a machine consumer from hanging on an interactive prompt. stdout contains exactly one JSON object; progress, debug details, and diagnostics go to stderr. `--check --output=json` and `doctor --output=json` do not require `--yes`.

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

`aicommit doctor` checks the running Node.js and Git versions, loaded config sources, endpoint security, selected adapter capabilities, redacted credential source, and a live provider connection. It prints source labels such as `env:OPENAI_API_KEY`, `git credential helper`, or `keyless localhost`, never the credential value. Use `aicommit doctor -p <name>` to select a configured provider or `aicommit doctor --output=json` in automation.

Flow: reads the staged diff, sends it to the AI, then lets you **accept** (Enter), **edit** (`e`), or **cancel** (`n`). If nothing is staged but the working tree has unstaged or untracked changes, aicommit offers to stage them for you — all at once (`git add -A`) or file by file — before continuing. If some changes are staged but others are not, aicommit asks whether to include the rest in this commit.

`--dry-run` follows the same review flow but stops before `git commit`. Any staging performed by aicommit is restored before it exits. Cancellation and failures use the same index transaction; if another process changed the index concurrently, aicommit leaves it untouched instead of overwriting that work.

Before repository content is sent, aicommit detects common sensitive filenames, private-key material, cloud access-key IDs, and credential-like assignments. Split mode scans the complete byte stream of each untracked regular file for these patterns while keeping the model preview bounded; the request reuses that captured preview instead of reopening the file. The default protected request omits sensitive file/private-key sections and redacts detected values; you can cancel or explicitly send the original diff. Untracked symbolic links and non-regular files are never opened for previews. In non-interactive split mode, detection fails closed before the API call because `--split --yes` would otherwise auto-stage the sensitive file. This is a safety net, not a replacement for a dedicated secret scanner.

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

`--split` asks whether to group the staged index snapshot or all staged, unstaged, and untracked changes into logical commits. Use `--split=staged` or `--split=all` when the boundary must be explicit, including every non-interactive run. You can review the plan, regenerate messages for selected groups, or edit the plan as JSON before committing. Sensitive-content detection fails closed before a non-interactive provider request or automatic staging.

For an auditable two-step flow, `aicommit split plan --scope=staged|all --file=<path>` exports a versioned JSON artifact, and `aicommit split apply --file=<path>` rechecks its base commit, change set, and content fingerprint before touching the index. Keep plan files outside the worktree or under `.git` so they cannot become part of their own plan.

Execution uses temporary indexes and a code-free checkpoint under `.git/aicommit`. A hook, Git error, interruption, or crash leaves completed commits in history and preserves the pending snapshot; the failure report shows checkpointed, in-flight, pending, and current worktree/index state. Resolve the cause and run `aicommit split --resume`. Resume reconciles the possible post-commit crash window before creating anything else, so a completed group is neither duplicated nor omitted. If planning or preflight fails before the first group, no split commit is created and the real index remains unchanged.

Split remains file-level by default. `--split-hunks` opts in to experimental same-file splitting for tracked text modifications with multiple unified-diff hunks. The JSON plan and checkpoint store only hunk IDs, line ranges, and hashes—not patch content. Before the first commit, AICommit applies every selected patch to a temporary index and requires the final tree to reproduce the captured target blobs exactly; parsing, patching, binary/mode-change, or lossless-validation failures fall back to a file-level plan. The worktree is never modified by hunk execution.

## Development and releases

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development and pull-request checks, [SECURITY.md](SECURITY.md) for private vulnerability reporting, and [RELEASING.md](RELEASING.md) for SemVer, release notes, tags, npm Trusted Publishing, provenance, and rollback procedures. `npm run eval` runs the anonymous local quality corpus covering single and mixed changes, renames, generated files, long diffs, Chinese/English output, and malformed weak-model candidates; it is also part of `npm run ci`.

## License

[MIT](LICENSE)
