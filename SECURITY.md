# Security Policy

## Supported versions

Security fixes are provided for the latest published `1.x` release. After a newer minor line is published, only its latest patch is supported unless a release note says otherwise.

## Reporting a vulnerability

Do not disclose vulnerabilities, leaked credentials, private diffs, or exploit details in a public issue.

Use GitHub's private vulnerability reporting from the repository's **Security** tab to open a private advisory for `hi-fullmoon/AICommit`. Include the affected version, operating system and Node.js version, reproduction steps, impact, and any suggested mitigation. If private reporting is unavailable, contact the maintainer through their GitHub profile without posting sensitive details publicly.

The project aims to acknowledge a complete report within three business days and provide an initial assessment within seven. Timelines for a fix depend on severity and the need for coordinated disclosure. Please allow a patch and advisory to be prepared before publishing details.

## Security model

AICommit is a local CLI that sends selected repository context directly to the configured model endpoint. It has no hosted AICommit service and does not upload telemetry. Its principal security boundaries are:

- the Git index and worktree must not be overwritten when concurrent changes make restoration uncertain;
- cloned project configuration must not redirect credentials, change provider controls, or increase user-owned data/cost limits;
- repository-owned prompts require a user-owned opt-in, while trusted convention paths can only come from user config;
- diff, path, history, preview, and convention content must remain marked as untrusted model data and never gain instruction authority;
- untrusted diff, file, model, and reasoning text must not execute terminal control sequences;
- common sensitive content should be detected and protected before the default model request;
- remote endpoints must use HTTPS, while plaintext HTTP is limited to loopback development services.
- npm releases must use Trusted Publishing provenance.

Sensitive-content detection is intentionally a defense in depth and cannot replace a dedicated secret scanner. Interactive users can explicitly choose to send original content after a warning. Review the selected endpoint and diff before doing so.

Provider credentials can come from an environment variable or the user config. Environment variables are preferred for CI and ephemeral use. The setup wizard can store a literal key when requested; the config is written atomically with mode `0600` on platforms that support POSIX permissions. Repository-level config is never a credential store.

For the detailed runtime and distribution trust boundaries, see the bilingual [privacy model](docs/privacy.md). For split recovery limits, see [README.md](README.md#privacy-and-data-flow).
