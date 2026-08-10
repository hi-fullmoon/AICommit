# aicommit

AI-powered git commit message generator: reads your diff, asks an AI model for a conventional commit message, and commits after your confirmation.

## Install

```bash
npm install -g .
```

Requires Node.js >= 18.

## Configure

Config is deep-merged: `./.aicommit.config.json` (project) overrides `~/.aicommit.config.json` (global). See [.aicommit.config.example.json](.aicommit.config.example.json).

Multiple providers can be defined and switched at runtime with `-p` / `--provider`:

```json
{
  "defaultProvider": "minimax",

  "providers": {
    "minimax": {
      "apiUrl": "https://api.minimaxi.com/v1/text/chatcompletion_v2",
      "apiKey": "sk-...",
      "modelId": "MiniMax-Text-01"
    },
    "deepseek": {
      "apiUrl": "https://api.deepseek.com/v1/chat/completions",
      "apiKey": "sk-...",
      "modelId": "deepseek-chat"
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

| Key        | Description                                                        |
| ---------- | ------------------------------------------------------------------ |
| `providers` | Named provider configs (`apiUrl`/`apiKey`/`modelId`/...)        |
| `defaultProvider` | Provider used when `-p` is not given (renamed from `default`) |
| `apiUrl`   | OpenAI-compatible chat completions endpoint                        |
| `apiKey`   | API key (empty string allowed for local models)                    |
| `modelId`  | Model identifier                                                   |
| `prompt`   | System prompt (a sensible default is built in)                     |
| `language` | Commit message language, `zh` or `en` (default: `zh`)              |
| `temperature` | Sampling temperature (default: `0.3`)                           |
| `maxTokens` | Max response tokens (default: `1024`)                             |
| `timeoutMs` | Per-request timeout in milliseconds (default: `120000`)            |
| `maxDiffChars` | Diff chars sent to the model per call; oversized diffs become a `--stat` summary + truncated hunks (default: `30000`) |
| `maxFileDiffChars` | Cap on a single file's diff section; bigger sections are truncated to their leading hunks so one huge file can't crowd out the rest (default: `3000`) |
| `diffContextLines` | Context lines around each diff hunk (`git diff --unified=<n>`); lower values mean fewer tokens (default: `3`) |
| `stripFiles` | Extra files to stub out of the diff like lock files, matched by basename with `*`/`?` wildcards, e.g. `["*.min.js", "*.map", "*.snap"]` (default: `[]`) |

Works with any OpenAI-compatible API: OpenAI, DeepSeek, [OpenRouter](https://openrouter.ai) (use model IDs like `openai/gpt-4o-mini`, `anthropic/claude-3.5-sonnet`, `deepseek/deepseek-chat`), Ollama (`http://localhost:11434/v1/chat/completions`), LiteLLM, etc.

## Usage

```bash
aicommit                 # generate & commit in current directory
aicommit /path/to/repo   # or a target directory
aicommit --split         # split changes into multiple logical commits
aicommit -l zh           # commit message language
aicommit -p deepseek     # switch to the "deepseek" provider
aicommit -c              # verify the configured LLM is reachable
aicommit -c -p openrouter # verify the "openrouter" provider specifically
aicommit -h              # help
```

| Option            | Description                                   |
| ----------------- | --------------------------------------------- |
| `-l`, `--lang`    | Commit message language (`zh` or `en`)        |
| `-p`, `--provider` | Use the named provider from `providers`      |
| `-s`, `--split`   | Split changes into multiple logical commits   |
| `-c`, `--check`   | Ping the provider to verify endpoint/key/model are working (exit 0 on success, 1 on failure) |
| `-v`, `--version` | Show version                                  |
| `-h`, `--help`    | Show help                                     |

Flow: reads the staged diff (aicommit never runs `git add` — stage what you want to commit first), sends it to the AI, then lets you **accept** (Enter), **edit** (`e`), or **cancel** (`n`).

### Split mode

`--split` groups all changes (staged, unstaged, untracked) into logical commits by feature/module. You can review the plan, regenerate messages for selected groups, or edit the plan as JSON before committing. Splitting is file-level; if a commit fails mid-way, remaining groups are printed for manual completion.

## License

[MIT](LICENSE)
