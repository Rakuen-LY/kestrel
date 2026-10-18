import type {
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  ImageAttachment,
  LanguageModel,
  ModelInfo,
  TokenDelta,
  Usage,
} from "@kestrel/agent";
import { modelHttpError, modelNetworkError, ModelRequestError } from "@kestrel/agent";
import type { Context } from "@kestrel/kernel";

export interface OpenAIProviderConfig {
  /** Any OpenAI-compatible endpoint, e.g. OpenAI, DeepSeek, vLLM, Ollama. */
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  /** Provider label shown in the console. */
  provider?: string;
  /** One or more model ids understood by the endpoint. */
  model?: string;
  models?: string[];
  label?: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Send `stream_options.include_usage` (OpenAI and most compatible APIs). */
  streamUsage?: boolean;
}

const DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
  apiKeyEnv: "OPENAI_API_KEY",
  provider: "openai",
  model: "gpt-4o-mini",
  timeoutMs: 180_000,
};

export class OpenAICompatibleModel implements LanguageModel {
  readonly info: ModelInfo;
  private readonly config: OpenAIProviderConfig & { baseUrl: string; timeoutMs: number };
  private readonly apiKey: string;

  constructor(config: OpenAIProviderConfig, modelId: string) {
    const provider = config.provider ?? DEFAULTS.provider;
    this.info = {
      id: modelId,
      provider,
      label: config.label ?? modelId,
      contextWindow: config.contextWindow,
      supportsTools: config.supportsTools ?? true,
      supportsReasoning: config.supportsReasoning,
    };
    this.config = {
      ...config,
      baseUrl: (config.baseUrl ?? DEFAULTS.baseUrl).replace(/\/$/, ""),
      timeoutMs: config.timeoutMs ?? DEFAULTS.timeoutMs,
    };
    this.apiKey = config.apiKey ?? (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined) ?? "";
  }

  async generate(request: CompletionRequest, onDelta?: (delta: TokenDelta) => void): Promise<CompletionResponse> {
    const body: Record<string, unknown> = {
      model: this.info.id,
      messages: toWireMessages(request.messages),
      stream: true,
    };
    if (this.config.supportsTools !== false && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
      body.tool_choice = "auto";
    }
    const temperature = request.temperature ?? this.config.temperature;
    if (temperature !== undefined) body.temperature = temperature;
    const maxTokens = request.maxTokens ?? this.config.maxTokens;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    if (this.config.streamUsage !== false) body.stream_options = { include_usage: true };

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...this.config.headers,
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/chat/completions`, {
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

interface WireChunk {
  choices?: Array<{
    delta?: {
      content?: string | Array<{ type?: string; text?: string }>;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
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
  let finishReason = "stop";
  let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

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
        let chunk: WireChunk;
        try {
          chunk = JSON.parse(data) as WireChunk;
        } catch {
          continue;
        }
        if (chunk.usage) usage = toUsage(chunk.usage);
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (!delta) continue;
        const text = contentText(delta.content);
        if (text) {
          content += text;
          onDelta?.({ channel: "text", delta: text });
        }
        const thought = delta.reasoning_content ?? delta.reasoning;
        if (typeof thought === "string" && thought) {
          reasoning += thought;
          onDelta?.({ channel: "reasoning", delta: thought });
        }
        for (const part of delta.tool_calls ?? []) {
          const index = part.index ?? toolCalls.size;
          const current = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
          if (part.id) current.id = part.id;
          if (part.function?.name) current.name += part.function.name;
          if (part.function?.arguments) current.arguments += part.function.arguments;
          toolCalls.set(index, current);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const calls = [...toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, call]) => call.name)
    .map(([index, call]) => ({
      id: call.id || `call_${index}_${Date.now().toString(36)}`,
      name: call.name,
      arguments: parseArguments(call.arguments),
    }));

  return {
    content,
    reasoning: reasoning || undefined,
    toolCalls: calls,
    usage,
    finishReason: calls.length > 0 ? "tool_calls" : finishReason,
  };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text ?? "") : ""))
      .join("");
  }
  return "";
}

function toUsage(usage: NonNullable<WireChunk["usage"]>): Usage {
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.total_tokens ?? inputTokens + outputTokens,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
  };
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return { __raw: raw };
  } catch {
    return { __raw: raw };
  }
}

/**
 * OpenAI tool messages cannot carry images. Images produced by a tool are
 * therefore attached to the next user message; if the turn ends on tool
 * results, they become a user message after the tool batch, which every
 * compatible endpoint accepts and vision models read as tool output.
 */
function toWireMessages(messages: readonly ChatMessage[]): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = [];
  let pending: ImageAttachment[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    wire.push({
      role: "user",
      content: [
        { type: "text", text: "Images returned by tool calls:" },
        ...pending.map(imagePart),
      ],
    });
    pending = [];
  };

  for (const message of messages) {
    if (message.role === "tool") {
      wire.push(toWireMessage(message));
      if (message.images?.length) pending.push(...message.images);
      continue;
    }
    if (message.role === "user" && pending.length > 0) {
      wire.push(toWireMessage(message, pending));
      pending = [];
      continue;
    }
    flush();
    wire.push(toWireMessage(message));
  }
  flush();
  return wire;
}

function imagePart(image: ImageAttachment): Record<string, unknown> {
  return { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } };
}

function toWireMessage(message: ChatMessage, extraImages: readonly ImageAttachment[] = []): Record<string, unknown> {
  const images = [...(message.images ?? []), ...extraImages];
  if (message.role === "user" && images.length > 0) {
    const parts: Array<Record<string, unknown>> = [];
    if (message.content) parts.push({ type: "text", text: message.content });
    for (const image of images) parts.push(imagePart(image));
    return { role: "user", content: parts };
  }
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId ?? "", content: message.content };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

export default {
  name: "@kestrel/plugin-openai",
  version: "0.1.0",
  description: "OpenAI-compatible chat model provider (OpenAI, DeepSeek, vLLM, Ollama and others).",
  inject: ["models"],
  apply(context: Context, config: OpenAIProviderConfig = {}) {
    const models = context.get("models");
    const provider = config.provider ?? DEFAULTS.provider;
    const ids = config.models?.length ? config.models : [config.model ?? DEFAULTS.model];
    for (const id of ids) {
      const model = new OpenAICompatibleModel({ ...config, provider }, id);
      context.effect(() => models.register(model));
    }
    context.logger.info("openai-compatible provider ready", {
      provider,
      models: ids,
      baseUrl: config.baseUrl ?? DEFAULTS.baseUrl,
      hasApiKey: Boolean(config.apiKey ?? (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined)),
    });
  },
};
