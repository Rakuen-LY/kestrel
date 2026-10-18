# Model Context Protocol

The [Model Context Protocol](https://modelcontextprotocol.io) is how Kestrel borrows tools from other
processes: a database gateway, a browser driver, a ticketing system, a filesystem index. The bridge
is a plugin (`@kestrel/plugin-mcp`), so it follows the same lifecycle, configuration and approval
rules as the built-in tools.

It connects to MCP servers and exposes three of the protocol's primitives to the agent: tools,
resources and prompts. Sampling requests are bridged opt-in; elicitation is not.

## Transports

| Transport | Config | Use when |
| --- | --- | --- |
| stdio | `command`, `args`, `env`, `cwd` | The server runs on the same machine. No network, no port, no auth. |
| Streamable HTTP | `url`, `headers` | The server is remote or shared. One endpoint, JSON or SSE answers. |

A server must set exactly one of `command` and `url`; anything else is logged and skipped, and the
rest of the platform keeps starting.

```json
{
  "plugins": {
    "config": {
      "@kestrel/plugin-mcp": {
        "servers": {
          "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/srv/data"] },
          "docs": {
            "url": "https://mcp.example.com/mcp",
            "headers": { "Authorization": "Bearer ${DOCS_MCP_TOKEN}" },
            "approval": "auto"
          }
        }
      }
    }
  }
}
```

`${NAME}` in a header value is replaced with that environment variable. A header that resolves to
the empty string is dropped, so an unset token never turns into `Authorization: ` — the request
fails loudly instead of authenticating as nobody. Keep tokens in the environment, not in
`kestrel.config.json`.

## What the agent sees

Every discovered tool becomes a normal tool:

```json
{
  "name": "mcp__docs__search",
  "description": "[MCP:docs] Search the handbook",
  "category": "mcp",
  "permission": "ask"
}
```

The tool name is prefixed and sanitised (`[^A-Za-z0-9_-]` becomes `_`), so two servers can both
expose `search` without colliding. `permission` comes from `servers.<name>.approval` and defaults to
`ask`: remote code does not run silently. Run the tool through the same approval flow described in
[Tools & approvals](/guide/tools).

Tool results are flattened to text. `structuredContent` is preserved in the tool result's `data` for
consumers that understand it, but the model reads the text parts.

Servers that support resources also get four bridge tools, so the model can discover and read
documents without a bespoke plugin for each server:

| Tool | Permission | Purpose |
| --- | --- | --- |
| `mcp__<server>__list_resources` | `auto` | Lists resource URIs, names and MIME types. |
| `mcp__<server>__read_resource` | server `approval` | Reads one URI; text is returned, blobs are described by size. |
| `mcp__<server>__list_prompts` | `auto` | Lists prompt templates and their arguments. |
| `mcp__<server>__get_prompt` | server `approval` | Renders a template into `[role] text` blocks. |

Listing is metadata only and runs without approval; reading content or rendering a prompt follows the
server's `approval` setting, because the payload comes from a remote process. A server that answers
`resources/list` or `prompts/list` with an error simply gets no bridge tools, and the rest of its
tools keep working.

## Sampling

An MCP server can ask the client for a model completion — for example, a summarisation or
classification server that does not want to ship its own provider credentials. Kestrel answers
`sampling/createMessage` with the same model registry the agent uses, but only when a deployment
opts in:

```json
{
  "plugins": {
    "config": {
      "@kestrel/plugin-mcp": {
        "sampling": {
          "enabled": true,
          "model": "claude-sonnet-4-5",
          "maxTokens": 1024,
          "maxRequestsPerCall": 8
        },
        "servers": { "summariser": { "command": "summariser-mcp" } }
      }
    }
  }
}
```

- `enabled` defaults to `false`. When false the client does not advertise the `sampling` capability,
  so well-behaved servers never ask, and a server that asks anyway gets a JSON-RPC error.
- `model` names a registered model. Without it, `modelPreferences.hints[].name` is matched against
  model ids; the registry default is the last resort.
- `maxTokens` is a ceiling. A server may ask for less, never more. The default is 1024.
- `maxRequestsPerCall` bounds one tool execution, so a server cannot sample in a loop. The default
  is 8.

The bridge is stateless: it sends the request's `systemPrompt` and `messages` and ignores
`includeContext`, because Kestrel does not mirror one server's view of the conversation into
another. Text and images are supported; audio and embedded resources are rendered as text
placeholders. The tool call's abort signal is forwarded to the model, and completions appear in the
provider's usage statistics but not in the session transcript.

Calls to one MCP server are serialized. The protocol has no parent id on server requests, so when
two sessions share a stdio process, overlapping tool calls would otherwise race for the handler.
Serialization keeps attribution exact and costs little for typical MCP tools.

## Connection lifecycle

- Servers connect during plugin startup, before the first session is created. Startup order is
  handled by the plugin host, so a slow MCP server delays readiness — set `timeoutMs` deliberately.
- One failure never aborts startup. The plugin logs `mcp server failed` with the server name and the
  transport error, keeps the remaining servers, and publishes only what connected.
- HTTP requests carry `Mcp-Session-Id` when the server issues one. On `404` or `410` the client
  re-initializes once and retries, which is what the spec expects when a server restarts or evicts a
  session.
- The plugin closes stdio children and `DELETE`s HTTP sessions on shutdown.

## Calling MCP from a plugin

The plugin publishes an `mcp` service, so another plugin can use a connection without knowing the
transport:

```ts
import type { Context } from "@kestrel/kernel";

export default {
  name: "@acme/tickets",
  inject: ["mcp"],
  apply(context: Context) {
    const mcp = context.get("mcp");
    context.logger.info("mcp servers", { servers: mcp.servers() });

    return {
      async onIssue(key: string) {
        const result = await mcp.call("docs", "search", { query: key });
        return result.content;
      },
    };
  },
};
```

`mcp.tools()` returns `{ server, tool }` pairs; `mcp.servers()` returns connected names.
`mcp.resources()` and `mcp.prompts()` return what was discovered at startup, and
`mcp.readResource(server, uri)` / `mcp.getPrompt(server, name, args)` call through the same
connection. This is the plugin-to-plugin linkage the platform is built around: services, not
imports.

## Security

- MCP servers are arbitrary code. stdio servers run with the server's user and environment; HTTP
  servers receive whatever headers you configure. Treat both as you would a dependency.
- Default `approval: "ask"`. Use `auto` only for servers you trust with your workspace — a tool that
  writes files is an edit the agent can make without asking.
- The MCP plugin does not sandbox the child process, restrict its filesystem access or filter its
  network calls. Use a container or a dedicated user for untrusted servers. See
  [Security](/guide/security).
- Nothing is forwarded to a server until the agent calls one of its tools. There is no background
  polling. Sampling is off by default and budgeted per tool call when enabled: a malicious server
  can spend tokens, but only within the ceiling you configured.

## Limits

- Elicitation is not bridged: a server cannot ask the user for structured input mid-call. Sampling
  is available but opt-in (see [Sampling](#sampling)).
- Resources and prompts are discovered once, at startup. A template added later needs a restart.
- No OAuth flow for HTTP servers; use a static token header or a header-injecting proxy.
- A server whose tool list changes at runtime is not re-discovered; restart the server to pick up
  new tools. The plugin emits `plugin.changed` only on install and removal.
- Tool schemas are passed through unchanged. A server with an invalid JSON Schema will produce
  arguments the agent cannot satisfy; validate server schemas before wiring them in.
