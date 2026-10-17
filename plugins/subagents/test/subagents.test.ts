import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "@kestrel/agent";
import { ScriptedModel, echoTool } from "../../../packages/testkit/src/index.js";
import { TOOL_NAME, createDelegationLayer, roleTable, toolAllowlist } from "../src/index.js";
import { cleanupAll, harness, runTool as runDelegate } from "./support.js";

afterEach(cleanupAll);

describe("delegation tool", () => {
  it("runs a subagent in an isolated session and returns only its report", async () => {
    const { sessions, models, delegate } = await harness({ child: [{ content: "Found three call sites." }] });
    models.register(new ScriptedModel([{ content: "Parent answer." }], { id: "parent" }), { setDefault: true });
    const parent = sessions.create({ model: "parent" });

    const result = await runDelegate(delegate, parent, { task: "Find call sites", role: "helper" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Found three call sites.");
    expect(result.content).toContain("Subagent `helper` finished");
    expect(result.data).toMatchObject({ role: "helper", status: "completed" });

    const children = sessions.childrenOf(parent.id);
    expect(children).toHaveLength(1);
    const [sub] = children;
    expect(sub.parentId).toBe(parent.id);
    expect(sub.depth).toBe(1);
    expect(sub.role).toBe("helper");
    expect(sub.summary()).toMatchObject({ parentId: parent.id, depth: 1, role: "helper" });
    expect(sub.messages.some((message) => message.role === "user")).toBe(true);
    // Isolation is bidirectional: the parent never receives the child transcript.
    expect(parent.messages).toHaveLength(0);
    expect(sub.messages.map((message) => message.content).join("\n")).not.toContain("Parent answer.");
  });

  it("frames a subagent prompt with the delegation contract", async () => {
    const { sessions, models, delegate, child } = await harness({});
    models.register(new ScriptedModel([{ content: "ok" }], { id: "parent" }), { setDefault: true });
    const parent = sessions.create({ model: "parent" });

    await runDelegate(delegate, parent, { task: "Do the thing", role: "helper" });

    const system = child.requests[0].messages.find((message) => message.role === "system");
    expect(system?.content).toContain("subagent");
    expect(system?.content).toContain("base prompt");
    expect(system?.content).toContain("The parent sees only your final message");
    expect(system?.content).toContain("Do not delegate");
  });

  it("refuses to delegate past the depth limit", async () => {
    const { sessions, models, delegate } = await harness({ config: { maxDepth: 1 } });
    models.register(new ScriptedModel([{ content: "ok" }], { id: "parent" }), { setDefault: true });
    const parent = sessions.create({ model: "parent" });
    const child = sessions.createSubagent(parent, { role: "helper", allowTools: [] });

    const result = await runDelegate(delegate, child, { task: "Go deeper" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("depth limit reached");
    expect(sessions.childrenOf(child.id)).toHaveLength(0);
  });

  it("reports unknown roles instead of inventing one", async () => {
    const { sessions, models, delegate } = await harness({});
    models.register(new ScriptedModel([{ content: "ok" }], { id: "parent" }), { setDefault: true });
    const parent = sessions.create({ model: "parent" });

    const result = await runDelegate(delegate, parent, { task: "Do it", role: "wizard" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("unknown role");
    expect(sessions.childrenOf(parent.id)).toHaveLength(0);
  });

  it("requires a task", async () => {
    const { sessions, models, delegate } = await harness({});
    models.register(new ScriptedModel([{ content: "ok" }], { id: "parent" }), { setDefault: true });
    const parent = sessions.create({ model: "parent" });

    const result = await runDelegate(delegate, parent, { task: "   " });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("`task` is required");
  });

  it("times out and cancels a run that ignores cancellation", async () => {
    const { sessions, models, delegate } = await harness({ config: { timeoutMs: 25 }, child: "hang" });
    models.register(new ScriptedModel([{ content: "ok" }], { id: "parent" }), { setDefault: true });
    const parent = sessions.create({ model: "parent" });

    const result = await runDelegate(delegate, parent, { task: "Never finishes", role: "helper" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("limit and was cancelled");
  });

  it("cancels the subagent when the parent run is aborted", async () => {
    const { sessions, models, delegate } = await harness({ child: "hang" });
    models.register(new ScriptedModel([{ content: "ok" }], { id: "parent" }), { setDefault: true });
    const parent = sessions.create({ model: "parent" });
    const controller = new AbortController();

    setTimeout(() => controller.abort(), 10);
    const result = await runDelegate(delegate, parent, { task: "Hang", role: "helper" }, controller.signal);

    expect(result.isError).toBe(true);
    expect(sessions.childrenOf(parent.id)[0].status).toBe("idle");
    expect(sessions.childrenOf(parent.id)[0].isRunning).toBe(false);
  });
});

describe("delegation prompt layer", () => {
  it("advertises roles to a session that can delegate", () => {
    const layer = createDelegationLayer({ roles: { helper: { description: "Helps." } } });
    const prompt = layer.transform("base", { workspace: "/tmp", tools: [] });
    expect(prompt).toContain("## Delegation");
    expect(prompt).toContain("`helper` — Helps.");
    expect(prompt).toContain("`researcher`");
  });

  it("stays silent at the depth limit", () => {
    const layer = createDelegationLayer({ maxDepth: 2 });
    expect(layer.transform("base", { workspace: "/tmp", tools: [], depth: 2 })).toBe("base");
  });
});

describe("tool allowlists", () => {
  const available = () => {
    const tools = new ToolRegistry();
    tools.register(echoTool());
    tools.register(echoTool({ name: "shell", permission: "ask" }));
    return tools;
  };

  it("drops tools that would prompt a human nobody is watching", () => {
    const role = roleTable({}).general;
    const allowed = toolAllowlist({ ...role, name: "general" }, available(), { canDelegate: false });
    expect(allowed).toContain("echo");
    expect(allowed).not.toContain("shell");
  });

  it("includes approval tools only when the operator opts in", () => {
    const role = roleTable({}).general;
    const allowed = toolAllowlist({ ...role, name: "general" }, available(), {
      canDelegate: false,
      exposeApprovalTools: true,
    });
    expect(allowed).toContain("shell");
  });

  it("adds delegate only while depth remains", async () => {
    const { tools, delegate } = await harness({});
    const role = roleTable({}).general;
    const nested = toolAllowlist({ ...role, name: "general" }, tools, { canDelegate: true });
    const leaf = toolAllowlist({ ...role, name: "general" }, tools, { canDelegate: false });
    expect(delegate.schema.name).toBe(TOOL_NAME);
    expect(nested).toContain(TOOL_NAME);
    expect(leaf).not.toContain(TOOL_NAME);
  });

  it("keeps an explicit role allowlist bounded by the registry", async () => {
    const { tools } = await harness({});
    const allowed = toolAllowlist(
      { name: "researcher", description: "Read only.", allowTools: ["echo", "not_installed"] },
      tools,
      { canDelegate: false },
    );
    expect(allowed).toEqual(["echo"]);
  });
});
