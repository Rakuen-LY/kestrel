# Changelog

All notable changes to Kestrel are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Workspace file browser in the console (`apps/web/src/components/FileViewer.tsx`) and the read-only
  `GET /api/sessions/:id/files` and `/file` routes. Listings are directories-first and hide ignored
  paths; text arrives UTF-8 with line counts and a truncation flag, images and binaries base64.
  Paths are resolved and contained per session, so traversal and cross-tenant ids answer `400`,
  `403` or `404` instead of leaking contents.
- Plugin UI slot `file.viewer`. Contributions declare `match.extensions` and receive a bounded
  `context.file` projection; the console keeps its built-in preview on a **Source** tab, so a
  plugin can add a table or diagram view without hiding the raw file. The new
  `examples/plugins/csv-viewer` demonstrates quoted-cell parsing and table rendering.
- Plugin UI slots `message.after` and `composer.actions`. Message contributions declare `match`
  (`roles`, `toolNames`), receive a projection without image bytes, and mount once per matching
  message; composer contributions receive `context.composer.submit(text)` and can propose a turn
  without touching the API token. The bridge requires `web.capabilities: ["composer.submit"]`, so
  a read-only bundle cannot start runs. The example metrics bundle and docs show both.
- Tool results can carry images. The runtime persists them on the tool message (with an `isError`
  flag), forwards them in `tool.finished`, sanitises plugin output (PNG/JPEG/WebP/GIF, 6 images,
  4 MB each, 12 MB total) and feeds them to models: Anthropic embeds them in `tool_result`, while
  OpenAI-compatible endpoints receive them on the next user turn. The console renders them in the
  tool card, including after a reload.
- `browser_screenshot` accepts `include_image`, `format` (`png`/`jpeg`) and `quality`, and attaches
  the captured bytes to the result for vision models.
- Skill authoring: `kestrel skills lint` validates every candidate file — missing `SKILL.md`,
  invalid or duplicate names, empty bodies, escaping symlinks, oversized files and frontmatter
  drift — with `--json` output and exit code `1` on errors. `kestrel skills new` scaffolds a
  kebab-cased `skills/<name>/SKILL.md` and never overwrites an existing one. The checks live in
  `@kestrel/plugin-skills` as `lintSkills` and `scaffoldSkill`.
- `@kestrel/plugin-browser`: nine headless-Chromium tools (`browser_open`, `browser_snapshot`,
  `browser_click`, `browser_type`, `browser_scroll`, `browser_wait_for`, `browser_back`,
  `browser_screenshot`, `browser_close`) plus a `browser` service for other plugins. It speaks Chrome DevTools Protocol
  directly over Node's WebSocket, so no Playwright dependency or browser download is needed; the
  executable is auto-detected and `browser_open` follows the `ask` policy. Snapshots expose body
  text and numbered interactive elements with password values omitted, every mutating call returns
  a fresh snapshot, and screenshots stay inside the workspace. Container defaults add
  `--no-sandbox` when user namespaces are unavailable.
- Sandboxed plugin UI: browser bundles now run in iframes with an opaque origin, served as
  `/plugin-sandbox.html`. A discovery pass records slots, each extension mounts in its own
  auto-sized frame, and API calls go through a postMessage proxy so the token never enters plugin
  code. CSP blocks direct network access; the console copies its CSS variables into the frame.
- Plugin UI API grants: `web.api` lists `"METHOD /api/path"` patterns (`*` one segment, `**` the
  rest). The proxy defaults to read-only `/api/**`, treats `[]` as deny-all, rejects `.`/`..`
  traversal, and answers unlisted calls with an error instead of forwarding them.
- MCP sampling: with `@kestrel/plugin-mcp` `sampling.enabled`, the client advertises the capability,
  answers `sampling/createMessage` from the model registry (hints, token ceiling, request budget)
  over stdio and streamable HTTP, and forwards the tool call's abort signal. Tool calls to one
  server are serialized so concurrent sessions cannot misattribute a sampling request.
- Transcript rewind: `POST /api/sessions/:id/rewind` drops a user message and everything after it,
  then restores the checkpoint taken just before that message. `session.rewound` carries the
  surviving transcript; the console adds a rewind button on user messages and the CLI a
  `kestrel sessions rewind` command. Snapshots now record the `messageId` they precede.

- Retry policy for transient model failures: adapters classify errors as retryable, the runtime
  retries with jittered exponential backoff, honours `Retry-After`, never replays streamed output
  and announces each retry as a `notice`. Configure with `agent.retry`.
- `@kestrel/plugin-anthropic`: native Messages API provider with streaming text, extended thinking,
  tool use, images, usage accounting and proxy-friendly `baseUrl` handling.
- Session guards: `SessionManager.addGuard()` lets a plugin veto session creation and run launches.
  A rejected action throws `SessionGuardError`, which the HTTP server reports as `429` with
  `Retry-After` and the CLI prints verbatim. Guards run before the transcript is touched.
