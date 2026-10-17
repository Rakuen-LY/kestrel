import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { JsonSchema, Tool } from "@kestrel/agent";
import type { Context, Logger } from "@kestrel/kernel";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Tools from this server default to requiring approval. */
  approval?: "auto" | "ask";
  timeoutMs?: number;
}

export interface McpConfig {
  servers?: Record<string, McpServerConfig>;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: unknown;
}

/** Minimal MCP stdio client: initialize, list tools, call tools. */
export class McpStdioClient {
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
    private readonly config: McpServerConfig,
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
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "kestrel", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
    this.logger.info("mcp server connected", { server: this.name });
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.request("tools/list", {})) as { tools?: McpToolDescriptor[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean; data: unknown }> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .map((part) => (part.type === "text" ? part.text ?? "" : JSON.stringify(part)))
      .join("\n");
    return { content: text || "(empty result)", isError: result.isError === true, data: result };
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
      if (typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
    }
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
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
    const clients = new Map<string, McpStdioClient>();
    const discovered: Array<{ server: string; tool: McpToolDescriptor }> = [];

    for (const [serverName, serverConfig] of Object.entries(config.servers ?? {})) {
      const client = new McpStdioClient(serverName, serverConfig, context.logger.child({ mcp: serverName }));
      try {
        await client.start();
        clients.set(serverName, client);
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
              const result = await client.callTool(descriptor.name, args);
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
        client.close();
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

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

declare module "@kestrel/kernel" {
  interface ServiceMap {
    mcp: McpService;
  }
}
