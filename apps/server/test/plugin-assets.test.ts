import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "@kestrel/kernel";
import type { PluginInfo } from "@kestrel/protocol";
import { PluginAssetWatcher, fingerprint } from "../src/plugin-assets.js";

const logger = createLogger({ level: "silent" });
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function pluginDir(id = "@test/plugin-ui"): Promise<{ root: string; plugin: PluginInfo }> {
  const root = await mkdtemp(join(tmpdir(), "kestrel-assets-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "web", "lib"), { recursive: true });
  await writeFile(join(root, "web", "panel.js"), "export default () => {};\n");
  await writeFile(join(root, "web", "lib", "helper.js"), "export const x = 1;\n");
  return {
    root,
    plugin: {
      id,
      name: id,
      version: "0.1.0",
      state: "active",
      dependencies: [],
      source: "local",
      path: root,
      web: { entry: "panel.js" },
    },
  };
}

describe("fingerprint", () => {
  it("is stable across scans and changes with file contents", async () => {
    const { root } = await pluginDir();
    const first = await fingerprint(join(root, "web"));
    const second = await fingerprint(join(root, "web"));
    expect(first).toBeDefined();
    expect(second).toBe(first);

    await writeFile(join(root, "web", "lib", "helper.js"), "export const x = 22;\n");
    expect(await fingerprint(join(root, "web"))).not.toBe(first);
  });

  it("covers nested files and ignores hidden ones", async () => {
    const { root } = await pluginDir();
    const before = await fingerprint(join(root, "web"));
    await writeFile(join(root, "web", ".cache"), "ignored");
    expect(await fingerprint(join(root, "web"))).toBe(before);

    await writeFile(join(root, "web", "lib", "extra.js"), "export const y = 2;\n");
    expect(await fingerprint(join(root, "web"))).not.toBe(before);
  });

  it("returns undefined when web/ is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "kestrel-assets-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    expect(await fingerprint(join(root, "web"))).toBeUndefined();
  });
});

describe("PluginAssetWatcher", () => {
  let plugins: PluginInfo[];

  beforeEach(async () => {
    const created = await pluginDir();
    plugins = [created.plugin];
  });

  it("establishes a baseline without reporting changes", async () => {
    const watcher = new PluginAssetWatcher({ plugins: () => plugins, logger });
    expect(await watcher.scan()).toEqual([]);
    expect(watcher.revisionFor(plugins[0].id)).toBeDefined();
    expect(watcher.snapshot()).toEqual([
      { id: plugins[0].id, revision: expect.any(String) },
    ]);
  });

  it("reports a change once and updates the snapshot", async () => {
    const watcher = new PluginAssetWatcher({ plugins: () => plugins, logger });
    await watcher.scan();
    const before = watcher.revisionFor(plugins[0].id);

    const seen: string[] = [];
    watcher.subscribe((change) => seen.push(change.id));

    await writeFile(join(plugins[0].path!, "web", "panel.js"), "export default () => 'v2';\n");
    const changes = await watcher.scan();
    expect(changes).toHaveLength(1);
    expect(changes[0].id).toBe(plugins[0].id);
    expect(changes[0].revision).not.toBe(before);
    expect(seen).toEqual([plugins[0].id]);
    expect(watcher.revisionFor(plugins[0].id)).toBe(changes[0].revision);

    expect(await watcher.scan()).toEqual([]);
    expect(seen).toEqual([plugins[0].id]);
  });

  it("skips plugins without web assets and drops departed ones", async () => {
    const watcher = new PluginAssetWatcher({ plugins: () => plugins, logger });
    await watcher.scan();
    expect(watcher.revisionFor(plugins[0].id)).toBeDefined();

    plugins = [{ ...plugins[0], state: "error" }];
    await watcher.scan();
    expect(watcher.revisionFor(plugins[0].id)).toBeUndefined();
  });

  it("does not overlap scans", async () => {
    const watcher = new PluginAssetWatcher({ plugins: () => plugins, logger });
    await watcher.scan();
    const [a, b] = await Promise.all([watcher.scan(), watcher.scan()]);
    expect(a.length + b.length).toBeLessThanOrEqual(1);
  });
});
