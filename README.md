# Kestrel

**A plugin-first agent platform. Run agents anywhere, drive them from anywhere.**

Kestrel is a TypeScript platform for running coding agents as a long-lived service. A small kernel
provides services, lifetimes and events. A headless agent runtime provides sessions, runs, tools and
approvals. A plugin host composes capabilities on top. The browser console, CLI and any future
client speak one small HTTP + SSE protocol — so the machine that runs the agent and the machine that
manages it do not have to be the same.

```
┌──────────── clients ────────────┐      ┌───────────────────── server ─────────────────────┐
│ web console · CLI · desktop ·   │ HTTP │  @kestrel/server  (REST + SSE, auth, static UI)  │
│ mobile · your integration       │◄────►│  @kestrel/agent   (sessions, runs, approvals)    │
└─────────────────────────────────┘      │  @kestrel/kernel  (services, scopes, events)     │
                                         │  plugins: providers · tools · context · memory · MCP       │
                                         └──────────────────────────────────────────────────┘
```

## Why another agent platform

Most agent projects begin as a chat loop and grow a UI, a provider abstraction and a plugin system
later. Kestrel begins with the seams:

- **Everything above the kernel is a plugin.** Model providers, filesystem and shell tools, memory,
  MCP bridges, and your own capabilities all register through the same contract. Plugins receive an
  isolated context; every registration is disposed when the plugin unloads.
- **The agent is a library, not a web app.** `@kestrel/agent` has no HTTP, no CLI and no browser
  code. The server and CLI are adapters over the same runtime.
- **The wire is the API boundary.** JSON over HTTP plus Server-Sent Events. Any language that can
  open a connection can drive an agent; desktop, web and mobile become packaging choices.
- **Lifetimes are explicit.** Services, listeners, timers, child processes and child plugins unwind
  in reverse order. Unloading a plugin is a supported operation, not a restart.
- **Failure is local.** A plugin that throws is marked `error`; dependents wait, everything else
  keeps running. Dependency cycles are reported instead of deadlocking the host.

The design borrows the service-and-injection kernel from Cordis / DeepSeek Harness, the
session/run and approval model from OpenHands-style runtimes, and the "small protocol, many
implementations" discipline of LSP and Unix. See [Inspirations](docs/guide/introduction.md#inspirations-and-what-we-changed)
for what changed and why.

## Features

| Area | What is here |
| --- | --- |
| Kernel | Typed service registry, dependency injection, scoped disposal, lifecycle events, structured logging |
| Plugins | Manifest discovery, dependency ordering, config merge, isolated contexts, error isolation |
| Agent | Multi-session runtime, streaming text and reasoning, tool loop, cancellation, step limits, persistence |
| Tools | Filesystem (read/write/edit/list/glob/grep), glob/grep, shell with approvals, HTTP fetch, todos, finish |
| Context | Ordered prompt layers; `AGENTS.md` and rule files loaded by a plugin; workspace skills loaded on demand |
| Models | OpenAI-compatible provider: OpenAI, DeepSeek, vLLM, Ollama and other `/v1` endpoints |
| Delegation | Subagent sessions with isolated context, roles, tool allowlists and bounded depth |
| Integrations | Memory tools and a Model Context Protocol bridge |
| Server | REST, SSE with resume, bearer auth, CORS, static console hosting, security headers |
| Clients | Installable PWA console (sessions, streaming markdown, tool cards, approvals, plugins) and a full CLI |
| Ops | Docker, Compose, Kubernetes, systemd, launchd, Windows Task Scheduler, health probes |

**Status: `0.1`, foundation-first.** The interfaces documented here are the ones intended to stay
stable. The roadmap lists what is missing before `1.0`; multi-process operation and sandboxed
execution are explicitly not done yet.

## Quickstart

Requirements: Node.js 22+, pnpm 9 (`corepack enable`).

```bash
pnpm install
pnpm build
```

### Run offline, with no API key

The bundled `echo` model and `clock` tool demonstrate the plugin contract end to end:

```bash
KESTREL_PLUGINS=plugins,examples/plugins KESTREL_MODEL=echo \
  node apps/cli/dist/index.js run "What time is it?"
```

### Run with a real model

```bash
export OPENAI_API_KEY=sk-...
node apps/cli/dist/index.js run "Summarise this repository and propose one improvement"
```

Any OpenAI-compatible endpoint works:

```json
{
  "model": { "default": "deepseek-chat" },
  "plugins": {
    "config": {
      "@kestrel/plugin-openai": {
        "baseUrl": "https://api.deepseek.com/v1",
        "apiKeyEnv": "DEEPSEEK_API_KEY",
        "provider": "deepseek",
        "models": ["deepseek-chat", "deepseek-reasoner"]
      }
    }
  }
}
```

