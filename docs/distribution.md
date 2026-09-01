# Distribution / 分发

AICommit 仅通过 npm 发布。

AICommit is distributed exclusively through npm.

## npm

```bash
# install / 安装
npm install --global @hifullmoon/aicommit

# upgrade / 升级
aicommit update

# manual upgrade / 手动升级
npm install --global @hifullmoon/aicommit@latest

# pin or roll back / 固定或回滚
npm install --global @hifullmoon/aicommit@1.4.0

aicommit --version
```

`aicommit update` 使用当前 `PATH` 中的 npm 和它配置的 registry，解析 `latest` dist-tag 后安装精确版本，并校验安装后的 package manifest。它仅更新当前 npm 全局根目录中的普通安装；源码检出、`npm link`、`npx` 缓存和其他 Node.js/npm 环境中的安装会被拒绝，以免更新错误的可执行文件。此时请切换到安装 AICommit 的 Node.js 环境，或使用上面的手动命令。

`aicommit update` uses the npm on the current `PATH` and its configured registry. It resolves the `latest` dist-tag, installs that exact version, and verifies the installed package manifest. It only updates a regular installation in the active npm global root; source checkouts, `npm link`, `npx` caches, and installations owned by another Node.js/npm environment are rejected to avoid updating the wrong executable. Switch to the Node.js environment that installed AICommit, or use the manual command above.

发布工作流使用 npm Trusted Publishing，不保存长期 `NPM_TOKEN`。来自公开 GitHub 仓库的 OIDC 发布会自动携带 npm provenance。可使用当前 npm CLI 检查 registry signature 与 provenance：

The release workflow uses npm Trusted Publishing without a long-lived `NPM_TOKEN`. OIDC publishing from the public GitHub repository automatically includes npm provenance. Verify registry signatures and provenance with a current npm CLI:

```bash
workdir=$(mktemp -d)
cd "$workdir"
npm install --package-lock-only @hifullmoon/aicommit@2.2.3
npm audit signatures
```

## Rollback / 回滚

npm 用户可以立即固定上一可用版本：

```bash
npm install --global @hifullmoon/aicommit@<last-good-version>
```

已发布的 npm version 不应覆盖或复用。维护者应 deprecate 有问题的版本、恢复正确的 dist-tag，并发布修复 patch。完整流程见 [`RELEASING.md`](../RELEASING.md)。
