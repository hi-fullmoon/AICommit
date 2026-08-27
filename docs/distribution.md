# Distribution / 分发

AICommit 通过 npm 与 Homebrew 发布。Homebrew formula 安装同一个 npm tarball，并用 SHA-256 固定其内容。

AICommit is distributed through npm and Homebrew. The Homebrew formula installs the same npm tarball and pins it by SHA-256.

## npm

```bash
# install / 安装
npm install --global @hifullmoon/aicommit

# upgrade / 升级
npm install --global @hifullmoon/aicommit@latest

# pin or roll back / 固定或回滚
npm install --global @hifullmoon/aicommit@1.4.0

aicommit --version
```

发布工作流使用 npm Trusted Publishing，不保存长期 `NPM_TOKEN`。来自公开 GitHub 仓库的 OIDC 发布会自动携带 npm provenance。可使用当前 npm CLI 检查 registry signature 与 provenance：

The release workflow uses npm Trusted Publishing without a long-lived `NPM_TOKEN`. OIDC publishing from the public GitHub repository automatically includes npm provenance. Verify registry signatures and provenance with a current npm CLI:

```bash
workdir=$(mktemp -d)
cd "$workdir"
npm install --package-lock-only @hifullmoon/aicommit@1.5.1
npm audit signatures
```

## Homebrew

```bash
# install / 安装
brew tap hi-fullmoon/aicommit https://github.com/hi-fullmoon/AICommit.git
brew install hi-fullmoon/aicommit/aicommit

# upgrade / 升级
brew update
brew upgrade hi-fullmoon/aicommit/aicommit

# uninstall / 卸载
brew uninstall aicommit
brew untap hi-fullmoon/aicommit
```

Formula 依赖 Homebrew 的 Node package，使用 Homebrew 标准 npm 安装参数，并测试 `--version`、`--help` 与无凭据配置校验。每次 npm 发布完成后，release workflow 会从公开 registry 再执行一次真实安装测试。

The formula depends on Homebrew's Node package, uses Homebrew's standard npm installation arguments, and tests `--version`, `--help`, and credential-free configuration validation. After every npm publish, the release workflow performs a real install from the public registry.

## Integrity / 完整性

`Formula/aicommit.rb` 中的 `sha256` 必须与对应 npm tarball 一致。维护者发布前通过 `scripts/release-assets.mjs` 生成 formula，工作流发布前会再次比较生成结果与已提交文件。

The `sha256` in `Formula/aicommit.rb` must match the corresponding npm tarball. Maintainers generate the formula with `scripts/release-assets.mjs`, and the release workflow compares it again before publishing.

## Rollback / 回滚

npm 用户可以立即固定上一可用版本：

```bash
npm install --global @hifullmoon/aicommit@<last-good-version>
```

Homebrew 用户可从旧 tag 取出 formula 并本地安装：

```bash
git clone https://github.com/hi-fullmoon/AICommit.git /tmp/aicommit-rollback
git -C /tmp/aicommit-rollback show v1.4.0:Formula/aicommit.rb > /tmp/aicommit.rb
brew uninstall aicommit
brew install --formula /tmp/aicommit.rb
```

已发布的 npm version 不应覆盖或复用。维护者应 deprecate 有问题的版本、恢复正确的 dist-tag，并发布修复 patch。完整流程见 [`RELEASING.md`](../RELEASING.md)。
