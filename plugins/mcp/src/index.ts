import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { JsonSchema, Tool } from "@kestrel/agent";
import type { Context, Logger } from "@kestrel/kernel";

const PROTOCOL_VERSION = "2025-06-18";

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
}

export interface McpToolResult {
  content: string;
  isError: boolean;
  data: unknown;
}

export interface McpStdioConfig {
  /** Executable to launch. Mutually exclusive with `url`. */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Tools from this server default to requiring approval. */
  approval?: "auto" | "ask";
  timeoutMs?: number;
}

export interface McpHttpConfig {
  /** Streamable HTTP endpoint. Mutually exclusive with `command`. */
  url: string;
  /**
   * Extra request headers. Values may reference environment variables as
   * `${NAME}`; headers that resolve to an empty string are dropped.
   */
  headers?: Record<string, string>;
  approval?: "auto" | "ask";
  timeoutMs?: number;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export interface McpConfig {
  servers?: Record<string, McpServerConfig>;
}

/** Transport-neutral surface used by the plugin and by `McpService`. */
export interface McpClient {
  readonly name: string;
  readonly transport: "stdio" | "http";
  start(): Promise<void>;
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  close(): void;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: unknown;
}

/** JSON-RPC over a child process, one JSON object per line. */
export class McpStdioClient implements McpClient {
  readonly transport = "stdio" as const;
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private closed = false;

