import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KESTREL_VERSION } from "../src/version.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Every package.json under the globs declared in pnpm-workspace.yaml. */
async function workspaceManifests(): Promise<string[]> {
  const workspace = await readFile(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  const globs = workspace
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).replace(/^["']|["']$/g, ""));
  const manifests: string[] = [];
  for (const pattern of globs) {
    const directory = join(repoRoot, pattern.replace(/\/\*$/, ""));
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(directory, entry.name, "package.json");
      // packages/testkit is an alias-only workspace entry with no manifest.
      if (await stat(manifest).catch(() => undefined)) manifests.push(manifest);
    }
  }
  return manifests;
}

async function rootVersion(): Promise<string> {
  const root = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { version: string };
  return root.version;
}

describe("version", () => {
  it("is a plain semver string", () => {
    expect(KESTREL_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it("matches the root package version", async () => {
    expect(KESTREL_VERSION).toBe(await rootVersion());
  });

  it("matches every workspace package", async () => {
    const expected = await rootVersion();
    const drifted: string[] = [];
    for (const manifest of await workspaceManifests()) {
      const pkg = JSON.parse(await readFile(manifest, "utf8")) as { name: string; version?: string };
      if (pkg.version !== expected) drifted.push(`${pkg.name}@${pkg.version ?? "missing"}`);
    }
    expect(drifted).toEqual([]);
  });
});
