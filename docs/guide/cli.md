# CLI

The CLI embeds the same runtime as the server. It is useful for one-shot tasks, machines without a
browser, and CI jobs that should not open a port.

```bash
pnpm --filter @kestrel/cli build
node apps/cli/dist/index.js --help
```

## Commands

| Command | Description |
| --- | --- |
| `kestrel serve` | Start the HTTP + SSE server (same as `kestrel-server`). |
| `kestrel run <prompt...>` | Run one task, stream output, exit. |
| `kestrel chat` | Interactive session with `/new`, `/cancel`, `/help`, `/exit`. |
| `kestrel plugins` | List discovered plugins with state and errors. |
| `kestrel models` | List registered models; marks the default. |
| `kestrel sessions` | List persisted sessions. |
| `kestrel sessions resume <id>` | Continue an interrupted session. |
| `kestrel sessions rewind <id> <messageId>` | Drop a user turn, and restore the files it started from. |
| `kestrel skills [show <name>]` | List workspace skills, or print one body. |
| `kestrel skills lint` | Validate every skill file; exits `1` on errors. |
| `kestrel skills new <name>` | Scaffold `skills/<name>/SKILL.md` without overwriting. |

## Options

| Flag | Applies to | Meaning |
| --- | --- | --- |
| `-c, --config <path>` | all | Configuration file (default `kestrel.config.json`). |
| `--workspace <dir>` | run, chat, serve, skills | Workspace root for tools, new sessions and skill discovery. |
| `--model <id>` | run, chat, serve | Default model for new sessions. |
| `--host <host>` | serve | Bind address. |
| `--port <port>` | serve | Bind port. |
| `--token <token>` | serve | Require a bearer token. |
| `--role <role>` | users create | `admin` or `member` (default `member`). |
| `--tenant <id>` | users create | Tenant id (default `default`). |
| `--email <address>` | users create | Optional contact address. |
| `--description <text>` | skills new | Frontmatter description for the scaffold. |
| `--when <text>` | skills new | Optional `whenToUse` hint for the scaffold. |
| `--json` | run, skills | Print raw event envelopes (run) or a JSON document (skills, skills lint). |
| `-h, --help` | all | Help. |
| `-v, --version` | all | Version. |

## Examples

```bash
# read-only analysis
kestrel run "Map this repository. Do not modify anything." --workspace .

# machine-readable stream for another tool
kestrel run "Run the test suite and summarise failures" --json | jq -r 'select(.event.type=="message.delta") | .event.delta'

# pin a model and a workspace
kestrel run "Add a healthcheck endpoint" --model gpt-4o-mini --workspace /srv/app

# inspect the procedures available to a workspace
kestrel skills --workspace /srv/app
kestrel skills show release-checklist --workspace /srv/app
kestrel skills lint --workspace /srv/app
kestrel skills new release-checklist --description "Publish a release safely." --workspace /srv/app

# serve with authentication
kestrel serve --host 0.0.0.0 --port 7331 --token "$(openssl rand -hex 24)"
```

`run` and `chat` raise the log level to `warn` so the transcript stays readable; set
`KESTREL_LOG_LEVEL=info` (or `debug`) to see plugin activation and session lifecycle lines. `serve`
logs at `info` by default.

`--json` output is the same `ServerEventEnvelope` shape the API sends, without the SSE framing:

```json
{"seq":12,"at":"2026-01-01T10:00:04.000Z","event":{"type":"tool.started","sessionId":"...","call":{"id":"call_1","name":"read_file","arguments":{"path":"README.md"}}}}
```

## Approvals in the terminal

`run` and `chat` install an interactive approval prompt. When a tool asks for permission, the CLI
prints the tool name and arguments and asks for `y`/`n`. This is a local decision; it does not touch
the HTTP approval endpoint.

In non-interactive contexts, prefer `shellPermission: "auto"` inside a disposable sandbox, or
implement a policy plugin with a `resolvePermission` function.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Run completed (including a run stopped by the `finish` tool). |
| 1 | Run failed, or startup/configuration failure. |
| 2 | Invalid arguments or unknown command. |

A cancelled run exits 0. In `--json` mode the failure is present in the stream even when the process
exits 1, so pipelines can parse and gate on either signal.