  constructor(
    readonly name: string,
    private readonly config: McpStdioConfig,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    this.child = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.logger.debug("mcp stderr", { server: this.name, line: chunk.trim().slice(0, 500) });
    });
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code) => {
      this.closed = true;
      this.failAll(new Error(`MCP server "${this.name}" exited with code ${code ?? "null"}.`));
    });

    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "kestrel", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
    this.logger.info("mcp server connected", { server: this.name, transport: "stdio" });
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.request("tools/list", {})) as { tools?: McpToolDescriptor[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    return { content: textOf(result), isError: result.isError === true, data: result };
  }

  close(): void {
    this.closed = true;
    this.failAll(new Error(`MCP server "${this.name}" was closed.`));
    this.child?.kill();
    this.child = undefined;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.child || this.closed) return Promise.reject(new Error(`MCP server "${this.name}" is not running.`));
    const id = this.nextId++;
    const timeout = this.config.timeoutMs ?? 120_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${timeout}ms.`));
      }, timeout);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: unknown): void {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        this.logger.debug("mcp non-json output", { server: this.name, line: line.slice(0, 300) });
        continue;
      }
      this.settle(message);
    }
  }

  private settle(message: JsonRpcResponse): void {
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
    else pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

/**
 * Streamable HTTP transport: every request is a POST that answers either with
 * one JSON object or with an SSE stream carrying the response. Servers may pin
 * a session with `Mcp-Session-Id`, which we echo on later calls and drop when
 * the server reports it expired.
 */
export class McpHttpClient implements McpClient {
  readonly transport = "http" as const;
  private sessionId?: string;
  private nextId = 1;

  constructor(
    readonly name: string,
    private readonly config: McpHttpConfig,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    await this.initialize();
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, false);
    this.logger.info("mcp server connected", { server: this.name, transport: "http", url: this.config.url });
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.request("tools/list", {})) as { tools?: McpToolDescriptor[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    return { content: textOf(result), isError: result.isError === true, data: result };
  }

  close(): void {
    const session = this.sessionId;
    this.sessionId = undefined;
    if (!session) return;
    void fetch(this.config.url, {
      method: "DELETE",
      headers: this.headers(session),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "kestrel", version: "0.1.0" },
    });
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const message = await this.exchange({ jsonrpc: "2.0", id, method, params });
    if (!message) throw new Error(`MCP server "${this.name}" returned no response to "${method}".`);
    if (message.error) throw new Error(`MCP error ${message.error.code}: ${message.error.message}`);
    return message.result;
  }

  private async exchange(body: Record<string, unknown>): Promise<JsonRpcResponse | undefined> {
    try {
      return await this.post(body, true);
    } catch (error) {
      if (!isExpiredSession(error) || !this.sessionId) throw error;
      this.logger.info("mcp session expired, re-initializing", { server: this.name });
      this.sessionId = undefined;
      await this.initialize();
      return await this.post({ ...body }, true);
    }
  }

  private async post(body: Record<string, unknown>, expectResponse: boolean): Promise<JsonRpcResponse | undefined> {
    const timeout = this.config.timeoutMs ?? 120_000;
    const response = await fetch(this.config.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (expectResponse && !response.ok) {
      const detail = await response.text().catch(() => "");
      throw new HttpError(
        response.status,
        `MCP HTTP ${response.status} from "${this.name}"${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
    }
    if (!expectResponse) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const type = response.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream")) return await this.readEventStream(response, body.id);
    return (await response.json()) as JsonRpcResponse;
  }

  private async readEventStream(response: Response, requestId: unknown): Promise<JsonRpcResponse | undefined> {
    if (!response.body) return undefined;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let answer: JsonRpcResponse | undefined;
    try {
      while (!answer) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          const message = parseSseFrame(frame, this.logger, this.name);
          if (!message) continue;
          if (typeof message.id !== "undefined" && message.id === requestId) {
            answer = message;
            break;
          }
          if (message.method) this.logger.debug("mcp notification", { server: this.name, method: message.method });
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return answer;
  }

  private headers(session = this.sessionId): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    for (const [key, value] of Object.entries(this.config.headers ?? {})) {
      const expanded = expandEnv(value);
      if (expanded) headers[key.toLowerCase()] = expanded;
    }
    if (session) headers["mcp-session-id"] = session;
    return headers;
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function createMcpClient(name: string, config: McpServerConfig, logger: Logger): McpClient {
  if ("url" in config && config.url) return new McpHttpClient(name, config, logger);
  if ("command" in config && config.command) return new McpStdioClient(name, config, logger);
  throw new Error(`MCP server "${name}" needs either "command" (stdio) or "url" (http).`);
}

export interface McpService {
  servers(): string[];
  tools(): Array<{ server: string; tool: McpToolDescriptor }>;
  call(server: string, tool: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }>;
}

export default {
  name: "@kestrel/plugin-mcp",
  version: "0.1.0",
  description: "Connect Model Context Protocol servers and expose their tools to the agent.",
  inject: ["tools"],
  async apply(context: Context, config: McpConfig = {}) {
    const registry = context.get("tools");
    const clients = new Map<string, McpClient>();
    const discovered: Array<{ server: string; tool: McpToolDescriptor }> = [];

    for (const [serverName, serverConfig] of Object.entries(config.servers ?? {})) {
      let client: McpClient | undefined;
      try {
        const ready = createMcpClient(serverName, serverConfig, context.logger.child({ mcp: serverName }));
        await ready.start();
        client = ready;
        clients.set(serverName, ready);
        for (const descriptor of await client.listTools()) {
          discovered.push({ server: serverName, tool: descriptor });
          const toolName = `mcp__${sanitize(serverName)}__${sanitize(descriptor.name)}`;
          const tool: Tool = {
            schema: {
              name: toolName,
              description: `[MCP:${serverName}] ${descriptor.description ?? descriptor.name}`,
              category: "mcp",
              permission: serverConfig.approval ?? "ask",
              parameters: descriptor.inputSchema ?? { type: "object", additionalProperties: true },
            },
            async execute(args) {
              const result = await ready.callTool(descriptor.name, args);
              return { content: result.content, isError: result.isError, data: result.data };
            },
          };
          context.effect(() => registry.register(tool));
        }
      } catch (error) {
        context.logger.error("mcp server failed", {
          server: serverName,
          error: error instanceof Error ? error.message : String(error),
        });
        client?.close();
      }
    }

    const service: McpService = {
      servers: () => [...clients.keys()],
      tools: () => [...discovered],
      async call(server, tool, args) {
        const client = clients.get(server);
        if (!client) throw new Error(`Unknown MCP server "${server}".`);
        const result = await client.callTool(tool, args);
        return { content: result.content, isError: result.isError };
      },
    };
    context.provide("mcp", service);
    context.effect(() => () => {
      for (const client of clients.values()) client.close();
    });
    context.logger.info("mcp ready", { servers: clients.size, tools: discovered.length });
  },
};

function textOf(result: { content?: Array<{ type?: string; text?: string }> }): string {
  const text = (result.content ?? [])
    .map((part) => (part.type === "text" ? part.text ?? "" : JSON.stringify(part)))
    .join("\n");
  return text || "(empty result)";
}

function parseSseFrame(frame: string, logger: Logger, server: string): JsonRpcResponse | undefined {
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line.startsWith("data:")) continue;
    data.push(line.slice(5).trimStart());
  }
  if (!data.length) return undefined;
  try {
    return JSON.parse(data.join("\n")) as JsonRpcResponse;
  } catch {
    logger.debug("mcp sse frame was not json", { server, frame: frame.slice(0, 300) });
    return undefined;
  }
}

function isExpiredSession(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 404 || error.status === 410);
}

function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "");
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

declare module "@kestrel/kernel" {
  interface ServiceMap {
    mcp: McpService;
  }
}
