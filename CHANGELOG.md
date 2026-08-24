# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Linux, macOS, and Windows CI across Node.js 18, 20, 22, and 24.
- ESLint, Prettier, c8 reporting, and a 70% minimum line-coverage gate.
- Setup and terminal UI smoke coverage plus installed-tarball dry-run tests.
- Release, security, contribution, privacy, and recovery documentation.

### Changed

- Constrained interactive prompt dependencies to releases that support Node.js 18.

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

[Unreleased]: https://github.com/hi-fullmoon/AICommit/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/hi-fullmoon/AICommit/releases/tag/v1.0.0
