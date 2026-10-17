# Example plugins

Two annotated plugins live in `examples/plugins/`. Together they demonstrate the three things a
plugin can do without touching the core: register a model, register a tool, and cooperate with
another plugin through a service.

Load both plus the first-party plugins:

```bash
KESTREL_PLUGINS=plugins,examples/plugins KESTREL_MODEL=echo \
  node apps/cli/dist/index.js run "What time is it?"
```

The echo model answers deterministically, so this works with no API key and no network.

For a first-party example of the prompt-layer seam, see
[`plugins/context`](https://github.com/kestrel-dev/kestrel/tree/main/plugins/context). It appends
`AGENTS.md` from the session workspace to the system prompt without teaching the agent loop about
files.

[`examples/skills/release-checklist`](https://github.com/kestrel-dev/kestrel/tree/main/examples/skills/release-checklist)
is a ready-to-copy skill. Copy it into `<workspace>/skills/` and the model will see it in the
session prompt, loading the body only when it decides the task is a release. The format and the
loading model are documented in [Skills](/guide/skills).

## `echo-model` — a model provider in 50 lines

`examples/plugins/echo-model/index.js` is plain ESM
with no build step:

```js
export default {
  name: "@example/plugin-echo-model",
  version: "0.1.0",
  inject: ["models"],
  apply(context, config) {
    const id = config.id ?? "echo";
    const model = {
      info: { id, provider: "example", label: "Echo (offline)", supportsTools: false },
      async generate(request, onDelta) {
        const text = `You said: ${lastUserMessage(request)}`;
        for (let index = 0; index < text.length; index += 24) {
          onDelta?.({ channel: "text", delta: text.slice(index, index + 24) });
        }
        return { content: text, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
      },
    };
    context.effect(() => context.get("models").register(model));
  },
};
```

What to notice:

- `inject: ["models"]` means `apply` runs only after the model registry exists.
- `context.effect` ties the registration to the plugin lifetime. Unloading removes the model.
- `generate` streams through `onDelta` and still returns a complete response.
- The manifest (`kestrel.plugin.json`) supplies the name and config default; the module may repeat
  them, and the host reconciles both.

The echo model declares `supportsTools: false`. The runtime still passes tool schemas; a real
provider that cannot call tools should ignore them, and clients should hide tool affordances for
models without support.

## `clock-tool` — a tool that extends another plugin's registry

`examples/plugins/clock-tool/index.js` never imports
`@kestrel/plugin-tools-core`. It depends on the `tools` service, which either plugin can provide:

```js
export default {
  name: "@example/plugin-clock-tool",
  version: "0.1.0",
  inject: ["tools"],
  apply(context) {
    context.effect(() =>
      context.get("tools").register({
        schema: {
          name: "clock_now",
          description: "Return the current time, optionally in an IANA time zone.",
          category: "example",
          permission: "auto",
          parameters: {
            type: "object",
            properties: { timeZone: { type: "string" } },
            additionalProperties: false,
          },
        },
        execute(args) {
          const timeZone = typeof args.timeZone === "string" ? args.timeZone : undefined;
          const now = new Date().toLocaleString("en-US", { timeZone, dateStyle: "full", timeStyle: "long" });
          return { content: now, data: { iso: new Date().toISOString(), timeZone } };
        },
      }),
    );
  },
};
```

This is the cooperation model in practice:

- Tools are not owned by the plugin that registers them; they are contributions to a shared
  registry.
- A tool can return `data` for rich clients. `data` never goes to the model, only `content` does.
- The plugin is disposable: when the host unloads it, the tool disappears and the model stops seeing
  it in the next request.

## `web-metrics` — a browser contribution

`examples/plugins/web-metrics` is the only example that touches the console. Its manifest declares a
bundle:

```json
{
  "name": "@example/plugin-web-metrics",
  "version": "0.1.0",
  "entry": "index.js",
  "web": { "entry": "panel.js", "css": ["panel.css"] }
}
```

`index.js` provides a `web-metrics` service, and `web/panel.js` registers two extensions:

```js
export default function activate(api) {
  const { request } = api.context;

  api.register({
    id: "sidebar-summary",
    slot: "sidebar.footer",
    order: 10,
    mount(element) {
      let disposed = false;
      const render = async () => {
        const { sessions } = await request("/api/sessions");
        if (!disposed) element.textContent = `${sessions.length} sessions`;
      };
      void render();
      const timer = setInterval(render, 15000);
      return () => {
        disposed = true;
        clearInterval(timer);
      };
    },
  });
}
```

The console imports the bundle from `/plugins/<id>/panel.js` only while the plugin is active, and
mounts it into the slot. The token stays inside the console: the bundle gets an authenticated
`request` function, not credentials. Full contract in [Plugin UI](/guide/plugin-ui).

## Build a third example: a capability that links two services

Plugins can depend on more than one service. This one contributes a tool that reports the models the
runtime knows about, combining the `tools` and `models` services without importing either provider:

```js
export default {
  name: "@acme/plugin-model-list",
  version: "0.1.0",
  inject: ["tools", "models"],
  apply(context) {
    const tools = context.get("tools");
    const models = context.get("models");
    context.effect(() =>
      tools.register({
        schema: {
          name: "list_models",
          description: "List the models registered with this runtime.",
          permission: "auto",
          parameters: { type: "object", properties: {} },
        },
        execute() {
          const rows = models.list().map(
            (model) => `${model.id} (${model.provider})${model.supportsTools ? " · tools" : ""}`,
          );
          return { content: rows.join("\n") || "No models are registered." };
        },
      }),
    );
  },
};
```

`inject` waits for both services and re-runs the callback if either is replaced. This is how
plugins compose: a provider registers `models`, a consumer registers a tool that reads it, and the
kernel never needs to know about either package.

## Testing a plugin

Plugins are ordinary modules. A unit test can construct a context, load the plugin and assert the
contribution:

```ts
import { createContext } from "@kestrel/kernel";
import plugin from "../examples/plugins/clock-tool/index.js";

const context = createContext({ name: "test" });
const tools = new ToolRegistry();
context.provide("tools", tools);
context.plugin(plugin).ready();
expect(tools.get("clock_now")).toBeDefined();
```

For an end-to-end check, use the `ScriptedModel` from `@kestrel/testkit` and the server tests in
`apps/server/test/http.test.ts` as a template: boot a runtime with a temporary plugin directory,
register the plugin, and drive it through the HTTP API.

## Naming and distribution

- Use a scoped name such as `@yourorg/plugin-name`; the directory name is not significant.
- Ship compiled ESM if the plugin has dependencies, or plain ESM if it has none.
- Declare `requires` for plugin-to-plugin dependencies and `inject` for service dependencies; they
  are different: one orders plugin loading, the other waits for a service.
- Keep configuration under the plugin name in `plugins.config`; never read environment variables
  directly if a config key can express the same thing.

See [Writing a plugin](/guide/writing-plugins) for the full lifecycle and
[Plugin API](/reference/plugins) for manifest fields.
