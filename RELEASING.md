# Releasing AICommit

Only maintainers publish releases. A release is complete when the GitHub Release, signed annotated tag, attested npm tarball/SBOM, npm provenance, Homebrew formula, and both installation verifications all refer to the same commit and version.

仅维护者可以发布。只有 GitHub Release、已签名 annotated tag、带证明的 npm tarball/SBOM、npm provenance、Homebrew formula 与两条安装验证全部指向同一 commit/version，发布才算完成。

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

Protect `main` and `v*` tags, require the CI jobs (including Homebrew smoke), and restrict who can publish GitHub Releases. Maintainer signing keys must be added to the corresponding GitHub account so the Git Data API reports the tag signature as `verified: true` and `reason: valid`.

## Release checklist

1. Start from a clean, up-to-date `main` after all required CI jobs pass.
2. Choose the SemVer bump from the policy above. Move relevant `CHANGELOG.md` entries from **Unreleased** into a dated version section.
3. Update the package and lockfile without creating a tag yet:

   ```bash
   npm version <patch|minor|major|x.y.z> --no-git-tag-version
   ```

4. Build the exact tarball and refresh the committed Homebrew formula. `Formula/` is excluded from the npm package, so the formula checksum is not circular:

   ```bash
   release_dir=$(mktemp -d)
   npm pack --pack-destination "$release_dir"
   npm sbom --sbom-format=spdx > "$release_dir/aicommit-X.Y.Z.spdx.json"
   node scripts/release-assets.mjs \
     --tarball "$release_dir/aicommit-X.Y.Z.tgz" \
     --sbom "$release_dir/aicommit-X.Y.Z.spdx.json" \
     --output "$release_dir"
   cp "$release_dir/aicommit.rb" Formula/aicommit.rb
   ruby -c Formula/aicommit.rb
   ```

5. Run the exact local release gates:

   ```bash
   npm ci
   npm run ci
   npm run test:package
   npm audit --omit=dev
   npm pack --dry-run
   ```

   On macOS, also execute the real formula install smoke (it uses a uniquely named temporary formula and removes it afterward):

   ```bash
   AICOMMIT_HOMEBREW_SMOKE=1 HOMEBREW_NO_AUTO_UPDATE=1 npm run test:homebrew
   ```

6. Stage the version, changelog, preset compatibility baseline, and `Formula/aicommit.rb`; create a Conventional Commit with `aicommit --yes`. Merge it through the protected branch flow.
7. Create and locally verify a signed annotated tag for the merged commit, then push it:

   ```bash
   git tag -s vX.Y.Z -m "AICommit vX.Y.Z"
   git verify-tag vX.Y.Z
   git push origin vX.Y.Z
   ```

8. Draft a GitHub Release from that tag. Generate release notes, reconcile them with the changelog, call out security/privacy or migration impacts, and mark pre-releases correctly. Confirm GitHub shows the tag signature as **Verified** before publishing.
9. Publishing the GitHub Release triggers `.github/workflows/release.yml`. It rejects lightweight/unverified tags, verifies tag/version/commit identity, reruns quality and tarball checks, builds the exact tarball plus SPDX SBOM/formula/checksums, creates GitHub OIDC/Sigstore provenance and SBOM attestations, uploads every asset, publishes that same tarball to npm through Trusted Publishing with provenance, and runs a post-publish Homebrew install test.
10. Verify the release:

```bash
npm view aicommit@X.Y.Z version dist.integrity
npm install --global aicommit@X.Y.Z
aicommit --version
aicommit --help
brew update
brew upgrade hi-fullmoon/aicommit/aicommit
```

Confirm npm shows provenance linked to the tagged GitHub workflow and that the correct `latest` or `next` dist-tag was applied. Then download and verify the GitHub artifact:

```bash
gh release download vX.Y.Z -R hi-fullmoon/AICommit -D /tmp/aicommit-release
cd /tmp/aicommit-release
shasum -a 256 -c SHA256SUMS
gh attestation verify aicommit-X.Y.Z.tgz \
  -R hi-fullmoon/AICommit \
  --signer-workflow hi-fullmoon/AICommit/.github/workflows/release.yml
```

## Failed releases and rollback

If validation fails before `npm publish`, fix the release commit, create a new version/tag if the original tag was already public, and publish corrected release notes. Do not move a public release tag or overwrite attested assets.

If npm publication succeeds but the release is broken, immediately deprecate that exact version with a useful message, document the impact, restore the previous Homebrew formula in a new commit, and publish a fixed patch. Do not unpublish except when npm policy and a severe security incident require it. Git history, tags, release notes, attestations, formulas, and npm provenance must remain auditable.

Users can pin npm with `npm install --global aicommit@X.Y.Z` or install the attested `aicommit.rb` downloaded from an older GitHub Release. Provider preset rollback remains independent: `aicommit preset rollback`. The bilingual executable procedures are in [`docs/distribution.md`](docs/distribution.md).
