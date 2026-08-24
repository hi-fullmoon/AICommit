# Provider presets / Provider 预设

Provider presets are versioned setup data, not request code. The stable adapters in `src/providers.js` own request/response behavior; `presets/provider-presets.json` only supplies a provider ID, display label, adapter ID, secure endpoint, default model, and optional bounded `extraBody` defaults. Adding another OpenAI-compatible service with the `custom` adapter does not change Git, interaction, or request orchestration code.

Provider preset 是带版本的 setup 数据，不是请求代码。`src/providers.js` 中的稳定 adapter 负责请求/响应行为；`presets/provider-presets.json` 只提供 provider ID、显示名称、adapter ID、安全 endpoint、默认模型以及可选且有界的 `extraBody` 默认值。使用 `custom` adapter 新增另一个 OpenAI-compatible 服务时，不需要修改 Git、交互或请求编排代码。

## Compatibility contract / 兼容契约

Every manifest declares:

每份清单都声明：

```json
{
  "kind": "aicommit-provider-presets",
  "schemaVersion": 1,
  "version": "1.0.0",
  "compatibility": {
    "coreMinimum": "1.3.0",
    "coreMaximumExclusive": "2.0.0",
    "adapterContract": 1
  }
}
```

- `version` versions the independently replaceable preset data.
- The core range is inclusive at `coreMinimum` and exclusive at `coreMaximumExclusive`.
- `adapterContract` declares the request-adapter interface expected by every entry.
- The runtime rejects unknown fields, duplicate/reserved IDs, unsupported adapters, remote HTTP, credentials, top-level `model`/`messages` overrides, oversized data, incompatible versions, and symlinked files.

- `version` 标识可独立替换的 preset 数据版本。
- core 范围包含 `coreMinimum`，不包含 `coreMaximumExclusive`。
- `adapterContract` 声明每个条目所依赖的请求 adapter 接口。
- 运行时拒绝未知字段、重复/保留 ID、不支持的 adapter、远程 HTTP、凭据、顶层 `model`/`messages` 覆盖、超限数据、不兼容版本和符号链接文件。

The published JSON Schema is [`schemas/aicommit-provider-presets.schema.json`](../schemas/aicommit-provider-presets.schema.json). Runtime validation is authoritative and adds semantic/security checks that JSON Schema alone cannot express.

发布的 JSON Schema 位于 [`schemas/aicommit-provider-presets.schema.json`](../schemas/aicommit-provider-presets.schema.json)。运行时校验是最终依据，并补充 JSON Schema 无法完整表达的语义与安全检查。

## Inspect and validate / 检视与校验

```bash
aicommit preset path
aicommit preset show --output=json
aicommit preset validate --file=provider-presets.json --output=json
```

The bundled manifest is used unless `~/.aicommit/provider-presets.json` exists. `show` reports the selected source, preset version, compatibility declaration, and provider count. These commands do not resolve provider credentials.

默认使用随包发布的清单；如果存在 `~/.aicommit/provider-presets.json`，则优先使用用户清单。`show` 会报告选中来源、preset 版本、兼容声明和 provider 数量。这些命令不会解析 provider 凭据。

## Independent update and rollback / 独立更新与回滚

Validate before installation, install atomically, then verify setup sees the expected source/version:

安装前先校验，原子安装后再确认 setup 使用了预期来源与版本：

```bash
aicommit preset validate --file=provider-presets.json
aicommit preset install --file=provider-presets.json
aicommit preset show --output=json
aicommit setup
```

On a later install, AICommit writes the current valid manifest to `~/.aicommit/provider-presets.previous.json` before replacing it. Roll back without changing the core package:

后续安装时，AICommit 会先把当前有效清单写入 `~/.aicommit/provider-presets.previous.json`，再执行替换。无需更改 core 包即可回滚：

```bash
aicommit preset rollback
aicommit preset validate
```

If the active user manifest is malformed or incompatible, installation preserves its raw bytes as `provider-presets.invalid-<timestamp>.json` before repairing the active file. / 如果活动用户清单损坏或不兼容，安装会先将原始内容保存为 `provider-presets.invalid-<timestamp>.json`，再修复活动文件。

There is deliberately no automatic network updater. Obtain manifests through a trusted channel, review the endpoint/model changes, and validate locally before installation.

系统刻意不提供自动联网更新器。请通过可信渠道取得清单，审阅 endpoint/模型变更，并在安装前进行本地校验。

## Add a compatible provider / 新增兼容 provider

Add one entry to a copied manifest, bump `version`, validate, and install it:

在清单副本中增加一个条目、提升 `version`，然后校验并安装：

```json
{
  "id": "acme",
  "label": "Acme Compatible",
  "adapter": "custom",
  "apiUrl": "https://api.acme.example/v1/chat/completions",
  "modelId": "acme-chat"
}
```

If the service speaks an existing adapter contract, no core flow changes are required. A genuinely new wire protocol belongs in a provider adapter extension, not in preset data.

如果服务符合现有 adapter 契约，就不需要修改 core 流程。真正的新 wire protocol 应实现 provider adapter 扩展，而不是塞入 preset 数据。
