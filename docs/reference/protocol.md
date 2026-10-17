# Protocol reference

Package: `@kestrel/protocol` · protocol version `1.0`.

Data only: no behaviour, no dependencies, safe to compile into a browser, CLI, desktop shell or
mobile client. The server, console and CLI all use these types.

## Endpoints

| Method | Path | Success | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/health` | `200 HealthResponse` | Public even when auth is enabled. |
| `GET` | `/api/bootstrap` | `200 BootstrapResponse` | Models, tools, plugins, feature flags. |
| `GET` | `/api/config` | `200` sanitized config | No secrets. |
| `GET` | `/api/plugins` | `200 { plugins: PluginInfo[] }` | |
| `GET` | `/api/sessions` | `200 { sessions: SessionSummary[] }` | Sorted by `updatedAt` descending. |
| `POST` | `/api/sessions` | `201 { session: SessionDetail }` | Body `CreateSessionRequest`. |
| `GET` | `/api/sessions/:id` | `200 { session: SessionDetail }` | |
| `PATCH` | `/api/sessions/:id` | `200 { session: SessionDetail }` | `title`, `model`, `systemPrompt`. |
| `DELETE` | `/api/sessions/:id` | `204` | Removes the transcript. |
| `POST` | `/api/sessions/:id/messages` | `202 { runId }` | Body `SendMessageRequest`; text, images or both. |
| `POST` | `/api/sessions/:id/cancel` | `200 { cancelled: boolean }` | Idempotent. |
| `POST` | `/api/sessions/:id/resume` | `202 { runId }` | Continues an `interrupted` or `error` session; `409 not_resumable` otherwise. |
| `GET` | `/api/sessions/:id/events` | `200 text/event-stream` | Session-scoped stream. |
| `POST` | `/api/sessions/:id/approvals/:approvalId` | `200 { resolved: true }` | Body `{ "approved": boolean, "note"?: string }`. |
| `GET` | `/api/sessions/:id/checkpoints` | `200 CheckpointListResponse` | `enabled`, optional `reason`, `checkpoints[]`. |
| `POST` | `/api/sessions/:id/checkpoints` | `201 { checkpoint }` | Body `{ "label"?: string }`. |
| `POST` | `/api/sessions/:id/checkpoints/:checkpointId/restore` | `200 { restored, safety }` | `409 session_busy` while a run is active. |
| `GET` | `/api/events` | `200 text/event-stream` | All sessions; operator/debug use. |

Unknown routes return `404`. Wrong methods on a known route return `405` with
`method_not_allowed`.

## Requests

```ts
interface CreateSessionRequest {
  title?: string;
  model?: string;         // must be a registered model id
  systemPrompt?: string;
  workspace?: string;     // absolute path; defaults to config.agent.workspace
}

interface SendMessageRequest {
  content: string;          // 0..200_000 chars; may be empty when images are present
  images?: ImageAttachment[];
}

interface ImageAttachment {
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;             // base64, without the `data:` prefix
  name?: string;            // display label, at most 120 chars
}

interface ApprovalDecision { approved: boolean; note?: string }
```

`POST /api/sessions/:id/messages` returns `409 session_busy` while a run is active. It does not
queue: the client waits for `run.finished` and sends the next message.

A message must carry text, images or both. Limits: at most 6 images, 4 MB each, 12 MB in total.
A `data:` prefix is accepted and stripped, so a browser can post `FileReader` output unchanged.
Invalid base64 or an unsupported `mimeType` answers `400 invalid_images`; oversize answers `413`.

## Responses

```ts
interface HealthResponse {
  status: "ok";
  name: string;
  version: string;
  protocol: string;
  uptimeMs: number;
  plugins: number;   // active plugins
  sessions: number;
}

interface BootstrapResponse {
  name: string;
  version: string;
  protocol: string;
  models: ModelInfo[];
  tools: ToolSchema[];
  plugins: PluginInfo[];
  features: {
    streaming: boolean;
    approvals: boolean;
    persistence: boolean;
    multiSession: boolean;
  };
}
```

OpenAPI is not published yet; this page and the TypeScript definitions are the contract.

## Errors

```ts
interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
```

| Status | Codes |
| --- | --- |
| `400` | `invalid_json`, `invalid_body`, `invalid_title`, `invalid_model`, `invalid_prompt`, `invalid_message`, `invalid_decision`, `bad_path` |
| `401` | `unauthorized` |
| `403` | `forbidden` |
| `404` | `not_found`, `session_not_found`, `approval_not_found` |
| `405` | `method_not_allowed` |
| `409` | `session_busy` |
| `413` | `payload_too_large`, `message_too_large` |
| `500` | `internal_error` |

`500` messages are deliberately generic; the stack goes to the server log. All error responses
carry `cache-control: no-store`.

## Server-sent events

Both stream endpoints emit:

```
id: 42
data: {"seq":42,"at":"2026-01-01T00:00:00.000Z","event":{"type":"message.delta",...}}

