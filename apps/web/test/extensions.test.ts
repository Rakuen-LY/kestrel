import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@kestrel/protocol";
import { matchesMessage, messagePayload } from "../src/extensions.js";

function message(extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    role: "assistant",
    content: "Hello",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

describe("plugin slot matching", () => {
  it("renders for user and assistant messages by default", () => {
    expect(matchesMessage(undefined, message({ role: "user" }))).toBe(true);
    expect(matchesMessage(undefined, message())).toBe(true);
    expect(matchesMessage(undefined, message({ role: "tool" }))).toBe(false);
    expect(matchesMessage(undefined, message({ role: "system" }))).toBe(false);
  });

  it("filters by role", () => {
    expect(matchesMessage({ roles: ["user"] }, message({ role: "user" }))).toBe(true);
    expect(matchesMessage({ roles: ["user"] }, message())).toBe(false);
  });

  it("filters by the tools a message called", () => {
    const withTools = message({
      toolCalls: [
        { id: "c1", name: "read_file", arguments: { path: "a" } },
        { id: "c2", name: "browser_screenshot", arguments: {} },
      ],
    });
    expect(matchesMessage({ toolNames: ["browser_screenshot"] }, withTools)).toBe(true);
    expect(matchesMessage({ toolNames: ["browser_open"] }, withTools)).toBe(false);
    expect(matchesMessage({ toolNames: ["browser_open"] }, message())).toBe(false);
  });
});

describe("message payload", () => {
  it("strips image data before posting to a sandbox", () => {
    const payload = messagePayload(
      message({
        images: [{ mimeType: "image/png", data: "AAAA", name: "shot.png" }],
      }),
    );
    expect(payload.images).toEqual([{ mimeType: "image/png", name: "shot.png" }]);
    expect(JSON.stringify(payload)).not.toContain("AAAA");
  });

  it("carries reasoning, model and tool calls", () => {
    const payload = messagePayload(
      message({
        content: "",
        reasoning: "thinking",
        model: "gpt-test",
        toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a" } }],
      }),
    );
    expect(payload).toMatchObject({
      id: "m1",
      role: "assistant",
      reasoning: "thinking",
      model: "gpt-test",
      toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a" } }],
    });
  });
});
