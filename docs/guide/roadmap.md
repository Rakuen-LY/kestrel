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
| Memory tools and Model Context Protocol bridge | Done |
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

Bundles now load into three slots (`sidebar.footer`, `session.header`, `settings.section`) from a
plugin's `web/` directory. Remaining work:

- Sandbox bundles in an iframe or module worker, with an explicit capability list.
- More slots: message renderer, composer actions, file viewer.
- A dev channel that reloads a bundle without a page refresh.

See [Plugin UI](/guide/plugin-ui).

### 3. Durable stores and multi-process operation

- SQLite `SessionStore` as the default for single-node installs.
- Postgres store and a shared event bus (Redis or NATS) as opt-ins.
- Resumable runs after a crash: persist the in-flight step and re-enter the loop.

### 4. Sandbox backends

- A `sandbox` service with implementations for local processes, Docker, and Kubernetes pods.
- Tools receive a sandbox handle instead of assuming the host filesystem.
- Per-run containers with the workspace mounted read-write and everything else read-only.

This is the largest piece of work and the one that changes the security story most.

### 5. Clients beyond the browser

- Desktop shell (Tauri) reusing the web console, with OS keychain storage for tokens.
- Mobile client using the same protocol; approvals via push notification.
- Protocol bindings generated from `@kestrel/protocol` for Python and Go.

### 6. Deeper agent capabilities

- ~~Sub-agents and delegation~~ — shipped in `@kestrel/plugin-subagents` with isolated context,
  roles and a bounded depth (see [Subagents](/guide/subagents)). Still missing: parallel fan-out in
  one tool call, and per-branch cost reporting.
- ~~Context compaction and summarisation for long sessions~~ — shipped; see
  [Long sessions](/guide/models#long-sessions-and-compaction).
- Skill authoring UX: a `kestrel skills` command to list, lint and scaffold procedures. Discovery
  and progressive loading ship in `@kestrel/plugin-skills`; see [Skills](/guide/skills).
- Multimodal messages and image-producing tools.
- ~~Checkpoints and rollback for workspace edits~~ — shipped; see [Checkpoints](/guide/checkpoints).
  Still missing: rewind of the transcript alongside files.
- Background tasks and scheduled runs.

### 7. Platform features

- Plugin registry with signatures and provenance.
- OIDC and SSO on top of the accounts model; per-tenant quotas and usage accounting.
- Metrics (OpenTelemetry) and an audit log of tool executions.
- Scheduled and event-triggered runs (webhooks, file watchers).

## Later

- More provider plugins: Anthropic-native, Gemini-native, local llama.cpp server.
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
