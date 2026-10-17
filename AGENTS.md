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
