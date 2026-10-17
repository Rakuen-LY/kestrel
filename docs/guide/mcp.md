# Model Context Protocol

The [Model Context Protocol](https://modelcontextprotocol.io) is how Kestrel borrows tools from other
processes: a database gateway, a browser driver, a ticketing system, a filesystem index. The bridge
is a plugin (`@kestrel/plugin-mcp`), so it follows the same lifecycle, configuration and approval
rules as the built-in tools.

It does one thing: connect to MCP servers, list their tools and expose them to the agent as
`mcp__<server>__<tool>`. It does not pass prompts, resources or sampling requests yet.

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

`mcp.tools()` returns `{ server, tool }` pairs; `mcp.servers()` returns connected names. This is the
plugin-to-plugin linkage the platform is built around: services, not imports.

## Security

- MCP servers are arbitrary code. stdio servers run with the server's user and environment; HTTP
  servers receive whatever headers you configure. Treat both as you would a dependency.
- Default `approval: "ask"`. Use `auto` only for servers you trust with your workspace — a tool that
  writes files is an edit the agent can make without asking.
- The MCP plugin does not sandbox the child process, restrict its filesystem access or filter its
  network calls. Use a container or a dedicated user for untrusted servers. See
  [Security](/guide/security).
- Nothing is forwarded to a server until the agent calls one of its tools. There is no background
  polling.

## Limits

- Tools only. Resources, prompts, sampling and elicitation are not bridged yet.
- No OAuth flow for HTTP servers; use a static token header or a header-injecting proxy.
- A server whose tool list changes at runtime is not re-discovered; restart the server to pick up
  new tools. The plugin emits `plugin.changed` only on install and removal.
- Tool schemas are passed through unchanged. A server with an invalid JSON Schema will produce
  arguments the agent cannot satisfy; validate server schemas before wiring them in.