### Run the server and console

```bash
pnpm build:web
KESTREL_TOKEN="$(openssl rand -hex 24)" pnpm start
# open http://127.0.0.1:7331 and paste the token
```

Development mode: `pnpm dev` (server on `:7331`) and `pnpm dev:web` (Vite on `:5173`, proxying
`/api`).

### CLI

```bash
kestrel serve [--host H] [--port P] [--token T]
kestrel run <prompt...> [--model M] [--workspace DIR] [--json]
kestrel chat  [--model M] [--workspace DIR]
kestrel plugins | models | sessions
kestrel skills [show <name>]
```

`run` exits `0` on completion, `1` on failure and `2` on invalid arguments. `chat` supports `/new`,
`/cancel`, `/help` and `/exit`.

## Writing a plugin

A plugin is a directory with a manifest and an entry module. It can register services, tools,
models, event listeners or other plugins.

```json
{
  "name": "@acme/plugin-clock",
  "version": "0.1.0",
  "entry": "index.js",
  "inject": ["tools"]
}
```

```js
export default {
  name: "@acme/plugin-clock",
  version: "0.1.0",
  inject: ["tools"],
  apply(context) {
    const tools = context.get("tools");
    context.effect(() =>
      tools.register({
        schema: {
          name: "clock",
          description: "Return the current time in ISO 8601.",
          category: "example",
          permission: "auto",
          parameters: { type: "object", properties: {} },
        },
        execute: () => ({ content: new Date().toISOString() }),
      }),
    );
  },
};
```

Drop the directory into `plugins/`, restart, and the tool appears in `/api/bootstrap` and in the
console. `context.effect` ties the registration to the plugin's lifetime; unloading the plugin
removes the tool and any listeners it added.

Continue with [Writing a plugin](docs/guide/writing-plugins.md) and the
[plugin system](docs/guide/plugin-system.md).

## Repository layout

```
packages/kernel        services, contexts, scopes, plugin definitions
packages/protocol      wire types shared by every client
packages/agent         sessions, registries, run loop, stores
packages/plugin-host   discovery, manifests, dependency graph
apps/server            HTTP + SSE adapter and composition root
apps/cli               terminal client
apps/web               browser console (React + Vite)
plugins/*              first-party extensions: openai, tools-core, memory, mcp
examples/plugins/*     minimal annotated plugins (echo model, clock tool)
deploy/*               Docker, Compose, Kubernetes, systemd, launchd, Windows
docs/                  VitePress documentation site
```

## Deployment

| Target | Entry point |
| --- | --- |
| Local | `node apps/server/dist/bin.js` |
| Docker | `docker build -t kestrel . && docker run -p 127.0.0.1:7331:7331 kestrel` |
| Compose | `docker compose up -d --build` |
| Kubernetes | `kubectl apply -k deploy/k8s` |
| Linux service | `deploy/systemd/kestrel.service` |
| macOS | `deploy/launchd/dev.kestrel.agent.plist` |
| Windows | `deploy/windows/install-task.ps1` |

The Kubernetes base runs one replica on purpose: sessions, the replay buffer and approvals are
process-local. The [deployment guide](docs/guide/deployment.md) explains the constraints, SSE proxy
settings and backup layout.

## Security

An agent with a shell is remote execution with a model in front of it. Kestrel defaults to binding
`127.0.0.1` and asking before shell or network access, but plugins run in-process and the shell is
not sandboxed. Read the [security model](docs/guide/security.md) before exposing an instance. Set a
token, use a container with only the workspace mounted, and review third-party plugins.

## Documentation

The full documentation lives in [`docs/`](docs/index.md) and builds with VitePress:

```bash
pnpm docs:dev
pnpm docs:build
```

- [Introduction](docs/guide/introduction.md) · [Quickstart](docs/guide/getting-started.md)
- [Architecture](docs/guide/architecture.md) · [Plugin system](docs/guide/plugin-system.md)
- [Tools](docs/guide/tools.md) · [Models](docs/guide/models.md) · [Protocol](docs/guide/protocol.md)
- [CLI](docs/guide/cli.md) · [Web console](docs/guide/web-console.md) · [Example plugins](docs/guide/examples.md)
- [Deployment](docs/guide/deployment.md) · [Security](docs/guide/security.md) · [Roadmap](docs/guide/roadmap.md)
- [Configuration](docs/reference/config.md) · [Kernel API](docs/reference/kernel.md) · [Plugin API](docs/reference/plugins.md)

## Contributing

Issues and pull requests are welcome. Start with [Contributing](docs/contributing.md); for a
security report, follow the private process in [Security](docs/guide/security.md#reporting-a-vulnerability).

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm docs:build
```

## Licence

MIT. See [LICENSE](LICENSE).
