# aicommit

AI-powered git commit message generator. Stages your changes, sends the diff to an AI model, and commits with the generated message — all with your confirmation.

## Install

```bash
cd aicommit
npm install -g .   # or: npm link
```

This makes `aicommit` available globally.

## Configure

Configuration is deep-merged from two sources (project wins over user):

| Priority | Path | Scope |
|----------|------|-------|
| Low | `~/.aicommit.config.json` | All projects (user-global) |
| High | `./.aicommit.config.json` | Current project only |

```json
{
  "apiUrl": "https://api.openai.com/v1/chat/completions",
  "apiKey": "sk-...",
  "modelId": "gpt-4o",
  "prompt": "Generate a concise, conventional commit message..."
}
```

- **apiUrl** — OpenAI-compatible chat completions endpoint (works with OpenAI, Claude API, Ollama, LiteLLM, etc.)
- **apiKey** — your API key (required)
- **modelId** — model identifier
- **prompt** — system prompt for commit message generation (a sensible default is built in)

### Example: DeepSeek

```json
{
  "apiUrl": "https://api.deepseek.com/v1/chat/completions",
  "apiKey": "sk-...",
  "modelId": "deepseek-v4-flash"
}
```

DeepSeek 原生兼容 OpenAI 格式，直接配置即可。常用模型：
- `deepseek-v4-flash` — 最新 V4 Flash，速度快
- `deepseek-chat` — 通用对话（V3）
- `deepseek-reasoner` — 深度推理（R1）

### Example: Claude API

```json
{
  "apiUrl": "https://api.anthropic.com/v1/messages",
  "apiKey": "sk-ant-...",
  "modelId": "claude-sonnet-5-20251001"
}
```

Note: when using Anthropic's native API you may need an adapter/proxy (e.g. LiteLLM) that speaks the OpenAI chat-completions format, or configure an OpenAI-compatible endpoint.

### Example: Local model (Ollama)

```json
{
  "apiUrl": "http://localhost:11434/v1/chat/completions",
  "apiKey": "",
  "modelId": "llama3.1"
}
```

## Usage

```bash
# Generate and commit in the current directory
aicommit

# Or specify a target directory
aicommit /path/to/project
aicommit .

# Show help
aicommit -h
aicommit --help

# Show version
aicommit -v
aicommit --version

# Split changes into multiple logical commits
aicommit --split
```

The tool will:
1. Read the staged diff (`git diff --staged`)
2. Send it to the configured AI model
3. Show the suggested commit message
4. Let you **accept** (Enter), **edit** (`e`), or **cancel** (`n`)

If no staged changes exist, it falls back to unstaged changes (`git diff`).

### Options

| Option            | Description                              |
|-------------------|------------------------------------------|
| `path`            | Target directory (default: current dir)  |
| `-h`, `--help`    | Show help message                        |
| `-v`, `--version` | Show version number                      |
| `-l`, `--lang`    | Commit message language (`zh` or `en`)   |
| `-s`, `--split`   | Split changes into multiple logical commits |

### Split mode (`--split`)

Groups all changes (staged, unstaged and untracked) into logical commits:

1. The AI partitions the changed files into groups by feature/module, each with a conventional commit message
2. You review the plan — **commit all**, **regenerate a message** for any group (uses that group's diff), **edit the plan** (JSON in your editor), or **cancel**
3. Each group is staged and committed in sequence

Notes: splitting is file-level (a file with two unrelated changes lands entirely in one group), and if a commit fails mid-way the already-made commits are kept and the remaining groups are printed for manual completion.

## License

MIT
