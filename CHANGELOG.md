# Changelog

This file lists notable user-facing changes. Internal refactors, test-only changes, release mechanics, and documentation-only edits are omitted.

## [Unreleased]

## [2.6.2] - 2026-09-14

### Fixed

- MiniMax streaming now accepts both cumulative snapshots and ordinary deltas without duplicating thinking or corrupting split plans. The live thinking panel also updates batch progress after the spinner stops.

## [2.6.1] - 2026-09-14

### Fixed

- Split mode now streams thinking during each large-change planning batch, with batch progress in the spinner; interactive review still shows only the final plan's reasoning.

## [2.6.0] - 2026-09-14

### Added

- Added `generate --scope=staged|all` and `apply` for a reviewable single-commit plan that rechecks the repository snapshot before committing.
- Added read-only `split status --output=json` so interrupted split transactions expose completed commits and the next recovery action.

### Changed

- Machine output schema 1.1 now reports commit IDs, plan paths, explicit change scope, and structured recovery errors. Consumers pinned to schema 1.0 should update their parsers.
- Staged snapshot checks use Git object IDs instead of regenerating full patches, and normal generation skips `git diff --stat` unless its diff is truncated.

### Fixed

- Split planning now displays the final model request's thinking for large changes and preserves it in interactive review; `auto` mode displays thinking when a provider emits it. JSON output remains free of model reasoning.

## [2.5.0] - 2026-09-10

### Added

- Added short-lived, content-addressed recovery caching for validated `deep` analysis chunks so identical snapshots resume after failures without repeating completed provider requests.

### Fixed

- Packed `deep` analysis fragments using the configured token estimate instead of character counts, avoiding unnecessary requests and premature aggregate-budget failures for ASCII-heavy diffs.
- Large split plans now preflight deep-analysis and downstream planning cost, batch local candidates hierarchically, and offer one complete conservative plan when the bounded budget cannot finish. Non-interactive committing requires the explicit `--allow-single-fallback` opt-in.

## [2.4.1] - 2026-09-10

### Fixed

- Recovered malformed large-change JSON responses once and accepted complete JSON arrays wrapped in provider reasoning, code fences, or explanatory prose while preserving strict ID coverage validation.

## [2.4.0] - 2026-09-09

### Changed

- Large changes now default to a local inventory, repeated-edit deduplication, and bounded representative excerpts, typically using one model request. Exhaustive model analysis is available through personal `largeChange.strategy: "deep"`.
- Large split plans must fit a complete local candidate inventory in one request by default; oversized plans stop before spending tokens. Coverage distinguishes sampled content from complete analysis.
- Temporary diff and untracked-file snapshots open descriptors only while reading or writing, preventing large file sets from exhausting the process descriptor limit.

- Moved model requests and streamed response decoding to Pi AI, using its bundled model metadata for reasoning capabilities while retaining existing Provider/Model configuration, custom endpoints, and native Ollama compatibility.
- Raised the minimum Node.js version to 22.19.0 for Pi AI; startup now reports unsupported runtimes before loading the model SDK.
- Streamed responses require an explicit provider finish reason. Token-limit aliases remain recoverable, mixed reasoning fields retain their text, and endpoints that only support complete JSON can use `extraBody.stream: false` without streaming-only parameters.

## [2.3.0] - 2026-09-05

### Added

- Added `aicommit update` for verified self-updates of regular npm-global installations, with exact-version installation, JSON output, and safeguards against updating source links or the wrong Node.js environment.

### Changed

- Moved the cancel action to the end of sensitive-data confirmation menus to keep send choices together.

## [2.2.3] - 2026-09-01

### Fixed

- Prevented accepted provider requests from being replayed after response-body interruptions, avoiding duplicate generations and potential duplicate billing.
- Honored provider retry timing safely by failing clearly when `Retry-After` exceeds the configured maximum delay instead of retrying too early.
- Stopped setup from replacing valid JSON configurations with unsupported schemas or invalid structures.

## [2.2.2] - 2026-08-31

### Added

- Added per-model reasoning mode and effort selection to interactive setup, with a balanced `medium` default and model-aware OpenAI option filtering.

## [2.2.1] - 2026-08-29

