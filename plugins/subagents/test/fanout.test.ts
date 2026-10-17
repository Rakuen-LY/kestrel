import { afterEach, describe, expect, it } from "vitest";
import type { CompletionRequest } from "@kestrel/agent";
import { ScriptedModel } from "../../../packages/testkit/src/index.js";
import type { SubagentService } from "../src/index.js";
import { GatedModel, cleanupAll, harness, runTool, type Harness } from "./support.js";

afterEach(cleanupAll);

/** Echoes the task back so each child's report is attributable to its request. */
class EchoModel extends ScriptedModel {
  constructor() {
    super([{ content: "" }], { id: "child" });
  }

  override async generate(request: CompletionRequest) {
    const task = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    return {
      content: `report for: ${task}`,
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      finishReason: "stop" as const,
    };
  }
}

/** Fails the child whose task mentions "boom", so a batch can be mixed. */
class SelectiveModel extends EchoModel {
  override async generate(request: CompletionRequest) {
    const task = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    if (task.includes("boom")) throw new Error("provider exploded");
    return super.generate(request);
  }
}

/**
 * The parent model is never invoked here (tests call the tools directly), and
 * subagents inherit the parent's model id, so pointing the parent at the test
 * model is enough to steer every child.
 */
function parentSession(harness: Harness) {
  return harness.sessions.create({ model: "child" });
}

function subagents(harness: Harness): SubagentService {
  return harness.context.get("subagents");
}

const tasks = (...names: string[]) => names.map((task) => ({ task }));

