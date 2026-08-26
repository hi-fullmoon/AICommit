# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Repository team policies now reject `-l`/`--lang` overrides, inherited policy languages are enforced during candidate validation, and split extension violations remain reviewable before commit.
- Provider preset compatibility now accepts valid core prerelease/build versions and compares prereleases using SemVer precedence.

### Security

- Provider endpoint userinfo, credential-like query parameters, and fragments are redacted from config inspection, diagnostics, debug output, extension inputs, and credential-helper failures.
- Extension provider adapters reject a broader set of credential-like request/configuration fields and fail closed when nested input exceeds the inspection depth.

## [1.4.0] - 2026-08-24

### Added

- Credential-free `aicommit config show|validate|path` inspection and generated Bash, Zsh, and Fish completion.
- Strict repository-owned team policy template plus deterministic local/CI `policy check` commands and bilingual migration examples.
- Independently updateable, versioned provider preset manifests with core/adapter compatibility declarations, atomic install, repair, and rollback.
- Credential-denied extension API v1 with isolated context-provider, message-validator, and provider-adapter interfaces, a strict manifest schema, and bilingual executable documentation.
- Signed GitHub release assets with SHA-256 checksums, SPDX SBOM, GitHub OIDC/Sigstore attestations, npm Trusted Publishing provenance, and a generated Homebrew formula.
- Automated npm/Homebrew installation smoke paths plus bilingual distribution, troubleshooting, privacy, and provider-compatibility guides.

### Changed

- Interactive setup now consumes the active provider preset manifest instead of a hard-coded provider list.
- Provider request orchestration accepts asynchronous built-in or extension adapters without changing the Git and interaction flows.

### Security

- Third-party extension code runs in a permissioned child process with a sanitized environment and no credential value; project config cannot enable extensions, v1 rejects credential permission requests, and Node.js 18 never falls back to unsandboxed execution.
- Team policy, config inspection, and preset management never resolve provider credentials; preset and extension manifests reject credential-bearing fields, unsafe paths, and incompatible contracts.

## [1.3.0] - 2026-08-24

### Added

- Explicit `--split=staged|all` scope selection plus versioned `aicommit split plan/apply` JSON artifacts with base-HEAD, change-set, and content-fingerprint validation.
- Code-free, owner-only split checkpoints and `aicommit split --resume`, including reconciliation of the post-commit/pre-checkpoint crash window.
- Strict split preflight checks for empty or duplicate groups, path coverage, rename/copy sides, conflicts, changed submodules, active hooks, and unborn branches.
- Opt-in `--split-hunks` support for tracked multi-hunk text modifications, with hunk IDs/ranges/hashes in plans and machine output.
- A shared end-to-end split fault matrix for SIGINT, process crashes, concurrent edits, hook failures, renames, deletions, binary files, and submodules.

### Changed

- Every split group is now created from an immutable captured object snapshot through a temporary index; later worktree edits cannot silently enter pending commits.
- Hook and Git failures report checkpointed, in-flight, pending, and current worktree/index state without reordering or duplicating groups.
- Split apply and resume run without loading provider configuration or credentials.

### Security

- Split plan and checkpoint readers reject unsafe paths, unknown fields, oversized artifacts, and symbolic links; artifacts never contain diffs, patch text, or file content.
- Experimental hunk execution validates selected patches entirely in temporary indexes and requires the final tree to reproduce every captured target blob exactly; otherwise planning falls back to file-level groups before the first commit.

## [1.2.0] - 2026-08-24

### Added

- Versioned `commitPolicy` rules for types, scopes, subject length, body, breaking changes, and language.
- Strictly bounded repository context from recent commit subjects, package boundaries, user-trusted convention files, and statically recognized commitlint rules.
- `aicommit stats` for local first-pass acceptance, edit/rewrite/failure rates, latency, token trends, and the 20% quality-improvement baseline; stats can be disabled or permanently cleared.
- Anonymous local eval coverage for single/mixed changes, renames, generated files, long diffs, Chinese/English output, and malformed weak-model candidates, enforced in CI at 99% or better.

### Changed

- Replaced the default free-form prompt contract with an authoritative structured policy; user guidance is additive, and project-owned prompts now require the user-owned `allowProjectPrompt` opt-in.
- Commit generation now shows a bounded context summary before the provider request and allows every repository-context category to be disabled independently.
- Candidate responses are validated locally for policy compliance and diff/path alignment; hard policy failures receive at most one low-cost correction without re-sending the diff.
- Automatic policy corrections now contribute to the anonymous local rewrite metric.

### Security

- Diff, file, path, history, and convention inputs now use explicit JSON envelopes marked as untrusted data, backed by a prompt-injection regression corpus.
- Project config can only disable repository context or lower user-owned ceilings; it cannot add trusted convention files, re-enable sources, expand budgets, or alter endpoints and credentials.
- Trusted convention reads reject paths outside the repository, symbolic links, and non-regular files; commitlint configuration is parsed as data and never executed.

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

[Unreleased]: https://github.com/hi-fullmoon/AICommit/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/hi-fullmoon/AICommit/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/hi-fullmoon/AICommit/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/hi-fullmoon/AICommit/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/hi-fullmoon/AICommit/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/hi-fullmoon/AICommit/releases/tag/v1.0.0
