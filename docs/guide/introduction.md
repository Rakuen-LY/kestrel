# Introduction

Kestrel is an agent platform for people who intend to keep it running.

Most agent projects start as a chat loop with tools and grow a UI around it. That works until you
need a second model provider, a different transport, a sandbox, or a client on a phone. Kestrel
starts from the other end: a small kernel that knows about services and lifetimes, an agent runtime
that knows about sessions and runs, and a plugin host that knows how to compose both. Everything
else — including the tools that edit your files — is an extension.

## Design principles

### 1. Everything is a plugin

Above the kernel, capability is assembled from plugins: providers, tools, prompt context, memory and integrations
all register through the same contract. A plugin is a named object with a version, an optional list
of required plugins, a list of service keys it injects, and an `apply` function. It receives an
isolated child context. Whatever it registers — services, listeners, timers, child plugins — is
disposed when the plugin goes away.

This is the same idea that makes Cordis-based systems (and DeepSeek's Harness work) pleasant to
extend: composition happens through dependency injection, not through a registry of hard-coded
imports. Kestrel adopts that model and makes the service surface explicit and typed.

### 2. The runtime is a library

`@kestrel/agent` has no HTTP server, no CLI and no browser code. It can be embedded in a script, a
worker, a desktop application or a server process. The server is a thin adapter: it validates JSON,
maps errors to status codes, and forwards events. The CLI is another adapter with the same runtime.

### 3. Explicit lifetimes

A process that runs for weeks will load and unload plugins. Kestrel treats teardown as a first-class
operation: every registration returns a disposer, contexts own scopes, and scopes unwind in reverse
order. Plugin replacement is expected behaviour, not a restart.

### 4. Failure is local

A plugin that throws during `apply` is marked `error` and isolated. Its dependents wait; unrelated
plugins keep running. Dependency cycles are detected and reported instead of deadlocking the host.

### 5. The wire is the API boundary

Clients speak JSON over HTTP and Server-Sent Events. There is no private socket protocol and no
framework-specific RPC. Any language with an HTTP client can drive an agent. This is what makes
"desktop, web, mobile" a packaging question rather than a rewrite.

## What ships today

| Layer | Package | Responsibility |
| --- | --- | --- |
| Kernel | `@kestrel/kernel` | contexts, services, events, scopes, plugin lifecycle, logging |
| Protocol | `@kestrel/protocol` | shared types for events, sessions, tools, models |
| Runtime | `@kestrel/agent` | model and tool registries, sessions, runs, persistence, approvals |
| Plugin host | `@kestrel/plugin-host` | discovery, manifests, dependency ordering, configuration |
| Transport | `@kestrel/server` | REST, SSE, static console, auth, CORS |
| Clients | `@kestrel/cli`, `@kestrel/web` | terminal and browser interfaces |
| Extensions | `plugins/*` | OpenAI-compatible models, filesystem and shell tools, workspace context, memory, MCP |

The platform is at an early `0.x` stage. The interfaces documented here are the ones we intend to
keep stable; see the [roadmap](/guide/roadmap) for what is still missing before `1.0`.

## Inspirations, and what we changed

- **Cordis / DeepSeek Harness** — the service-and-injection kernel, and the idea that plugins are
  the unit of everything. Kestrel adds an application-wide service registry for plugin
  contributions, a stricter disposal story, and a manifest format that works without a bundler.
- **OpenHands and similar agent runtimes** — the session/run model, tool approval, workspace
  confinement. Kestrel keeps the runtime headless and pushes presentation into clients.
- **Unix and LSP** — small protocols with many implementations. We resisted embedding a web
  framework in the core for the same reason.

## Who this is for

- Teams that want an agent they can host themselves, on infrastructure they already run.
- Tool authors who want to add capability without forking the agent.
- Client authors who want a stable event stream rather than a private SDK.
- People who care more about the next two years of maintenance than the next two weeks of demo.
