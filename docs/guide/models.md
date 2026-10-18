# Models and providers

A model provider is a plugin that registers one or more `LanguageModel` objects into the `models`
service. The runtime picks a model per session, calls `generate`, and streams whatever the provider
reports.

## The interface

```ts
export interface LanguageModel {
  readonly info: ModelInfo;
  generate(request: CompletionRequest, onDelta?: (delta: TokenDelta) => void): Promise<CompletionResponse>;
}
```

`CompletionRequest` carries the fully built message list (system prompt included), the available
tool schemas, temperature, token limit and an `AbortSignal`. `CompletionResponse` carries:

```ts
{
  content: string;
  reasoning?: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  finishReason: "stop" | "length" | "tool_calls" | "error";
}
```

Providers assemble streamed tool calls themselves. OpenAI-compatible APIs send argument fragments
by index; the bundled provider accumulates them and emits one call per index.

## Bundled provider

`@kestrel/plugin-openai` speaks the OpenAI chat-completions protocol, including streaming and tool
calls. It works with OpenAI, Azure OpenAI (via a custom `baseUrl`), DeepSeek, Moonshot, vLLM, Ollama
and anything else that implements the same wire format.

| Option | Default | Description |
| --- | --- | --- |
| `baseUrl` | `https://api.openai.com/v1` | Endpoint root, without a trailing slash. |
| `apiKey` | — | Literal key. Prefer `apiKeyEnv`. |
| `apiKeyEnv` | `OPENAI_API_KEY` | Environment variable to read the key from. |
| `headers` | `{}` | Extra request headers. |
| `provider` | `openai` | Label shown in clients. |
| `model` | `gpt-4o-mini` | Single model id. |
| `models` | — | List of model ids to register. |
| `label` | model id | Display name. |
| `contextWindow` | — | Informational. |
| `supportsTools` | `true` | Send tool schemas. |
| `supportsReasoning` | `false` | Advertise a reasoning channel. |
| `temperature` | — | Forwarded to the API. |
| `maxTokens` | — | Forwarded to the API. |
| `timeoutMs` | `180000` | Request timeout. |
| `streamUsage` | `true` | Request usage in the final stream chunk. |

Example configuration:

```json
{
  "model": { "default": "deepseek-chat" },
  "plugins": {
    "config": {
      "@kestrel/plugin-openai": {
        "baseUrl": "https://api.deepseek.com/v1",
        "apiKeyEnv": "DEEPSEEK_API_KEY",
        "provider": "deepseek",
        "models": ["deepseek-chat", "deepseek-reasoner"],
        "supportsReasoning": true
      }
    }
  }
}
```

For a local Ollama instance:

```json
{
  "@kestrel/plugin-openai": {
    "baseUrl": "http://127.0.0.1:11434/v1",
    "apiKey": "ollama",
    "provider": "ollama",
    "models": ["qwen2.5-coder:14b"]
  }
}
```

## Anthropic

`@kestrel/plugin-anthropic` speaks the Messages API directly, including streaming text, extended
thinking, tool use and base64 images. Use it rather than the OpenAI-compatible plugin when you need
native thinking blocks or Anthropic prompt caching headers.

| Option | Default | Description |
| --- | --- | --- |
| `baseUrl` | `https://api.anthropic.com` | Origin or proxy root; `/v1` is appended unless present. |
| `apiKey` | — | Literal key. Prefer `apiKeyEnv`. |
| `apiKeyEnv` | `ANTHROPIC_API_KEY` | Environment variable to read the key from. |
| `headers` | `{}` | Extra request headers (for gateways). |
| `provider` | `anthropic` | Label shown in clients. |
| `model` | `claude-sonnet-4-5` | Single model id. |
| `models` | — | List of model ids to register. |
| `maxTokens` | `4096` | `max_tokens` is required by the API; sent with every request. |
| `thinkingBudget` | — | Enables extended thinking with this token budget. Forces `temperature` off. |
| `anthropicVersion` | `2023-06-01` | `anthropic-version` header. |
| `timeoutMs` | `180000` | Request timeout. |

```json
{
  "model": { "default": "claude-sonnet-4-5" },
  "plugins": {
    "config": {
      "@kestrel/plugin-anthropic": {
        "models": ["claude-sonnet-4-5", "claude-haiku-4-5"],
        "thinkingBudget": 4096
      }
    }
  }
}
```

Wire-format notes the adapter handles for you:

- The system prompt is a top-level `system` field, not a message.
- Tool results are `tool_result` blocks inside a user turn; parallel results are merged into one
  turn, which the API requires.
- Assistant tool calls become `tool_use` blocks whose `input` is the decoded argument object.
- `stop_reason` maps to Kestrel's finish reasons: `tool_use` → `tool_calls`, `max_tokens` →
  `length`, `refusal` → `content_filter`.

## Default model selection

1. `model.default` in configuration wins if the model exists.
2. Otherwise the first registered model becomes the default.
3. `POST /api/sessions` can pin a model per session; `PATCH /api/sessions/:id` changes it while idle.

A session keeps its model across restarts. The console's model picker and `kestrel models` read the
same registry.

## Reasoning traces

Some providers expose a separate reasoning channel ("thinking" tokens). Emit them as
`onDelta({ channel: "reasoning", delta })` and include the final text in `reasoning`. The runtime
stores the trace separately from `content`, and clients collapse it behind a disclosure. Whether it
is replayed to the model is the provider's decision when mapping messages.

## Usage accounting

Report input and output token counts when the provider supplies them. The runtime sums usage per
run and includes it in `run.finished`; clients can display totals or bill against them. Estimates
are acceptable for providers that do not report usage, but label them as estimates in your metrics.

