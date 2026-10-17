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
- Token usage is cumulative per session in `AgentSession._usage`; it is updated right after every
  model and compaction response (not in `finally`) so the final `session.updated` and persisted
  `detail()` already include the run that just finished. `SessionManager.sessionOptions` must
  forward `usage` on restore or histories reload with zero tokens.
- Triggers (`plugins/triggers`) are in-process: cron uses five UTC fields with OR semantics for
  day-of-month/day-of-week, fires at most once per minute, skips overlapping runs and never catches
  up after downtime. Webhook secrets expand `${ENV}`; a public hook without a secret is refused.

