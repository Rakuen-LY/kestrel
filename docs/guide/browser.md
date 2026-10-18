# Browser automation

Kestrel can drive a real Chromium page: open URLs, read the visible page, click and type by
reference, scroll, go back and save screenshots. The implementation talks to Chrome DevTools
Protocol directly, so it does not add Playwright, Puppeteer or a browser download to the dependency
tree.

The plugin ships as `@kestrel/plugin-browser` and is loaded from `plugins/browser` when that
directory is part of `plugins.directories` (the default).

## Requirements

- Google Chrome, Chromium or Microsoft Edge on the agent host.
- A display is not required; the default is headless.
- The plugin finds a browser in this order:
  1. `browser.executable` in configuration.
  2. `KESTREL_BROWSER_PATH` or `CHROME_PATH`.
  3. Common names on `PATH` (`chromium`, `google-chrome`, `msedge`, ...).
  4. Platform locations such as `/Applications/Google Chrome.app` or `Program Files`.

If no browser is found, tool calls fail with a message that names both the config key and the
environment variable. Other agent capabilities keep working.

## Configuration

```json
{
  "plugins": {
    "config": {
      "@kestrel/plugin-browser": {
        "permission": "ask",
        "headless": true,
        "timeoutMs": 30000,
        "settleMs": 250,
        "maxTextChars": 12000,
        "maxElements": 120
      }
    }
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `executable` | auto | Chromium-compatible binary. |
| `args` | `[]` | Extra browser flags, appended last. |
| `headless` | `true` | Use `--headless=new`. Set `false` only when a display exists. |
| `permission` | `"ask"` | Approval policy for `browser_open`. Interactions stay automatic. |
| `timeoutMs` | `30000` | Launch, navigation and command timeout. |
| `settleMs` | `250` | Extra wait after `load` for client-side rendering. |
| `maxTextChars` | `12000` | Visible text retained per snapshot. |
| `maxElements` | `120` | Interactive elements retained per snapshot. |
| `noSandbox` | auto | Pass `--no-sandbox` in containers without usable user namespaces. |

`noSandbox` defaults to true on Linux when Kestrel runs as root, inside Docker (`/.dockerenv`), or
in Kubernetes. Chromium's sandbox needs privileges that these environments usually withhold; the
container is then the isolation boundary. On a desktop host the browser sandbox stays enabled. Set
`noSandbox` explicitly if auto-detection is wrong for your deployment.

## Tools

| Tool | Permission | What it does |
| --- | --- | --- |
| `browser_open` | `ask` by default | Navigate to an HTTP(S) URL and return a snapshot. |
| `browser_snapshot` | auto | Re-read the current page without changing it. |
| `browser_click` | auto | Click element `ref` from the latest snapshot. |
| `browser_type` | auto | Replace an input's value, optionally submit its form. |
| `browser_scroll` | auto | Scroll by pixels (default 700) and snapshot. |
| `browser_back` | auto | Go back in history and snapshot. |
| `browser_screenshot` | auto | Save a PNG inside the workspace. |
| `browser_close` | auto | Close the browser and delete its temporary profile. |

Every mutating tool returns a **fresh snapshot**, so the model does not need a second call to see
the result. Refs are numbers scoped to the most recent snapshot; after a navigation or a large DOM
change they may point somewhere else, and a stale ref fails with an instruction to snapshot again.

### Snapshots

A snapshot contains:

- the document title and final URL;
- visible body text, capped by `maxTextChars`;
- interactive elements (`a`, `button`, `input`, `textarea`, `select`, ARIA button/link and
  contenteditable) with a `ref`, tag, accessible label, type, value, href and state.

Password values are omitted. Hidden elements (zero layout box) and elements beyond
`maxElements` are not listed. The agent should read the snapshot, choose a ref, act, and read the
next snapshot — the same observe/act loop a human uses.

### Screenshots

`browser_screenshot` writes a PNG under the session workspace and returns the path and byte count.
The image is **not** sent to the model; it is for humans reviewing the run, or for later steps that
inspect the file. Paths outside the workspace are rejected.

## Programmatic use

Other plugins can consume the shared page through the `browser` service:

```ts
const browser = context.get("browser");
const page = await browser.open("https://example.com");
const button = page.elements.find((element) => element.text === "Sign in");
if (button) await browser.click(button.ref);
```

The service exposes `open`, `snapshot`, `click`, `type`, `scroll`, `back`, `screenshot`, `status`
and `close`. Calls are serialised over one page, which keeps refs and navigation deterministic.
The service is declared in `ServiceMap`, so TypeScript checks the usage.

## Security

- `browser_open` defaults to `"ask"`, like `web_fetch`. Approving a URL approves that navigation,
  not every later click on the page. Interactions are automatic because a page can require dozens
  of them.
- Pages are untrusted input. Prompt injection in page text is possible; the agent prompt already
  treats tool output as data, and approvals remain the control for consequential actions.
- The browser profile is a fresh temporary directory per process and is deleted on close. Cookies
  and logins do not survive a restart.
- Only `http:` and `https:` URLs are accepted. `file:`, `data:` and browser-internal URLs are
  rejected, so the page cannot read the host filesystem through a URL.
- The tool does not expose arbitrary JavaScript evaluation. Snapshot, click and type operate on
  the page's own DOM, but a hostile page still controls what those elements do.
- Because the browser can reach private networks and cloud metadata endpoints, run the agent in a
  network policy that matches the pages it should reach. `browser_open` approval is the first line,
  not a network firewall.
- `noSandbox` weakens Chromium's process isolation. Prefer a host with user namespaces, or accept
  the container boundary deliberately. Never enable it on a multi-tenant desktop host.

## Limits

- One page per plugin instance; no tabs, popups or downloads.
- No file upload or download handling.
- No persistent profile, cookie import or authenticated-session reuse.
- No video, canvas or WebGL assertions; screenshots capture what the compositor produced.
- Client-side rendering is given `settleMs`, not an arbitrary condition. If an app needs longer,
  increase it or call `browser_snapshot` again.
- Anti-bot systems may block headless Chromium. That is a policy decision for the target site, not
  something the plugin tries to circumvent.

For richer scenarios (multi-tab, tracing, network interception, PDF), connect a Playwright MCP
server and use the [MCP bridge](/guide/mcp) instead. The built-in plugin covers the common
read-and-act loop without another runtime.
