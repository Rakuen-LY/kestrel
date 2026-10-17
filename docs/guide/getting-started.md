# Quickstart

## Requirements

- Node.js **22 or newer**
- pnpm **9** (the repository pins `pnpm@9.4.0` via `packageManager`)
- A model provider, or the bundled offline `echo` example for a first run

Kestrel runs on Linux, macOS and Windows. The server has no native dependencies; the only
platform-specific code lives in tools that shell out to the host, and those can be replaced.

## From source

```bash
git clone <your-fork> kestrel
cd kestrel
pnpm install
pnpm build
```

Start the server with the built-in plugins and the example extensions:

::: code-group

```bash [Linux / macOS]
KESTREL_PLUGINS=plugins,examples/plugins KESTREL_WORKSPACE=. \
  node apps/server/dist/bin.js
```

```powershell [Windows PowerShell]
$env:KESTREL_PLUGINS = "plugins,examples/plugins"
$env:KESTREL_WORKSPACE = "."
node apps/server/dist/bin.js
```

:::

Open <http://127.0.0.1:7331>. The console connects to the same origin, lists the loaded plugins and
lets you create a session.

The example `echo` model answers offline, which is useful to verify the whole loop before adding an
API key. Select it in the model picker or create a session with `model: "echo"`.

## Connect a real model

The OpenAI-compatible provider plugin reads standard environment variables:

```bash
export OPENAI_API_KEY=sk-...
export KESTREL_MODEL=gpt-4o-mini
KESTREL_PLUGINS=plugins node apps/server/dist/bin.js
```

Any endpoint that implements the OpenAI chat-completions API can be used:

```json
{
  "plugins": {
    "config": {
      "@kestrel/plugin-openai": {
        "baseUrl": "https://api.example.com/v1",
        "models": ["my-model"],
        "apiKeyEnv": "MY_PROVIDER_KEY"
      }
    }
  }
}
```

See [Models & providers](/guide/models) for the full configuration surface.

## Development mode

Two processes, hot reload on both sides:

```bash
# terminal 1 — server on :7331
pnpm dev

# terminal 2 — Vite dev server on :5173, proxying /api to :7331
pnpm dev:web
```

`pnpm dev` runs the TypeScript sources through `tsx`. The Vite server proxies API calls, so the
browser sees a single origin and SSE works without CORS configuration.

## CLI

```bash
# one-shot task, streaming tool calls to the terminal
node apps/cli/dist/index.js run "Summarise this repository" --workspace .

# interactive session
node apps/cli/dist/index.js chat --model echo

# inspect the runtime
node apps/cli/dist/index.js plugins
node apps/cli/dist/index.js models
```

Install it globally if you prefer:

```bash
pnpm --filter @kestrel/cli build
npm link ./apps/cli
kestrel run "Find the failing test"
```

## Docker

```bash
docker build -t kestrel .
docker run --rm -p 7331:7331 \
  -e KESTREL_TOKEN=change-me \
  -e OPENAI_API_KEY=sk-... \
  -v "$PWD/workspace:/workspace" \
  kestrel
```

`/workspace` is the agent's default working directory inside the image. Mount the project you want
the agent to edit there, not the repository root. See [Deployment](/guide/deployment) for Compose,
Kubernetes and systemd.

## First useful session

1. Create a session and pick a model.
2. Ask a read-only question first: *"Map this repository and explain how the server starts."*
3. Watch tool calls stream in. Read and search tools run automatically; `shell` and `web_fetch` are
   marked `ask` and pause for approval.
4. Approve a plan, then let the agent work. Every message and tool result is persisted under
   `.kestrel/sessions` and survives a restart.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `The Kestrel API is running...` at `/` | Web console not built. Run `pnpm build:web`, or use `pnpm dev:web`. |
| `No language model is configured` | No provider plugin registered a model. Set `OPENAI_API_KEY` or install a provider plugin. |
| `fetch failed` on the first turn | Provider endpoint unreachable or API key rejected. Check the server log. |
| Console shows *Reconnecting…* | SSE blocked by a proxy that buffers responses. Disable buffering for `/api/*`. |
| Tools cannot see your project | `KESTREL_WORKSPACE` points elsewhere. It is resolved at startup. |

Next: [Architecture](/guide/architecture).
