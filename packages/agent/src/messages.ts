import { randomUUID } from "node:crypto";
import type { ChatMessage, MessageRole, ToolCall, Usage } from "@kestrel/protocol";

export function createMessage(role: MessageRole, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

export function assistantMessage(
  content: string,
  options: { reasoning?: string; toolCalls?: ToolCall[] } = {},
): ChatMessage {
  return createMessage("assistant", content, {
    reasoning: options.reasoning || undefined,
    toolCalls: options.toolCalls?.length ? options.toolCalls : undefined,
  });
}

export function toolMessage(call: ToolCall, content: string): ChatMessage {
  return createMessage("tool", content, { toolCallId: call.id, toolName: call.name });
}

export function textOf(message: ChatMessage): string {
  return message.content;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

export function addUsage(total: Usage, next: Usage): Usage {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    totalTokens: total.totalTokens + next.totalTokens,
    cachedInputTokens: (total.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0) || undefined,
    reasoningTokens: (total.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0) || undefined,
  };
}

/** Rough estimate used for UI meters; providers report exact usage. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function titleFromInput(input: string): string {
  const line = input.replace(/\s+/g, " ").trim();
  if (!line) return "Untitled session";
  return line.length > 64 ? `${line.slice(0, 61)}...` : line;
}

/** Keeps a tool result inside provider and UI limits without losing its head. */
export function truncateToolOutput(content: string, limit = 60_000): string {
  if (content.length <= limit) return content;
  const keep = limit - 200;
  const head = content.slice(0, Math.floor(keep * 0.7));
  const tail = content.slice(-Math.floor(keep * 0.3));
  return `${head}\n\n[... ${content.length - keep} characters truncated ...]\n\n${tail}`;
}