describe("delegate_many", () => {
  it("returns one report per task, in request order", async () => {
    const h = await harness({ config: { maxConcurrent: 3 } });
    h.models.register(new EchoModel());
    const parent = parentSession(h);

    const result = await runTool(h.fanOut, parent, {
      tasks: [tasks("alpha", "beta", "gamma")[0], { task: "beta" }, { task: "gamma" }],
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Delegated 3 tasks");
    expect(result.content).toContain("3 completed");
    expect(result.content.indexOf("report for: alpha")).toBeLessThan(
      result.content.indexOf("report for: beta"),
    );
    expect(result.content.indexOf("report for: beta")).toBeLessThan(
      result.content.indexOf("report for: gamma"),
    );

    const data = result.data as { total: number; results: Array<{ status: string; sessionId: string }> };
    expect(data.total).toBe(3);
    expect(data.results.map((entry) => entry.status)).toEqual(["completed", "completed", "completed"]);
    expect(new Set(data.results.map((entry) => entry.sessionId)).size).toBe(3);

    const children = h.sessions.childrenOf(parent.id);
    expect(children).toHaveLength(3);
    expect(children.every((child) => child.depth === 1 && child.parentId === parent.id)).toBe(true);
  });

  it("runs at the concurrency limit and queues the remainder", async () => {
    const h = await harness({ config: { maxConcurrent: 2 } });
    const model = new GatedModel([{ content: "child report" }], { id: "child" });
    h.models.register(model);
    const parent = parentSession(h);

    const pending = runTool(h.fanOut, parent, { tasks: tasks("one", "two", "three", "four") });

    await model.waitForRunning(2);
    expect(model.current).toBe(2);
    expect(subagents(h).concurrency(parent.id)).toMatchObject({ limit: 2, active: 2, queued: 2 });
    // Queued tasks have no session yet: queuing is cheap and visible.
    expect(h.sessions.childrenOf(parent.id)).toHaveLength(2);

    await model.releaseAll();
    await model.waitForRunning(2);
    await model.releaseAll();

    const result = await pending;
    expect(result.isError).toBeFalsy();
    expect(model.peak).toBe(2);
    expect(h.sessions.childrenOf(parent.id)).toHaveLength(4);
    expect(subagents(h).concurrency(parent.id)).toMatchObject({ active: 0, queued: 0 });
  });

  it("shares the concurrency budget with single delegation", async () => {
    const h = await harness({ config: { maxConcurrent: 1 } });
    const model = new GatedModel([{ content: "child report" }], { id: "child" });
    h.models.register(model);
    const parent = parentSession(h);

    const single = runTool(h.delegate, parent, { task: "single task" });
    await model.waitForRunning(1);
    const batch = runTool(h.fanOut, parent, { tasks: tasks("batched task") });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.sessions.childrenOf(parent.id)).toHaveLength(1);
    expect(subagents(h).concurrency(parent.id)).toMatchObject({ active: 1, queued: 1 });

    await model.releaseAll();
    await model.waitForRunning(1);
    await model.releaseAll();
    const [singleResult, batchResult] = await Promise.all([single, batch]);

    expect(singleResult.isError).toBeFalsy();
    expect(batchResult.isError).toBeFalsy();
    expect(model.peak).toBe(1);
    expect(h.sessions.childrenOf(parent.id)).toHaveLength(2);
  });

  it("drops queued tasks when the parent run is aborted", async () => {
    const h = await harness({ config: { maxConcurrent: 1 } });
    const model = new GatedModel([{ content: "child report" }], { id: "child" });
    h.models.register(model);
    const parent = parentSession(h);
    const controller = new AbortController();

    const pending = runTool(
      h.fanOut,
      parent,
      { tasks: tasks("first", "second", "third") },
      controller.signal,
    );
    await model.waitForRunning(1);
    controller.abort();

    const result = await pending;
    // One child ran and was cancelled; the other two never started a session.
    expect(h.sessions.childrenOf(parent.id)).toHaveLength(1);
    expect(subagents(h).concurrency(parent.id)).toMatchObject({ active: 0, queued: 0 });

    const data = result.data as { results: Array<{ status: string; sessionId?: string }> };
    expect(data.results.map((entry) => entry.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(data.results.filter((entry) => entry.sessionId)).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("cancelled before this subagent started");
  });

  it("rejects a batch larger than the fan-out limit without starting anything", async () => {
    const h = await harness({ config: { maxFanOut: 2 } });
    h.models.register(new EchoModel());
    const parent = parentSession(h);

    const result = await runTool(h.fanOut, parent, { tasks: tasks("one", "two", "three") });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("3 tasks requested; the limit is 2");
    expect(h.sessions.childrenOf(parent.id)).toHaveLength(0);
  });

  it("rejects unknown roles before starting the batch", async () => {
    const h = await harness({});
    h.models.register(new EchoModel());
    const parent = parentSession(h);

    const result = await runTool(h.fanOut, parent, {
      tasks: [{ task: "fine", role: "researcher" }, { task: "broken", role: "wizard" }],
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('unknown role "wizard"');
    expect(h.sessions.childrenOf(parent.id)).toHaveLength(0);
  });

  it("requires a non-empty task list", async () => {
    const h = await harness({});
    const parent = parentSession(h);

    for (const args of [{}, { tasks: [] }, { tasks: [{ task: "  " }] }]) {
      const result = await runTool(h.fanOut, parent, args);
      expect(result.isError).toBe(true);
    }
    expect(h.sessions.childrenOf(parent.id)).toHaveLength(0);
  });

  it("reports partial success as a usable result, not an error", async () => {
    const h = await harness({});
    h.models.register(new SelectiveModel());
    const parent = parentSession(h);

    const result = await runTool(h.fanOut, parent, {
      tasks: [{ task: "investigate alpha" }, { task: "boom here" }, { task: "investigate gamma" }],
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("2 completed, 1 failed");
    expect(result.content).toContain("provider exploded");
    expect(result.content).toContain("report for: investigate gamma");

    const data = result.data as { counts: Record<string, number> };
    expect(data.counts).toEqual({ completed: 2, failed: 1 });
  });

  it("treats a wholly failed batch as an error", async () => {
    const h = await harness({});
    h.models.register(new SelectiveModel());
    const parent = parentSession(h);

    const result = await runTool(h.fanOut, parent, { tasks: tasks("boom one", "boom two") });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("2 failed");
  });
});
