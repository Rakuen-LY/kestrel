# Configuration reference

The server reads `kestrel.config.json` from the working directory, or from `KESTREL_CONFIG` /
`--config`. A missing default file is ignored; an **explicitly named** file must exist.

Precedence: defaults → configuration file → environment variables → command-line flags.

## Full example

```json
{
  "name": "Kestrel",
  "server": {
    "host": "127.0.0.1",
    "port": 7331,
    "token": "",
    "corsOrigins": ["*"],
    "bodyLimitBytes": 10485760,
    "webRoot": "apps/web/dist"
  },
  "model": {
    "default": "gpt-4o-mini",
    "temperature": 0.2,
    "maxTokens": 8192,
    "maxSteps": 60
  },
  "agent": {
    "workspace": ".",
    "systemPrompt": "Prefer small, verifiable changes."
  },
  "plugins": {
    "directories": ["plugins"],
    "allow": ["@kestrel/plugin-openai", "@kestrel/plugin-tools-core"],
    "config": {
      "@kestrel/plugin-tools-core": {
        "shellPermission": "ask"
      },
      "@kestrel/plugin-context": {
        "files": ["AGENTS.md"],
        "maxBytes": 32000
      }
    }
  },
  "storage": { "directory": ".kestrel" },
  "auth": {
    "mode": "token",
    "bootstrapToken": "",
    "workspaces": { "acme-corp": "/srv/kestrel/acme" }
  },
  "approvals": { "timeoutMs": 900000 }
}
```

## `server`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `host` | string | `127.0.0.1` | Bind address. Use `0.0.0.0` in containers. |
| `port` | number | `7331` | Bind port. |
| `token` | string | — | Bearer token. Empty disables auth. |
| `corsOrigins` | string[] | `["*"]` | Allowed origins. `*` is convenient locally and unsafe publicly. |
| `bodyLimitBytes` | number | `10485760` | Maximum request body. |
| `webRoot` | string | `apps/web/dist` | Directory served for non-API paths. |

When authentication is enabled, `GET /api/health` and static files remain public. Every other
`/api/*` route requires the token.

CORS is applied to API responses. Credentials are not allowed with `*`; set explicit origins if a
separate front-end origin sends cookies (Kestrel uses bearer tokens, so this mostly affects
preflight).

## `model`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `default` | string | first registered | Model id selected for new sessions. |
| `temperature` | number | provider default | Forwarded to providers that support it. |
| `maxTokens` | number | provider default | Output token cap per model call. |
| `maxSteps` | number | `40` | Tool/assistant iterations before the run stops with `max_steps`. |

`maxSteps` protects against loops. A typical investigation uses 10–25 steps; raise it for large
refactors. When the limit is reached the run emits a `notice` and `run.finished` with
`status: "max_steps"`.

## `agent`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `workspace` | string | `"."` | Root for tools and new sessions. Resolved at startup. |
| `systemPrompt` | string | — | Extra instructions appended to the default prompt. |
| `compaction.enabled` | boolean | `true` | Summarize old turns when the prompt approaches the model window. |
| `compaction.threshold` | number | `0.8` | Fraction of the context window that triggers compaction. |
| `compaction.keepRecent` | number | `8` | Messages kept verbatim after the summary. |
| `compaction.fallbackContextWindow` | number | `128000` | Window assumed when a model reports none. |

A session may pin a different workspace at creation; tools then operate there. The default system
prompt always states the active workspace and tool list.

## `plugins`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `directories` | string[] | `["plugins"]` | Scan roots, relative to the working directory. |
| `allow` | string[] | — | Exact allow-list of manifest names. |
| `config` | object | `{}` | Per-plugin configuration keyed by manifest name. |

`applyTimeoutMs` is a `PluginHost` option, not a config-file key; the server uses the host default
of 20 seconds.

`@kestrel/plugin-context` reads the first existing file from `files` in each session workspace and
adds it to the system prompt. `maxBytes` truncates (rather than drops) large files. Paths that
resolve outside the workspace are ignored.

## `storage`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `directory` | string | `.kestrel` | Data root: sessions, accounts and per-tenant workspaces. |

Transcripts live in `<directory>/sessions` for the default tenant and
`<directory>/tenants/<tenantId>/sessions` for every other tenant. Accounts live in
`<directory>/auth/accounts.json`.

In containers, point this at a mounted volume (`/data`) so sessions survive restarts.

## `auth`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"none"` \| `"token"` \| `"accounts"` | derived | Derived as `token` when `server.token` is set, otherwise `none`. |
| `bootstrapToken` | string | — | First-run administrator token in accounts mode. |
| `bootstrapName` | string | `Admin` | Display name for the bootstrap administrator. |
| `workspaces` | object | `{}` | Workspace root per tenant id. Unlisted tenants use `<data>/tenants/<id>/workspace`. |

Accounts mode is described in [Authentication and tenants](/guide/authentication). In short:
`none` and `token` keep the single-operator model, while `accounts` adds users, roles and tenant
isolation.

## `approvals`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `timeoutMs` | number | `900000` | How long a tool call waits for a decision before it is declined. |

