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

To configure by hand, start from [.aicommit.config.example.json](.aicommit.config.example.json). User config is loaded first, then allow-listed generation preferences from `./.aicommit.config.json` are deep-merged over it. Project config may set `language`, `prompt`, `stripFiles`, `temperature`, and the diff/token/timeout limits, but limits may only lower user-configured ceilings. Connection/provider fields (including `apiKeyEnv`), reasoning request controls, unknown keys, and oversized prompts are ignored with a warning. This prevents a cloned repository from redirecting an authenticated request or silently increasing its cost/data scope.

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

The selected provider's values are deep-merged over the top-level keys, so shared settings (`language`, `prompt`, `temperature`, `maxTokens`, ...) only need to be set once. Without `-p`, the `defaultProvider` is used (or the first entry in `providers` if `defaultProvider` is omitted). A flat single-model config (top-level `apiUrl`/`apiKey`/`modelId`, no `providers`) still works as before.

| Key                  | Description                                                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers`          | Named provider configs (`apiUrl`/`apiKey`/`modelId`/...)                                                                                                                                                                     |
| `defaultProvider`    | Provider used when `-p` is not given (renamed from `default`)                                                                                                                                                                |
| `apiUrl`             | OpenAI-compatible chat completions endpoint                                                                                                                                                                                  |
| `apiKey`             | API key (empty string allowed for local models)                                                                                                                                                                              |
| `apiKeyEnv`          | Environment variable containing the API key; takes precedence over `apiKey` (default: empty)                                                                                                                                 |
| `modelId`            | Model identifier                                                                                                                                                                                                             |
| `providerType`       | Optional adapter override: `openai`, `openrouter`, `deepseek`, `minimax`, `ollama`, or `custom`; otherwise inferred from the endpoint                                                                                        |
| `prompt`             | System prompt (a sensible default is built in)                                                                                                                                                                               |
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

### Provider reliability

Every provider adapter maps the same generation contract: messages, streaming, reasoning controls, output-token budget, normalized usage (`inputTokens`, `outputTokens`, `totalTokens`), and finish reason. Endpoint detection normally selects the adapter; set `providerType` when a compatible service uses a custom domain.

Requests retry only transient failures: HTTP 429, recoverable 5xx responses, network interruption, and interrupted response bodies. Retries are bounded by `retry.maxAttempts`, use capped exponential backoff, and honor `Retry-After` when present. Authentication, invalid-parameter, and content-safety failures are returned immediately without retrying.

### Saving tokens

Token spend per call is dominated by the diff; aicommit already strips lock files, condenses oversized diffs, and never re-sends the diff on regenerate or retry. To trim further:

- Add generated artifacts to `stripFiles` (e.g. `["*.min.js", "*.map", "*.snap"]`) — their content is replaced with a one-line stub.
- Lower `maxDiffChars` (e.g. `15000`) if your commits are usually small.
- `diffContextLines` defaults to `1`; set it to `0` to send only changed lines with no context.

## Privacy and data flow

AICommit has no hosted backend and no metrics-upload implementation. At runtime it only makes generation requests to the `apiUrl` selected from your user-owned provider configuration. The API key is sent to that endpoint as authorization; verify custom endpoints before trusting them with credentials or repository content.

Commit-generation requests can contain:

- the configured system prompt and requested commit language;
- changed file paths/statuses and the staged diff in normal mode;
- changed file paths/statuses, tracked diffs, and bounded text previews of untracked files in split mode;
- the previous generated message when asking for a lower-cost rewrite;
- a small fixed prompt when running `aicommit --check`.

AICommit does not intentionally send unrelated repository files, Git history, environment variables, or its local configuration file. Lock files, configured `stripFiles`, oversized sections, common sensitive filenames, private-key material, cloud access-key IDs, and credential-like assignments are omitted, truncated, or redacted before the default request. The interactive warning still allows explicitly sending the original diff, so review that choice carefully. Detection is a guardrail, not a complete secret scanner.

Project-level configuration is treated as untrusted: it cannot change the endpoint, provider, credentials, retry policy, metrics, reasoning request controls, or increase user-configured data/cost ceilings. Prefer `apiKeyEnv` or the OS-backed Git credential helper for credentials. The setup wizard can save a literal key in the user config when requested; that file is written atomically with owner-only permissions where the OS supports them.

Successful and failed commit runs write a minimal local JSONL metric by default to `~/.aicommit/metrics.jsonl`. Each record contains exactly duration, normalized token usage, a bounded result category, whether the message was edited, and the rewrite count. It never contains the diff, reasoning, commit message, file names, provider, model, or credentials. The file retains the newest 500 records by default and is written with owner-only permissions where supported. Use `aicommit metrics status|clear|enable|disable`; clearing is permanent. Set `metrics.enabled` to `false`, choose an absolute `metrics.path`, or change `metrics.maxEntries` in the user config. Project config cannot override these settings.

## Usage

```bash
aicommit setup           # interactive configuration wizard
aicommit doctor          # diagnose runtime, config, credentials, and connectivity
aicommit metrics status  # inspect local metrics state without uploading anything
aicommit                 # generate & commit in current directory
aicommit /path/to/repo   # or a target directory
aicommit --split         # split changes into multiple logical commits
aicommit --dry-run       # generate and review without creating a commit
aicommit --split --dry-run # review a split plan without creating commits
aicommit --yes           # non-interactively commit already staged changes
aicommit --yes --dry-run # non-interactively preview all changes; restores staging
aicommit --split --yes   # non-interactively plan and commit all working-tree changes
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
| `-s`, `--split`    | Split changes into multiple logical commits                                                          |
| `--dry-run`        | Generate and review a message or split plan without creating commits                                 |
| `-y`, `--yes`      | Accept without prompts; normal mode requires explicitly staged changes                               |
| `--reasoning`      | Enable reasoning with `low`, `medium`, `high`, `xhigh`, or `max` effort                              |
| `--no-reasoning`   | Explicitly disable reasoning when the selected provider/model supports it                            |
| `--output`         | `text` (default) or one JSON object; commit/split JSON flows require `--yes`                         |
| `-c`, `--check`    | Ping the provider to verify endpoint/key/model are working; failures use the stable classified exits |
| `-v`, `--version`  | Show version                                                                                         |
| `-h`, `--help`     | Show help                                                                                            |

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

`--split` groups all changes (staged, unstaged, and untracked) into logical commits by feature/module. It intentionally crosses the current index boundary. You can review the plan, regenerate messages for selected groups, or edit the plan as JSON before committing. `--split --yes` approves that complete working-tree scope non-interactively, except that sensitive-content detection fails closed before any provider request or automatic staging.

Current split behavior is file-level: one file cannot be divided across multiple commits. If execution fails after one or more groups, completed commits remain in history; AICommit does not rewrite or roll them back. The remaining groups' files are re-staged and printed, the CLI exits non-zero, and you should inspect `git status` plus `git diff --staged` before finishing them with plain `git commit`. If planning fails before execution, no split commit is created. Run split mode only from a worktree whose complete set of changes you intend to review and commit.

## Development and releases

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development and pull-request checks, [SECURITY.md](SECURITY.md) for private vulnerability reporting, and [RELEASING.md](RELEASING.md) for SemVer, release notes, tags, npm Trusted Publishing, provenance, and rollback procedures.

## License

[MIT](LICENSE)
