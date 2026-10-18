# Writing a plugin

This walkthrough builds a plugin that adds a `word_count` tool and a service other plugins can
consume. It assumes TypeScript and pnpm, but the result is ordinary ESM and works from plain
JavaScript too.

## 1. Create the package

```
plugins/word-count/
  kestrel.plugin.json
  package.json
  src/index.ts
```

`package.json`:

```json
{
  "name": "@acme/plugin-word-count",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsup src/index.ts --format esm --clean --sourcemap --dts"
  },
  "devDependencies": {
    "@kestrel/agent": "workspace:*",
    "@kestrel/kernel": "workspace:*",
    "tsup": "^9.0.0",
    "typescript": "^5.9.0"
  }
}
```

`kestrel.plugin.json`:

```json
{
  "name": "@acme/plugin-word-count",
  "version": "0.1.0",
  "description": "Counts words and exposes a wordCount service.",
  "entry": "dist/index.js",
  "inject": ["tools"]
}
```

Because the directory lives under `plugins/`, the workspace already includes it. Run
`pnpm install` and `pnpm --filter @acme/plugin-word-count build`. During development the host falls
back to `src/index.ts` when no build exists, which `tsx` can execute directly.

## 2. Implement `apply`

```ts
import type { Tool } from "@kestrel/agent";
import type { PluginDefinition } from "@kestrel/kernel";

export interface WordCountConfig {
  /** Reject inputs larger than this many characters. */
  maxChars?: number;
}

const countWords = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

export default {
  name: "@acme/plugin-word-count",
  version: "0.1.0",
  description: "Counts words and exposes a wordCount service.",
  inject: ["tools"],

  apply(context, config: WordCountConfig = {}) {
    const maxChars = config.maxChars ?? 1_000_000;

    context.provide("wordCount", {
      count: (text: string) => {
        if (text.length > maxChars) throw new Error(`Input exceeds ${maxChars} characters.`);
        return countWords(text);
      },
    });

    const tool: Tool = {
      schema: {
        name: "word_count",
        description: "Count words in a piece of text.",
        category: "text",
        permission: "auto",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to analyse." },
          },
          required: ["text"],
          additionalProperties: false,
        },
      },
      execute(args) {
        const text = typeof args.text === "string" ? args.text : "";
        return {
          content: `${countWords(text)} words`,
          data: { words: countWords(text), characters: text.length },
        };
      },
    };

    context.effect(() => context.get("tools").register(tool));
    context.logger.info("word_count tool registered", { maxChars });
  },
} satisfies PluginDefinition<WordCountConfig>;
```

Three details are worth noticing:

1. `context.effect` runs the registration immediately and attaches the returned disposer to the
   plugin scope. When the plugin is disposed, the tool disappears from the registry.
2. The schema uses `additionalProperties: false`. The runtime validates arguments before execution,
   so the model gets a precise error instead of a runtime exception.
3. The service is a plain object. Services are values, not classes; keep them small and explicit.

## 3. Compose with another plugin's service

A second plugin can consume `wordCount` without importing the first:

```ts
export default {
  name: "@acme/plugin-reading-level",
  version: "0.1.0",
  inject: ["wordCount"],
  apply(context) {
    context.provide("readingLevel", {
      score: (text: string) => Math.min(100, context.get<{ count(text: string): number }>("wordCount").count(text) / 2),
    });
  },
};
```

The host may load them in either order. If `wordCount` is removed, the dependent injection is
disposed automatically.

## 4. Expose an HTTP endpoint

A plugin can extend the server's API through the `http.routes` service. Paths must live under
`/api/`, so a plugin can never shadow the console or a static asset:

```ts
export default {
  name: "@acme/plugin-webhooks",
  version: "0.1.0",
  inject: ["http.routes"],
  apply(context) {
    const routes = context.get("http.routes");
    context.effect(() =>
      routes.route({
        method: "GET",
        path: "/api/webhooks/:id/deliveries",
        handler: async (request) => ({
          status: 200,
          body: { id: request.params.id, limit: Number(request.query.limit ?? 20) },
        }),
      }),
    );
  },
};
```

