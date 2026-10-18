import { randomUUID } from "node:crypto";
import type { ChatMessage, ImageAttachment } from "@kestrel/protocol";
import type { ModelRegistry } from "@kestrel/agent";

/** `sampling/createMessage` parameters, as sent by an MCP server. */
export interface McpSamplingRequest {
  messages?: Array<{ role?: string; content?: unknown }>;
  systemPrompt?: string;
  includeContext?: "none" | "thisServer" | "allServers";
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  modelPreferences?: {
    hints?: Array<{ name?: string }>;
    costPriority?: number;
    speedPriority?: number;
    intelligencePriority?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface McpSamplingResult {
  role: "assistant";
  content: { type: "text"; text: string };
  model: string;
  stopReason: string;
}

export type SamplingHandler = (request: McpSamplingRequest, signal: AbortSignal) => Promise<McpSamplingResult>;

export interface McpSamplingConfig {
  /** Off unless a deployment opts in: every request spends model tokens. */
  enabled?: boolean;
  /** Model id; defaults to the registry's default, then to model hints. */
  model?: string;
  /** Ceiling for one completion, regardless of what the server asks for. */
  maxTokens?: number;
  temperature?: number;
  /** Safety valve against a server that samples in a loop. */
  maxRequestsPerCall?: number;
}

export interface McpCallOptions {
  sampling?: SamplingHandler;
  signal?: AbortSignal;
}

const DEFAULT_MAX_TOKENS = 1_024;
const DEFAULT_MAX_REQUESTS = 8;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * Builds a sampling handler bound to one model. Each MCP tool execution gets
 * its own handler so the request budget and abort signal cannot leak between
 * sessions sharing a server process.
 */
export function createSampler(
  models: ModelRegistry,
  config: McpSamplingConfig = {},
): SamplingHandler {
  const ceiling = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  let remaining = config.maxRequestsPerCall ?? DEFAULT_MAX_REQUESTS;

  return async (request, signal) => {
    if (remaining <= 0) {
      throw new Error(
        `Sampling request budget exhausted (${config.maxRequestsPerCall ?? DEFAULT_MAX_REQUESTS} per tool call).`,
      );
    }
    remaining -= 1;

    const model = resolveModel(models, config, request);
    const requested = request.maxTokens ?? ceiling;
    const maxTokens = Math.max(1, Math.min(requested, ceiling));
    const response = await model.generate({
      model: model.info.id,
      messages: toChatMessages(request),
      tools: [],
      temperature: request.temperature ?? config.temperature,
      maxTokens,
      signal,
    });

    return {
      role: "assistant",
      content: { type: "text", text: response.content },
      model: model.info.id,
      stopReason: response.finishReason === "length" ? "maxTokens" : "endTurn",
    };
  };
}

function resolveModel(
  models: ModelRegistry,
  config: McpSamplingConfig,
  request: McpSamplingRequest,
) {
  if (config.model) return models.get(config.model);
  for (const hint of request.modelPreferences?.hints ?? []) {
    const name = hint.name?.trim().toLowerCase();
    if (!name) continue;
    if (models.has(name)) return models.get(name);
    const match = models
      .list()
      .find((info) => info.id.toLowerCase().includes(name) || name.includes(info.id.toLowerCase()));
    if (match) return models.get(match.id);
  }
  return models.get();
}

function toChatMessages(request: McpSamplingRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const createdAt = new Date().toISOString();
  if (request.systemPrompt) {
    messages.push({
      id: randomUUID(),
      role: "system",
      content: request.systemPrompt,
      createdAt,
    });
  }
  for (const message of request.messages ?? []) {
    const role = message.role === "assistant" ? "assistant" : "user";
    const { text, images } = readContent(message.content, role === "user");
    messages.push({
      id: randomUUID(),
      role,
      content: text || (images.length ? `[${images.length} image${images.length === 1 ? "" : "s"}]` : ""),
      images: images.length ? images : undefined,
      createdAt,
    });
  }
  return messages;
}

function readContent(content: unknown, allowImages: boolean): { text: string; images: ImageAttachment[] } {
  const text: string[] = [];
  const images: ImageAttachment[] = [];
  const visit = (part: unknown): void => {
    if (typeof part === "string") {
      text.push(part);
      return;
    }
    if (Array.isArray(part)) {
      for (const item of part) visit(item);
      return;
    }
    if (!part || typeof part !== "object") return;
    const value = part as {
      type?: string;
      text?: string;
      data?: string;
      mimeType?: string;
      resource?: { uri?: string; text?: string };
    };
    if (value.type === "image" && value.data) {
      const mimeType = value.mimeType ?? "";
      if (allowImages && IMAGE_TYPES.has(mimeType)) {
        images.push({ mimeType: mimeType as ImageAttachment["mimeType"], data: value.data });
      } else {
        text.push(`[image ${mimeType || "unknown"}]`);
      }
      return;
    }
    if (value.type === "audio") {
      text.push(`[audio ${value.mimeType ?? "unknown"}]`);
      return;
    }
    if (value.resource) {
      text.push(value.resource.text ?? `[resource ${value.resource.uri ?? "unknown"}]`);
      return;
    }
    if (typeof value.text === "string") text.push(value.text);
  };
  visit(content);
  return { text: text.filter(Boolean).join("\n"), images };
}

/**
 * Serializes tool calls per MCP client so a `sampling/createMessage` request
 * can be attributed to exactly one caller. The protocol carries no parent id
 * on server requests, so overlapping calls on a shared stdio process would
 * otherwise race for the handler.
 */
export class SamplingGate {
  private queue: Promise<unknown> = Promise.resolve();
  private handler?: SamplingHandler;
  private signal?: AbortSignal;

  run<T>(options: McpCallOptions | undefined, fn: () => Promise<T>): Promise<T> {
    const execute = async (): Promise<T> => {
      const previous = { handler: this.handler, signal: this.signal };
      this.handler = options?.sampling;
      this.signal = options?.signal;
      try {
        return await fn();
      } finally {
        this.handler = previous.handler;
        this.signal = previous.signal;
      }
    };
    const result = this.queue.then(execute, execute);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async answer(message: {
    id?: number | string;
    method?: string;
    params?: unknown;
  }): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    if (message.method !== "sampling/createMessage") {
      return {
        error: { code: -32601, message: `Unsupported server request "${message.method ?? ""}".` },
      };
    }
    if (!this.handler) {
      return {
        error: { code: -32601, message: "Sampling is not enabled for this server." },
      };
    }
    try {
      const result = await this.handler(
        (message.params ?? {}) as McpSamplingRequest,
        this.signal ?? new AbortController().signal,
      );
      return { result };
    } catch (error) {
      return {
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }
}
