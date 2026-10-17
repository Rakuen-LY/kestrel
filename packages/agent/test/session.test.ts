import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { silencedLogger } from "@kestrel/kernel";
import type { SessionEvent } from "@kestrel/protocol";
import {
  FileSessionStore,
  ModelRegistry,
  SessionManager,
  ToolRegistry,
  validateArguments,
  type SessionManagerOptions,
} from "../src/index.js";
import { ScriptedModel, echoTool } from "../../testkit/src/index.js";

const logger = silencedLogger();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function manager(options: Partial<SessionManagerOptions> = {}) {
  const models = new ModelRegistry();
  const tools = new ToolRegistry();
  tools.register(echoTool());
  const events: SessionEvent[] = [];
  const instance = new SessionManager({
    models,
    tools,
    logger,
    defaultWorkspace: process.cwd(),
    systemPrompt: () => "test prompt",
    ...options,
  });
  instance.subscribe((event) => events.push(event));
  return { instance, models, tools, events };
}

describe("AgentSession", () => {
  it("streams a plain answer and records the exchange", async () => {
    const { instance, models, events } = manager();
    const model = new ScriptedModel([{ content: "Hello there." }]);
    models.register(model, { setDefault: true });

    const session = instance.create({ title: "Greeting" });
    const result = await session.start("Say hello").done;

    expect(result.status).toBe("completed");
    expect(result.usage.totalTokens).toBe(15);
    expect(session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(session.messages[1].content).toBe("Hello there.");
    expect(events.some((event) => event.type === "run.started")).toBe(true);
    expect(events.filter((event) => event.type === "message.delta").length).toBeGreaterThan(0);
    expect(model.requests[0].messages[0].role).toBe("system");
  });

  it("executes tool calls and feeds results back to the model", async () => {
    const { instance, models } = manager();
    const model = new ScriptedModel([
      { content: "Checking.", toolCalls: [{ name: "echo", arguments: { text: "pong" } }] },
      { content: "The tool said pong." },
    ]);
    models.register(model, { setDefault: true });

    const session = instance.create({});
    const result = await session.start("Use the echo tool").done;

    expect(result.status).toBe("completed");
    const roles = session.messages.map((message) => message.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(session.messages[2].content).toBe("pong");
    expect(session.messages[2].toolName).toBe("echo");
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1].messages.some((message) => message.role === "tool")).toBe(true);
  });

  it("rejects malformed tool arguments without calling the tool", async () => {
    const { instance, models } = manager();
    const model = new ScriptedModel([
      { toolCalls: [{ name: "echo", arguments: { wrong: true } }] },
      { content: "Sorry." },
    ]);
    models.register(model, { setDefault: true });

    const session = instance.create({});
    await session.start("break it").done;
    const toolMessage = session.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("Invalid arguments");
    expect(toolMessage?.content).toContain("text");
  });

  it("returns an error result for unknown tools", async () => {
    const { instance, models } = manager();
    const model = new ScriptedModel([{ toolCalls: [{ name: "nope", arguments: {} }] }, { content: "Fine." }]);
    models.register(model, { setDefault: true });

    const session = instance.create({});
    await session.start("use a missing tool").done;
    expect(session.messages.find((message) => message.role === "tool")?.content).toContain('Unknown tool "nope"');
  });

  it("pauses for approval and declines", async () => {
    const { instance, models, tools } = manager({
      approve: async () => false,
      resolvePermission: () => "ask",
    });
    models.register(new ScriptedModel([{ toolCalls: [{ name: "echo", arguments: { text: "x" } }] }, { content: "Okay." }]), {
      setDefault: true,
    });

    const session = instance.create({});
    await session.start("ask me").done;
    expect(tools.get("echo")).toBeDefined();
    expect(session.messages.find((message) => message.role === "tool")?.content).toContain("declined");
  });

  it("runs approved tools", async () => {
    const { instance, models } = manager({ approve: async () => true, resolvePermission: () => "ask" });
    models.register(
      new ScriptedModel([{ toolCalls: [{ name: "echo", arguments: { text: "approved" } }] }, { content: "Done." }]),
      { setDefault: true },
    );

    const session = instance.create({});
    await session.start("approved call").done;
    expect(session.messages.find((message) => message.role === "tool")?.content).toBe("approved");
  });

  it("stops at the step limit", async () => {
    const { instance, models } = manager({ maxSteps: 3 });
    models.register(new ScriptedModel([{ toolCalls: [{ name: "echo", arguments: { text: "loop" } }] }]), {
      setDefault: true,
    });

    const session = instance.create({});
    const result = await session.start("loop forever").done;
    expect(result.status).toBe("max_steps");
    expect(session.messages.filter((message) => message.role === "assistant")).toHaveLength(3);
  });

  it("cancels an in-flight run", async () => {
    const { instance } = manager();
    const gate = new Promise<void>(() => undefined);
    const slow = {
      info: { id: "slow", provider: "test", supportsTools: false },
      generate: async (request: { signal?: AbortSignal }) => {
        await new Promise<void>((resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          void gate.then(resolve);
        });
        return { content: "", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: "stop" };
      },
    };
    instance["options"].models.register(slow, { setDefault: true });

    const session = instance.create({});
    const run = session.start("wait");
    expect(session.cancel()).toBe(true);
    const result = await run.done;
    expect(result.status).toBe("cancelled");
    expect(session.status).toBe("idle");
  });

  it("refuses concurrent runs on one session", async () => {
    const { instance, models } = manager();
    models.register(new ScriptedModel([{ content: "one" }, { content: "two" }]), { setDefault: true });
    const session = instance.create({});
    const run = session.start("first");
    expect(() => session.start("second")).toThrow(/active run/);
    await run.done;
  });

  it("auto-titles from the first message and renames on request", async () => {
    const { instance, models } = manager();
    models.register(new ScriptedModel([{ content: "ok" }]), { setDefault: true });
    const session = instance.create({});
    await session.start("  Implement   a parser  ").done;
    expect(session.title).toBe("Implement a parser");
    session.rename("Parser work");
    expect(instance.list()[0].title).toBe("Parser work");
  });
});