## `checkpoints`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `"auto"` \| boolean | `"auto"` | `auto` uses git when available; `false` disables snapshots. |
| `maxFiles` | number | `20000` | Refuse to snapshot larger workspaces. |
| `exclude` | string[] | `[]` | Extra ignore patterns, appended to `.gitignore` and the built-in list. |

Snapshots live in `<storage.directory>/checkpoints` as a shadow git repository per workspace. See
[Checkpoints and rollback](/guide/checkpoints).

## Environment variables

| Variable | Overrides | Example |
| --- | --- | --- |
| `KESTREL_CONFIG` | config file path | `/etc/kestrel/kestrel.config.json` |
| `KESTREL_HOST` | `server.host` | `0.0.0.0` |
| `KESTREL_PORT` | `server.port` | `7331` |
| `KESTREL_TOKEN` | `server.token` | long random string |
| `KESTREL_CORS_ORIGINS` | `server.corsOrigins` | `https://app.example.com` |
| `KESTREL_MODEL` | `model.default` | `deepseek-chat` |
| `KESTREL_WORKSPACE` | `agent.workspace` | `/workspace` |
| `KESTREL_SYSTEM_PROMPT` | `agent.systemPrompt` | `Be terse.` |
| `KESTREL_PLUGINS` | `plugins.directories` | `plugins,examples/plugins` |
| `KESTREL_DATA_DIR` | `storage.directory` | `/data` |
| `KESTREL_CHECKPOINTS` | `checkpoints.enabled` | `auto` |
| `KESTREL_CHECKPOINTS_MAX_FILES` | `checkpoints.maxFiles` | `20000` |
| `KESTREL_AUTH_MODE` | `auth.mode` | `accounts` |
| `KESTREL_BOOTSTRAP_TOKEN` | `auth.bootstrapToken` | first-run admin token |
| `KESTREL_LOG_LEVEL` | logger level | `debug` |
| `KESTREL_LOG_FORMAT` | logger format | `json` |

Comma-separated lists (`KESTREL_PLUGINS`, `KESTREL_CORS_ORIGINS`) are trimmed and empty entries are
dropped.

Provider credentials are read by the provider plugin, not the server. The bundled OpenAI plugin
uses `OPENAI_API_KEY` unless `apiKeyEnv` names another variable.

## Command-line flags

`kestrel serve` / `kestrel-server`:

| Flag | Equivalent |
| --- | --- |
| `--host` | `KESTREL_HOST` |
| `--port` | `KESTREL_PORT` |
| `--token` | `KESTREL_TOKEN` |
| `--workspace` | `KESTREL_WORKSPACE` |
| `--config` | `KESTREL_CONFIG` |

Flags are applied by setting the environment before the runtime is created, so they win over both
the file and inherited environment values.

## Plugin configuration

### `@kestrel/plugin-openai`

| Key | Default |
| --- | --- |
| `baseUrl` | `https://api.openai.com/v1` |
| `apiKey` / `apiKeyEnv` | — / `OPENAI_API_KEY` |
| `provider` | `openai` |
| `model` | `gpt-4o-mini` |
| `models` | `["gpt-4o-mini"]` |
| `label` | model id |
| `contextWindow` | — |
| `supportsTools` | `true` |
| `supportsReasoning` | `false` |
| `temperature` / `maxTokens` | — |
| `timeoutMs` | `180000` |
| `streamUsage` | `true` |

### `@kestrel/plugin-tools-core`

| Key | Default |
| --- | --- |
| `restrictToWorkspace` | `true` |
| `shellPermission` | `ask` |
| `shellTimeoutMs` | `120000` |
| `webPermission` | `ask` |
| `fetchTimeoutMs` | `30000` |
| `maxOutputChars` | `100000` |

### `@kestrel/plugin-memory`

| Key | Default |
| --- | --- |
| `path` | `.kestrel/memory.json` (relative to each session workspace) |
| `maxEntries` | `2000` |

### `@kestrel/plugin-skills`

| Key | Default |
| --- | --- |
| `directories` | `[".kestrel/skills", "skills"]` (relative to each session workspace) |
| `maxSkillBytes` | `64000` |
| `maxSkills` | `100` |
| `toolName` | `use_skill` |

See [Skills](/guide/skills) for the file format and the loading model.

### `@kestrel/plugin-subagents`

| Key | Default |
| --- | --- |
| `maxDepth` | `2` |
| `maxConcurrent` | `3` — shared by `delegate` and `delegate_many`; `0` is unbounded |
| `maxFanOut` | `6` |
| `maxBatchResultChars` | `40000` |
| `maxSteps` | `12` |
| `timeoutMs` | `600000` |
| `maxResultChars` | `20000` |
| `exposeApprovalTools` | `false` |
| `roles` | built-in `general`, `researcher`, `reviewer`, `implementer` |

See [Subagents](/guide/subagents) for roles, budgets and observability.

### `@kestrel/plugin-mcp`

| Key | Default |
| --- | --- |
| `servers` | `{}` — an object keyed by server name, matching the MCP `mcpServers` shape |

See [Tools](/guide/tools) and [Models](/guide/models) for behaviour.
