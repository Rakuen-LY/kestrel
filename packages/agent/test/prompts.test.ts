import { describe, expect, it } from "vitest";
import { PromptPipeline, type PromptLayer } from "../src/index.js";

function layer(name: string, order: number | undefined, suffix: string): PromptLayer {
  return { name, order, transform: (prompt) => `${prompt}\n${suffix}` };
}

describe("PromptPipeline", () => {
  it("applies layers in order and keeps registration order for ties", () => {
    const pipeline = new PromptPipeline();
    pipeline.add(layer("late", 10, "late"));
    pipeline.add(layer("early", -10, "early"));
    pipeline.add(layer("tie-a", 0, "a"));
    pipeline.add(layer("tie-b", 0, "b"));

    expect(pipeline.render("base", { workspace: "/tmp", tools: [] })).toBe("base\nearly\na\nb\nlate");
    expect(pipeline.list()).toEqual(["early", "tie-a", "tie-b", "late"]);
  });

  it("stops applying a layer once disposed", () => {
    const pipeline = new PromptPipeline();
    const dispose = pipeline.add(layer("context", 0, "context"));
    expect(pipeline.render("base", { workspace: "/tmp", tools: [] })).toContain("context");
    dispose();
    dispose();
    expect(pipeline.render("base", { workspace: "/tmp", tools: [] })).toBe("base");
  });

  it("isolates failing layers and reports them", () => {
    const failures: string[] = [];
    const pipeline = new PromptPipeline({ onError: (failed) => failures.push(failed.name) });
    pipeline.add({ name: "broken", transform: () => { throw new Error("boom"); } });
    pipeline.add(layer("after", 5, "after"));

    expect(pipeline.render("base", { workspace: "/tmp", tools: [] })).toBe("base\nafter");
    expect(failures).toEqual(["broken"]);
  });

  it("passes workspace, session and tool context to layers", () => {
    const pipeline = new PromptPipeline();
    let seen: unknown;
    pipeline.add({
      name: "capture",
      transform: (prompt, context) => {
        seen = context;
        return prompt;
      },
    });
    pipeline.render("base", { workspace: "/srv/app", sessionId: "s1", tools: ["read_file"] });
    expect(seen).toEqual({ workspace: "/srv/app", sessionId: "s1", tools: ["read_file"] });
  });
});
