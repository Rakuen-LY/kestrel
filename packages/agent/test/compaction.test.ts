import { describe, expect, it } from "vitest";
import { silencedLogger } from "@kestrel/kernel";
import type { ChatMessage, CompletionRequest, CompletionResponse, SessionEvent } from "@kestrel/protocol";
import {
  ModelRegistry,
  SessionManager,
  ToolRegistry,
  assistantMessage,
  createMessage,
  toolMessage,
  type CompactionOptions,
  type LanguageModel,
  type SessionManagerOptions,
} from "../src/index.js";
import { ScriptedModel, echoTool } from "../../testkit/src/index.js";

const logger = silencedLogger();

function manager(compaction: CompactionOptions, options: Partial<SessionManagerOptions> = {}) {
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
    compaction,
    ...options,
  });
  instance.subscribe((event) => events.push(event));
  return { instance, models, events };
}

/** A window small enough that a handful of paragraphs overflows it. */
const SMALL_WINDOW = 400;

function fill(session: { messages: ChatMessage[] }, turns: number, size = 400) {
  for (let index = 0; index < turns; index += 1) {
    session.messages.push(createMessage("user", `request ${index}: ${"x".repeat(size)}`));
    session.messages.push(assistantMessage(`answer ${index}: ${"y".repeat(size)}`));
  }
}

describe("context compaction", () => {
  it("replaces the oldest turns with one summary", async () => {
    const { instance, models, events } = manager({ threshold: 0.5, keepRecent: 4 });
    const model = new ScriptedModel([{ content: "The user is refactoring auth." }, { content: "Continuing." }], {
      contextWindow: SMALL_WINDOW,
    });
    models.register(model, { setDefault: true });

    const session = instance.create({ title: "Long" });
    fill(session, 6);

    const result = await session.start("What next?").done;

    expect(result.status).toBe("completed");
    const compacted = events.find((event) => event.type === "context.compacted");
    expect(compacted?.type === "context.compacted" && compacted.removedMessages).toBeGreaterThan(0);

    // The summary is the first message and the tail starts on a user turn.
    expect(session.messages[0].content).toContain("[Summary of the earlier conversation]");
    expect(session.messages[0].content).toContain("refactoring auth");
    expect(session.messages[1].role).toBe("user");
    expect(session.messages.some((message) => message.content === "request 0")).toBe(false);
    expect(session.messages.at(-1)?.content).toBe("Continuing.");

    // The summarizer sees the transcript, not the tool schemas.
    const summaryRequest = model.requests[0];
    expect(summaryRequest.tools).toEqual([]);
    expect(summaryRequest.messages[0].role).toBe("system");
    expect(summaryRequest.messages[1].content).toContain("request 0");
    expect(summaryRequest.messages[1].content).not.toContain("What next?");
  });

  it("never splits a tool call from its result", async () => {
    const { instance, models } = manager({ threshold: 0.3, keepRecent: 3 });
    const model = new ScriptedModel([{ content: "summary" }, { content: "done" }], { contextWindow: 200 });
    models.register(model, { setDefault: true });

    const session = instance.create({ title: "Tools" });
    for (let index = 0; index < 4; index += 1) {
      session.messages.push(createMessage("user", `turn ${index} ${"a".repeat(300)}`));
      const call = { id: `call_${index}`, name: "echo", arguments: { text: `t${index}` } };
      session.messages.push(assistantMessage("", { toolCalls: [call] }));
      session.messages.push(toolMessage(call, `result ${index} ${"b".repeat(300)}`));
      session.messages.push(assistantMessage(`ack ${index}`));
    }

    await session.start("go").done;
    const firstKept = session.messages[1];
    expect(firstKept.role).toBe("user");
    const toolMessagesAfterCut = session.messages.slice(1).filter((message) => message.role === "tool");
    const callIds = new Set(session.messages.slice(1).flatMap((message) => message.toolCalls?.map((c) => c.id) ?? []));
    for (const message of toolMessagesAfterCut) expect(callIds.has(message.toolCallId ?? "")).toBe(true);
  });

  it("stays put when compaction is disabled", async () => {
    const { instance, models, events } = manager({ enabled: false });
    const model = new ScriptedModel([{ content: "ok" }], { contextWindow: 100 });
    models.register(model, { setDefault: true });

    const session = instance.create({ title: "Disabled" });
    fill(session, 5);

    await session.start("continue").done;

    expect(events.some((event) => event.type === "context.compacted")).toBe(false);
    expect(model.requests).toHaveLength(1);
    expect(session.messages.some((message) => message.content.startsWith("[Summary"))).toBe(false);
  });

  it("keeps the transcript when summarization fails", async () => {
    const { instance, models, events } = manager({ threshold: 0.4, keepRecent: 2 });
    const failing: LanguageModel = {
      info: { id: "flaky", provider: "test", supportsTools: true, contextWindow: 200 },
      async generate(request: CompletionRequest): Promise<CompletionResponse> {
        if (request.tools.length === 0) throw new Error("summarizer offline");
        return { content: "still working", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: "stop" };
      },
    };
    models.register(failing, { setDefault: true });

    const session = instance.create({ title: "Flaky" });
    fill(session, 4);

    const result = await session.start("go").done;

    expect(result.status).toBe("completed");
    expect(events.some((event) => event.type === "context.compacted")).toBe(false);
    expect(session.messages.some((message) => message.content.startsWith("answer 0"))).toBe(true);
    expect(session.messages.at(-1)?.content).toBe("still working");
  });

  it("does nothing without a safe cut point", async () => {
    const { instance, models, events } = manager({ threshold: 0.2, keepRecent: 2 });
    const model = new ScriptedModel([{ content: "ok" }], { contextWindow: 100 });
    models.register(model, { setDefault: true });

    const session = instance.create({ title: "No boundary" });
    for (let index = 0; index < 10; index += 1) {
      session.messages.push(assistantMessage(`note ${index} ${"z".repeat(300)}`));
    }

    await session.start("go").done;
    expect(events.some((event) => event.type === "context.compacted")).toBe(false);
    expect(model.requests).toHaveLength(1);
  });
});
