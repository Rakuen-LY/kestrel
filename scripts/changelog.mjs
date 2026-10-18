#!/usr/bin/env node
/**
 * Extracts one release section from CHANGELOG.md for use as GitHub release
 * notes. Exits non-zero when the section is missing or still marked as a draft,
 * so a release never publishes an empty changelog.
 *
 * Usage: node scripts/changelog.mjs 0.2.0 > notes.md
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2]?.replace(/^v/, "");

if (!version) {
  console.error("Usage: node scripts/changelog.mjs <version>");
  process.exit(2);
}

const changelog = await readFile(join(repoRoot, "CHANGELOG.md"), "utf8");
const lines = changelog.split("\n");
const heading = lines.findIndex((line) => line.startsWith(`## [${version}]`));

if (heading === -1) {
  console.error(`CHANGELOG.md has no section for ${version}.`);
  process.exit(1);
}

const next = lines.findIndex((line, index) => index > heading && line.startsWith("## ["));
const section = lines.slice(heading + 1, next === -1 ? undefined : next);
const body = section.join("\n").trim();

if (!body) {
  console.error(`CHANGELOG.md section for ${version} is empty.`);
  process.exit(1);
}
if (/^###\s+(Added|Changed|Fixed|Removed)\s*\n\s*-?\s*(TODO|TBD)/i.test(body)) {
  console.error(`CHANGELOG.md section for ${version} is still a draft.`);
  process.exit(1);
}

process.stdout.write(`${body}\n`);
