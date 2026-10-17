---
layout: home

hero:
  name: Kestrel
  text: Everything is a plugin.
  tagline: A kernel, an agent runtime and a plugin host behind one small protocol. Run agents on any desktop OS or orchestration platform; drive them from a browser, desktop shell or phone.
  image:
    src: /icon.svg
    alt: Kestrel
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Read the architecture
      link: /guide/architecture

features:
  - title: Plugin-first, all the way down
    details: Models, tools, memory, MCP servers and user interfaces attach through the same lifecycle. A plugin can inject another plugin's service without importing its code.
  - title: Headless by design
    details: The agent runtime is a library. The HTTP/SSE server, CLI and web console are clients, so the same brain can run on a laptop, a Docker container or a Kubernetes pod.
  - title: Streaming, resumable sessions
    details: Every run emits typed events. Clients resume from the last event id, render tool calls live and approve risky actions out of band.
  - title: Delegation you can bound
    details: A parent hands one scoped task to a subagent with a fresh context, a role and a step budget. Depth, concurrency and wall clock are capped, and every child is a session you can inspect.
  - title: Boring where it matters
    details: No hidden globals, no implicit ordering. Services are explicit, disposers are tracked, and one broken plugin cannot take down the host.
---

## One runtime, many shapes

```bash
# Anywhere Node 22 runs
pnpm install && pnpm build
KESTREL_PLUGINS=plugins,examples/plugins node apps/server/dist/bin.js

# Or a container
docker build -t kestrel . && docker run --rm -p 7331:7331 -v "$PWD:/workspace" kestrel
```

The server exposes a small REST surface plus an event stream. The bundled console is a static
application: it can be served by the agent host, by a CDN, or wrapped by a desktop or mobile shell
without changing a line of agent code.

## What "plugin" means here

| Concern | Plugin | Contract |
| --- | --- | --- |
| Model access | `@kestrel/plugin-openai` | provides `models` |
| Filesystem and shell tools | `@kestrel/plugin-tools-core` | provides `tools` |
| Durable notes | `@kestrel/plugin-memory` | injects `tools`, provides `memory` |
| Model Context Protocol | `@kestrel/plugin-mcp` | injects `tools`, provides `mcp` |
| Skills | `@kestrel/plugin-skills` | injects `prompts`, `tools`, provides `skills` |
| Delegation | `@kestrel/plugin-subagents` | injects `sessions`, `tools`, `prompts`, provides `subagents` |
| Your product | anything in `plugins/` | whatever you declare |

There is no privileged core plugin. `tools-core` is simply the plugin that happens to ship with the
repository. Removing it yields an agent that can still talk, but cannot touch the workspace.

## Where to go next

- [Quickstart](/guide/getting-started) — run the server and console in five minutes.
- [Architecture](/guide/architecture) — how the kernel, runtime and transport fit together.
- [Writing a plugin](/guide/writing-plugins) — add a tool, a provider or a whole subsystem.
- [Protocol](/guide/protocol) — build a client in any language.
