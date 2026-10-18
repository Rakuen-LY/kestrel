# Roadmap

Kestrel is at `0.1`. The foundation is intentionally conservative; features are added only when they
fit the plugin model. This page is a statement of intent, not a schedule.

## What works today

| Area | Status |
| --- | --- |
| Kernel services, injection, scopes, lifecycle events | Done |
| Plugin discovery, manifests, dependency ordering, config merge | Done |
| Session/run loop with streaming, tool calls, cancellation | Done |
| Multiple concurrent sessions with file persistence | Done |
| Approvals for `ask` tools over HTTP and CLI | Done |
| OpenAI-compatible provider (OpenAI, DeepSeek, vLLM, Ollama) | Done |
| Core filesystem, search, shell, fetch, todo and finish tools | Done |
| Headless browser tools: snapshots, clicks, typing, screenshots | Done |
| Memory tools and MCP bridge (stdio and streamable HTTP) | Done |
| Web console: streaming markdown, tool cards, approvals, plugin panel, PWA install | Done |
| Plugin UI contributions: browser bundles rendered in console slots | Done |
| Workspace checkpoints, rewind and safety snapshots | Done |
| Context compaction with a model-written summary | Done |
| Accounts, roles and tenant isolation (`auth.mode: "accounts"`) | Done |
| CLI: serve, run, chat, plugins, models, sessions | Done |
| Docker, Compose, Kubernetes, systemd, launchd, Windows Task | Done |
| Documentation site | You are reading it |
| Test suite | Unit tests plus end-to-end HTTP/SSE runs against a scripted model |

## Next

### 1. A stronger test and release pipeline

- Snapshot tests for every HTTP error path.
- Browser tests for the console against a scripted backend.
- Automated release workflow with signed tags and changelog generation.

### 2. Plugin UI hardening

Bundles load into three slots (`sidebar.footer`, `session.header`, `settings.section`) from a
plugin's `web/` directory, each in a sandboxed iframe with an opaque origin and a proxied API. The
remaining work is about capability, not isolation:

- ~~Per-plugin route grants~~ — `web.api` defaults to read-only and mutating routes must be
  declared; the proxy rejects anything else.
- More slots: message renderer, composer actions, file viewer.
- A dev channel that reloads a bundle without a page refresh.

See [Plugin UI](/guide/plugin-ui).

### 3. Durable stores and multi-process operation

- ~~SQLite `SessionStore`~~ — opt-in today via `storage.driver: "sqlite"`; default
  switch is deferred until migrations are exercised in the field.
- Postgres store and a shared event bus (Redis or NATS) as opt-ins.
- ~~Resumable runs after a crash~~ — shipped: persisted `running` sessions become
  `interrupted` on boot and resume from the transcript without replaying tools.

### 4. Sandbox backends

- ~~A `sandbox` service~~ — the interface lives in `@kestrel/agent`; `@kestrel/plugin-sandbox-docker`
  runs each shell command in a disposable container; see [Process sandbox](/guide/sandbox).
- Route every tool (filesystem, search, fetch) through the sandbox, not only `shell`.
- A Kubernetes pod backend and per-run resource quotas. This remains the piece that changes the
  security story most.

### 5. Clients beyond the browser

- Desktop shell (Tauri) reusing the web console, with OS keychain storage for tokens.
- Mobile client using the same protocol; approvals via push notification.
- Protocol bindings generated from `@kestrel/protocol` for Python and Go.

### 6. Deeper agent capabilities

- ~~Sub-agents and delegation~~ — shipped in `@kestrel/plugin-subagents` with isolated context,
  roles and a bounded depth (see [Subagents](/guide/subagents)). Still missing: parallel fan-out in
  one tool call, and per-branch cost reporting.
- ~~MCP resources and prompts~~ — bridged as `mcp__<server>__*` tools and on the `mcp` service;
  ~~sampling~~ ships opt-in with per-call budgets, elicitation remains; see [MCP](/guide/mcp).
- ~~Context compaction and summarisation for long sessions~~ — shipped; see
  [Long sessions](/guide/models#long-sessions-and-compaction).
- ~~Skill authoring UX~~ — `kestrel skills` lists and shows procedures, `skills lint` validates
  files (including the ones the runtime would skip) and `skills new` scaffolds them; see
  [Skills](/guide/skills).
- ~~Multimodal user messages~~ — images ship in the console and the API; see
  [Images](/guide/models#images). Still missing: image-producing tools and attachments on tool
  results.
- ~~Checkpoints and rollback for workspace edits~~ — shipped; see [Checkpoints](/guide/checkpoints).
- ~~Rewind of the transcript alongside files~~ — `POST /api/sessions/:id/rewind` truncates at a
  user message and restores its snapshot in one call. See [Rewind a turn](/guide/checkpoints#rewinding-a-turn).
- ~~Background tasks and scheduled runs~~ — webhooks and cron ship in
  `@kestrel/plugin-triggers`; file watchers and background job queues remain.

### 7. Platform features

- Plugin registry with signatures and provenance.
- OIDC and SSO on top of the accounts model.
- ~~Per-tenant quotas~~ — `@kestrel/plugin-quota` enforces session, concurrency and token limits
  through session guards; see [Quotas & guards](/guide/quotas). Open: shared counters across
  replicas and timed budget windows.
- ~~Metrics and an audit log of tool executions~~ — `@kestrel/plugin-metrics` serves Prometheus text
  and a plugin-facing registry; `@kestrel/plugin-audit` keeps a JSONL trail. Still open: an
  OpenTelemetry exporter. See [Metrics](/guide/metrics) and
  [Audit log](/guide/audit).
- ~~Scheduled and event-triggered runs~~ — webhooks and UTC cron schedules ship in
  `@kestrel/plugin-triggers`; file watchers and durable delivery history are still open.

## Later

- More provider plugins: Gemini-native, local llama.cpp server.
- More tool packs: browser automation, LSP-aware code navigation, database access.
- Evaluation harness: replay recorded sessions against new models.
- Helm chart and Terraform module.
- Internationalisation of the documentation site.

## Non-goals

- **Replacing your terminal.** Kestrel is a platform for agents, not a terminal emulator.
- **A hosted SaaS in this repository.** The code is self-hostable; a managed service would be a
  separate product.
- **A proprietary plugin marketplace.** Plugins are npm-compatible directories; distribution can
  stay boring.
- **Framework lock-in.** The core does not depend on React, Fastify, Express or a specific database.

## Versioning policy

- Protocol `1.x` keeps event names and endpoint shapes stable.
- Additive fields and event types are minor releases.
- Breaking changes require a major protocol bump and a migration note.
- Packages are versioned together while the project is `0.x`; independent versioning starts at
  `1.0`.

## How to influence it

Open an issue describing the use case, not only the feature. The best proposals explain the
deployment shape, the failure modes, and how the capability fits the plugin contract. See
[Contributing](/contributing).