### Fixed

- Combined repository commit policies with commitlint constraints without allowing either source to relax the other, including correct `never` and complete-header length handling.
- Hardened split transactions against changes during snapshot capture, restricted plan exports to safe locations, and prevented existing output files from being overwritten.

### Security

- Redacted credential assignments with quoted JSON or YAML keys before diffs and untracked previews are sent to a model.

## [2.2.0] - 2026-08-28

### Added

- Expanded bundled model presets for OpenAI, DeepSeek, OpenRouter, and Ollama, including current GPT, Claude, Gemini, Qwen, GLM, Kimi, Grok, DeepSeek, and local open-model choices.

## [2.1.0] - 2026-08-27

### Changed

- Made quality and cross-platform compatibility checks blocking prerequisites of npm publishing in the single tag-triggered release workflow.
- Moved user configuration to `~/.aicommit/config.json` with legacy-path compatibility; project configuration remains `./.aicommit.config.json`.
- Simplified the primary help and documentation around the everyday setup, doctor, commit, and file-level split workflows; automation and team-policy commands are now presented as advanced tools.

### Removed

- Removed local run metrics and the `stats` command; aicommit no longer creates `~/.aicommit/metrics.jsonl`.
- Removed executable extensions and extension-backed provider adapters to reduce the trusted-code and compatibility surface.
- Removed user-installable provider preset lifecycle commands; setup now uses the validated defaults shipped with each aicommit release.
- Removed the experimental `--split-hunks` planning entry point. Existing versioned hunk plan artifacts remain readable for recovery and compatibility.

## [2.0.1] - 2026-08-27

### Fixed

- Made tag-only workflow validation portable across LF and CRLF checkouts.

## [2.0.0] - 2026-08-27

### Added

- Added named model profiles per provider, with model selection available in setup and through `--model`.

### Changed

- **Breaking:** user configuration now requires `schemaVersion: 1`, an explicit `defaultProvider`, and provider-level `defaultModel`/`models` maps; legacy flat and provider-level `modelId` configurations must be migrated with `aicommit setup`.
- Provider preset manifests now use schema version 2 with named model maps and explicit default models.

### Removed

- Removed the Homebrew distribution channel; install and upgrade AICommit through npm.

## [1.5.1] - 2026-08-27

### Fixed

- Normalized Windows 8.3 path aliases before validating split plan destinations, so repository-local output is rejected before any provider request.

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

[Unreleased]: https://github.com/hi-fullmoon/AICommit/compare/v2.6.2...HEAD
[2.6.2]: https://github.com/hi-fullmoon/AICommit/releases/tag/v2.6.2
[2.6.1]: https://github.com/hi-fullmoon/AICommit/releases/tag/v2.6.1
[2.6.0]: https://github.com/hi-fullmoon/AICommit/releases/tag/v2.6.0
[2.5.0]: https://github.com/hi-fullmoon/AICommit/releases/tag/v2.5.0
[2.4.1]: https://github.com/hi-fullmoon/AICommit/releases/tag/v2.4.1
[2.4.0]: https://github.com/hi-fullmoon/AICommit/releases/tag/v2.4.0
[2.3.0]: https://github.com/hi-fullmoon/AICommit/releases/tag/v2.3.0
[2.2.3]: https://github.com/hi-fullmoon/AICommit/releases/tag/v2.2.3
[2.2.2]: https://github.com/hi-fullmoon/AICommit/releases/tag/v2.2.2
[2.2.1]: https://github.com/hi-fullmoon/AICommit/releases/tag/v2.2.1
[2.2.0]: https://github.com/hi-fullmoon/AICommit/releases/tag/v2.2.0
[2.1.0]: https://github.com/hi-fullmoon/AICommit/releases/tag/v2.1.0
[2.0.1]: https://github.com/hi-fullmoon/AICommit/releases/tag/v2.0.1
[2.0.0]: https://github.com/hi-fullmoon/AICommit/releases/tag/v2.0.0
[1.5.1]: https://github.com/hi-fullmoon/AICommit/releases/tag/v1.5.1
[1.5.0]: https://github.com/hi-fullmoon/AICommit/releases/tag/v1.5.0