The handler receives the path params, query, headers, parsed JSON body and the authenticated
`principal` (unless the route is marked `public`). Return `{ status, body }` for JSON. For text
formats, return `{ raw, headers: { "content-type": "text/plain" } }`; `raw` is written verbatim.
Throwing is a `500` with `plugin_route_failed`, so validate input and return `4xx` instead.

Two rules keep plugin APIs predictable:

- Routes are registered in load order; the first registration of a path wins.
- A route is private by default. Mark it `public: true` only for content that is safe without a
  token, and authenticate secrets yourself (the triggers plugin compares an HMAC-like header with
  `timingSafeEqual`).

## 5. Add a model provider

A provider is a plugin that registers a `LanguageModel`:

```ts
import type { CompletionResponse, LanguageModel } from "@kestrel/agent";

const model: LanguageModel = {
  info: {
    id: "acme-small",
    provider: "acme",
    label: "Acme Small",
    supportsTools: true,
    supportsReasoning: false,
  },
  async generate(request, onDelta) {
    const response = await fetch("https://api.acme.dev/v1/chat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.ACME_KEY}` },
      body: JSON.stringify({ messages: request.messages, tools: request.tools, stream: true }),
      signal: request.signal,
    });
    // ...parse the stream and call onDelta({ channel: "text", delta })...
    return response as unknown as CompletionResponse;
  },
};

export default {
  name: "@acme/plugin-model",
  version: "0.1.0",
  inject: ["models"],
  apply(context) {
    context.effect(() => context.get("models").register(model));
  },
};
```

`generate` must:

- honour `request.signal` (the cancel button aborts it);
- call `onDelta` for text and reasoning tokens when streaming;
- return the full content, assembled tool calls and token usage;
- throw on transport errors; the runtime marks the run `error` and emits `run.failed`.

See [Models & providers](/guide/models) for the full contract.

## 6. Test it

`@kestrel/testkit` provides a scripted model and helpers. Build a context with the services the
plugin injects, start it, and assert on the registry:

```ts
import { describe, expect, it } from "vitest";
import { createContext, silencedLogger } from "@kestrel/kernel";
import { ModelRegistry, ToolRegistry } from "@kestrel/agent";
import plugin from "../src/index.js";

describe("word-count", () => {
  it("registers the tool", async () => {
    const context = createContext({
      name: "test",
      logger: silencedLogger(),
      services: { tools: new ToolRegistry(), models: new ModelRegistry() },
    });

    await context.plugin(plugin, { maxChars: 100 }).ready();

    const tools = context.get<ToolRegistry>("tools");
    const result = await tools.get("word_count")!.execute(
      { text: "one two three" },
      {
        session: { id: "s", workspace: process.cwd(), messages: [], metadata: new Map() },
        callId: "call-1",
        signal: new AbortController().signal,
        logger: context.logger,
        progress: () => undefined,
      },
    );

    expect(result.content).toBe("3 words");
    await context.dispose();
  });
});
```

For full-loop tests, construct a `SessionManager` with a `ScriptedModel`; see
`packages/agent/test/session.test.ts` for a working example. Run the suite with `pnpm test`.

## 7. Ship it

- Build with `tsup` so the entry is a single ESM file.
- Keep `@kestrel/*` packages external; the host provides them at runtime.
- Add the plugin directory to `KESTREL_PLUGINS`, or install it into a directory the host scans.
- Document the configuration keys and the services it provides.
- Reference providers through `inject` rather than importing across packages.

## Guidelines

| Do | Don't |
| --- | --- |
| Register through `context.effect` | Create global timers or listeners without disposal |
| Throw a clear message from `apply` | Swallow configuration errors |
| Validate tool arguments and return structured errors | Assume the model sends well-formed JSON |
| Keep services narrow | Publish a god-object "context" service |
| Respect `AbortSignal` | Ignore cancellation in long operations |
| Use the manifest for defaults | Read ad-hoc environment variables in every call |

Plugins run in the same process as the agent. Treat third-party plugins as trusted code and review
them, or run the whole agent inside a sandbox. See [Security](/guide/security).
