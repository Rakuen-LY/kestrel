import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRequestError, isModelRequestError } from "@kestrel/agent";
import { OpenAICompatibleModel } from "../src/index.js";

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
});

async function endpoint(status: number, body: string, headers: Record<string, string> = {}): Promise<OpenAICompatibleModel> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return new OpenAICompatibleModel({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k" }, "test-model");
}

const request = { model: "test-model", messages: [], tools: [] };

describe("OpenAI provider error classification", () => {
  it("marks 429 responses retryable and reads Retry-After", async () => {
    const model = await endpoint(429, '{"error":{"message":"rate limited"}}', { "retry-after": "5" });
    const error = (await model.generate(request).catch((reason: unknown) => reason)) as ModelRequestError;

    expect(isModelRequestError(error)).toBe(true);
    expect(error).toMatchObject({ status: 429, retryable: true, retryAfterMs: 5_000 });
    expect(error.message).toMatch(/rate limited/);
  });

  it("treats 4xx client errors as final", async () => {
    const model = await endpoint(400, '{"error":{"message":"bad tools"}}');
    const error = (await model.generate(request).catch((reason: unknown) => reason)) as ModelRequestError;
    expect(error).toMatchObject({ status: 400, retryable: false });
  });

  it("treats a refused connection as retryable", async () => {
    const model = new OpenAICompatibleModel(
      { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", timeoutMs: 2_000 },
      "test-model",
    );
    const error = (await model.generate(request).catch((reason: unknown) => reason)) as ModelRequestError;
    expect(isModelRequestError(error)).toBe(true);
    expect(error.retryable).toBe(true);
  });
});
