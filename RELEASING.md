# Releasing AICommit

Only maintainers publish releases. A release is complete when the GitHub Release, npm package, provenance, and installation verification all refer to the same commit and version.

## Version policy

AICommit follows Semantic Versioning:

- **Patch** (`1.0.1`): backward-compatible fixes, security hardening, documentation, and internal maintenance.
- **Minor** (`1.1.0`): backward-compatible CLI options, provider support, or workflow capabilities.
- **Major** (`2.0.0`): incompatible CLI, configuration, output, default-scope, or Git-state behavior.

Pre-release versions use identifiers such as `1.1.0-rc.1` and publish under npm's `next` dist-tag. Stable releases publish under `latest`. A published name/version cannot be reused; correct a bad release with deprecation plus a new patch.

## One-time publishing setup

In the npm package settings for `aicommit`, configure a GitHub Actions Trusted Publisher with:

- repository: `hi-fullmoon/AICommit`;
- workflow filename: `release.yml`;
- allowed action: `npm publish`;
- optional environment: leave empty unless the workflow is updated to use the same protected environment.

The workflow uses a GitHub-hosted Ubuntu runner, Node.js 24, npm's OIDC flow, and `id-token: write`. No long-lived npm publish token is required. The public `repository` field in `package.json` must continue to match this GitHub repository. Trusted Publishing automatically attaches npm provenance; `publishConfig.provenance` keeps the package intent explicit.

Protect `main` and `v*` tags, require the CI jobs, and restrict who can publish GitHub Releases.

## Release checklist

1. Start from a clean, up-to-date `main` after all required CI jobs pass.
2. Choose the SemVer bump from the policy above. Move relevant `CHANGELOG.md` entries from **Unreleased** into a dated version section.
3. Update the package and lockfile without creating a tag yet:

   ```bash
   npm version <patch|minor|major|x.y.z> --no-git-tag-version
   ```

4. Run the exact local release gates:

   ```bash
   npm ci
   npm run ci
   npm run test:package
   npm audit --omit=dev
   npm pack --dry-run
   ```

5. Stage the version and changelog changes and create a Conventional Commit (AICommit can generate it with `aicommit --yes`). Merge that commit through the normal protected branch flow.
6. Create and push a signed tag for the merged commit:

   ```bash
   git tag -s vX.Y.Z -m "AICommit vX.Y.Z"
   git push origin vX.Y.Z
   ```

7. Draft a GitHub Release from that tag. Generate release notes, reconcile them with the changelog, call out security/privacy or migration impacts, and mark pre-releases correctly. Publish the GitHub Release only after reviewing the tag and notes.
8. Publishing the GitHub Release triggers `.github/workflows/release.yml`. It verifies `vX.Y.Z` matches `package.json`, reruns all quality and tarball checks, audits production dependencies, and publishes to npm through Trusted Publishing.
9. Verify the release:

   ```bash
   npm view aicommit@X.Y.Z version dist.integrity
   npm install --global aicommit@X.Y.Z
   aicommit --version
   aicommit --help
   ```

   Confirm npm shows provenance linked to the tagged GitHub workflow and that the correct `latest` or `next` dist-tag was applied.

## Failed releases and rollback

If validation fails before `npm publish`, fix the release commit, create a new version/tag if the original tag was already public, and publish corrected release notes. Do not move a public release tag.

If npm publication succeeds but the release is broken, immediately deprecate that exact version with a useful message, document the impact, and publish a fixed patch. Do not unpublish except when npm policy and a severe security incident require it. Git history, tags, release notes, and npm provenance must remain auditable.
