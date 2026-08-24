# Extensions / 扩展

AICommit extension API v1 exposes three deliberately small interfaces without loading third-party code into the CLI process. Extensions are user-installed single-file ESM modules and are never enabled by repository config.

AICommit 扩展 API v1 提供三个刻意保持精简的接口，第三方代码不会加载到 CLI 主进程。扩展由用户以单文件 ESM 模块安装，仓库配置无权启用扩展。

## Security model / 安全模型

- Every manifest must declare `"permissions": { "credentials": false }`; v1 rejects every other value.
- The extension process receives no AICommit API key, credential-helper result, `HOME`/`USERPROFILE` value, or inherited secret environment variable.
- On Node.js 20+, the child runs with Node's permission model and may read only the packaged runner and its own `.mjs` entry. File writes, child processes, workers, and unrelated reads are denied.
- Node.js 18 remains supported for core AICommit. Executable extensions fail clearly instead of running without isolation; use Node.js 20+ when extensions are enabled.
- A context provider receives bounded branch/file metadata, a validator receives the candidate and normalized policy, and an adapter receives non-secret provider settings plus the request/response value needed for its operation.
- Extensions can observe the data passed to their selected capability and may have network access, including access to services reachable from the machine. Node's permission model is defense in depth, not a substitute for reviewing third-party code. Keep the manifest and entry in a dedicated directory; imports and multi-file packages are intentionally outside v1.

- 每个清单必须声明 `"permissions": { "credentials": false }`，v1 会拒绝其他值。
- 扩展进程不会收到 AICommit API key、credential helper 结果、`HOME`/`USERPROFILE` 值或继承的秘密环境变量。
- 在 Node.js 20+ 上，子进程使用 Node 权限模型，只能读取随包发布的 runner 和自己的 `.mjs` 入口；文件写入、子进程、worker 与无关文件读取均被拒绝。
- Node.js 18 仍可运行 AICommit 核心；启用扩展时会明确失败，而不会在无隔离条件下降级执行。扩展场景请使用 Node.js 20+。
- context provider 只收到受限的分支/文件元数据，validator 收到候选消息和标准化 policy，adapter 只收到非敏感 provider 设置及当前操作需要的请求/响应值。
- 扩展能看到其接口明确收到的数据，也可能访问网络，包括本机可达的服务。Node 权限模型是纵深防御，不能替代第三方代码审查。请把清单和入口放进独立目录；v1 有意不支持 import 和多文件扩展包。

## Manifest and configuration / 清单与配置

Copy the executable example in [`docs/examples/extension`](examples/extension), then add its absolute manifest path to the user config:

复制 [`docs/examples/extension`](examples/extension) 中的可执行示例，再把清单绝对路径写入用户配置：

```json
{
  "extensions": {
    "manifests": ["/Users/me/.aicommit/extensions/team-rules/aicommit-extension.json"],
    "timeoutMs": 3000,
    "maxContextChars": 2000
  }
}
```

```json
{
  "kind": "aicommit-extension",
  "apiVersion": 1,
  "id": "team-rules",
  "version": "1.0.0",
  "entry": "./index.mjs",
  "capabilities": ["contextProvider", "messageValidator", "providerAdapter"],
  "permissions": { "credentials": false }
}
```

Validate the config shape without resolving credentials, then exercise the installed code through a dry run or doctor:

先在不解析凭据的情况下校验配置结构，再通过 dry run 或 doctor 实际加载扩展：

```bash
aicommit config validate
aicommit --dry-run
aicommit doctor
```

The published JSON Schema is [`schemas/aicommit-extension.schema.json`](../schemas/aicommit-extension.schema.json).

## Interface contract / 接口契约

All exports may be synchronous or asynchronous and must return JSON-serializable values.

所有导出函数均可同步或异步执行，返回值必须可 JSON 序列化。

```js
export function contextProvider({ repository, branch, files }) {
  return { text: 'bounded context text', warnings: [] };
}

export function messageValidator({ message, policy }) {
  return {
    issues: [{ severity: 'error', code: 'ticket', message: 'ticket id required' }],
  };
}

export function providerAdapter({ operation, config, request, response, reasoning }) {
  if (operation === 'buildRequest') return { model: config.modelId, messages: request.messages };
  if (operation === 'normalizeResponse') return { content: response.answer };
  if (operation === 'reasoningForFollowUp') return { ...reasoning, mode: 'off' };
}
```

To select the adapter, set `"providerType": "extension:team-rules"`. Core code still owns endpoint validation, timeout/retry, HTTP transport, and Bearer authorization. Adapter-produced credential-like request fields are rejected. Therefore a new body dialect can be added without modifying the core Git or interaction flow, while custom credential schemes remain intentionally unsupported by extension API v1.

选择 adapter 时设置 `"providerType": "extension:team-rules"`。endpoint 校验、超时/重试、HTTP 传输和 Bearer 鉴权仍由核心负责。adapter 返回的疑似凭据字段会被拒绝。因此，新的请求/响应 body 方言无需修改核心 Git 或交互流程即可加入，而自定义鉴权方案在扩展 API v1 中暂不支持。

Validator errors participate in the same one-shot correction flow as built-in policy errors and fail closed if the extension crashes or returns malformed output. Context-provider failures become warnings so optional context cannot block a commit.

Validator 错误与内置 policy 错误共用一次纠正流程；扩展崩溃或返回格式错误时会 fail closed。Context provider 失败只产生 warning，避免可选上下文阻断提交。
