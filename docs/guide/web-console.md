# Web console

The browser console is a static React application. It has no server-side rendering and no session
of its own: every action becomes an HTTP request, and every update arrives over SSE. The server can
host it, or you can serve `apps/web/dist` from any static host and point it at a remote API.

## Opening the console

```bash
pnpm build:web
KESTREL_TOKEN="$(openssl rand -hex 24)" pnpm start
```

Open `http://127.0.0.1:7331`. Without a stored token against a protected server, the console shows a
sign-in screen; in `accounts` mode each user signs in with their own token. The token is kept in
`localStorage` and sent as a bearer header; it is never written to a cookie. **Settings → Account**
shows the current user, role and tenant, and offers **Sign out**.

If the server runs without a token, the console connects immediately. When the API is on another
origin, set `server.corsOrigins` and serve the console separately:

```bash
pnpm --filter @kestrel/web build
npx serve apps/web/dist   # or any static host, behind TLS
```

The console derives the API base from `window.location.origin` by default. To drive a remote agent,
either open `https://console.example.com/?api=https://agent.example.com:7331` once, or set the
endpoint under **Settings → Server → API endpoint**. The choice is stored in `localStorage` and the
page reloads with the new base. A path such as `/kestrel` works when both tiers share a reverse
proxy.

Cross-origin use requires the server to allow the console origin (`server.corsOrigins`) and, for
streaming, the SSE endpoint must be reachable directly rather than buffered by a proxy. Serve the
console over HTTPS when the agent is HTTPS; browsers block mixed content.

## Install as an app

The console ships a web manifest, PNG icons and a small service worker, so Chromium and Safari can
install it as a standalone window on desktop and mobile. The worker caches only the application
shell and hashed assets; `/api/*` requests and event streams always go to the network. The offline
fallback shows the shell, not a cached transcript — sessions remain on the agent.

For a native shell, wrap the same static build with Tauri, Electron or a mobile WebView and point it
at the API endpoint. No desktop-specific API exists to port.

## Layout

| Region | Behaviour |
| --- | --- |
| Sidebar | Session list, new session, connection state, mobile drawer toggle. |
| Header | Session title (click to rename), status, settings. |
| Thread | User and assistant messages, markdown, reasoning trace, tool cards and diffs. |
| Composer | Multi-line input, send on Enter, cancel while a run is active, image attachments via paperclip, paste or drop. |
| Settings drawer | Endpoint, token, model, workspace, system prompt, plugins and tools. |
| Approval dialog | Blocking prompt for tools configured with `permission: "ask"`. |

## Sessions

- **New session** calls `POST /api/sessions` and opens it. The first message becomes the title if
  the session has no title.
- **Switching** loads the full transcript with `GET /api/sessions/:id`, then reconnects the event
  stream for that session. The cached list keeps the sidebar fast.
- **Renaming** uses `PATCH /api/sessions/:id`.
- **Deleting** removes the transcript from disk. It is not recoverable; there is no trash.
- **Status** reflects the server: `idle`, `running`, `error` or `cancelled`. A second message is
  rejected with `409` while running; use cancel first.

The console never edits the transcript locally beyond optimistic user messages. `message.completed`
is authoritative and replaces streamed deltas.

## Streaming and reconnects

The console opens `GET /api/sessions/:id/events` after loading the transcript. It remembers the last
event id and reconnects with `Last-Event-ID`, so a dropped connection replays missed events. If the
server has evicted the buffer, the console refetches the session and continues from live events.

While disconnected, the header shows the connection state. Sending is disabled until the stream is
restored, because otherwise the run could complete without the UI observing it.

## Tools and approvals

Tool calls render as cards with name, arguments, duration, exit status and a collapsible result.
Long output is truncated by the server (`maxOutputChars`); the card shows that truncation.

When a tool has `permission: "ask"`, the server pauses the run and emits `approval.requested`. The
console shows a modal with the tool name and arguments. Approving or denying calls
`POST /api/sessions/:id/approvals/:approvalId`; the decision is final and the run resumes or records
a denial. The server's approval timeout also resolves the prompt as denied.

## Settings

- **Server** — read-only endpoint, version, protocol and live connection state; token entry.
- **Session** — model selection (only when idle), workspace path, editable system prompt.
- **Plugins** — every discovered plugin with version, state, dependencies and error text. This view
  is read-only in `0.1`; install or remove plugins on disk and restart.
- **Tools** — the schemas the current model can call, including permission mode.

Saving a token reloads the page so that the SSE connection is re-established with the new
credentials.

## Accessibility and mobile

The layout collapses to a single column under 900px. The sidebar becomes a drawer; the composer
stays above the safe-area inset. Controls are native buttons and inputs with labels, the approval
dialog traps focus, and colour is never the only status signal. The console respects
`prefers-reduced-motion`.

## Building and embedding

```bash
pnpm --filter @kestrel/web dev      # Vite on :5173, proxies /api to :7331
pnpm --filter @kestrel/web build    # static assets in apps/web/dist
pnpm --filter @kestrel/web typecheck
```

The only coupling to the server is `apps/web/src/api.ts`, which uses the types from
`@kestrel/protocol`. A desktop shell (Tauri, Electron) can load the same build; point it at a local
or remote server and keep the same token flow. A mobile client should implement the protocol
directly rather than embedding the desktop layout.
