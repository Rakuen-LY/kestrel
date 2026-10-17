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

export interface McpResourceDescriptor {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface McpReadResult {
  contents: McpResourceContent[];
  text: string;
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptDescriptor {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export interface McpPromptMessage {
  role: string;
  content: unknown;
}

export interface McpPromptResult {
  description?: string;
  messages: McpPromptMessage[];
  text: string;
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
  listResources(): Promise<McpResourceDescriptor[]>;
  readResource(uri: string): Promise<McpReadResult>;
  listPrompts(): Promise<McpPromptDescriptor[]>;
  getPrompt(name: string, args?: Record<string, string>): Promise<McpPromptResult>;
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

  async listResources(): Promise<McpResourceDescriptor[]> {
    const result = (await this.request("resources/list", {})) as { resources?: McpResourceDescriptor[] };
    return result.resources ?? [];
  }

  async readResource(uri: string): Promise<McpReadResult> {
    const result = (await this.request("resources/read", { uri })) as { contents?: McpResourceContent[] };
    const contents = result.contents ?? [];
    return { contents, text: formatResourceContents(contents) };
  }

  async listPrompts(): Promise<McpPromptDescriptor[]> {
    const result = (await this.request("prompts/list", {})) as { prompts?: McpPromptDescriptor[] };
    return result.prompts ?? [];
  }

  async getPrompt(name: string, args: Record<string, string> = {}): Promise<McpPromptResult> {
    const result = (await this.request("prompts/get", { name, arguments: args })) as {
      description?: string;
      messages?: McpPromptMessage[];
    };
    const messages = result.messages ?? [];
    return { description: result.description, messages, text: formatPromptMessages(messages) };
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

  async listResources(): Promise<McpResourceDescriptor[]> {
    const result = (await this.request("resources/list", {})) as { resources?: McpResourceDescriptor[] };
    return result.resources ?? [];
  }

  async readResource(uri: string): Promise<McpReadResult> {
    const result = (await this.request("resources/read", { uri })) as { contents?: McpResourceContent[] };
    const contents = result.contents ?? [];
    return { contents, text: formatResourceContents(contents) };
  }

  async listPrompts(): Promise<McpPromptDescriptor[]> {
    const result = (await this.request("prompts/list", {})) as { prompts?: McpPromptDescriptor[] };
    return result.prompts ?? [];
  }

  async getPrompt(name: string, args: Record<string, string> = {}): Promise<McpPromptResult> {
    const result = (await this.request("prompts/get", { name, arguments: args })) as {
      description?: string;
      messages?: McpPromptMessage[];
    };
    const messages = result.messages ?? [];
    return { description: result.description, messages, text: formatPromptMessages(messages) };
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
  resources(): Array<{ server: string; resource: McpResourceDescriptor }>;
  prompts(): Array<{ server: string; prompt: McpPromptDescriptor }>;
  readResource(server: string, uri: string): Promise<McpReadResult>;
  getPrompt(server: string, name: string, args?: Record<string, string>): Promise<McpPromptResult>;
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
    const discoveredResources: Array<{ server: string; resource: McpResourceDescriptor }> = [];
    const discoveredPrompts: Array<{ server: string; prompt: McpPromptDescriptor }> = [];
    const capability = new Set<string>();

    for (const [serverName, serverConfig] of Object.entries(config.servers ?? {})) {
      let client: McpClient | undefined;
      try {
        const ready = createMcpClient(serverName, serverConfig, context.logger.child({ mcp: serverName }));
        await ready.start();
        client = ready;
        clients.set(serverName, ready);
        const taken = new Set<string>();
        for (const descriptor of await client.listTools()) {
          discovered.push({ server: serverName, tool: descriptor });
          const toolName = `mcp__${sanitize(serverName)}__${sanitize(descriptor.name)}`;
          taken.add(toolName);
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

        const registerExtra = (tool: Tool): void => {
          if (taken.has(tool.schema.name)) {
            context.logger.warn("mcp bridge tool name collision", {
              server: serverName,
              tool: tool.schema.name,
            });
            return;
          }
          taken.add(tool.schema.name);
          context.effect(() => registry.register(tool));
        };
        const bridgePrefix = `mcp__${sanitize(serverName)}__`;
        const approval = serverConfig.approval ?? "ask";
        const namespace = `[MCP:${serverName}]`;

        try {
          const listed = await ready.listResources();
          capability.add(`${serverName}:resources`);
          for (const resource of listed) discoveredResources.push({ server: serverName, resource });
          registerExtra({
            schema: {
              name: `${bridgePrefix}list_resources`,
              description: `${namespace} List the resource URIs this server publishes.`,
              category: "mcp",
              permission: "auto",
              parameters: { type: "object", properties: {}, additionalProperties: false },
            },
            async execute() {
              const resources = await ready.listResources();
              return { content: JSON.stringify({ resources }, null, 2), isError: false, data: resources };
            },
          });
          registerExtra({
            schema: {
              name: `${bridgePrefix}read_resource`,
              description: `${namespace} Read a resource by URI.`,
              category: "mcp",
              permission: approval,
              parameters: {
                type: "object",
                properties: { uri: { type: "string", description: "Resource URI from list_resources." } },
                required: ["uri"],
                additionalProperties: false,
              },
            },
            async execute(args) {
              const uri = typeof args.uri === "string" ? args.uri : "";
              if (!uri) return { content: "Error: uri is required.", isError: true, data: undefined };
              const result = await ready.readResource(uri);
              return { content: result.text, isError: false, data: result.contents };
            },
          });
        } catch (error) {
          context.logger.debug("mcp resources unavailable", {
            server: serverName,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        try {
          const listed = await ready.listPrompts();
          capability.add(`${serverName}:prompts`);
          for (const prompt of listed) discoveredPrompts.push({ server: serverName, prompt });
          registerExtra({
            schema: {
              name: `${bridgePrefix}list_prompts`,
              description: `${namespace} List reusable prompt templates with their arguments.`,
              category: "mcp",
              permission: "auto",
              parameters: { type: "object", properties: {}, additionalProperties: false },
            },
            async execute() {
              const prompts = await ready.listPrompts();
              return { content: JSON.stringify({ prompts }, null, 2), isError: false, data: prompts };
            },
          });
          registerExtra({
            schema: {
              name: `${bridgePrefix}get_prompt`,
              description: `${namespace} Render a prompt template into messages.`,
              category: "mcp",
              permission: approval,
              parameters: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Prompt name from list_prompts." },
                  arguments: {
                    type: "object",
                    description: "Template arguments; values are strings.",
                    additionalProperties: { type: "string" },
                  },
                },
                required: ["name"],
                additionalProperties: false,
              },
            },
            async execute(args) {
              const name = typeof args.name === "string" ? args.name : "";
              if (!name) return { content: "Error: name is required.", isError: true, data: undefined };
              const values = isStringRecord(args.arguments) ? args.arguments : {};
              const result = await ready.getPrompt(name, values);
              const text = result.description ? `${result.description}\n\n${result.text}` : result.text;
              return { content: text, isError: false, data: result.messages };
            },
          });
        } catch (error) {
          context.logger.debug("mcp prompts unavailable", {
            server: serverName,
            error: error instanceof Error ? error.message : String(error),
          });
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
      resources: () => [...discoveredResources],
      prompts: () => [...discoveredPrompts],
      async readResource(server, uri) {
        const client = clients.get(server);
        if (!client) throw new Error(`Unknown MCP server "${server}".`);
        return client.readResource(uri);
      },
      async getPrompt(server, name, args = {}) {
        const client = clients.get(server);
        if (!client) throw new Error(`Unknown MCP server "${server}".`);
        return client.getPrompt(name, args);
      },
    };
    context.provide("mcp", service);
    context.effect(() => () => {
      for (const client of clients.values()) client.close();
    });
    context.logger.info("mcp ready", {
      servers: clients.size,
      tools: discovered.length,
      resources: discoveredResources.length,
      prompts: discoveredPrompts.length,
      capabilities: [...capability],
    });
  },
};

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function formatResourceContents(contents: McpResourceContent[]): string {
  if (contents.length === 0) return "(no contents)";
  return contents
    .map((content) => {
      const head = `[${content.uri}${content.mimeType ? ` (${content.mimeType})` : ""}]`;
      if (typeof content.text === "string") return `${head}\n${content.text}`;
      if (content.blob) return `${head}\n(binary: ${content.blob.length} base64 characters)`;
      return head;
    })
    .join("\n\n");
}

function formatPromptMessages(messages: McpPromptMessage[]): string {
  if (messages.length === 0) return "(no messages)";
  return messages.map((message) => `[${message.role}] ${promptContentToText(message.content)}`).join("\n\n");
}

function promptContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(promptContentToText).join("\n");
  if (content && typeof content === "object") {
    const part = content as {
      type?: string;
      text?: string;
      mimeType?: string;
      resource?: { uri?: string; text?: string; mimeType?: string };
    };
    if (typeof part.text === "string") return part.text;
    if (part.type === "image") return `[image ${part.mimeType ?? "unknown"}]`;
    if (part.resource?.text) return part.resource.text;
  }
  return JSON.stringify(content);
}

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
