import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PromptPipeline, ToolRegistry, type ToolContext } from "@kestrel/agent";
import { createContext, silencedLogger } from "@kestrel/kernel";
import plugin, {
  SkillCatalog,
  createSkillsLayer,
  createUseSkillTool,
  normalizeName,
  parseSkill,
} from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kestrel-skills-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  return root;
}

const RELEASE = `---
name: release-checklist
description: How to cut a release without breaking the changelog.
when-to-use: The user asks to ship, tag or publish a version.
---

1. Run the full test suite.
2. Update CHANGELOG.md.
`;

function toolContext(workspace: string): ToolContext {
  return {
    session: { id: "test", workspace, messages: [], metadata: new Map() },
    callId: "call-1",
    signal: new AbortController().signal,
    logger: silencedLogger(),
    progress: () => undefined,
  };
}

describe("parseSkill", () => {
  it("reads frontmatter and keeps the body separate", () => {
    const parsed = parseSkill(RELEASE, "fallback");
    expect(parsed).toMatchObject({
      name: "release-checklist",
      description: "How to cut a release without breaking the changelog.",
      whenToUse: "The user asks to ship, tag or publish a version.",
    });
    expect(parsed?.body).toContain("1. Run the full test suite.");
    expect(parsed?.body).not.toContain("description:");
  });

  it("falls back to the file name and the first prose line", () => {
    const parsed = parseSkill("# Title\n\nRotate the signing keys every quarter.\n", "Rotate Keys");
    expect(parsed?.name).toBe("rotate-keys");
    expect(parsed?.description).toBe("Rotate the signing keys every quarter.");
  });

  it("returns undefined for an empty body", () => {
    expect(parseSkill("---\nname: empty\n---\n\n", "empty")).toBeUndefined();
  });

  it("normalizes CRLF documents", () => {
    const parsed = parseSkill(RELEASE.replace(/\n/g, "\r\n"), "x");
    expect(parsed?.body.startsWith("1. Run")).toBe(true);
  });
});

describe("normalizeName", () => {
  it("produces kebab-case identifiers", () => {
    expect(normalizeName("  Release_Checklist ")).toBe("release-checklist");
    expect(normalizeName("a  b")).toBe("a-b");
  });
});

describe("SkillCatalog", () => {
  it("discovers directories and flat files, sorted by name", async () => {
    const root = await workspace({
      "skills/release/SKILL.md": RELEASE,
      "skills/deploy.md": "---\ndescription: Ship to production.\n---\nRun make deploy.\n",
      "skills/.hidden/SKILL.md": "ignored",
      "skills/_draft/SKILL.md": "---\ndescription: Draft.\n---\nNot ready.\n",
    });
    const catalog = new SkillCatalog();
    expect(catalog.list(root).map((skill) => skill.name)).toEqual(["deploy", "release-checklist"]);
  });

  it("prefers .kestrel/skills over skills for duplicate names", async () => {
    const root = await workspace({
      ".kestrel/skills/release/SKILL.md": RELEASE,
      "skills/release/SKILL.md": "---\nname: release-checklist\ndescription: Outdated copy.\n---\nOld steps.\n",
    });
    const catalog = new SkillCatalog();
    expect(catalog.list(root).filter((skill) => skill.name === "release-checklist")).toHaveLength(1);
    expect(catalog.load(root, "release-checklist")?.body).toContain("Run the full test suite");
  });

  it("truncates oversized skills instead of dropping them", async () => {
    const root = await workspace({ "skills/big.md": "x".repeat(500) });
    const catalog = new SkillCatalog({ maxSkillBytes: 100 });
    const skill = catalog.load(root, "big");
    expect(skill?.body).toHaveLength(100);
    expect(skill?.truncated).toBe(true);
  });

  it("honours the skill budget", async () => {
    const root = await workspace({
      "skills/a.md": "---\ndescription: A.\n---\nA body.\n",
      "skills/b.md": "---\ndescription: B.\n---\nB body.\n",
      "skills/c.md": "---\ndescription: C.\n---\nC body.\n",
    });
    expect(new SkillCatalog({ maxSkills: 2 }).list(root)).toHaveLength(2);
  });

  it("re-reads a skill after it changes", async () => {
    const root = await workspace({ "skills/note.md": "---\ndescription: First.\n---\nFirst body.\n" });
    const catalog = new SkillCatalog();
    expect(catalog.load(root, "note")?.body).toBe("First body.");

    await writeFile(join(root, "skills/note.md"), "---\ndescription: Second.\n---\nSecond body, longer.\n");
    expect(catalog.load(root, "note")?.body).toContain("Second body");
  });

  it("refuses skills that link outside the workspace", async () => {
    const outside = await workspace({ "secret.md": "---\ndescription: Secret.\n---\nLeak.\n" });
    const root = await workspace({});
    await mkdir(join(root, "skills"), { recursive: true });
    await symlink(join(outside, "secret.md"), join(root, "skills", "leak.md"));

    expect(new SkillCatalog().list(root)).toEqual([]);
  });

  it("ignores unreadable and invalid entries", async () => {
    const root = await workspace({ "skills/notes.txt": "not a skill" });
    await mkdir(join(root, "skills", "empty-dir"), { recursive: true });
    expect(new SkillCatalog().list(root)).toEqual([]);
  });
});

