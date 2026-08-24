# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-08-24

### Added

- Linux, macOS, and Windows CI across Node.js 18, 20, 22, and 24.
- ESLint, Prettier, c8 reporting, and a 70% minimum line-coverage gate.
- Setup and terminal UI smoke coverage plus installed-tarball dry-run tests.
- Release, security, contribution, privacy, and recovery documentation.
- Unified provider generation adapters and contract fixtures for OpenAI, OpenRouter, DeepSeek, MiniMax, Ollama, and custom endpoints.
- Bounded retries for rate limits, recoverable server failures, and interrupted network responses, including `Retry-After` support.
- Stable error categories and process exit codes for config, Git state, network, provider, response-format, sensitive-data, and concurrent-modification failures.
- `--output=text|json` with a published JSON schema and decoration-free stdout for automation.
- `aicommit doctor` diagnostics for runtime, configuration, endpoint security, provider capabilities, credentials, and connectivity.
- Optional Git credential-helper integration for OS-backed credential storage.
- Minimal local-only metrics with status, clear, enable, and disable commands.

### Changed

- Constrained interactive prompt dependencies to releases that support Node.js 18.
- Normalized provider usage as input, output, and total tokens and exposed finish reasons through one internal response contract.
- Environment credentials now take priority over credential helpers and legacy plaintext configuration.
- Installed-package smoke tests now verify the machine interface and published schema.

### Fixed

- Split planning scans complete untracked regular files for common sensitive content while keeping model previews bounded.
- Split planning no longer follows untracked symbolic links for previews or fingerprints.
- Non-interactive split mode fails closed before auto-staging detected sensitive files.
- Split-plan messages are sanitized before terminal display and commit execution.

## [1.0.0] - 2026-08-24

### Added

- Conventional commit generation in Chinese or English through OpenAI-compatible providers.
- Interactive staging, editing, regeneration, dry-run, reasoning display, and connection checks.
- File-level split planning and execution with Git-state concurrency checks.
- Provider presets and user/project configuration trust boundaries.

[Unreleased]: https://github.com/hi-fullmoon/AICommit/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/hi-fullmoon/AICommit/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/hi-fullmoon/AICommit/releases/tag/v1.0.0
