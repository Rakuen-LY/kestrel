/**
 * Pure helpers behind the release scripts. They throw instead of exiting so
 * both the CLIs and the tests can drive them.
 */

/**
 * Moves everything under `## [Unreleased]` beneath a new dated heading and
 * leaves an empty unreleased section behind, which is what the release
 * workflow's changelog extraction expects.
 */
export function rollChangelog(source, version, date) {
  const heading = /^## \[Unreleased\][ \t]*$/m.exec(source);
  if (!heading) throw new Error("CHANGELOG.md has no `## [Unreleased]` heading.");
  const rest = source.slice(heading.index + heading[0].length);
  const nextSection = rest.search(/^## \[/m);
  if (nextSection < 0) throw new Error("CHANGELOG.md has no released section to anchor against.");
  const body = rest.slice(0, nextSection).trim();
  if (!/^[-*] /m.test(body)) throw new Error("Nothing under `## [Unreleased]` — write the changelog first.");
  return [
    source.slice(0, heading.index),
    "## [Unreleased]\n\n",
    `## [${version}] - ${date}\n\n`,
    body,
    "\n\n",
    rest.slice(nextSection),
  ].join("");
}

/**
 * Rewrites the top-level version field without re-serializing the file: a
 * release should not reformat manifests that happen to use compact arrays.
 * Returns the source unchanged when it already carries the requested version,
 * so `version:set` stays idempotent.
 */
export function withVersion(source, version) {
  if (!/^\s*"version":\s*"[^"]*"/m.test(source)) throw new Error('No top-level "version" field to rewrite.');
  return source.replace(/^(\s*)"version":\s*"[^"]*"/m, `$1"version": "${version}"`);
}
