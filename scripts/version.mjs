#!/usr/bin/env node
/**
 * Bumps the product version everywhere it is recorded, or verifies that the
 * records agree. Run `pnpm version:set 0.2.0` before tagging a release.
 */
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withVersion } from "./lib/changelog.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

async function manifestPaths() {
  const workspace = await readFile(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  const globs = workspace
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).replace(/^["']|["']$/g, ""));
  const paths = [join(repoRoot, "package.json")];
  for (const pattern of globs) {
    const directory = join(repoRoot, pattern.replace(/\/\*$/, ""));
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(directory, entry.name, "package.json");
      // packages/testkit is an alias-only workspace entry with no manifest.
      if (await stat(manifest).catch(() => undefined)) paths.push(manifest);
    }
  }
  return paths;
}

async function readManifest(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function rootVersion() {
  return (await readManifest(join(repoRoot, "package.json"))).version;
}

async function check() {
  const expected = await rootVersion();
  const problems = [];
  if (!SEMVER.test(expected)) problems.push(`root package.json: invalid version ${expected}`);
  for (const path of await manifestPaths()) {
    const pkg = await readManifest(path);
    if (pkg.version !== expected) problems.push(`${pkg.name}: ${pkg.version ?? "missing"} (expected ${expected})`);
  }
  const source = await readFile(join(repoRoot, "packages/protocol/src/version.ts"), "utf8");
  const constant = /export const KESTREL_VERSION = "([^"]+)"/.exec(source)?.[1];
  if (constant !== expected) {
    problems.push(`packages/protocol/src/version.ts: ${constant ?? "missing"} (expected ${expected})`);
  }
  if (problems.length) {
    console.error(`Version drift detected. Run \`pnpm version:set ${expected}\`.\n`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`Version ${expected} is consistent across every manifest.`);
}

async function set(requested) {
  if (!SEMVER.test(requested)) {
    console.error(`Not a semver version: ${requested}`);
    process.exit(2);
  }
  for (const path of await manifestPaths()) {
    const source = await readFile(path, "utf8");
    const next = withVersion(source, requested);
    if (next !== source) await writeFile(path, next);
  }
  const sourcePath = join(repoRoot, "packages/protocol/src/version.ts");
  const source = await readFile(sourcePath, "utf8");
  const next = source.replace(
    /export const KESTREL_VERSION = "[^"]+";/,
    `export const KESTREL_VERSION = "${requested}";`,
  );
  if (next === source) {
    const constant = /export const KESTREL_VERSION = "([^"]+)"/.exec(source)?.[1];
    if (constant !== requested) {
      console.error(`Could not rewrite the version constant in ${sourcePath}.`);
      process.exit(2);
    }
  } else {
    await writeFile(sourcePath, next);
  }
  console.log(`Version set to ${requested}. Update CHANGELOG.md before tagging.`);
}

const [argument] = process.argv.slice(2);
if (argument === undefined || argument === "--check") await check();
else await set(argument);
