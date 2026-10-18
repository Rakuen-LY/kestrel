import type {
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  FinishReason,
  LanguageModel,
  ModelInfo,
  TokenDelta,
  ToolCall,
} from "@kestrel/agent";
import { modelHttpError, modelNetworkError, ModelRequestError } from "@kestrel/agent/errors";
import type { Context } from "@kestrel/kernel";

export interface AnthropicProviderConfig {
  /** Origin or proxy root; `/v1` is appended unless already present. */
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  /** Provider label shown in the console. */
  provider?: string;
  /** One or more model ids, e.g. `claude-sonnet-4-5`. */
  model?: string;
  models?: string[];
  label?: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** Extended thinking budget in tokens. Enables thinking when set. */
  thinkingBudget?: number;
  timeoutMs?: number;
  /** Sent as `anthropic-version`; override only for compatible proxies. */
  anthropicVersion?: string;
}

const DEFAULTS = {
  baseUrl: "https://api.anthropic.com",
  apiKeyEnv: "ANTHROPIC_API_KEY",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  anthropicVersion: "2023-06-01",
  maxTokens: 4096,
  timeoutMs: 180_000,
};

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }>;
      is_error?: boolean;
    };

type WireMessage = { role: "user" | "assistant"; content: ContentBlock[] };

export class AnthropicModel implements LanguageModel {
  readonly info: ModelInfo;
  private readonly config: AnthropicProviderConfig & { baseUrl: string; timeoutMs: number; messagesUrl: string };
  private readonly apiKey: string;

