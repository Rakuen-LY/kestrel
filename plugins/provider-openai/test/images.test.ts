import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "@kestrel/protocol";
import { OpenAICompatibleModel } from "../src/index.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+4wAAAABJRU5ErkJggg==";
const servers: Server[] = [];

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
});

/** Starts a fake endpoint that records one request body and answers with a tiny stream. */
async function capture(): Promise<{ model: OpenAICompatibleModel; body: () => Record<string, unknown> }> {
  let body: Record<string, unknown> = {};
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      body = JSON.parse(raw) as Record<string, unknown>;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    model: new OpenAICompatibleModel({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test" }, "vision"),
    body: () => body,
  };
}

function user(content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "m1", role: "user", content, createdAt: new Date().toISOString(), ...extra };
}

describe("OpenAI-compatible image messages", () => {
  it("serializes attachments as content parts with a data URL", async () => {
    const { model, body } = await capture();
    await model.generate({
      messages: [user("what is this?", { images: [{ mimeType: "image/png", data: PNG, name: "dot.png" }] })],
      tools: [],
    });

    expect((body().messages as Array<{ content: unknown }>)[0].content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
    ]);
  });

  it("omits the text part for an image-only message", async () => {
    const { model, body } = await capture();
    await model.generate({
      messages: [user("", { images: [{ mimeType: "image/jpeg", data: "AAAA" }] })],
      tools: [],
    });

    const content = (body().messages as Array<{ content: Array<{ type: string }> }>)[0].content;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("image_url");
  });

  it("keeps text-only messages as plain strings", async () => {
    const { model, body } = await capture();
    await model.generate({ messages: [user("plain")], tools: [] });
    expect((body().messages as Array<{ content: unknown }>)[0].content).toBe("plain");
  });
});
