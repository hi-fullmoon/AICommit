# aicommit

AI-powered git commit message generator: reads your diff, asks an AI model for a conventional commit message, and commits after your confirmation.

## Install

```bash
npm install -g .
```

Requires Node.js >= 18.

## Configure

Config is deep-merged: `./.aicommit.config.json` (project) overrides `~/.aicommit.config.json` (global). See [.aicommit.config.example.json](.aicommit.config.example.json).

Multiple providers can be defined and switched at runtime with `-m` / `--model`:

```json
{
  "default": "minimax",

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
    }
  }
}
```

The selected provider's values are deep-merged over the top-level keys, so shared settings (`language`, `prompt`, `temperature`, `maxTokens`, ...) only need to be set once. Without `-m`, the `default` provider is used (or the first entry in `providers` if `default` is omitted). A flat single-model config (top-level `apiUrl`/`apiKey`/`modelId`, no `providers`) still works as before.

| Key        | Description                                                        |
| ---------- | ------------------------------------------------------------------ |
| `providers` | Named provider configs (`apiUrl`/`apiKey`/`modelId`/...)        |
| `default`  | Provider used when `-m` is not given                               |
| `apiUrl`   | OpenAI-compatible chat completions endpoint                        |
| `apiKey`   | API key (empty string allowed for local models)                    |
| `modelId`  | Model identifier                                                   |
| `prompt`   | System prompt (a sensible default is built in)                     |
| `language` | Commit message language, `zh` or `en` (default: `zh`)              |
| `temperature` | Sampling temperature (default: `0.3`)                           |
| `maxTokens` | Max response tokens (default: `1024`)                             |

Works with any OpenAI-compatible API: OpenAI, DeepSeek, Ollama (`http://localhost:11434/v1/chat/completions`), LiteLLM, etc.

## Usage

```bash
aicommit                 # generate & commit in current directory
aicommit /path/to/repo   # or a target directory
aicommit --split         # split changes into multiple logical commits
aicommit -l zh           # commit message language
aicommit -m deepseek     # switch to the "deepseek" provider
aicommit -h              # help
```

| Option            | Description                                   |
| ----------------- | --------------------------------------------- |
| `-l`, `--lang`    | Commit message language (`zh` or `en`)        |
| `-m`, `--model`   | Use the named provider from `providers`       |
| `-s`, `--split`   | Split changes into multiple logical commits   |
| `-v`, `--version` | Show version                                  |
| `-h`, `--help`    | Show help                                     |

Flow: reads the staged diff (falls back to unstaged changes), sends it to the AI, then lets you **accept** (Enter), **edit** (`e`), or **cancel** (`n`).

### Split mode

`--split` groups all changes (staged, unstaged, untracked) into logical commits by feature/module. You can review the plan, regenerate messages for selected groups, or edit the plan as JSON before committing. Splitting is file-level; if a commit fails mid-way, remaining groups are printed for manual completion.

## License

[MIT](LICENSE)
