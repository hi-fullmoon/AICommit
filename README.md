# aicommit

AI-powered git commit message generator: reads your diff, asks an AI model for a conventional commit message, and commits after your confirmation.

## Install

```bash
npm install -g .
```

Requires Node.js >= 18.

## Configure

Config is deep-merged: `./.aicommit.config.json` (project) overrides `~/.aicommit.config.json` (global). See [.aicommit.config.example.json](.aicommit.config.example.json).

```json
{
  "apiUrl": "https://api.deepseek.com/v1/chat/completions",
  "apiKey": "sk-...",
  "modelId": "deepseek-chat"
}
```

| Key           | Description                                           |
| ------------- | ----------------------------------------------------- |
| `apiUrl`      | OpenAI-compatible chat completions endpoint           |
| `apiKey`      | API key (empty string allowed for local models)       |
| `modelId`     | Model identifier                                      |
| `prompt`      | System prompt (a sensible default is built in)        |
| `language`    | Commit message language, `zh` or `en` (default: `zh`) |
| `temperature` | Sampling temperature (default: `0.3`)                 |
| `maxTokens`   | Max response tokens (default: `1024`)                 |

Works with any OpenAI-compatible API: OpenAI, DeepSeek, Ollama (`http://localhost:11434/v1/chat/completions`), LiteLLM, etc.

## Usage

```bash
aicommit                 # generate & commit in current directory
aicommit /path/to/repo   # or a target directory
aicommit --split         # split changes into multiple logical commits
aicommit -l zh           # commit message language
aicommit -h              # help
```

| Option            | Description                                   |
| ----------------- | --------------------------------------------- |
| `-l`, `--lang`    | Commit message language (`zh` or `en`)        |
| `-s`, `--split`   | Split changes into multiple logical commits   |
| `-v`, `--version` | Show version                                  |
| `-h`, `--help`    | Show help                                     |

Flow: reads the staged diff (falls back to unstaged changes), sends it to the AI, then lets you **accept** (Enter), **edit** (`e`), or **cancel** (`n`).

### Split mode

`--split` groups all changes (staged, unstaged, untracked) into logical commits by feature/module. You can review the plan, regenerate messages for selected groups, or edit the plan as JSON before committing. Splitting is file-level; if a commit fails mid-way, remaining groups are printed for manual completion.

## License

[MIT](LICENSE)
