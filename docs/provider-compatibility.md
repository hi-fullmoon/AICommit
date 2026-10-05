# Provider compatibility / Provider 兼容表

AICommit uses the official **OpenAI JavaScript SDK** (`openai`, pinned to 6.40.0) for Chat Completions and SSE decoding. Node.js **>=22.19.0** is required. See the [OpenAI SDK documentation](https://developers.openai.com/api/reference/typescript).

AICommit 使用官方 **OpenAI JavaScript SDK**（`openai`，固定为 6.40.0）发送 Chat Completions 请求并解码 SSE。要求 Node.js **>=22.19.0**。

The existing Provider/Model configuration format is preserved. `providers.js` applies model capability checks and vendor parameter mappings; `model-client.js` calls the SDK through the application's restricted transport. `provider-response.js` normalizes vendor fields using [eventsource-parser](https://github.com/rexxars/eventsource-parser) for SSE framing. `api.js` retains commit prompts, policy validation, and recovery.

现有 Provider/Model 配置格式保持不变。`providers.js` 负责模型能力校验与厂商参数映射；`model-client.js` 通过应用已有的受限请求层调用 SDK；`provider-response.js` 使用 `eventsource-parser` 解析 SSE 并统一厂商响应字段；`api.js` 保留提交提示词、规则校验与恢复。

| Provider / adapter        | Protocol / 协议                                                                                                                 | Reasoning / 推理                                                                                            | Token budget / 输出预算                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| OpenAI / `openai`         | Chat Completions                                                                                                                | Local effort mapping and capability checks / 本地强度映射与能力校验                                         | Reasoning: `max_completion_tokens`; otherwise `max_tokens` |
| OpenRouter / `openrouter` | Chat Completions; `X-Title: aicommit`                                                                                           | `reasoning.effort` and model capability checks / 强度映射与模型能力校验                                     | `max_tokens`                                               |
| DeepSeek / `deepseek`     | Chat Completions                                                                                                                | `thinking.type` and effort mapping; thinking omits temperature / 开关与强度映射，开启推理时省略 temperature | `max_tokens`                                               |
| MiniMax / `minimax`       | Chat Completions                                                                                                                | `reasoning_split` and thinking switches / 推理分离与开关                                                    | `max_tokens`                                               |
| Kimi Code / `custom`      | OpenAI-compatible endpoint and `kimi-for-coding` preset / 兼容端点与现有预设                                                    | Server defaults or configured body switches / 服务端默认值或配置的请求体开关                                | `max_tokens`                                               |
| Ollama / `ollama`         | Native JSON bridge for `/api/chat` and `/api/generate`; SDK for compatible endpoints / 原生端点使用 JSON 桥接，兼容端点使用 SDK | Native `think` switch / 原生开关                                                                            | Native: `options.num_predict`; compatible: `max_tokens`    |
| Custom / `custom`         | Full OpenAI-compatible endpoint URLs / 完整兼容端点 URL                                                                         | `enabledBody` / `disabledBody`                                                                              | `max_tokens`                                               |

## Configuration and model metadata / 配置与模型元数据

- `apiUrl` is the **complete endpoint**. Proxy paths and query parameters are preserved. Only the resolved AICommit credential is sent; SDK environment credential discovery is bypassed and redirects are rejected.
- `src/model-capabilities.json` preserves the reasoning capabilities, assistant message compatibility requirements, and context/output limits of 403 model IDs from the previous pinned Pi AI 0.85.0 catalog, sharing 176 capability profiles. It is a static metadata snapshot with [source and license information](model-capabilities-license.md), not a runtime Pi dependency. Unknown IDs retain the existing fallback. No online model discovery runs during setup or generation.
- `reasoning.mode: auto` preserves server defaults and explicit `extraBody`. Explicit `on` / `off` takes precedence over extras. Setup filters supported efforts. DeepSeek V4 Flash maps legacy `medium` to `high` and `xhigh` to `max`.
- SSE is requested by default, including when reasoning is not displayed. Complete JSON responses are normalized into SDK-readable events. `extraBody: { "stream": false }` disables streaming for incompatible endpoints and removes streaming-only options.
- Native Ollama remains non-streaming. `/api/generate` receives `system` and `prompt`; `/api/chat` receives `messages`. Existing `options` are retained.

对应行为：

- `apiUrl` 仍填写**完整接口地址**，代理路径与查询参数会保留。仅发送 AICommit 已解析的凭据，不使用 SDK 自动读取的环境变量凭据，也不跟随重定向。
- `src/model-capabilities.json` 保存原 Pi AI 0.85.0 目录中 403 个模型 ID 的推理能力、assistant 消息兼容要求、上下文与输出上限，共享 176 组能力配置。这是带来源及许可说明的静态元数据，运行时不再依赖 Pi。未知模型继续走兼容路径，setup 与生成过程不在线拉取目录。
- `auto` 保留服务端默认值及显式 `extraBody`；`on` / `off` 在 extras 之后应用。setup 根据能力过滤强度。DeepSeek V4 Flash 的旧配置 `medium` 映射为 `high`，`xhigh` 映射为 `max`。
- 默认请求 SSE；完整 JSON 响应会统一为 SDK 可读取的事件。服务拒绝流式请求时，可配置 `extraBody: { "stream": false }`，流式专用参数会自动移除。
- Ollama 原生端点保留非流式响应和 `options`；`/api/generate` 使用 `system` / `prompt`，`/api/chat` 使用 `messages`。

## Result and retry contract / 结果与重试契约

Callers receive `content`, optional `reasoning`, normalized usage, finish reason, capabilities, attempts, and latency. Cached input tokens are included once in `inputTokens`; reasoning tokens are already part of output usage. The legacy `piMessage` field retains assistant content blocks and token usage for compatibility; it is assembled locally and no longer supplies catalog price estimates or Pi replay metadata. `raw` retains complete JSON responses or reconstructed Chat Completions results for SSE.

Retries are owned by AICommit; SDK automatic retries are disabled. Only 429, selected 5xx, and network failures **before an accepted response** may retry. Accepted-body interruptions, malformed responses, authentication, invalid parameters, and safety failures are never automatically replayed. Oversized `Retry-After` fails instead of retrying early.

SSE must contain a `finish_reason`. A clean EOF or `[DONE]` alone is rejected. Token-limit aliases (`max_tokens`, `max_output_tokens`, `token_limit`) normalize to `length` so recovery can run. Textual `reasoning_details`, including legacy shapes, are combined with ordinary reasoning deltas in arrival order. Duplicate representations within one event are emitted once; repeated text in later events is retained. Encrypted metadata is not displayed.

业务仍获得 `content`、可选 `reasoning`、归一 usage、结束原因、能力、尝试次数与耗时。缓存输入 token 只计入一次，推理 token 已包含在输出中。旧字段 `piMessage` 保留 assistant 内容块和 token 用量兼容结构，由本地组装，不再提供目录价格估算或 Pi 重放元数据。`raw` 保留完整 JSON 原响应，或重建 SSE 的 Chat Completions 结果。

重试由 AICommit 负责，SDK 自动重试已关闭。仅 429、部分 5xx，以及**收到成功响应前**的网络失败可重试；已接受请求后的响应中断、格式错误、鉴权、参数及安全错误不会自动重放。超过上限的 `Retry-After` 会直接报错。

SSE 必须带 `finish_reason`，仅有 EOF 或 `[DONE]` 时会拒绝结果。输出上限别名归一为 `length`，保留补全恢复流程。推理文本按到达顺序合并；同一事件中的重复表示只展示一次，后续事件中重复出现的文本保留。加密元数据不会作为推理文本输出。

Use `aicommit doctor -p provider-name -m model-name` to verify a configured connection. The six existing adapter types are supported; native Anthropic/Gemini/Responses endpoints and OAuth require explicit routing and configuration support.

使用 `aicommit doctor -p provider-name -m model-name` 检查配置的连接。现有六种适配类型保持支持；Anthropic、Gemini、Responses 原生端点及 OAuth 需要额外的路由与配置支持。
