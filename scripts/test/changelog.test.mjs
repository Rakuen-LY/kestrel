import { describe, expect, it } from "vitest";
import { rollChangelog, withVersion } from "../lib/changelog.mjs";

const HEADER = "# Changelog\n\nAll notable changes to Kestrel are documented here.\n\n";

const UNRELEASED = `${HEADER}## [Unreleased]

### Added

- A new thing.
- Another thing.

### Fixed

- A bug.

## [0.1.0] - 2026-01-01

### Added

- The beginning.

## [0.0.1] - 2025-12-01

- Earlier.
`;

describe("rollChangelog", () => {
  it("moves the unreleased body under a dated heading", () => {
    const rolled = rollChangelog(UNRELEASED, "0.2.0", "2026-02-03");
    expect(rolled).toContain("## [0.2.0] - 2026-02-03\n\n### Added\n\n- A new thing.");
    expect(rolled).toContain("### Fixed\n\n- A bug.");
  });

  it("leaves an empty unreleased section on top", () => {
    const rolled = rollChangelog(UNRELEASED, "0.2.0", "2026-02-03");
    expect(rolled.startsWith(`${HEADER}## [Unreleased]\n\n## [0.2.0] - 2026-02-03`)).toBe(true);
  });

  it("keeps released history intact below the new section", () => {
    const rolled = rollChangelog(UNRELEASED, "0.2.0", "2026-02-03");
    expect(rolled.endsWith("## [0.1.0] - 2026-01-01\n\n### Added\n\n- The beginning.\n\n## [0.0.1] - 2025-12-01\n\n- Earlier.\n")).toBe(true);
  });

  it("is stable when the result is rolled again", () => {
    const once = rollChangelog(UNRELEASED, "0.2.0", "2026-02-03");
    const withNext = once.replace("## [Unreleased]\n\n", "## [Unreleased]\n\n### Added\n\n- Later.\n\n");
    const twice = rollChangelog(withNext, "0.3.0", "2026-03-04");
    const sections = [...twice.matchAll(/^## \[([^\]]+)\]/gm)].map((match) => match[1]);
    expect(sections).toEqual(["Unreleased", "0.3.0", "0.2.0", "0.1.0", "0.0.1"]);
  });

  it("refuses an empty unreleased section", () => {
    expect(() => rollChangelog(`${HEADER}## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\n- Old.\n`, "0.2.0", "2026-02-03")).toThrow(
      /Nothing under/i,
    );
  });

  it("refuses a changelog without an unreleased heading", () => {
    expect(() => rollChangelog(`${HEADER}## [0.1.0] - 2026-01-01\n\n- Old.\n`, "0.2.0", "2026-02-03")).toThrow(
      /Unreleased/,
    );
  });

  it("refuses a changelog with no released section to anchor against", () => {
    expect(() => rollChangelog(`${HEADER}## [Unreleased]\n\n- New.\n`, "0.2.0", "2026-02-03")).toThrow(/anchor/);
  });
});

describe("withVersion", () => {
  it("rewrites only the version field", () => {
    const source = '{\n  "name": "@kestrel/kernel",\n  "version": "0.1.0",\n  "files": ["dist"]\n}\n';
    expect(withVersion(source, "0.2.0")).toBe(
      '{\n  "name": "@kestrel/kernel",\n  "version": "0.2.0",\n  "files": ["dist"]\n}\n',
    );
  });

  it("preserves compact arrays that a re-serialization would expand", () => {
    const source = '{\n  "version": "0.1.0",\n  "files": ["dist"]\n}\n';
    expect(withVersion(source, "0.2.0")).toContain('"files": ["dist"]');
  });

  it("is idempotent", () => {
    const source = '{\n  "version": "0.2.0"\n}\n';
    expect(withVersion(source, "0.2.0")).toBe(source);
  });

  it("refuses a manifest without a version field", () => {
    expect(() => withVersion('{\n  "name": "x"\n}\n', "0.2.0")).toThrow(/version/);
  });
});
