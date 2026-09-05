# Provider compatibility / Provider 兼容表

AICommit uses **Pi AI** (`@earendil-works/pi-ai`, pinned to 0.85.0) for model request construction, message conversion, SSE decoding, thinking events, and normalized results. Node.js **>=22.19.0** is required. See the [Pi AI documentation](https://github.com/earendil-works/pi/tree/main/packages/ai).

AICommit 使用 **Pi AI**（`@earendil-works/pi-ai`，固定为 0.85.0）构造模型请求、转换消息、解析 SSE，并读取统一的推理事件和结果。要求 Node.js **>=22.19.0**。

The runtime keeps the existing Provider/Model config format. `providers.js` selects Pi model metadata and applies configuration overrides; `model-client.js` calls Pi's `openai-completions` implementation. `provider-response.js` normalizes legacy response fields before Pi; its SSE framing uses the lightweight [eventsource-parser](https://github.com/rexxars/eventsource-parser) dependency. `api.js` retains commit prompts, policy validation, and recovery. Presets remain setup data, not executable adapters.

现有 Provider/Model 配置格式保持不变。`providers.js` 选择 Pi 模型元数据并应用配置覆盖；`model-client.js` 调用 Pi 的 `openai-completions` 实现；`provider-response.js` 在进入 Pi 前统一旧版响应字段，SSE 分帧使用轻量依赖 `eventsource-parser`；`api.js` 保留提交提示词、规则校验与恢复。预设仍是 setup 数据，不是可执行适配器。

| Provider / adapter        | Pi integration / Pi 接入                                                                                                                                 | Reasoning / 推理                                                                                                    | Token budget / 输出预算                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| OpenAI / `openai`         | Chat Completions; bundled model metadata / Chat Completions 与内置模型元数据                                                                             | Pi thinking-level map; unsupported known efforts rejected locally / 使用 Pi 强度映射，已知不支持的强度本地拒绝      | Reasoning: `max_completion_tokens`; otherwise `max_tokens` |
| OpenRouter / `openrouter` | Chat Completions; `X-Title: aicommit`                                                                                                                    | Pi `reasoning.effort` and catalog capability checks / Pi 参数映射与模型能力检查                                     | `max_tokens`                                               |
| DeepSeek / `deepseek`     | Chat Completions; bundled model metadata / 内置模型元数据                                                                                                | Pi `thinking.type` and effort mapping; enabled thinking omits temperature / Pi 映射推理参数，开启时省略 temperature | `max_tokens`                                               |
| MiniMax / `minimax`       | Chat Completions / 兼容接口                                                                                                                              | Small compatibility override for `reasoning_split` and thinking switches / 保留少量开关兼容逻辑                     | `max_tokens`                                               |
| Kimi Code / `custom`      | Existing OpenAI-compatible endpoint and `kimi-for-coding` preset / 保留现有兼容端点与预设                                                                | Server defaults; configurable body switches / 服务端默认值或自定义请求体                                            | `max_tokens`                                               |
| Ollama / `ollama`         | Native JSON bridge for `/api/chat` and `/api/generate`; compatible `/v1/chat/completions` uses Pi directly / 原生端点使用 JSON 桥接，兼容端点直接使用 Pi | Native `think` switch / 原生开关                                                                                    | Native: `options.num_predict`; compatible: `max_tokens`    |
| Custom / `custom`         | Arbitrary OpenAI-compatible model IDs and full endpoint URLs / 任意兼容模型 ID 与完整端点 URL                                                            | `enabledBody` / `disabledBody`; no inferred vendor fields / 不自动注入厂商开关                                      | `max_tokens`                                               |

## Configuration and model metadata / 配置与模型元数据

- `apiUrl` is still the **complete endpoint**, not a base URL. Proxy paths and query parameters are preserved. Requests use only the resolved AICommit credential. Pi environment-key discovery and OAuth are not invoked, and redirects are rejected.
- `modelId` need not exist in Pi's catalog. Known OpenAI, DeepSeek, and OpenRouter models use the bundled metadata; unknown IDs retain a compatible fallback. No online model discovery runs during setup or generation.
- `reasoning.mode: auto` preserves server defaults and explicit `extraBody`. `on` / `off` applies the selected mode after extras. Setup filters known supported effort levels. DeepSeek's legacy unsupported effort values are normalized by Pi: for the pinned V4 Flash catalog, `medium` becomes `high`, and `xhigh` becomes `max`.
- Pi requests SSE by default, even when the CLI does not display reasoning. Complete JSON responses are bridged into Pi events. Set `extraBody: { "stream": false }` for endpoints that reject streaming requests; streaming-only options are removed automatically.
- Native Ollama remains non-streaming. `/api/generate` receives `system` and `prompt`, while `/api/chat` receives `messages`; existing `options` are retained.

对应行为：

- `apiUrl` 仍填写**完整接口地址**，代理路径与查询参数会保留。鉴权只使用 AICommit 已解析的凭据，不调用 Pi 的环境变量凭据发现或 OAuth，也不跟随重定向。
- Pi 目录中没有的 `modelId` 也可以配置；已知 OpenAI、DeepSeek、OpenRouter 模型使用随依赖发布的元数据，未知模型走兼容路径。setup 与生成过程不在线拉取模型目录。
- `reasoning.mode: auto` 保留服务端默认值及显式 `extraBody`；`on` / `off` 在 extras 之后应用。setup 根据已知能力过滤强度。DeepSeek 的旧配置由 Pi 归一：当前 V4 Flash 目录中 `medium` 映射为 `high`，`xhigh` 映射为 `max`。
- Pi 默认请求 SSE，包括终端不展示推理的场景；完整 JSON 响应通过桥接交给 Pi。若服务拒绝流式请求，可配置 `extraBody: { "stream": false }`，流式专用参数会自动移除。
- Ollama 原生端点继续使用非流式响应，保留 `options`；`/api/generate` 使用 `system` / `prompt`，`/api/chat` 使用 `messages`。

## Result and retry contract / 结果与重试契约

Callers receive `content`, optional `reasoning`, normalized usage, finish reason, capabilities, attempts, and latency. Cached input tokens are included once in `inputTokens`; reasoning tokens are already part of output usage. `piMessage` exposes Pi's normalized assistant result. `raw` retains the actual complete JSON response, or a reconstructed Chat Completions result for SSE, preserving `callAPI` compatibility.

Retries remain owned by AICommit; Pi and the underlying SDK's automatic retries are disabled. Only 429, selected 5xx, and network failures **before an accepted response** can retry. Accepted-body interruptions, malformed responses, authentication, invalid parameters, and safety failures are never automatically replayed. Oversized `Retry-After` fails instead of retrying early.

SSE must contain a `finish_reason`. A clean EOF or `[DONE]` alone is rejected, and partial content is not returned as a successful generation. Token-limit aliases (`max_tokens`, `max_output_tokens`, `token_limit`) are normalized to `length` before Pi so recovery can run. Textual `reasoning_details`, including legacy shapes, are combined with ordinary reasoning deltas in arrival order. Duplicate representations within one event are emitted once; repeated text in later events is retained. Encrypted metadata remains opaque.

业务仍获得 `content`、可选 `reasoning`、归一 usage、结束原因、能力、尝试次数与耗时。缓存输入 token 只计入一次，推理 token 已包含在输出中。`piMessage` 提供 Pi 的统一 assistant 结果；完整 JSON 的 `raw` 保留原响应，SSE 的 `raw` 则重建兼容 Chat Completions 结构。

重试由 AICommit 负责，Pi 与底层 SDK 的自动重试均已关闭。只有 429、部分 5xx，以及**收到成功响应前**的网络失败可重试；已接受请求后的响应中断、格式错误、鉴权、参数及安全错误不会自动重放。超过上限的 `Retry-After` 会直接报错，不提前重试。

SSE 必须带 `finish_reason`。只有 EOF 或 `[DONE]` 时会拒绝结果，不将半截内容当作成功生成。输出上限别名（`max_tokens`、`max_output_tokens`、`token_limit`）在进入 Pi 前归一为 `length`，保留补全恢复流程。`reasoning_details`（含旧格式）中的文本与普通推理分片按到达顺序合并；同一事件中的重复表示只展示一次，后续事件中重复出现的文本则保留。加密元数据不会作为推理文本输出。

Use `aicommit doctor -p provider-name -m model-name` to verify a configured connection. This integration covers the existing six adapter types; installing Pi does **not** automatically expose every Pi provider, OAuth flow, or native Anthropic/Gemini/Responses endpoint. Those protocols require explicit routing and configuration support.

使用 `aicommit doctor -p provider-name -m model-name` 检查配置的连接。本次接入覆盖现有六种适配类型；安装 Pi **不会自动开放**其全部供应商、OAuth 或 Anthropic/Gemini/Responses 原生端点，这些协议需要显式扩展路由与配置。