## Retries

The runtime retries transient failures so providers do not each implement their own policy. An
adapter throws `ModelRequestError` with `retryable: true` for rate limits, gateway errors and
network failures, and the session retries with exponential backoff and jitter. A `Retry-After`
header wins over the computed delay, capped by `maxDelayMs`. Each retry emits a `notice` event, so
clients show the wait without a separate protocol message.

Retries are safe by construction: an attempt that already streamed a token is never retried,
because clients have rendered those deltas. A failure after the first delta fails the run instead
of duplicating output.

```json
{
  "agent": {
    "retry": { "attempts": 4, "baseDelayMs": 750, "maxDelayMs": 15000 }
  }
}
```

Classification lives in the adapters: HTTP 408, 409, 425, 429, 5xx and fetch failures are
retryable; other 4xx responses are final. Provider authors get `modelHttpError()` and
`modelNetworkError()` from `@kestrel/agent`.

## Errors and cancellation

- Throw on HTTP or protocol errors. The runtime emits `run.failed` with your message and marks the
  session `error`.
- Honour `request.signal`. Abort promptly and let the rejection propagate; the runtime converts it
  into a cancelled run.
- Do not retry indefinitely inside `generate`. One retry with backoff is reasonable; the user has a
  cancel button.

## Writing a local provider

A provider backed by a local process uses the same interface. Register the model, spawn or connect
on first use, and dispose the process with `context.effect`:

```ts
apply(context, config) {
  const child = spawn("my-local-llm", ["--serve"]);
  context.effect(() => () => child.kill());
  context.effect(() => context.get("models").register(createModel(child, config)));
}
```

Keep the model object stateless where possible; sessions may be created and destroyed concurrently.

## Long sessions and compaction

A model call is bounded by the context window, not by how long a conversation has run. Kestrel
estimates the prompt on every step (chars/4, plus a small per-message overhead) and, once it crosses
`agent.compaction.threshold` of the window, replaces the oldest turns with a model-written brief.

```
before:  [user][assistant][tool]... 40 turns ... [user]
after:   [assistant: summary] [user][assistant][tool] [user]
```

The cut always lands on a user message, so a tool call is never separated from its result. The
summary is a normal assistant message in the transcript — visible in clients and to the agent — and
the `context.compacted` event reports how many messages were folded and the estimated token change.
Messages in the tail are kept verbatim; the summarizer itself receives a truncated transcript with
tool arguments shortened, so compaction cannot recursively blow up the window.

Configuration:

```json
{
  "agent": {
    "compaction": { "threshold": 0.8, "keepRecent": 8 }
  }
}
```

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Set `false` to keep full history and let the provider reject oversized prompts. |
| `threshold` | `0.8` | Fraction of `contextWindow` that triggers compaction. |
| `keepRecent` | `8` | Messages always preserved. |
| `fallbackContextWindow` | `128000` | Used when a model does not declare a window. |

Compaction needs at least two removable messages and a user-message boundary; otherwise the step
proceeds unchanged. If the summarizer call fails or returns nothing, the failure is logged and the
original history is kept — a compaction problem never fails a run. Token counts are estimates until
the provider reports usage, so leave headroom below `1.0`.

Compaction edits history, checkpoints edit files. They are independent: restoring a checkpoint does
not rewind the transcript, and compaction does not touch the workspace.

## Images

A user message may carry images alongside text. The console accepts them with the paperclip, a
paste or a drop; the API takes base64-encoded attachments:

```json
{
  "content": "Which component renders the sidebar?",
  "images": [{ "mimeType": "image/png", "data": "iVBORw0KGgo...", "name": "screenshot.png" }]
}
```

The provider serializes them as OpenAI-style content parts:

```json
{ "role": "user", "content": [
  { "type": "text", "text": "Which component renders the sidebar?" },
  { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0KGgo..." } }
] }
```

Text-only messages stay plain strings, so endpoints that do not support parts keep working.

Limits, enforced by the server: PNG, JPEG, WebP or GIF; at most 6 images; 4 MB each; 12 MB total.
The browser downscales photographs to a 1568 px long edge before uploading, which keeps requests
under provider limits without visible quality loss. GIFs are sent untouched so animation survives,
and a `data:` prefix is accepted and stripped.

Images count against the context window — the estimator charges 1100 tokens each — so screenshots
are compacted away with the turns that carried them. Not every model accepts images: a text-only
endpoint will usually answer `400`. Pick a vision-capable model in the session header when
attaching them. The CLI has no attachment flags yet; use the HTTP API or the console.

### Images from tools

A tool returns images by setting `images` on its result, and the runtime carries them through the
transcript, SSE events and the console:

```ts
return {
  content: `Saved screenshot to ${path}.`,
  images: [{ mimeType: "image/png", data: base64, name: "page.png" }],
};
```

Clients render the images inside the tool card, including after a reload, because tool messages
persist them alongside an `isError` flag. All provider adapters send them back to the model:

- Anthropic puts text and images in the same `tool_result` content block.
- OpenAI-compatible endpoints only accept images in user turns, so tool images are attached to the
  next user message, or to a synthetic user message when the tool batch ends the history.
- Messages that carry no images keep their previous wire shape, which is important for endpoints
  that do not implement content parts.

Tool output is untrusted, so the runtime drops images that are not PNG, JPEG, WebP or GIF, exceed
4 MB each, more than 6 per call, or 12 MB in total. It appends `[images omitted: …]` to the tool
result instead of failing the call. A tool that returns images should therefore tell the user
what it saved even when the model cannot see it.

`browser_screenshot` is the bundled producer: pass `include_image: true` to receive the page as an
image. See [Browser automation](/guide/browser).
