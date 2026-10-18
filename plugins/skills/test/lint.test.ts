import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lintSkills, scaffoldSkill } from "../src/lint.js";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kestrel-skills-lint-"));
  roots.push(root);
  return root;
}

async function skill(root: string, directory: string, body: string): Promise<void> {
  const path = join(root, "skills", directory);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), body, "utf8");
}

describe("lintSkills", () => {
  it("reports a clean skill without issues", async () => {
    const root = await workspace();
    await skill(
      root,
      "release-checklist",
      "---\nname: release-checklist\ndescription: Publish a release safely.\n---\n\n1. Run tests.\n2. Tag.\n",
    );
    const result = lintSkills(root);
    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(0);
    expect(result.reports).toHaveLength(1);
  });

  it("finds invalid names, duplicates, empty bodies and missing files", async () => {
    const root = await workspace();
    await skill(root, "first", "---\nname: Shared_Name\ndescription: One.\n---\n\nBody.\n");
    await skill(root, "second", "---\nname: shared-name\ndescription: Two.\n---\n\nBody.\n");
    await skill(root, "empty", "---\nname: empty\n---\n\n");
    await mkdir(join(root, "skills", "missing"), { recursive: true });

    const result = lintSkills(root);
    const byPath = new Map(result.reports.map((report) => [report.path, report.issues.map((issue) => issue.code)]));
    expect(byPath.get("skills/first/SKILL.md")).toContain("name-normalized");
    expect(byPath.get("skills/first/SKILL.md")).toContain("name-mismatch");
    expect(byPath.get("skills/second/SKILL.md")).toContain("duplicate-name");
    expect(byPath.get("skills/empty/SKILL.md")).toContain("empty-body");
    expect(byPath.get("skills/missing/SKILL.md")).toContain("file-missing");
    expect(result.errors).toBeGreaterThanOrEqual(3);
  });

  it("warns about missing frontmatter and long files", async () => {
    const root = await workspace();
    await skill(root, "plain", `# Plain\n\n${"x".repeat(300)}\n`);
    const result = lintSkills(root, { maxSkillBytes: 200 });
    const codes = result.reports[0].issues.map((issue) => issue.code);
    expect(codes).toContain("no-frontmatter");
    expect(codes).toContain("no-description");
    expect(codes).toContain("too-large");
    expect(result.errors).toBe(0);
  });

  it("rejects a malformed workspace", () => {
    const result = lintSkills("/definitely/not/here");
    expect(result.errors).toBe(1);
    expect(result.reports[0].issues[0].code).toBe("workspace-missing");
  });
});

describe("scaffoldSkill", () => {
  it("writes frontmatter and a body that lints cleanly", async () => {
    const root = await workspace();
    const markdown = scaffoldSkill("Release Checklist", "Publish a release.", "cutting a tag");
    expect(markdown).toContain("name: release-checklist");
    expect(markdown).toContain("whenToUse: cutting a tag");

    const directory = join(root, "skills", "release-checklist");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), markdown, "utf8");
    const result = lintSkills(root);
    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(0);
  });

  it("rejects names that cannot be addressed", () => {
    expect(() => scaffoldSkill("...", "x")).toThrow("must normalize");
  });
});
