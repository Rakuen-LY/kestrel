#!/usr/bin/env node
/**
 * Cuts a release locally: rolls `## [Unreleased]` into a dated section, bumps
 * the version everywhere, commits, and creates the annotated tag that triggers
 * `.github/workflows/release.yml`.
 *
 * Everything except `git push` is automated, and pushing is the one step that
 * needs a credential the repository cannot hold.
 *
 *   pnpm release:prepare 0.2.0 --dry-run
 *   pnpm release:prepare 0.2.0
 *   pnpm release:prepare 0.2.0 --sign      # requires a configured signing key
 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((argument) => argument.startsWith("--")));
const version = argv.find((argument) => !argument.startsWith("--"));
const dryRun = flags.has("--dry-run");
const sign = flags.has("--sign");

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function git(...args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function step(message) {
  console.log(`${dryRun ? "[dry run] " : ""}${message}`);
}

function readme(path) {
  return readFile(join(repoRoot, path), "utf8");
}

function compare(left, right) {
  const parse = (value) => value.split("-")[0].split(".").map(Number);
  const [a, b] = [parse(left), parse(right)];
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Moves everything under `## [Unreleased]` beneath a new dated heading and
 * leaves an empty unreleased section behind, which is what the workflow's
 * changelog extraction expects.
 */
function rollChangelog(source, nextVersion, date) {
  const heading = /^## \[Unreleased\][ \t]*$/m.exec(source);
  if (!heading) fail("CHANGELOG.md has no `## [Unreleased]` heading.");
  const rest = source.slice(heading.index + heading[0].length);
  const nextSection = rest.search(/^## \[/m);
  if (nextSection < 0) fail("CHANGELOG.md has no released section to anchor against.");
  const body = rest.slice(0, nextSection).trim();
  if (!/^[-*] /m.test(body)) fail("Nothing under `## [Unreleased]` — write the changelog first.");
  return [
    source.slice(0, heading.index),
    "## [Unreleased]\n\n",
    `## [${nextVersion}] - ${date}\n\n`,
    body,
    "\n\n",
    rest.slice(nextSection),
  ].join("");
}

if (!version || !SEMVER.test(version)) {
  fail("Usage: pnpm release:prepare <version> [--dry-run] [--sign]");
}

const current = JSON.parse(await readme("package.json")).version;
if (compare(version, current) <= 0) {
  fail(`Version ${version} must be greater than the current ${current}.`);
}

const tag = `v${version}`;
if (git("tag", "--list", tag)) fail(`Tag ${tag} already exists.`);

if (!dryRun) {
  const dirty = git("status", "--porcelain");
  if (dirty) fail(`Working tree is not clean:\n${dirty}\n\nCommit or stash first, or use --dry-run.`);
  git("rev-parse", "--verify", "HEAD");
}

const today = new Date().toISOString().slice(0, 10);
const rolled = rollChangelog(await readme("CHANGELOG.md"), version, today);
const branch = (() => {
  try {
    return git("rev-parse", "--abbrev-ref", "HEAD");
  } catch {
    return "HEAD";
  }
})();

step(`version ${current} -> ${version}`);
step(`changelog: ## [Unreleased] -> ## [${version}] - ${today}`);
step(`commit: chore(release): ${version} on ${branch}`);
step(`tag: ${tag}${sign ? " (signed)" : " (annotated)"}`);

if (dryRun) {
  const start = rolled.indexOf("## [Unreleased]");
  const end = rolled.indexOf(`## [${version}]`) + 40;
  console.log(`\n--- changelog preview ---\n${rolled.slice(start, end).trimEnd()}\n-------------------------`);
  process.exit(0);
}

await writeFile(join(repoRoot, "CHANGELOG.md"), rolled);
step("wrote CHANGELOG.md");

execFileSync("node", [join(repoRoot, "scripts/version.mjs"), version], { cwd: repoRoot, stdio: "inherit" });
execFileSync("node", [join(repoRoot, "scripts/version.mjs"), "--check"], { cwd: repoRoot, stdio: "inherit" });

// Refuse to tag a section the release workflow would publish as an empty body.
execFileSync("node", [join(repoRoot, "scripts/changelog.mjs"), version], { cwd: repoRoot, stdio: "ignore" });
step("changelog section extracts cleanly");

git("add", "--all");
git("commit", "--message", `chore(release): ${version}`, "--message", `Version ${version}. Release notes come from CHANGELOG.md.`);
step("committed");

if (sign) {
  git("tag", "--sign", tag, "--message", `Kestrel ${version}`);
} else {
  git("tag", "--annotate", tag, "--message", `Kestrel ${version}`);
}
step(`tagged ${tag}`);

console.log(`
Release ${version} is prepared and tagged locally.

Remaining step — push the commit and the tag together:

  git push --follow-tags origin ${branch}

The tag starts .github/workflows/release.yml, which re-runs the full suite,
publishes ghcr.io/<owner>/<repo>:${version} (amd64 + arm64, signed), and
creates the GitHub release.`);
