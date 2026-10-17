import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PromptPipeline } from "@kestrel/agent";
import { createContext, silencedLogger } from "@kestrel/kernel";
import plugin, { createWorkspaceContextLayer } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function workspaceWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kestrel-context-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  return root;
}

describe("workspace context layer", () => {
  it("appends AGENTS.md to the prompt", async () => {
    const root = await workspaceWith({ "AGENTS.md": "Use pnpm. Never touch main." });
    const layer = createWorkspaceContextLayer();
    const prompt = layer.transform("base", { workspace: root, tools: [] });

    expect(prompt).toContain("## Workspace instructions");
    expect(prompt).toContain("<workspace_instructions path=\"AGENTS.md\">");
    expect(prompt).toContain("Use pnpm. Never touch main.");
  });

  it("prefers the first matching file", async () => {
    const root = await workspaceWith({
      "AGENTS.md": "root guidance",
      ".kestrel/AGENTS.md": "kestrel guidance",
    });
    const prompt = createWorkspaceContextLayer().transform("base", { workspace: root, tools: [] });
    expect(prompt).toContain("root guidance");
    expect(prompt).not.toContain("kestrel guidance");
  });

  it("leaves the prompt untouched when no context file exists", async () => {
    const root = await workspaceWith({ "README.md": "# nothing" });
    expect(createWorkspaceContextLayer().transform("base", { workspace: root, tools: [] })).toBe("base");
  });

  it("truncates large files instead of dropping them", async () => {
    const root = await workspaceWith({ "AGENTS.md": "x".repeat(200) });
    const prompt = createWorkspaceContextLayer({ maxBytes: 50 }).transform("base", { workspace: root, tools: [] });
    expect(prompt).toContain("x".repeat(50));
    expect(prompt).not.toContain("x".repeat(51));
    expect(prompt).toContain("[truncated at 50 characters]");
  });

  it("refuses to read outside the workspace", async () => {
    const root = await workspaceWith({});
    const secret = join(root, "..", `${root.split("/").pop()}-secret.md`);
    await writeFile(secret, "do not leak");
    cleanups.push(() => rm(secret, { force: true }));

    const prompt = createWorkspaceContextLayer({ files: [`../${root.split("/").pop()}-secret.md`] }).transform(
      "base",
      { workspace: root, tools: [] },
    );
    expect(prompt).toBe("base");
  });
});

describe("context plugin", () => {
  it("registers a prompt layer with the kernel service", async () => {
    const root = await workspaceWith({ "AGENTS.md": "keep the build green" });
    const context = createContext({ name: "test", logger: silencedLogger() });
    const prompts = new PromptPipeline();
    context.provide("prompts", prompts);
    cleanups.push(() => context.dispose());

    const handle = context.plugin(plugin, {});
    await handle.ready();
    expect(prompts.list()).toContain("workspace-context");

    const rendered = prompts.render("base", { workspace: root, tools: [] });
    expect(rendered).toContain("keep the build green");

    await handle.dispose();
    expect(prompts.list()).not.toContain("workspace-context");
  });
});
