# Changelog

This file lists notable user-facing changes. Internal refactors, test-only changes, release mechanics, and documentation-only edits are omitted.

## [Unreleased]

## [1.5.0] - 2026-08-27

### Added

- Added a built-in Kimi Code provider preset and an environment-variable configuration example.

### Changed

- `aicommit split` now starts the interactive split flow directly; `aicommit split run` remains available as an alias.
- Repository policies can enforce their configured language without CLI overrides.
- Provider preset compatibility now follows SemVer rules for prerelease and build versions.
- Split commands detect unfinished checkpoints early and provide safe resume or abort actions.

### Security

- Sensitive URL components are redacted from configuration, diagnostics, debug output, extension input, and credential-helper errors.
- Provider extensions reject credential-like configuration fields and excessively deep nested input.

## 1.4.0 - 2026-08-24

### Added

- Added credential-free `config show`, `config validate`, and `config path` commands.
- Added generated shell completion for Bash, Zsh, and Fish.
- Added repository-owned team policies with deterministic local and CI checks.
- Added independently updateable provider presets with install, repair, and rollback support.
- Added an isolated extension API for context providers, message validators, and provider adapters.

### Changed

- Interactive setup now reads providers from the active preset manifest.

### Security

- Extension processes run with explicit permissions, a sanitized environment, and no provider credentials.
- Project configuration cannot enable extensions or weaken credential boundaries.

## 1.3.0 - 2026-08-24

### Added

- Added explicit staged/all split scopes and reusable `split plan` / `split apply` artifacts.
- Added resumable split checkpoints for interrupted or failed multi-commit operations.
- Added optional same-file hunk splitting for tracked text files.

### Changed

- Split commits are built from captured snapshots so later worktree edits cannot enter pending commits.
- Split apply and resume no longer require provider configuration or credentials.

### Security

- Split plans, checkpoints, paths, and hunk operations are validated before Git state is changed.

## 1.2.0 - 2026-08-24

### Added

- Added versioned commit policies for type, scope, subject, body, breaking changes, and language.
- Added bounded repository context from recent commits, package boundaries, trusted convention files, and recognized commitlint rules.
- Added local-only quality statistics with enable, disable, and clear controls.

### Changed

- Commit generation now uses an authoritative structured policy and locally validates candidate messages.
- Repository context categories and budgets can be configured without allowing project settings to expand user-owned limits.

### Security

- Repository and diff inputs are isolated as untrusted structured data.
- Trusted convention files cannot escape the repository or execute commitlint configuration code.

## 1.1.0 - 2026-08-24

### Added

- Added unified support for OpenAI, OpenRouter, DeepSeek, MiniMax, Ollama, and custom compatible endpoints.
- Added bounded retries for rate limits, recoverable server failures, and interrupted responses.
- Added stable error categories, process exit codes, and JSON output for automation.
- Added `aicommit doctor` diagnostics.
- Added optional Git credential-helper integration.

### Changed

- Environment credentials now take priority over credential helpers and legacy plaintext configuration.
- Provider usage is normalized as input, output, and total tokens.

### Security

- Sensitive untracked files are detected before non-interactive staging.
- Split previews avoid symbolic links and sanitize generated messages before display or commit.

## 1.0.0 - 2026-08-24

### Added

- Added Conventional Commit generation in Chinese or English through OpenAI-compatible providers.
- Added interactive staging, editing, regeneration, dry-run, reasoning display, and connection checks.
- Added file-level split planning and execution with Git-state concurrency checks.
- Added provider presets and user/project configuration boundaries.

[Unreleased]: https://github.com/hi-fullmoon/AICommit/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/hi-fullmoon/AICommit/releases/tag/v1.5.0
