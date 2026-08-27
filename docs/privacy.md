# Privacy model / 隐私模型

AICommit is a local CLI, not a hosted relay. Repository data travels directly from the local process to the provider endpoint selected in the user-owned config. There is no telemetry upload implementation.

AICommit 是本地 CLI，不是托管中转服务。仓库数据从本地进程直接发送到用户配置选定的 provider endpoint；项目没有遥测上传实现。

## Trust boundaries / 信任边界

| Boundary / 边界                                    | Data visible there / 可见数据                                                                                                        | Default control / 默认控制                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Main CLI process / CLI 主进程                      | Selected Git metadata/diff, effective config, resolved provider credential / 选定 Git 元数据与 diff、有效配置、provider 凭据         | User config owns connection fields; project config is filtered / 连接字段归用户配置，项目配置受过滤                                            |
| Git subprocess / Git 子进程                        | Requested status, diff, index/tree operations / 请求的 status、diff、index/tree 操作                                                 | Explicit arguments, temporary indexes, fingerprints and recovery checkpoints / 显式参数、临时 index、指纹与恢复 checkpoint                     |
| Provider endpoint / Provider 端点                  | Prompt, protected selected diff/context, model options, Bearer credential / prompt、保护后的选定 diff/context、模型选项、Bearer 凭据 | Remote HTTPS except loopback; preview/protection before send; bounded context / 远端仅 HTTPS；发送前预览/保护；上下文有预算                    |
| Extension child / 扩展子进程                       | Only the input for its declared interface / 仅声明接口所需输入                                                                       | Sanitized environment, no resolved credential, Node permission model, timeout/output bounds / 清理环境、不传凭据、Node 权限模型、超时/输出限制 |
| Local metrics file / 本地指标文件                  | Duration, token totals, bounded result, edited/rewrite flags / 延迟、token 总量、结果类别、编辑/重写标记                             | Local-only, owner permissions, retention cap, disable/clear controls / 仅本地、owner 权限、保留上限、可关闭/清除                               |
| GitHub/npm during installation / 安装期 GitHub/npm | Package download metadata / package 下载元数据                                                                                       | Version tag and npm Trusted Publishing provenance / 版本 tag 与 npm Trusted Publishing provenance                                              |

## Provider request contents / Provider 请求内容

A normal generation can send the system policy, requested language, selected changed paths/statuses, staged diff, bounded repository context, and provider/model controls. Split planning can additionally send tracked diffs and bounded previews of untracked regular files. Regeneration sends the previous message by default instead of the diff. Connection check sends only a fixed `OK` prompt.

普通生成可能发送 system policy、语言、选定文件路径/状态、staged diff、受限仓库上下文及 provider/model 控制。Split planning 还可能发送 tracked diff 与未跟踪普通文件的受限预览。默认重写只发送上一条消息而不重发 diff。连通性检查只发送固定 `OK` prompt。

AICommit does not intentionally send unrelated files, historical commit bodies, local metric records, environment variables, its config file, Git credential-helper output, split checkpoint content, or model reasoning in machine output.

AICommit 不会主动发送无关文件、历史 commit body、本地指标、环境变量、配置文件、Git credential-helper 输出、split checkpoint 内容，也不会在机器输出中包含模型 reasoning。

## Data minimization and sensitive content / 数据最小化与敏感内容

- Repository context and every diff category have explicit character/count ceilings and can be disabled.
- Lock files and configured generated artifacts are stubbed; oversized diffs/files are condensed.
- Common sensitive filenames, private keys, cloud access-key IDs, and credential-like assignments are omitted or redacted in the protected request.
- Repository text is encoded as untrusted JSON data under an authoritative system policy.
- Interactive users can explicitly send the original content after a warning. This is a deliberate override and should be rare.

- 仓库上下文与每类 diff 都有字符/数量上限，并可关闭。
- 锁文件与配置的生成物会被替换为占位；过大 diff/文件会被压缩。
- 常见敏感文件名、私钥、云访问 key ID 与疑似凭据赋值会在默认保护请求中省略或脱敏。
- 仓库文本作为不可信 JSON 数据编码，由权威 system policy 约束。
- 交互用户可在警告后明确发送原文；这是应谨慎使用的主动覆盖。

Detection, redaction, prompt boundaries, and the extension permission model are defense in depth, not proofs that arbitrary data or malicious code is safe. Extensions may access the network and can observe the candidate/context/response explicitly passed to their capability. Install only reviewed extensions and verify custom endpoints before sending private code.

检测、脱敏、prompt 边界与扩展权限模型都是纵深防御，不能证明任意数据或恶意代码绝对安全。扩展可能访问网络，并能看到其 capability 明确收到的候选消息、上下文或响应。只安装已审查扩展，并在向自定义 endpoint 发送私有代码前核实其可信度。

## Credentials and retention / 凭据与保留

Credential resolution order is environment variable → opted-in Git credential helper → literal user config → keyless loopback. Project config and team policy cannot select a credential source. The provider credential is used only by the core transport; extension API v1 always declares `credentials: false` and never receives the resolved value.

凭据解析顺序为：环境变量 → 用户启用的 Git credential helper → 用户配置明文 → 无 key 的 loopback。项目配置和团队 policy 无权选择凭据来源。Provider 凭据只由核心传输层使用；扩展 API v1 固定声明 `credentials: false`，不会收到解析后的值。

Providers control their own server-side retention and training policies; AICommit cannot enforce them. Consult the selected provider's current terms. Locally, Git commits retain the accepted message, split checkpoints persist only code-free plan metadata until completion/recovery, and metrics retain at most the configured number of minimal records.

Provider 自行决定服务端保留与训练策略，AICommit 无法强制控制；请查阅所选 provider 的现行条款。本地 Git commit 会保留接受的消息；split checkpoint 在完成/恢复前只保存不含代码的计划元数据；metrics 最多保留配置数量的最小记录。

Use `aicommit config show`, `aicommit stats`, and `aicommit preset show` to inspect effective local state without revealing credentials. Use `aicommit stats clear` to permanently remove local metric history.

使用 `aicommit config show`、`aicommit stats` 和 `aicommit preset show` 可在不显示凭据的情况下检查本地状态。使用 `aicommit stats clear` 可永久删除本地指标历史。
