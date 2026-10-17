import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { silencedLogger } from "@kestrel/kernel";
import type { SessionDetail, SessionEvent, ToolResult } from "@kestrel/protocol";
import {
  FileSessionStore,
  ModelRegistry,
  SessionManager,
  ToolRegistry,
  type SessionManagerOptions,
} from "../src/index.js";
import { ScriptedModel } from "../../testkit/src/index.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function store(): Promise<FileSessionStore> {
  const root = await mkdtemp(join(tmpdir(), "kestrel-resume-"));
  const sessions = new FileSessionStore(root);
  cleanups.push(async () => {
    await sessions.flush();
    await rm(root, { recursive: true, force: true });
  });
  return sessions;
}

function crashedDetail(): SessionDetail {
  const now = new Date().toISOString();
  return {
    id: "crashed",
    title: "Crashed run",
    createdAt: now,
    updatedAt: now,
    status: "running",
    model: "scripted",
    messageCount: 2,
    workspace: process.cwd(),
    systemPrompt: "test prompt",
    messages: [
      { id: "m1", role: "user", content: "delete the temp file", createdAt: now },
      {
        id: "m2",
        role: "assistant",
        content: "",
        createdAt: now,
        model: "scripted",
        toolCalls: [{ id: "call_1", name: "danger", arguments: {} }],
      },
    ],
  };
}

function manager(sessions: FileSessionStore, options: Partial<SessionManagerOptions> = {}) {
  const models = new ModelRegistry();
  const tools = new ToolRegistry();
  const events: SessionEvent[] = [];
  const instance = new SessionManager({
    models,
    tools,
    logger: silencedLogger(),
    defaultWorkspace: process.cwd(),
    systemPrompt: () => "test prompt",
    store: sessions,
    ...options,
  });
  instance.subscribe((event) => events.push(event));
  return { instance, models, tools, events };
}

describe("resumable runs", () => {
  it("marks a crashed run as interrupted on startup", async () => {
    const sessions = await store();
    await sessions.save(crashedDetail());

    const { instance } = manager(sessions);
    await instance.initialize();

    expect(instance.get("crashed").status).toBe("interrupted");
    await sessions.flush();
    expect((await sessions.load("crashed"))?.status).toBe("interrupted");
  });

  it("resumes without re-running the pending tool and tells the model why", async () => {
    const sessions = await store();
    await sessions.save(crashedDetail());

    let executions = 0;
    const { instance, models, tools, events } = manager(sessions);
    await instance.initialize();
    tools.register({
      schema: { name: "danger", description: "Side-effecting tool", parameters: {}, permission: "auto" },
      async execute(): Promise<ToolResult> {
        executions += 1;
        return { callId: "", name: "danger", ok: true, content: "did it" };
      },
    });
    const model = new ScriptedModel([{ content: "Verified; nothing else to do." }]);
    models.register(model, { setDefault: true });

    const result = await instance.resume("crashed").done;

    expect(result.status).toBe("completed");
    expect(executions).toBe(0);
    const messages = instance.get("crashed").messages;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(messages[2].toolCallId).toBe("call_1");
    expect(messages[2].content).toContain("interrupted");
    expect(messages[3].content).toBe("Verified; nothing else to do.");
    expect(events.some((event) => event.type === "notice")).toBe(true);
    expect(model.requests[0].messages.some((message) => message.toolCallId === "call_1")).toBe(true);
  });

  it("rejects resuming a session that is not interrupted", async () => {
    const sessions = await store();
    const { instance, models } = manager(sessions);
    models.register(new ScriptedModel([{ content: "hi" }]), { setDefault: true });
    const session = instance.create({});
    await session.start("hello").done;

    expect(() => instance.resume(session.id)).toThrow(/interrupted or failed/);
  });

  it("keeps interrupted state across a restart when resuming fails again", async () => {
    const sessions = await store();
    await sessions.save(crashedDetail());

    const first = manager(sessions);
    await first.instance.initialize();
    expect(first.instance.get("crashed").status).toBe("interrupted");
    await first.instance.close();

    const second = manager(sessions);
    await second.instance.initialize();
    expect(second.instance.get("crashed").status).toBe("interrupted");
  });
});