```

- `id` is the envelope `seq`, monotonic per server process.
- `data` is a single-line JSON `ServerEventEnvelope`.
- A comment heartbeat (`: ping`) is sent every 15 seconds.
- The server first writes `retry: 3000`.
- Headers: `content-type: text/event-stream`, `cache-control: no-cache, no-transform`,
  `x-accel-buffering: no`.

### Replay

Send `Last-Event-ID: <seq>` (or `?lastEventId=<seq>`) to receive buffered events with a greater
sequence number before live delivery.

- On a **first** connection, omit `Last-Event-ID`. History comes from `GET /api/sessions/:id`;
  replaying the buffer would duplicate messages.
- The buffer is in memory and bounded (10,000 envelopes in the current server). If the requested id has already
  been evicted, the server replays what remains; clients should then refetch the session detail.
- Scope matters: a session stream replays only that session's events.

### Ordering

Events are emitted in the order the runtime produces them. A typical run:

```
session.updated
run.started
message.started        (assistant)
message.delta ...
tool.started
[approval.requested]
[approval.resolved]
tool.finished
message.started        (tool result)
message.completed
run.finished
```

`message.completed` is authoritative: replace any locally accumulated deltas with its content.
Deltas may arrive on the `text` or `reasoning` channel and can interleave.

`notice` can appear between any two events. `plugin.changed` is part of the union but is not
emitted by the 0.1 server; treat it as forward-compatible surface.

`context.compacted` says the server replaced old messages with a summary; clients should refetch the
session before rendering the next turn. See [Long sessions](/guide/models#long-sessions-and-compaction).

## Event union

```ts
type SessionEvent =
  | { type: "session.updated"; sessionId: string; session: SessionSummary }
  | { type: "run.started"; sessionId: string; runId: string }
  | { type: "run.finished"; sessionId: string; runId: string;
      status: "completed" | "cancelled" | "max_steps"; usage?: Usage }
  | { type: "run.failed"; sessionId: string; runId: string; error: string }
  | { type: "message.started"; sessionId: string; message: ChatMessage }
  | { type: "message.delta"; sessionId: string; messageId: string;
      channel: "text" | "reasoning"; delta: string }
  | { type: "message.completed"; sessionId: string; message: ChatMessage }
  | { type: "tool.started"; sessionId: string; call: ToolCall }
  | { type: "tool.finished"; sessionId: string; result: ToolResult }
  | { type: "approval.requested"; sessionId: string; approval: ApprovalRequest }
  | { type: "approval.resolved"; sessionId: string; approvalId: string; approved: boolean }
  | { type: "session.deleted"; sessionId: string }
  | { type: "plugin.changed"; plugin: PluginInfo }
  | { type: "context.compacted"; sessionId: string; removedMessages: number;
      keptMessages: number; tokensBefore: number; tokensAfter: number }
  | { type: "notice"; level: "info" | "warn" | "error"; message: string };
```

## Core data types

```ts
interface ChatMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: ImageAttachment[];
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  createdAt: string;
  model?: string;
  hidden?: boolean;
  meta?: Record<string, unknown>;
}

interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }

interface ToolResult {
  callId: string;
  name: string;
  ok: boolean;
  content: string;
  durationMs?: number;
  error?: string;
  data?: unknown;      // client-only; never sent to the model
}

interface ToolSchema {
  name: string;
  description: string;
  parameters: JsonSchema;
  permission?: "auto" | "ask";
  category?: string;
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

interface ModelInfo {
  id: string;
  provider: string;
  label?: string;
  description?: string;
  contextWindow?: number;
  supportsTools: boolean;
  supportsReasoning?: boolean;
}

interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: "idle" | "running" | "interrupted" | "error" | "cancelled";
  model: string;
  messageCount: number;
  workspace: string;
}

interface SessionDetail extends SessionSummary {
  messages: ChatMessage[];
  systemPrompt?: string;
}
```

### Interrupted runs

A session is persisted as `running` while a run is in flight. If the server
stops abruptly, the next boot rewrites that status to `interrupted`, and
`POST /api/sessions/:id/resume` re-enters the loop from the stored transcript.
Tool calls that had no recorded result are answered with an error result
instead of being executed again, because a side effect may already have
happened: the model is told to verify the workspace before retrying. Failed
runs (`error`) can be resumed the same way.

## Authentication

When a token is configured, every `/api/*` route except `/api/health` requires it:

```
Authorization: Bearer <token>
```

`?token=<token>` is accepted for clients that cannot set headers (`EventSource`). Tokens are
compared in constant time. Static assets are never authenticated by the server; put the whole
origin behind a proxy if that matters.

## Versioning

`PROTOCOL_VERSION` is returned by `/api/health` and `/api/bootstrap`. Within a major version:

- new event types, fields and endpoints may be added;
- clients must ignore unknown fields and unknown event types;
- existing field meanings do not change.

A major bump will ship with a migration note and, where possible, a compatibility layer.
