# Releasing AICommit

AICommit 仅通过 npm 发布。推送 `v*` tag 是 CI 与发布工作流的唯一自动化触发入口；GitHub Release 仅用于展示发布说明，不额外上传构建产物。

## 发布目标

- npm：`@hifullmoon/aicommit`
- 自动化入口：`.github/workflows/ci.yml` 与 `.github/workflows/release.yml`
- 稳定版 tag 发布到 npm `latest`，带 SemVer prerelease 后缀的 tag 发布到 npm `next`

## 一次性准备

当前 npm package 已存在，因此后续版本应全部通过 npm Trusted Publishing 发布，不再使用本地 `npm publish` 或长期 `NPM_TOKEN`。

在 npm package 的 **Settings → Trusted Publisher** 中配置：

- GitHub organization/user：`hi-fullmoon`
- Repository：`AICommit`
- Workflow filename：`release.yml`
- Environment：留空
- Allowed actions：`npm publish`

工作流使用 GitHub 托管的 Ubuntu runner、Node.js 24 和 `id-token: write`。npm Trusted Publishing 要求 npm CLI 11.5.1+、Node.js 22.14.0+；Node.js 24 runner 满足该要求。确认第一次 OIDC 发布成功后，在 npm 的 **Publishing access** 中选择 **Require two-factor authentication and disallow tokens**，并撤销不再使用的发布 token。

GitHub 侧还需要：

- 保护 `main`，要求通过代码审查后才能合并；
- 只允许维护者创建并推送 `v*` tag；
- npm scope `@hifullmoon` 的维护权限。

## 每次发布

1. 从最新的 `main` 开始，把本次用户可见变更写入 `CHANGELOG.md` 的 `[Unreleased]`。

2. 运行版本更新脚本。它接受 `patch`、`minor`、`major` 或完整 SemVer，同步更新 package、lockfile、changelog 与分发文档，但不会创建 commit 或 tag：

   ```bash
   npm run release:version -- <patch|minor|major|X.Y.Z>
   ```

3. 检查脚本生成的 diff，然后安装锁定依赖并运行 npm 发布检查：

   ```bash
   npm ci
   npm run release:npm:check
   npm view @hifullmoon/aicommit@X.Y.Z version
   ```

   最后一条命令在版本尚未占用时应返回 `E404`。检查会验证发布字段、lint、格式、测试、coverage、eval、安装后的 package smoke 和 `npm pack --dry-run`。

4. 提交版本脚本生成的文件，通过受保护的 `main` 流程合并。日常 branch push 与 pull request 不会自动触发 GitHub Actions，因此合并前必须完成上面的本地检查。

5. 给合并后的 commit 创建 annotated tag 并推送：

   ```bash
   git tag -a vX.Y.Z -m "AICommit vX.Y.Z"
   git push origin vX.Y.Z
   ```

6. 推送 tag 会同时触发 CI 与 `release.yml`。发布工作流会重新校验 tag/version、执行完整质量检查、生成并发布精确 tarball，并通过 npm OIDC 自动附加 provenance。需要发布说明时，可在流程成功后从该 tag 创建 GitHub Release；这个动作不会再次触发 CI/CD。

## 发布后验证

```bash
npm view @hifullmoon/aicommit@X.Y.Z version dist.integrity
npm view @hifullmoon/aicommit dist-tags
npm install --global @hifullmoon/aicommit@X.Y.Z
aicommit --version
aicommit --help
```

在 npm package 页面确认 provenance 指向 `hi-fullmoon/AICommit/.github/workflows/release.yml`，并确认稳定版使用 `latest`、预发布版使用 `next`。

## 失败与回滚

npm 的已发布 version 不可覆盖。如果版本有问题，应发布修复 patch，并视影响执行：

```bash
npm deprecate @hifullmoon/aicommit@X.Y.Z "Use X.Y.Z+1: <reason>"
npm dist-tag add @hifullmoon/aicommit@<last-good-version> latest
```

不要移动已经公开的 tag。若 package 本身有问题，应发布新的修复 patch。用户侧的固定和回滚命令见 [`docs/distribution.md`](docs/distribution.md)。
