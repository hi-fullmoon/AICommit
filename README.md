# AICommit

AI-powered git commit message generator: reads your diff, asks an AI model for a conventional commit message, and commits after your confirmation.

## Install

```bash
npm install -g .
```

Requires Node.js >= 18.

## Configure

The fastest way is the interactive wizard:

```bash
aicommit setup
```

It walks you through picking a provider (OpenAI, DeepSeek, OpenRouter, MiniMax, or a custom OpenAI-compatible endpoint), entering your API key and model, choosing the commit language, and optionally testing the connection — then writes the config for you (global or project level, your choice).

To configure by hand instead: config is deep-merged: `./.aicommit.config.json` (project) overrides `~/.aicommit.config.json` (global). See [.aicommit.config.example.json](.aicommit.config.example.json).

Multiple providers can be defined and switched at runtime with `-p` / `--provider`:

```json
{
  "defaultProvider": "minimax",

  "providers": {
    "minimax": {
      "apiUrl": "https://api.minimaxi.com/v1/chat/completions",
      "apiKey": "sk-...",
      "modelId": "MiniMax-M3",
      "extraBody": {
        "thinking": { "type": "disabled" },
        "reasoning_split": true
      }
    },
    "deepseek": {
      "apiUrl": "https://api.deepseek.com/v1/chat/completions",
      "apiKey": "sk-...",
      "modelId": "deepseek-v4-flash"
    },
    "openrouter": {
      "apiUrl": "https://openrouter.ai/api/v1/chat/completions",
      "apiKey": "sk-or-v1-...",
      "modelId": "openai/gpt-4o-mini"
    }
  }
}
```

The selected provider's values are deep-merged over the top-level keys, so shared settings (`language`, `prompt`, `temperature`, `maxTokens`, ...) only need to be set once. Without `-p`, the `defaultProvider` is used (or the first entry in `providers` if `defaultProvider` is omitted). A flat single-model config (top-level `apiUrl`/`apiKey`/`modelId`, no `providers`) still works as before.

| Key                | Description                                                                                                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers`        | Named provider configs (`apiUrl`/`apiKey`/`modelId`/...)                                                                                                                                                                     |
| `defaultProvider`  | Provider used when `-p` is not given (renamed from `default`)                                                                                                                                                                |
| `apiUrl`           | OpenAI-compatible chat completions endpoint                                                                                                                                                                                  |
| `apiKey`           | API key (empty string allowed for local models)                                                                                                                                                                              |
| `modelId`          | Model identifier                                                                                                                                                                                                             |
| `prompt`           | System prompt (a sensible default is built in)                                                                                                                                                                               |
| `language`         | Commit message language, `zh` or `en` (default: `zh`)                                                                                                                                                                        |
| `temperature`      | Sampling temperature (default: `0.3`)                                                                                                                                                                                        |
| `maxTokens`        | Max response tokens (default: `1024`)                                                                                                                                                                                        |
| `timeoutMs`        | Per-request timeout in milliseconds (default: `120000`)                                                                                                                                                                      |
| `maxDiffChars`     | Diff chars sent to the model per call; oversized diffs become a `--stat` summary + truncated hunks (default: `30000`)                                                                                                        |
| `maxFileDiffChars` | Cap on a single file's diff section; bigger sections are truncated to their leading hunks so one huge file can't crowd out the rest (default: `3000`)                                                                        |
| `splitMaxDiffChars` | Diff chars sent to the split-planning call; split mode needs less hunk detail than final message generation (default: `16000`)                                                                                              |
| `splitMaxPlanFiles` | Number of changed files shown to the split planner before extra files are swept into a catch-all commit (default: `100`)                                                                                                    |
| `diffContextLines` | Context lines around each diff hunk (`git diff --unified=<n>`); lower values mean fewer tokens (default: `1`)                                                                                                                |
| `stripFiles`       | Extra files to stub out of the diff like lock files, matched by basename with `*`/`?` wildcards, e.g. `["*.min.js", "*.map", "*.snap"]` (default: `[]`; project-level entries are merged with user-level ones, not replaced) |
| `regenerateWithDiff` | `true` re-sends the full diff on every regenerate for more varied rewrites; `false` (default) only asks the model to reword its previous message, which is far cheaper |
| `extraBody`         | Extra provider-specific JSON fields merged into the request body, except `model`/`messages` (default: `{}`); standard requests send no vendor extensions unless explicitly configured |
| `reasoning`         | Reasoning controls: `mode`, `effort`, `maxTokens`, and `maxDisplayChars`; defaults to `mode: "on"` and streams reasoning automatically |

Works with any OpenAI-compatible API: OpenAI, DeepSeek, [OpenRouter](https://openrouter.ai) (use model IDs like `openai/gpt-4o-mini`, `anthropic/claude-3.5-sonnet`, `deepseek/deepseek-chat`), Ollama (`http://localhost:11434/v1/chat/completions`), LiteLLM, etc.