describe("prompt layer", () => {
  it("lists names and descriptions but not bodies", async () => {
    const root = await workspace({ "skills/release/SKILL.md": RELEASE });
    const prompt = createSkillsLayer(new SkillCatalog()).transform("base", { workspace: root, tools: [] });

    expect(prompt).toContain("## Skills");
    expect(prompt).toContain("`release-checklist`");
    expect(prompt).toContain("use when: The user asks to ship");
    expect(prompt).not.toContain("Update CHANGELOG.md");
  });

  it("leaves the prompt untouched without skills", async () => {
    const root = await workspace({ "README.md": "# none" });
    expect(createSkillsLayer(new SkillCatalog()).transform("base", { workspace: root, tools: [] })).toBe("base");
  });
});

describe("use_skill tool", () => {
  it("returns the full procedure", async () => {
    const root = await workspace({ "skills/release/SKILL.md": RELEASE });
    const tool = createUseSkillTool(new SkillCatalog());
    const result = await tool.execute({ name: "Release Checklist" }, toolContext(root));

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("# Skill: release-checklist");
    expect(result.content).toContain("Update CHANGELOG.md");
    expect(result.data).toMatchObject({ name: "release-checklist", truncated: false });
  });

  it("lists skills when no name is given", async () => {
    const root = await workspace({ "skills/release/SKILL.md": RELEASE });
    const result = await createUseSkillTool(new SkillCatalog()).execute({}, toolContext(root));
    expect(result.content).toContain("release-checklist");
    expect(result.isError).toBeUndefined();
  });

  it("reports unknown names with the available set", async () => {
    const root = await workspace({ "skills/release/SKILL.md": RELEASE });
    const result = await createUseSkillTool(new SkillCatalog()).execute({ name: "missing" }, toolContext(root));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("release-checklist");
  });

  it("tracks loaded skills on the session", async () => {
    const root = await workspace({ "skills/release/SKILL.md": RELEASE });
    const context = toolContext(root);
    const tool = createUseSkillTool(new SkillCatalog());
    await tool.execute({ name: "release-checklist" }, context);
    await tool.execute({ name: "RELEASE-CHECKLIST" }, context);
    expect(context.session.metadata.get("skills.loaded")).toEqual(new Set(["release-checklist"]));
  });
});

describe("skills plugin", () => {
  it("registers the layer, the tool and the service", async () => {
    const root = await workspace({ "skills/release/SKILL.md": RELEASE });
    const context = createContext({ name: "test", logger: silencedLogger() });
    const prompts = new PromptPipeline();
    const tools = new ToolRegistry();
    context.provide("prompts", prompts);
    context.provide("tools", tools);
    cleanups.push(() => context.dispose());

    const handle = context.plugin(plugin, {});
    await handle.ready();

    expect(prompts.list()).toContain("workspace-skills");
    expect(tools.get("use_skill")).toBeDefined();
    expect(context.get("skills").list(root).map((skill) => skill.name)).toEqual(["release-checklist"]);
    expect(prompts.render("base", { workspace: root, tools: [] })).toContain("release-checklist");

    await handle.dispose();
    expect(prompts.list()).not.toContain("workspace-skills");
    expect(tools.get("use_skill")).toBeUndefined();
  });
});
