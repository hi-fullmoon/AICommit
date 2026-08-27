# Distribution / 分发

AICommit 仅通过 npm 发布。

AICommit is distributed exclusively through npm.

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
npm install --package-lock-only @hifullmoon/aicommit@2.0.1
npm audit signatures
```

## Rollback / 回滚

npm 用户可以立即固定上一可用版本：

```bash
npm install --global @hifullmoon/aicommit@<last-good-version>
```

已发布的 npm version 不应覆盖或复用。维护者应 deprecate 有问题的版本、恢复正确的 dist-tag，并发布修复 patch。完整流程见 [`RELEASING.md`](../RELEASING.md)。