### Saving tokens

Token spend per call is dominated by the diff; aicommit already strips lock files, condenses oversized diffs, and never re-sends the diff on regenerate or retry. To trim further:

- Add generated artifacts to `stripFiles` (e.g. `["*.min.js", "*.map", "*.snap"]`) — their content is replaced with a one-line stub.
- Lower `maxDiffChars` (e.g. `15000`) if your commits are usually small.
- `diffContextLines` defaults to `1`; set it to `0` to send only changed lines with no context.

## Usage

```bash
aicommit setup           # interactive configuration wizard
aicommit                 # generate & commit in current directory
aicommit /path/to/repo   # or a target directory
aicommit --split         # split changes into multiple logical commits
aicommit --dry-run       # generate and review without creating a commit
aicommit --split --dry-run # review a split plan without creating commits
aicommit --reasoning=low # stream low-effort reasoning; Ctrl+O expands/collapses it
aicommit --no-reasoning # explicitly disable reasoning when supported
aicommit -l zh           # commit message language
aicommit -p deepseek     # switch to the "deepseek" provider
aicommit -c              # verify the configured LLM is reachable
aicommit -c -p openrouter # verify the "openrouter" provider specifically
aicommit -h              # help
```

| Option             | Description                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `-l`, `--lang`     | Commit message language (`zh` or `en`)                                                       |
| `-p`, `--provider` | Use the named provider from `providers`                                                      |
| `-s`, `--split`    | Split changes into multiple logical commits                                                  |
| `--dry-run`        | Generate and review a message or split plan without creating commits                         |
| `--reasoning`      | Enable reasoning with `low`, `medium`, `high`, `xhigh`, or `max` effort                       |
| `--no-reasoning`   | Explicitly disable reasoning when the selected provider/model supports it                     |
| `-c`, `--check`    | Ping the provider to verify endpoint/key/model are working (exit 0 on success, 1 on failure) |
| `-v`, `--version`  | Show version                                                                                 |
| `-h`, `--help`     | Show help                                                                                    |

Flow: reads the staged diff, sends it to the AI, then lets you **accept** (Enter), **edit** (`e`), or **cancel** (`n`). If nothing is staged but the working tree has unstaged or untracked changes, aicommit offers to stage them for you — all at once (`git add -A`) or file by file — before continuing. If some changes are staged but others are not, aicommit asks whether to include the rest in this commit.

`--dry-run` follows the same review flow but stops before `git commit`. If you choose to stage files interactively, they remain staged after the dry run.

Reasoning defaults to `on` with `low` effort. It is mapped natively for OpenAI reasoning models, DeepSeek, OpenRouter, and MiniMax; models that do not expose reasoning continue normally and show an unavailable notice instead of failing. Official OpenAI endpoints validate the selected effort against the model generation before sending the request, so unsupported combinations such as `o3 --no-reasoning` or `gpt-5.1 --reasoning=max` fail locally with a clear list of supported levels. DeepSeek's current `deepseek-v4-flash` and `deepseek-v4-pro` models receive `thinking: { "type": "enabled" }` plus `reasoning_effort`; `medium`/`xhigh` are normalized to DeepSeek's `high` level.

When reasoning mode is `on` (including via `--reasoning=<level>`), aicommit requests a streaming response and displays reasoning as it arrives. The live view follows the newest two terminal lines by default; press `Ctrl+O` to expand or collapse the accumulated text during generation or review. Long expanded output is kept inside the terminal viewport—use `PageUp`/`PageDown` to read every page. Holding `Ctrl+O` counts as one toggle, so key repeat cannot leave duplicate panels behind. Output is sanitized and capped by `reasoning.maxDisplayChars`; providers that do not expose reasoning show a short unavailable notice.

```json
{
  "reasoning": {
    "mode": "on",
    "effort": "low",
    "maxTokens": 4096,
    "maxDisplayChars": 12000,
    "enabledBody": { "enable_thinking": true },
    "disabledBody": { "enable_thinking": false }
  }
}
```

### Split mode

`--split` groups all changes (staged, unstaged, untracked) into logical commits by feature/module. You can review the plan, regenerate messages for selected groups, or edit the plan as JSON before committing. Splitting is file-level; if a commit fails mid-way, the remaining groups' files are re-staged and printed so you can finish with plain `git commit`.

## License

[MIT](LICENSE)
