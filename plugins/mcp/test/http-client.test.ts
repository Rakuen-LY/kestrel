import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { silencedLogger, createContext } from "@kestrel/kernel";
import { ToolRegistry, type ToolContext } from "@kestrel/agent";
import mcpPlugin, { McpHttpClient, createMcpClient } from "../src/index.js";

const logger = silencedLogger();

interface Harness {
  url: string;
  readonly initializes: number;
  calls: Array<{ name: string; args: unknown }>;
  close(): Promise<void>;
}

async function startServer(options: { expireFirstCall?: boolean } = {}): Promise<Harness> {
  const state = { initializes: 0, calls: [] as Array<{ name: string; args: unknown }> };
  const expired = { done: false };
  let session = "";

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    if (req.headers.authorization !== "Bearer test-key") {
      res.writeHead(401).end("unauthorized");
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const message = JSON.parse(body) as { id?: number; method?: string; params?: Record<string, unknown> };
      if (message.method === "initialize") {
        state.initializes += 1;
        session = `sess-${state.initializes}`;
        res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": session });
        sendSse(res, {
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock", version: "0" } },
        });
        return;
      }
      if (req.headers["mcp-session-id"] !== session) {
        res.writeHead(404).end("session expired");
        return;
      }
      if (message.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (options.expireFirstCall && message.method === "tools/call" && !expired.done) {
        expired.done = true;
        res.writeHead(404).end("session expired");
        return;
      }
      if (message.method === "tools/list") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              tools: [
                {
                  name: "lookup",
                  description: "Look something up.",
                  inputSchema: { type: "object", properties: { q: { type: "string" } } },
                },
              ],
            },
          }),
        );
        return;
      }
      if (message.method === "tools/call") {
        const params = message.params as { name: string; arguments: unknown };
        state.calls.push({ name: params.name, args: params.arguments });
        res.writeHead(200, { "content-type": "text/event-stream" });
        // A notification frame before the answer must not confuse the client.
        sendSse(res, { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } });
        sendSse(res, {
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: `found ${JSON.stringify(params.arguments)}` }] },
        });
        res.end();
        return;
      }
      if (message.method === "resources/list") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              resources: [
                { uri: "file:///handbook.md", name: "Handbook", mimeType: "text/markdown" },
              ],
            },
          }),
        );
        return;
      }
      if (message.method === "resources/read") {
        const params = message.params as { uri: string };
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              contents: [{ uri: params.uri, mimeType: "text/markdown", text: "# Handbook" }],
            },
          }),
        );
        return;
      }
      if (message.method === "prompts/list") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              prompts: [
                { name: "review", description: "Review a change", arguments: [{ name: "target", required: true }] },
              ],
            },
          }),
        );
        return;
      }
      if (message.method === "prompts/get") {
        const params = message.params as { name: string; arguments?: Record<string, string> };
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              description: "Review a change",
              messages: [
                { role: "user", content: { type: "text", text: `review ${params.arguments?.target ?? ""}` } },
                { role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] },
              ],
            },
          }),
        );
        return;
      }
      res.writeHead(400).end("unexpected method");
    });
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    get initializes() {
      return state.initializes;
    },
    calls: state.calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function sendSse(res: ServerResponse, message: unknown): void {
  res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
}

const cleanups: Array<() => Promise<void>> = [];
const clients: McpHttpClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  while (cleanups.length) await cleanups.pop()?.();
});

async function connect(url: string): Promise<McpHttpClient> {
  const client = new McpHttpClient(
    "mock",
    { url, headers: { Authorization: "Bearer ${MCP_TEST_KEY}" }, timeoutMs: 5_000 },
    logger,
  );
  clients.push(client);
  await client.start();
  return client;
}

describe("MCP over streamable HTTP", () => {
  it("initializes, lists tools from JSON and calls tools through SSE", async () => {
    process.env.MCP_TEST_KEY = "test-key";
    const harness = await startServer();
    cleanups.push(harness.close);

    const client = await connect(harness.url);
    expect(client.transport).toBe("http");
    expect(harness.initializes).toBe(1);

    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["lookup"]);

    const result = await client.callTool("lookup", { q: "kestrel" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("kestrel");
    expect(harness.calls).toEqual([{ name: "lookup", args: { q: "kestrel" } }]);
  });

  it("re-initializes when the server forgets the session", async () => {
    process.env.MCP_TEST_KEY = "test-key";
    const harness = await startServer({ expireFirstCall: true });
    cleanups.push(harness.close);

    const client = await connect(harness.url);
    const result = await client.callTool("lookup", { q: "retry" });

    expect(result.content).toContain("retry");
    expect(harness.initializes).toBe(2);
  });

  it("lists and reads resources, then renders prompt templates", async () => {
    process.env.MCP_TEST_KEY = "test-key";
    const harness = await startServer();
    cleanups.push(harness.close);
    const client = await connect(harness.url);

    const resources = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual(["file:///handbook.md"]);

    const read = await client.readResource("file:///handbook.md");
    expect(read.contents).toHaveLength(1);
    expect(read.text).toContain("[file:///handbook.md (text/markdown)]");
    expect(read.text).toContain("# Handbook");

    const prompts = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toEqual(["review"]);

    const prompt = await client.getPrompt("review", { target: "src/app.ts" });
    expect(prompt.description).toBe("Review a change");
    expect(prompt.text).toContain("[user] review src/app.ts");
    expect(prompt.text).toContain("[image image/png]");
  });

  it("registers resource and prompt tools through the plugin", async () => {
    process.env.MCP_TEST_KEY = "test-key";
    const harness = await startServer();
    cleanups.push(harness.close);
    const context = createContext({ logger });
    const registry = new ToolRegistry();
    context.provide("tools", registry);

    await mcpPlugin.apply(context, {
      servers: { mock: { url: harness.url, headers: { Authorization: "Bearer ${MCP_TEST_KEY}" } } },
    });
    cleanups.push(async () => context.dispose());

    const toolContext: ToolContext = {
      session: { id: "s1", workspace: process.cwd(), messages: [], metadata: new Map() },
      callId: "call_1",
      signal: new AbortController().signal,
      logger,
      progress: () => undefined,
    };

    const listResources = registry.get("mcp__mock__list_resources");
    expect(listResources).toBeDefined();
    const listed = await listResources!.execute({}, toolContext);
    expect(listed.content).toContain("file:///handbook.md");

    const read = await registry.get("mcp__mock__read_resource")!.execute(
      { uri: "file:///handbook.md" },
      toolContext,
    );
    expect(read.content).toContain("# Handbook");
    expect(read.isError).toBe(false);

    const prompt = await registry.get("mcp__mock__get_prompt")!.execute(
      { name: "review", arguments: { target: "src" } },
      toolContext,
    );
    expect(prompt.content).toContain("Review a change");
    expect(prompt.content).toContain("[user] review src");
  });

  it("refuses configs without a transport", () => {
    expect(() => createMcpClient("broken", {} as never, logger)).toThrow(/command.*url/);
  });
});
