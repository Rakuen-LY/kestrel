# Repository guide

Kestrel is a pnpm + TypeScript (ESM, Node 22) monorepo for a plugin-first agent platform.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm build` | Build every workspace in dependency order. |
| `pnpm typecheck` | `tsc --noEmit` for every package and app. |
| `pnpm lint` | oxlint over packages/apps/plugins. |
| `pnpm test` | Vitest, single run (packages, apps and plugins). |
| `pnpm dev` / `pnpm dev:web` | Server (`:7331`) and Vite console (`:5173`). |
| `pnpm docs:dev` / `pnpm docs:build` | VitePress site in `docs/`. |
| `node apps/cli/dist/index.js run "..."` | Run the agent once after building. |
| `node apps/cli/dist/index.js skills` | List workspace skills (`show <name>` for a body). |
| `node apps/server/dist/bin.js` | Start the HTTP server after building. |

## Architecture invariants

- `packages/kernel` is pure: no network, filesystem or framework dependencies.
- Every registration returns a disposer; long-lived work goes inside `context.effect` or
  `context.inject` so it unwinds with the plugin.
- Services are injected, not imported globally. New capability means a new service or tool.
- The system prompt is composed by `PromptPipeline` layers registered through the `prompts`
  service. Context sources (workspace files, policies, skills) belong in plugins, not in
  `SessionManager`.
- `packages/agent` must not import the server, CLI, browser or a specific HTTP framework.
- Workspace skills are discovered by `@kestrel/plugin-skills`, never by the agent loop. Prompt
  layers list them; the `use_skill` tool loads bodies on demand.
- CLI output must work for streaming and non-streaming models: `message.completed` is printed when
  no `message.delta` was emitted for that message.
- `packages/protocol` is data-only and dependency-free; all clients compile against it.
- Relative imports use `.js` extensions (Node ESM).
- Plugins live in `plugins/<name>/` with `kestrel.plugin.json`; examples in `examples/plugins/`.

## Runtime composition

`apps/server/src/runtime.ts` is the composition root: config → kernel context → registries →
`SessionManager` → `PluginHost.loadAll()` → HTTP server. The HTTP layer only translates protocol and
never contains agent logic.

## Docs

- `docs/` is the public site (VitePress). All documentation is English.
- Reference pages must match the source; read the implementation before editing them.
- Mermaid fences are rendered by `docs/.vitepress/theme/MermaidDiagram.vue`.
- Adding a page requires a sidebar entry in `docs/.vitepress/config.mts`.

## Testing notes

- The offline demo uses `examples/plugins/echo-model` and `examples/plugins/clock-tool`.
- `@kestrel/testkit` exposes `ScriptedModel` for deterministic runs.
- Prefer real registries and contexts over mocks; most packages are pure enough to test directly.

## Delegation

- `@kestrel/plugin-subagents` owns `delegate`, `delegate_many` and the `subagents` service. Session
  provenance lives in the agent core (`parentId`, `depth`, `role`), not in the plugin, so HTTP,
  persistence and the console all see it without special cases.
- Concurrency policy lives in one `DelegationGate` (`plugins/subagents/src/gate.ts`), keyed by parent
  session. Both tools acquire from it, so a batch cannot exceed `maxConcurrent` even when a single
  delegation is also in flight. Queued tasks create their session only when granted a slot.
- A subagent shares the workspace and tool registry but not the transcript. Its prompt is framed by
  `subagentSystemPrompt`; its tools are an allowlist computed at creation time.
- Tools with permission `ask` are excluded from subagents by default, because nobody is watching the
  child session's approval queue. `exposeApprovalTools` overrides this deliberately.
- Depth is enforced twice: the tools check `session.depth`, and both delegation tools are stripped
  from the child's allowlist when no depth remains.
- `delegate_many` reports a partially failed batch as a non-error result; only a fully failed batch
  sets `isError`. Clients should read `data.counts` / `data.results` rather than parse prose.
- `AgentSession.callModel` races the provider call against the abort signal; a hung provider must not
  leave a session stuck in `running`.

- Authentication is a server concern, not a plugin: `apps/server/src/auth.ts` owns modes, users,
  tenants and token hashing. The plugin context never sees credentials. Keep it that way.
- Tenant scoping is applied at the HTTP edge (`principal.tenantId`) and carried by
  `AgentSession.tenantId`; subagents inherit it in `SessionManager.createSubagent`. Anything that
  creates a session outside the manager must set `tenantId` explicitly.
- `FileSessionStore` maps the default tenant to the v0.1 `<data>/sessions` path and other tenants to
  `<data>/tenants/<id>/sessions`. Do not "tidy" this into a uniform layout without a migration.
- Cross-tenant reads answer `404`, not `403`, so ids cannot be enumerated. Keep that convention for
  new session routes.

## Gotchas

- `apps/server/src/main.ts` exports `main()`; only `src/bin.ts` is an executable entry. Do not add a
  `pathToFileURL` self-start guard to `main.ts` — the CLI imports it and would boot twice.
- Session status is part of the persisted document. `SessionManager.initialize()` rewrites
  `running` to `interrupted`; `AgentSession.resume()` requires that status (or `error`) and answers
  orphaned tool calls with an error result rather than executing them again. Do not "helpfully"
  replay pending tools.
- `FileSessionStore` writes `sessions/<id>/session.json`; sessions are not safe for multi-process
  writers. `SessionManager.close()` calls `store.flush()`, so shutdown cannot race an in-flight
  write — keep that barrier when adding a store.
- SSE replay only happens when `Last-Event-ID` is present; first connections fetch history via
  `GET /api/sessions/:id`.
- Event, session and approval state are process-local; run one server replica.
- `server.token` empty disables authentication; `/api/health` and static files are always public.
- Accounts mode fails fast when there are no users: bootstrap with `KESTREL_BOOTSTRAP_TOKEN` or
  `kestrel users create`. Tokens are hashed with SHA-256 and never recoverable; rotate instead.
- The web console is served from `apps/web/dist` (config `server.webRoot`); without it the server
  returns a small JSON notice at `/`.
- Checkpoints (`apps/server/src/checkpoints.ts`) are workspace-level, backed by a shadow git repo at
  `<data>/checkpoints/<sha1(workspace)>/repo.git`. Never point it at the workspace's own `.git`.
  `snapshotUnlocked` is called by `restore` inside the same per-workspace queue; calling the public
  `snapshot()` there would deadlock. Restores use `reset --hard` + `clean -fd` (no `-x`) so ignored
  files such as `node_modules/` survive.
- A checkpoint failure must never fail a run: both HTTP and CLI wrap snapshots in try/catch and log.
- Context compaction (`AgentSession.maybeCompact`) runs inside the step loop, before the model call.
  The cut must land on a `user` message so tool calls never separate from results, and it must stay
  above 25% of *conversation* tokens (not total prompt, which includes the large system prompt) to
  avoid one summary call per step. Failures and empty summaries leave history untouched; a run must
  never fail because compaction did. The console refetches on `context.compacted` because history is
  rewritten server-side.
- MCP (`plugins/mcp`) has two transports behind one `McpClient` interface: stdio (NDJSON over a
  child process) and streamable HTTP (POST answering JSON or SSE). HTTP keeps `Mcp-Session-Id` and
  re-initializes once on `404`/`410`; `${ENV_VAR}` in headers expands and empty headers are dropped
  so a missing token fails instead of sending `Authorization: `. Tool names are
  `mcp__<server>__<tool>`; a failing server is logged and skipped, never fatal.
- Image attachments travel as base64 inside the message (`ImageAttachment`), never as URLs the
  server must fetch. The server enforces 6 images / 4 MB each / 12 MB total and strips `data:`
  prefixes; the browser downscales photographs to a 1568 px edge but leaves GIFs alone. Providers
  that support vision serialize user parts; text-only messages remain plain strings so endpoints
  without parts keep working. `estimateTokens` charges 1100 tokens per image, and the compaction
  transcript renders image names only — never base64.
- Tool results may carry images too. `ToolExecutionResult.images` is sanitised by
  `packages/agent/src/images.ts` (same budgets, note appended on drops), persisted on the tool
  message with `isError`, emitted in `tool.finished`, and restored into the console's `toolRuns`
  when a session is reloaded. Anthropic embeds them in `tool_result`; OpenAI-compatible adapters
  move them to the next user turn or a synthetic user message after a trailing tool batch.
- Two session stores exist: `FileSessionStore` (one JSON document per session, the default) and
  `SqliteSessionStore` (single WAL database at `<data>/kestrel.db`, opt in with
  `storage.driver: "sqlite"`). They do not share data. Both are single-process stores; the SQLite
  one uses Node's built-in `node:sqlite`, so it needs no native toolchain. Store lifecycle hooks are
  optional (`flush?`, `close?`) and `SessionManager.close()` invokes both.
- Plugin HTTP routes (`apps/server/src/plugin-http.ts`) match exact segments plus `:name`, live
  under `/api/`, and are dispatched after auth unless `public: true` — public handlers must check
  their own secret and run before token auth by design. Duplicate method/path registration throws.
- The Docker sandbox fails closed: if Docker is unavailable the `shell` tool errors instead of
  silently running on the host. Only `shell` is routed through `sandbox`; filesystem tools still run
  in the server process, so the workspace remains the trust boundary. Containers mount the session
  workspace read-write at the same absolute path, run with the server UID on POSIX, and default to
  `--network none`. Killing the Docker CLI does not stop a container, so timeouts and aborts run
  `docker rm -f <name>` as well.
- Guards are synchronous and must stay O(in-memory state); the runtime calls them from `create()`
  and from `start()`/`resume()` before mutating the transcript. Only `SessionGuardError` maps to 429;
  anything else is a 500 on purpose. Guard errors are detected structurally (`name` + `code`)
  because plugin bundles can carry a second copy of `@kestrel/agent`.
- Metrics are memory-only and must stay low-cardinality; never label by session or user id. The
  plugin exposes one shared `MetricRegistry` through the `metrics` service, and summaries are stored
  as `__sum__`/`__count__` series folded back at snapshot time.
- Audit logs hash tool arguments and never store output. Listener writes are queued; tests read
  through the route handler (which awaits the queue) instead of racing the file. The plugin needs
  the `storage` service, so keep it injected in `kestrel.plugin.json` and provide it in any test
  harness that applies the plugin directly.
- Token usage is cumulative per session in `AgentSession._usage`; it is updated right after every
  model and compaction response (not in `finally`) so the final `session.updated` and persisted
  `detail()` already include the run that just finished. `SessionManager.sessionOptions` must
  forward `usage` on restore or histories reload with zero tokens.
- Triggers (`plugins/triggers`) are in-process: cron uses five UTC fields with OR semantics for
  day-of-month/day-of-week, fires at most once per minute, skips overlapping runs and never catches
  up after downtime. Webhook secrets expand `${ENV}`; a public hook without a secret is refused.
- Model failures are classified in the adapters, not the runtime: providers throw
  `ModelRequestError` from `@kestrel/agent` (built with `modelHttpError()`/`modelNetworkError()`),
  and `AgentSession.callModel` retries only errors marked retryable. A retry is skipped once any
  delta has been forwarded, so clients never see duplicated text. Backoff is equal-jitter
  exponential; `Retry-After` wins but is capped by `maxDelayMs`. Retries surface as `notice` events.
- Plugins resolve `@kestrel/agent` through its `dist` exports map, not `src`. After adding or
  renaming anything exported from a package, rebuild that package (`pnpm build`) before smoke
  testing plugins, or module linking fails with "does not provide an export named ...".
- Rewind is split by design: `AgentSession.rewind()` only truncates and persists the transcript,
  while the HTTP layer restores the checkpoint whose `messageId` matches. `POST /messages` and the
  CLI generate the user message id before snapshotting and pass it to `start()`, which keeps the
  two halves linked without guessing from labels or timestamps. Only user messages are valid
  targets: truncating at a tool result would orphan an assistant `toolCalls` block. Restore happens
  after truncation, and a restore failure becomes a `warning` in a `200` response instead of
  rolling back the transcript.
- MCP sampling is a reverse JSON-RPC flow: servers send requests with an id on the same channel
  used for responses. Stdio answers by writing a JSON object; streamable HTTP answers with a new
  POST while the original SSE response stays open. The protocol carries no parent id, so
  `SamplingGate` serializes tool calls per client and scopes the handler and abort signal to one
  execution. Sampling is off by default, budgets completions (`maxTokens`) and requests per call,
  and never enters the transcript; the models service is resolved lazily so sampling-disabled
  installs need no model registry.
- Plugin UI bundles are untrusted: they run in `sandbox="allow-scripts"` iframes whose document is
  served by the API with an opaque origin. The parent is the only channel: discovery and mount
  messages, height reports, and proxied `request` calls. Never import bundles into the console
  origin; the bearer token lives only in the parent. Plugin CSS vars are copied on mount and on
  `prefers-color-scheme` changes. The console CSP needs `frame-src *` for cross-origin deployments.
- Plugin UI API calls are default-deny beyond read-only `GET /api/**`; `web.api` grants are checked
  in the parent proxy after URL normalisation, so never forward a raw plugin path without calling
  `apiAllowed` first. `api: []` means no API access at all.
- Browser tools live in `plugins/browser` and speak CDP over Node's built-in WebSocket; do not add
  Playwright/Puppeteer for this path. The controller serialises every call on one page, returns a
  snapshot from each mutating action, and defaults `--no-sandbox` only when running in a container
  without user namespaces. `browser_screenshot` writes a file and, with `include_image: true`,
  returns the bytes to the model; JPEG format and quality keep big pages affordable. Tests skip
  when no Chromium binary exists.
