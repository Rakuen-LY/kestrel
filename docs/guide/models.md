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
