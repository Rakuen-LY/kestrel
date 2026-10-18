import { mkdtemp, mkdir, cp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createContext, silencedLogger } from "@kestrel/kernel";
import { PluginHost } from "../src/index.js";

const logger = silencedLogger();
const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function makeRoot(names: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kestrel-plugins-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const name of names) {
    await mkdir(join(root, name));
    await cp(join(fixtures, name), join(root, name), { recursive: true });
  }
  return root;
}

function host(root: string, options: Partial<ConstructorParameters<typeof PluginHost>[0]> = {}) {
  const context = createContext({ logger });
  return {
    context,
    host: new PluginHost({ context, logger, directories: [root], ...options }),
  };
}

async function makeWebPlugin(web: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kestrel-plugin-web-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "webby");
  await mkdir(join(directory, "web"), { recursive: true });
  await writeFile(
    join(directory, "kestrel.plugin.json"),
    JSON.stringify({ name: "fixture-web", version: "1.0.0", entry: "index.js", web }),
  );
  await writeFile(join(directory, "index.js"), "export default { apply() {} };\n");
  await writeFile(join(directory, "web", "panel.js"), "export default 1;\n");
  await writeFile(join(directory, "web", "panel.css"), "");
  return root;
}

describe("PluginHost browser contributions", () => {
  it("resolves an object declaration against web/ and keeps existing css", async () => {
    const root = await makeWebPlugin({ entry: "panel.js", css: ["panel.css", "missing.css"] });
    const { host: instance } = host(root);
    const info = (await instance.discover())[0];
    expect(info.web).toEqual({ entry: "panel.js", css: ["panel.css"] });
  });

  it("accepts the string shorthand", async () => {
    const root = await makeWebPlugin("panel.js");
    const { host: instance } = host(root);
    expect((await instance.discover())[0].web).toEqual({ entry: "panel.js" });
  });

  it("keeps valid api grants and drops malformed ones", async () => {
    const root = await makeWebPlugin({
      entry: "panel.js",
      api: ["GET /api/sessions", "get /api/plugins", "* /api/tools", 42, "GET /etc/passwd", "/api/x"],
    });
    const { host: instance } = host(root);
    expect((await instance.discover())[0].web).toEqual({
      entry: "panel.js",
      api: ["GET /api/sessions", "get /api/plugins", "* /api/tools"],
    });
  });

  it("keeps known capabilities and drops unknown ones", async () => {
    const root = await makeWebPlugin({
      entry: "panel.js",
      capabilities: ["composer.submit", "filesystem.root", 42],
    });
    const { host: instance } = host(root);
    expect((await instance.discover())[0].web).toEqual({
      entry: "panel.js",
      capabilities: ["composer.submit"],
    });
  });

  it("keeps an explicit empty grant list", async () => {
    const root = await makeWebPlugin({ entry: "panel.js", api: [] });
    const { host: instance } = host(root);
    expect((await instance.discover())[0].web).toEqual({ entry: "panel.js", api: [] });
  });

  it("ignores entries that point outside web/ or do not exist", async () => {
    for (const web of ["../panel.js", { entry: "/etc/passwd" }, { entry: "missing.js" }, 42]) {
      const root = await makeWebPlugin(web);
      const { host: instance } = host(root);
      expect((await instance.discover())[0].web).toBeUndefined();
    }
  });
});

describe("PluginHost discovery", () => {
  it("reads manifests from a directory", async () => {
    const root = await makeRoot(["alpha", "beta"]);
    const { host: instance } = host(root, { applyTimeoutMs: 2_000 });
    const infos = await instance.discover();
    expect(infos.map((info) => info.name).sort()).toEqual(["fixture-alpha", "fixture-beta"]);
    expect(infos.find((info) => info.name === "fixture-alpha")?.state).toBe("waiting");
    expect(infos.find((info) => info.name === "fixture-beta")?.dependencies).toEqual(["fixture-alpha"]);
  });

  it("loads dependencies before dependents", async () => {
    const root = await makeRoot(["alpha", "beta"]);
    const { host: instance, context } = host(root, { applyTimeoutMs: 2_000 });
    await instance.discover();
    const active = await instance.loadAll();
    expect(active.every((info) => info.state === "active")).toBe(true);
    expect(context.has("alpha")).toBe(true);
    const alpha = instance.list().find((info) => info.name === "fixture-alpha");
    expect(alpha?.state).toBe("active");
  });

  it("merges manifest and user configuration", async () => {
    const root = await makeRoot(["alpha"]);
    const { host: instance } = host(root, {
      config: { "fixture-alpha": { greeting: "bonjour" } },
      applyTimeoutMs: 2_000,
    });
    await instance.discover();
    await instance.load("fixture-alpha");
    const alpha = instance.get("fixture-alpha");
    expect(alpha?.error).toBeUndefined();
    expect(alpha?.state).toBe("active");
  });

  it("marks plugins with missing dependencies as errored", async () => {
    const root = await makeRoot(["orphan", "alpha"]);
    const { host: instance } = host(root, { applyTimeoutMs: 2_000 });
    await instance.discover();
    const infos = await instance.loadAll();
    const orphan = infos.find((info) => info.name === "fixture-orphan");
    expect(orphan?.state).toBe("error");
    expect(orphan?.error).toContain("missing-plugin");
    expect(infos.find((info) => info.name === "fixture-alpha")?.state).toBe("active");
  });

  it("records plugin failures without crashing the host", async () => {
    const root = await makeRoot(["alpha", "broken"]);
    const { host: instance } = host(root, { applyTimeoutMs: 2_000 });
    await instance.discover();
    const results = [];
    for (const info of instance.list()) {
      try {
        results.push(await instance.load(info.name));
      } catch {
        results.push(instance.get(info.name));
      }
    }
    const broken = results.find((info) => info?.name === "fixture-broken");
    expect(broken?.state).toBe("error");
    expect(broken?.error).toContain("intentional failure");
  });

  it("honours the allow list", async () => {
    const root = await makeRoot(["alpha", "beta"]);
    const { host: instance } = host(root, { allow: ["fixture-alpha"], applyTimeoutMs: 2_000 });
    const infos = await instance.discover();
    expect(infos.map((info) => info.name)).toEqual(["fixture-alpha"]);
  });

  it("disposes plugins in reverse order", async () => {
    const root = await makeRoot(["alpha", "beta"]);
    const { host: instance, context } = host(root, { applyTimeoutMs: 2_000 });
    await instance.discover();
    await instance.loadAll();
    expect(instance.list().every((info) => info.state === "active")).toBe(true);
    await instance.dispose();
    expect(instance.list().every((info) => info.state === "disposed")).toBe(true);
    await context.dispose();
  });
});
