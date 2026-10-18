import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ScriptedModel } from "@kestrel/testkit";
import type { PluginInfo } from "@kestrel/protocol";
import { createHttpServer } from "../src/http.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

beforeAll(() => {
  process.env.KESTREL_LOG_LEVEL ??= "silent";
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

interface Harness {
  base: string;
  root: string;
  runtime: Runtime;
  close(): Promise<void>;
}

async function boot(hotReload: boolean): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "kestrel-hot-reload-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const plugins = join(root, "plugins");
  await mkdir(join(plugins, "panel", "web"), { recursive: true });
  await writeFile(
    join(plugins, "panel", "kestrel.plugin.json"),
    JSON.stringify({ name: "@example/panel", version: "0.1.0", entry: "index.js", web: { entry: "panel.js" } }),
  );
  await writeFile(join(plugins, "panel", "index.js"), "export default { apply() {} };\n");
  await writeFile(join(plugins, "panel", "web", "panel.js"), 'export default () => "one";\n');

  const configPath = join(root, "kestrel.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      server: { host: "127.0.0.1", port: 0 },
      model: { default: "scripted", maxSteps: 2 },
      agent: { workspace: join(root, "workspace") },
      plugins: { directories: [plugins], hotReload, hotReloadIntervalMs: 250 },
      storage: { directory: join(root, "data") },
    }),
  );

  const runtime = await createRuntime({ configPath });
  runtime.models.register(new ScriptedModel([{ content: "ok" }]), { setDefault: true });
  const server: Server = createHttpServer(runtime);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    base,
    root,
    runtime,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.shutdown();
    },
  };
}

async function panel(base: string): Promise<PluginInfo | undefined> {
  const body = (await (await fetch(`${base}/api/plugins`)).json()) as { plugins: PluginInfo[] };
  return body.plugins.find((plugin) => plugin.id === "@example/panel");
}

/** Minimal SSE reader: returns complete frames that satisfy a predicate. */
async function openStream(url: string): Promise<{
  until(predicate: (frame: string) => boolean, timeoutMs?: number): Promise<string>;
  close(): void;
}> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async until(predicate, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary < 0) break;
          const frame = buffer.slice(0, boundary + 2);
          buffer = buffer.slice(boundary + 2);
          if (predicate(frame)) return frame;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Timed out waiting for a matching frame.");
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Timed out waiting for a matching frame.")), remaining),
          ),
        ]);
        if (chunk.done) throw new Error("The stream ended early.");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    close: () => controller.abort(),
  };
}

describe("plugin asset hot reload", () => {
  it("publishes and refreshes a revision while watching", async () => {
    const harness = await boot(true);
    cleanups.push(harness.close);

    const first = await panel(harness.base);
    expect(first?.web?.revision).toEqual(expect.any(String));
    const revision = first!.web!.revision;

    const stream = await openStream(`${harness.base}/api/plugins/events`);
    cleanups.push(async () => stream.close());
    const ready = await stream.until((frame) => frame.includes("event: ready"));
    expect(ready).toContain('"enabled":true');

    await writeFile(join(harness.root, "plugins", "panel", "web", "panel.js"), 'export default () => "two";\n');
    const changed = await stream.until((frame) => frame.includes("event: plugins.changed"));
    expect(changed).toContain("@example/panel");
    expect(changed).not.toContain(revision);

    const after = await panel(harness.base);
    expect(after?.web?.revision).toEqual(expect.any(String));
    expect(after?.web?.revision).not.toBe(revision);
  });

  it("reports a disabled channel when the feature is off", async () => {
    const harness = await boot(false);
    cleanups.push(harness.close);
    expect((await panel(harness.base))?.web?.revision).toBeUndefined();

    const stream = await openStream(`${harness.base}/api/plugins/events`);
    cleanups.push(async () => stream.close());
    const ready = await stream.until((frame) => frame.includes("event: ready"));
    expect(ready).toContain('"enabled":false');
  });
});