  constructor(config: AnthropicProviderConfig, modelId: string) {
    const provider = config.provider ?? DEFAULTS.provider;
    this.info = {
      id: modelId,
      provider,
      label: config.label ?? modelId,
      contextWindow: config.contextWindow,
      supportsTools: config.supportsTools ?? true,
      supportsReasoning: config.supportsReasoning ?? Boolean(config.thinkingBudget),
    };
    const baseUrl = (config.baseUrl ?? DEFAULTS.baseUrl).replace(/\/$/, "");
    this.config = {
      ...config,
      baseUrl,
      messagesUrl: `${baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`}/messages`,
      timeoutMs: config.timeoutMs ?? DEFAULTS.timeoutMs,
    };
    this.apiKey = config.apiKey ?? (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined) ?? "";
  }

  async generate(request: CompletionRequest, onDelta?: (delta: TokenDelta) => void): Promise<CompletionResponse> {
    const { system, messages } = toWireMessages(request.messages);
    const body: Record<string, unknown> = {
      model: this.info.id,
      max_tokens: request.maxTokens ?? this.config.maxTokens ?? DEFAULTS.maxTokens,
      messages,
      stream: true,
    };
    if (system) body.system = system;
    if (this.config.supportsTools !== false && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }
    const temperature = request.temperature ?? this.config.temperature;
    if (temperature !== undefined) body.temperature = temperature;
    if (this.config.thinkingBudget !== undefined) {
      // Anthropic requires temperature 1 with extended thinking.
      delete body.temperature;
      body.thinking = { type: "enabled", budget_tokens: this.config.thinkingBudget };
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      "anthropic-version": this.config.anthropicVersion ?? DEFAULTS.anthropicVersion,
      ...this.config.headers,
    };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;

    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(this.config.messagesUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (request.signal?.aborted) throw error;
      if (timeout.aborted) {
        throw new ModelRequestError(`Model request timed out after ${this.config.timeoutMs}ms.`, {
          retryable: true,
          cause: error,
        });
      }
      throw modelNetworkError(error, "Model request failed");
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw modelHttpError(response.status, response.statusText, text, response.headers.get("retry-after"));
    }
    if (!response.body) {
      throw new ModelRequestError("Model endpoint returned an empty stream.", { retryable: true });
    }

    return readStream(response.body, onDelta);
  }
}

interface WireEvent {
  type?: string;
  index?: number;
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  content_block?: { type?: string; id?: string; name?: string; text?: string; input?: Record<string, unknown> };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
    stop_sequence?: string | null;
  };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  onDelta?: (delta: TokenDelta) => void,
): Promise<CompletionResponse> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let stopReason: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens: number | undefined;
  const blocks = new Map<number, { type: string; id: string; name: string; json: string; input?: Record<string, unknown> }>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n");
      while (boundary >= 0) {
        const line = buffer.slice(0, boundary).replace(/\r$/, "");
        buffer = buffer.slice(boundary + 1);
        boundary = buffer.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let event: WireEvent;
        try {
          event = JSON.parse(data) as WireEvent;
        } catch {
          continue;
        }
        switch (event.type) {
          case "message_start": {
            const usage = event.message?.usage;
            inputTokens = usage?.input_tokens ?? 0;
            outputTokens = usage?.output_tokens ?? 0;
            cachedInputTokens = usage?.cache_read_input_tokens;
            break;
          }
          case "content_block_start": {
            const block = event.content_block;
            if (block?.type === "text" && block.text) {
              content += block.text;
              onDelta?.({ channel: "text", delta: block.text });
            }
            if (block?.type === "thinking" && block.text) {
              reasoning += block.text;
              onDelta?.({ channel: "reasoning", delta: block.text });
            }
            blocks.set(event.index ?? blocks.size, {
              type: block?.type ?? "text",
              id: block?.id ?? "",
              name: block?.name ?? "",
              json: "",
              input: block?.input,
            });
            break;
          }
          case "content_block_delta": {
            const delta = event.delta;
            if (!delta) break;
            if (delta.type === "text_delta" && delta.text) {
              content += delta.text;
              onDelta?.({ channel: "text", delta: delta.text });
            } else if (delta.type === "thinking_delta" && delta.thinking) {
              reasoning += delta.thinking;
              onDelta?.({ channel: "reasoning", delta: delta.thinking });
            } else if (delta.type === "input_json_delta" && delta.partial_json) {
              const block = blocks.get(event.index ?? 0);
              if (block) block.json += delta.partial_json;
            }
            break;
          }
          case "message_delta": {
            if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
            if (event.usage?.output_tokens !== undefined) outputTokens = event.usage.output_tokens;
            break;
          }
          case "error": {
            const kind = event.error?.type ?? "api_error";
            throw new ModelRequestError(`Model stream error: ${event.error?.message ?? "unknown error"}`, {
              retryable: !kind.endsWith("invalid_request_error"),
            });
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const toolCalls: ToolCall[] = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, block]) => block.type === "tool_use" && block.name)
    .map(([index, block]) => ({
      id: block.id || `toolu_${index}_${Date.now().toString(36)}`,
      name: block.name,
      arguments: block.json.trim() ? parseArguments(block.json) : (block.input ?? {}),
    }));

  return {
    content,
    reasoning: reasoning || undefined,
    toolCalls,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cachedInputTokens,
    },
    finishReason: finishReason(stopReason, toolCalls.length > 0),
  };
}

function finishReason(stopReason: string | undefined, hasTools: boolean): FinishReason {
  if (hasTools || stopReason === "tool_use") return "tool_calls";
  switch (stopReason) {
    case "max_tokens":
      return "length";
    case "refusal":
      return "content_filter";
    case "end_turn":
    case "stop_sequence":
    case undefined:
      return "stop";
    default:
      return stopReason;
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return { __raw: raw };
  } catch {
    return { __raw: raw };
  }
}

/**
 * Converts the provider-neutral transcript into Anthropic's block format.
 *
 * Two differences matter: the system prompt is a top-level field rather than a
 * message, and tool results travel as user-content blocks. Consecutive tool
 * results are merged into one user turn, which is what the API expects after a
 * parallel tool call.
 */
function toWireMessages(messages: readonly ChatMessage[]): { system: string; messages: WireMessage[] } {
  const system: string[] = [];
  const wire: WireMessage[] = [];

  const pushToolResult = (block: Extract<ContentBlock, { type: "tool_result" }>): void => {
    const last = wire[wire.length - 1];
    if (last?.role === "user" && last.content.every((item) => item.type === "tool_result")) {
      last.content.push(block);
      return;
    }
    wire.push({ role: "user", content: [block] });
  };

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content.trim()) system.push(message.content);
      continue;
    }
    if (message.role === "tool") {
      const content: Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }> = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const image of message.images ?? []) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: image.mimeType, data: image.data },
        });
      }
      pushToolResult({
        type: "tool_result",
        tool_use_id: message.toolCallId ?? "",
        content: message.images?.length ? content : message.content,
      });
      continue;
    }
    if (message.role === "assistant") {
      const blocks: ContentBlock[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
      }
      if (blocks.length === 0) blocks.push({ type: "text", text: "" });
      wire.push({ role: "assistant", content: blocks });
      continue;
    }
    const blocks: ContentBlock[] = [];
    if (message.content) blocks.push({ type: "text", text: message.content });
    for (const image of message.images ?? []) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: image.mimeType, data: image.data },
      });
    }
    if (blocks.length === 0) blocks.push({ type: "text", text: "" });
    wire.push({ role: "user", content: blocks });
  }

  return { system: system.join("\n\n"), messages: wire };
}

export default {
  name: "@kestrel/plugin-anthropic",
  version: "0.1.0",
  description: "Anthropic Messages API provider: streaming text, thinking, tool use and images.",
  inject: ["models"],
  apply(context: Context, config: AnthropicProviderConfig = {}) {
    const models = context.get("models");
    const provider = config.provider ?? DEFAULTS.provider;
    const ids = config.models?.length ? config.models : [config.model ?? DEFAULTS.model];
    for (const id of ids) {
      const model = new AnthropicModel({ ...config, provider }, id);
      context.effect(() => models.register(model));
    }
    context.logger.info("anthropic provider ready", {
      provider,
      models: ids,
      baseUrl: config.baseUrl ?? DEFAULTS.baseUrl,
      hasApiKey: Boolean(config.apiKey ?? (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined)),
    });
  },
};
