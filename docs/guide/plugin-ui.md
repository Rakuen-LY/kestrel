# Plugin UI

"Everything is a plugin" should include the interface. A plugin can ship a small ESM bundle that
adds a sidebar summary, a settings section or a session header, without forking the console or
depending on its React internals.

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
  "web": { "entry": "panel.js", "css": ["panel.css"] }
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
  request<T>(path: string, init?: RequestInit): Promise<T>;
}

interface ConsoleExtension {
  id: string;                                        // unique within the plugin
  slot: "sidebar.footer" | "settings.section" | "session.header";
  order?: number;                                    // lower renders first, default 100
  mount(element: HTMLElement, context: ConsoleContext): void | (() => void);
}
```

`request` is proxied through the console's authenticated client: the bearer token is attached by the
parent and is **not** exposed to the bundle. Only `method`, plain `headers` and a string `body` cross
the boundary; streams, `FormData` and `AbortSignal` do not. The promise resolves with parsed JSON,
and non-2xx responses reject with the API message.

`mount` receives an empty element inside the iframe. Build whatever DOM you need; return a function
to release timers, listeners or observers. The iframe resizes to the content's height, so avoid
`position: fixed` layers and full-viewport layouts.

The console copies its CSS custom properties (`--bg`, `--text`, `--accent`, ...) onto the iframe
root and refreshes them when the system colour scheme changes. Use `var(--text-muted)` rather than
hard-coded colours so a bundle works in both themes.

## Slots

| Slot | Where it renders | Session scoped |
| --- | --- | --- |
| `sidebar.footer` | Above the settings link in the session list | No |
| `session.header` | Right side of the session toolbar | Yes |
| `settings.section` | Inside the settings drawer | No |

Extensions remount when the active session changes, so `session.header` can read
`context.sessionId` and refresh. Slots are intentionally few: a stable surface is easier to keep
compatible than a component tree.

## Lifecycle and failures

1. The console loads `/api/bootstrap`, then opens a hidden sandbox per active bundle.
2. The sandbox imports `web.entry` and calls `activate`; registrations are reported back as
   metadata. Stylesheet URLs are loaded before the module runs.
3. The console opens one visible sandbox per extension, matching `extensionId` and `slot`.
4. `mount` renders into that sandbox; a mount error is shown in place of the extension.
5. Discovery failures and runtime errors are listed under **Settings → Extension errors**; other
   plugins still load.

A bundle that registers nothing, times out during discovery (five seconds) or throws is reported
once and does not affect other plugins. Reloading the page reloads bundles; there is no hot-reload
channel yet.

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

This prevents token theft and page tampering. It is **not** a capability system: a plugin can still
call every API route the signed-in user can call, spend model tokens, create sessions and read the
workspace through the API. Review bundles like server-side plugins, and use `plugins.allow` when the
plugin directory is not fully trusted. Per-plugin route grants are a roadmap item.

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
