# Plugin UI

"Everything is a plugin" should include the interface. A plugin can ship a small ESM bundle that
adds a sidebar summary, a settings section, a session header, content after a message, an action
under the composer or a preview for a workspace file, without forking the console or depending on
its React internals.

Bundles run in a sandboxed iframe, not in the console's origin. This page covers the contract, the
slots and the trust boundary. The worked example is
`examples/plugins/web-metrics`, listed in [Example plugins](/guide/examples).

## Declaring a bundle

Add `web` to the manifest and put the files under `web/`:

```json
{
  "name": "@acme/plugin-metrics",
  "version": "0.1.0",
  "entry": "index.js",
  "web": {
    "entry": "panel.js",
    "css": ["panel.css"],
    "api": ["GET /api/sessions", "GET /api/plugins"],
    "capabilities": ["composer.submit"]
  }
}
```

```js
// web/panel.js
export default function activate(api) {
  api.register({
    id: "summary",
    slot: "sidebar.footer",
    order: 10,
    mount(element, context) {
      element.textContent = `API: ${context.endpoint}`;
      return () => {
        /* optional cleanup */
      };
    },
  });
}
```

`web` may also be a bare string, which means `{ entry: "<string>" }`. Paths are relative to the
plugin's `web/` directory; absolute paths, `..` segments and drive letters are dropped. A missing
entry leaves the plugin active but without a browser bundle, and is reported in the log.

The server only serves assets for plugins whose state is `active`:

```
GET /plugins/<url-encoded plugin id>/panel.js
GET /plugins/<url-encoded plugin id>/panel.css
```

Assets are public, exactly like the console's own files, and are served with `no-cache`. Never put
secrets in a bundle.

## The module contract

The default export runs inside a sandboxed iframe, after `/api/bootstrap` reports the plugin as
active. It runs once in a short discovery pass and again in the iframe that mounts each extension,
so keep activation free of global side effects: register, do not start work.

```ts
type Activate = (api: ConsoleModuleApi) => void | Promise<void>;

interface ConsoleModuleApi {
  context: ConsoleContext;
  register(extension: ConsoleExtension): void;
}

interface ConsoleContext {
  plugin: { id: string; name: string; version: string };
  endpoint: string;                                  // absolute API origin
  sessionId?: string;                                // set for session slots
  payload: Record<string, unknown>;                  // slot input, see below
  message?: {                                        // message.after only
    id: string;
    role: "user" | "assistant";
    content: string;
    createdAt: string;
    reasoning?: string;
    model?: string;
    toolCalls?: ToolCall[];
    images?: Array<{ mimeType: string; name?: string }>;
  };
  file?: {                                            // file.viewer only
    path: string;
    name: string;
    size: number;
    mimeType: string;
    encoding: "utf8" | "base64";
    content: string;
    truncated: boolean;
    binary: boolean;
    lines?: number;
  };
  composer?: { submit(text: string): void };         // composer.actions only
  request<T>(path: string, init?: RequestInit): Promise<T>;
}

interface ConsoleExtension {
  id: string;                                        // unique within the plugin
  slot: "sidebar.footer" | "settings.section" | "session.header"
      | "message.after" | "composer.actions" | "file.viewer";
  order?: number;                                    // lower renders first, default 100
  match?: {                                          // message.after / file.viewer filtering
    roles?: Array<"user" | "assistant">;             // message.after only
    toolNames?: string[];                            // message.after only
    extensions?: string[];                           // file.viewer only, without the dot
  };
  mount(element: HTMLElement, context: ConsoleContext): void | (() => void);
}
```

`request` is proxied through the console's authenticated client: the bearer token is attached by the
parent and is **not** exposed to the bundle. Only `method`, plain `headers` and a string `body` cross
the boundary; streams, `FormData` and `AbortSignal` do not. The promise resolves with parsed JSON,
and non-2xx responses reject with the API message.

### API grants

A bundle must declare which API routes it may call through the proxy. Grants are
`"METHOD /api/path"` strings; `*` matches one path segment and `**` matches the rest:

```json
{
  "web": {
    "entry": "panel.js",
    "api": ["GET /api/sessions", "GET /api/sessions/*", "POST /api/sessions/*/messages"]
  }
}
```

- Omit `api` for **read-only** access to `/api/**`; use `[]` to deny every request.
- Matching is method-aware and case-insensitive for the method.
- Paths are normalised before matching, and `.`/`..` or encoded traversal is rejected.
- Asset URLs are never proxied; only `/api/...` calls cross the bridge.

Requests outside the grant list fail with `Plugin <id> is not granted <METHOD> <path>.` The check
runs in the parent, after the plugin has handed over the call, so a compromised bundle cannot widen
its own grants. Discovery runs cannot call the API at all.

`mount` receives an empty element inside the iframe. Build whatever DOM you need; return a function
to release timers, listeners or observers. The iframe resizes to the content's height, so avoid
`position: fixed` layers and full-viewport layouts.

The console copies its CSS custom properties (`--bg`, `--text`, `--accent`, ...) onto the iframe
root and refreshes them when the system colour scheme changes. Use `var(--text-muted)` rather than
hard-coded colours so a bundle works in both themes.

`context.file` is a read-only projection of the file the user opened. Text is clipped to 512,000
characters before it crosses the boundary, and `truncated` flips when either the server read limit
or that clip was hit. Binary files arrive base64-encoded; prefer `request` for large payloads
instead of pushing them through `postMessage`.

`context.message` omits base64 image bytes; call `request` if a contribution needs the actual
pixels. Tool arguments and results are included through `toolCalls`, so a message extension can
recognise its own output. `context.payload` carries the raw slot input for new slots and is the
forward-compatible place for future data.

