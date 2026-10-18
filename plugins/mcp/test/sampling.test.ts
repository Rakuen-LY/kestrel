import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createContext, silencedLogger } from "@kestrel/kernel";
import { ModelRegistry, ToolRegistry, type ToolContext } from "@kestrel/agent";
import { ScriptedModel } from "@kestrel/testkit";
import mcpPlugin, { type McpSamplingConfig } from "../src/index.js";

const logger = silencedLogger();
const fixture = fileURLToPath(new URL("./fixtures/sampling-server.mjs", import.meta.url));
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function setup(sampling?: McpSamplingConfig) {
  const context = createContext({ logger });
  const tools = new ToolRegistry();
  const models = new ModelRegistry();
  context.provide("tools", tools);
  context.provide("models", models);
  const model = new ScriptedModel([{ content: "A short answer." }], { id: "mock-model" });
  models.register(model, { setDefault: true });

  await mcpPlugin.apply(context, {
    servers: {
      mock: { command: process.execPath, args: [fixture], timeoutMs: 5_000 },
    },
    sampling,
  });
  cleanups.push(async () => context.dispose());
  return { tools, model, models };
}

async function startHttpServer(): Promise<{ url: string; close(): Promise<void> }> {
  let pending: ServerResponse | undefined;
  let toolRequestId: number | string | undefined;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const message = JSON.parse(body) as { id?: number | string; method?: string; result?: unknown };
      if (message.method === "initialize") {
        res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "sampling" });
        res.end(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { sampling: {} },
              serverInfo: { name: "http-sampling", version: "0" },
            },
          })}\n\n`,
        );
        return;
      }
      if (message.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (message.method === "tools/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              tools: [
                {
                  name: "ask",
                  inputSchema: { type: "object", properties: { question: { type: "string" } } },
                },
              ],
            },
          }),
        );
        return;
      }
      if (message.method === "resources/list" || message.method === "prompts/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
        return;
      }
      if (message.method === "tools/call") {
        toolRequestId = message.id;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: "sample-1",
            method: "sampling/createMessage",
            params: {
              messages: [{ role: "user", content: { type: "text", text: "over http" } }],
            },
          })}\n\n`,
        );
        pending = res;
        return;
      }
      // The client answering our sampling request.
      if (message.id === "sample-1" && pending) {
        res.writeHead(202).end();
        const sampled = (message.result as { content?: { text?: string } } | undefined)?.content?.text ?? "";
        pending.write(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: toolRequestId,
            result: { content: [{ type: "text", text: `http sampled: ${sampled}` }] },
          })}\n\n`,
        );
        pending.end();
        pending = undefined;
        return;
      }
      res.writeHead(404).end("unexpected");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function toolContext(): ToolContext {
  return {
    session: { id: "s1", workspace: process.cwd(), messages: [], metadata: new Map() },
    callId: "call_1",
    signal: new AbortController().signal,
    logger,
    progress: () => undefined,
  };
}

describe("MCP sampling", () => {
  it("declares the capability and answers createMessage with the configured model", async () => {
    const { tools, model } = await setup({ enabled: true });

    const caps = await tools.get("mcp__mock__caps")!.execute({}, toolContext());
    expect(JSON.parse(caps.content)).toEqual({ sampling: {} });

    const answer = await tools.get("mcp__mock__ask")!.execute(
      { question: "Why is the sky blue?" },
      toolContext(),
    );
    expect(answer.isError).toBe(false);
    expect(answer.content).toBe("sampled: A short answer.");

    expect(model.requests).toHaveLength(1);
    const request = model.requests[0];
    expect(request.model).toBe("mock-model");
    expect(request.maxTokens).toBe(64);
    expect(request.messages[0]).toMatchObject({
      role: "system",
      content: "Answer in one short sentence.",
    });
    expect(request.messages[1]).toMatchObject({ role: "user", content: "Why is the sky blue?" });
  });

  it("does not advertise or answer sampling unless enabled", async () => {
    const { tools, model } = await setup();

    const caps = await tools.get("mcp__mock__caps")!.execute({}, toolContext());
    expect(JSON.parse(caps.content)).toEqual({});

    const answer = await tools.get("mcp__mock__ask")!.execute({ question: "Hello" }, toolContext());
    expect(answer.isError).toBe(true);
    expect(answer.content).toContain("Sampling is not enabled");
    expect(model.requests).toHaveLength(0);
  });

  it("answers sampling requests on the streamable HTTP transport", async () => {
    const server = await startHttpServer();
    cleanups.push(server.close);
    const context = createContext({ logger });
    const tools = new ToolRegistry();
    const models = new ModelRegistry();
    context.provide("tools", tools);
    context.provide("models", models);
    const model = new ScriptedModel([{ content: "HTTP answer." }], { id: "mock-model" });
    models.register(model, { setDefault: true });
    await mcpPlugin.apply(context, {
      servers: { mock: { url: server.url, timeoutMs: 5_000 } },
      sampling: { enabled: true },
    });
    cleanups.push(async () => context.dispose());

    const answer = await tools.get("mcp__mock__ask")!.execute({ question: "over http" }, toolContext());
    expect(answer.content).toBe("http sampled: HTTP answer.");
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0].messages.map((message) => message.content)).toEqual(["over http"]);
  });

  it("caps output tokens and enforces the per-call request budget", async () => {
    const { tools, model } = await setup({ enabled: true, maxTokens: 32, maxRequestsPerCall: 1 });

    const answer = await tools.get("mcp__mock__ask_twice")!.execute(
      { question: "Count to two" },
      toolContext(),
    );
    expect(answer.isError).toBe(true);
    expect(answer.content).toContain("Sampling request budget exhausted");
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0].maxTokens).toBe(32);
  });
});
