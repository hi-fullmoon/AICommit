# Releasing AICommit

AICommit 只维护两条发布渠道：npm 与 Homebrew。GitHub Release 用来触发发布工作流，不额外上传构建产物。

## 发布目标

- npm：`@hifullmoon/aicommit`
- Homebrew tap：`hi-fullmoon/aicommit`
- 自动化入口：`.github/workflows/release.yml`
- 稳定版发布到 npm `latest`，GitHub pre-release 发布到 npm `next`

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

- 保护 `main`，要求 CI 的 `Quality / Node 24` 和三项 `Compatibility` 检查通过；
- 只允许维护者创建或发布 GitHub Release；
- npm scope `@hifullmoon` 的维护权限；
- Homebrew 与 Ruby 可在维护者的 macOS 环境中使用。

## 每次发布

1. 从干净且最新的 `main` 开始，按 SemVer 选择版本，并更新 `CHANGELOG.md`。

2. 更新 `package.json` 与 lockfile，但暂不创建 tag：

   ```bash
   npm version <patch|minor|major|X.Y.Z> --no-git-tag-version
   ```

3. 安装锁定依赖并运行 npm 发布检查：

   ```bash
   npm ci
   npm run release:npm:check
   npm view @hifullmoon/aicommit@X.Y.Z version
   ```

   最后一条命令在版本尚未占用时应返回 `E404`。检查会验证发布字段、lint、格式、测试、coverage、eval、安装后的 package smoke 和 `npm pack --dry-run`。

4. 用将要发布的精确 npm tarball 更新 Homebrew formula：

   ```bash
   release_dir=$(mktemp -d)
   pack_json=$(npm pack --json --pack-destination "$release_dir")
   pack_file=$(node -e "process.stdout.write(JSON.parse(process.argv[1])[0].filename)" "$pack_json")
   node scripts/release-assets.mjs \
     --tarball "$release_dir/$pack_file" \
     --output "$release_dir"
   cp "$release_dir/aicommit.rb" Formula/aicommit.rb
   ruby -c Formula/aicommit.rb
   ```

5. 在 macOS 上执行真实的 Homebrew 安装测试：

   ```bash
   AICOMMIT_HOMEBREW_SMOKE=1 HOMEBREW_NO_AUTO_UPDATE=1 npm run test:homebrew
   ```

6. 提交 version、lockfile、changelog 与 `Formula/aicommit.rb`，通过受保护的 `main` 流程合并。

7. 给合并后的 commit 创建 annotated tag 并推送：

   ```bash
   git tag -a vX.Y.Z -m "AICommit vX.Y.Z"
   git push origin vX.Y.Z
   ```

8. 从该 tag 创建并发布 GitHub Release。发布会触发 `release.yml`：重新校验 tag/version、生成并发布精确 tarball、通过 npm OIDC 自动附加 provenance，然后从公开 registry 执行 Homebrew 安装测试。

## 发布后验证

```bash
npm view @hifullmoon/aicommit@X.Y.Z version dist.integrity
npm view @hifullmoon/aicommit dist-tags
npm install --global @hifullmoon/aicommit@X.Y.Z
aicommit --version
aicommit --help

brew update
brew upgrade hi-fullmoon/aicommit/aicommit
```

在 npm package 页面确认 provenance 指向 `hi-fullmoon/AICommit/.github/workflows/release.yml`，并确认稳定版使用 `latest`、预发布版使用 `next`。

## 失败与回滚

npm 的已发布 version 不可覆盖。如果版本有问题，应发布修复 patch，并视影响执行：

```bash
npm deprecate @hifullmoon/aicommit@X.Y.Z "Use X.Y.Z+1: <reason>"
npm dist-tag add @hifullmoon/aicommit@<last-good-version> latest
```

不要移动已经公开的 tag。若只有 Homebrew formula 有问题，可在 `main` 上修复 formula 并重新执行安装测试；若 package 本身有问题，则 npm 与 Homebrew 一起发布新 patch。用户侧的固定和回滚命令见 [`docs/distribution.md`](docs/distribution.md)。
