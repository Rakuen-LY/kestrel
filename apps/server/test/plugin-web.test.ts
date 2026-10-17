import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ScriptedModel } from "@kestrel/testkit";
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
  runtime: Runtime;
  close(): Promise<void>;
}

async function writePlugin(root: string, folder: string, name: string, web?: unknown): Promise<void> {
  const directory = join(root, folder);
  await mkdir(join(directory, "web", "nested"), { recursive: true });
  await writeFile(
    join(directory, "kestrel.plugin.json"),
    JSON.stringify({ name, version: "0.1.0", entry: "index.js", web }),
  );
  await writeFile(join(directory, "index.js"), "export default { apply() {} };\n");
  await writeFile(join(directory, "web", "panel.js"), 'export default () => "panel";\n');
  await writeFile(join(directory, "web", "panel.css"), ".panel { color: red; }\n");
  await writeFile(join(directory, "web", "nested", "deep.js"), "export const deep = true;\n");
}

async function boot(token?: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "kestrel-plugin-web-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const plugins = join(root, "plugins");
  await mkdir(plugins, { recursive: true });
  await writePlugin(plugins, "panel", "@example/panel", { entry: "panel.js", css: ["panel.css"] });
  await writePlugin(plugins, "plain", "plain");
  await writePlugin(plugins, "escaping", "escaping", { entry: "../panel.js" });

  const configPath = join(root, "kestrel.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      server: { host: "127.0.0.1", port: 0, ...(token ? { token } : {}) },
      model: { default: "scripted", maxSteps: 2 },
      agent: { workspace: join(root, "workspace") },
      plugins: { directories: [plugins] },
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
    runtime,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.shutdown();
    },
  };
}

describe("plugin browser bundles", () => {
  it("publishes web metadata for active plugins only", async () => {
    const harness = await boot();
    cleanups.push(harness.close);

    const { plugins } = (await (await fetch(`${harness.base}/api/plugins`)).json()) as {
      plugins: Array<{ id: string; state: string; web?: { entry: string; css?: string[] } }>;
    };
    const panel = plugins.find((plugin) => plugin.id === "@example/panel");
    expect(panel?.state).toBe("active");
    expect(panel?.web).toEqual({ entry: "panel.js", css: ["panel.css"] });

    expect(plugins.find((plugin) => plugin.id === "plain")?.web).toBeUndefined();
    // A manifest pointing outside web/ is ignored rather than served.
    const escaping = plugins.find((plugin) => plugin.id === "escaping");
    expect(escaping?.state).toBe("active");
    expect(escaping?.web).toBeUndefined();
  });

  it("serves entry, styles and nested assets with the right types", async () => {
    const harness = await boot();
    cleanups.push(harness.close);
    const base = `${harness.base}/plugins/${encodeURIComponent("@example/panel")}`;

    const script = await fetch(`${base}/panel.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(await script.text()).toContain("panel");

    const styles = await fetch(`${base}/panel.css`);
    expect(styles.headers.get("content-type")).toContain("text/css");

    const nested = await fetch(`${base}/nested/deep.js`);
    expect(nested.status).toBe(200);
    expect(await nested.text()).toContain("deep");

    const head = await fetch(`${base}/panel.js`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("refuses traversal, unknown plugins and plugins without a bundle", async () => {
    const harness = await boot();
    cleanups.push(harness.close);
    const base = harness.base;

    expect((await fetch(`${base}/plugins/${encodeURIComponent("@example/panel")}/..%2F..%2Fsecret`)).status).toBe(403);
    expect((await fetch(`${base}/plugins/${encodeURIComponent("@example/panel")}/%2e%2e%2f%2e%2e%2fpackage.json`)).status).toBe(403);
    expect((await fetch(`${base}/plugins/does-not-exist/panel.js`)).status).toBe(404);
    expect((await fetch(`${base}/plugins/plain/panel.js`)).status).toBe(404);
    expect((await fetch(`${base}/plugins`)).status).toBe(404);
  });

  it("serves bundles publicly while the API requires the token", async () => {
    const harness = await boot("secret-token");
    cleanups.push(harness.close);
    const asset = await fetch(`${harness.base}/plugins/${encodeURIComponent("@example/panel")}/panel.js`);
    expect(asset.status).toBe(200);
    expect((await fetch(`${harness.base}/api/sessions`)).status).toBe(401);
    const api = await fetch(`${harness.base}/api/sessions`, {
      headers: { authorization: "Bearer secret-token" },
    });
    expect(api.status).toBe(200);
  });
});