- `@kestrel/plugin-quota`: per-tenant `maxSessions`, `maxConcurrentRuns` and `maxTokens` limits, plus
  `GET /api/quotas` and a `quotas` service.
- `@kestrel/plugin-metrics`: in-process counters, gauges and summaries with
  `GET /api/metrics` (JSON) and `GET /api/metrics/prometheus` (text) for administrators. A `metrics`
  service lets other plugins publish their own series, including scrape-time collectors.
- Plugin routes may return a literal `raw` body with custom headers, so text formats such as
  Prometheus exposition do not need a JSON wrapper.
- MCP resources and prompts: servers that support them now contribute
  `mcp__<server>__{list,read}_resource` and `mcp__<server>__{list,get}_prompt` tools, and the `mcp`
  service exposes `resources()`, `prompts()`, `readResource()` and `getPrompt()` for plugin-to-plugin
  use.
- Resumable runs: a session persisted as `running` becomes `interrupted` on boot, and
  `POST /api/sessions/:id/resume` (or `kestrel sessions resume <id>`, or the console's Resume
  button) re-enters the loop from the stored transcript. Pending tool calls are answered with an
  error result instead of being replayed.
- SQLite session store: `storage.driver: "sqlite"` keeps transcripts and summaries in one WAL
  database via the built-in `node:sqlite`, with the same `SessionStore` contract as the JSON store.
- Accounts and tenants: `auth.mode: "accounts"` adds per-user bearer tokens, `admin`/`member` roles
  and tenant isolation for sessions, storage, workspaces and event streams. `none` and `token` keep
  the single-operator behaviour and remain the default.
- `kestrel users` and `kestrel tenants`: create, list, rotate and delete accounts from the host that
  owns the data directory.
- HTTP management: `GET /api/auth/me`, `/api/users`, `/api/users/:id/token`, `/api/tenants`.
- Console: sign-in screen for `401`, and an Account section showing the current user, role and
  tenant.
- Config: `auth.mode`, `auth.bootstrapToken`, `auth.bootstrapName`, `auth.workspaces`; env
  `KESTREL_AUTH_MODE`, `KESTREL_BOOTSTRAP_TOKEN`.
- Session summaries carry `tenantId` for non-default tenants.
- Plugin UI contributions: a manifest's `web` entry (string or `{ entry, css }`) is served from the
  plugin's `web/` directory at `/plugins/:id/*` for active plugins only. The console imports each
  bundle and mounts its extensions into `sidebar.footer`, `session.header` and `settings.section`
  slots; token-bearing requests go through a console helper, and failures are isolated per plugin.
- `examples/plugins/web-metrics`: an example plugin with a browser bundle.
- Workspace checkpoints: a shadow git repository per workspace snapshots files before every turn
  and before each `kestrel run`/`chat` message. `GET`/`POST /api/sessions/:id/checkpoints` lists and
  captures snapshots; `POST .../checkpoints/:id/restore` rewinds after taking a safety snapshot.
  Ignored files are preserved, workspace `.gitignore` is honoured, and snapshots are serialized per
  workspace.
- `kestrel checkpoints list|create|restore` and a checkpoint drawer in the console.
- Config: `checkpoints.enabled`, `checkpoints.maxFiles`, `checkpoints.exclude`; env
  `KESTREL_CHECKPOINTS`, `KESTREL_CHECKPOINTS_MAX_FILES`.
- Storage: `SqliteSessionStore` using Node's built-in `node:sqlite` keeps every transcript in one
  WAL database, with summary columns so listing never parses a session. Enabled with
  `storage.driver: "sqlite"` or `KESTREL_STORAGE_DRIVER=sqlite`; the store is closed on shutdown.
- Multimodal input: user messages may carry up to six images (PNG, JPEG, WebP, GIF). The console
  offers paperclip, paste and drag-and-drop with client-side downscaling; the HTTP API validates and
  strips `data:` prefixes; the OpenAI-compatible provider emits `image_url` content parts, and the
  token estimator charges images against the context window.
- MCP: streamable HTTP transport alongside stdio, with `Mcp-Session-Id` handling, automatic
  re-initialization on expiry, `${ENV_VAR}` expansion in headers and a transport-neutral
  `McpClient` interface. Config reference and a dedicated guide added.
- Context compaction: once an estimated prompt crosses `agent.compaction.threshold` of the model
  window, the oldest turns are replaced by a model-written summary, keeping tool call/result pairs
  intact. Emits `context.compacted`; the console refetches the transcript. A failed summarizer call
  leaves history untouched.

### Changed

- Browser pages are session-scoped: each session gets its own browser process, cookies and refs,
  created lazily and evicted after `idleMs` (15 minutes by default). Other plugins call
  `browser.page(sessionId)`; `closeAll()` still runs on plugin disposal.

