import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessage, TokenDelta } from "@kestrel/agent";
import { AnthropicModel } from "../src/index.js";

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
});

function sse(events: unknown[]): string {
  return events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

/** Fake Anthropic endpoint that records the request and replays the given events. */
async function endpoint(
  events: unknown[],
  options: { status?: number; body?: string } = {},
): Promise<{
  model: AnthropicModel;
  baseUrl: string;
  requests: Array<{ body: Record<string, unknown>; headers: IncomingMessage["headers"]; path?: string }>;
}> {
  const requests: Array<{ body: Record<string, unknown>; headers: IncomingMessage["headers"]; path?: string }> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push({ body: JSON.parse(raw) as Record<string, unknown>, headers: req.headers, path: req.url });
      if (options.status && options.status >= 400) {
        res.writeHead(options.status, { "content-type": "application/json" });
        res.end(options.body ?? '{"type":"error","error":{"message":"boom"}}');
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse(events));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    model: new AnthropicModel({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "key-123" }, "claude-test"),
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
  };
}

function system(content: string): ChatMessage {
  return { id: "s1", role: "system", content, createdAt: new Date().toISOString() };
}

function user(content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "m1", role: "user", content, createdAt: new Date().toISOString(), ...extra };
}

describe("Anthropic provider", () => {
  it("streams text and reports usage in token deltas", async () => {
    const { model } = await endpoint([
      { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } },
      { type: "message_stop" },
    ]);
    const deltas: TokenDelta[] = [];
    const result = await model.generate({ model: "claude-test", messages: [user("hi")], tools: [] }, (delta) =>
      deltas.push(delta),
    );

    expect(result.content).toBe("Hello");
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 8, totalTokens: 20 });
    expect(deltas).toEqual([
      { channel: "text", delta: "Hel" },
      { channel: "text", delta: "lo" },
    ]);
  });

  it("reassembles a tool call from partial JSON", async () => {
    const { model } = await endpoint([
      { type: "message_start", message: { usage: { input_tokens: 20, output_tokens: 2 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "Checking." } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_01", name: "read_file" },
      },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"a.txt"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 14 } },
    ]);

    const result = await model.generate({ model: "claude-test", messages: [user("read it")], tools: [] });

    expect(result.content).toBe("Checking.");
    expect(result.toolCalls).toEqual([{ id: "toolu_01", name: "read_file", arguments: { path: "a.txt" } }]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.usage.outputTokens).toBe(14);
  });

  it("streams thinking as the reasoning channel", async () => {
    const { model } = await endpoint([
      { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "Answer" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } },
    ]);
    const deltas: TokenDelta[] = [];
    const result = await model.generate({ model: "claude-test", messages: [user("q")], tools: [] }, (delta) =>
      deltas.push(delta),
    );

    expect(result.reasoning).toBe("hmm");
    expect(result.content).toBe("Answer");
    expect(deltas.map((delta) => delta.channel)).toEqual(["reasoning", "text"]);
  });

  it("sends the system prompt, tools and images in Anthropic's shape", async () => {
    const { model, requests } = await endpoint([
      { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
    ]);
    await model.generate({
      model: "claude-test",
      messages: [
        system("Be terse."),
        user("what is this?", { images: [{ mimeType: "image/png", data: "AAAA" }] }),
      ],
      tools: [
        {
          name: "read_file",
          description: "Read a file.",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      ],
    });

    const request = requests[0];
    expect(request.path).toBe("/v1/messages");
    expect(request.headers["x-api-key"]).toBe("key-123");
    expect(request.headers["anthropic-version"]).toBe("2023-06-01");
    expect(request.body.system).toBe("Be terse.");
    expect(request.body.max_tokens).toBe(4096);
    expect(request.body.stream).toBe(true);
    expect(request.body.messages).toHaveLength(1);
    expect(request.body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    ]);
    expect(request.body.tools).toEqual([
      {
        name: "read_file",
        description: "Read a file.",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ]);
  });

  it("merges parallel tool results into one user turn", async () => {
    const { model, requests } = await endpoint([
      { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
    ]);
    await model.generate({
      model: "claude-test",
      messages: [
        user("read both"),
        {
          id: "a1",
          role: "assistant",
          content: "",
          createdAt: new Date().toISOString(),
          toolCalls: [
            { id: "toolu_a", name: "read_file", arguments: { path: "a" } },
            { id: "toolu_b", name: "read_file", arguments: { path: "b" } },
          ],
        },
        { id: "t1", role: "tool", toolCallId: "toolu_a", content: "AAA", createdAt: new Date().toISOString() },
        { id: "t2", role: "tool", toolCallId: "toolu_b", content: "BBB", createdAt: new Date().toISOString() },
      ],
      tools: [],
    });

    const messages = requests[0].body.messages as Array<{ role: string; content: unknown[] }>;
    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_a", name: "read_file", input: { path: "a" } },
        { type: "tool_use", id: "toolu_b", name: "read_file", input: { path: "b" } },
      ],
    });
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_a", content: "AAA" },
        { type: "tool_result", tool_use_id: "toolu_b", content: "BBB" },
      ],
    });
  });

  it("does not double the version segment in a proxy base URL", async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse([{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }]));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const model = new AnthropicModel({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k" }, "claude-test");
    await model.generate({ model: "claude-test", messages: [user("q")], tools: [] });
    expect((model as unknown as { config: { messagesUrl: string } }).config.messagesUrl).toBe(
      `http://127.0.0.1:${port}/v1/messages`,
    );
  });

  it("disables temperature when thinking is enabled", async () => {
    const { baseUrl, requests } = await endpoint([
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
    ]);
    const thinking = new AnthropicModel(
      { baseUrl, apiKey: "k", thinkingBudget: 1024, temperature: 0.7 },
      "claude-test",
    );
    await thinking.generate({ model: "claude-test", messages: [user("q")], tools: [], temperature: 0.2 });
    expect(requests[0].body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect(requests[0].body.temperature).toBeUndefined();
    expect(thinking.info.supportsReasoning).toBe(true);
  });

  it("includes the response body in error messages", async () => {
    const { model } = await endpoint([], {
      status: 400,
      body: '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens too large"}}',
    });
    await expect(model.generate({ model: "claude-test", messages: [user("q")], tools: [] })).rejects.toThrow(
      /400.*max_tokens too large/s,
    );
  });

  it("fails on a mid-stream error event", async () => {
    const { model } = await endpoint([
      { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: "error", error: { type: "overloaded_error", message: "try later" } },
    ]);
    await expect(model.generate({ model: "claude-test", messages: [user("q")], tools: [] })).rejects.toThrow(
      /try later/,
    );
  });
});
