# Plugin UI

"Everything is a plugin" should include the interface. A plugin can ship a small ESM bundle that
adds a sidebar summary, a settings section or a session header, without forking the console or
depending on its React internals.

This page covers the contract, the slots, and the trust boundary. The worked example is
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

The default export is called once per page load, after `/api/bootstrap` reports the plugin as
active:

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

`request` goes through the console's authenticated client: the bearer token is attached for you and
is **not** exposed to the bundle. Use it for every API call so headers and error handling stay
consistent.

`mount` receives an empty element that the console owns. Build whatever DOM you need; return a
function to release timers, listeners or observers. The console clears the element after cleanup.

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

1. The console loads `/api/bootstrap`, then imports every active plugin's `web.entry`.
2. Stylesheets are injected before the module runs.
3. `activate(api)` registers extensions; duplicate ids within a plugin throw.
4. Each extension mounts into its slot. A mount error is shown inside that slot.
5. Errors are logged and listed under **Settings → Extension errors**; other plugins still load.

Reloading the page reloads bundles. There is no hot-reload channel yet, which keeps the contract
small.

## Trust boundary

A browser bundle is **code in the console's origin**. It can read `localStorage`, call any API the
user can call, and alter the page. Only install plugins you trust, and review what they ship.

The console does not hand the token to plugin code, but same-origin code can read it from storage
directly. If you need stronger isolation, the roadmap direction is sandboxed iframes or workers per
bundle; until then, treat the plugin directory with the same care as the server's `node_modules`.

Bundles must be same-origin with the console. When the console talks to a remote API, plugin assets
still load from the API origin; the default CSP (`default-src 'self'`) and CORS will usually block
that, so for now serve the console from the same Kestrel server as the API.

## Writing bundles without a build step

A bundle is plain ESM. No bundler, framework or import map is required: use DOM APIs directly, or
import from a CDN if your deployment allows it. If you want TypeScript, compile to a single `.js`
file and commit the output under `web/`; nothing in Kestrel inspects the source.

React and other large dependencies are best avoided. If you need them, bundle your own copy inside
the entry — the console's copy is not shared.