`context.composer.submit(text)` asks the console to send `text` as a new user turn. The console
still owns the request, the API token and the run lifecycle; the bundle only proposes the prompt.
Empty or whitespace-only text is ignored and the call is capped at 100,000 characters. Because a
prompt can mutate the workspace, the bridge is absent unless the manifest declares the capability:

```json
{ "web": { "entry": "panel.js", "capabilities": ["composer.submit"] } }
```

Unknown capabilities are dropped with a warning, exactly like malformed API grants. Read-only
bundles can still register `composer.actions` to show information, but cannot start a run.

## Slots

| Slot | Where it renders | Session scoped | Payload |
| --- | --- | --- | --- |
| `sidebar.footer` | Above the settings link in the session list | No | — |
| `session.header` | Right side of the session toolbar | Yes | — |
| `settings.section` | Inside the settings drawer | No | — |
| `message.after` | Under every matching user or assistant message | Yes | `message` |
| `composer.actions` | Under the composer box | Yes | `composer` |
| `file.viewer` | Instead of the built-in file preview | Yes | `file` |

`message.after` mounts one iframe per matching message. Narrow it with `match` so the console does
not create an island for every turn:

```js
api.register({
  id: "tool-timing",
  slot: "message.after",
  match: { roles: ["assistant"], toolNames: ["browser_screenshot"] },
  mount(element, context) {
    element.textContent = `Rendered from ${context.message.toolCalls.length} tool calls`;
  },
});
```

Extensions remount when the active session changes or when a slot payload changes, so
`session.header` can read `context.sessionId` and refresh. Message payloads are stable once a turn
is persisted; streaming messages do not mount extensions until the turn completes. Slots are
intentionally few: a stable surface is easier to keep compatible than a component tree.

### Replacing a file preview

The console ships a source/line-number preview and an image viewer, plus a read-only workspace
browser backed by `GET /api/sessions/:id/files` and `/file`. A `file.viewer` contribution takes over
the preview pane for the file types it claims, and the console offers a **Source** tab beside it so
the raw text is always one click away. Claim extensions precisely — a contribution without `match`
would replace every preview:

```js
api.register({
  id: "csv-table",
  slot: "file.viewer",
  match: { extensions: ["csv", "tsv"] },
  mount(element, context) {
    const { path, content, encoding, binary, truncated } = context.file;
    if (binary || encoding !== "utf8") {
      element.textContent = "Not a text table.";
      return;
    }
    // Parse and render `content`; `path` ends in .csv or .tsv here.
  },
});
```

`examples/plugins/csv-viewer` is a complete version with quoted-cell parsing. The file API is
session-scoped and honours tenant visibility: a file outside the session workspace, including a
symlink that escapes it, answers `400`, `403` or `404`, never its contents.

## Lifecycle and failures

1. The console loads `/api/bootstrap`, then opens a hidden sandbox per active bundle.
2. The sandbox imports `web.entry` and calls `activate`; registrations are reported back as
   metadata. Stylesheet URLs are loaded before the module runs.
3. The console opens one visible sandbox per extension, matching `extensionId` and `slot`.
4. `mount` renders into that sandbox; a mount error is shown in place of the extension.
5. Discovery failures and runtime errors are listed under **Settings → Extension errors**; other
   plugins still load.

A bundle that registers nothing, times out during discovery (five seconds) or throws is reported
once and does not affect other plugins. Registrations carry `match` metadata during discovery, so
filtering happens before any iframe is created. Reloading the page reloads bundles; there is no
hot-reload channel yet.

## Trust boundary

The sandbox document is served by the Kestrel API at `/plugin-sandbox.html` and framed with
`sandbox="allow-scripts"`. That combination gives the bundle an **opaque origin**:

- No access to the console's `localStorage`, `sessionStorage`, cookies or DOM.
- No `window.opener`, popups or top-level navigation.
- No direct network access: CSP sets `connect-src 'none'`. Images may come from `data:`, `blob:` or
  the API origin; fonts and styles only from `data:` and the API origin. The entry and stylesheets
  are the only scripts allowed, so a CDN import will not load.
- No form submission. API access happens exclusively through the parent's `request` proxy, which
  attaches the token after the call leaves the sandbox.

This prevents token theft and page tampering. Route grants narrow the API surface further: by
default a bundle can only read, and mutating routes must be declared in the manifest. Grants are
still not a sandbox for a malicious plugin: every granted route runs with the signed-in user's
authority, so review bundles like server-side plugins and use `plugins.allow` when the plugin
directory is not fully trusted.

The same applies to `composer.submit`: a capability is permission, not user intent. A bundle can
call it without a click, so treat `capabilities: ["composer.submit"]` like a write grant and review
why a plugin needs to start runs.

The console and the API may live on different origins (a static console deployment, or the Vite dev
server). The sandbox is always served by the API origin; plugin assets are public and CORS-enabled,
and the console's CSP allows framing it.

## Limitations

- Bundles cannot share a DOM or React tree with the console; use slots and the API.
- There is one iframe per extension, and discovery runs the bundle once more. Bundles should be
  small, and activation must be side-effect free.
- `request` speaks JSON only.
- The sandbox cannot open links in a new tab; render an `<a>` and let the console own navigation, or
  use the API.

## Writing bundles without a build step

A bundle is plain ESM. No bundler, framework or import map is required: use DOM APIs directly. The
sandbox allows no third-party script origins, so relative imports must stay inside `web/` and a CDN
import will fail. If you want TypeScript, compile to a single `.js` file and commit the output under
`web/`; nothing in Kestrel inspects the source.

React and other large dependencies are best avoided. If you need them, bundle your own copy inside
the entry — the console's copy is not shared.
