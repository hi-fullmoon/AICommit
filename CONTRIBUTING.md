# Contributing to AICommit

Thanks for helping improve AICommit. Keep changes focused on safe, local commit workflows; the current product scope and sequencing live in [ROADMAP.md](ROADMAP.md).

## Development setup

You need Git and a supported Node.js release: 18, 20, 22, or 24.

```bash
git clone https://github.com/hi-fullmoon/AICommit.git
cd AICommit
npm ci
npm test
```

Use a personal `~/.aicommit.config.json` or environment variables for provider credentials. Never add real credentials, private diffs, or captured model requests to fixtures.

## Required checks

Run these before opening a pull request:

```bash
npm run ci
npm run test:package
npm audit --omit=dev
```

`npm run ci` runs ESLint, verifies Prettier formatting, enforces the anonymous local quality eval at 99% or better, executes the tests, writes a coverage report, and enforces at least 70% line coverage. Use `npm run format` to apply the repository style.

Tests that manipulate Git should create a temporary repository and clean it up. Provider integration tests must use a local stub server or fixtures; routine tests must not call paid or remote model APIs. Add regression coverage for security boundaries, Git restoration, non-interactive behavior, and cross-platform path handling when relevant.

## Pull requests and commits

- Keep a pull request to one coherent outcome and explain user-visible behavior, risks, and verification.
- Update README, CHANGELOG, and configuration examples when behavior or defaults change.
- Preserve existing staged/unstaged Git state in workflow changes and fail closed when safe recovery is uncertain.
- Use Conventional Commit subjects (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, or `chore:`).
- Do not combine drive-by refactors with a behavioral fix unless they are required for it.

For vulnerabilities or suspected credential exposure, do not open a public issue. Follow [SECURITY.md](SECURITY.md).

Maintainers perform versioning and publishing according to [RELEASING.md](RELEASING.md).