- `SessionStore` paths and `SessionManager.create()` are tenant-aware; the default tenant keeps the
  v0.1 `<data>/sessions` layout, so existing data directories need no migration.

- `delegate_many`: fan-out delegation. Up to `maxFanOut` independent tasks run concurrently under the
  same per-parent budget as `delegate`; excess tasks queue and are dropped if the parent is cancelled.
  Results are returned in request order with per-task status, timing, usage and session id.
- `DelegationGate`: a FIFO, abort-aware semaphore that owns concurrency policy for every delegation
  tool, keyed by parent session.
- `subagents.concurrency(parentId)` on the plugin service reports `{ limit, active, queued }`.
- Config: `maxFanOut` (6) and `maxBatchResultChars` (40000); `maxConcurrent: 0` now means unbounded.

### Changed

- The subagents plugin is split into `gate`, `run` and `tools` modules so the execution policy is
  testable without a session, and both tools share one runner.
- `toolAllowlist` now adds both delegation tools while depth remains.

## [0.1.0] - 2026-10-17

The first release. Kestrel is a plugin-first agent platform: a small agent core, a dependency-aware
plugin host, and every capability above that — tools, prompts, models, skills, delegation — supplied
by plugins that can be added, removed or composed at runtime.

### Added

**Platform**

- `@kestrel/kernel`: dependency-aware plugin host with `inject`, effect scopes, disposal, reload and
  a typed service registry (`ServiceMap` declaration merging).
- `@kestrel/protocol`: shared wire types for sessions, messages, tools, approvals, usage and SSE
  events, plus a versioned protocol handshake.
- HTTP/SSE server: sessions, streaming events with `Last-EventID` replay, approvals, plugin
  inspection, bootstrap and health endpoints, bearer-token auth and static web serving.
- File-backed session persistence (`sessions/<id>/session.json`) with serialized, atomic writes and
  a shutdown `flush()` barrier; in-memory store for tests.

**Agent runtime**

- Streaming agent loop with tool calls, per-session step budget, cancellation and usage accounting.
- Approvals: tools may require confirmation; requests surface as events and resolve through the API.
- Prompt pipeline: identity and context are layers, so plugins change behaviour without forking the
  loop.
- OpenAI-compatible provider (`@kestrel/plugin-openai`) covering OpenAI, DeepSeek, vLLM, Ollama and
  other `/v1` endpoints.
- Core tools (`@kestrel/plugin-tools-core`): file read/write/edit, directory listing, glob, grep,
  shell, fetch and todo tracking.

**Delegation (`@kestrel/plugin-subagents`)**

- `delegate` tool: runs one scoped task in a child session with an isolated transcript, its own step
  budget and a filtered tool allowlist; returns a single final report.
- Roles (`general`, `researcher`, `reviewer`, `implementer`) with instructions, model and tool
  overrides; user configuration extends built-in roles instead of replacing them.
- Bounded recursion via `maxDepth`, enforced both in the tool and in the child's allowlist, plus
  concurrency, wall-clock and result-size limits.
- Subagents are ordinary sessions: persisted with `parentId` / `depth` / `role`, visible in the API,
  the console (indented, role chip) and `kestrel sessions`.
- `subagents` service (`roles()`, `running()`) for dashboards and policy plugins.
- Approval-requiring tools are withheld from subagents by default, because a child's approval prompt
  belongs to a session the human may not be watching.

**Skills (`@kestrel/plugin-skills`)**

- Workspace skill discovery (`.kestrel/skills/`, `skills/`) with progressive loading: the prompt
  carries only names and descriptions, and `use_skill` loads a body on demand.
- `kestrel skills [show <name>] [--json]` for inspecting what the agent can load.

**Clients and samples**

- Web console (React + Vite): session list with delegation tree, streaming transcript, tool calls,
  approvals, model picker, plugin status; installable as a PWA shell.
- CLI (`kestrel`): `serve`, `chat`, `run`, `sessions`, `skills`, `plugins`, `doctor`; streams events
  in the terminal and falls back to the completed message for non-streaming providers.
- Example plugins (`echo-model`, `clock-tool`) used by the offline demo and the test suite.

**Operations**

- Dockerfile (multi-stage, non-root), `compose.yaml`, and Kubernetes manifests (Deployment, Service,
  PVC, ConfigMap, Secret example, probes) under `deploy/`.
- Configuration via file, environment and CLI flags with documented precedence.
- VitePress documentation site: concepts, guides (plugins, tools, skills, subagents, protocol, CLI,
  web console, deployment) and reference pages.

### Security

- All filesystem tools are rooted at the session workspace; path escapes are rejected.
- Shell execution is approval-gated and never inherits the server's environment blindly.
- Tool output is treated as untrusted data in the prompt.
- Server binds to loopback by default; a token is required for non-loopback access.
