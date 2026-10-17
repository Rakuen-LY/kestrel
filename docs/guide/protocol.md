# Protocol and API

Everything a client needs is JSON over HTTP plus one Server-Sent Events stream. The definitions
live in `@kestrel/protocol`; the server is a reference implementation.

Base URL: `http://<host>:7331`. All API paths are under `/api`.

## Authentication

If `server.token` is configured, every `/api/*` request needs a bearer token:

```http
Authorization: Bearer <token>
```

Event streams, which cannot set headers in a browser `EventSource`, may use a query parameter
instead:

```
GET /api/sessions/<id>/events?token=<token>
```

`GET /api/health` is public so load balancers can probe the process without credentials. Static
console files are public; the API they call is not.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness, version, uptime, plugin and session counts. |
| `GET` | `/api/bootstrap` | Models, tools, plugins and feature flags for a new client. |
| `GET` | `/api/config` | Sanitized runtime configuration (no secrets). |
| `GET` | `/api/plugins` | Plugin list with state and errors. |
| `GET` | `/api/sessions` | Session summaries. |
| `POST` | `/api/sessions` | Create a session. |
| `GET` | `/api/sessions/:id` | Session detail, including the transcript. |
| `PATCH` | `/api/sessions/:id` | Rename, change model or system prompt while idle. |
| `DELETE` | `/api/sessions/:id` | Delete a session and its persisted transcript. |
| `POST` | `/api/sessions/:id/messages` | Start a run. Returns `202` immediately. |
| `GET` | `/api/sessions/:id/events` | SSE stream for one session. |
| `GET` | `/api/events` | SSE stream for every session (operator dashboards). |
| `POST` | `/api/sessions/:id/cancel` | Abort the active run. |
| `POST` | `/api/sessions/:id/approvals/:approvalId` | Approve or decline a tool call. |

### Create a session

```bash
curl -sS -X POST http://127.0.0.1:7331/api/sessions \
  -H 'content-type: application/json' \
  -d '{"title":"Refactor auth","model":"gpt-4o-mini","workspace":"/srv/app"}'
```

```json
{
  "session": {
    "id": "0f0d...",
    "title": "Refactor auth",
    "createdAt": "2026-01-01T10:00:00.000Z",
    "updatedAt": "2026-01-01T10:00:00.000Z",
    "status": "idle",
    "model": "gpt-4o-mini",
    "messageCount": 0,
    "workspace": "/srv/app",
    "messages": [],
    "systemPrompt": "..."
  }
}
```

All fields except `title` are optional. `workspace` must be resolvable by the server.

Sessions created by `delegate` carry delegation metadata on every summary and detail response:

```json
{ "parentId": "9a1b…", "depth": 1, "role": "researcher" }
```

`parentId` is absent for sessions a human started, which keeps the root list a tree with a single
optional edge per node. `depth` and `role` are present whenever `parentId` is.

### Send a message

```bash
curl -sS -X POST http://127.0.0.1:7331/api/sessions/$ID/messages \
  -H 'content-type: application/json' \
  -d '{"content":"Find the failing test and fix it."}'
# {"runId":"..."}
```

The response is `202 Accepted` and does not wait for the model. Subscribe to the event stream
before or after sending; events are buffered in memory and replayed on reconnect.

One run per session at a time. A second message while a run is active returns
`409 session_busy`; cancel first or wait for `run.finished`.

### Approve a tool call

```bash
curl -sS -X POST \
  http://127.0.0.1:7331/api/sessions/$ID/approvals/$APPROVAL_ID \
  -H 'content-type: application/json' \
  -d '{"approved":true}'
```

The approval id arrives in an `approval.requested` event. Decisions are idempotent only while the
call is pending; a late decision returns `404 approval_not_found`.

## Server-Sent Events

Each frame is:

```
id: 42
data: {"seq":42,"at":"2026-01-01T10:00:03.120Z","event":{"type":"message.delta","sessionId":"...","messageId":"...","channel":"text","delta":"Hel"}}
```

- `id` equals the envelope `seq`. Send it back as `Last-Event-ID` (or `?lastEventId=`) to replay
  missed events after a reconnect.
- The server emits `retry: 3000` and a heartbeat comment every 15 seconds.
- Replay is per process and bounded; it is a reconnection aid, not an audit log.

### Event types

| Type | Payload |
| --- | --- |
| `session.updated` | Session summary after a title, model or status change. |
| `run.started` | `runId`; the run is now active. |
| `message.started` | Assistant message skeleton. |
| `message.delta` | `messageId`, `channel` (`text` or `reasoning`), `delta`. |
| `message.completed` | Final message with content, reasoning and tool calls. |
| `tool.started` | The call about to execute. |
| `tool.finished` | Result, duration, error flag and optional structured `data`. |
| `approval.requested` | Call, reason and approval id. |
| `approval.resolved` | Decision. |
| `run.finished` | Terminal status (`completed`, `cancelled`, `max_steps`) and accumulated usage. |
| `run.failed` | Error message; the session is marked `error`. |
| `session.deleted` | The session no longer exists. |
| `plugin.changed` | A plugin changed state at runtime. |
| `notice` | Non-fatal informational message. |

A user message is appended synchronously and emitted as `message.completed` before `run.started`.
Clients may render it optimistically, then reconcile with the event carrying the server id.

### Minimal client

```ts
const session = await fetch(`${base}/api/sessions`, { method: "POST" }).then((r) => r.json());
const events = new EventSource(`${base}/api/sessions/${session.session.id}/events`);

events.onmessage = (message) => {
  const { event } = JSON.parse(message.data);
  switch (event.type) {
    case "message.delta":
      if (event.channel === "text") process.stdout.write(event.delta);
      break;
    case "run.finished":
      console.log(`\n[${event.status}]`);
      break;
    case "approval.requested":
      void decide(event.approval.id, true);
  }
};

await fetch(`${base}/api/sessions/${session.session.id}/messages`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ content: "Hello" }),
});
```

## Errors

Errors use one envelope:

```json
{
  "error": {
    "code": "session_busy",
    "message": "This session already has an active run.",
    "details": {}
  }
}
```

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_json`, `invalid_message`, `invalid_body` | Malformed or missing fields. |
| 401 | `unauthorized` | Missing or wrong bearer token. |
| 403 | `forbidden` | Static path traversal attempt. |
| 404 | `session_not_found`, `approval_not_found`, `not_found` | Unknown resource or route. |
| 405 | `method_not_allowed` | Wrong verb for an existing path. |
| 409 | `session_busy` | A run is already active. |
| 413 | `payload_too_large`, `message_too_large` | Body over the configured limit. |
| 500 | `internal_error` | Unexpected server error; details are in the log. |

Internal errors never leak stack traces to clients.

## Limits

| Limit | Default |
| --- | --- |
| Request body | 10 MB (`server.bodyLimitBytes`) |
| Message length | 200,000 characters |
| Tool result sent to the model | 60,000 characters |
| Store writes | Debounced, atomic rename |
| Event replay buffer | Bounded per process |

## Versioning

`/api/health` and `/api/bootstrap` report `protocol: "1.0"`. The protocol follows semantic
versioning: additive event types and optional fields are minor changes; removals or semantic
changes are major.
