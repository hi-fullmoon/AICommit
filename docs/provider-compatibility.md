# Provider compatibility / Provider 兼容表

Provider presets choose setup defaults; adapters own request/response dialects; the core owns Git state, user interaction, HTTPS enforcement, retry, timeout, authorization, and machine output. Adding a compatible preset or an extension adapter does not modify the core Git/interaction flow.

Provider preset 只选择 setup 默认值；adapter 负责请求/响应方言；核心负责 Git 状态、用户交互、HTTPS、重试、超时、鉴权与机器输出。新增兼容 preset 或 extension adapter 无需修改核心 Git/交互流程。

| Provider / adapter           | Endpoint and auth / 端点与鉴权                                                 | Streaming / 流式                                                                | Reasoning / 推理                                                                        | Token and usage mapping / token 与 usage                                           | Notes / 说明                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| OpenAI / `openai`            | Official HTTPS Chat Completions; Bearer key / 官方 HTTPS；Bearer key           | SSE                                                                             | Native for recognized `o*`/`gpt-5*`; model-dependent otherwise / 已识别推理模型原生支持 | `max_completion_tokens` for reasoning models, otherwise `max_tokens`; OpenAI usage | Unsupported effort is rejected locally for known model generations / 已知模型不支持的 effort 会本地拒绝  |
| OpenRouter / `openrouter`    | OpenRouter HTTPS; Bearer key; `X-Title: aicommit`                              | SSE                                                                             | `reasoning.effort`                                                                      | `max_tokens`; OpenAI-style usage                                                   | Model IDs commonly include vendor prefix / model 通常含厂商前缀                                          |
| DeepSeek / `deepseek`        | DeepSeek HTTPS; Bearer key                                                     | SSE                                                                             | `thinking.type` plus normalized effort / thinking 与归一 effort                         | `max_tokens`; compatible usage                                                     | `medium`/`xhigh` map to supported high behavior where required / 必要时映射为 high                       |
| MiniMax / `minimax`          | MiniMax HTTPS; Bearer key                                                      | SSE                                                                             | `reasoning_split` and thinking switch                                                   | `max_tokens`; compatible usage                                                     | Adapter removes conflicting switches before send / 发送前移除冲突开关                                    |
| Ollama native / `ollama`     | Loopback `/api/chat` or `/api/generate`; normally keyless HTTP                 | Complete JSON in v1; native NDJSON streaming is not consumed / v1 使用完整 JSON | Native `think` boolean                                                                  | `options.num_predict`; `prompt_eval_count` + `eval_count`                          | OpenAI-compatible `/v1/chat/completions` uses the compatible shape instead / `/v1` 使用兼容方言          |
| Custom compatible / `custom` | HTTPS remote or loopback HTTP; optional core Bearer key                        | SSE when endpoint supports Chat Completions events                              | No vendor fields by default; explicit `enabledBody`/`disabledBody` / 默认不注入厂商字段 | `max_tokens`; common OpenAI/Anthropic/Ollama usage fields normalized               | Validate the endpoint before trusting it with code or credentials / 发送代码前验证端点                   |
| Extension / `extension:<id>` | Core HTTPS/loopback transport and optional Bearer only / 核心传输与可选 Bearer | Declared conservative in API v1 / v1 保守声明                                   | Adapter operation can transform non-secret reasoning config                             | Adapter maps body and normalized response                                          | No custom credential scheme or headers; credential-like body fields rejected / 不支持自定义鉴权或 header |

## Compatibility contract / 兼容契约

All built-in adapters return `content`, optional `reasoning`, normalized usage, finish reason, raw response, capabilities, attempts, and latency. Retries cover 429, selected 5xx, and network/body interruption; authentication, invalid parameters, and safety failures are not retried.

所有内置 adapter 返回 `content`、可选 `reasoning`、标准 usage、finish reason、raw response、capability、attempts 与 latency。仅 429、部分 5xx、网络/响应中断会重试；鉴权、参数与安全错误不会重试。

Preset compatibility is declared by core version range plus `adapterContract: 1`. Run:

Preset 兼容性由核心版本范围与 `adapterContract: 1` 共同声明：

```bash
aicommit preset show
aicommit preset validate --file=provider-presets.json
aicommit preset install --file=provider-presets.json
aicommit doctor -p provider-name
```

Use an existing built-in adapter when only setup defaults change. Use `custom` for an OpenAI-compatible endpoint with optional body switches. Use a reviewed `providerAdapter` extension only when the JSON request/response dialect differs and core Bearer authorization is sufficient. A protocol requiring different transport, streaming parser, or credential scheme is not compatible with extension API v1 and must not be disguised as a preset.

若只改变 setup 默认值，应复用内置 adapter；OpenAI-compatible endpoint 及少量 body 开关使用 `custom`；仅当 JSON 请求/响应方言不同且核心 Bearer 鉴权足够时，才使用已审查的 `providerAdapter` 扩展。若协议需要不同传输、流解析或鉴权方案，则不兼容扩展 API v1，不能伪装成 preset。