describe("Persistence", () => {
  it("round-trips sessions through the file store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kestrel-store-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));

    const store = new FileSessionStore(directory);
    const models = new ModelRegistry();
    models.register(new ScriptedModel([{ content: "persisted" }]), { setDefault: true });
    const first = new SessionManager({
      models,
      tools: new ToolRegistry(),
      logger,
      defaultWorkspace: process.cwd(),
      systemPrompt: () => "test",
      store,
    });
    await first.initialize();
    const session = first.create({ title: "Stored" });
    await session.start("remember me").done;
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = new SessionManager({
      models,
      tools: new ToolRegistry(),
      logger,
      defaultWorkspace: process.cwd(),
      systemPrompt: () => "test",
      store,
    });
    await second.initialize();
    expect(second.list()).toHaveLength(1);
    const restored = second.get(session.id);
    expect(restored.title).toBe("Stored");
    expect(restored.messages.at(-1)?.content).toBe("persisted");
    expect(restored.summary().usage?.totalTokens).toBe(15);
    await second.delete(session.id);
    expect(await store.list()).toHaveLength(0);
  });
});

describe("validateArguments", () => {
  it("reports nested and missing fields", () => {
    const issues = validateArguments(
      {
        type: "object",
        required: ["name", "items"],
        properties: {
          name: { type: "string" },
          items: { type: "array", items: { type: "object", required: ["id"], properties: { id: { type: "integer" } } } },
        },
        additionalProperties: false,
      },
      { items: [{ id: "x" }], extra: true },
    );
    expect(issues.map((issue) => issue.path).sort()).toEqual(["extra", "items[0].id", "name"]);
  });

  it("enforces enums", () => {
    expect(validateArguments({ type: "string", enum: ["a", "b"] }, "c")).toHaveLength(1);
    expect(validateArguments({ type: "string", enum: ["a", "b"] }, "a")).toHaveLength(0);
  });
});
