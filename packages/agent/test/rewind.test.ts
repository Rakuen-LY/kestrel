import { describe, expect, it } from "vitest";
import { silencedLogger } from "@kestrel/kernel";
import type { SessionEvent } from "@kestrel/protocol";
import {
  ModelRegistry,
  RewindError,
  SessionManager,
  ToolRegistry,
  isRewindError,
} from "../src/index.js";
import { ScriptedModel } from "../../testkit/src/index.js";

function harness() {
  const models = new ModelRegistry();
  const tools = new ToolRegistry();
  const events: SessionEvent[] = [];
  const manager = new SessionManager({
    models,
    tools,
    logger: silencedLogger(),
    defaultWorkspace: process.cwd(),
    systemPrompt: () => "test prompt",
  });
  manager.subscribe((event) => events.push(event));
  models.register(new ScriptedModel([{ content: "answer" }]), { setDefault: true });
  return { manager, events };
}

describe("session rewind", () => {
  it("removes the target user message and everything after it", async () => {
    const { manager, events } = harness();
    const session = manager.create({});
    await session.start("first").done;
    const second = await session.start("second").done;
    expect(session.messages).toHaveLength(4);

    const targetId = session.messages[2].id;
    const result = session.rewind(targetId);

    expect(result.removed).toBe(2);
    expect(session.messages.map((message) => message.content)).toEqual(["first", "answer"]);
    expect(manager.get(session.id).messages).toHaveLength(2);
    expect(second.status).toBe("completed");

    const event = events.find((item) => item.type === "session.rewound");
    expect(event).toMatchObject({ type: "session.rewound", sessionId: session.id, messageId: targetId });
    if (event?.type === "session.rewound") {
      expect(event.messages).toHaveLength(2);
    }
  });

  it("honours a caller-supplied message id", async () => {
    const { manager } = harness();
    const session = manager.create({});
    await session.start("hello", { messageId: "msg_fixed" }).done;

    expect(session.messages[0].id).toBe("msg_fixed");
    session.rewind("msg_fixed");
    expect(session.messages).toHaveLength(0);
  });

  it("refuses unknown messages, non-user targets and active runs", async () => {
    const { manager } = harness();
    const session = manager.create({});
    await session.start("hello").done;
    const assistantId = session.messages[1].id;

    expect(() => session.rewind("missing")).toThrow(RewindError);
    try {
      session.rewind("missing");
    } catch (error) {
      expect(isRewindError(error) && error.code).toBe("message_not_found");
    }

    try {
      session.rewind(assistantId);
    } catch (error) {
      expect(isRewindError(error) && error.code).toBe("invalid_rewind_target");
    }

    const running = session.start("again");
    try {
      session.rewind(session.messages.at(-1)?.id ?? "");
    } catch (error) {
      expect(isRewindError(error) && error.code).toBe("session_busy");
    }
    await running.done;
  });
});
