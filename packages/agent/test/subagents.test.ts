import { afterEach, describe, expect, it } from "vitest";
import { silencedLogger } from "@kestrel/kernel";
import { ModelRegistry, SessionManager, ToolRegistry } from "../src/index.js";
import { ScriptedModel, echoTool } from "../../testkit/src/index.js";

const logger = silencedLogger();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function manager() {
  const models = new ModelRegistry();
  const tools = new ToolRegistry();
  tools.register(echoTool());
  tools.register(echoTool({ name: "restricted" }));
  const sessions = new SessionManager({
    models,
    tools,
    logger,
    defaultWorkspace: "/tmp/workspace",
    systemPrompt: (workspace) => `base ${workspace}`,
  });
  return { sessions, models, tools };
}

describe("SessionManager.createSubagent", () => {
  it("records provenance and depth", () => {
    const { sessions } = manager();
    const parent = sessions.create({ title: "Parent" });
    const child = sessions.createSubagent(parent, { role: "researcher", instructions: "Stay read-only." });
    const grandchild = sessions.createSubagent(child, { role: "researcher" });

    expect(parent.depth).toBe(0);
    expect(parent.parentId).toBeUndefined();
    expect(child.parentId).toBe(parent.id);
    expect(child.depth).toBe(1);
    expect(child.role).toBe("researcher");
    expect(grandchild.depth).toBe(2);
    expect(sessions.childrenOf(parent.id)).toEqual([child]);
    expect(child.summary()).toMatchObject({ parentId: parent.id, depth: 1, role: "researcher" });
    expect(parent.summary().parentId).toBeUndefined();
  });

  it("frames the prompt and inherits the workspace", () => {
    const { sessions } = manager();
    const parent = sessions.create({ title: "Parent", workspace: "/srv/app" });
    const child = sessions.createSubagent(parent, { role: "reviewer", instructions: "Order findings by severity." });

    expect(child.workspace).toBe("/srv/app");
    expect(child.systemPrompt).toContain('Your role is "reviewer"');
    expect(child.systemPrompt).toContain("Order findings by severity.");
    expect(child.systemPrompt).toContain("base /srv/app");
    expect(child.systemPrompt).not.toContain("Parent");
  });

  it("hides tools outside the allowlist and refuses to execute them", async () => {
    const { sessions, models } = manager();
    const model = new ScriptedModel([{ toolCalls: [{ name: "restricted", arguments: {} }] }, { content: "done" }]);
    models.register(model, { setDefault: true });
    const parent = sessions.create({ title: "Parent" });
    const child = sessions.createSubagent(parent, { allowTools: ["echo"] });

    const result = await child.start("Use the restricted tool").done;

    expect(result.status).toBe("completed");
    expect(model.requests[0].tools.map((tool) => tool.name)).toEqual(["echo"]);
    const toolMessage = child.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain('Unknown tool "restricted"');
  });

  it("narrows only the child; the parent keeps the full registry", async () => {
    const { sessions, models } = manager();
    const model = new ScriptedModel([{ content: "parent done" }]);
    models.register(model, { setDefault: true });
    const parent = sessions.create({ title: "Parent" });
    sessions.createSubagent(parent, { allowTools: ["echo"] });

    await parent.start("Look around").done;

    expect(model.requests[0].tools.map((tool) => tool.name).sort()).toEqual(["echo", "restricted"]);
  });

  it("restores delegation metadata from the session store", async () => {
    const { sessions } = manager();
    const parent = sessions.create({ title: "Parent" });
    const child = sessions.createSubagent(parent, { role: "researcher" });
    const detail = child.detail();

    const restored = new SessionManager({
      models: new ModelRegistry(),
      tools: new ToolRegistry(),
      logger,
      defaultWorkspace: "/tmp/workspace",
      store: { list: async () => [detail], load: async () => detail, save: async () => {}, delete: async () => {} },
    });
    await restored.initialize();
    const reloaded = restored.get(child.id);

    expect(reloaded.parentId).toBe(parent.id);
    expect(reloaded.depth).toBe(1);
    expect(reloaded.role).toBe("researcher");
  });
});
