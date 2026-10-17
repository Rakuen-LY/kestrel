import type {
  ChatMessage,
  JsonSchema,
  ModelInfo,
  ToolCall,
  ToolPermission,
  ToolSchema,
  Usage,
} from "@kestrel/protocol";
import type { Logger } from "@kestrel/kernel";
import type { ModelRegistry, ToolRegistry } from "./registry.js";
import type { AgentSession } from "./session.js";

export interface TokenDelta {
  channel: "text" | "reasoning";
  delta: string;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "error" | (string & {});

export interface CompletionResponse {
  content: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: FinishReason;
}

/** A provider adapter over one concrete model. */
export interface LanguageModel {
  readonly info: ModelInfo;
  generate(request: CompletionRequest, onDelta?: (delta: TokenDelta) => void): Promise<CompletionResponse>;
}

export interface ToolExecutionResult {
  content: string;
  data?: unknown;
  isError?: boolean;
  /** Ask the agent loop to stop after this result (e.g. a `finish` tool). */
  terminate?: boolean;
}

export interface ToolSession {
  readonly id: string;
  readonly workspace: string;
  readonly messages: readonly ChatMessage[];
  /** Delegation depth: `0` for a session a human started. */
  readonly depth?: number;
  readonly parentId?: string;
  readonly role?: string;
  metadata: Map<string, unknown>;
}

export interface ToolContext {
  readonly session: ToolSession;
  readonly callId: string;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  progress(message: string): void;
}

export interface Tool {
  readonly schema: ToolSchema;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> | ToolExecutionResult;
}

export type PermissionResolver = (
  tool: Tool,
  call: ToolCall,
  session: ToolSession,
) => ToolPermission | "deny" | Promise<ToolPermission | "deny">;

/** Bridges a paused tool call to a human decision. */
export type ApprovalHandler = (
  request: import("@kestrel/protocol").ApprovalRequest,
  signal: AbortSignal,
) => Promise<boolean>;

export interface AgentSessionOptions {
  id: string;
  title: string;
  model: string;
  workspace: string;
  systemPrompt: string;
  /** Owning tenant; `undefined` means the default tenant. */
  tenantId?: string;
  messages?: ChatMessage[];
  createdAt?: string;
  updatedAt?: string;
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  /** Set for subagents; omitted for sessions a human started. */
  parentId?: string;
  depth?: number;
  role?: string;
  /** When set, only these tool names are offered and executable. */
  allowTools?: readonly string[];
  models: ModelRegistry;
  tools: ToolRegistry;
  logger: Logger;
  emit: (event: import("@kestrel/protocol").SessionEvent) => void;
  approve?: ApprovalHandler;
  resolvePermission?: PermissionResolver;
  onPersist?: (session: AgentSession) => void;
}

export interface RunResult {
  runId: string;
  status: "completed" | "cancelled" | "max_steps";
  usage: Usage;
}

export interface ModelRegistryOptions {
  defaultModel?: string;
}

export interface ToolRegistration {
  register(tool: Tool): () => void;
  get(name: string): Tool | undefined;
  list(): Tool[];
  schemas(): ToolSchema[];
  readonly size: number;
}

export interface JsonValidationIssue {
  path: string;
  message: string;
}

export type { ChatMessage, JsonSchema, ModelInfo, ToolCall, ToolPermission, ToolSchema, Usage };
