# Team policy / 团队策略

AICommit supports a repository-owned `.aicommit.policy.json` for deterministic commit-message rules. The document is safe to commit because its strict schema accepts only a language and a complete `commitPolicy`; credentials, endpoints, provider settings, prompts, and unknown properties are rejected.

AICommit 支持由仓库维护的 `.aicommit.policy.json`，用于确定性地约束提交信息。该文件采用严格 schema，只接受语言与完整的 `commitPolicy`；凭据、endpoint、provider 设置、prompt 和未知字段都会被拒绝，因此可以安全提交到仓库。

## Adopt the template / 引入模板

Generate the template from the same installed CLI that will validate it, review every rule, then commit it:

使用将负责校验的同一份 CLI 生成模板，审阅所有规则后提交：

```bash
aicommit policy template > .aicommit.policy.json
aicommit config validate
git add .aicommit.policy.json
```

The template fully declares every policy field. AICommit loads it after user, project, and provider-scoped config, so personal settings cannot silently change team results. `policy check` always applies recognized commitlint constraints from the same repository with fixed local-only detection limits; generation applies the same constraints when its commitlint context source is enabled.

模板完整声明全部策略字段。AICommit 在用户、项目和 provider 级配置之后加载它，因此个人设置不会悄悄改变团队校验结果。`policy check` 始终以固定的本地只读检测上限应用同仓库中识别到的 commitlint 约束；生成流程会在启用 commitlint 上下文源时应用相同约束。

## Use the same check locally and in CI / 本地与 CI 使用同一校验

Install the sample [`commit-msg`](examples/commit-msg) hook, or call the equivalent command from Husky/lefthook:

安装示例 [`commit-msg`](examples/commit-msg) hook，或在 Husky/lefthook 中调用同一命令：

```bash
install -m 0755 docs/examples/commit-msg .git/hooks/commit-msg
```

For pull requests, use the executable [GitHub Actions example](examples/aicommit-policy.yml), which validates the exact base-to-head range:

对于 pull request，可使用可执行的 [GitHub Actions 示例](examples/aicommit-policy.yml)，校验准确的 base-to-head 范围：

```bash
aicommit policy check --range=origin/main..HEAD
```

Both paths call the same validator. `--output=json` returns the effective policy, a SHA-256 policy fingerprint, result IDs, issue codes, and severity without returning commit-message contents or diagnostic text derived from them. A policy violation exits with code `2`. `policy template` and `policy check` never resolve environment credentials or invoke Git credential helpers.

两条路径调用同一个校验器。`--output=json` 返回有效策略、SHA-256 策略指纹、结果 ID、问题代码和严重级别，但不回传提交信息正文或由其派生的诊断文本。策略违规以退出码 `2` 结束。`policy template` 和 `policy check` 都不会解析环境凭据，也不会调用 Git credential helper。

## Migration / 迁移

1. Move Conventional Commit types, scope rules, subject length, body rules, breaking-change handling, and language out of free-form `prompt` text and into `.aicommit.policy.json`.
2. Declare every field instead of relying on personal defaults. Start with optional scopes and narrow the values only after current history has been sampled.
3. Keep provider credentials in `~/.aicommit/config.json` or environment variables; never copy them into the repository policy.
4. If commitlint already defines `type-enum`, `scope-enum`, `subject-max-length`, or `header-max-length`, keep that file committed. AICommit reads recognized scalar values as data and never executes the config.
5. Run the local hook and CI example on the same known-good and known-bad messages. Their `policyFingerprint` and issue codes must match before making the gate required.

中文迁移步骤：

1. 将 Conventional Commit 类型、scope 规则、标题长度、正文规则、破坏性变更和语言要求从自由文本 `prompt` 迁移到 `.aicommit.policy.json`。
2. 明确声明所有字段，不依赖个人默认值。可先保留可选 scope，再根据现有提交历史逐步收紧取值。
3. provider 凭据继续放在 `~/.aicommit/config.json` 或环境变量中，绝不要复制到仓库策略。
4. 如果 commitlint 已定义 `type-enum`、`scope-enum`、`subject-max-length` 或 `header-max-length`，继续提交该配置。AICommit 只按数据读取识别出的标量规则，不执行配置文件。
5. 用同一组已知正确/错误消息分别运行本地 hook 与 CI 示例；在强制启用门禁前，确认两者的 `policyFingerprint` 和问题代码一致。

## Examples / 示例

Require an `api` or `cli` scope and an English subject:

要求 `api` 或 `cli` scope，并使用英文标题：

```json
{
  "kind": "aicommit-team-policy",
  "version": 1,
  "language": "en",
  "commitPolicy": {
    "version": 1,
    "types": ["feat", "fix", "docs", "refactor", "test", "chore"],
    "scope": { "mode": "required", "values": ["api", "cli"] },
    "subject": { "maxLength": 72 },
    "body": { "mode": "optional", "maxLines": 8 },
    "breakingChange": "allow",
    "language": "inherit"
  }
}
```

`feat(api): add retry budget` passes. `feat: add retry budget` fails with `scope_required`; `feat(api): 添加重试预算` fails with `language`.

`feat(api): add retry budget` 会通过。`feat: add retry budget` 以 `scope_required` 失败；`feat(api): 添加重试预算` 以 `language` 失败。
