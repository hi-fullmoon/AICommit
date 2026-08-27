# Distribution and verification / 分发与校验

AICommit publishes the same version through npm, an in-repository Homebrew tap, and a signed GitHub Release asset set. Runtime behavior is identical; Homebrew installs the npm tarball whose SHA-256 is pinned in the formula.

AICommit 通过 npm、仓库内 Homebrew tap 和带签名证明的 GitHub Release 资产发布同一版本。运行行为一致；Homebrew 安装的是 formula 中固定 SHA-256 的 npm tarball。

## npm

```bash
npm install --global @hifullmoon/aicommit
aicommit --version

# upgrade / 升级
npm install --global @hifullmoon/aicommit@latest

# pin or roll back / 固定或回滚
npm install --global @hifullmoon/aicommit@1.4.0
```

The release workflow uses npm Trusted Publishing on a GitHub-hosted runner with OIDC and `--provenance`; it has no long-lived npm token. To verify registry signatures and provenance with a current npm CLI:

发布工作流在 GitHub 托管 runner 上通过 OIDC 使用 npm Trusted Publishing，并显式启用 `--provenance`；流程不需要长期 npm token。使用较新的 npm CLI 校验 registry 签名与 provenance：

```bash
workdir=$(mktemp -d)
cd "$workdir"
npm install --package-lock-only @hifullmoon/aicommit@1.5.0
npm audit signatures
```

## Homebrew

The main repository is a tap, so no separate tap repository or install script is trusted:

主仓库本身就是 tap，无需信任额外 tap 仓库或安装脚本：

```bash
brew tap hi-fullmoon/aicommit https://github.com/hi-fullmoon/AICommit.git
brew install hi-fullmoon/aicommit/aicommit
aicommit --version

# upgrade / 升级
brew update
brew upgrade hi-fullmoon/aicommit/aicommit

# uninstall / 卸载
brew uninstall aicommit
brew untap hi-fullmoon/aicommit
```

The formula depends on Homebrew's Node package, installs with Homebrew's standard npm arguments, and tests `--version`, `--help`, credential-free config validation, and Fish completion. Pull requests run an actual `brew install` against a locally packed tarball; the release workflow repeats the smoke test against the published registry tarball.

Formula 依赖 Homebrew 的 Node 包，使用 Homebrew 标准 npm 参数安装，并测试 `--version`、`--help`、无凭据配置校验和 Fish completion。Pull request 会针对本地打包 tarball 执行真实 `brew install`；发布工作流还会针对 registry 已发布 tarball 再跑一次 smoke。

## Signed GitHub assets / GitHub 签名资产

Each release requires a GitHub-verified signed annotated tag. The release workflow builds and uploads:

每个 release 都要求 GitHub 已验证签名的 annotated tag。发布工作流生成并上传：

- `aicommit-X.Y.Z.tgz` — the exact tarball published to npm / 与 npm 完全相同的 tarball;
- `aicommit.rb` — the versioned Homebrew formula / 固定版本的 Homebrew formula;
- `aicommit-X.Y.Z.spdx.json` — SPDX SBOM;
- `SHA256SUMS` — hashes for the tarball, formula, and SBOM;
- `*.sigstore.json` — GitHub OIDC/Sigstore provenance and SBOM bundles.

Verify checksums and the cryptographically signed provenance against the exact release workflow:

校验 checksum，并把加密签名的 provenance 限定到本仓库的 release workflow：

```bash
version=v1.5.0
asset_dir=$(mktemp -d)
gh release download "$version" -R hi-fullmoon/AICommit -D "$asset_dir"
cd "$asset_dir"
shasum -a 256 -c SHA256SUMS
gh attestation verify "aicommit-${version#v}.tgz" \
  -R hi-fullmoon/AICommit \
  --signer-workflow hi-fullmoon/AICommit/.github/workflows/release.yml
```

An attestation proves origin and integrity, not that the code is vulnerability-free. Review the referenced commit/workflow and the security notes before installation.

Attestation 证明来源与完整性，不代表代码不存在漏洞。安装前仍应审查其关联 commit、workflow 与安全说明。

## Release and rollback / 发布与回滚

Maintainers execute the complete checklist in [`RELEASING.md`](../RELEASING.md). Public tags and attestations are immutable: never move a published tag or replace a published version.

维护者按 [`RELEASING.md`](../RELEASING.md) 执行完整清单。公开 tag 与 attestation 不可变：不得移动已发布 tag，也不得覆盖已发布版本。

For an affected npm version, deprecate it and publish a fixed patch. Users can immediately pin the preceding version. For Homebrew, revert the formula in a new commit or download the older release's attested `aicommit.rb`, uninstall the current formula, and install that local file:

若 npm 版本有问题，应 deprecate 并发布修复 patch；用户可立即固定上一版本。Homebrew 应通过新 commit 回退 formula，或下载旧 release 中已证明的 `aicommit.rb`，卸载当前版本后从本地文件安装：

```bash
gh release download v1.4.0 -R hi-fullmoon/AICommit -p aicommit.rb -D /tmp/aicommit-rollback
brew uninstall aicommit
brew install --formula /tmp/aicommit-rollback/aicommit.rb
```

Provider preset rollback is independent of the core package: use `aicommit preset rollback`, then `aicommit preset show` and `aicommit doctor`. See [`provider-presets.md`](provider-presets.md).

Provider preset 回滚不依赖核心包版本：执行 `aicommit preset rollback`，再运行 `aicommit preset show` 和 `aicommit doctor`。详见 [`provider-presets.md`](provider-presets.md)。
